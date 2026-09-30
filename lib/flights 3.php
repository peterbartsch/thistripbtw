<?php
/**
 * lib/flights.php — flight lookup, the one genuinely scarce thing in the chat agent.
 *
 * AeroDataBox is capped at 600 lookups/month for the whole product (D-035). Tokens are
 * cheap and bounded; this is not. So the order of defence matters, and it is spend-first:
 *
 *   1. the cache answers, or
 *   2. the monthly counter says no, or
 *   3. we call out — and only then.
 *
 * The counter is incremented BEFORE the request, not after. A crashed or timed-out call
 * still consumed the quota at the far end; counting on success would let a flapping network
 * spend the month's budget while the local number stayed reassuringly low.
 *
 * The pre-purchase path must never reach this file at all — lookup_flight is withheld from
 * the free schema and refused again by dispatch (D-035). This is the resource the paywall
 * is actually protecting.
 */

declare(strict_types=1);
require_once __DIR__ . '/varstore.php';

const FLIGHT_MONTHLY_CAP = 600;          // AeroDataBox's hard ceiling for the whole product
/* AeroDataBox is resold by several marketplaces and the credential is NOT portable between
   them. Peter's key is an api.market key: it returns 200 with real data here and 403 against
   RapidAPI, which is where this file used to point. The response body is byte-for-byte the
   same AeroDataBox shape either way, so only the host, the path prefix and the auth header
   differ — everything below this line was already correct. */
const FLIGHT_HOST        = 'prod.api.market';
const FLIGHT_PATH        = '/api/v1/aedbx/aerodatabox';

function flight_cache_path() { return dirname(__DIR__) . '/var/flights.json'; }
function flight_count_path() { return dirname(__DIR__) . '/var/flight-calls.json'; }

/** Cache key is flight number + date, exactly as the spec fixed it. */
function flight_key(string $num, string $date): string
{
    return strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $num)) . '|' . $date;
}

function flight_cache_get(string $key)
{
    $f = flight_cache_path();
    if (!is_file($f)) return null;
    $j = json_decode((string)@file_get_contents($f), true);
    if (!is_array($j) || !isset($j[$key])) return null;
    $e = $j[$key];
    // A flight that has already happened cannot change. Cache it forever; that is what
    // keeps the 600 from being spent re-answering the same question next week.
    if (($e['date'] ?? '') < date('Y-m-d')) return $e['data'] ?? null;
    return (time() - (int)($e['at'] ?? 0) < 6 * 3600) ? ($e['data'] ?? null) : null;
}

function flight_cache_put(string $key, string $date, array $data): void
{
    $dir = dirname(flight_cache_path());
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $f = flight_cache_path();
    $j = is_file($f) ? json_decode((string)@file_get_contents($f), true) : [];
    if (!is_array($j)) $j = [];
    $j[$key] = ['at' => time(), 'date' => $date, 'data' => $data];
    if (count($j) > 4000) $j = array_slice($j, -3000, null, true);   // bounded, oldest first
    @file_put_contents($f, json_encode($j), LOCK_EX);
}

function flight_calls_used(): int
{
    $f = flight_count_path();
    if (!is_file($f)) return 0;
    $j = json_decode((string)@file_get_contents($f), true);
    return is_array($j) ? (int)($j[date('Y-m')] ?? 0) : 0;
}

function flight_calls_add(): void
{
    // D-091: AeroDataBox's free tier is a hard 600/month. An undercount here does not cost
    // money, it makes the feature start failing with no warning.
    var_update(flight_count_path(), function (array $j) {
        $k = date('Y-m');
        $j[$k] = (int)($j[$k] ?? 0) + 1;
        return [$j, null];
    });
}

/**
 * Look up one flight. Returns the shape the model is allowed to repeat, or an error array.
 *
 * Only fields that came back from the API are included. The system prompt forbids stating a
 * time the tool did not return, and the cheapest way to keep that true is to never hand the
 * model a key it could mistake for a real answer.
 */
function flight_lookup(string $num, string $date): array
{
    if (!preg_match('/^[A-Za-z0-9]{2,3}\s?\d{1,4}[A-Za-z]?$/', trim($num)))
        return ['error' => 'bad_flight_number', 'message' => 'That does not look like a flight number. Ask the person to check it.'];
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date))
        return ['error' => 'bad_date', 'message' => 'A flight lookup needs a date in YYYY-MM-DD.'];

    $key = flight_key($num, $date);
    $hit = flight_cache_get($key);
    if ($hit !== null) return $hit + ['cached' => true];

    $apiKey = env('AERODATABOX_KEY', '');
    if ($apiKey === '')
        return ['error' => 'not_configured', 'message' => 'Flight lookup is not switched on. Add the leg without times.'];

    if (flight_calls_used() >= FLIGHT_MONTHLY_CAP)
        return ['error' => 'quota', 'message' => 'Flight lookups are used up for this month. Add the leg without times.'];

    // Counted before the call: a timeout still spent the quota at the far end.
    flight_calls_add();

    $url = 'https://' . FLIGHT_HOST . FLIGHT_PATH . '/flights/number/'
         . rawurlencode(strtoupper(str_replace(' ', '', $num)))
         . '/' . rawurlencode($date) . '?withAircraftImage=false&withLocation=true';
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_HTTPHEADER     => ['x-magicapi-key: ' . $apiKey, 'Accept: application/json'],
    ]);
    $raw  = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    /* no curl_close(): a no-op since PHP 8.0 and deprecated in 8.5, and leaving it in lets a
       Deprecated warning into the response body wherever display_errors is on. api.php's
       stripe_get_session() dropped it for that reason; these four were missed. The VPS is on
       8.2 today, so this was latent rather than live — it goes noisy the day DreamHost moves. */

    if ($code === 404) return ['error' => 'not_found', 'message' => 'No flight by that number on that date. Say so and add the leg without times.'];
    if ($raw === false || $code >= 400)
        return ['error' => 'unavailable', 'message' => 'The flight service did not answer. Add the leg without times.'];

    $d = json_decode((string)$raw, true);
    $f = (is_array($d) && isset($d[0])) ? $d[0] : (is_array($d) ? $d : null);
    if (!$f) return ['error' => 'not_found', 'message' => 'No flight by that number on that date.'];

    $pick = function ($side) use ($f) {
        $s = $f[$side] ?? null;
        if (!is_array($s)) return null;
        $out = [];
        $ap = $s['airport'] ?? [];
        if (!empty($ap['iata']))     $out['airport']  = $ap['iata'];
        if (!empty($ap['name']))     $out['name']     = $ap['name'];
        if (isset($ap['location']['lat'], $ap['location']['lon'])) {
            $out['lat'] = (float)$ap['location']['lat'];
            $out['lng'] = (float)$ap['location']['lon'];
        }
        // Scheduled local time only — never a guess, never an invented timezone.
        $t = $s['scheduledTime']['local'] ?? ($s['scheduledTimeLocal'] ?? null);
        if (is_string($t) && $t !== '') $out['scheduled_local'] = $t;
        return $out ?: null;
    };

    $res = ['ok' => true, 'flight' => strtoupper(str_replace(' ', '', $num)), 'date' => $date];
    if ($dep = $pick('departure')) $res['departure'] = $dep;
    if ($arr = $pick('arrival'))   $res['arrival']   = $arr;
    if (!isset($res['departure']) && !isset($res['arrival']))
        return ['error' => 'not_found', 'message' => 'That flight came back with no usable times. Add the leg without them.'];

    flight_cache_put($key, $date, $res);
    return $res;
}
