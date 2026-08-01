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

echo "\n" . ($fail ? "\033[31m$fail failed\033[0m, " : '') . "\033[32m$pass\033[0m passed\n";
exit($fail ? 1 : 0);
