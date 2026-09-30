<?php
/* this trip, btw — operator tool: mint a trip WITHOUT Stripe (comps, the founding
   trip, testing). CLI-only; the paid customer path is still /api/claim.
   Usage:  php ~/thistripbtw.us/scripts/mint-trip.php "Trip name" [plan|keep|works]
   Prints the trip's URL + edit/view links to THIS terminal only. */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit("cli only\n"); }
define('SECURE_ACCESS', true);
require __DIR__ . '/../api.php';   // defines rand_str, phrase, now_ms, q, TIERS, SLUG_ALPHABET, RESERVED, DEFAULT_LABELS, APEX

$name = $argv[1] ?? 'our trip';
$tier = $argv[2] ?? 'works';
if (!isset(TIERS[$tier])) { fwrite(STDERR, "tier must be plan|keep|works\n"); exit(1); }

$slug = null;
for ($i = 0; $i < 6; $i++) {
  $c = rand_str(7, SLUG_ALPHABET);
  if (!q_first('SELECT 1 AS x FROM trips WHERE slug=?', [$c]) && !in_array($c, RESERVED, true)) { $slug = $c; break; }
}
if (!$slug) { fwrite(STDERR, "could not allocate a slug\n"); exit(1); }

$edit = phrase(4); $view = phrase(4); $t = now_ms();
$days = TIERS[$tier]['days'];
$expires = $days ? $t + $days * 86400000 : null;
q('INSERT INTO trips (slug,name,tier,edit_hash,view_hash,labels_json,stripe_session,created,expires,updated)
   VALUES (?,?,?,?,?,?,?,?,?,?)',
  [$slug, mb_substr($name, 0, 60, 'UTF-8'), $tier, hash('sha256', $edit), hash('sha256', $view),
   DEFAULT_LABELS, 'manual-' . $slug, $t, $expires, $t]);

$apex = APEX;
echo "\nMinted a '{$tier}' trip: \"{$name}\"\n";
echo "  Trip:  https://{$apex}/{$slug}\n";
echo "  EDIT:  https://{$apex}/{$slug}/#k={$edit}\n";
echo "  VIEW:  https://{$apex}/{$slug}/#k={$view}\n";
echo "\nSend the EDIT link to the crew, the VIEW link to everyone else.\n";
echo "Rotate either anytime from the trip's Info → Trip settings.\n";
