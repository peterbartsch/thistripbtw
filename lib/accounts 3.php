<?php
/**
 * lib/accounts.php — email + password accounts (D-046, D-053).
 *
 * An account holds an email, a password hash, and a list of trips. That is the whole record:
 * no name, no profile, no behaviour, nothing a broker would want. It exists so a person can
 * find their trips again from another device, and so we can reach them when we must.
 *
 * D-053 knowingly reversed D-038's "never a trip reference", so `account_trips` is plaintext
 * and the server can read it. Everything else here is the hardening that trade obliges:
 *
 *   · the password is stored ONLY as password_hash() — bcrypt, never anything reversible
 *   · a session cookie is a random token; we store SHA-256 of it, the same rule D-016 sets
 *     for trip phrases, so a database dump yields no usable cookie
 *   · sign-in is rate-limited per email, and a wrong password costs the same time as an
 *     unknown address so the response cannot be used to enumerate who has an account
 */

declare(strict_types=1);

const SESSION_DAYS   = 60;
const LOGIN_MAX_FAIL = 12;    // per email per hour
const PASS_MIN       = 10;    // characters; length beats character-class theatre
const MAIL_MAX_HOUR  = 3;     // outbound mails per address per hour (D-076)

function acct_norm_email(string $e): string { return mb_strtolower(trim($e)); }

function acct_email_ok(string $e): bool {
    return $e !== '' && mb_strlen($e) <= 190 && (bool)filter_var($e, FILTER_VALIDATE_EMAIL);
}

/** Find an account by email, or null. */
function acct_by_email(string $email) {
    return q_first('SELECT * FROM accounts WHERE email=?', [acct_norm_email($email)]);
}

/**
 * Create an account. Returns the row, or null if the email is already taken.
 *
 * `$verified` says whether we have grounds to believe the person owns this address.
 * **It defaults to false on purpose.** Every caller that has grounds must say so out loud,
 * so that the day someone adds a new way to make an account, the safe value is the one they
 * get by forgetting. Today exactly two callers pass true, and both hold a paid Stripe session
 * whose email Stripe itself collected, charged and receipted — stronger proof than a click on
 * a link we mailed. A signup (D-076) passes nothing and the account stays unusable until a
 * mailed token is redeemed.
 */
function acct_create(string $email, ?string $password = null, bool $verified = false) {
    $email = acct_norm_email($email);
    if (!acct_email_ok($email)) return null;
    /* D-067: an account minted from a Stripe receipt has no password yet — the person never
       chose one, because they never saw a signup form. NULL is the honest value for that, and
       acct_check() refuses to sign in against it, so a password-less row is not a way in.
       The way in is the mailed reset token, which is the same machinery either way. */
    if ($password !== null && mb_strlen($password) < PASS_MIN) return null;
    if (acct_by_email($email)) return null;
    $id = 'a' . rand_str(12);
    q('INSERT INTO accounts (id,email,pass_hash,verified,created) VALUES (?,?,?,?,?)',
      [$id, $email, $password === null ? null : password_hash($password, PASSWORD_DEFAULT),
       $verified ? 1 : 0, now_ms()]);
    return q_first('SELECT * FROM accounts WHERE id=?', [$id]);
}

/** True if this account exists but has never had a password set (minted from a receipt). */
function acct_needs_password(array $a): bool {
    return ($a['pass_hash'] ?? null) === null || $a['pass_hash'] === '';
}

/** How many sign-ins for this email have failed in the current hour. */
function acct_fail_count(string $email): int {
    $r = q_first('SELECT hits FROM login_gate WHERE email=? AND win=?',
                 [acct_norm_email($email), intdiv(now_ms(), 3600000)]);
    return $r ? (int)$r['hits'] : 0;
}
function acct_fail_record(string $email): void {
    q('INSERT INTO login_gate (email,win,hits) VALUES (?,?,1) ON DUPLICATE KEY UPDATE hits=hits+1',
      [acct_norm_email($email), intdiv(now_ms(), 3600000)]);
}

/**
 * Check an email/password pair. Returns the account row or null.
 *
 * Runs password_verify() against a dummy hash when the address is unknown, so an unknown
 * email and a wrong password take the same time. Without that, response timing tells an
 * attacker which addresses have accounts — which is a privacy leak in a product whose whole
 * promise is that we hold almost nothing about you.
 *
 * D-076: an unverified account cannot sign in, whatever its password. In practice a fresh
 * signup also has no password, so `acct_needs_password()` would already refuse it — this is
 * the second lock, and it is here deliberately. The day someone adds a route that sets a
 * password without redeeming a mailed token, that route must not quietly become a way to
 * hold an account on an address you do not own.
 */
function acct_check(string $email, string $password) {
    static $dummy = null;
    if ($dummy === null) $dummy = password_hash('not-a-real-password', PASSWORD_DEFAULT);
    $a = acct_by_email($email);
    /* A password-less account (D-067) verifies against the dummy too, not against "". Both
       refuse, but "" refuses instantly while a real bcrypt compare does not — which would
       time-leak exactly which addresses have never set a password. */
    $hash = ($a && !acct_needs_password($a)) ? (string)$a['pass_hash'] : $dummy;
    $ok = password_verify($password, $hash);
    /* The verified test sits AFTER password_verify(), never as an early return, for the same
       timing reason as everything above it. */
    return ($a && !acct_needs_password($a) && (int)$a['verified'] === 1 && $ok) ? $a : null;
}

