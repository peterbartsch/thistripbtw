<?php
/* this trip, btw — JSON API. Behavioral mirror of worker.js `api()`.
   Same paths, same JSON keys, same error strings, same status codes.
   Entered ONLY via index.php (front controller); never web-accessible directly. */
if (!defined('SECURE_ACCESS')) { http_response_code(403); exit('forbidden'); }
require_once __DIR__ . '/lib/config.php';
require_once __DIR__ . '/lib/db.php';
require_once __DIR__ . '/lib/trip.php';   // auth, sealing, wire shape — shared with lib/mcp.php (D-172)
require_once __DIR__ . '/lib/words.php';

/* ── tiers & limits (mirror worker.js) ───────────────────── */
/* Every tier has an end (D-059). "Permanent" sold hosting forever for one payment — cost
   accrues, revenue does not — and it was also a promise no one-person shop can honestly make,
   because it outlives any guarantee the business can give.
   A dollar a year, bought in advance: $5 buys five, $10 buys ten. $2.50 stays at one year,
   so the cheapest tier is the dearest per year, which is how bulk pricing is supposed to read.
   `expires` is stamped per trip AT PURCHASE, so changing these numbers cannot reach back and
   shorten a trip somebody already bought — trips sold as permanent stay permanent. */
/* D-088 split `media` into `photo` and `video`. One boolean gated both, which is why the middle
   tier had nothing to sell: "Keep it" listed only a longer clock at double the price, and the
   top tier carried two capability jumps at once. Now each tier has exactly one thing the tier
   below lacks, and "Keep it" means what its name always said — the trip becomes a record, and
   records have pictures in them.

   Photos moved DOWN a tier, never up, so no existing trip loses anything: `works` keeps both and
   `keep` gains photos. Prices are unchanged, so the Stripe Payment Links are untouched. */
/* The three live payment links, ONCE in PHP, so the expiry notice can offer a renewal (D-188).
   They are the same three strings as PAY in public/new.html, and test/stripe-links.php holds the
   two together in `make check` — one value in two files with no guard is how the live flip missed
   new.html for a day (check-stripe) and how a version number sat wrong through a whole release
   (check-mcp-version). A renewal link pointing at a retired price fails the same way and is
   invisible: the customer pays, the webhook matches no tier, the extension silently does not
   happen. A renewal is the same link with ?client_reference_id=renew_<slug>, which the webhook
   below reads — the first time anything server-side has read that field. */
const PAY_LINKS = [
  'plan'  => 'https://buy.stripe.com/4gM00jazY6Uf3ak28jaIM02',
  'keep'  => 'https://buy.stripe.com/eVqbJ1gYm4M726gcMXaIM00',
  'works' => 'https://buy.stripe.com/00w5kD8rQ0vRbGQ7sDaIM01',
];
const TIERS = [
  'plan'  => ['cents' => 250,  'days' => 365,   'photo' => false, 'video' => false],  // one year
  'keep'  => ['cents' => 500,  'days' => 1826,  'photo' => true,  'video' => false],  // five years (leap-safe)
  'works' => ['cents' => 1000, 'days' => 3653,  'photo' => true,  'video' => true ],  // ten years (leap-safe)
];
/* D-093: turns of the PAID chat one trip may spend. Peter, 2026-08-02 — the number
   CHAT_AGENT_SPEC originally asked for. Generous for a real itinerary, and a hard stop on a
   conversation that has stopped going anywhere. */
const CHAT_TURNS_PER_TRIP = 40;
/* D-094: total media one trip may hold. Peter, 2026-08-02. Per-file caps bounded a single
   upload and nothing bounded the sum, so a one-time $10 bought unlimited storage on a finite
   disk — and unlike the token ceiling, storage does not reset at the end of the month. */
const MEDIA_MAX_PER_TRIP = 2147483648;   // 2 GB
const IMG_MAX = 8388608;          // 8 MB
const VID_MAX = 209715200;        // 200 MB
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';           // no 0/1/i/l/o
// worker relies on the D1 column DEFAULT for labels; MySQL has none, so set it here:
const DEFAULT_LABELS = '{"truck":"Vehicle 1","rental":"Vehicle 2"}';

/* ── helpers ─────────────────────────────────────────────── */

function security_headers() {
  header('X-Content-Type-Options: nosniff');
  header('X-Frame-Options: DENY');                 // anti-clickjacking
  header('Referrer-Policy: no-referrer');           // never leak the /{slug} path to third parties
  header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
  header('Permissions-Policy: geolocation=(self), camera=(), microphone=()');
}
function json_out($data, $status = 200) {
  http_response_code($status);
  header('Content-Type: application/json');
  header('Cache-Control: no-store');   // API responses must never be cached (stale trips)
  security_headers();
  echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  exit;
}
function err_out($msg, $status) { json_out(['error' => $msg], $status); }

function body_json() {
  $raw = file_get_contents('php://input');
  $d = json_decode($raw, true);
  return is_array($d) ? $d : [];
}


/* JS `v || default` semantics ('' / 0 / false / null → default; note '0' is truthy in JS) */





/* ── Stripe: fetch a checkout session (base URL configurable for tests) ── */
function stripe_get_session($id) {
  $base = rtrim(env('STRIPE_API_BASE', 'https://api.stripe.com'), '/');
  $url = $base . '/v1/checkout/sessions/' . rawurlencode($id);
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . env('STRIPE_SECRET', '')],
    CURLOPT_TIMEOUT        => 15,
  ]);
  $resp = curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  // (no curl_close: it's a no-op since PHP 8.0 and deprecated in 8.5 — leaving it
  //  in would let a Deprecated warning leak into the JSON body under display_errors)
  if ($resp === false || $code < 200 || $code >= 300) return null;   // !sres.ok → caller returns 402
  $data = json_decode($resp, true);
  return is_array($data) ? $data : null;
}

/* Withhold sealed-drop content from anyone who hasn't opened it.
 *
 * CLAUDE.md: "Sealed-drop content must never render (or ship over the wire in a
 * distinguishable way) to a viewer who hasn't opened it — surprise is the feature."
 * The client already refuses to RENDER it, but the payload carried the caption to every
 * viewer, so devtools (or any proxy) spoiled the surprise for anyone curious enough.
 *
 * Position still ships — the pin has to appear on the map, that's the whole game. What
 * goes is the content: title/caption, notes, lodging, photo, spotify.
 *
 * $who is the viewer's chosen name, the same self-declared handle the client already uses
 * for opened_by. It is NOT authenticated, and this is deliberately no stronger than the
 * existing trust model: everyone holding the phrase is already inside the trip. What it
 * fixes is bulk pre-shipping — the difference between "spoilable by anyone idly looking"
 * and "spoilable only by someone deliberately impersonating a specific crew member".
 * Absent or unknown $who redacts, so the failure direction is always toward keeping the
 * secret.
 */
/* Two radii, because they are two promises (D-057).
   A sealed DROP is regional — "open this when you get to Tahoe" — and 30 miles is D-010's
   decided number for it.
   A near-only POST means "you had to be here", so it is a place, not a region: at 30 miles you
   could open a Zion post from Cedar City. A quarter mile is about 400m — tight enough to mean
   you stood there, loose enough for the 5–20m a phone is usually off by, the worse error under
   tree cover or between buildings, and a pin dropped from across the car park. */
const SEAL_RADIUS_MI = 30;      // sealed drops (D-010); the client shows the same number
const NEAR_RADIUS_MI = 0.25;    // "was there?" posts (D-057)
/* D-124: the bounds a CUSTOM geofence is clamped to. The floor is not zero because a drop you
   can only open by standing on one exact point never opens — GPS on a phone in a moving car is
   routinely off by a hundred metres. The ceiling is a day's drive: past that the drop is not
   tied to a place any more, and "you had to be there" stops meaning anything. */
const RADIUS_MIN_MI  = 0.05;    // ~80 metres
const RADIUS_MAX_MI  = 500;
/** A custom geofence, or null to mean "use the default for this kind". Clamped rather than
 *  rejected: a trip that arrives beats a tool call that errors over one number, which is the
 *  same rule the mode and subtype fields already follow. */

/** Great-circle miles between two points — used to enforce the sealed-drop radius. */
function haversine_mi(float $aLat, float $aLng, float $bLat, float $bLng): float {
    $r = 3958.7613;
    $dLat = deg2rad($bLat - $aLat); $dLng = deg2rad($bLng - $aLng);
    $h = sin($dLat/2)**2 + cos(deg2rad($aLat)) * cos(deg2rad($bLat)) * sin($dLng/2)**2;
    return 2 * $r * asin(min(1.0, sqrt($h)));
}


/* user-drawn leg geometry → sanitized JSON text (or null). Caps points + coerces floats. */
function normalize_note($r) {
  return [
    'id'      => (string)$r['id'],
    'slug'    => (string)$r['slug'],
    'title'   => (string)$r['title'],
    'body'    => $r['body'] !== null ? (string)$r['body'] : '',
    'ord'     => (int)$r['ord'],
    'updated' => (int)$r['updated'],
    'deleted' => (int)$r['deleted'],
  ];
}

