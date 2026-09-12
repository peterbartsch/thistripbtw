<?php
/**
 * lib/geocode.php — place lookup, through our own server (D-045).
 *
 * The browser used to call Nominatim directly, and it mostly worked. The failure mode was the
 * confusing kind: their shared cache serves some responses with no `Access-Control-Allow-Origin`
 * header — their `vary` omits `Origin`, so a response cached from a non-browser request gets
 * handed to a browser, which must throw perfectly good data away. Measured on 2026-07-27: a
 * repeated coordinate came back without the header every time, while ten varied coordinates all
 * had it. The user-visible symptom was a stop named "Dropped pin · 38.959, -102.305" — sometimes.
 *
 * Same-origin removes CORS from the question entirely. Two more things follow from being on the
 * server: we can send the User-Agent their usage policy actually asks for, and we can cache, so
 * a free service we depend on carries less of our traffic.
 *
 * This is a proxy, not a new data relationship. The same coordinates and search text already
 * went to Nominatim from the browser; they now go from here, and nothing about the person is
 * added — no IP forwarding, no identifier, nothing stored but the place answer itself.
 */

declare(strict_types=1);

/* var_pace() lives here. Neither this file nor routing.php loaded it before, because
   nothing in them needed varstore until the pacer moved into it — and api.php reaches
   these two directly, without going through chat.php, which is what used to pull it in. */
require_once __DIR__ . '/varstore.php';

const GEO_HOST      = 'nominatim.openstreetmap.org';
const GEO_UA        = 'thistripbtw.us/1.0 (trip planner; support@thistripbtw.us)';
const GEO_TTL       = 30 * 86400;   // a place's name does not move; a month is conservative
const GEO_MAX       = 5000;         // bounded, oldest trimmed first
const GEO_MIN_GAP_US = 1100000;     // ~1.1s between upstream calls — their policy asks for ~1/sec
/* How long a request may wait for its turn before we give up and answer without a name. At a
   1.1s gap that is about two callers deep. Past that, sleeping is worse than failing: every
   waiting request is a PHP worker held open on a third party, and enough of them is an outage of
   our own making. An unresolved name is the existing, quiet degradation — the stop keeps its
   coordinates and the map is unaffected. */
const GEO_MAX_WAIT_US = 2500000;    // 2.5s

/* ONE FILE PER PLACE, not one big JSON — the same change D-110 made to the route cache, and the
 * same reasons, arriving late because this cache is smaller and so the fault was quieter.
 *
 * The old shape read var/geocode.json, decoded up to GEO_MAX entries, added one, re-encoded the
 * lot and wrote it back. Two faults, and the second is the one that actually loses data:
 *
 *   · O(n) on every MISS. 140 entries and 25 KB today; the ceiling is 5,000, which at the
 *     measured 90-byte mean is ~438 KB decoded, mutated and rewritten per miss.
 *   · IT LOSES ENTRIES. `file_put_contents(..., LOCK_EX)` locks only the WRITE. The read happens
 *     outside any lock, so two requests that miss at the same time both decode the same map, each
 *     adds its own key, and whichever writes last discards the other's. This is exactly the
 *     read-modify-write D-091 found and fixed in the counters — measured there as forty
 *     concurrent increments recorded as fourteen. Here it silently throws away a lookup we paid
 *     Nominatim's rate limit to get, and the busier we are the more of them it drops.
 *
 * Per-file removes the read-modify-write entirely: a put touches one path, reads nothing, and
 * blocks nobody. The write goes to a temp name and rename()s into place — atomic on POSIX, so a
 * reader never sees half a file and neither side needs a lock. Copied deliberately from
 * rt_cache_put() rather than reinvented; two implementations of one idea drift.
 *
 * `''` REMAINS A MEANINGFUL VALUE and must survive the round trip: geo_reverse() caches a genuine
 * miss so a blank spot on the map is not re-asked for a month, and `$j['d'] ?? null` keeps the
 * empty string distinct from an absent entry. A search result caches an array. Both go through
 * unchanged.
 */
function geo_cache_dir():  string { return dirname(__DIR__) . '/var/places'; }
function geo_cache_file(string $key): string { return geo_cache_dir() . '/' . sha1($key) . '.json'; }
function geo_gate_path():  string { return dirname(__DIR__) . '/var/geocode-last'; }

function geo_cache_get(string $key)
{
    $f = geo_cache_file($key);
    if (!is_file($f)) return null;
    $j = json_decode((string)@file_get_contents($f), true);
    if (!is_array($j)) return null;
    if (time() - (int)($j['at'] ?? 0) >= GEO_TTL) return null;
    return $j['d'] ?? null;                       // '' is a cached "no name here" — not a miss
}

function geo_cache_put(string $key, $data): void
{
    $dir = geo_cache_dir();
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $f   = geo_cache_file($key);
    /* `k` is the plaintext key. sha1 is not reversible and a cache you cannot inspect is a cache
       you cannot debug — this is the only reason it is stored. */
    $tmp = $f . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, json_encode(['at' => time(), 'd' => $data, 'k' => $key])) !== false) {
        @rename($tmp, $f);
    } else {
        @unlink($tmp);
    }
    /* Listing the directory is far too expensive to do on every write and pointless besides — the
       cache only crosses its ceiling occasionally. Sample it, same odds as rt_cache_put(). */
    try { if (random_int(1, 200) === 1) geo_cache_trim(); } catch (\Throwable $e) {}
}

