<?php
/* The payment links live in TWO files. Make them agree, or fail the build.
 *
 * D-188 gave the expiry notice a renewal link, which meant PHP needed the three checkout URLs that
 * had only ever existed in `public/new.html` as `const PAY`. Copying them into `api.php` as
 * `PAY_LINKS` created the exact shape this repo has been bitten by twice: one value, two files,
 * nothing holding them together. `make check-mcp-version` exists because a version number lived in
 * four files unguarded and sat wrong through a whole release; `make check-stripe` exists because
 * the live flip updated one file and missed the other, and every buyer hit a test checkout for a
 * day. A renewal link pointing at a retired price would fail the same way and be invisible: the
 * customer pays, the webhook sees an amount no tier matches, and the extension silently does not
 * happen.
 *
 * It reads both files as TEXT rather than executing them — api.php runs a router on include, and
 * new.html is not PHP at all.
 *
 * Run: php test/stripe-links.php   (no database, no network)
 */
$root = dirname(__DIR__);
$pass = 0; $fail = 0;
function ok(string $w, bool $c, string $d = '') { global $pass, $fail;
  if ($c) { $pass++; echo "  ✓ $w\n"; } else { $fail++; echo "  ✗ $w" . ($d !== '' ? " — $d" : '') . "\n"; } }

/** tier => url, out of a `key : "https://buy.stripe.com/…"` or `'key' => 'https://…'` block. */
function links(string $text): array {
    preg_match_all('~[\'"]?(plan|keep|works)[\'"]?\s*(?:=>|:)\s*[\'"](https://buy\.stripe\.com/[A-Za-z0-9_]+)[\'"]~',
                   $text, $m, PREG_SET_ORDER);
    $out = [];
    foreach ($m as $x) $out[$x[1]] = $x[2];
    ksort($out);
    return $out;
}

$html = links(file_get_contents("$root/public/new.html"));
$php  = links(file_get_contents("$root/api.php"));

ok('public/new.html declares a link for all three tiers', count($html) === 3, implode(',', array_keys($html)));
ok('api.php PAY_LINKS declares a link for all three tiers', count($php) === 3, implode(',', array_keys($php)));
ok('the two agree, tier for tier', $html === $php,
   'new.html=' . json_encode($html) . ' api.php=' . json_encode($php));

/* The same rule check-stripe applies to public/: a test-mode link in the renewal path would take
   a real card to a checkout that rejects it. */
foreach ($php as $tier => $url)
    ok("the $tier renewal link is not a test-mode link", !str_contains($url, '/test_'), $url);

/* Every tier in TIERS must have a link, or a renewal for that tier cannot be offered at all and
   the notice silently omits it. */
preg_match_all("~'(plan|keep|works)'\s*=>\s*\['cents'~", file_get_contents("$root/api.php"), $tm);
$tiers = array_unique($tm[1]); sort($tiers);
$have = array_keys($php);
ok('every tier in TIERS has a payment link', $tiers === $have, implode(',', $tiers) . ' vs ' . implode(',', $have));

echo "\n$pass passed, $fail failed\n";
exit($fail ? 1 : 0);
