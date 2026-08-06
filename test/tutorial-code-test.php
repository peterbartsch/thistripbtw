<?php
/* The code on /tutorials is EXTRACTED FROM THE PAGE AND RUN (queue #7, 2026-08-02).
 *
 * A tutorial whose snippet does not work is worse than no tutorial: the reader assumes they
 * mistyped it, and the first thing they learn about this product is that its documentation
 * lies. Copying the samples into a test file would defeat the point — a copy keeps passing
 * after the page drifts — so this pulls them out of `tutorials.html` and executes them.
 *
 * The assertion worth having is the three-way one: the JavaScript sample, the Python sample and
 * `mcp_build_link()` must all produce the SAME base64. That is what makes "build the link
 * yourself" a real alternative to the MCP server rather than a plausible-looking approximation.
 * The usual way it breaks is a JSON encoder inserting spaces, which the page warns about and
 * this is what would catch.
 *
 * Run: php test/tutorial-code-test.php   (needs node and python3; skips loudly without them)
 */
define('SECURE_ACCESS', true);
$root = dirname(__DIR__);
require "$root/lib/config.php";
require "$root/lib/mcp.php";

$pass = 0; $fail = 0;
function ok(string $w, bool $c) { global $pass, $fail;
  if ($c) { $pass++; echo "  ✓ $w\n"; } else { $fail++; echo "  ✗ $w\n"; } }

$html = file_get_contents("$root/public/tutorials.html");
ok('/tutorials exists', $html !== false && $html !== '');

/* Pull the two snippets out by their first line. Anchored on content, not on ordinal position,
   so adding a section above them does not silently start testing the wrong block. */
$grab = function (string $startsWith) use ($html): ?string {
  if (!preg_match_all('#<pre><code>(.*?)</code></pre>#s', $html, $m)) return null;
  foreach ($m[1] as $block) {
    $t = html_entity_decode($block, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    if (str_starts_with(ltrim($t), $startsWith)) return $t;
  }
  return null;
};
$js = $grab('const trip = {');
$py = $grab('import base64, json');
ok('the JavaScript sample is on the page', $js !== null);
ok('the Python sample is on the page',     $py !== null);
if ($js === null || $py === null) { echo "\n" . ($fail) . " failed\n"; exit(1); }

$tmp = sys_get_temp_dir() . '/ttb-tut-' . bin2hex(random_bytes(4));
@mkdir($tmp);
$run = function (string $bin, string $file, string $code) use ($tmp): ?string {
  $which = trim((string)@shell_exec('command -v ' . escapeshellarg($bin) . ' 2>/dev/null'));
  if ($which === '') return null;                       // not installed: caller reports a skip
  file_put_contents("$tmp/$file", $code);
  return trim((string)@shell_exec(escapeshellarg($which) . ' ' . escapeshellarg("$tmp/$file") . ' 2>&1'));
};

$jsOut = $run('node',    'sample.mjs', $js);
$pyOut = $run('python3', 'sample.py',  $py);

/* What our own server produces for the same trip. If the page and the server disagree, one of
   them is wrong and a reader has no way to tell which. */
$srv = mcp_build_link([
  'name'   => 'Chicago to Denver',
  'origin' => ['name' => 'Chicago, IL', 'lat' => 41.8781, 'lng' => -87.6298],
  'legs'   => [
    ['to' => ['name' => 'Omaha, NE',  'lat' => 41.2565, 'lng' => -95.9345],  'mode' => 'drive', 'date' => '2026-09-04'],
    ['to' => ['name' => 'Denver, CO', 'lat' => 39.7392, 'lng' => -104.9903], 'mode' => 'drive', 'date' => '2026-09-06'],
  ]])['url'];
$payload = fn(?string $u) => $u === null ? null : substr($u, strpos($u, '#d=') + 3);
$want = $payload($srv);

if ($jsOut === null) { echo "  – node not installed, JavaScript sample not run\n"; }
else {
  ok('the JavaScript sample runs and prints a /new#d= URL',
     str_contains($jsOut, 'thistripbtw.us/new#d='));
  ok('and its payload is byte-identical to mcp_build_link()', $payload($jsOut) === $want);
}
if ($pyOut === null) { echo "  – python3 not installed, Python sample not run\n"; }
else {
  ok('the Python sample runs and prints a /new#d= URL',
     str_contains($pyOut, 'thistripbtw.us/new#d='));
  ok('and its payload is byte-identical to mcp_build_link()', $payload($pyOut) === $want);
}
if ($jsOut !== null && $pyOut !== null) {
  ok('both languages agree with each other', $payload($jsOut) === $payload($pyOut));
}

/* The payload must decode to the object the page documents, or the JSON block above the code is
   describing something the code does not produce. */
$json = json_decode(base64_decode(strtr($want, '-_', '+/')), true);
ok('the payload decodes to JSON',                     is_array($json));
ok('with the documented keys, in the documented order', array_keys($json ?? []) === ['o', 'l', 'n']);
ok('two legs, as the example says',                   count($json['l'] ?? []) === 2);
ok('and coordinates survive the round trip',
   ($json['l'][1]['to']['lng'] ?? null) === -104.9903);

/* The page tells the reader to strip padding and use the URL-safe alphabet. Check we do. */
ok('no "=" padding, and no "+" or "/" — as the page instructs',
   !str_contains($want, '=') && !str_contains($want, '+') && !str_contains($want, '/'));

array_map('unlink', glob("$tmp/*") ?: []); @rmdir($tmp);
echo "\n" . ($fail ? "$fail failed, " : '') . "$pass passed\n";
exit($fail ? 1 : 0);
