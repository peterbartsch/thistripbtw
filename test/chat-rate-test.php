<?php
/**
 * The per-IP draft-chat limiter — that it still counts, and that its cost no longer grows.
 *
 * Two properties, and the second is the one that was broken. D-091 established the first: the
 * check and the increment must happen under ONE lock, or parallel requests all read the same
 * count and all pass, which is precisely how an abuser hits an unauthenticated endpoint that
 * spends tokens. That property is preserved and re-asserted here.
 *
 * What changed is the SCOPE of the lock. Every hashed IP for the day lived in one JSON file that
 * was decoded, mutated and re-encoded under LOCK_EX on every request, so the endpoint's
 * throughput fell as the day's traffic accumulated — 14 ms per request at 50,000 addresses,
 * serialized, which is ~70 req/s for the whole endpoint no matter how many workers exist. One
 * file per caller makes the cost flat and confines contention to requests from the same address.
 *
 * The flatness test is the point of this file, and it is asserted in BYTES rather than
 * milliseconds — see the comment at the bottom for why the timing version had to go.
 *
 * Run: php test/chat-rate-test.php
 */
/* A PER-PROCESS STORE, so this never touches the real one and two copies can run at once.
   Both matter: chat_rate_dir() IS the live rate limiter, so a run on the server would reset every
   caller's daily count — and without isolation four concurrent copies wipe each other's fixtures
   mid-run, which is exactly what happened when this was first written. */
$TTB_RATE_DIR = sys_get_temp_dir() . '/ttb-rate-' . getmypid();
if (!function_exists('env')) {
    function env($k, $d = null) {
        global $TTB_RATE_DIR;
        return $k === 'CHAT_RATE_DIR' ? $TTB_RATE_DIR : $d;
    }
}
define('SECURE_ACCESS', true);
require __DIR__ . '/../lib/chat.php';

$pass = 0; $fail = 0;
function ok(string $what, bool $cond) {
    global $pass, $fail;
    if ($cond) { $pass++; echo "  ✓ $what\n"; }
    else       { $fail++; echo "  ✗ $what\n"; }
}

$dir = chat_rate_dir();   // the per-process temp path set above, never the real store
$day = date('Y-m-d');
$rm = function (string $d) use (&$rm) {
    foreach (glob($d . '/*') ?: [] as $p) { is_dir($p) ? $rm($p) : @unlink($p); }
    @rmdir($d);
};
$rm($dir);

/* ── it still counts, and it still refuses ─────────────────────────────────────────────── */
$ip = '198.51.100.7';                                   // TEST-NET-2, never a real caller
$allowed = 0;
for ($i = 0; $i < CHAT_DRAFT_PER_IP + 5; $i++) if (chat_rate_ok($ip)) $allowed++;
ok('lets exactly CHAT_DRAFT_PER_IP (' . CHAT_DRAFT_PER_IP . ') through, then refuses',
   $allowed === CHAT_DRAFT_PER_IP);
ok('and keeps refusing once over', chat_rate_ok($ip) === false);

/* ── one caller's exhaustion is not another's ──────────────────────────────────────────── */
ok('a different address is unaffected by the first one being capped', chat_rate_ok('198.51.100.8') === true);

/* ── a missing header is never a lockout ──────────────────────────────────────────────── */
ok('an empty address is allowed rather than counted', chat_rate_ok('') === true);

/* ── the address is never written down ────────────────────────────────────────────────── */
$written = [];
foreach (glob($dir . '/*/*/*') ?: [] as $f) $written[] = basename($f) . '|' . (string)file_get_contents($f);
$blob = implode("\n", $written);
ok('no raw address appears anywhere in the store', strpos($blob, '198.51.100.7') === false);
ok('the filename is the 16-char daily hash, not an address',
   (bool)count($written) && preg_match('/^[0-9a-f]{16}$/', basename(glob($dir . '/*/*/*')[0])));

/* ── D-091: the increment cannot be lost ──────────────────────────────────────────────── */
/* Sequential here on purpose — a forked concurrency test is the kind of staged interaction that
   produces false findings. What is actually asserted is that the counter is read and written
   inside one var_update(), which is the property that made the parallel case safe. */
