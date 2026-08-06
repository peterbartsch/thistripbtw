-- D-114: mark the in-house QA trips, so "never expires" is a decision instead of an accident.
--
-- Today every early trip has expires = NULL and the two real purchases have proper dates. That
-- looks like the right outcome and is not: nothing DECIDED it. The minted trips simply never had
-- an expiry set, and expiry_due() skips NULL, and expire-trips.php skips NULL, so they persist
-- by omission.
--
-- The same omission runs the other way, and that is the reason this column exists. If a customer
-- trip is ever created down a path that leaves expires NULL, it silently becomes permanent: no
-- notice is ever sent, it is never deleted, and we quietly hold someone's trip forever while
-- `make check-copy` gates the build on never claiming we would. Nothing catches that today.
--
-- A flag, NOT a fourth tier. `tier` drives real behaviour — photo and video permissions, the
-- media cap, the export, the pricing copy — and a value none of those know about falls through
-- every one of them unmapped. This says only WHY a trip does not expire, and changes nothing
-- about what it can do.
--
-- The value is that the invariant becomes checkable: every trip has an expiry UNLESS qa = 1.
-- smoke.sh asserts it, so the first customer trip that slips through with a NULL fails loudly.
--
-- Safe to re-run.
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'trips' AND column_name = 'qa');
SET @s := IF(@c = 0, 'ALTER TABLE trips ADD COLUMN qa TINYINT NOT NULL DEFAULT 0', 'DO 0');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Backfill: every trip that predates the expiry rule and has no end date is in-house. The two
-- real purchases carry dates and are untouched by the WHERE clause, so this cannot reclassify a
-- customer trip even if it is run again later.
UPDATE trips SET qa = 1 WHERE expires IS NULL AND qa = 0;
