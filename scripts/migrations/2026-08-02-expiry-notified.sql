-- D-098: one notice before a trip lapses, and never a second one.
--
-- NULL means never notified; otherwise the ms timestamp we sent at. A timestamp rather than a
-- flag because the first question anyone asks about a mail that did or did not arrive is WHEN,
-- and a TINYINT cannot answer it.
--
-- Idempotent the awkward way, same as D-093 and D-094: ADD COLUMN IF NOT EXISTS is MariaDB
-- syntax MySQL 8 rejects, so existence is checked against information_schema and the ALTER is
-- prepared only if needed. The no-op branch is DO 0, not SELECT 1 -- a stray result set makes
-- migrate.php fail on the NEXT statement, and a migration that errors on re-run is a trap.
-- Note for whoever writes the next one: migrate.php splits on semicolons without understanding
-- comments, so keep prose free of them.

SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'trips' AND column_name = 'expiry_notified');
SET @s := IF(@c = 0, 'ALTER TABLE trips ADD COLUMN expiry_notified BIGINT NULL', 'DO 0');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
