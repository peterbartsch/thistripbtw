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
function export_build(string $slug, array $trip, string $who): ?string {
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
                     . 'decimal degrees. Sealed drops left for other people appear with empty '
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
    $zip->addFromString('itinerary.html', export_html($slug, $trip, $pins, $notes));

    /* Photos, gathered from the SEALED pin list — never by walking the directory, which would
       hand over every sealed drop's picture regardless of who is asking. */
    $seen = [];
    foreach ($pins as $p) {
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
function export_html(string $slug, array $trip, array $pins, array $notes): string {
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
        . "p.n{white-space:pre-wrap;margin:6px 0 0}img{max-width:100%;height:auto;border-radius:8px;margin-top:10px}"
        . "footer{border-top:1px solid #e2e2e2;margin-top:26px;padding-top:14px;color:#666;font-size:.86em}"
        . "a{color:#006B70}</style>\n";
    $h .= "<h1>$name</h1>\n<p class=\"sub\">" . export_e('https://' . APEX . '/' . $slug)
        . ' &middot; exported ' . export_e(gmdate('j F Y')) . "</p>\n";

    foreach ($pins as $p) {
        $sealed = ($p['kind'] ?? '') === 'sealed' || !empty($p['near_only']);
        $title  = (string)($p['title'] ?? '');
        if ($sealed && $title === '') {
            $h .= "<section><p class=\"m\"><em>A sealed drop, still shut. It was left for someone "
                . "else, so its words are not in this file either.</em></p></section>\n";
            continue;
        }
        $h .= "<section>\n";
        if (!empty($p['date'])) $h .= '  <div class="d">' . export_e($p['date']) . "</div>\n";
        $h .= '  <h2>' . export_e($title !== '' ? $title : 'Stop') . "</h2>\n";
        $bits = [];
        if (!empty($p['mode']))    $bits[] = export_e($p['mode']);
        if (!empty($p['lodging'])) $bits[] = 'stay: ' . export_e($p['lodging']);
        if (!empty($p['author']))  $bits[] = 'by ' . export_e($p['author']);
        $bits[] = export_e(round((float)$p['lat'], 5) . ', ' . round((float)$p['lng'], 5));
        $h .= '  <p class="m">' . implode(' &middot; ', $bits) . "</p>\n";
        if (!empty($p['notes'])) $h .= '  <p class="n">' . export_e($p['notes']) . "</p>\n";
        if (!empty($p['photo'])) $h .= '  <img src="photos/' . export_e(basename((string)$p['photo']))
                                     . '" alt="">' . "\n";
        $h .= "</section>\n";
    }

    foreach ($notes as $n) {
        $t = (string)($n['text'] ?? ($n['body'] ?? ''));
        if ($t !== '') $h .= '<section><p class="n">' . export_e($t) . "</p></section>\n";
    }

    $h .= "<footer>Exported from <a href=\"https://" . export_e(APEX) . "\">" . export_e(APEX)
        . "</a>. The photos sit beside this file in <code>photos/</code>, so keep them together. "
        . "Nothing here calls the internet.</footer>\n</html>\n";
    return $h;
}