/* ── outbound mail throttle (D-076) ──────────────────────────────────────────────────────────
 * Both endpoints that mail somebody take the address from an unauthenticated request body.
 * That is safe today only because an account cannot exist without a Stripe payment. Open
 * signup removes that condition, at which point an unthrottled mailer is a harassment tool
 * aimed at strangers and a fast way to burn the domain's sending reputation — which would
 * take the password reset down with it.
 *
 * Counted by address and hour, nothing else. No IP, no user agent, nothing about a person.
 * The caller must still answer identically whether or not it sent: a "slow down" that only
 * appears for real addresses is the same enumeration oracle D-056 went to trouble to avoid.
 */
function acct_mail_allowed(string $email): bool {
    $r = q_first('SELECT hits FROM mail_gate WHERE email=? AND win=?',
                 [acct_norm_email($email), intdiv(now_ms(), 3600000)]);
    return ($r ? (int)$r['hits'] : 0) < MAIL_MAX_HOUR;
}
function acct_mail_record(string $email): void {
    q('INSERT INTO mail_gate (email,win,hits) VALUES (?,?,1) ON DUPLICATE KEY UPDATE hits=hits+1',
      [acct_norm_email($email), intdiv(now_ms(), 3600000)]);
}

/** Mint a session. Returns the raw token for the cookie; only its hash is stored. */
function acct_session_start(string $accountId): string {
    $token = rand_str(48);
    q('INSERT INTO sessions (id,account_id,created,expires) VALUES (?,?,?,?)',
      [hash('sha256', $token), $accountId, now_ms(), now_ms() + SESSION_DAYS * 86400000]);
    q('UPDATE accounts SET last_seen=? WHERE id=?', [now_ms(), $accountId]);
    return $token;
}

/** The account behind a session token, or null. Expired rows are swept as they are met. */
function acct_from_token(?string $token) {
    if (!$token) return null;
    $id = hash('sha256', $token);
    $s = q_first('SELECT * FROM sessions WHERE id=?', [$id]);
    if (!$s) return null;
    if ((int)$s['expires'] < now_ms()) { q('DELETE FROM sessions WHERE id=?', [$id]); return null; }
    return q_first('SELECT * FROM accounts WHERE id=?', [$s['account_id']]);
}

function acct_session_end(?string $token): void {
    if ($token) q('DELETE FROM sessions WHERE id=?', [hash('sha256', $token)]);
}

/** Attach a trip to an account. `owner` bought it; `member` holds a personal link (D-047). */
function acct_attach_trip(string $accountId, string $slug, string $role = 'owner'): void {
    q('INSERT INTO account_trips (account_id,slug,role,added) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE role=VALUES(role)',
      [$accountId, $slug, $role === 'member' ? 'member' : 'owner', now_ms()]);
}

/**
 * The trips on an account, newest first. Expired and deleted trips fall out because the join
 * is against `trips` — a sweep that removes the trip removes it from every list at once.
 */
