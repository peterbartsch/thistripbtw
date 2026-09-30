<?php
/**
 * lib/routing.php — road routing, through our own server. The D-045 pattern, applied to OSRM.
 *
 * WHY (MASTER_PLAN item 14). The browser called `router.project-osrm.org` directly, which meant
 * the one thing this product exists to keep private — *where someone is going* — was sent from
 * the traveller's own IP to a third party on every leg. `privacy.html` disclosed it honestly
 * ("the stop coordinates are sent to compute the path"), and disclosure is not the same as not
 * doing it. Tiles leak which areas you looked at; routing leaked the itinerary itself.
 *
 * Proxied, three things change at once:
 *   · OSRM stops seeing user IPs. It sees our server, once per distinct road path, ever.
 *   · Routes cache hard. A coordinate pair's road geometry does not change — roads do not move
 *     — so the second person to drive Denver→Moab costs zero upstream calls. Nominatim's cache
 *     (D-045) proved the shape; this one has a better hit rate because trips repeat.
 *   · A free service we depend on carries less of our traffic, and the demo server's
 *     no-heavy-use policy stops being something we quietly violate at scale.
 *
 * This is a proxy, not a new data relationship — the same coordinates already went to OSRM from
 * the browser. Nothing about the person is added: no IP forwarding, no identifier, nothing
 * stored but the road geometry itself, which is a public fact about roads.
 *
 * NOT self-hosting. That needs a box with RAM we do not have (no sudo on the VPS) and is its
 * own decision, MASTER_PLAN §6l. This buys most of the privacy and resilience win without it.
 */

declare(strict_types=1);

/* var_pace() lives here. Neither this file nor routing.php loaded it before, because
   nothing in them needed varstore until the pacer moved into it — and api.php reaches
   these two directly, without going through chat.php, which is what used to pull it in. */
require_once __DIR__ . '/varstore.php';

const RT_HOST       = 'router.project-osrm.org';
const RT_UA         = 'thistripbtw.us/1.0 (trip planner; support@thistripbtw.us)';
const RT_TTL        = 180 * 86400;   // roads do not move; six months is still conservative
const RT_MAX        = 4000;          // bounded, oldest trimmed first
const RT_MIN_GAP_US = 250000;        // ~4/sec — the demo server asks for restraint, not silence
/* How long a request may wait for its turn before giving up. At a 250ms gap that is about six
   callers deep. Past that the honest answer is cheaper than the wait: every queued request is a
   PHP worker asleep on a third party, and the fallback here is already good — the client draws
   the dashed straight line it draws for any leg with no road route. */
const RT_MAX_WAIT_US = 1500000;      // 1.5s
const RT_MAX_PTS    = 25;            // a leg is 2 points; a whole route is a handful

/* ONE FILE PER ROUTE, not one big JSON (D-110).
 *
 * The single-file cache was correct for `overview=simplified`, whose entries were ~575 bytes:
 * 4,000 of them is a 2 MB file, cheap to parse. Full-fidelity geometry is ~16 KB per route, and
 * the same cache would be a 64 MB file decoded, re-encoded and rewritten under LOCK_EX on EVERY
 * miss. That works fine for one person testing and falls over the moment two people plan trips
 * at once, which is the worst possible time to find out.
 *
 * Per-file removes the read-modify-write entirely: a store touches one path and blocks nobody.
 * Writes go to a temp name and rename() into place — rename is atomic on POSIX, so a reader
 * never sees a half-written file and no lock is needed on either side.
 */
function rt_cache_dir():  string { return dirname(__DIR__) . '/var/routes'; }
function rt_cache_file(string $key): string { return rt_cache_dir() . '/' . sha1($key) . '.json'; }
function rt_gate_path():  string { return dirname(__DIR__) . '/var/routes-last'; }

function rt_cache_get(string $key)
{
    $f = rt_cache_file($key);
    if (!is_file($f)) return null;
    $j = json_decode((string)@file_get_contents($f), true);
    if (!is_array($j)) return null;
    if (time() - (int)($j['at'] ?? 0) >= RT_TTL) return null;
    return $j['d'] ?? null;                       // string = polyline, '' = a cached "no route"
}

function rt_cache_put(string $key, $data): void
{
    $dir = rt_cache_dir();
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $f   = rt_cache_file($key);
    /* `k` is the plaintext key. sha1 is not reversible and a cache you cannot inspect is a cache
       you cannot debug — this is the only reason it is stored. */
    $tmp = $f . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, json_encode(['at' => time(), 'd' => $data, 'k' => $key])) !== false) {
        @rename($tmp, $f);
    } else {
        @unlink($tmp);
    }
    /* Trimming means listing the directory, which is far too expensive to do on every write and
       pointless besides — the cache only crosses the ceiling occasionally. Sample it instead. */
    try { if (random_int(1, 200) === 1) rt_cache_trim(); } catch (\Throwable $e) {}
}

