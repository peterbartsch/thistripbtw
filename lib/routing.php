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

const RT_HOST       = 'router.project-osrm.org';
const RT_UA         = 'thistripbtw.us/1.0 (trip planner; support@thistripbtw.us)';
const RT_TTL        = 180 * 86400;   // roads do not move; six months is still conservative
const RT_MAX        = 4000;          // bounded, oldest trimmed first
const RT_MIN_GAP_US = 250000;        // ~4/sec — the demo server asks for restraint, not silence
const RT_MAX_PTS    = 25;            // a leg is 2 points; a whole route is a handful

function rt_cache_path(): string { return dirname(__DIR__) . '/var/routes.json'; }
function rt_gate_path():  string { return dirname(__DIR__) . '/var/routes-last'; }

function rt_cache_get(string $key)
{
    $f = rt_cache_path();
    if (!is_file($f)) return null;
    $j = json_decode((string)@file_get_contents($f), true);
    if (!is_array($j) || !isset($j[$key])) return null;
    $e = $j[$key];
    return (time() - (int)($e['at'] ?? 0) < RT_TTL) ? ($e['d'] ?? null) : null;
}

function rt_cache_put(string $key, $data): void
{
    $dir = dirname(rt_cache_path());
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $f = rt_cache_path();
    $j = is_file($f) ? json_decode((string)@file_get_contents($f), true) : [];
    if (!is_array($j)) $j = [];
    $j[$key] = ['at' => time(), 'd' => $data];
    if (count($j) > RT_MAX) $j = array_slice($j, -(int)(RT_MAX * 0.75), null, true);
    @file_put_contents($f, json_encode($j), LOCK_EX);
}

/** Hold to a few upstream requests a second across every visitor at once (see geo_pace). */
function rt_pace(): void
{
    $f = rt_gate_path();
    $dir = dirname($f);
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $last = is_file($f) ? (int)(@filemtime($f) * 1000000) : 0;
    $now  = (int)(microtime(true) * 1000000);
    $wait = RT_MIN_GAP_US - ($now - $last);
    if ($wait > 0) usleep((int)min($wait, RT_MIN_GAP_US));
    @touch($f);
}

/**
 * "lat,lng;lat,lng…" → the road path as [[lat,lng], …], or null when there is no route.
 *
 * Coordinates are rounded to 4 decimals (~11 m) for the CACHE KEY only. Two people tapping the
 * same junction a few metres apart get the same road, which is what turns a busy corridor into
 * one upstream call. The request itself uses what was asked for.
 */
function rt_route(string $coords): ?array
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

    $key = 'v1|' . implode(';', array_map(
        fn($c) => sprintf('%.4f,%.4f', $c[0], $c[1]), $clean));
    $hit = rt_cache_get($key);
    if ($hit !== null) return $hit === '' ? null : $hit;   // '' is a cached "no route"

    rt_pace();
    // OSRM wants lng,lat — the reverse of everything else in this codebase, which is exactly
    // the kind of detail worth writing down rather than rediscovering.
    $path = '/route/v1/driving/' . implode(';', array_map(
        fn($c) => $c[1] . ',' . $c[0], $clean));
    $url = 'https://' . RT_HOST . $path . '?overview=simplified&geometries=geojson';

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_USERAGENT      => RT_UA,
        CURLOPT_HTTPHEADER     => ['Accept: application/json'],
    ]);
    $raw  = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    // A failure is NOT cached as "no route": the map falls back to a straight dashed line, and
    // caching a transient outage for six months would make that permanent.
    if ($raw === false || $code >= 400) return null;

    $d = json_decode((string)$raw, true);
    $c = $d['routes'][0]['geometry']['coordinates'] ?? null;
    if (!is_array($c) || !$c) { rt_cache_put($key, ''); return null; }   // genuinely no road

    $geo = [];
    foreach ($c as $pt) {
        if (!isset($pt[0], $pt[1])) continue;
        $geo[] = [round((float)$pt[1], 5), round((float)$pt[0], 5)];     // back to lat,lng
    }
    rt_cache_put($key, $geo);
    return $geo;
}
