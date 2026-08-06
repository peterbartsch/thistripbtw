<?php
/* this trip, btw — daily expiry sweep (mirror of worker.js `scheduled`).
   Expired "plan" trips vanish — data we don't keep can't leak.

   Two passes since D-098, and notify comes first: the notice looks fourteen days AHEAD, the
   sweep looks behind, so they never contend for the same row — but running the sweep first
   would mean a trip that lapsed overnight is gone before anything can say so.

   Wire up in the DreamHost panel → Goodies → Cron Jobs, daily:
     /usr/bin/php /home/<user>/thistripbtw.us/scripts/expire-trips.php
   Pass --dry-run to see who WOULD be mailed and swept, sending and marking nothing. */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit("cli only\n"); }

define('SECURE_ACCESS', true);
require __DIR__ . '/../api.php';   // pulls in config/db/words; defines now_ms(), delete_trip()
require __DIR__ . '/../lib/expiry.php';

$t   = now_ms();
$dry = in_array('--dry-run', $argv ?? [], true);

/* 1. The one notice (D-098): fourteen days out, to the buyer, once ever. */
if ($dry) {
  foreach (expiry_due($t) as $r) {
    $m = expiry_message($r, $t);
    echo "would mail {$r['slug']}: {$m['subject']}\n";
  }
} else {
  /* A mail problem must never stop the sweep below. Deleting on time is a promise on the privacy
     page and in the tier copy; the notice is a courtesy. */
  try {
    [$sent, $skipped, $failed] = expiry_notify($t);
    echo "notices: {$sent} sent, {$skipped} already claimed, {$failed} failed\n";
    if ($failed) fwrite(STDERR, "{$failed} expiry notice(s) failed; they retry tomorrow\n");
  } catch (\Throwable $e) {
    fwrite(STDERR, "notice pass FAILED: {$e->getMessage()}\n");
  }
}

/* 2. The sweep itself. */
$rows = q_all('SELECT slug FROM trips WHERE expires IS NOT NULL AND expires < ?', [$t]);
$n = 0;
foreach ($rows as $r) {
  if ($dry) { echo "would expire {$r['slug']}\n"; $n++; continue; }
  try { delete_trip($r['slug']); $n++; echo "expired {$r['slug']}\n"; }
  catch (\Throwable $e) { fwrite(STDERR, "FAILED {$r['slug']}: {$e->getMessage()}\n"); }
}
echo "done: {$n} trip(s) swept at {$t}" . ($dry ? " (dry run — nothing changed)" : "") . "\n";