/** Oldest first, down to 75% of the ceiling, so trimming is rare rather than continuous. */
function rt_cache_trim(): void
{
    $files = @glob(rt_cache_dir() . '/*.json') ?: [];
    if (count($files) <= RT_MAX) return;
    $age = [];
    foreach ($files as $p) $age[$p] = @filemtime($p) ?: 0;
    asort($age);
    $drop = count($files) - (int)(RT_MAX * 0.75);
    foreach (array_slice(array_keys($age), 0, $drop) as $p) @unlink($p);
}

/** Hold to a few upstream requests a second across every visitor at once (see var_pace).
 *  False means the queue is deeper than RT_MAX_WAIT_US and the caller must give up — which draws
 *  the dashed straight line, the same thing a genuinely routeless leg already does. */
function rt_pace(): bool
{
    return var_pace(rt_gate_path(), RT_MIN_GAP_US, RT_MAX_WAIT_US);
}

/**
 * "lat,lng;lat,lng…" → the road path as an ENCODED POLYLINE (precision 5), or null when there
 * is no route. The client decodes it; see decodePoly() in app.html and new.html.
 *
 * Coordinates are rounded to 4 decimals (~11 m) for the CACHE KEY only. Two people tapping the
 * same junction a few metres apart get the same road, which is what turns a busy corridor into
 * one upstream call. The request itself uses what was asked for.
 */
function rt_route(string $coords): ?string
{
    $pairs = array_filter(explode(';', trim($coords)));
    if (count($pairs) < 2 || count($pairs) > RT_MAX_PTS) return null;

    $clean = [];
    foreach ($pairs as $p) {
        $xy = explode(',', $p);
        if (count($xy) !== 2) return null;
        $lat = (float)$xy[0]; $lng = (float)$xy[1];
        if (!is_numeric($xy[0]) || !is_numeric($xy[1])) return null;
        if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) return null;
        $clean[] = [$lat, $lng];
    }

    /* v2, and the bump is load-bearing: v1 entries are decimated ARRAYS and v2 is an encoded
       STRING. Reusing the prefix would hand the client the wrong type from a warm cache. */
    $key = 'v2|' . implode(';', array_map(
        fn($c) => sprintf('%.4f,%.4f', $c[0], $c[1]), $clean));
    $hit = rt_cache_get($key);
    if ($hit !== null) return $hit === '' ? null : $hit;   // '' is a cached "no route"

    /* Shed rather than queue. Returning null here is NOT cached as "no route" — the cache put
       below is only reached on a real upstream answer — so a leg skipped during a spike routes
       normally the next time somebody asks for it. */
    if (!rt_pace()) return null;
    // OSRM wants lng,lat — the reverse of everything else in this codebase, which is exactly
    // the kind of detail worth writing down rather than rediscovering.
    $path = '/route/v1/driving/' . implode(';', array_map(
        fn($c) => $c[1] . ',' . $c[0], $clean));
    /* `full`, not `simplified`. OSRM's `simplified` runs Douglas-Peucker at the zoom level of
       the WHOLE route, so Chicago→Omaha came back as 22 points for 470 miles — routed, but so
       decimated it drew as a bent straight line and read as though no routing existed at all.
       `full` is 4,855 points for the same road.
       And `polyline`, not `geojson`, because the same geometry is 15.9 KB encoded against
       120.3 KB as coordinate arrays — a 7.5× saving on the wire and in the cache, for about
       fifteen lines of decoding in the client. Precision 5 is ~1 m, well past what a map draws. */
    $url = 'https://' . RT_HOST . $path . '?overview=full&geometries=polyline';

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_USERAGENT      => RT_UA,
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
    ]);
    $raw  = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    /* no curl_close(): a no-op since PHP 8.0 and deprecated in 8.5, and leaving it in lets a
       Deprecated warning into the response body wherever display_errors is on. api.php's
       stripe_get_session() dropped it for that reason; these four were missed. The VPS is on
       8.2 today, so this was latent rather than live — it goes noisy the day DreamHost moves. */

    // A failure is NOT cached as "no route": the map falls back to a straight dashed line, and
    // caching a transient outage for six months would make that permanent.
    if ($raw === false || $code >= 400) return null;

    $d = json_decode((string)$raw, true);
    $g = $d['routes'][0]['geometry'] ?? null;
    /* An encoded polyline, passed through untouched — the server never decodes it. No lat/lng
       swap to get wrong here, which is worth noting given the comment above about OSRM's
       reversed axis order. */
    if (!is_string($g) || $g === '') { rt_cache_put($key, ''); return null; }   // genuinely no road

    rt_cache_put($key, $g);
    return $g;
}
