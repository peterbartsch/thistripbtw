<?php
/* this trip, btw — daily expiry sweep (mirror of worker.js `scheduled`).
   Expired "plan" trips vanish — data we don't keep can't leak.
   Wire up in the DreamHost panel → Goodies → Cron Jobs, daily:
     /usr/bin/php /home/<user>/thistripbtw.us/scripts/expire-trips.php */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit("cli only\n"); }

define('SECURE_ACCESS', true);
require __DIR__ . '/../api.php';   // pulls in config/db/words; defines now_ms(), delete_trip()

$t = now_ms();
$rows = q_all('SELECT slug FROM trips WHERE expires IS NOT NULL AND expires < ?', [$t]);
$n = 0;
foreach ($rows as $r) {
  try { delete_trip($r['slug']); $n++; echo "expired {$r['slug']}\n"; }
  catch (\Throwable $e) { fwrite(STDERR, "FAILED {$r['slug']}: {$e->getMessage()}\n"); }
}
echo "done: {$n} trip(s) swept at {$t}\n";
