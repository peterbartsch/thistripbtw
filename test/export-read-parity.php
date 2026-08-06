<?php
/* D-107: the zip's itinerary.html and the app's Read panel describe the SAME trip, so they must
 * not disagree about it. One is PHP on the server, one is JS in the browser, and nothing but this
 * file stops them drifting.
 *
 * The specific thing worth pinning is the honesty fix, because it is the one that was wrong in
 * both: a stop's `mode` is how you got TO it, so a track's FIRST stop has no inbound leg and must
 * print no mode at all. The live demo's "Chicago O'Hare — 9:40a flight to Reno" printed as a
 * drive in both places, because that is where its traveller starts.
 *
 * Run: php test/export-read-parity.php   (no DB, no network — export_html is a pure function)
 */
define('SECURE_ACCESS', true);
$root = dirname(__DIR__);
require "$root/lib/config.php";
require "$root/lib/export.php";

$pass = 0; $fail = 0;
function ok(string $w, bool $c) { global $pass, $fail;
  if ($c) { $pass++; echo "  ✓ $w\n"; } else { $fail++; echo "  ✗ $w\n"; } }

/* ── the vocabularies must match, word for word ─────────────────────────────────────── */
$appSrc = file_get_contents("$root/public/app.html");
preg_match('/const READ_MODE = \{(.*?)\};/s', $appSrc, $m);
ok('READ_MODE was found in app.html', !empty($m));
$appModes = [];
if (!empty($m)) {
  preg_match_all('/(\w+):"([^"]+)"/', $m[1], $mm, PREG_SET_ORDER);
  foreach ($mm as $x) $appModes[$x[1]] = $x[2];
}
ok('the app and the export know the same modes',
   array_keys($appModes) === array_keys(EXPORT_ARRIVE));
ok('and phrase every one of them identically', $appModes === EXPORT_ARRIVE);
ok('every mode reads as ARRIVAL, not as a label',
   count(array_filter(EXPORT_ARRIVE, fn($v) => str_starts_with($v, 'by ') || $v === 'on foot'))
     === count(EXPORT_ARRIVE));

/* ── render a real two-vehicle trip and read the output ─────────────────────────────── */
$trip = ['name' => 'Weekend at Tahoe', 'tier' => 'keep', 'created' => 0, 'expires' => null,
         'labels_json' => '{"truck":"Sam\'s Subaru","rental":"Alex\'s Rental"}'];
$pins = export_sort([
  ['id'=>'a','kind'=>'stop','track'=>'truck','date'=>'2026-08-01','title'=>'San Francisco — load up, coffee, go',
   'lat'=>37.77,'lng'=>-122.41,'mode'=>'drive','craft'=>'','lodging'=>'','notes'=>'','author'=>'','seq'=>1],
  ['id'=>'b','kind'=>'stop','track'=>'truck','date'=>'2026-08-01','title'=>'Tahoe City — cabin check-in',
   'lat'=>39.17,'lng'=>-120.14,'mode'=>'drive','craft'=>'','lodging'=>'The cabin','notes'=>'code 4417','author'=>'','seq'=>2],
  ['id'=>'c','kind'=>'stop','track'=>'rental','date'=>'2026-08-01','title'=>'Chicago O’Hare — 9:40a flight to Reno',
   'lat'=>41.97,'lng'=>-87.90,'mode'=>'drive','craft'=>'','lodging'=>'','notes'=>'','author'=>'','seq'=>1],
  ['id'=>'d','kind'=>'stop','track'=>'rental','date'=>'2026-08-01','title'=>'Reno–Tahoe (RNO) — land, grab the rental',
   'lat'=>39.49,'lng'=>-119.76,'mode'=>'fly','craft'=>'','lodging'=>'','notes'=>'','author'=>'','seq'=>2],
]);
$html = export_html('efevnwm', $trip, $pins, []);

/* THE defect, in the file people keep. An origin has no leg into it. */
ok('a track\'s FIRST stop prints no arrival mode',
   preg_match('#<h2>1\. Chicago O’Hare[^<]*</h2>\s*<p class="m">(?!by )#u', $html) === 1);
ok('and neither does the other track\'s first stop',
   preg_match('#<h2>1\. San Francisco[^<]*</h2>\s*<p class="m">(?!by )#u', $html) === 1);
ok('a stop you flew to says so',   str_contains($html, 'by air'));
ok('a stop you drove to says so',  str_contains($html, 'by car'));
ok('the raw mode word never appears as a label',
   !preg_match('#<p class="m">\s*(drive|fly|water)\s*&middot;#', $html));