/* ── media file helpers (R2 → local filesystem under photos/) ── */
function delete_media_file($url) {
  $key = preg_replace('#^/photos/#', '', (string)$url);
  if (!preg_match('#^[a-z2-9]+/[A-Za-z0-9]+\.[a-z0-9]+$#', $key)) return;
  $path = PHOTOS_DIR . '/' . $key;
  if (!is_file($path)) return;
  /* D-094: give the space back, or "remove something first" is advice a person cannot act on —
     the trip would stay full forever. Size is read BEFORE the unlink, the slug comes from the
     key's own first segment, and GREATEST(...,0) means a double-delete or a pre-D-094 file
     cannot drive the counter negative. */
  $bytes = (int)@filesize($path);
  $slug  = explode('/', $key)[0];
  @unlink($path);
  if ($bytes > 0) q('UPDATE trips SET media_bytes = GREATEST(media_bytes - ?, 0) WHERE slug=?', [$bytes, $slug]);
}
function rrmdir($dir) {
  if (!is_dir($dir)) return;
  foreach (scandir($dir) as $f) {
    if ($f === '.' || $f === '..') continue;
    $p = $dir . '/' . $f;
    is_dir($p) ? rrmdir($p) : @unlink($p);
  }
  @rmdir($dir);
}
/* ── hard delete: rows + every media object (mirror worker deleteTrip) ──
   Every table keyed by slug goes, not just the three that hold the trip's visible content.
   `members` holds a handle a person typed for themselves and the hash of their phrase, and
   `gate` holds their failed-guess counters — both survived a "delete everything" until
   2026-07-27, which left crew names sitting in the database after the trip was gone. Adding
   a slug-keyed table without adding it here is how that happens again. */
function delete_trip($slug) {
  rrmdir(PHOTOS_DIR . '/' . $slug);
  $pdo = db();
  $pdo->beginTransaction();
  try {
    q('DELETE FROM pins    WHERE slug=?', [$slug]);
    q('DELETE FROM notes   WHERE slug=?', [$slug]);
    q('DELETE FROM members WHERE slug=?', [$slug]);
    q('DELETE FROM gate    WHERE slug=?', [$slug]);
    /* The warning above called this exactly, and it still happened: `account_trips` (D-046) is
       a slug-keyed table added later and never added here. Found by the 2026-07-30 audit, not
       by anything failing — `acct_trips()` selects with JOIN trips, so an orphan is invisible
       in the account UI. What survived a "delete everything" was (account_id, slug, role,
       added), which joined to accounts.email records which address held which trip and when.
       help.html promises the button removes it "for good". */
    q('DELETE FROM account_trips WHERE slug=?', [$slug]);
    q('DELETE FROM trips   WHERE slug=?', [$slug]);
    $pdo->commit();
  } catch (\Throwable $e) { $pdo->rollBack(); throw $e; }
}