$ip2 = '198.51.100.9';
for ($i = 0; $i < 5; $i++) chat_rate_ok($ip2);
$salt = $day . '|' . 'thistripbtw.us';
$k2   = substr(hash('sha256', $ip2 . '|' . $salt), 0, 16);
$f2   = $dir . '/' . $day . '/' . substr($k2, 0, 2) . '/' . $k2;
$n2   = (int)(json_decode((string)@file_get_contents($f2), true)['n'] ?? 0);
ok("five calls recorded as five, not fewer (got $n2)", $n2 === 5);

/* ── yesterday is forgotten ───────────────────────────────────────────────────────────── */
$old = $dir . '/2020-01-01/ab';
@mkdir($old, 0775, true);
file_put_contents($old . '/abcdef0123456789', '{"n":4}');
chat_rate_sweep($day);
ok('a previous day is removed entirely', !is_dir($dir . '/2020-01-01'));
ok("and today's counts survive the sweep", is_file($f2));

/* the sweep only ever removes things that ARE dates — a stray file is left alone rather than
   being treated as a day, because a delete loop that guesses is the one you regret */
file_put_contents($dir . '/not-a-day', 'x');
chat_rate_sweep($day);
ok('a non-date entry beside the day directories is left alone', is_file($dir . '/not-a-day'));
@unlink($dir . '/not-a-day');

/* ── THE POINT: cost does not grow with the number of other callers ─────────────────────
 *
 * ASSERTED IN BYTES, NOT MILLISECONDS, and the first version's flakiness is why. It compared two
 * sub-millisecond timings and asserted their RATIO — but both terms are noisy, so the quotient is
 * noisier than either, and it can fail in both directions for reasons that have nothing to do with
 * this code. It measured 0.88–1.11× standalone and 0.75× under load, then failed once inside
 * `make check` at over 2×, which is a machine-speed test inventing a defect. CLAUDE.md's rule
 * applies to a test as much as to an investigation: prefer a calculation you can check.
 *
 * Bytes are the honest statement of the property anyway. What made the old shape O(n) was not the
 * clock — it was that every call had to READ AND REWRITE THE WHOLE STORE. So the thing to pin is
 * that the bytes one call touches do not depend on how many other callers exist. That is exact,
 * deterministic, and fails loudly the moment somebody puts every caller back in one file. */
$rm($dir);
chat_rate_ok('203.0.113.7');
$soloPath  = null;
foreach (glob($dir . '/*/*/*') ?: [] as $g) $soloPath = $g;
$emptyBytes = $soloPath ? filesize($soloPath) : -1;

/* 20,000 other callers already on file for today. The old shape put every one of them in the
   single JSON this function had to decode and re-encode on each call. */
for ($i = 0; $i < 20000; $i++) {
    $k = substr(hash('sha256', "filler$i|$salt"), 0, 16);
    $d = $dir . '/' . $day . '/' . substr($k, 0, 2);
    if (!is_dir($d)) @mkdir($d, 0775, true);
    file_put_contents($d . '/' . $k, '{"n":1}');
}
clearstatcache();
chat_rate_ok('203.0.113.7');                       // same caller, now among 20,000 others
$loadedBytes = $soloPath ? filesize($soloPath) : -1;
$storeBytes  = array_sum(array_map('filesize', glob($dir . '/*/*/*') ?: []));

printf("  … one caller's file: %d bytes alone, %d bytes among 20,000 — whole store %s KB\n",
       $emptyBytes, $loadedBytes, number_format($storeBytes / 1024));
ok("a call touches the same $loadedBytes bytes whether the store holds 1 caller or 20,000",
   $emptyBytes > 0 && $emptyBytes === $loadedBytes);
/* The ceiling that makes it meaningful: the old shape read the WHOLE store on every call, which
   at this size was a 410 KB file and 5.54 ms. If anyone reintroduces that, this file grows with
   the store and the assertion above fails immediately rather than eventually. */
ok('and that is a tiny fraction of the store, not all of it',
   $loadedBytes > 0 && $loadedBytes < $storeBytes / 100);

$rm($dir);
echo "\n" . ($fail ? $fail . " failed, " : "") . $pass . " passed\n";
exit($fail ? 1 : 0);