/** Oldest first, down to 75% of the ceiling, so trimming is rare rather than continuous. */
function geo_cache_trim(): void
{
    $files = @glob(geo_cache_dir() . '/*.json') ?: [];
    if (count($files) <= GEO_MAX) return;
    $age = [];
    foreach ($files as $p) $age[$p] = @filemtime($p) ?: 0;
    asort($age);
    $drop = count($files) - (int)(GEO_MAX * 0.75);
    foreach (array_slice(array_keys($age), 0, $drop) as $p) @unlink($p);
}

/**
 * Hold to roughly one upstream request per second, across every visitor at once.
 *
 * Returns false when the queue is already deeper than GEO_MAX_WAIT_US, and the caller must then
 * give up rather than sleep. See var_pace() for why this is a reservation taken under a lock
 * instead of the filemtime arithmetic that used to live here — that was wrong under concurrency
 * AND wrong on the clock, while still costing a blocked worker.
 */
function geo_pace(): bool
{
    return var_pace(geo_gate_path(), GEO_MIN_GAP_US, GEO_MAX_WAIT_US);
}

/**
 * One upstream call.
 *
 *   array  the decoded body
 *   null   we asked and got nothing usable — a real answer about this place
 *   false  WE NEVER ASKED, because the queue was too deep
 *
 * The third case has to be distinguishable, and the reason is the cache. geo_reverse() caches a
 * miss on purpose, so a blank spot on the map is not re-asked for thirty days — which is right
 * for "Nominatim has no name for this point" and catastrophic for "we were busy at 9pm on a
 * Friday". Folding a shed into null would poison the cache with an empty name for a month, and
 * the busier the moment, the more places it would do it to.
 *
 * routing.php already draws this line — "A failure is NOT cached as 'no route': caching a
 * transient outage for six months would make that permanent." Same rule, same reason.
 */
function geo_fetch(string $path, array $params)
{
    if (!geo_pace()) return false;
    $url = 'https://' . GEO_HOST . $path . '?' . http_build_query($params + ['format' => 'json']);
    $ch  = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_USERAGENT      => GEO_UA,          // their policy requires an identifying UA
        CURLOPT_HTTPHEADER     => ['Accept: application/json', 'Accept-Language: en'],
    ]);
    $raw  = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    /* no curl_close(): a no-op since PHP 8.0 and deprecated in 8.5, and leaving it in lets a
       Deprecated warning into the response body wherever display_errors is on. api.php's
       stripe_get_session() dropped it for that reason; these four were missed. The VPS is on
       8.2 today, so this was latent rather than live — it goes noisy the day DreamHost moves. */
    if ($raw === false || $code >= 400) return null;
    $d = json_decode((string)$raw, true);
    return is_array($d) ? $d : null;
}

/** "Cheyenne County, Colorado, United States" → "Cheyenne County, Colorado". */
function geo_short(string $name): string
{
    $p = array_map('trim', explode(',', $name));
    return count($p) > 2 ? implode(', ', array_slice($p, 0, 2)) : $name;
}

/** Reverse: a tapped point → a name, or null if there isn't a usable one. */
function geo_reverse(float $lat, float $lng): ?string
{
    if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180) return null;
    // Round the key, not the query: taps a few metres apart are the same place, and this is
    // what turns a map full of taps into a handful of upstream calls.
    $key = sprintf('r|%.4f|%.4f', $lat, $lng);
    $hit = geo_cache_get($key);
    if ($hit !== null) return $hit === '' ? null : $hit;

    $d = geo_fetch('/reverse', ['zoom' => 14, 'lat' => $lat, 'lon' => $lng]);
    if ($d === false) return null;       // shed, not asked — must NOT be cached as "no name here"
    $name = (is_array($d) && !empty($d['display_name'])) ? geo_short((string)$d['display_name']) : '';
    geo_cache_put($key, $name);          // cache the miss too, so a blank spot isn't re-asked
    return $name === '' ? null : $name;
}

/** Forward: typed text → up to 6 candidates the client can rank. */
function geo_search(string $q): array
{
    $q = trim($q);
    if ($q === '' || mb_strlen($q) > 120) return [];
    $key = 's|' . mb_strtolower($q);
    $hit = geo_cache_get($key);
    if (is_array($hit)) return $hit;

    $d = geo_fetch('/search', ['limit' => 6, 'q' => $q, 'addressdetails' => 0]);
    if ($d === false) return [];         // shed, not asked — must NOT be cached as "no such place"
    $out = [];
    foreach ((is_array($d) ? $d : []) as $r) {
        if (!isset($r['lat'], $r['lon'])) continue;
        $out[] = [
            'name'       => geo_short((string)($r['display_name'] ?? '')),
            'full'       => (string)($r['display_name'] ?? ''),
            'lat'        => (float)$r['lat'],
            'lon'        => (float)$r['lon'],
            'importance' => (float)($r['importance'] ?? 0),
        ];
    }
    geo_cache_put($key, $out);
    return $out;
}
