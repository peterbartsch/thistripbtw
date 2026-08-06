<?php
/* The map files in the export zip: trip.kml and trip.gpx (2026-08-04).
 *
 * The one thing that ALWAYS bites here — it produced the only real defects of the D-100→D-103
 * ingest work — is coordinate order: KML writes `lon,lat`, GPX writes `lat=`/`lon=` attributes.
 * A file with the order flipped looks completely fine and draws the trip in the ocean off
 * Antarctica. So this test uses a fixture whose latitude and longitude cannot be confused
 * (Chicago: lat 41.88, lng -87.63 — the sign alone tells you which is which) and asserts the
 * exact serialized strings.
 *
 * Run: php test/export-map-test.php   (no DB, no network — both builders are pure functions)
 */
define('SECURE_ACCESS', true);
$root = dirname(__DIR__);
require "$root/lib/config.php";
require "$root/lib/export.php";

$pass = 0; $fail = 0;
function ok(string $w, bool $c) { global $pass, $fail;
  if ($c) { $pass++; echo "  ✓ $w\n"; } else { $fail++; echo "  ✗ $w\n"; } }

$trip = ['name' => 'College Move', 'labels_json' => '{"truck":"The Truck"}'];
$mk = fn($over) => array_merge([
    'id' => 'p1', 'kind' => 'stop', 'track' => 'truck', 'date' => null, 'title' => 'Somewhere',
    'lat' => 0.0, 'lng' => 0.0, 'mode' => 'drive', 'craft' => '', 'fly' => 0, 'lodging' => '',
    'notes' => '', 'photo' => '', 'spotify' => '', 'path' => null, 'near_only' => 0,
    'author' => '', 'updated' => 0, 'seq' => 0,
], $over);

$pins = [
    $mk(['id' => 'a', 'title' => 'Loop, Chicago', 'lat' => 41.88, 'lng' => -87.63, 'seq' => 0]),
    $mk(['id' => 'b', 'title' => 'Downtown Kansas City — lunch', 'lat' => 39.0997, 'lng' => -94.5786,
         'seq' => 1, 'date' => '2026-08-07', 'lodging' => 'Motel',
         'path' => [[40.5, -90.25], [40.0, -92.0]]]),
    // an UNOPENED sealed drop: seal_pin blanks the title; the map files must skip it whole
    $mk(['id' => 's', 'kind' => 'sealed', 'title' => '', 'lat' => 39.5, 'lng' => -91.5, 'seq' => 2]),
    // an "<xml> & ampersand" title: escaping must hold in both formats
    $mk(['id' => 'c', 'kind' => 'post', 'track' => null, 'title' => 'Tom & Jerry <stop>',
         'lat' => 38.0, 'lng' => -90.0, 'seq' => 3]),
];

$kml = export_kml($trip, $pins);
$gpx = export_gpx('abc1234', $trip, $pins);

/* ── the order trap, asserted as exact strings ──────────────────────────────────────── */
ok('KML writes lon,lat — Chicago is "-87.63,41.88"', str_contains($kml, '-87.63,41.88'));
ok('KML never writes lat,lon for Chicago',           !str_contains($kml, '41.88,-87.63'));
ok('GPX writes lat= lon= attributes for Chicago',    str_contains($gpx, 'lat="41.88" lon="-87.63"'));
ok('GPX never swaps them',                           !str_contains($gpx, 'lat="-87.63"'));

/* ── both parse as XML (the escaping test that matters) ─────────────────────────────── */
$kx = @simplexml_load_string($kml);
$gx = @simplexml_load_string($gpx);
ok('KML parses as XML with an & and a <tag> in a title', $kx !== false);
ok('GPX parses as XML with the same title',              $gx !== false);
ok('the ampersand title survives, escaped',   str_contains($kml, 'Tom &amp; Jerry'));

/* ── the sealed rule is STRICTER than trip.json: the pin is absent, not blanked ─────── */
ok('an unopened drop\'s coordinates are NOT in the KML', !str_contains($kml, '39.5') && !str_contains($kml, '-91.5'));
ok('nor in the GPX',                                     !str_contains($gpx, '39.5') && !str_contains($gpx, '-91.5'));

/* ── the drawn path (D-117: nothing can rebuild it) rides in the leg line ───────────── */
ok('KML track line carries the hand-drawn points, lon,lat', str_contains($kml, '-90.25,40.5'));
ok('GPX trkseg carries them as trkpt lat/lon',   str_contains($gpx, '<trkpt lat="40.5" lon="-90.25"/>'));
ok('the line runs origin → drawn points → stop', strpos($kml, '-87.63,41.88 -90.25,40.5') !== false);

/* ── vocabulary is the itinerary\'s, and the first stop of a track has no arrival ────── */
ok('a later stop says how you arrive ("arrive by car")', str_contains($kml, 'arrive by car'));
$firstDesc = $kx ? (string)($kx->Document->Placemark[0]->description ?? '') : 'PARSE-FAIL';
ok('the track\'s FIRST stop claims no arrival mode', !str_contains($firstDesc, 'arrive'));
ok('the track label comes from labels_json',   str_contains($gpx, '<name>The Truck</name>'));
ok('headings use the place, not the full title', str_contains($kml, '2. Downtown Kansas City</name>'));

echo "\n$pass passed" . ($fail ? ", $fail FAILED" : ", 0 failed") . "\n";
exit($fail ? 1 : 0);