/* ── structure, matching the Read panel ─────────────────────────────────────────────── */
ok('two vehicles produce two labelled bands',
   str_contains($html, "Sam&#039;s Subaru") || str_contains($html, "Sam's Subaru"));
ok('and the second one too',
   str_contains($html, "Alex&#039;s Rental") || str_contains($html, "Alex's Rental"));
ok('legs are numbered within their own track, not across the trip',
   substr_count($html, '<h2>1. ') === 2 && substr_count($html, '<h2>2. ') === 2);

/* THE assertion the first version of this file was missing, and the reason a broken export
   passed it: counting that two headings EXIST says nothing about whether the stops underneath
   belong to them. `export_sort()` interleaves vehicles, so the shipped output put Alex's second
   stop under Sam's heading. Check the ORDER of the rendered blocks, not their presence. */
preg_match_all('#<h2 class="vh">([^<]+)</h2>|<h2>(\d)\. ([^—<]+)#u', $html, $seq, PREG_SET_ORDER);
$flat = array_map(fn($x) => $x[1] !== '' ? "BAND:" . html_entity_decode($x[1], ENT_QUOTES)
                                         : "leg{$x[2]}:" . trim($x[3]), $seq);
ok('every stop sits under its OWN vehicle heading',
   $flat === ["BAND:Sam's Subaru", "leg1:San Francisco", "leg2:Tahoe City",
              "BAND:Alex's Rental", "leg1:Chicago O’Hare", "leg2:Reno–Tahoe (RNO)"]
   || $flat === ["BAND:Alex's Rental", "leg1:Chicago O’Hare", "leg2:Reno–Tahoe (RNO)",
                 "BAND:Sam's Subaru", "leg1:San Francisco", "leg2:Tahoe City"]);
if (!in_array($flat[0] ?? '', ["BAND:Sam's Subaru", "BAND:Alex's Rental"], true))
  echo "      got: " . implode(' | ', $flat) . "\n";

/* And the summary must describe ONE journey. Taking the interleaved sort's endpoints described
   "Chicago O'Hare → Reno–Tahoe" for a trip that goes San Francisco → Reno. */
/* Two tracks of equal size: there is no single journey, so the summary must not invent one.
   A tie broken by array order is not a decision — the shipped zip claimed "Chicago O'Hare →
   Reno–Tahoe" for a trip going San Francisco → Reno. */
ok('two equal vehicles produce NO route claim, only dates',
   !str_contains($html, '&rarr;') && str_contains($html, '1 Aug 2026'));
$lop = export_html('x', $trip, array_merge($pins, [
  ['id'=>'e','kind'=>'stop','track'=>'truck','date'=>'2026-08-03','title'=>'Sacramento — home',
   'lat'=>38.58,'lng'=>-121.49,'mode'=>'drive','craft'=>'','lodging'=>'','notes'=>'','author'=>'','seq'=>3]]), []);
ok('but a clearly busier track DOES give the summary',
   str_contains($lop, 'San Francisco &rarr; Sacramento'));
ok('the header always says WHEN', str_contains($html, '1 Aug 2026'));
ok('lodging and notes still survive',
   str_contains($html, 'The cabin') && str_contains($html, 'code 4417'));

/* A one-vehicle trip must NOT be given a category it does not have. */
$oneTrack = array_values(array_filter($pins, fn($p) => $p['track'] === 'truck'));
$solo = export_html('x', $trip, $oneTrack, []);
ok('one vehicle gets no vehicle heading at all', !str_contains($solo, 'class="vh"'));

/* Still self-contained — the whole reason the file exists. */
ok('no stylesheet, script, font or remote image', !preg_match('#<(script|link)\b#i', $html));
/* The real question is whether any URL points somewhere we do not control — counting "http"
   against APEX was never that, because APEX also appears as visible anchor text. */
preg_match_all('#https?://([^/"\s<]+)#', $html, $hosts);
ok('every URL in the file points at our own domain, and nowhere else',
   array_values(array_unique($hosts[1])) === [APEX]);

/* Dates never go through a zone. Renders identically wherever it is run. */
$was = date_default_timezone_get();
date_default_timezone_set('Pacific/Kiritimati');           // UTC+14
$a = export_span(['2026-08-01', '2026-08-04']);
date_default_timezone_set('Pacific/Midway');               // UTC-11
$b = export_span(['2026-08-01', '2026-08-04']);
date_default_timezone_set($was);
ok("the date span is the same on both sides of the date line ($a)", $a === $b);

echo "\n" . ($fail ? "$fail failed, " : '') . "$pass passed\n";
exit($fail ? 1 : 0);
