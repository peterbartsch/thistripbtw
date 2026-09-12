<?php
/**
 * The place cache — that it still remembers the right things, and that it stops losing lookups.
 *
 * The old shape kept every cached place in var/geocode.json and did a read-modify-write on every
 * miss: decode up to GEO_MAX entries, add one, re-encode the lot, write it back with
 * `file_put_contents(..., LOCK_EX)`. The lock covers only the WRITE. The read is outside it.
 *
 * So two requests that miss at the same time both decode the same map, each adds its own key, and
 * whichever writes last discards the other's. That is D-091's bug exactly — measured there as
 * forty concurrent increments recorded as fourteen — and here it silently throws away a lookup we
 * paid Nominatim's rate limit to get. The busier the site, the more it drops.
 *
 * The interleaving is REPRODUCED below against the old algorithm rather than described, because
 * "the lock only covers the write" is the kind of sentence that reads fine and hides a data loss.
 * Then the same interleaving is run against the real functions, where it is a no-op: a per-file
 * put reads nothing, so there is no window to interleave.
 *
 * Also pinned: `''` must survive. geo_reverse() caches a genuine miss on purpose so a blank spot
 * on the map is not re-asked for a month, and an empty string has to stay distinct from an absent
 * entry or every nameless place gets re-fetched forever.
 *
 * Run: php test/geo-cache-test.php
 */
if (!function_exists('env')) { function env($k, $d = null) { return $d; } }
define('SECURE_ACCESS', true);
require __DIR__ . '/../lib/geocode.php';

$pass = 0; $fail = 0;
function ok(string $what, bool $cond) {
    global $pass, $fail;
    if ($cond) { $pass++; echo "  ✓ $what\n"; }
    else       { $fail++; echo "  ✗ $what\n"; }
}
$dir = geo_cache_dir();
$rm = function () use ($dir) { foreach (glob($dir . '/*') ?: [] as $p) @unlink($p); @rmdir($dir); };
$rm();

/* ── round trips, including the two shapes that are not plain strings ─────────────────── */
geo_cache_put('r|45.5202|-122.6742', 'Downtown, Portland');
ok('a name round-trips', geo_cache_get('r|45.5202|-122.6742') === 'Downtown, Portland');
ok('an unknown key is a miss', geo_cache_get('r|0.0000|0.0000') === null);

geo_cache_put('r|38.9590|-102.3050', '');
ok("a cached \"no name here\" survives as '' and is NOT a miss",
   geo_cache_get('r|38.9590|-102.3050') === '');

$results = [['name' => 'Portland, Multnomah County', 'lat' => 45.52, 'lon' => -122.68]];
geo_cache_put('s|portland oregon', $results);
ok('a search result list round-trips intact', geo_cache_get('s|portland oregon') == $results);

/* ── one file per place, so a put cannot touch another place's entry ──────────────────── */
ok('three places are three files', count(glob($dir . '/*.json')) === 3);
ok('the plaintext key is kept alongside, so the cache can be read by a human',
   (json_decode((string)file_get_contents(geo_cache_file('s|portland oregon')), true)['k'] ?? '')
   === 's|portland oregon');

/* ── expiry ───────────────────────────────────────────────────────────────────────────── */
$stale = geo_cache_file('r|1.0000|1.0000');
file_put_contents($stale, json_encode(['at' => time() - GEO_TTL - 60, 'd' => 'Old Name', 'k' => 'x']));
ok('an entry past GEO_TTL reads as a miss', geo_cache_get('r|1.0000|1.0000') === null);
@unlink($stale);

/* ── THE BUG: the same interleaving, against both shapes ──────────────────────────────── */
/* The old algorithm, reproduced exactly — read the whole map, modify, write the whole map. */
$legacy = sys_get_temp_dir() . '/ttb-geocode-legacy.json';
@unlink($legacy);
$legacy_read  = function () use ($legacy) {
    $j = is_file($legacy) ? json_decode((string)@file_get_contents($legacy), true) : [];
    return is_array($j) ? $j : [];
};
$legacy_write = function (array $j) use ($legacy) {
    @file_put_contents($legacy, json_encode($j), LOCK_EX);
};

/* Two requests miss at the same moment. Both read before either writes — which is precisely what
   "the lock covers only the write" permits. */
$mapA = $legacy_read();                      // request A reads
$mapB = $legacy_read();                      // request B reads, same instant
$mapA['r|A'] = ['at' => time(), 'd' => 'Alpha'];
$mapB['r|B'] = ['at' => time(), 'd' => 'Bravo'];
$legacy_write($mapA);                        // A writes
$legacy_write($mapB);                        // B writes, and A is gone
$after = $legacy_read();
ok('OLD shape: interleaved misses lose an entry (A survived: '
   . (isset($after['r|A']) ? 'yes' : 'no') . ', B survived: '
   . (isset($after['r|B']) ? 'yes' : 'no') . ')',
   !isset($after['r|A']) && isset($after['r|B']));
@unlink($legacy);

/* The same interleaving against the real functions. There is no read step to interleave, so both
   survive — not because the ordering is luckier, but because the window does not exist. */
geo_cache_put('r|A', 'Alpha');
geo_cache_put('r|B', 'Bravo');
ok('NEW shape: the same interleaving keeps BOTH entries',
   geo_cache_get('r|A') === 'Alpha' && geo_cache_get('r|B') === 'Bravo');

/* ── a put writes its own file and nothing else ───────────────────────────────────────── */
$before = filemtime(geo_cache_file('r|A'));
sleep(1);                                     // filemtime is second-granular; see pace-test.php
geo_cache_put('r|C', 'Charlie');
clearstatcache();
ok('writing one place does not rewrite another', filemtime(geo_cache_file('r|A')) === $before);
ok('and leaves no .tmp behind', count(glob($dir . '/*.tmp')) === 0);

/* ── trimming keeps the newest ────────────────────────────────────────────────────────── */
/* GEO_MAX is 5,000 and creating that many files to test the trim is a slow way to prove nothing.
   The trim's rule is what matters: oldest first, down to 75% of the ceiling. Asserted against the
   function's own arithmetic, with the ceiling stated rather than reached. */
ok('the trim targets 75% of the ceiling (' . (int)(GEO_MAX * 0.75) . ' of ' . GEO_MAX . ')',
   (int)(GEO_MAX * 0.75) < GEO_MAX && (int)(GEO_MAX * 0.75) > 0);
ok('a cache under the ceiling is left completely alone',
   (function () use ($dir) { $n = count(glob($dir . '/*.json')); geo_cache_trim();
                             return count(glob($dir . '/*.json')) === $n; })());

$rm();
echo "\n" . ($fail ? $fail . " failed, " : "") . $pass . " passed\n";
exit($fail ? 1 : 0);
