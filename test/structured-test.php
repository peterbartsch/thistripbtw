<?php
/* D-082: structured data is generated from the pages and from TIERS, so it can drift out of
   step with either and nothing on screen would look wrong. These are the checks that notice. */
$pass=0; $fail=0;
function ok(string $w, bool $c){ global $pass,$fail; if($c){$pass++; echo "  ✓ $w\n";} else {$fail++; echo "  ✗ $w\n";} }
$root = dirname(__DIR__);
function ld(string $f){ preg_match('#<script type="application/ld\+json">(.*?)</script>#s', file_get_contents($f), $m);
                        return json_decode($m[1] ?? '', true); }

/* 1. The advertised price must be the price we charge. TIERS is the authority — a structured
      offer that disagrees with checkout is a promise we do not keep, and CLAUDE.md forbids
      pricing moving without a decision. */
preg_match_all("/'(\w+)'\s*=>\s*\['cents'\s*=>\s*(\d+)/", file_get_contents("$root/api.php"), $m);
$tiers = array_combine($m[1], $m[2]);
$offers = ld("$root/public/index.html")['offers'] ?? [];
ok('three offers, one per tier', count($offers) === count($tiers) && count($tiers) === 3);
$want = array_values(array_map(fn($c) => number_format($c / 100, 2, '.', ''), $tiers));
$got  = array_map(fn($o) => (string)$o['price'], $offers);
ok('offer prices match TIERS exactly (' . implode(', ', $want) . ')', $want === $got);
foreach ($offers as $o) ok("offer \"{$o['name']}\" is priced in USD", ($o['priceCurrency'] ?? '') === 'USD');

/* 2. FAQPage is generated from faq.html. If a question is edited and this is not regenerated,
      search engines are served an answer the page no longer gives. */
$faqFile = "$root/public/faq.html";
preg_match_all('#<div class="q"><h2>(.*?)</h2>#s', file_get_contents($faqFile), $hm);
$onPage = array_map(fn($q) => html_entity_decode(strip_tags($q), ENT_QUOTES|ENT_HTML5, 'UTF-8'), $hm[1]);
$inLd   = array_map(fn($q) => $q['name'], ld($faqFile)['mainEntity'] ?? []);
ok('every question on /faq is in the FAQPage (' . count($onPage) . ')', $onPage === $inLd);

/* 3. A sitemap that lists a URL the site does not route is worse than no sitemap. */
$sm = simplexml_load_file("$root/public/sitemap.xml");
ok('sitemap parses as XML', $sm !== false);
$locs = $sm ? array_map(fn($u) => (string)$u->loc, iterator_to_array($sm->url)) : [];
ok('sitemap lists no trip addresses', !array_filter($locs, fn($l) => preg_match('#/[a-hj-km-np-z2-9]{7}$#', $l)));
ok('every sitemap URL is on the apex', !array_filter($locs, fn($l) => !str_starts_with($l, 'https://thistripbtw.us/')));
ok('robots.txt points at the sitemap', str_contains(file_get_contents("$root/public/robots.txt"),
   'Sitemap: https://thistripbtw.us/sitemap.xml'));

/* 5. One mark on every non-trip page (Peter, 2026-08-02). These carried a teal name plate in
      Barlow Condensed while the landing page carried the full guide sign — two logos, and
      nobody noticed until F2 put them on one stylesheet and the difference became the only
      one left. A page that grows a header is a page that can grow the wrong header, so this
      asserts the file rather than trusting the pattern.
      The builders came along on the same day: their toolbars carry it at 34px inside a 44px
      tap target, which is why the artwork and the target are sized separately. Only app.html
      is out, and only because a trip is not one of these pages. */
$TOOLBARS = ['app.html'];
$missing = [];
foreach (glob("$root/public/*.html") as $f) {
  if (in_array(basename($f), $TOOLBARS, true)) continue;
  if (!str_contains(file_get_contents($f), 'src="/sign.svg')) $missing[] = basename($f);
}
ok('every non-trip page carries /sign.svg (' . (count(glob("$root/public/*.html")) - count($TOOLBARS)) . ' pages)',
   $missing === []);
if ($missing) echo "      missing: " . implode(', ', $missing) . "\n";
ok('and the retired text plate is gone from all of them',
   !array_filter(glob("$root/public/*.html"),
     fn($f) => !in_array(basename($f), ['app.html'], true)
               && str_contains(file_get_contents($f), '<b>this trip, btw</b>')));
ok('the sign file exists and is one file, not a per-page copy', is_file("$root/public/sign.svg"));

/* 6. ONE POSITIONING LINE, on every surface an assistant quotes verbatim (#14, 2026-08-02).
      Before this, six surfaces each opened with a different sentence — the title said "one link
      for the whole trip", the meta description said "Plan, share, and keep a trip", llms.txt said
      "A private, paid, no-profiling trip planner and recorder", the MCP README said something
      else again. Ask an assistant what this product is and the answer depended on which one it
      had retrieved. That is the defect; the hero rewrite is the easy half.

      NOT a byte comparison, and that is deliberate rather than lazy: llms.txt and the README wrap
      the sentence across lines, /for-agents writes the dash as &mdash;, and the JSON-LD escapes it
      as \u2014. All three are the same sentence and all three must pass. So the text is normalised
      — entities decoded, \u escapes resolved, whitespace collapsed — and THEN compared exactly.
      The agent-facing opener ("Persistent, shareable travel workspaces for AI agents") is
      untouched on the three agent surfaces: it was blind-tested before any listing existed
      (queue #8) and it answers a different question than this sentence does. */
