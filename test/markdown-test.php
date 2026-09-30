<?php
/* Markdown negotiation (2026-09-28). The rule this guards: the markdown and the page say the
   SAME thing. `make check-copy` reads the HTML only, so a claim that existed solely in the
   markdown would ship unchecked — which is why the converter converts and never composes. */
define('SECURE_ACCESS', true);
require __DIR__ . '/../lib/markdown.php';

$pass = 0; $fail = 0;
function ok(string $what, bool $cond, string $detail = '') {
    global $pass, $fail;
    if ($cond) { $pass++; echo "  ✓ $what\n"; }
    else { $fail++; echo "  ✗ $what" . ($detail ? " — $detail" : '') . "\n"; }
}

/* ── who gets markdown ─────────────────────────────────────────────────────────────────── */
ok('an explicit text/markdown asks for it',        md_wants_markdown('text/markdown'));
ok('so does a weighted one',                       md_wants_markdown('text/markdown;q=0.9,text/html'));
ok('text/x-markdown counts too',                   md_wants_markdown('text/x-markdown'));
/* THE ONE THAT MATTERS: every browser sends */ /* */
ok('*/* does NOT — that is every browser alive',   !md_wants_markdown('*/*'));
ok('a browser Accept does not',                    !md_wants_markdown('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'));
ok('an empty Accept does not',                     !md_wants_markdown(''));
ok('a lookalike type does not',                    !md_wants_markdown('text/markdownish'));

/* ── the conversion ────────────────────────────────────────────────────────────────────── */
$root = dirname(__DIR__);
$md = md_from_html(file_get_contents("$root/public/what-you-get.html"));
ok('the page converts to something substantial', strlen($md) > 1500, strlen($md) . ' chars');
ok('it starts with the page h1 as an h1', str_starts_with($md, "# What's free"));
ok('the heading plates come through as headings', str_contains($md, "\n## "));
ok('bold survives', str_contains($md, '**'));
ok('links keep their text and get an absolute href',
   preg_match('/\[[^\]]+\]\(https:\/\/thistripbtw\.us\/[^)]*\)/', $md) === 1);

/* Chrome, decoration and scaffolding are gone. If any of these appear, the converter is handing
   an agent the furniture of a web page, which is the whole thing it exists to strip. */
foreach (['<script', '<svg', '<style', 'aria-hidden', 'Change the theme'] as $junk)
    ok("no \"$junk\" in the markdown", !str_contains($md, $junk));
ok('no raw tags at all', preg_match('/<[a-z][^>]*>/i', $md) === 0);

/* ── the same thing, not a different thing ─────────────────────────────────────────────── */
$html = file_get_contents("$root/public/what-you-get.html");
$plain = preg_replace('/\s+/', ' ', strip_tags(preg_replace('~<(script|style|svg)\b.*?</\1>~si', '', $html)));
$missing = [];
foreach (["There is no free tier and no trial", "no card, no email"] as $claim)
    if (str_contains($plain, $claim) && !str_contains(preg_replace('/\s+/', ' ', strip_tags($md)), $claim)) $missing[] = $claim;
ok('the claims the HTML makes are in the markdown too', $missing === [], implode(' · ', $missing));

/* ── what it must refuse ───────────────────────────────────────────────────────────────── */
ok('the trip page is never served as markdown', md_serve("$root/public/app.html") === false);

/* ── the token hint ────────────────────────────────────────────────────────────────────── */
$t = md_token_estimate($md);
ok('the token estimate is in the right neighbourhood', $t > strlen($md) / 8 && $t < strlen($md) / 2, (string)$t);

/* Every content page converts to something, or the negotiation is a promise we keep unevenly. */
$thin = [];
foreach (glob("$root/public/*.html") as $f) {
    if (in_array(basename($f), ['app.html', 'new.html', '404.html'], true)) continue;
    if (strlen(trim(md_from_html(file_get_contents($f)))) < 200) $thin[] = basename($f);
}
ok('every content page converts to real markdown', $thin === [], implode(', ', $thin));

echo "\n" . ($fail ? "\033[31m$fail failed\033[0m, " : '') . "\033[32m$pass\033[0m passed\n";
exit($fail ? 1 : 0);
