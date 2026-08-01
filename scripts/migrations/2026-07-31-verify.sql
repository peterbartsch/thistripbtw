-- D-076 step one: make `accounts.verified` mean something, and stop the mailer being a weapon.
--
-- NOTE FOR FUTURE MIGRATIONS: scripts/migrate.php splits on ";" without understanding comments,
-- so a semicolon anywhere in prose cuts the file into fragments and the comment-only pieces get
-- executed as SQL. Use commas or full stops.
--
-- ── 1. Backfill, and this one is not optional ────────────────────────────────────────────────
-- `verified` has existed since the accounts build and has been written as 0 and read NOWHERE,
-- exactly like account_trips.role before D-071. Step one of D-076 makes acct_check() refuse an
-- unverified account. Every account that exists today was minted from a Stripe receipt, so
-- without this line that change locks out every customer we have.
--
-- A receipt is stronger proof of an address than a click on a link we mailed. Stripe collected
-- it, charged a real card against it and sent a receipt to it. Marking these 1 is not a
-- convenience, it is the correct value.
UPDATE accounts SET verified = 1 WHERE verified = 0;

-- ── 2. A throttle on outbound mail, per address, per hour ────────────────────────────────────
-- Shaped exactly like `login_gate`, for the same reason: slow an abuser without ever letting
-- them lock a real person out.
--
-- Today /api/account/reset-request will mail an address every single time it is asked, with no
-- limit. That is survivable only because an account cannot exist without a Stripe payment, so
-- the set of mailable addresses is the set of people who paid us. D-076 removes that condition.
-- The moment anyone can sign up, an unauthenticated endpoint that mails an arbitrary address on
-- demand is a harassment tool pointed at strangers and a fast way to burn the domain's sending
-- reputation, which would take the password reset down with it.
--
-- Counting is by address and hour only. No IP, no user agent, nothing about a person. The row
-- says "this address was mailed N times this hour" and expires into irrelevance on its own.
-- Safe to re-run.
CREATE TABLE IF NOT EXISTS mail_gate (
  email VARCHAR(190) NOT NULL,
  win   BIGINT       NOT NULL,               -- hour bucket, intdiv(now_ms, 3600000)
  hits  INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (email, win)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
