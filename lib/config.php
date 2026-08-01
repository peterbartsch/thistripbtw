<?php
/* this trip, btw — config loader. thios.co-style SECURE_ACCESS guard.
   Reads .env (KEY=VALUE) from the app root. .env is NEVER committed.
   Required keys: DB_HOST, DB_NAME, DB_USER, DB_PASS, STRIPE_SECRET.
   Optional: DB_PORT (3306), APEX (thistripbtw.us). */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }

function load_env($path) {
  static $loaded = null;
  if ($loaded !== null) return $loaded;
  $loaded = [];
  if (is_readable($path)) {
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
      $line = trim($line);
      if ($line === '' || $line[0] === '#') continue;
      $eq = strpos($line, '=');
      if ($eq === false) continue;
      $k = trim(substr($line, 0, $eq));
      $v = trim(substr($line, $eq + 1));
      if (strlen($v) >= 2 && ($v[0] === '"' || $v[0] === "'") && substr($v, -1) === $v[0])
        $v = substr($v, 1, -1);
      $loaded[$k] = $v;
    }
  }
  return $loaded;
}

$GLOBALS['ENV'] = load_env(dirname(__DIR__) . '/.env');

function env($k, $default = null) {
  if (isset($GLOBALS['ENV'][$k]) && $GLOBALS['ENV'][$k] !== '') return $GLOBALS['ENV'][$k];
  $g = getenv($k);
  return ($g !== false && $g !== '') ? $g : $default;
}

/* apex host — everything below it (except reserved) is a trip subdomain */
define('APEX', env('APEX', 'thistripbtw.us'));

/* paths (repo root == VPS docroot after deploy) */
define('APP_ROOT',   dirname(__DIR__));
define('PUBLIC_DIR', APP_ROOT . '/public');   // landing.html source == public/index.html
define('PHOTOS_DIR', APP_ROOT . '/photos');   // media store, slug-prefixed subdirs

/* First path segments that are NOT trips (reserved words + content pages).
   NOTE: this is a ROUTING list, not collision protection — slugs are 7 chars from
   SLUG_ALPHABET (no o/i/l/0/1), so none of these words can ever be generated.
   index.php serves the landing for anything listed here; unlisted paths fall through
   to a trip lookup and 404. Account routes (D-031/D-032) are reserved ahead of the
   build so they can't 404; they get real handlers in phase B/E of
   _agents/HANDOFF_ACCOUNTS_BUILD.md. */
define('RESERVED', ['www', 'api', 'app', 'mail', 'admin', 'status', 'privacy', 'about', 'mission', 'help', 'terms', 'faq',
                    'login', 'signin', 'signup', 'account', 'trips', 'unsubscribe', 'verify']);
