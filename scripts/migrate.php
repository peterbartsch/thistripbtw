<?php
/* this trip, btw — apply ONE migration file, using the DB creds in .env so no password
   ever appears in a shell command or a transcript.

   Usage:  php scripts/migrate.php scripts/migrations/2026-07-29-passwordless-accounts.sql

   Migrations here must be safe to re-run: this prints what it does but keeps no ledger,
   deliberately, because a ledger table is one more thing to migrate. Write the SQL so that
   running it twice is harmless. */
if (PHP_SAPI !== 'cli') { http_response_code(403); exit("cli only\n"); }
define('SECURE_ACCESS', true);
require __DIR__ . '/../lib/db.php';

$file = $argv[1] ?? '';
if ($file === '' || !is_file($file)) { fwrite(STDERR, "usage: php scripts/migrate.php <file.sql>\n"); exit(1); }

try { db()->query('SELECT 1'); echo "✓ DB connection OK\n"; }
catch (\Throwable $e) { fwrite(STDERR, "✗ DB connection FAILED: " . $e->getMessage() . "\n"); exit(1); }

$sql = preg_replace('/^\s*--.*$/m', '', file_get_contents($file));
foreach (array_filter(array_map('trim', explode(';', $sql))) as $s) {
    if ($s === '') continue;
    try { db()->exec($s); echo "  applied: " . substr(preg_replace('/\s+/', ' ', $s), 0, 70) . "\n"; }
    catch (\Throwable $e) { fwrite(STDERR, "  ✗ " . $e->getMessage() . "\n"); exit(1); }
}
echo "✓ migration complete: " . basename($file) . "\n";
