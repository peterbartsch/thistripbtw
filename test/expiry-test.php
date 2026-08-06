<?php
/* D-098: the expiry notice, against a real database, with a fake sender.
 *
 * The one behaviour worth defending is ONCE. §6c drew the line — "one email is honest, two is a
 * campaign" — and the sweep runs daily against a fourteen-day window, so the naive version mails
 * the same person fourteen times. That is not a rare race; it is the DEFAULT if the claim is not
 * conditional. So the test runs the sweep repeatedly and counts messages, rather than reading the
 * SQL and agreeing with it.
 *
 * No SMTP is stood up. expiry_notify() takes the sender as an argument for exactly this reason,
 * and everything asserted here is a count or a row — CLAUDE.md's rule that a calculation you can
 * check beats an interaction you have to stage.
 *
 * Run: php test/expiry-test.php   (needs the local MySQL that `make test` uses)
 */
define('SECURE_ACCESS', true);
$root = dirname(__DIR__);
require "$root/lib/config.php";
require "$root/lib/db.php";
require "$root/lib/expiry.php";

$pass = 0; $fail = 0;
function ok(string $w, bool $c) { global $pass, $fail;
  if ($c) { $pass++; echo "  ✓ $w\n"; } else { $fail++; echo "  ✗ $w\n"; } }

$now  = 1785000000000;                    // fixed, so "in N days" is arithmetic and not a clock
$DAY  = 86400000;
$sfx  = substr(bin2hex(random_bytes(4)), 0, 7);

/* Three trips and two accounts. `owner` gets a notice, `member` must not, and the trip with no
   account at all must not — a purchase without an email is allowed and asserted in smoke.sh. */
$mk = function (string $slug, ?int $expires) use ($now, $sfx) {
  q('INSERT INTO trips (slug,name,tier,edit_hash,view_hash,labels_json,stripe_session,created,expires,updated)
     VALUES (?,?,?,?,?,?,?,?,?,?)',
    [$slug, 'trip ' . $slug, 'plan', str_repeat('a', 64), str_repeat('b', 64), '{}',
     'cs_exp_' . $slug . '_' . $sfx, $now, $expires, $now]);
};
$acct = function (string $id, string $email) use ($now) {
  q('INSERT INTO accounts (id,email,pass_hash,verified,created) VALUES (?,?,NULL,1,?)', [$id, $email, $now]);
};
$link = function (string $id, string $slug, string $role) use ($now) {
  q('INSERT INTO account_trips (account_id,slug,role,added) VALUES (?,?,?,?)', [$id, $slug, $role, $now]);
};

$S_SOON = 'ex1' . substr($sfx, 0, 4);      // lapses in 10 days -> inside the window
$S_FAR  = 'ex2' . substr($sfx, 0, 4);      // lapses in 90 days -> outside it
$S_MEM  = 'ex3' . substr($sfx, 0, 4);      // inside the window, but only a MEMBER is attached
$S_NONE = 'ex4' . substr($sfx, 0, 4);      // inside the window, no account at all
$A_OWN  = 'ao' . $sfx; $A_MEM = 'am' . $sfx;

foreach ([[$S_SOON, 10], [$S_FAR, 90], [$S_MEM, 10], [$S_NONE, 10]] as [$s, $d]) $mk($s, $now + $d * $DAY);
$acct($A_OWN, "own$sfx@example.test");
$acct($A_MEM, "mem$sfx@example.test");
$link($A_OWN, $S_SOON, 'owner');
$link($A_OWN, $S_FAR,  'owner');
$link($A_MEM, $S_MEM,  'member');

$cleanup = function () use ($S_SOON, $S_FAR, $S_MEM, $S_NONE, $A_OWN, $A_MEM) {
  foreach ([$S_SOON, $S_FAR, $S_MEM, $S_NONE] as $s) q('DELETE FROM trips WHERE slug=?', [$s]);
  foreach ([$A_OWN, $A_MEM] as $a) { q('DELETE FROM account_trips WHERE account_id=?', [$a]);
                                     q('DELETE FROM accounts WHERE id=?', [$a]); }
};

