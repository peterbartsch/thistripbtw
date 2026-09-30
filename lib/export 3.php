<?php
/* this trip, btw — take your trip with you (D-085).
 *
 * Available at EVERY paid tier, deliberately. Charging extra to get your own trip out would
 * read as hostage-taking and would undercut the delete-everything button, which is the thing
 * that makes the privacy promise credible. It costs nothing to give away and it is the
 * strongest available proof the pitch is real.
 *
 * ── THE RULE THAT MATTERS ────────────────────────────────────────────────────────────────────
 * A sealed drop must never leave here for someone who has not opened it. That is not a
 * politeness — surprise is the feature (CLAUDE.md), and an export is exactly the sort of
 * side door that quietly bypasses a check the main path enforces.
 *
 * So this does NOT re-implement the visibility rule. It runs every pin through the SAME
 * `seal_pin(normalize_pin($row), $who)` the state endpoint uses, with `$who` taken from the
 * token the same way (D-047). Whatever the exporter can already see on screen is what lands in
 * the zip, and nothing else. Photos are collected AFTER sealing, so a sealed drop's photo is
 * not in the archive either — copying files by walking the directory instead would have
 * shipped every one of them.
 */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }

/** Sort key for reading order: dated first by date, undated keep their sequence. */
function export_sort(array $pins): array {
    usort($pins, function ($a, $b) {
        $ad = (string)($a['date'] ?? ''); $bd = (string)($b['date'] ?? '');
        if ($ad !== '' && $bd !== '' && $ad !== $bd) return strcmp($ad, $bd);
        if ($ad !== '' && $bd === '') return -1;
        if ($ad === '' && $bd !== '') return 1;
        return ((int)($a['seq'] ?? 0)) <=> ((int)($b['seq'] ?? 0));
    });
    return $pins;
}