/* ── router ──────────────────────────────────────────────── */
function api_main($sub, $path) {
  $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

  /* ── accounts (D-046/D-053) ────────────────────────────────────────────────────────
     Sign-in, sign-out, and "what are my trips". Account CREATION is not here: an account is
     minted inside `claim`, from the email Stripe already collected, after a payment succeeds.
     There is no signup route to hit before buying, and that is D-036, not an oversight. */
  /* POST /api/account/create — the ONLY way an account comes into existence (D-036).
     Proof of purchase is the checkout session id; the email is read back from Stripe here,
     server-side, and never taken from the request body — otherwise anyone could mint an
     account against someone else's address by guessing a session id and naming a victim.
     The person only chooses a password. Offered AFTER the trip links are on screen, so a
     forgotten password never stands between someone and the thing they just paid for. */
  if ($path === 'account/create' && $method === 'POST') {
    require_once __DIR__ . '/lib/accounts.php';
    $b = body_json();
    $sid  = (string)($b['session_id'] ?? '');
    $pass = (string)($b['password'] ?? '');
    if ($sid === '') err_out('missing session_id', 400);
    if (mb_strlen($pass) < PASS_MIN) err_out('a password of at least ' . PASS_MIN . ' characters, please', 400);

    $session = stripe_get_session($sid);
    if ($session === null) err_out('stripe session not found', 402);
    if (($session['payment_status'] ?? '') !== 'paid') err_out('payment not completed', 402);

    $email = (string)($session['customer_details']['email'] ?? $session['customer_email'] ?? '');
    if (!acct_email_ok($email)) err_out('that checkout has no usable email on it', 422);

    $existing = acct_by_email($email);
    if ($existing) err_out('there is already an account for that address — sign in instead', 409);

    // true for the same reason as `claim`: the address came back from a PAID Stripe session,
    // server-side, never from the request body. That is what makes it proof (D-076).
    $a = acct_create($email, $pass, true);
    if (!$a) err_out('could not create the account', 500);

    // Attach the trip this payment made, if it has been created yet.
    $trip = q_first('SELECT slug FROM trips WHERE stripe_session=?', [$session['id']]);
    if ($trip) acct_attach_trip((string)$a['id'], (string)$trip['slug'], 'owner');

    acct_cookie_set(acct_session_start((string)$a['id']));
    json_out(['ok' => true, 'email' => $email]);
  }

  if ($path === 'account/login' && $method === 'POST') {
    require_once __DIR__ . '/lib/accounts.php';
    $b = body_json();
    $email = (string)($b['email'] ?? ''); $pass = (string)($b['password'] ?? '');
    if ($email === '' || $pass === '') err_out('email and password, please', 400);
    if (acct_fail_count($email) >= LOGIN_MAX_FAIL)
      err_out('too many tries for this address — wait an hour', 429);
    $a = acct_check($email, $pass);
    /* D-067: an account minted from a receipt has no password, so this is the ordinary case
       for anyone who bought a trip and never set one. The message says so WITHOUT confirming
       whether the address exists — it reads the same for a stranger and for a customer, which
       is the point, and it sends both to the flow that actually works. */
    if (!$a) { acct_fail_record($email); err_out('that pair does not match anything. If you bought a trip and never set a password, use "email me a link" below.', 401); }
    acct_cookie_set(acct_session_start((string)$a['id']));
    json_out(['ok' => true, 'email' => (string)$a['email']]);
  }

  /* POST /api/account/reset-request — always answers the same, account or not (D-056). */
  if ($path === 'account/reset-request' && $method === 'POST') {
    require_once __DIR__ . '/lib/accounts.php';
    require_once __DIR__ . '/lib/mail.php';
    $email = (string)(body_json()['email'] ?? '');
    $a = acct_email_ok(acct_norm_email($email)) ? acct_by_email($email) : null;
    /* D-076: at most MAIL_MAX_HOUR mails to one address per hour. Note where the test sits —
       inside the `if ($a)`, so the answer below is still identical for an address with an
       account and one without. A throttle that announced itself would be exactly the
       enumeration oracle the same-answer rule exists to prevent. */
    if ($a && acct_mail_allowed((string)$a['email'])) {
      acct_mail_record((string)$a['email']);
      $token = acct_reset_start((string)$a['id']);
      $url = 'https://' . APEX . '/reset?t=' . $token;
      send_mail((string)$a['email'], 'Reset your password for this trip, btw',
        "Someone asked to reset the password on your account.\n\n" .
        "Open this within the hour:\n$url\n\n" .
        "If it wasn't you, ignore this — nothing has changed, and the link expires on its own.\n\n" .
        "One thing worth knowing: this resets your ACCOUNT password, not your trip passwords. " .
        "Those are stored as one-way hashes and nobody can recover them, us included.\n",
        'reset');
    }
    // Same answer either way — a reset form that says "no such account" tells a stranger
    // which addresses have one.
    json_out(['ok' => true]);
  }

  /* POST /api/account/signup — D-076 step 2. Anyone may ask for an account.
     Three things about this are deliberate and easy to undo by accident:

     1. **It answers identically whether or not that address already has an account.** Same
        rule as reset-request (D-056), same reason: a signup form that says "already taken"
        is an oracle for who has an account here, which is a real leak in a product that
        promises to hold almost nothing about you.
     2. **The account it creates is UNVERIFIED and has no password**, so it is not a way in.
        `acct_check()` refuses both conditions. The only way to finish is the mailed token,
        which is what proves the address belongs to whoever asked.
     3. **It reuses the reset token wholesale.** `acct_reset_finish()` sets the password AND
        `verified=1` (D-076 step 1), so first sign-up and password reset are one flow with
        one expiry, one mailer and one set of tests. There is no second token type to build.

     Throttled per address like every other path that sends mail, and the throttle is inside
     the branch so silence still reads the same from outside. */
  if ($path === 'account/signup' && $method === 'POST') {
    require_once __DIR__ . '/lib/accounts.php';
    require_once __DIR__ . '/lib/mail.php';
    $email = acct_norm_email((string)(body_json()['email'] ?? ''));
    if (acct_email_ok($email) && acct_mail_allowed($email)) {
      $a = acct_by_email($email);
      $fresh = false;
      if (!$a) { $a = acct_create($email); $fresh = true; }   // unverified, no password, on purpose
      if ($a) {
        acct_mail_record($email);
        $token = acct_reset_start((string)$a['id']);
        $url = 'https://' . APEX . '/reset?t=' . $token;
        /* Two bodies, because the situations genuinely differ and one message would be wrong
           for somebody. A stranger who already has an account needs to know it exists rather
           than being told to set a password again. */
        $body = $fresh
          ? "Someone asked to make an account on this trip, btw with this address.\n\n" .
            "Open this within the hour to set a password and finish:\n$url\n\n" .
            "If it wasn't you, ignore this. Nothing was created that anyone can use — the account " .
            "cannot be signed into until that link is opened, and it expires on its own.\n"
          : "Someone asked to make an account on this trip, btw with this address, and there " .
            "is already one here.\n\nIf that was you, this link sets a new password:\n$url\n\n" .
            "If it wasn't, ignore this — nothing has changed and the link expires on its own.\n";
        send_mail($email, 'Finish your this trip, btw account', $body .
          "\nOne thing worth knowing: this is your ACCOUNT password, not a trip password. " .
          "Trip phrases are stored as one-way hashes and nobody can recover them, us included.\n",
          'signup');
      }
    }
    // Same answer for a new address, an existing one, a malformed one and a throttled one.
    json_out(['ok' => true]);
  }

  if ($path === 'account/reset' && $method === 'POST') {
    require_once __DIR__ . '/lib/accounts.php';
    $b = body_json();
    $token = (string)($b['token'] ?? ''); $pass = (string)($b['password'] ?? '');
    if ($token === '') err_out('missing token', 400);
    if (mb_strlen($pass) < PASS_MIN) err_out('a password of at least ' . PASS_MIN . ' characters, please', 400);
    if (!acct_reset_finish($token, $pass))
      err_out('that link has expired or already been used — ask for a new one', 400);
    json_out(['ok' => true]);
  }

  if ($path === 'account/logout' && $method === 'POST') {
    require_once __DIR__ . '/lib/accounts.php';
    acct_session_end($_COOKIE['ttb_s'] ?? null);
    acct_cookie_clear();
    json_out(['ok' => true]);
  }

  if ($path === 'account/me' && $method === 'GET') {
    require_once __DIR__ . '/lib/accounts.php';
    $a = acct_current();
    if (!$a) json_out(['signed_in' => false]);
    $ts = acct_trips((string)$a['id']);
    /* The SHAPE rides along (§2bk) so the list can draw each trip rather than only name it. It is
       normalised and position-free — see `acct_trip_shapes()` — and it is one extra query for the
       whole list, not one per row. */
    $shapes = acct_trip_shapes(array_map(fn($t) => (string)$t['slug'], $ts));
    json_out(['signed_in' => true, 'email' => (string)$a['email'],
              'trips' => array_map(fn($t) => [
                  'slug'    => (string)$t['slug'],
                  'name'    => (string)$t['name'],
                  'tier'    => (string)$t['tier'],
                  'role'    => (string)$t['role'],
                  'expires' => $t['expires'] !== null ? (int)$t['expires'] : null,
                  'shape'   => $shapes[(string)$t['slug']] ?? null,
              ], $ts)]);
  }

  /* POST /api/account/claim-trip — attach a trip you hold a personal link for (D-047).
     The proof is the member phrase itself: you can only attach a trip you can already open.
     This is how "trips you were invited to" gets populated without anyone typing a slug. */
  if ($path === 'account/claim-trip' && $method === 'POST') {
    require_once __DIR__ . '/lib/accounts.php';
    $a = acct_current();
    if (!$a) err_out('sign in first', 401);
    $b = body_json();
    $slug = strtolower(trim((string)($b['slug'] ?? '')));
    $tok  = strtolower(trim((string)($b['phrase'] ?? '')));
    if ($slug === '' || $tok === '') err_out('which trip, and your link phrase', 400);
    /* D-091: this checks the SAME secret the trip gate checks — a member phrase — and until now
       it did so with no limiter at all, while the gate rate-limits guesses at 30/trip/hour. A
       4-word phrase is 240^4, about 31.6 bits, and 31.6 bits is only safe because guessing is
       supposed to be slow. This was a second door onto the same lock, without the lock.

       D-076 quietly made it cheaper to reach: the barrier used to be "has bought a trip", and
       since open signup it is "has an account", which anyone can have for free.

       So it shares the gate's limiter and its counter. A wrong guess here costs the attacker the
       same budget a wrong guess at the front door costs, and burning it here also slows them
       there — which is right, because it is one secret.

       Note the ORDER: the limiter is consulted before the trip is looked up, so the 404/403
       distinction below cannot be used as an unmetered slug oracle either. */
    $win = intdiv(now_ms(), 3600000);
    $g = q_first('SELECT hits FROM gate WHERE slug=? AND win=?', [$slug, $win]);
    if ($g && (int)$g['hits'] >= 30) err_out('too many tries for this trip — wait an hour', 429);

    $trip = q_first('SELECT slug FROM trips WHERE slug=?', [$slug]);
    $hash = hash('sha256', $tok);
    $mem  = $trip ? q_first('SELECT id FROM members WHERE slug=? AND phrase_hash=? AND deleted=0', [$slug, $hash]) : null;
    if (!$mem) {
      /* One answer for "no such trip" and for "wrong phrase". The old code returned 404 vs 403,
         which confirmed which slugs exist to anyone with a free account. */
      q('INSERT INTO gate (slug,win,hits) VALUES (?,?,1) ON DUPLICATE KEY UPDATE hits=hits+1', [$slug, $win]);
      err_out('that phrase is not a personal link for this trip', 403);
    }
    acct_attach_trip((string)$a['id'], $slug, 'member');
    json_out(['ok' => true]);
  }

  /* GET /api/geocode — place lookup through us instead of from the browser (D-045).
     Unauthenticated by necessity: /new has no trip and no token, and naming the place you
     just tapped is the first thing that happens there. It is safe to leave open — it writes
     nothing, it reads a public gazetteer, the answers are cached and shared, and the pacing
     gate holds the whole site to ~1 upstream call/sec no matter how many people are typing. */
  if ($path === 'geocode' && $method === 'GET') {
    require_once __DIR__ . '/lib/geocode.php';
    header('Cache-Control: public, max-age=86400');
    if (isset($_GET['lat'], $_GET['lon'])) {
      $name = geo_reverse((float)$_GET['lat'], (float)$_GET['lon']);
      json_out(['name' => $name]);
    }
    $q = (string)($_GET['q'] ?? '');
    if (trim($q) === '') err_out('nothing to look up', 400);
    json_out(['results' => geo_search($q)]);
  }

  /* GET /api/route?c=lat,lng;lat,lng — road geometry, proxied and cached (item 14).
     Unauthenticated like /api/geocode and for the same reasons: it identifies nobody, it reads
     a public road network, answers are cached and shared, and the pacing gate holds the whole
     site to a few upstream calls a second however many people are dragging a route around.
     The point of it being here at all is that OSRM no longer sees a traveller's IP. */
  if ($path === 'route' && $method === 'GET') {
    require_once __DIR__ . '/lib/routing.php';
    header('Cache-Control: public, max-age=604800');   // a week at the edge; roads do not move
    /* `poly`, not `path` (D-110). The value is an encoded polyline now, not an array of pairs,
       and a renamed key is how a stale cached page finds nothing rather than misreading a
       string as coordinates — it falls back to the dashed straight line, which is the existing
       no-route behaviour and degrades quietly. */
    $geo = rt_route((string)($_GET['c'] ?? ''));
    json_out(['poly' => $geo]);                        // null = no route; the client dashes it
  }

  /* POST /api/draft-chat — the pre-purchase agent (D-035). Unauthenticated by necessity:
     on /new there is no trip, no slug and no token, and that is exactly where "UA328 and
     AA1902, Aug 14" would sell the product. So the rate limiting IS the feature.

     Four caps, in the order they can stop a request:
       1. per-IP daily count  — the address is hashed with a daily-rotating salt, never stored
       2. 2 turns per draft   — counted from the transcript the caller sends
       3. no lookup_flight    — withheld from the schema AND refused by dispatch (D-035)
       4. global monthly tokens — checked inside chat_run before every model call

     Nothing is written to the database. There is no trip yet; the draft lives in the
     browser, so add_leg accumulates legs and hands them back for the client to keep. */
  if ($path === 'draft-chat' && $method === 'POST') {
    require_once __DIR__ . '/lib/chat.php';

    if (!chat_rate_ok(chat_client_ip())) err_out('that is a lot of drafting for one day — build the rest by hand, or grab a trip', 429);

    $b        = body_json();
    $messages = chat_sanitize_history($b['messages'] ?? []);
    if (!$messages) err_out('nothing to answer', 400);
    if (chat_user_turns($messages) > CHAT_DRAFT_TURNS)
      err_out('the assistant does two turns per draft before you buy — keep going by hand, it all carries over', 429);

    $places = is_array($b['places'] ?? null) ? $b['places'] : [];

    // The caller's own draft, bounded, so the model can see what it already has.
    $draft = [];
    foreach (array_slice(is_array($b['stops'] ?? null) ? $b['stops'] : [], 0, 60) as $i => $st) {
      if (!is_array($st) || !is_number($st['lat'] ?? null) || !is_number($st['lng'] ?? null)) continue;
      $draft[] = ['kind' => 'stop', 'id' => 'd' . $i,
        'track' => in_array(($st['track'] ?? ''), CHAT_TRACKS, true) ? $st['track'] : 'truck',
        'seq'   => (int)($st['seq'] ?? $i), 'lat' => (float)$st['lat'], 'lng' => (float)$st['lng'],
        'title' => mb_substr((string)($st['title'] ?? ''), 0, 300),
        'date'  => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)($st['date'] ?? '')) ? $st['date'] : '',
        'mode'  => (string)($st['mode'] ?? 'drive'),
        'craft' => (string)($st['craft'] ?? '')];
    }

    $legs = [];
    $listPins = fn($sl) => $draft;
    $addPin   = function ($sl, $pin) use (&$legs, &$draft) {
      $legs[]  = $pin;      // handed back to the browser; nothing touches the DB
      $draft[] = $pin + ['kind' => 'stop'];
      return true;
    };

    try {
      $r = chat_run('draft', false, $messages, $places, $listPins, $addPin);   // paid=false
    } catch (Throwable $e) {
      err_out($e->getMessage(), 503);
    }
    json_out([
      'reply'        => $r['reply'],
      'messages'     => $r['messages'],
      'added'        => $r['added'],
      'needs_places' => $r['needs_places'],
      'legs'         => $legs,
      'turns_left'   => max(0, CHAT_DRAFT_TURNS - chat_user_turns($r['messages'])),
    ]);
  }

  /* POST /api/stripe-webhook — D-073. Stripe tells us a payment happened, server to server.
     Runs on apex, before `claim`, and is the ONLY unauthenticated write in the API — the
     signature IS the authentication.

     WHY IT RECORDS AND DOES NOT MINT. The obvious build is "the webhook mints the trip", and it
     is wrong here. The phrases are generated inside `claim` and returned exactly once; nothing
     stores them in plaintext. A webhook usually beats the browser redirect, so a minting webhook
     would hand the BUYER the 409 below — "the passwords were shown once and cannot be recovered,
     so ask whoever has the link" — on every purchase, locking them out of the trip they just
     bought. That is far worse than the bug it fixes.

     So this closes the half that is unambiguously right: a payment is recorded durably the
     instant Stripe knows about it, whether or not the browser ever comes back. `claim` still
     mints and still shows the phrases once. Automated recovery of a lost redirect needs sign-in
     to be able to open a trip (D-071); until then this record is what makes the gap detectable
     at all — before it, a lost redirect left no trace anywhere on our side. */
  if ($path === 'stripe-webhook' && $method === 'POST') {
    $secret = (string)env('STRIPE_WEBHOOK_SECRET', '');
    if ($secret === '') err_out('webhook not configured', 503);

    $raw = file_get_contents('php://input');
    $sig = $_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '';
    /* Stripe signs "{timestamp}.{raw body}" with HMAC-SHA256. Parsed by hand because this
       project carries no composer deps by design — it is a dozen lines and one hash_equals. */
    $ts = ''; $v1 = [];
    foreach (explode(',', $sig) as $part) {
      $kv = explode('=', trim($part), 2);
      if (count($kv) !== 2) continue;
      if ($kv[0] === 't')  $ts = $kv[1];
      if ($kv[0] === 'v1') $v1[] = $kv[1];
    }
    if ($ts === '' || !$v1) err_out('bad signature', 400);
    // Replay window. Without it a captured request stays valid forever.
    if (abs(time() - (int)$ts) > 300) err_out('stale signature', 400);
    $expect = hash_hmac('sha256', $ts . '.' . $raw, $secret);
    $ok = false;
    foreach ($v1 as $cand) if (hash_equals($expect, $cand)) $ok = true;
    if (!$ok) err_out('bad signature', 400);

    $ev = json_decode($raw, true);
    if (!is_array($ev)) err_out('bad payload', 400);
    /* Anything but a completed checkout is acknowledged and ignored — Stripe retries on a
       non-2xx, and retrying an event we do not care about helps nobody. */
    if (($ev['type'] ?? '') !== 'checkout.session.completed') json_out(['ok' => true, 'ignored' => true]);

    $s = $ev['data']['object'] ?? [];
    $sid = (string)($s['id'] ?? '');
    if ($sid === '') json_out(['ok' => true, 'ignored' => 'no session id']);
    if (($s['payment_status'] ?? '') !== 'paid') json_out(['ok' => true, 'ignored' => 'unpaid']);

    $amount = (int)($s['amount_total'] ?? 0);
    $tier = '';
    foreach (TIERS as $k => $v) if ($v['cents'] === $amount) { $tier = $k; break; }
    require_once __DIR__ . '/lib/accounts.php';
    $email = acct_norm_email((string)($s['customer_details']['email'] ?? $s['customer_email'] ?? ''));
    /* D-188 — A RENEWAL IS THE SAME PAYMENT WITH ONE WORD ON IT. `client_reference_id` of
       `renew_<slug>` on a checkout means: extend that trip by the tier just bought, from whichever
       is later of its current end and today; upgrade the tier if the new one is higher, never
       downgrade; re-arm the expiry notice. No new trip is minted. Unknown or malformed refs fall
       through to the ordinary path exactly as before. This is also the first time the webhook has
       read client_reference_id at all — D-055's via_ tag has only ever been visible in Stripe. */
    $ref = (string)($s['client_reference_id'] ?? '');
    $existing = q_first('SELECT slug FROM trips WHERE stripe_session=?', [$sid]);
    if (!$existing && $tier !== '' && preg_match('/^renew_([a-z2-9]{7})$/', $ref, $rm)) {
      $rt = q_first('SELECT slug, tier, expires FROM trips WHERE slug=?', [$rm[1]]);
      if ($rt) {
        $rank = ['plan' => 1, 'keep' => 2, 'works' => 3];
        $now  = now_ms();
        $from = max((int)($rt['expires'] ?? 0), $now);
        $newExp  = $from + TIERS[$tier]['days'] * 86400000;
        $newTier = ($rank[$tier] ?? 0) > ($rank[(string)$rt['tier']] ?? 0) ? $tier : (string)$rt['tier'];
        q('UPDATE trips SET expires=?, tier=?, expiry_notified=NULL, updated=? WHERE slug=?',
          [$newExp, $newTier, $now, $rt['slug']]);
        q('INSERT INTO payments (session_id,email,amount,tier,slug,created) VALUES (?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE slug=COALESCE(VALUES(slug), slug)',
          [$sid, $email, $amount, $tier, (string)$rt['slug'], $now]);
        json_out(['ok' => true, 'renewed' => (string)$rt['slug'], 'expires' => $newExp, 'tier' => $newTier]);
      }
    }

    /* Idempotent: Stripe retries, and the buyer's own claim may already have minted. The primary
       key keeps the first record; the slug is filled in once a trip exists for it. */
    q('INSERT INTO payments (session_id,email,amount,tier,slug,created) VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE slug=COALESCE(VALUES(slug), slug)',
      [$sid, $email, $amount, $tier, $existing ? (string)$existing['slug'] : null, now_ms()]);

    json_out(['ok' => true, 'recorded' => true]);
  }

  // POST /api/claim — Stripe checkout session → mint a trip (runs on apex)
  if ($path === 'claim' && $method === 'POST') {
    $b = body_json();
    $session_id = $b['session_id'] ?? null;
    $trip_name  = $b['trip_name']  ?? null;
    if (!$session_id) err_out('missing session_id', 400);

    $session = stripe_get_session($session_id);
    if ($session === null) {
      /* Test and live are separate object spaces: a live key cannot see a cs_test_ session,
         and vice versa. The symptom is an ordinary "not found", which sends you hunting the
         wrong problem. Say which half is out of step instead. */
      $keyLive = str_starts_with((string)env('STRIPE_SECRET', ''), 'sk_live_');
      $sesTest = str_starts_with((string)$session_id, 'cs_test_');
      if ($keyLive && $sesTest)  err_out('this is a test payment link but the site is on live Stripe keys — the payment links need replacing with live ones', 402);
      if (!$keyLive && !$sesTest) err_out('this is a live payment link but the site is on test Stripe keys', 402);
      err_out('stripe session not found', 402);
    }
    if (($session['payment_status'] ?? '') !== 'paid') err_out('payment not completed', 402);

    $amount = $session['amount_total'] ?? null;
    $tier = null;
    foreach (TIERS as $k => $v) { if ($v['cents'] === $amount) { $tier = $k; break; } }
    if (!$tier) err_out('unrecognized amount', 402);

    // one trip per checkout session
    /* One trip per checkout. Name the address in the message: the phrases are gone for good
       (only hashes are stored), but knowing WHICH trip the payment made is the difference
       between "ask whoever has the link" and having no idea anything exists. The slug alone
       opens nothing — the gate still wants a phrase — and only someone holding the paid
       session id can get this far. */
    /* D-188: a renewal's session never mints. If the webhook already extended a trip on this
       session, say so — the return page shows the new end date instead of two passwords. If the
       webhook has not fired yet (it usually has), do the extension here, idempotently. */
    $ref = (string)($session['client_reference_id'] ?? '');
    if (preg_match('/^renew_([a-z2-9]{7})$/', $ref, $rm)) {
      $paid = q_first('SELECT slug FROM payments WHERE session_id=?', [$session['id']]);
      $rt   = q_first('SELECT slug, name, tier, expires FROM trips WHERE slug=?', [$rm[1]]);
      if ($rt && !$paid) {
        $rank = ['plan' => 1, 'keep' => 2, 'works' => 3];
        $now  = now_ms(); $from = max((int)($rt['expires'] ?? 0), $now);
        $newExp  = $from + TIERS[$tier]['days'] * 86400000;
        $newTier = ($rank[$tier] ?? 0) > ($rank[(string)$rt['tier']] ?? 0) ? $tier : (string)$rt['tier'];
        q('UPDATE trips SET expires=?, tier=?, expiry_notified=NULL, updated=? WHERE slug=?', [$newExp, $newTier, $now, $rt['slug']]);
        q('INSERT IGNORE INTO payments (session_id,email,amount,tier,slug,created) VALUES (?,?,?,?,?,?)',
          [$session['id'], '', $amount, $tier, (string)$rt['slug'], $now]);
        $rt['expires'] = $newExp; $rt['tier'] = $newTier;
      }
      if ($rt) json_out(['renewed' => true, 'slug' => (string)$rt['slug'], 'name' => (string)$rt['name'],
                         'tier' => (string)$rt['tier'], 'expires' => (int)$rt['expires']]);
    }
    $dup = q_first('SELECT slug FROM trips WHERE stripe_session=?', [$session['id']]);
    if ($dup) err_out('this payment already made a trip, at ' . APEX . '/' . $dup['slug']
                    . ' — the passwords were shown once and cannot be recovered, so ask whoever has the link', 409);

    $slug = null;
    for ($i = 0; $i < 5; $i++) {
      $cand = rand_str(7, SLUG_ALPHABET);
      $hit = q_first('SELECT 1 AS x FROM trips WHERE slug=?', [$cand]);
      if (!$hit && !in_array($cand, RESERVED, true)) { $slug = $cand; break; }
    }
    if (!$slug) err_out('could not allocate a trip address, try again', 500);

    $editToken = phrase(4);
    $viewToken = phrase(4);
    $t = now_ms();
    $days = TIERS[$tier]['days'];
    $expires = $days ? $t + $days * 86400000 : null;
    q('INSERT INTO trips (slug,name,tier,edit_hash,view_hash,labels_json,stripe_session,created,expires,updated)
       VALUES (?,?,?,?,?,?,?,?,?,?)',
      [$slug, mb_substr((string)jor($trip_name, 'our trip'), 0, 60, 'UTF-8'), $tier,
       hash('sha256', $editToken), hash('sha256', $viewToken), DEFAULT_LABELS,
       $session['id'], $t, $expires, $t]);

    /* D-073: stamp the payment ledger so both sides agree whichever arrived first. If the webhook
       already recorded this session the row exists and gains its slug here; if it has not fired
       yet, this writes the row and the webhook's later INSERT no-ops on the primary key. Wrapped
       for the same reason the account mint below is: the customer has paid, and no bookkeeping is
       allowed to turn a successful payment into an error. */
    try {
      require_once __DIR__ . '/lib/accounts.php';
      q('INSERT INTO payments (session_id,email,amount,tier,slug,created) VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE slug=VALUES(slug)',
        [$session['id'],
         acct_norm_email((string)($session['customer_details']['email'] ?? $session['customer_email'] ?? '')),
         (int)$amount, $tier, $slug, $t]);
    } catch (\Throwable $e) { /* never fail a paid claim over a ledger row */ }

    /* D-067: mint the account from the receipt. Stripe already collected an email in order to
       send one, so there is nothing further to ask for and no signup step anywhere — which is
       what D-036 described and the code never did.

       WRAPPED, and deliberately so. The person has paid; they must get their trip. Nothing
       about bookkeeping an email is allowed to turn a successful payment into an error, so
       every failure here is swallowed and the claim returns exactly as it did before. The
       worst case is the behaviour of the last three days: no account. */
    $acctEmail = null;
    try {
      require_once __DIR__ . '/lib/accounts.php';
      $e = acct_norm_email((string)($session['customer_details']['email'] ?? $session['customer_email'] ?? ''));
      if ($e !== '' && acct_email_ok($e)) {
        // true: Stripe collected this address, charged a card against it and receipted it (D-076)
        $a = acct_by_email($e) ?: acct_create($e, null, true);   // no password: they never chose one
        if ($a) { acct_attach_trip((string)$a['id'], $slug, 'owner'); $acctEmail = $e; }
      }
    } catch (\Throwable $ex) { /* never fail a paid claim over an account */ }

    /* D-074: the receipt. Wrapped like everything else after the payment — a mail that fails
       must not turn a successful purchase into an error.

       WHAT IT DELIBERATELY DOES NOT CONTAIN: the phrases. They ARE the key, they are stored
       only as SHA-256, and mailing a working link would mail the secret to a mailbox that keeps
       it forever. That is the whole reason this sat unbuilt (DEEP_AUDIT B3). It carries the trip
       ADDRESS, which opens nothing on its own — the gate still wants a phrase.

       It also carries NO sign-in token. A reset link expires in an hour and would be dead by the
       time most people read a receipt, so it would mostly be a broken promise; and a live one
       sitting in an inbox forever is a standing key to the trip, now that signing in opens trips
       (D-071). Asking for the link at /account when they actually need it is both more useful
       and less exposed. */
    try {
      if ($acctEmail) {
        require_once __DIR__ . '/lib/mail.php';
        $name = mb_substr((string)jor($trip_name, 'our trip'), 0, 60, 'UTF-8');
        $when = $expires ? gmdate('j F Y', (int)($expires / 1000)) : null;
        send_mail($acctEmail, 'Your trip: ' . APEX . '/' . $slug,
          "Your trip is live at:\nhttps://" . APEX . '/' . $slug . "\n\n" .
          ($when ? "It is kept until $when.\n\n" : "") .
          "THE TWO PASSWORDS ARE NOT IN THIS EMAIL, on purpose. They were shown once on screen " .
          "and they are stored only as one-way hashes — nobody can recover them, us included, " .
          "and mailing them would leave the key to your trip sitting in an inbox. Keep them " .
          "wherever you keep passwords.\n\n" .
          "If you lose them, you can still get back to this trip: an account was made for this " .
          "address when you paid. Go to https://" . APEX . "/account, put this address in, and " .
          "ask for a link — signing in opens the trips you own.\n\n" .
          "Share the trip by sending someone the address above plus the view phrase. Anyone who " .
          "has both can see it; anyone with the edit phrase can change it.\n",
          'purchase');
      }
    } catch (\Throwable $ex) { /* a receipt is never worth failing a paid claim over */ }

    json_out(['slug' => $slug, 'tier' => $tier, 'edit_token' => $editToken,
              'view_token' => $viewToken, 'url' => "https://" . APEX . "/{$slug}",
              'account_email' => $acctEmail]);   // D-021 path-based
  }

  // everything below runs on a trip subdomain and needs a token
  if (!$sub) err_out('not found', 404);
  $acc   = access_level($sub);
  $level = $acc['level'];
  $trip  = $acc['trip'] ?? null;
  if (!$level && !empty($acc['expired']))
    err_out('this trip reached its one-year end and was deleted', 410);
  if (!$level) err_out('bad or missing trip link', 401);   // worker also folds `limited` into this 401
  $canWrite = ($level === 'edit');
  /* M1 / D-072: who may destroy or lock others out. The shared EDIT phrase is the buyer's, and an
     account row with role='owner' is the same person. A member phrase is crew — it grants edit,
     which is the whole point of D-023's attribution layer, but not the power to delete the trip
     or rotate the buyer out of their own purchase. Until now every invited person had both. */
  $isOwner = !empty($acc['owner']);
  $t = now_ms();

  // GET state?since=0 — polling sync: config + changed pins/notes (tombstones included)
  if ($path === 'trip/state' && $method === 'GET') {
    /* D-187: the stdio MCP server reads a kept trip through this endpoint and announces itself as
       thistripbtw-mcp/<version>. Counting that prefix is the first agent-channel signal that does
       not need a purchase. The UA is matched and dropped — nothing about it is kept. */
    if (str_starts_with((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 'thistripbtw-mcp/')) {
      require_once __DIR__ . '/lib/tally.php'; tally('kept_read');
    }
    $since = (int)($_GET['since'] ?? 0);
    // whoever this viewer says they are — used only to decide which sealed drops they've opened
    /* D-047: the viewer's identity for sealing comes from the TOKEN and nowhere else.
       This used to fall back to $_GET['who'] — a name the caller typed — so anyone holding
       the shared edit or view phrase could read another person's drops by asking for them
       under that person's name. A member phrase (D-023) is a per-person key, so `member` is
       the only claim of identity the server can actually check. No member phrase means no
       identity, which means everything sealed stays sealed: the failure direction has to be
       toward keeping the surprise, because the surprise is the whole feature. */
    $who = trim((string)($acc['member'] ?? ''));
    // deterministic order: same-date stops keep creation order (client re-sorts by date, stably)
    $pins  = q_all('SELECT * FROM pins  WHERE slug=? AND updated>? ORDER BY updated ASC, id ASC', [$sub, $since]);
    $notes = q_all('SELECT * FROM notes WHERE slug=? AND updated>? ORDER BY ord ASC, id ASC', [$sub, $since]);
    $roster = q_all('SELECT id,handle FROM members WHERE slug=? AND deleted=0 ORDER BY created ASC', [$sub]);
    json_out([
      'serverTime' => $t,
      'access'     => $level,
      'me'         => $acc['member'] ?? null,                       // this viewer's member handle, if any
      'members'    => array_map(fn($r) => (string)$r['handle'], $roster),  // handles (colors/attribution)
      'roster'     => array_map(fn($r) => ['id' => (string)$r['id'], 'handle' => (string)$r['handle']], $roster), // + ids (revoke)
      'tier'       => $trip['tier'],
      /* `media` is kept as "can upload anything at all" so a client loaded before D-088 keeps
         working; `photo` and `video` are what the current client reads. */
      'media'      => TIERS[$trip['tier']]['photo'] || TIERS[$trip['tier']]['video'],
      'photo'      => TIERS[$trip['tier']]['photo'],
      'video'      => TIERS[$trip['tier']]['video'],
      'expires'    => $trip['expires'] !== null ? (int)$trip['expires'] : null,
      /* D-114: an in-house QA trip, so the client can say so. A beta tester must be able to
         tell an internal trip from how the product actually behaves for a customer — chiefly
         that this one has no end date, which no purchasable tier does. */
      'qa'         => (int)($trip['qa'] ?? 0) === 1,
      /* THE OFFLINE BASEMAP'S URL, AND WHY IT COMES FROM HERE.
         scripts/trip-tiles.php cuts a vector basemap to this trip's own shape and names the file
         HMAC(slug, TILES_SALT). It must be named that way rather than after the slug, because a
         per-trip basemap IS a map of where somebody is going — the slug is in the address bar, in
         the og card and in every shared link, so a derivable filename would hand the route to
         anyone holding a link, past the phrase gate entirely.
         So the token is handed out HERE, on a response that already required a phrase or an
         account session. Null when no archive has been cut, which is the normal state for a trip
         whose route has not settled.
         API SHAPE: additive, signed off as D-157. No existing key changes type or meaning, so a
         client from before it landed ignores this and behaves exactly as it did. D-157 settles
         the plumbing and its shape ONLY — adopting Protomaps and retiring CARTO is still open. */
      'tiles'      => (function () use ($sub) {
        $st = __DIR__ . '/var/trip-tiles.json';
        if (!is_file($st)) return null;
        $j = json_decode((string)@file_get_contents($st), true);
        $tok = is_array($j) ? ($j[$sub]['token'] ?? null) : null;
        if (!$tok || !preg_match('/^[a-f0-9]{32}$/', (string)$tok)) return null;
        return is_file(__DIR__ . "/maps/trips/$tok.pmtiles.bin") ? "/maps/trips/$tok.pmtiles.bin" : null;
      })(),
      'config'     => ['name' => $trip['name'], 'labels' => json_decode($trip['labels_json'], true)],
      'pins'       => array_map(fn($r) => seal_pin(normalize_pin($r), $who), $pins),
      'notes'      => array_map('normalize_note', $notes),
    ]);
  }

  /* GET /{slug}/api/export — D-085, take your trip with you.

     Gated on EDIT, not on tier: every paid tier gets it. Charging to get your own trip out
     would undercut the delete-everything button, which is what makes the privacy promise
     credible in the first place.

     Edit rather than view, because the archive is the whole trip in one file and a view link
     is the thing you hand to people you do not want holding that. `$who` comes from the token
     exactly as `trip/state` takes it, and every pin goes through the same `seal_pin()` — an
     export is precisely the side door that bypasses a check the main path enforces. */
  if ($path === 'trip/export' && $method === 'GET') {
    if (!$canWrite) err_out('the edit phrase is needed to export a trip', 403);
    require_once __DIR__ . '/lib/export.php';
    $who  = trim((string)($acc['member'] ?? ''));
    $file = export_build($sub, $trip, $who);
    if ($file === null) err_out('could not build the export', 500);
    $stamp = gmdate('Y-m-d');
    $safe  = preg_replace('/[^A-Za-z0-9._-]+/', '-', (string)$trip['name']);
    $safe  = trim((string)$safe, '-');
    if ($safe === '') $safe = 'trip';
    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="' . $safe . '-' . $stamp . '.zip"');
    header('Content-Length: ' . filesize($file));
    header('Cache-Control: no-store');       // it contains the trip; never let a proxy keep it
    readfile($file);
    @unlink($file);                          // temp files are not a place to leave a trip
    exit;
  }

  if (!$canWrite && $method !== 'GET') err_out("view link can't make changes", 403);

  // pins
  if ($path === 'trip/pins' && $method === 'POST') {
    $p = body_json();
    if (!is_number($p['lat'] ?? null) || !is_number($p['lng'] ?? null)) err_out('lat/lng required', 400);
    $id = insert_pin($sub, $p, $t);
    json_out(['id' => $id, 'updated' => $t]);
  }
  /* POST trip/pins/{id}/open — open a sealed drop, as yourself (D-047).
     Two things this does that the client cannot be trusted to do:
       1. it appends the AUTHENTICATED member's handle, so nobody can open a drop as someone
          else, and
       2. it checks the 30-mile radius (D-010) on the server. That check used to live only in
          the browser, which made "you have to be there" a suggestion rather than a rule —
          and being there is the entire point of a sealed drop.
     Needs a member phrase: the shared edit link proves you are on the trip, not who you are. */
  if (preg_match('#^trip/pins/([A-Za-z0-9]+)/open$#', $path, $m) && $method === 'POST') {
    if (!$canWrite) err_out('view links cannot open drops', 403);
    $me = trim((string)($acc['member'] ?? ''));
    if ($me === '') err_out('a sealed drop opens for a person, and this link does not say who you are — ask for your own link', 403);

    $pin = q_first('SELECT * FROM pins WHERE id=? AND slug=?', [$m[1], $sub]);
    if (!$pin) err_out('no such pin', 404);
    if (($pin['kind'] ?? '') !== 'sealed' && empty($pin['near_only']))
      err_out('that pin is not locked to a place', 400);

    $b = body_json();
    if (!isset($b['lat'], $b['lng'])) err_out('opening a drop needs where you are', 400);
    /* D-124: a pin may carry its own geofence. NULL keeps the global default for its kind, so
       every pin made before this behaves exactly as it did. The server is the only place this
       is enforced — the client shows the number, it does not decide it (D-047's shape). */
    $limit = ($pin['radius_mi'] !== null && $pin['radius_mi'] !== '')
      ? max(RADIUS_MIN_MI, min(RADIUS_MAX_MI, (float)$pin['radius_mi']))
      : ((($pin['kind'] ?? '') === 'sealed') ? SEAL_RADIUS_MI : NEAR_RADIUS_MI);
    $d = haversine_mi((float)$b['lat'], (float)$b['lng'], (float)$pin['lat'], (float)$pin['lng']);
    if ($d > $limit) {
      /* "Still 0 miles too far" is what a mile-only message says when someone is standing
         across the street, so short distances are given in feet. */
      $off  = $d - $limit;
      $away = $off < 1 ? (max(1, (int)round($off * 5280 / 10) * 10) . ' feet') : ((int)ceil($off) . ' miles');
      err_out('still ' . $away . ' too far — this one opens where it was left', 403);
    }

    $opened = json_decode((string)($pin['opened_by'] ?? '[]'), true);
    if (!is_array($opened)) $opened = [];
    if (!in_array($me, $opened, true)) {
      $opened[] = $me;
      q('UPDATE pins SET opened_by=?, updated=? WHERE id=? AND slug=?',
        [json_encode(array_values($opened)), now_ms(), $m[1], $sub]);
    }
    json_out(['ok' => true, 'pin' => seal_pin(normalize_pin(q_first('SELECT * FROM pins WHERE id=? AND slug=?', [$m[1], $sub])), $me)]);
  }

  if (preg_match('#^trip/pins/([A-Za-z0-9]+)$#', $path, $m) && ($method === 'PATCH' || $method === 'DELETE')) {
    $id = $m[1];
    if ($method === 'DELETE') {
      $row = q_first('SELECT photo FROM pins WHERE id=? AND slug=?', [$id, $sub]);
      if ($row && !empty($row['photo'])) delete_media_file($row['photo']);
      q("UPDATE pins SET deleted=1, photo='', title='', notes='', updated=? WHERE id=? AND slug=?", [$t, $id, $sub]);
      json_out(['ok' => true]);
    }
    $p = body_json();
    /* OT1 (2026-07-30 audit): POST guards lat/lng with is_number and answers 400, and PATCH did
       not — the same two columns went straight into the UPDATE. `lat`/`lng` are DOUBLE NOT NULL
       and MySQL runs STRICT_TRANS_TABLES, so a non-numeric value raised ERROR 1366 and the row
       survived: the data was never at risk, but the caller got a bodyless 500 where the other
       half of the same endpoint pair would have told them what was wrong. Two writes to one
       table should not disagree about what a coordinate is.

       Note `is_number()` is deliberately strict — `is_int || is_float`, so the STRING "40.7" is
       rejected. That is POST's existing contract and this now matches it rather than inventing a
       looser one. Checked before shipping: every client sends coordinates as JS numbers (Leaflet
       `LatLng`, and `normalize_pin` casts to float on the way out), and the MCP server only
       builds `#d=` fragments and never calls this API. Nothing in the product sends a string. */
    foreach (['lat','lng'] as $c)
      if (array_key_exists($c, $p) && !is_number($p[$c])) err_out('lat/lng must be numbers', 400);

    /* OT3: quest claims. These used to be two ordinary patchable strings, which meant the score
       rested entirely on the client being honest — the same assumption D-047 removed from sealed
       drops, one feature over. Three rules now, none of which change what the UI already does:

         · a claim cannot be overwritten. The UI hides the claim buttons once a quest is taken,
           so first-claim-wins was already the intended rule and simply was not enforced. It is
           applied as a condition on the UPDATE rather than a read-then-write, so two vehicles
           claiming the same quest at the same moment resolve atomically instead of racing.
         · the team must be a real track. `truck` and `rental` are fixed keys in the client
           (only their LABELS are per-trip and renameable), so anything else is invalid data.
         · the claimant is taken from the token when the caller holds a member phrase, and only
           falls back to the supplied name when they do not. That is D-047's rule applied as far
           as it can go without *requiring* personal links, which would be a product change and
           is not mine to make. With a personal link a claim is now attributable; with the shared
           edit link it stays self-declared, exactly as before. */
    $claiming = array_key_exists('claimed_team', $p) && trim((string)$p['claimed_team']) !== '';
    if ($claiming) {
      $team = trim((string)$p['claimed_team']);
      if (!in_array($team, ['truck', 'rental'], true)) err_out('unknown team', 400);
      $who = trim((string)($acc['member'] ?? '')) ?: mb_substr((string)jor($p['claimed_by'] ?? null, ''), 0, 40, 'UTF-8');
      $st = q('UPDATE pins SET claimed_team=?, claimed_by=?, updated=? WHERE id=? AND slug=? AND claimed_team=\'\'',
              [$team, $who, $t, $id, $sub]);
      if ($st->rowCount() === 0) err_out('that quest is already claimed', 409);
      json_out(['ok' => true, 'updated' => $t, 'claimed_team' => $team, 'claimed_by' => $who]);
    }

    /* claimed_team/claimed_by are NOT in this list, for the same reason opened_by is not: the
       guarded branch above is the only way to set them. Leaving them patchable would have left
       an unclaim — PATCH `claimed_team:""`, then claim again for the other team — which defeats
       first-claim-wins as thoroughly as overwriting did. There is no unclaim in the UI.
       Silently ignored rather than rejected, so an older client still syncs the rest of its
       patch (D-047's precedent, one field over). */
    $cols = ['track','date','ts','lat','lng','title','lodging','notes','photo','spotify','seq','craft'];
    /* OT2: claimed_team and claimed_by were the only user-writable strings clamped on neither
       path, while title/lodging/notes/craft/author are clamped on both. The columns are
       VARCHAR(16) and VARCHAR(40), so over-long input was ERROR 1406 — another 500 that should
       have been a clamp. Caps match the schema exactly; widen both together or neither. */
    $caps = ['title' => 300, 'lodging' => 300, 'notes' => 4000, 'spotify' => 300, 'photo' => 300,
             'craft' => 24, 'claimed_team' => 16, 'claimed_by' => 40];
    $sets = []; $vals = [];
    foreach ($cols as $c) if (array_key_exists($c, $p)) {
      $v = $p[$c];
      if (isset($caps[$c]) && is_string($v)) $v = mb_substr($v, 0, $caps[$c], 'UTF-8');
      $sets[] = "$c=?"; $vals[] = $v;
    }
    if (array_key_exists('mode', $p)) { $m = norm_mode($p['mode']);
      $sets[] = 'mode=?'; $vals[] = $m; $sets[] = 'fly=?'; $vals[] = ($m === 'fly') ? 1 : 0; }
    elseif (array_key_exists('fly', $p)) { $sets[] = 'fly=?'; $vals[] = $p['fly'] ? 1 : 0;
      $sets[] = 'mode=?'; $vals[] = $p['fly'] ? 'fly' : 'drive'; }
    if (array_key_exists('path', $p)) { $sets[] = 'path=?'; $vals[] = encode_path($p['path']); }
    if (array_key_exists('here', $p)) { $sets[] = 'here=?'; $vals[] = $p['here'] ? 1 : 0; }
    if (array_key_exists('near_only', $p)) { $sets[] = 'near_only=?'; $vals[] = $p['near_only'] ? 1 : 0; }
    if (array_key_exists('radius_mi', $p)) { $sets[] = 'radius_mi=?'; $vals[] = clamp_radius($p['radius_mi']); }
    /* opened_by is NOT patchable any more (D-047). It used to be whatever array the client
       sent, so a caller could simply write someone else's name into it and unseal their drop
       on the next read. Opening is now POST trip/pins/{id}/open, which appends the
       authenticated member and nobody else. Silently ignored rather than rejected so an older
       client still syncs the rest of its patch. */
    if (!$sets) err_out('nothing to update', 400);
    $sets[] = 'updated=?'; $vals[] = $t; $vals[] = $id; $vals[] = $sub;
    q('UPDATE pins SET ' . implode(',', $sets) . ' WHERE id=? AND slug=?', $vals);
    json_out(['ok' => true, 'updated' => $t]);
  }

  // notes
  if ($path === 'trip/notes' && $method === 'POST') {
    $n = body_json();
    $id = 'n' . rand_str(12);
    q('INSERT INTO notes (id,slug,title,body,ord,updated) VALUES (?,?,?,?,?,?)',
      [$id, $sub, mb_substr((string)jor($n['title'] ?? null, ''), 0, 120, 'UTF-8'),
       mb_substr((string)jor($n['body'] ?? null, ''), 0, 8000, 'UTF-8'), jor($n['ord'] ?? null, $t), $t]);
    json_out(['id' => $id, 'updated' => $t]);
  }
  if (preg_match('#^trip/notes/([A-Za-z0-9]+)$#', $path, $m) && ($method === 'PATCH' || $method === 'DELETE')) {
    $id = $m[1];
    if ($method === 'DELETE') {
      q("UPDATE notes SET deleted=1, title='', body='', updated=? WHERE id=? AND slug=?", [$t, $id, $sub]);
      json_out(['ok' => true]);
    }
    $n = body_json();
    $sets = []; $vals = [];
    if (array_key_exists('title', $n)) { $sets[] = 'title=?'; $vals[] = mb_substr((string)$n['title'], 0, 120, 'UTF-8'); }
    if (array_key_exists('body',  $n)) { $sets[] = 'body=?';  $vals[] = mb_substr((string)$n['body'], 0, 8000, 'UTF-8'); }
    if (!$sets) err_out('nothing to update', 400);
    $sets[] = 'updated=?'; $vals[] = $t; $vals[] = $id; $vals[] = $sub;
    q('UPDATE notes SET ' . implode(',', $sets) . ' WHERE id=? AND slug=?', $vals);
    json_out(['ok' => true]);
  }

  // config: trip name + vehicle labels
  if ($path === 'trip/config' && $method === 'PATCH') {
    $c = body_json();
    if (!empty($c['labels']) && is_array($c['labels'])) {
      $labels = array_merge(json_decode($trip['labels_json'], true) ?: [], $c['labels']);
      q('UPDATE trips SET labels_json=?, updated=? WHERE slug=?', [json_encode($labels), $t, $sub]);
    }
    if (isset($c['name']) && is_string($c['name']))
      q('UPDATE trips SET name=?, updated=? WHERE slug=?', [mb_substr($c['name'], 0, 60, 'UTF-8'), $t, $sub]);
    json_out(['ok' => true]);
  }

  // rotate a leaked link
  if ($path === 'trip/rotate' && $method === 'POST') {
      if (!$isOwner) err_out('only the person who bought this trip can change its passwords', 403);
    $b = body_json();
    $which = $b['which'] ?? null;
    if ($which !== 'view' && $which !== 'edit') err_out('which must be view|edit', 400);
    $token = phrase(4);
    q("UPDATE trips SET {$which}_hash=?, updated=? WHERE slug=?", [hash('sha256', $token), $t, $sub]);
    json_out([$which . '_token' => $token]);
  }

  // per-person members (D-023): add a named person with their own phrase → returns
  // their one-tap link (shown ONCE; we store only the hash). Send-only email is the
  // client's job (mailto) — the server never sees or stores an address.
  if ($path === 'trip/members' && $method === 'POST') {
    $b = body_json();
    $handle = mb_substr(trim((string)jor($b['handle'] ?? null, '')), 0, 40, 'UTF-8');
    if ($handle === '') err_out('a name is required', 400);
    $token = phrase(4);
    $id = 'm' . rand_str(12);
    q('INSERT INTO members (id,slug,handle,phrase_hash,created) VALUES (?,?,?,?,?)',
      [$id, $sub, $handle, hash('sha256', $token), $t]);
    q('UPDATE trips SET updated=? WHERE slug=?', [$t, $sub]);
    json_out(['id' => $id, 'handle' => $handle, 'token' => $token,
              'url' => "https://" . APEX . "/{$sub}/#k={$token}"]);
  }
  if (preg_match('#^trip/members/([A-Za-z0-9]+)$#', $path, $m) && $method === 'DELETE') {
      if (!$isOwner) err_out('only the person who bought this trip can remove people from it', 403);
    q('UPDATE members SET deleted=1 WHERE id=? AND slug=?', [$m[1], $sub]);
    q('UPDATE trips SET updated=? WHERE slug=?', [$t, $sub]);
    json_out(['ok' => true]);
  }

  // media upload (works tier): raw body, ?ext=jpg|mp4|...
  if ($path === 'trip/media' && $method === 'POST') {
    $ext = preg_replace('/[^a-z0-9]/', '', strtolower($_GET['ext'] ?? 'jpg'));
    // whitelist extensions in code — don't rely on photos/.htaccess no-exec alone (defense in depth)
    if (!in_array($ext, ['jpg','jpeg','png','gif','webp','heic','mp4','mov','webm'], true)) err_out('unsupported file type', 415);
    $isVideo = in_array($ext, ['mp4', 'mov', 'webm'], true);
    /* D-088: the gate is decided by WHAT is being uploaded, after the extension is known and
       whitelisted — so a caller cannot reach the video allowance by lying about the type, and a
       photo tier refuses a video with a message that names the tier that takes it. */
    if ($isVideo  && !TIERS[$trip['tier']]['video']) err_out('video is on the $10 tier — photos are included here', 402);
    if (!$isVideo && !TIERS[$trip['tier']]['photo']) err_out('photos are on the $5 tier and up', 402);
    $max = $isVideo ? VID_MAX : IMG_MAX;
    $len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if (!$len || $len > $max) err_out('file too large (max ' . round($max / 1048576) . ' MB)', 413);
    $dir = PHOTOS_DIR . '/' . $sub;
    if (!is_dir($dir)) @mkdir($dir, 0755, true);
    /* D-094: the aggregate cap. Checked here on the DECLARED length so an oversized upload is
       refused before a byte is written — but see below, because the declared length is the
       client's word and the bytes on disk are ours. */
    $used = (int)($trip['media_bytes'] ?? 0);
    if ($used + $len > MEDIA_MAX_PER_TRIP)
      err_out('this trip is full — ' . round(MEDIA_MAX_PER_TRIP / 1073741824) . ' GB of photos and video. Remove something first', 413);

    $key = $sub . '/' . rand_str(20) . '.' . $ext;
    $in  = fopen('php://input', 'rb');
    $out = fopen(PHOTOS_DIR . '/' . $key, 'wb');
    if (!$in || !$out) err_out('upload failed', 500);
    $wrote = (int)stream_copy_to_stream($in, $out);
    fclose($in); fclose($out);

    /* A TRUNCATED UPLOAD IS NOT AN UPLOAD. `stream_copy_to_stream` returns whatever actually
       arrived, and a phone that loses signal mid-transfer sends fewer bytes than it declared.
       Without this check the half a JPEG stayed on disk, `media_bytes` was charged for it, and
       the caller never saw the 200 because the connection it would have travelled down is the
       one that died — so the customer got an invisible, unreachable file counted against their
       allowance, and every retry in the same dead zone left another. That is the road this
       product is for, so it is worth a line.
       `$len` is always > 0 here: the check further up rejects a missing or oversized
       Content-Length, which also rules out chunked bodies, so a healthy upload always writes
       exactly what it declared. */
    if ($wrote !== $len) {
      @unlink(PHOTOS_DIR . '/' . $key);
      err_out('the upload was cut short — try again when the signal is better', 400);
    }

    /* Count what was actually written. Content-Length is supplied by the caller and the per-file
       check above trusts it; the aggregate must not, or the cap is advisory. If the real bytes
       push the trip over, the file goes back off the disk rather than being kept and billed. */
    if ($used + $wrote > MEDIA_MAX_PER_TRIP) {
      @unlink(PHOTOS_DIR . '/' . $key);
      err_out('this trip is full — ' . round(MEDIA_MAX_PER_TRIP / 1073741824) . ' GB of photos and video. Remove something first', 413);
    }
    q('UPDATE trips SET media_bytes = media_bytes + ? WHERE slug=?', [$wrote, $sub]);
    json_out(['url' => "/photos/{$key}",
              'bytes_left' => max(0, MEDIA_MAX_PER_TRIP - ($used + $wrote))]);
  }

  // the delete-everything button — hard delete, including media
  /* POST trip/chat — the itinerary agent (D-035). Edit token required: this endpoint spends
     money, and an unauthenticated one gets drained. The transcript arrives in the body, is
     used for this request, and is handed straight back — nothing about it is ever stored. */
  if ($path === 'trip/chat' && $method === 'POST') {
    if (!$canWrite) err_out('the chat needs the edit link', 403);

    /* D-093: a per-trip turn cap, checked BEFORE anything outbound — the same rule the guards in
       CHAT_AGENT_SPEC follow, so an over-budget trip costs nothing rather than one more request.

       Without it the only thing between one trip and the entire monthly token ceiling was six
       tool rounds per request. A single $2.50 buyer could exhaust the global budget and turn the
       chat off for every other customer, silently, and nothing would have said so.

       Incremented with `chat_turns + 1` in the UPDATE rather than read-then-write: that is
       atomic in MySQL and cannot lose increments the way the file counters did before D-091. */
    $used = (int)($trip['chat_turns'] ?? 0);
    if ($used >= CHAT_TURNS_PER_TRIP)
      err_out('this trip has used its ' . CHAT_TURNS_PER_TRIP . ' chat turns — the rest is yours to add by hand', 429);
    q('UPDATE trips SET chat_turns = chat_turns + 1 WHERE slug=?', [$sub]);

    require_once __DIR__ . '/lib/chat.php';
    $b        = body_json();
    $messages = chat_sanitize_history($b['messages'] ?? []);
    if (!$messages) err_out('nothing to answer', 400);
    $places   = is_array($b['places'] ?? null) ? $b['places'] : [];

    $listPins = fn($sl) => q_all('SELECT * FROM pins WHERE slug=? AND deleted=0', [$sl]);
    $addPin   = function ($sl, $pin) use ($t) {
      q('INSERT INTO pins (id,slug,kind,track,date,ts,lat,lng,title,lodging,notes,photo,spotify,path,fly,mode,here,seq,opened_by,claimed_team,claimed_by,author,updated)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        ['p' . rand_str(12), $sl, $pin['kind'] ?? 'stop', $pin['track'] ?? 'truck',
         $pin['date'] ?? null, null, $pin['lat'], $pin['lng'], $pin['title'] ?? '',
         $pin['lodging'] ?? '', $pin['notes'] ?? '', '', '', null,
         (int)($pin['fly'] ?? 0), $pin['mode'] ?? 'drive', 0, (int)($pin['seq'] ?? 0),
         '[]', '', '', $pin['author'] ?? '', $t]);
      return true;
    };

    try {
      $r = chat_run($sub, true, $messages, $places, $listPins, $addPin);
    } catch (Throwable $e) {
      err_out($e->getMessage(), 503);
    }
    json_out([
      'reply'        => $r['reply'],
      'messages'     => $r['messages'],
      'added'        => $r['added'],
      'needs_places' => $r['needs_places'],
      // D-093: so the client can warn before the cap rather than only at it
      'turns_left'   => max(0, CHAT_TURNS_PER_TRIP - ($used + 1)),
    ]);
  }

  if ($path === 'trip' && $method === 'DELETE') {
      if (!$isOwner) err_out('only the person who bought this trip can delete it', 403);
    delete_trip($sub);
    json_out(['ok' => true, 'gone' => true]);
  }

  err_out('not found', 404);
}
