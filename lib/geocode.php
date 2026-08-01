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

const GEO_HOST      = 'nominatim.openstreetmap.org';
const GEO_UA        = 'thistripbtw.us/1.0 (trip planner; support@thistripbtw.us)';
const GEO_TTL       = 30 * 86400;   // a place's name does not move; a month is conservative
const GEO_MAX       = 5000;         // bounded, oldest trimmed first
const GEO_MIN_GAP_US = 1100000;     // ~1.1s between upstream calls — their policy asks for ~1/sec

function geo_cache_path(): string { return dirname(__DIR__) . '/var/geocode.json'; }
function geo_gate_path():  string { return dirname(__DIR__) . '/var/geocode-last'; }

function geo_cache_get(string $key)
{
    $f = geo_cache_path();
    if (!is_file($f)) return null;
    $j = json_decode((string)@file_get_contents($f), true);
    if (!is_array($j) || !isset($j[$key])) return null;
    $e = $j[$key];
    return (time() - (int)($e['at'] ?? 0) < GEO_TTL) ? ($e['d'] ?? null) : null;
}

function geo_cache_put(string $key, $data): void
{
    $dir = dirname(geo_cache_path());
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $f = geo_cache_path();
    $j = is_file($f) ? json_decode((string)@file_get_contents($f), true) : [];
    if (!is_array($j)) $j = [];
    $j[$key] = ['at' => time(), 'd' => $data];
    if (count($j) > GEO_MAX) $j = array_slice($j, -(int)(GEO_MAX * 0.75), null, true);
    @file_put_contents($f, json_encode($j), LOCK_EX);
}

/**
 * Hold to roughly one upstream request per second, across every visitor at once.
 * A file mtime is enough here and needs no daemon; the sleep is capped so a burst
 * queues briefly rather than tying a worker up.
 */
function geo_pace(): void
{
    $f = geo_gate_path();
    $dir = dirname($f);
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $last = is_file($f) ? (int)(@filemtime($f) * 1000000) : 0;
    $now  = (int)(microtime(true) * 1000000);
    $wait = GEO_MIN_GAP_US - ($now - $last);
    if ($wait > 0) usleep((int)min($wait, GEO_MIN_GAP_US));
    @touch($f);
}

/** One upstream call. Returns the decoded body, or null on any failure. */
function geo_fetch(string $path, array $params)
{
    geo_pace();
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
    curl_close($ch);
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
