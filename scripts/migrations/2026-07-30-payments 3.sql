-- D-073: a durable record that a payment happened, independent of the browser.
--
-- NOTE FOR FUTURE MIGRATIONS: scripts/migrate.php splits on ";" without understanding comments,
-- so a semicolon anywhere in a comment cuts the file into fragments and the comment-only pieces
-- get executed as SQL. The first draft of this file used semicolons in prose and failed with a
-- syntax error that pointed at line 2 rather than at the real cause. Use commas or full stops.
--
-- Until now /api/claim was the ONLY thing that knew a purchase existed, and it fires from the
-- buyer's browser on return from Stripe. A dropped redirect, a dead phone or an in-app browser
-- eating the return meant Stripe had the money and we had no record at all, with nothing to
-- reconcile against and nothing to alert anyone (DEEP_AUDIT B1).
--
-- Written by the Stripe webhook, which fires server to server and does not care whether the
-- browser ever came back. It deliberately does NOT mint the trip. The phrases are generated
-- inside claim and shown exactly once, so a webhook that minted first would hand the BUYER the
-- 409 "the passwords were shown once and cannot be recovered", locking them out of every trip
-- they bought. Recording is safe. Minting is not, until sign-in can open a trip (D-071).
--
-- Safe to re-run.
CREATE TABLE IF NOT EXISTS payments (
  session_id  VARCHAR(120) PRIMARY KEY,          -- Stripe checkout session, one payment per row
  email       VARCHAR(190) NOT NULL DEFAULT '',
  amount      INT          NOT NULL DEFAULT 0,   -- cents, as Stripe reports it
  tier        VARCHAR(8)   NOT NULL DEFAULT '',  -- inferred where the amount is recognised
  slug        VARCHAR(16)  NULL,                 -- filled in once a trip is claimed for it
  created     BIGINT       NOT NULL,
  KEY payments_slug (slug),
  KEY payments_created (created)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