try {
  /* ── selection ─────────────────────────────────────────────────────────────────────── */
  $due  = array_column(expiry_due($now), 'slug');
  ok('a trip lapsing inside the window is due',        in_array($S_SOON, $due, true));
  ok('a trip lapsing outside it is not',               !in_array($S_FAR,  $due, true));
  ok('a member is not mailed — only the buyer is',     !in_array($S_MEM,  $due, true));
  ok('a trip claimed without an email is skipped',     !in_array($S_NONE, $due, true));

  /* An already-lapsed trip must not be mailed: the same run deletes it, and "ends in -3 days"
     is worse than silence. */
  q('UPDATE trips SET expires=? WHERE slug=?', [$now - 3 * $DAY, $S_FAR]);
  ok('an already-lapsed trip is not mailed', !in_array($S_FAR, array_column(expiry_due($now), 'slug'), true));
  q('UPDATE trips SET expires=? WHERE slug=?', [$now + 90 * $DAY, $S_FAR]);

  /* ── once, and only once ───────────────────────────────────────────────────────────── */
  $sent = [];
  $spy  = function ($to, $subj, $text) use (&$sent) { $sent[] = [$to, $subj, $text]; return true; };

  [$n1] = expiry_notify($now, $spy);
  ok('the first run sends exactly one', $n1 === 1 && count($sent) === 1);
  ok('and it goes to the buyer', ($sent[0][0] ?? '') === "own$sfx@example.test");

  /* Fourteen more days of cron. This is the assertion the whole file exists for. */
  for ($i = 1; $i <= 14; $i++) expiry_notify($now + $i * $DAY, $spy);
  ok('fourteen more daily runs send nothing more (§6c: one is honest, two is a campaign)',
     count($sent) === 1);

  $mark = q_first('SELECT expiry_notified FROM trips WHERE slug=?', [$S_SOON]);
  ok('the send is recorded as a timestamp, not a flag', (int)$mark['expiry_notified'] === $now);

  /* ── a failed send must not burn the only notice ───────────────────────────────────── */
  q('UPDATE trips SET expiry_notified=NULL WHERE slug=?', [$S_SOON]);
  [$s2, , $f2] = expiry_notify($now, function () { return false; });
  ok('a relay failure reports the failure', $s2 === 0 && $f2 === 1);
  $after = q_first('SELECT expiry_notified FROM trips WHERE slug=?', [$S_SOON]);
  ok('and releases the claim so tomorrow retries', $after['expiry_notified'] === null);

  $sent = [];
  [$s3] = expiry_notify($now + $DAY, $spy);
  ok('tomorrow does retry, and sends', $s3 === 1 && count($sent) === 1);

  /* ── D-109: the notice carries the trip ─────────────────────────────────────────── */
  require_once "$root/lib/export.php";
  $trip = q_first('SELECT * FROM trips WHERE slug=?', [$S_SOON]);
  $z = export_build($S_SOON, $trip, '', false);
  ok('a photo-less export builds at all', $z !== null && is_file($z));
  if ($z) {
    $zip = new ZipArchive(); $zip->open($z);
    $names = [];
    for ($i = 0; $i < $zip->numFiles; $i++) $names[] = $zip->getNameIndex($i);
    $zip->close();
    ok('it still carries the data and the readable page',
       in_array('trip.json', $names, true) && in_array('itinerary.html', $names, true));
    ok('and NO photos — that is the whole point of the switch',
       !array_filter($names, fn($n) => str_starts_with($n, 'photos/')));
    ok('it is small enough to email', filesize($z) < EXPIRY_ATTACH_MAX);
    @unlink($z);
  }

  /* The message must describe what actually happened. Telling someone a copy is attached when
     it is not is the kind of confidently-wrong this product keeps finding in itself. */
  $withZip = expiry_message(['slug'=>$S_SOON,'name'=>'x','expires'=>$now + 10*$DAY], $now, true);
  $noZip   = expiry_message(['slug'=>$S_SOON,'name'=>'x','expires'=>$now + 10*$DAY], $now, false);
  ok('with an attachment the mail says it is attached',
     str_contains($withZip['text'], 'attached to this email'));
  ok('and says the photos are not in it',
     str_contains($withZip['text'], 'photos are not in it'));
  ok('without one it tells them where to download instead',
     str_contains($noZip['text'], 'Download a copy') && !str_contains($noZip['text'], 'attached'));

  /* The zip is a courtesy; the notice is the promise. A build failure must not lose the mail. */
  $sent2 = [];
  q('UPDATE trips SET expiry_notified=NULL WHERE slug=?', [$S_SOON]);
  [$s4] = expiry_notify($now, function ($to, $su, $tx, $at = null) use (&$sent2) {
    $sent2[] = ['attached' => $at !== null]; return true; });
  ok('the notice still goes, and carries the zip', $s4 === 1 && ($sent2[0]['attached'] ?? false) === true);

  /* ── the message ───────────────────────────────────────────────────────────────────── */
  $m = expiry_message(['slug' => $S_SOON, 'name' => 'moving Scott', 'expires' => $now + 10 * $DAY], $now);
  ok('the subject names the date',            str_contains($m['subject'], gmdate('j F Y', (int)(($now + 10 * $DAY) / 1000))));
  ok('the subject names the trip address',    str_contains($m['subject'], APEX . '/' . $S_SOON));
  ok('the body counts the days correctly',    str_contains($m['text'], 'in 10 days'));
  ok('the body names the trip',               str_contains($m['text'], 'moving Scott'));
  ok('it points at the download, which is the only thing they can do',
     str_contains($m['text'], 'Download a copy'));
  ok('it says this is the only email — the §6c promise, made to the customer',
     str_contains($m['text'], 'only email you will get'));
  ok('it does not promise a renewal that does not exist',
     !preg_match('/\brenew (it|your|now)\b|extend your trip/i', $m['text']));
  ok('no phrase or token is ever in the body',
     !preg_match('/Bearer|edit_token|view_token|phrase[:=]/i', $m['text']));

  /* A trip with no name must not produce a dangling quote. */
  $mu = expiry_message(['slug' => $S_SOON, 'name' => '', 'expires' => $now + 3 * $DAY], $now);
  ok('an unnamed trip reads cleanly', str_starts_with($mu['text'], 'Your trip ends on ')
                                      && !str_contains($mu['text'], '""'));

  /* ── D-114: the invariant, checked against every row that is actually here ──────────── */
  /* This is the assertion the qa column exists FOR. A customer trip created down a path that
     leaves `expires` NULL is silently permanent: expiry_due() skips NULL, expire-trips.php
     skips NULL, so no notice is ever sent and it is never deleted — while check-copy gates the
     build on never claiming a trip lasts forever. Nothing caught that before this line.
     Stated positively so the failure names the offender rather than just a count. */
  $orphans = q_all('SELECT slug, name, tier FROM trips WHERE expires IS NULL AND qa = 0');
  ok('every trip has an end date unless it is marked in-house QA',
     count($orphans) === 0);
  foreach ($orphans as $o)
    echo "      no expiry and not qa: {$o['slug']} ({$o['tier']}) {$o['name']}\n";

  /* And the flag must not have become a way to sell a trip that never ends: qa is set by hand
     on our own rows, never by the purchase path. A paid tier carrying it would mean a customer
     bought something the pricing page does not offer. */
  $sold = q_all("SELECT slug FROM trips WHERE qa = 1 AND stripe_session NOT LIKE 'cs_exp_%'
                   AND stripe_session LIKE 'cs_live_%'");
  ok('no live purchase is marked QA', count($sold) === 0);

} finally {
  $cleanup();
}

echo "\n" . ($fail ? "$fail failed, " : '') . "$pass passed\n";
exit($fail ? 1 : 0);