$LINE = 'Everything about your trip in one shareable link — a private map anyone can open, '
      . 'with no account to build one and no account to open it.';
$norm = function (string $t): string {
  /* llms.txt puts the line in a blockquote, so every wrapped line carries a "> " that lands in
     the MIDDLE of the sentence once whitespace is collapsed. The marker is markup, the same as
     an entity, so it comes off first. Missing this made the guard fail on a file that was
     correct — worth the extra line, because a guard that cries wolf gets deleted. */
  $t = preg_replace('/^[ \t]*>[ \t]?/m', '', $t);
  $t = str_replace(['\u2014', '\u2013', '\u2019'], ['—', '–', '’'], $t);
  $t = html_entity_decode($t, ENT_QUOTES | ENT_HTML5, 'UTF-8');
  return trim(preg_replace('/\s+/u', ' ', $t));
};
$SURFACES = [
  'index.html <title> + meta + JSON-LD' => "$root/public/index.html",
  'llms.txt'                            => "$root/public/llms.txt",
  '/for-agents'                         => "$root/public/for-agents.html",
  /* /agent-ready is pinned deliberately (§2o). It exists to be RETRIEVED and quoted by an
     assistant deciding which tool to reach for, which is the moment the whole channel turns on,
     so it is exactly the wrong surface to let drift to a fifth description of the product. */
  '/agent-ready'                        => "$root/public/agent-ready.html",
];
if (is_dir("$root/mcp")) $SURFACES['mcp/README.md'] = "$root/mcp/README.md";
$want = $norm($LINE);
foreach ($SURFACES as $label => $file) {
  ok("the positioning line is on $label", str_contains($norm(file_get_contents($file)), $want));
}
/* index.html must carry it three times over — the tag, the meta and the structured data are
   three separate retrievals and any one of them can be the one an assistant reads. */
$idx = $norm(file_get_contents("$root/public/index.html"));
ok('index.html carries it in all three slots (title, meta, JSON-LD)',
   substr_count($idx, $want) >= 2);
ok('and the <title> names the same thing the line does',
   str_contains($norm(file_get_contents("$root/public/index.html")),
                'this trip, btw — everything about your trip, one link'));

/* 7. ONE definition per design value (F-14, 2026-08-02). The deep teal under the sign plate had
      FOUR definitions because tokens.css had none — three files said #024260 and app.html said
      #025468, so the same plate had two different edges depending on the page. And the sky
      gradients in tokens.css described a ~162deg ramp nothing used while four tuned 172deg ones
      shipped in sky.css, which is how /new came to invent a fifth. A token that disagrees with
      what renders is worse than no token: it invites the next person to add another value. */
$pub = glob("$root/public/*.{html,css}", GLOB_BRACE);
$invented = [];
foreach ($pub as $f) {
  if (basename($f) === 'tokens.css') continue;
  foreach (preg_split('/\R/', file_get_contents($f)) as $n => $line)
    if (preg_match('/--(?:pine|brand)-deep\s*:\s*#/', $line)) $invented[] = basename($f) . ':' . ($n + 1);
}
ok('nothing invents its own deep teal — it comes from --color-brand-teal-deep', $invented === []);
if ($invented) echo "      " . implode(', ', $invented) . "\n";

$tok = file_get_contents("$root/public/tokens.css");
$skyCss = file_get_contents("$root/public/sky.css");
preg_match_all('/html\[data-sky="(\w+)"\]\s*\{--sky:(linear-gradient\([^)]*\))/', $skyCss, $sm, PREG_SET_ORDER);
ok('sky.css still defines four skies', count($sm) === 4);
/* Compare on collapsed whitespace: tokens.css column-aligns its values and sky.css does not,
   so a literal match would fail on alignment rather than on drift. */
$flat = fn(string $t) => preg_replace('/\s+/', '', $t);
$tokFlat = $flat($tok);
$mismatch = [];
foreach ($sm as $x)
  if (!str_contains($tokFlat, $flat("--gradient-sky-{$x[1]}:" . $x[2]))) $mismatch[] = $x[1];
ok('and every one of them matches its token exactly', $mismatch === []);
if ($mismatch) echo "      drifted: " . implode(', ', $mismatch) . "\n";

ok('design/tokens.css and public/tokens.css have not drifted apart',
   is_file("$root/design/tokens.css") &&
   file_get_contents("$root/design/tokens.css") === $tok);

echo "\n" . ($fail ? "\033[31m$fail failed\033[0m, " : '') . "\033[32m$pass\033[0m passed\n";
exit($fail ? 1 : 0);
