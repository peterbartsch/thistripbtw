<?php
/* this trip, btw — the one safe way to update a counter in var/ (D-091).
 *
 * WHAT WAS WRONG. Five places did the same thing: read a JSON file, change it, then
 * `file_put_contents(..., LOCK_EX)`. The lock covers only the WRITE, so two requests read the
 * same value and the second overwrites the first. Measured with that exact shape:
 * **forty concurrent increments recorded as fourteen.**
 *
 * That is not an abstract concurrency worry, because of WHICH counters they are:
 *
 *   · `chat_rate_ok`      — the per-IP daily cap on /api/draft-chat, which is unauthenticated
 *                           and spends Anthropic tokens. An abuser sends requests in PARALLEL,
 *                           so the adversarial case is exactly the case that defeats it.
 *   · `chat_tokens_add`   — the global monthly ceiling, the whole "fail-safe, not fail-loud"
 *                           story. lib/chat.php already notes it once did not exist at all.
 *   · `flight_calls_add`  — AeroDataBox's free tier is a HARD 600/month. Overshoot and flight
 *                           lookups start failing silently, which is the exact failure the
 *                           cache was built to prevent.
 *
 * THE FIX. Hold an exclusive lock across the read AND the write. `fopen('c+')` creates the file
 * if missing without truncating it, so the lock is taken before anything is read.
 *
 * Not a database, deliberately. These are counters nobody joins on, the box has no sudo and one
 * MySQL already carries the product; a file the OS can lock is the smaller dependency. The gate
 * limiter in api.php uses MySQL's atomic `ON DUPLICATE KEY UPDATE hits=hits+1` instead, which is
 * right for it because it is keyed by slug and lives beside the trips.
 */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }

/**
 * Read a JSON file, hand it to $fn, write back whatever $fn returns — all under one lock.
 *
 * $fn receives the decoded array and returns [$newValue, $result]; $result is handed back to the
 * caller so a decision made under the lock (like "is this IP over its limit?") is the same
 * decision the write was based on. Returning null as $newValue leaves the file untouched.
 */
function var_update(string $path, callable $fn) {
    $dir = dirname($path);
    if (!is_dir($dir)) @mkdir($dir, 0775, true);

    $fp = @fopen($path, 'c+');            // create-if-missing, do NOT truncate
    if (!$fp) {                            // unwritable: fail OPEN, never lock a customer out
        [$new, $result] = $fn([]);
        return $result;
    }
    if (!flock($fp, LOCK_EX)) { fclose($fp); [$new, $result] = $fn([]); return $result; }

    $raw = stream_get_contents($fp);
    $data = $raw !== false && $raw !== '' ? json_decode($raw, true) : [];
    if (!is_array($data)) $data = [];

    [$new, $result] = $fn($data);

    if ($new !== null) {
        rewind($fp);
        ftruncate($fp, 0);
        fwrite($fp, json_encode($new));
        fflush($fp);
    }
    flock($fp, LOCK_UN);
    fclose($fp);
    return $result;
}

/** Read-only, no lock — a stale read is fine for anything that re-checks under the lock. */
function var_read(string $path): array {
    if (!is_file($path)) return [];
    $j = json_decode((string)@file_get_contents($path), true);
    return is_array($j) ? $j : [];
}
