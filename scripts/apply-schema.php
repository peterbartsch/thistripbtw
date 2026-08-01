<?php
/* this trip, btw — one-time schema loader. Applies schema.mysql.sql using the
   DB creds in .env, so the password never has to appear in a shell command.
   Run once after .env is filled:  php ~/thistripbtw.us/scripts/apply-schema.php */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit("cli only\n"); }
define('SECURE_ACCESS', true);
require __DIR__ . '/../lib/db.php';

try {
  db()->query('SELECT 1');
  echo "✓ DB connection OK\n";
} catch (\Throwable $e) {
  fwrite(STDERR, "✗ DB connection FAILED: " . $e->getMessage() . "\n");
  exit(1);
}

$sql = file_get_contents(__DIR__ . '/../schema.mysql.sql');
$sql = preg_replace('/^\s*--.*$/m', '', $sql);           // strip comment lines
$stmts = array_filter(array_map('trim', explode(';', $sql)));
foreach ($stmts as $s) {
  if ($s === '') continue;
  db()->exec($s);
  echo "  applied: " . substr(preg_replace('/\s+/', ' ', $s), 0, 46) . "…\n";
}
$tables = db()->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
echo "✓ schema applied — tables: " . implode(', ', $tables) . "\n";
