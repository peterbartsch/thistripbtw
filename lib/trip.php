<?php
/**
 * lib/trip.php — the trip's AUTH, SEALING and WIRE SHAPE, in one place both servers can reach.
 *
 * WHY THIS FILE EXISTS. These seven functions lived in api.php, which routes as soon as it is
 * included, so nothing else could call them. When `read_kept_trip` needed them (D-172) there were
 * three ways to get them and two were wrong: reimplement `access_level()` and `seal_pin()` inside
 * lib/mcp.php — a SECOND copy of the auth choke point and of the one line that keeps a sealed drop
 * sealed, which is exactly the drift D-081 exists to prevent, in the worst place for it — or have
 * the hosted endpoint call its own API over loopback and risk exhausting its own workers. So they
 * moved here instead, unchanged.
 *
 * THIS WAS A PURE MOVE. No logic, no signature and no order of checks changed. The three-way order
 * inside `access_level()` is load-bearing and CLAUDE.md documents why: a Bearer phrase, then a
 * member phrase, then — only when NO phrase was presented — an account session, so that a wrong
 * account password can never feed the phrase guess-limiter and lock out link holders. Read that
 * section before changing anything here.
 *
 * WHAT STAYED IN api.php: `haversine_mi()`, `clamp_radius()` and the radius constants. Those are
 * used when a drop is OPENED, not when one is read out, and `seal_pin()` never touches them.
 */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }

function now_ms() { return (int) round(microtime(true) * 1000); }

