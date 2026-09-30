<?php
/* this trip, btw — PDO MySQL helper. One shared connection per request.
   No ORM, no Composer — PDO + vanilla PHP (MVP_STACK_PHP.md). */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }
require_once __DIR__ . '/config.php';

function db() {
  static $pdo = null;
  if ($pdo) return $pdo;
  $host = env('DB_HOST', '127.0.0.1');
  $name = env('DB_NAME', 'ttb_main');
  $user = env('DB_USER', 'root');
  $pass = env('DB_PASS', '');
  $port = env('DB_PORT', '3306');
  $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
  $pdo = new PDO($dsn, $user, $pass, [
    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES   => false,
  ]);
  return $pdo;
}

/* thin query helpers mirroring the worker's prepare().bind().first()/all() shape */
function q($sql, $params = []) {          // run + return statement
  $st = db()->prepare($sql);
  $st->execute($params);
  return $st;
}
function q_first($sql, $params = []) {    // first row or null
  $row = q($sql, $params)->fetch();
  return $row === false ? null : $row;
}
function q_all($sql, $params = []) {      // all rows
  return q($sql, $params)->fetchAll();
}