function export_e($v): string { return htmlspecialchars((string)$v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }

/**
 * Build the zip. Returns its path on disk, or null if it could not be made.
 * The caller streams it and deletes it.
 */
/* $withPhotos=false builds the SAME zip without the images (D-109). The expiry notice attaches
   one, and photos are what make an export unmailable: a `works` trip may hold 2 GB and no mail
   system will take it. The data and the readable page are the part that must survive; the photos
   are still there behind the download button until the day the trip goes. */
function export_build(string $slug, array $trip, string $who, bool $withPhotos = true): ?string {
    if (!class_exists('ZipArchive')) return null;

    $rows  = q_all('SELECT * FROM pins WHERE slug=? AND deleted=0 ORDER BY seq ASC, id ASC', [$slug]);
    $notes = q_all('SELECT * FROM notes WHERE slug=? AND deleted=0 ORDER BY ord ASC, id ASC', [$slug]);

    // The one line that keeps a sealed drop sealed. Do not "optimise" it away.
    $pins = array_map(fn($r) => seal_pin(normalize_pin($r), $who), $rows);
    $pins = export_sort($pins);

    $tripOut = [
        '_readme'   => 'Your trip, exported from ' . APEX . '. This file is yours. The shape is '
                     . 'documented at ' . APEX . '/for-agents and is stable — dates are '
                     . 'YYYY-MM-DD, timestamps are milliseconds since 1970 UTC, coordinates are '
                     . 'decimal degrees. Easter eggs left for other people appear with empty '
                     . 'text: they were never readable by you and are not readable here.',
        'exported'  => gmdate('c'),
        'address'   => 'https://' . APEX . '/' . $slug,
        'name'      => (string)$trip['name'],
        'tier'      => (string)$trip['tier'],
        'created'   => (int)$trip['created'],
        'expires'   => $trip['expires'] !== null ? (int)$trip['expires'] : null,
        'labels'    => json_decode((string)$trip['labels_json'], true),
        'stops'     => array_map(function ($p) {
            $out = [
                'id' => $p['id'], 'kind' => $p['kind'], 'track' => $p['track'],
                'date' => $p['date'], 'title' => $p['title'], 'lat' => $p['lat'], 'lng' => $p['lng'],
                'mode' => $p['mode'], 'craft' => $p['craft'], 'fly' => $p['fly'],
                'lodging' => $p['lodging'], 'notes' => $p['notes'], 'spotify' => $p['spotify'],
                'author' => $p['author'], 'updated' => $p['updated'],
            ];
            if (!empty($p['photo'])) $out['photo'] = 'photos/' . basename((string)$p['photo']);
            if (!empty($p['path']))  $out['path']  = $p['path'];
            return $out;
        }, $pins),
        'notes'     => array_map(fn($n) => ['id' => $n['id'], 'text' => $n['text'] ?? ($n['body'] ?? ''),
                                            'updated' => (int)($n['updated'] ?? 0)], $notes),
    ];

    $tmp = tempnam(sys_get_temp_dir(), 'ttbexp');
    if ($tmp === false) return null;
    $zip = new ZipArchive();
    if ($zip->open($tmp, ZipArchive::OVERWRITE) !== true) { @unlink($tmp); return null; }

    $zip->addFromString('trip.json',
        json_encode($tripOut, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    $zip->addFromString('itinerary.html', export_html($slug, $trip, $pins, $notes, $withPhotos));
    /* The map files (2026-08-04): the builder READS .gpx/.kml (D-103) but the export never
       wrote them, so a trip could arrive from Google My Maps and not leave for it. Same
       sealed $pins as everything above — see export_mappable() for the one rule that is
       STRICTER here than in trip.json. */
    $zip->addFromString('trip.kml', export_kml($trip, $pins));
    $zip->addFromString('trip.gpx', export_gpx($slug, $trip, $pins));

    /* Photos, gathered from the SEALED pin list — never by walking the directory, which would
       hand over every sealed drop's picture regardless of who is asking. */
    $seen = [];
    if ($withPhotos) foreach ($pins as $p) {
        $f = (string)($p['photo'] ?? '');
        if ($f === '') continue;
        $base = basename($f);
        if (isset($seen[$base]) || !preg_match('/^[A-Za-z0-9._-]+$/', $base)) continue;
        $full = PHOTOS_DIR . '/' . $slug . '/' . $base;
        $real = realpath($full);
        $root = realpath(PHOTOS_DIR . '/' . $slug);
        if ($real === false || $root === false || !str_starts_with($real, $root . '/')) continue;
        if (is_file($real)) { $zip->addFile($real, 'photos/' . $base); $seen[$base] = true; }
    }

    $zip->close();
    return is_file($tmp) ? $tmp : null;
}

/** A readable copy that opens in any browser with no server and no network. */
/* ── shared with the in-app read view (D-106/D-107) ──────────────────────────────────
   The zip's itinerary.html and the app's Read panel render the SAME trip and must not disagree
   about it. These three are the PHP half of that: the same arrival phrasing, the same
   "an origin has no inbound leg" rule, and the same place-name clamp. If one side changes,
   change both — `test/export-read-parity.php` fails if the vocabularies drift. */
const EXPORT_ARRIVE = ['drive'=>'by car', 'fly'=>'by air', 'train'=>'by rail', 'ferry'=>'by ferry',
                       'water'=>'by boat', 'bike'=>'by bike', 'walk'=>'on foot'];

/** A stop's title is often "PLACE — note". For a heading we want the place. */
function export_place(string $t): string {
    $t = trim(preg_split('/\s+[—–-]\s+/u', $t)[0] ?? $t);
    return $t === '' ? 'Stop' : $t;
}

/** "4–7 Sep 2026" / "28 Aug – 3 Sep 2026". Dates are plain YYYY-MM-DD; never a DateTime with a
    zone, which is how this codebase has printed the wrong day three times. */
function export_span(array $dates): string {
    $d = array_values(array_filter($dates)); sort($d);
    if (!$d) return '';
    $a = $d[0]; $b = $d[count($d) - 1];
    $fmt = fn($x, $f) => gmdate($f, (int)strtotime($x . ' 12:00:00 UTC'));
    if ($a === $b)                       return $fmt($a, 'j M Y');
    if (substr($a, 0, 7) === substr($b, 0, 7)) return $fmt($a, 'j') . '–' . $fmt($b, 'j M Y');
    if (substr($a, 0, 4) === substr($b, 0, 4)) return $fmt($a, 'j M') . ' – ' . $fmt($b, 'j M Y');
    return $fmt($a, 'j M Y') . ' – ' . $fmt($b, 'j M Y');
}

function export_html(string $slug, array $trip, array $pins, array $notes, bool $withPhotos = true): string {
    $name = export_e($trip['name'] !== '' ? $trip['name'] : 'our trip');
    $h  = "<!DOCTYPE html>\n<html lang=\"en\"><meta charset=\"utf-8\">\n";
    $h .= "<title>$name</title>\n";
    $h .= "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n";
    /* Self-contained on purpose: no stylesheet, no font, no script, no image host. It has to
       still open in ten years on a laptop with no internet, which is the point of having it. */
    $h .= "<style>body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;"
        . "max-width:44em;margin:0 auto;padding:28px 18px;color:#141414}"
        . "h1{font-size:1.7em;margin:0 0 2px}.sub{color:#666;margin:0 0 26px;font-size:.92em}"
        . "section{border-top:1px solid #e2e2e2;padding:16px 0;break-inside:avoid}"
        . ".d{font-weight:700;font-size:.82em;letter-spacing:.06em;text-transform:uppercase;color:#666}"
        . "h2{font-size:1.12em;margin:2px 0 6px}.m{color:#555;font-size:.9em;margin:0 0 6px}"
        . "h2.vh{font-size:.82em;letter-spacing:.14em;text-transform:uppercase;color:#666;margin:26px 0 0;border-top:2px solid #141414;padding-top:12px}"
        . "p.n{white-space:pre-wrap;margin:6px 0 0}img{max-width:100%;height:auto;border-radius:8px;margin-top:10px}"
        . "footer{border-top:1px solid #e2e2e2;margin-top:26px;padding-top:14px;color:#666;font-size:.86em}"
        . "a{color:#006B70}</style>\n";
    /* The same subtitle the Read panel shows: where it goes and when, then the address. */
    /* The route summary is the BUSIEST track's first → last, not the sorted array's ends. The
       sort interleaves vehicles, so taking its endpoints described "Chicago O'Hare → Reno–Tahoe"
       for a trip that goes San Francisco → Reno: two people's journeys spliced into one claim
       that was true of neither. */
    $mainStops = [];
    foreach ($pins as $p) if (($p['kind'] ?? 'stop') === 'stop') $mainStops[(string)($p['track'] ?? '')][] = $p;
    $sizes = array_map('count', $mainStops);
    arsort($sizes);
    $main = [];
    if (count($sizes) === 1) {
        $main = $mainStops[array_key_first($sizes)];
    } elseif (count($sizes) > 1) {
        $vals = array_values($sizes);
        /* ONLY when one track is strictly bigger. Two equal vehicles are two journeys, and a tie
           broken by array order is not a decision — it just picks one and states it as fact.
           The zip claimed "Chicago O'Hare → Reno–Tahoe" for a trip going San Francisco → Reno.
           When there is no main journey, say the dates and say nothing about the route. */
        if ($vals[0] > $vals[1]) $main = $mainStops[array_key_first($sizes)];
    }
    $sub = [];
    if ($main) {
        $first = export_place((string)($main[0]['title'] ?? ''));
        $last  = export_place((string)($main[count($main) - 1]['title'] ?? ''));
        if ($first !== '' && $last !== '') $sub[] = $first === $last ? $first : "$first &rarr; $last";
    }
    $span = export_span(array_column($pins, 'date'));
    if ($span !== '') $sub[] = export_e($span);
    $sub[] = export_e('https://' . APEX . '/' . $slug);
    $sub[] = 'exported ' . export_e(gmdate('j F Y'));
    $h .= "<h1>$name</h1>\n<p class=\"sub\">" . implode(' &middot; ', $sub) . "</p>\n";

    /* GROUPED BY VEHICLE, and numbered within each — matching the Read panel, and matching how a
       two-vehicle trip actually happened. A flat list interleaves two people's days and reads as
       one confusing sequence. Only when there IS a second vehicle: a one-vehicle trip should not
       be given a category it does not have. */
    $labels = json_decode((string)($trip['labels_json'] ?? '{}'), true) ?: [];
    $labelOf = fn($t) => (string)($labels[$t] ?? ($t === 'truck' ? 'Vehicle 1'
                                 : ($t === 'rental' ? 'Vehicle 2' : $t)));
    /* ITERATE TRACK BY TRACK. `export_sort()` orders by date then seq, which INTERLEAVES two
       vehicles — so emitting a band heading the first time a track appears does not group
       anything: it labels one pin and files the other track's later stops under the wrong
       vehicle. Found by downloading the zip and reading it, which no assertion had done. */
    $byTrack = [];
    $rest    = [];   // posts, sealed drops, quests — they belong to the trip, not to a vehicle
    foreach ($pins as $p) {
        if (($p['kind'] ?? 'stop') === 'stop') $byTrack[(string)($p['track'] ?? '')][] = $p;
        else                                   $rest[] = $p;
    }
    $many  = count($byTrack) > 1;
    $order = [];
    foreach ($byTrack as $t => $ps) $order[] = $t;
    $ordered = [];
    foreach ($order as $t) foreach ($byTrack[$t] as $p) $ordered[] = $p;
    foreach ($rest as $p) $ordered[] = $p;
    $seen = [];   // per-track leg counter

    foreach ($ordered as $p) {
        $sealed = ($p['kind'] ?? '') === 'sealed' || !empty($p['near_only']);
        $title  = (string)($p['title'] ?? '');
        if ($sealed && $title === '') {
            $h .= "<section><p class=\"m\"><em>An easter egg, not opened yet. It was left for someone "
                . "else, so its words are not in this file either.</em></p></section>\n";
            continue;
        }
        $isStop = ($p['kind'] ?? 'stop') === 'stop';
        $tk = (string)($p['track'] ?? '');
        if ($isStop) {
            $seen[$tk] = ($seen[$tk] ?? 0) + 1;
            if ($many && $seen[$tk] === 1) $h .= '<h2 class="vh">' . export_e($labelOf($tk)) . "</h2>\n";
        }
        $h .= "<section>\n";
        if (!empty($p['date'])) $h .= '  <div class="d">' . export_e($p['date']) . "</div>\n";
        $n = $isStop ? $seen[$tk] . '. ' : '';
        $h .= '  <h2>' . $n . export_e($title !== '' ? $title : 'Stop') . "</h2>\n";
        $bits = [];
        /* Arrival, not a label — and NOTHING for the first stop of a track, which has no leg into
           it. The live demo's "Chicago O'Hare — 9:40a flight to Reno" printed as "drive" because
           that is where its traveller STARTS. Confidently wrong, in the file people keep. */
        if ($isStop && $seen[$tk] > 1 && !empty($p['mode']) && isset(EXPORT_ARRIVE[$p['mode']]))
            $bits[] = EXPORT_ARRIVE[$p['mode']];
        if (!empty($p['lodging'])) $bits[] = 'stay: ' . export_e($p['lodging']);
        if (!empty($p['author']))  $bits[] = 'by ' . export_e($p['author']);
        $bits[] = export_e(round((float)$p['lat'], 5) . ', ' . round((float)$p['lng'], 5));
        $h .= '  <p class="m">' . implode(' &middot; ', $bits) . "</p>\n";
        if (!empty($p['notes'])) $h .= '  <p class="n">' . export_e($p['notes']) . "</p>\n";
        /* No <img> when the images are not in the file — a broken-image icon on every stop is a
           worse answer than a sentence saying where they are. */
        if (!empty($p['photo'])) $h .= $withPhotos
            ? '  <img src="photos/' . export_e(basename((string)$p['photo'])) . '" alt="">' . "\n"
            : '  <p class="m"><em>A photo goes here. It is in the full download, not this copy.</em></p>' . "\n";
        $h .= "</section>\n";
    }

    foreach ($notes as $n) {
        $t = (string)($n['text'] ?? ($n['body'] ?? ''));
        if ($t !== '') $h .= '<section><p class="n">' . export_e($t) . "</p></section>\n";
    }

    $h .= "<footer>Exported from <a href=\"https://" . export_e(APEX) . "\">" . export_e(APEX) . "</a>. "
        . ($withPhotos
            ? "The photos sit beside this file in <code>photos/</code>, so keep them together. "
            : "This copy has no photos, to keep it small enough to email. The full download at "
              . "the address above has them, until the trip's term ends. ")
        . "Nothing here calls the internet.</footer>\n</html>\n";
    return $h;
}

/* ── the map files: trip.kml + trip.gpx (2026-08-04) ─────────────────────────────────────────
 *
 * Interop is FORMATS, not partnerships — the whole "PDF for travel" position. These two are
 * what let a trip leave for Google My Maps / Earth (KML) and Garmin / OsmAnd / every GPS tool
 * (GPX), with no API, no key and nobody's permission.
 *
 * THE TRAP, stated here because it has already bitten once (D-103, and the import code's own
 * comment): KML coordinates are `lon,lat` — the OPPOSITE of GPX's `lat=`/`lon=` attributes and
 * of everything else in this codebase. `test/export-map-test.php` pins the order in BOTH
 * formats from fixture coordinates; if you touch these, run it.
 *
 * SEALED DROPS ARE STRICTER HERE THAN IN trip.json. The JSON ships an unopened drop's
 * coordinates (blanked text) because the app needs them for the near-radius check. A map file
 * has no such need, and a nameless waypoint at exact coordinates is a treasure map to the
 * surprise — export_html already renders NOTHING for an unopened drop, and the map files
 * follow that precedent: the pin is skipped whole. */

/** XML text escape (ENT_XML1: KML/GPX are XML, not HTML). */
function export_x($v): string { return htmlspecialchars((string)$v, ENT_QUOTES | ENT_XML1, 'UTF-8'); }

/** Locale-proof coordinate: %F never writes a comma decimal point, whatever the server locale. */
function export_coord(float $v): string { return rtrim(rtrim(sprintf('%.6F', $v), '0'), '.'); }

/** The pins a map file may carry: everything the exporter can SEE. Unopened sealed/near-only
 *  pins arrive from seal_pin() with a blanked title — the same test export_html uses. */
function export_mappable(array $pins): array {
    return array_values(array_filter($pins, function ($p) {
        $locked = ($p['kind'] ?? '') === 'sealed' || !empty($p['near_only']);
        return !($locked && (string)($p['title'] ?? '') === '');
    }));
}

/** Stops grouped per track in reading order, plus everything else, plus track labels —
 *  the same grouping export_html draws, shared so the three artifacts cannot disagree. */
function export_tracks(array $trip, array $pins): array {
    $labels  = json_decode((string)($trip['labels_json'] ?? '{}'), true) ?: [];
    $labelOf = fn($t) => (string)($labels[$t] ?? ($t === 'truck' ? 'Vehicle 1'
                                  : ($t === 'rental' ? 'Vehicle 2' : ($t !== '' ? $t : 'Route'))));
    $byTrack = []; $rest = [];
    foreach ($pins as $p) {
        if (($p['kind'] ?? 'stop') === 'stop') $byTrack[(string)($p['track'] ?? '')][] = $p;
        else                                   $rest[] = $p;
    }
    return [$byTrack, $rest, $labelOf];
}

/** One line of leg geometry for a track: each stop in order, with the hand-drawn path INTO a
 *  stop spliced in before it (encode_path stores intermediates only; endpoints are the stops).
 *  Drawn paths are the one thing here nothing can rebuild (D-117), so losing them from an
 *  export would be losing them, full stop. Returns [[lat,lng],...]. */
function export_trackline(array $stops): array {
    $line = [];
    foreach ($stops as $i => $p) {
        if ($i > 0 && is_array($p['path'] ?? null))
            foreach ($p['path'] as $pt)
                if (is_array($pt) && isset($pt[0], $pt[1])) $line[] = [(float)$pt[0], (float)$pt[1]];
        $line[] = [(float)$p['lat'], (float)$p['lng']];
    }
    return $line;
}

/** What a map pin's description says: the itinerary's vocabulary, not a new one. */
function export_pin_desc(array $p, bool $firstOfTrack): string {
    $bits = [];
    if (!empty($p['date']))    $bits[] = (string)$p['date'];
    if (!$firstOfTrack && !empty($p['mode']) && isset(EXPORT_ARRIVE[$p['mode']]))
        $bits[] = 'arrive ' . EXPORT_ARRIVE[$p['mode']];
    if (!empty($p['lodging'])) $bits[] = 'stay: ' . (string)$p['lodging'];
    if (!empty($p['notes']))   $bits[] = (string)$p['notes'];
    return implode(' · ', $bits);
}

function export_kml(array $trip, array $pins): string {
    $pins = export_mappable($pins);
    [$byTrack, $rest, $labelOf] = export_tracks($trip, $pins);
    $name = (string)$trip['name'] !== '' ? (string)$trip['name'] : 'our trip';

    $k  = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
    $k .= "<kml xmlns=\"http://www.opengis.net/kml/2.2\"><Document>\n";
    $k .= '<name>' . export_x($name) . "</name>\n";

    foreach ($byTrack as $t => $stops) {
        foreach ($stops as $i => $p) {
            $k .= "<Placemark><name>" . export_x(($i + 1) . '. ' . export_place((string)$p['title'])) . "</name>";
            $d = export_pin_desc($p, $i === 0);
            if ($d !== '') $k .= '<description>' . export_x($d) . '</description>';
            /* lon,lat — yes, really. See the header comment. */
            $k .= '<Point><coordinates>' . export_coord((float)$p['lng']) . ',' . export_coord((float)$p['lat'])
                . "</coordinates></Point></Placemark>\n";
        }
        $line = export_trackline($stops);
        if (count($line) > 1) {
            $k .= '<Placemark><name>' . export_x($labelOf($t)) . '</name><LineString><tessellate>1</tessellate><coordinates>';
            $k .= implode(' ', array_map(fn($pt) => export_coord($pt[1]) . ',' . export_coord($pt[0]), $line));
            $k .= "</coordinates></LineString></Placemark>\n";
        }
    }
    foreach ($rest as $p) {
        $k .= '<Placemark><name>' . export_x(export_place((string)$p['title'])) . '</name>';
        $d = export_pin_desc($p, true);
        if ($d !== '') $k .= '<description>' . export_x($d) . '</description>';
        $k .= '<Point><coordinates>' . export_coord((float)$p['lng']) . ',' . export_coord((float)$p['lat'])
            . "</coordinates></Point></Placemark>\n";
    }
    $k .= "</Document></kml>\n";
    return $k;
}

function export_gpx(string $slug, array $trip, array $pins): string {
    $pins = export_mappable($pins);
    [$byTrack, $rest, $labelOf] = export_tracks($trip, $pins);
    $name = (string)$trip['name'] !== '' ? (string)$trip['name'] : 'our trip';

    $g  = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
    $g .= "<gpx version=\"1.1\" creator=\"" . export_x(APEX) . "\" xmlns=\"http://www.topografix.com/GPX/1/1\">\n";
    $g .= '<metadata><name>' . export_x($name) . '</name><link href="' . export_x('https://' . APEX . '/' . $slug)
        . "\"/></metadata>\n";

    $wpt = function (array $p, string $nm, bool $first) {
        /* lat= then lon=, as attributes — the other order from KML, and the reason the test exists. */
        $w = '<wpt lat="' . export_coord((float)$p['lat']) . '" lon="' . export_coord((float)$p['lng']) . '">';
        $w .= '<name>' . export_x($nm) . '</name>';
        $d = export_pin_desc($p, $first);
        if ($d !== '') $w .= '<desc>' . export_x($d) . '</desc>';
        return $w . "</wpt>\n";
    };
    foreach ($byTrack as $stops)
        foreach ($stops as $i => $p)
            $g .= $wpt($p, ($i + 1) . '. ' . export_place((string)$p['title']), $i === 0);
    foreach ($rest as $p)
        $g .= $wpt($p, export_place((string)$p['title']), true);

    foreach ($byTrack as $t => $stops) {
        $line = export_trackline($stops);
        if (count($line) < 2) continue;
        $g .= '<trk><name>' . export_x($labelOf($t)) . "</name><trkseg>\n";
        foreach ($line as $pt)
            $g .= '<trkpt lat="' . export_coord($pt[0]) . '" lon="' . export_coord($pt[1]) . "\"/>\n";
        $g .= "</trkseg></trk>\n";
    }
    $g .= "</gpx>\n";
    return $g;
}