function auth_header() {
  if (!empty($_SERVER['HTTP_AUTHORIZATION']))          return $_SERVER['HTTP_AUTHORIZATION'];
  if (!empty($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) return $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
  if (function_exists('getallheaders')) {
    foreach (getallheaders() as $k => $v) if (strcasecmp($k, 'Authorization') === 0) return $v;
  }
  return '';
}

/* ── auth: Bearer phrase → "edit" | "view" | null (guess-rate-limited) ── */
/* Is this request same-origin? Only consulted for COOKIE-authenticated writes (D-071).
   A Bearer phrase cannot be attached by another site, so phrase auth needs no CSRF defence and
   has never had one. A session cookie rides along automatically, so the moment an account can
   change a trip, a form on any other page could too. Sec-Fetch-Site is the modern answer and
   Origin the fallback; both are absent only on non-browser clients, which use a phrase. Fails
   CLOSED — an unrecognised request shape is refused rather than trusted. */
function same_origin_write() {
  $sfs = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
  if ($sfs !== '') return $sfs === 'same-origin' || $sfs === 'none';
  $o = $_SERVER['HTTP_ORIGIN'] ?? '';
  if ($o === '') return false;
  $host = strtolower((string)parse_url($o, PHP_URL_HOST));
  $apex = strtolower(APEX);
  return $host === $apex || str_ends_with($host, '.' . $apex);
}

/* D-071: an account opens the trips it owns or was invited to. Reached ONLY when no phrase was
   presented, so the phrase paths below are untouched and a wrong password can never feed the
   phrase guess-limiter (which would let a stranger lock out link holders).

   It deliberately returns no `member` key. `seal_pin()` withholds a sealed drop unless `$who`
   matches, and `$who` comes from that key — so signing in as the owner grants the TRIP, never a
   PERSON. Drops left for someone else stay shut, and D-047 stands unchanged. */
function acct_trip_access($sub, $trip) {
  /* __DIR__ IS lib/ NOW. This line read `__DIR__ . '/lib/accounts.php'` in api.php, where that
     resolved to the repo root; moving the function without changing it would have looked for
     lib/lib/accounts.php and fatalled on the first account-session read. */
  require_once __DIR__ . '/accounts.php';
  $a = acct_current();
  if (!$a) return ['level' => null];
  $row = q_first('SELECT role FROM account_trips WHERE account_id=? AND slug=?', [(string)$a['id'], $sub]);
  if (!$row) return ['level' => null];
  if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET' && !same_origin_write())
    return ['level' => null, 'csrf' => true];
  return ['level' => 'edit', 'trip' => $trip,
          'account_id' => (string)$a['id'],
          'owner' => ((string)$row['role'] === 'owner')];
}

/* $presented lets a caller supply the phrase INSTEAD of the Authorization header, and exists for
   exactly one caller: the MCP endpoint (D-172), where the phrase arrives as a JSON-RPC argument
   because it came out of a `#k=` fragment rather than off the wire. Default null = read the header,
   so every one of the existing call sites behaves identically and no check moves.
   It is a value, not a bypass: whatever is passed goes through the same hash comparison, the same
   member lookup and the same guess-limiter as a header would. The one thing it must never be is
   the empty string from a caller who meant "no phrase" — '' falls through to the account-session
   branch, which is why mcp_read_kept() refuses a link with no phrase before it ever gets here. */
function access_level($sub, ?string $presented = null) {
  if ($presented === null) {
    $h = auth_header();
    $token = (stripos($h, 'Bearer ') === 0) ? strtolower(trim(substr($h, 7))) : '';
  } else {
    $token = strtolower(trim($presented));
  }
  $trip = q_first('SELECT * FROM trips WHERE slug=?', [$sub]);
  if (!$trip) return ['level' => null];

  /* A "plan it" trip promises to delete itself after a year, and five pages say so. Until
     now the only thing that could make that true was a nightly cron — which was not
     installed, so an expired trip stayed fully readable. A promise that depends on one
     crontab line is not a promise. The check lives here, at the single choke point every
     authenticated read passes through, so the trip is gone to everyone the moment it
     expires whether or not the sweep ever runs. The sweep still does the actual reaping. */
  if ($trip['expires'] !== null && (int)$trip['expires'] < now_ms())
    return ['level' => null, 'expired' => true];

  /* No phrase presented — try the account session. Placed AFTER the expiry check so an expired
     trip is gone to its owner too, and before any guess-limiter accounting. */
  if ($token === '') return acct_trip_access($sub, $trip);

  // A correct token ALWAYS passes — never locked out by the guess limiter (the slug
  // is public, so a global lockout would let anyone deny access). hash_equals = constant time.
  $hash = hash('sha256', $token);
  if (hash_equals((string)$trip['edit_hash'], $hash)) return ['level' => 'edit', 'trip' => $trip, 'owner' => true];
  if (hash_equals((string)$trip['view_hash'], $hash)) return ['level' => 'view', 'trip' => $trip];

  // per-person member phrase (D-023): grants EDIT + an identity (handle). Indexed lookup
  // by hash — also a correct token, so it must pass BEFORE the guess limiter (same reason
  // as edit/view: the slug is public, a global lockout can't be allowed to lock members out).
  $mem = q_first('SELECT id,handle FROM members WHERE slug=? AND phrase_hash=? AND deleted=0', [$sub, $hash]);
  if ($mem) return ['level' => 'edit', 'trip' => $trip, 'member' => (string)$mem['handle'], 'member_id' => (string)$mem['id']];

  // wrong token: rate-limit the guessing at 30 fails/trip/hour, then record the miss
  $win = intdiv(now_ms(), 3600000);
  $g = q_first('SELECT hits FROM gate WHERE slug=? AND win=?', [$sub, $win]);
  if ($g && (int)$g['hits'] >= 30) return ['level' => null, 'limited' => true];
  q('INSERT INTO gate (slug,win,hits) VALUES (?,?,1) ON DUPLICATE KEY UPDATE hits=hits+1', [$sub, $win]);
  return ['level' => null];
}

function seal_pin($p, $who) {
  /* Two kinds of withheld pin now (D-050):
       · a sealed DROP  — private by nature, left for particular people
       · a near-only POST — public to the trip, but only once you have stood where it happened
     The identity rule is the same for both (D-047): it comes from the token, never a name the
     caller typed, and no identity means it stays shut. */
  $locked = ($p['kind'] ?? '') === 'sealed' || !empty($p['near_only']);
  if (!$locked) return $p;
  if ($who !== '' && $who === ($p['author'] ?? '')) return $p;          // your own drop
  $opened = json_decode($p['opened_by'] ?? '[]', true);
  if (is_array($opened) && $who !== '' && in_array($who, $opened, true)) return $p;
  $p['title'] = ''; $p['notes'] = ''; $p['lodging'] = '';
  $p['photo'] = ''; $p['spotify'] = '';
  /* S1: the CONTENT was blanked and the GUEST LIST was not. `opened_by` is the handles of
     everyone who has already opened this drop, and it went over the wire to people who have
     not — so you could see who else had read theirs, and who had not yet. A small social leak
     in a feature whose whole point is that nobody knows anything until they open it.
     `author` deliberately stays: "a drop from Dad" is the intended shape, and knowing who left
     a drop is not knowing what it says. */
  $p['opened_by'] = '[]';
  return $p;
}

/* ── row → wire shape: match worker.js JSON exactly (types, opened_by stays a string) ── */
function normalize_pin($r) {
  return [
    'id'           => (string)$r['id'],
    'slug'         => (string)$r['slug'],
    'kind'         => (string)$r['kind'],
    'track'        => $r['track'] !== null ? (string)$r['track'] : null,
    'date'         => $r['date']  !== null ? (string)$r['date']  : null,
    'ts'           => $r['ts']    !== null ? (int)$r['ts']       : null,
    'lat'          => (float)$r['lat'],
    'lng'          => (float)$r['lng'],
    'title'        => (string)$r['title'],
    'lodging'      => (string)$r['lodging'],
    'notes'        => $r['notes'] !== null ? (string)$r['notes'] : '',
    'photo'        => (string)$r['photo'],
    'spotify'      => (string)$r['spotify'],
    'path'         => (isset($r['path']) && $r['path'] !== null && $r['path'] !== '') ? json_decode($r['path'], true) : null,
    'fly'          => (int)$r['fly'],
    'mode'         => (string)$r['mode'],
    'craft'        => (string)($r['craft'] ?? ''),
    'near_only'    => (int)($r['near_only'] ?? 0),
    'radius_mi'    => ($r['radius_mi'] ?? null) !== null ? (float)$r['radius_mi'] : null,
    'here'         => (int)$r['here'],
    'seq'          => (int)$r['seq'],
    'opened_by'    => $r['opened_by'] !== null ? (string)$r['opened_by'] : '[]',
    'claimed_team' => (string)$r['claimed_team'],
    'claimed_by'   => (string)$r['claimed_by'],
    'author'       => (string)$r['author'],
    'updated'      => (int)$r['updated'],
    'deleted'      => (int)$r['deleted'],
  ];
}

/* ── the one pin INSERT, and the helpers it needs ────────────────────────────────────────────
   Moved here from api.php on 2026-09-10 as a PURE MOVE — same columns, same clamps, same
   defaults — so that the hosted MCP's add_to_kept_trip writes a stop through the identical
   statement the browser uses rather than a second copy of it. Two insert statements for one
   table is how a clamp lands in one and not the other. The six helpers came with it because
   they are what the statement calls; api.php still calls them freely — a PHP function is
   global wherever it was declared. */
function rand_str($len, $alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789') {
  $n = strlen($alphabet); $s = '';
  for ($i = 0; $i < $len; $i++) $s .= $alphabet[random_int(0, $n - 1)];
  return $s;
}
function jor($v, $default) {
  if ($v === null || $v === false || $v === '' || $v === 0 || $v === 0.0) return $default;
  return $v;
}
function is_number($v) { return is_int($v) || is_float($v); }
function norm_mode($m, $flyFallback = false) {   // valid transit mode, else drive (or fly for legacy)
  static $M = ['drive','fly','train','ferry','water','bike','walk','bus'];
  if (in_array($m, $M, true)) return $m;
  return $flyFallback ? 'fly' : 'drive';
}
function clamp_radius($v) {
  if ($v === null || $v === '' || !is_numeric($v)) return null;
  return max(RADIUS_MIN_MI, min(RADIUS_MAX_MI, (float)$v));
}
function encode_path($v) {
  if (!is_array($v) || count($v) < 1) return null;
  $out = [];
  foreach (array_slice($v, 0, 500) as $pt) {
    if (is_array($pt) && isset($pt[0], $pt[1]) && is_numeric($pt[0]) && is_numeric($pt[1])) {
      $out[] = [(float)$pt[0], (float)$pt[1]];
    }
  }
  return count($out) >= 1 ? json_encode($out) : null;   // intermediate waypoints; leg render adds the stop endpoints
}

/** Insert one pin. $p is the client's JSON body; the caller has already validated lat/lng. */
function insert_pin(string $sub, array $p, int $t): string {
    $id = 'p' . rand_str(12);
    $pmode = norm_mode($p['mode'] ?? '', !empty($p['fly']));
    q('INSERT INTO pins (id,slug,kind,track,date,ts,lat,lng,title,lodging,notes,photo,spotify,path,fly,mode,craft,here,near_only,radius_mi,seq,opened_by,claimed_team,claimed_by,author,updated)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [$id, $sub, jor($p['kind'] ?? null, 'post'), jor($p['track'] ?? null, null),
       jor($p['date'] ?? null, null), jor($p['ts'] ?? null, null),
       $p['lat'], $p['lng'], mb_substr((string)jor($p['title'] ?? null, ''), 0, 300, 'UTF-8'),
       mb_substr((string)jor($p['lodging'] ?? null, ''), 0, 300, 'UTF-8'),
       mb_substr((string)jor($p['notes'] ?? null, ''), 0, 4000, 'UTF-8'),
       jor($p['photo'] ?? null, ''), jor($p['spotify'] ?? null, ''), encode_path($p['path'] ?? null),
       ($pmode === 'fly') ? 1 : 0, $pmode,
       mb_substr((string)jor($p['craft'] ?? null, ''), 0, 24, 'UTF-8'),
       !empty($p['here']) ? 1 : 0, !empty($p['near_only']) ? 1 : 0, clamp_radius($p['radius_mi'] ?? null),
       (int)($p['seq'] ?? $t),
       json_encode($p['opened_by'] ?? []),
       mb_substr((string)jor($p['claimed_team'] ?? null, ''), 0, 16, 'UTF-8'),
       mb_substr((string)jor($p['claimed_by'] ?? null, ''), 0, 40, 'UTF-8'),
       mb_substr((string)jor($p['author'] ?? null, ''), 0, 40, 'UTF-8'), $t]);
    return $id;
}
