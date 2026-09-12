<?php
/**
 * var_pace() — the upstream gate that geo_pace() and rt_pace() are now both made of.
 *
 * The two it replaces were each wrong in two ways at once, and the API comments in front of them
 * asserted a guarantee neither kept ("holds the whole site to ~1 upstream call/sec no matter how
 * many people are typing"):
 *
 *   1. NO LOCK between reading the clock and touching it, so N concurrent callers read the same
 *      mtime, slept the same amount and fired together. The pacer was a no-op under exactly the
 *      concurrency it existed to control.
 *   2. filemtime() is integer SECONDS while microtime() is not, so the wait undershot by up to
 *      990 ms depending on where in the second the last call landed — about 2x the intended rate
 *      on average, 10x at the worst phase. That arithmetic is reproduced below and asserted
 *      against, because it is the part that looks right when you read it.
 *
 * What replaces them reserves a slot under the lock and sleeps outside it, so ten simultaneous
 * callers get ten DISTINCT slots. Past a cap it sheds instead of queueing, because a queued
 * request is a PHP worker asleep on a third party and enough of them is an outage of our own
 * making.
 *
 * Timing is asserted in ONE direction only — that calls are at least a gap apart. An upper bound
 * would be a machine-speed test that fails on a loaded laptop and tells you nothing.
 *
 * Run: php test/pace-test.php
 */
if (!function_exists('env')) { function env($k, $d = null) { return $d; } }
define('SECURE_ACCESS', true);
require __DIR__ . '/../lib/varstore.php';

$pass = 0; $fail = 0;
function ok(string $what, bool $cond) {
    global $pass, $fail;
    if ($cond) { $pass++; echo "  ✓ $what\n"; }
    else       { $fail++; echo "  ✗ $what\n"; }
}
$path = sys_get_temp_dir() . '/ttb-pace-' . getmypid();
@unlink($path);

/* ── sequential calls are spaced by at least the gap ──────────────────────────────────── */
$gap = 120000;                                    // 120ms, so the suite stays quick
$t0 = microtime(true); $at = [];
for ($i = 0; $i < 4; $i++) { var_pace($path, $gap, 5000000); $at[] = (microtime(true) - $t0) * 1000; }

$gaps = [];
for ($i = 1; $i < count($at); $i++) $gaps[] = $at[$i] - $at[$i - 1];
$minGap = min($gaps);
/* A LOOSE BOUND ON PURPOSE, and it was tightened once and flaked immediately. Measured gaps run
   116-120ms against a requested 120: usleep wakes when the scheduler gets round to it, and the
   slot is reserved a moment before the sleep starts, so wall clock is always a little under. A
   0.95 floor put the threshold at 114ms and `make check` failed on a busy machine while the same
   test passed standalone — a machine-speed test, which CLAUDE.md warns is how an instrument
   invents a defect. The EXACT property is the reservation spacing, and that is asserted below
   against the marker, where it is deterministic. This one only has to catch "no pacing at all",
   which shows up as ~0ms and cannot hide under 0.8. */
ok(sprintf('four calls are spaced by roughly the %dms gap (smallest %.0fms)', $gap / 1000, $minGap),
   $minGap >= $gap / 1000 * 0.8);
ok('the first call is not delayed at all', $at[0] < $gap / 1000);

/* ── the reservation is what makes concurrency safe ───────────────────────────────────── */
/* Ten callers reserve BEFORE any of them sleeps — which is what a burst of parallel requests
   does. Each must get its own slot; the old pacer handed all ten the same one. Reserving without
   sleeping is exactly what var_pace does under its lock, so this reads the file between calls
   rather than staging ten processes: the marker must advance by one gap every time. */
@unlink($path);
$marks = [];
for ($i = 0; $i < 10; $i++) {
    var_pace($path, 1, 5000000);                  // 1us gap: reserve, never actually sleep
    $marks[] = (int)(var_read($path)['next'] ?? 0);
}
$strictlyIncreasing = true;
for ($i = 1; $i < count($marks); $i++) if ($marks[$i] <= $marks[$i - 1]) $strictlyIncreasing = false;
ok('ten reservations advance the marker every time — no two callers share a slot', $strictlyIncreasing);

/* ── past the cap it sheds rather than queueing ───────────────────────────────────────── */
/* THE QUEUE IS SEEDED RATHER THAN BUILT, and the first attempt at this test is the reason: a
   loop of sequential var_pace() calls can never shed, because every accepted call SLEEPS until
   its own slot, so real time keeps pace with the marker and the queue never deepens. That is a
   true and reassuring fact about the design — only genuinely concurrent callers can outrun it —
   but as a test it is an infinite loop, which is what it did. Writing the marker directly states
   the condition under test ("the queue is already 10s deep") without staging the concurrency
   that would produce it, and it is deterministic besides. */
@unlink($path);
$cap = 500000;                                    // half a second of queue allowed
$now = (int)(microtime(true) * 1000000);
file_put_contents($path, json_encode(['next' => $now + 10000000]));   // 10s deep
$before = (int)(var_read($path)['next'] ?? 0);
$shed = var_pace($path, 400000, $cap);
ok('a queue deeper than the cap is refused rather than slept through', $shed === false);
ok('and a shed caller does not move the marker — it must not push the queue out for everyone',
   (int)(var_read($path)['next'] ?? 0) === $before);

/* the same store, once the queue has drained, lets the next caller straight through */
file_put_contents($path, json_encode(['next' => $now - 1000000]));    // a slot already past
$b2 = (int)(var_read($path)['next'] ?? 0);
ok('a drained queue admits the next caller immediately', var_pace($path, 400000, $cap) === true);
ok('…and an accepted caller DOES move the marker', (int)(var_read($path)['next'] ?? 0) > $b2);

/* ── an unwritable store fails OPEN, never refuses a customer ─────────────────────────── */
ok('an unreachable path is allowed through rather than refused',
   var_pace('/proc/definitely/not/writable/ttb-pace', $gap, 5000000) === true);

/* ── the arithmetic that made the OLD pacer wrong ─────────────────────────────────────── */
/* Reproduced rather than described: filemtime truncates to the second, so elapsed time is
   overstated by however far into the second the last call landed, and the wait undershoots by
   exactly that much. Nothing in the product runs this — it exists so the defect stays legible if
   anyone is ever tempted to go back to an mtime clock. */
$worst = 0.0;
foreach ([0.0, 0.25, 0.5, 0.75, 0.99] as $sub) {
    $lastSeen = 1000 * 1000000;                       // filemtime: the .sub is gone
    $now      = (int)((1000 + $sub) * 1000000);       // microtime: it is not
    $computed = max(0, 1100000 - ($now - $lastSeen));
    $worst    = max($worst, (1100000 - $computed) / 1000);
}
ok(sprintf('an mtime clock undershoots the wait by up to %.0fms — which is why it is gone', $worst),
   $worst > 900);

@unlink($path);
echo "\n" . ($fail ? $fail . " failed, " : "") . $pass . " passed\n";
exit($fail ? 1 : 0);
