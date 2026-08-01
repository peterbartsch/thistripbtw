-- D-067: an account minted from a Stripe receipt has no password, because the person was
-- never shown a form to choose one. NULL is the honest value; acct_check() refuses to sign in
-- against it, and the mailed reset token is the way in.
--
-- Safe to re-run. Existing rows keep their hashes; only the constraint changes.
ALTER TABLE accounts MODIFY pass_hash VARCHAR(255) NULL;