function acct_trips(string $accountId): array {
    return q_all(
        'SELECT t.slug, t.name, t.tier, t.expires, at.role, at.added
           FROM account_trips at JOIN trips t ON t.slug = at.slug
          WHERE at.account_id = ?
          ORDER BY at.added DESC', [$accountId]);
}

/**
 * A trip's own SHAPE, for drawing it small (§2bk).
 *
 * `go.remap.earth` draws each route as a ~60px silhouette of its real geometry, so you tell rides
 * apart before reading a word. A trip already HAS a shape and nothing drew it — the account list
 * was text links, and every trip's `og:image` is one static file.
 *
 * WHAT THIS DOES AND DOES NOT EXPOSE. It returns at most 24 points, normalised into a unit box and
 * rounded to whole units of 1/1000 — so it carries the trip's SHAPE and not its position: the
 * bounding box is discarded, and a route in Utah and the same route in Spain produce identical
 * output. That matters because this rides on `account/me`, and an account already has full access
 * to every trip in the list (D-071) — but "already allowed" is not a reason to send more than the
 * job needs.
 *
 * `cos(latitude)` OR NORTH-SOUTH TRIPS COME OUT SQUASHED. A degree of longitude is narrower than a
 * degree of latitude everywhere but the equator, so fitting raw degrees into a square stretches
 * the east-west axis. Same term `milesBetween()` and `wayArrows()` already carry.
 *
 * ONE QUERY, not one per trip: an account with twenty trips would otherwise make twenty round
 * trips to draw twenty thumbnails.
 */
function acct_trip_shapes(array $slugs): array {
    $slugs = array_values(array_unique(array_filter($slugs, 'strlen')));
    if (!$slugs) return [];
    $in   = implode(',', array_fill(0, count($slugs), '?'));
    $rows = q_all(
        "SELECT slug, lat, lng FROM pins
          WHERE kind = 'stop' AND slug IN ($in)
          ORDER BY slug, COALESCE(date,''), seq, id", $slugs);

    $by = [];
    foreach ($rows as $r) $by[$r['slug']][] = [(float)$r['lat'], (float)$r['lng']];

    $out = [];
    foreach ($by as $slug => $pts) {
        if (count($pts) < 2) continue;              // a single stop has no shape to draw
        // thin to at most 24, keeping the first and last
        $max = 24;
        if (count($pts) > $max) {
            $step = (count($pts) - 1) / ($max - 1);
            $thin = [];
            for ($i = 0; $i < $max; $i++) $thin[] = $pts[(int)round($i * $step)];
            $pts = $thin;
        }
        $lats = array_column($pts, 0);
        $k    = cos(deg2rad((min($lats) + max($lats)) / 2));
        $xs   = array_map(fn($p) => $p[1] * $k, $pts);
        $ys   = array_map(fn($p) => -$p[0], $pts);      // screen y is inverted: north is up
        $x0 = min($xs); $x1 = max($xs); $y0 = min($ys); $y1 = max($ys);
        $span = max($x1 - $x0, $y1 - $y0);
        if ($span <= 0) continue;                       // every stop on one coordinate
        // centre the shorter axis so the silhouette is not shoved into a corner
        $padX = ($span - ($x1 - $x0)) / 2;
        $padY = ($span - ($y1 - $y0)) / 2;
        $shape = [];
        foreach ($pts as $i => $_) {
            $shape[] = [(int)round((($xs[$i] - $x0 + $padX) / $span) * 1000),
                        (int)round((($ys[$i] - $y0 + $padY) / $span) * 1000)];
        }
        $out[$slug] = $shape;
    }
    return $out;
}

/** The session cookie. HttpOnly so script cannot read it; SameSite=Lax so a cross-site POST cannot use it. */
function acct_cookie_set(string $token): void {
    setcookie('ttb_s', $token, [
        'expires'  => time() + SESSION_DAYS * 86400,
        'path'     => '/',
        'secure'   => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}
function acct_cookie_clear(): void {
    setcookie('ttb_s', '', ['expires' => time() - 3600, 'path' => '/', 'secure' => true,
                            'httponly' => true, 'samesite' => 'Lax']);
}
function acct_current() { return acct_from_token($_COOKIE['ttb_s'] ?? null); }

/* ── password reset (D-056) ─────────────────────────────────────────────────────────────
 * The token is random and only its SHA-256 is stored — the same rule as sessions and trip
 * phrases (D-016), so a database dump yields nothing anyone can redeem.
 *
 * The request endpoint answers identically whether or not the address has an account. That
 * is not politeness: a reset form that says "no such account" is an oracle for who has one,
 * which in a product that promises to hold almost nothing about you is a real leak.
 */

const RESET_MINUTES = 60;

function acct_reset_start(string $accountId): string {
    // One live token at a time in practice: burn the older ones so an old mail cannot be
    // used after a newer request, which is what someone forwarding a mail would expect.
    q('UPDATE resets SET used=1 WHERE account_id=? AND used=0', [$accountId]);
    $token = rand_str(48);
    q('INSERT INTO resets (id,account_id,created,expires) VALUES (?,?,?,?)',
      [hash('sha256', $token), $accountId, now_ms(), now_ms() + RESET_MINUTES * 60000]);
    return $token;
}

/** The account a reset token belongs to, or null if it is unknown, spent, or stale. */
function acct_reset_check(?string $token) {
    if (!$token) return null;
    $r = q_first('SELECT * FROM resets WHERE id=? AND used=0', [hash('sha256', $token)]);
    if (!$r || (int)$r['expires'] < now_ms()) return null;
    return q_first('SELECT * FROM accounts WHERE id=?', [$r['account_id']]);
}

/**
 * Spend the token and set the new password. Every existing session is destroyed: if the reset
 * happened because someone else had the account, leaving their cookie alive would make the
 * whole exercise decorative.
 */
function acct_reset_finish(string $token, string $password): bool {
    if (mb_strlen($password) < PASS_MIN) return false;
    $a = acct_reset_check($token);
    if (!$a) return false;
    q('UPDATE resets SET used=1 WHERE id=?', [hash('sha256', $token)]);
    /* D-076: redeeming this token IS the verification. The token was random, only its hash was
       stored, and it went to one place — that address. Someone holding it controls the mailbox,
       which is the whole question `verified` asks. So one flow serves both a reset and a first
       sign-up, and there is no second token type to build, expire, mail or get wrong. */
    q('UPDATE accounts SET pass_hash=?, verified=1 WHERE id=?',
      [password_hash($password, PASSWORD_DEFAULT), $a['id']]);
    q('DELETE FROM sessions WHERE account_id=?', [$a['id']]);
    // A successful reset also clears the failed-sign-in counter for that address, so someone
    // who locked themselves out by guessing is not locked out again straight afterwards.
    q('DELETE FROM login_gate WHERE email=?', [$a['email']]);
    return true;
}
