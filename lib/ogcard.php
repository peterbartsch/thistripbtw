<?php
/* this trip, btw — the per-trip link preview card (D-123).
 *
 * Renders the trip's NAME onto the brand card, so a shared link arrives in a group chat looking
 * like a specific trip rather than a bare URL. Peter's call, 2026-08-04, against the recorded
 * default — the reasoning and its cost are in D-123.
 *
 * ── WHAT THIS MAY AND MAY NOT DRAW ─────────────────────────────────────────────────────────
 * The NAME ONLY. Never the route, the places, the dates, the photos or the map.
 *
 * That is not caution for its own sake, it is the shape of the problem: the phrase rides in the
 * URL fragment, which no browser transmits, so a link scraper is unauthenticated BY
 * CONSTRUCTION — this endpoint cannot tell an invited friend's Slack from a stranger's, and it
 * never will be able to. Whatever is drawn here is drawn for anyone holding the slug, and is
 * then cached on infrastructure we do not control and cannot purge when the trip's term ends.
 *
 * A name is a string the buyer chose and is deliberately handing to someone. A route is the
 * trip. The first is a reasonable thing to publish on their behalf; the second is not ours to
 * publish at all. If this ever grows a second field, that is a DECISIONS entry, not a patch.
 */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }

function og_card_render(string $name): ?string {
    $base = PUBLIC_DIR . '/og-base.png';
    $font = PUBLIC_DIR . '/fonts/barlow-condensed-700.ttf';
    if (!function_exists('imagecreatefrompng') || !is_file($base) || !is_file($font)) return null;

    $im = @imagecreatefrompng($base);
    if (!$im) return null;
    imagesavealpha($im, true);

    $name = trim(preg_replace('/\s+/u', ' ', $name));
    if ($name === '') $name = 'A trip';
    /* One line of a name, not a paragraph of one. A 40-char cap is what `submitName()` already
       enforces client-side; this clamps again because an API-written name never passed through
       it, and an unbounded string would run off the card or wrap into the footer band. */
    if (mb_strlen($name) > 40) $name = mb_substr($name, 0, 39) . '…';
    $name = mb_strtoupper($name, 'UTF-8');

    /* Fit the width by trying sizes down, rather than guessing one: "Kishwaukee canoe" and
       "Two cars to Tempe, then the long way home" are both legal names. */
    $maxW = 1000; $size = 82;
    for (; $size >= 34; $size -= 2) {
        $b = imagettfbbox($size, 0, $font, $name);
        if (($b[2] - $b[0]) <= $maxW) break;
    }
    $b = imagettfbbox($size, 0, $font, $name);
    $w = $b[2] - $b[0];
    $x = (int)((1200 - $w) / 2) - $b[0];
    $y = 400;                                   // baseline, clear of the sign and the band

    $ink = imagecolorallocate($im, 0xF0, 0xF7, 0xFB);
    imagettftext($im, $size, 0, $x, $y, $ink, $font, $name);

    ob_start();
    imagepng($im, null, 6);
    $png = ob_get_clean();
    return $png ?: null;
}

/** Serve the card for a slug. Public by design — it is a link preview — but it reveals only
 *  the name, and an unknown slug gets the plain brand card rather than a 404 that would tell a
 *  scanner which slugs exist. */
function og_card_serve(string $slug): void {
    $name = '';
    try {
        $row = q_first('SELECT name FROM trips WHERE slug=?', [$slug]);
        if ($row) $name = (string)($row['name'] ?? '');
    } catch (\Throwable $e) { $name = ''; }

    $png = $name !== '' ? og_card_render($name) : null;
    if ($png === null) {
        $f = PUBLIC_DIR . '/og.png';
        if (is_file($f)) { header('Content-Type: image/png');
            header('Cache-Control: public, max-age=86400'); readfile($f); return; }
        http_response_code(404); exit;
    }
    header('Content-Type: image/png');
    header('Content-Length: ' . strlen($png));
    /* Scrapers refetch rarely and cache hard anyway; a day is long enough to be cheap and short
       enough that a renamed trip's card catches up on its own. */
    header('Cache-Control: public, max-age=86400');
    header('X-Content-Type-Options: nosniff');
    echo $png;
}
