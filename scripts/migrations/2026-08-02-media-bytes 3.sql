-- D-094: an aggregate media cap per trip.
--
-- NOTE FOR FUTURE MIGRATIONS: migrate.php splits on ";" without understanding comments, so a
-- semicolon in prose cuts the file into fragments. Use commas or full stops. And the no-op branch
-- below is DO 0, not SELECT 1: a stray result set makes migrate.php fail on the NEXT statement,
-- which is how the D-093 migration errored on re-run.
--
-- Per-file caps existed (8 MB image, 200 MB video) and nothing capped the TOTAL. A works-tier
-- buyer pays $10 once and could upload video without limit, forever, onto a VPS with finite disk.
-- Same shape as the chat cap in D-093 - a paid tier with a per-request limit and no ceiling -
-- except storage does not reset monthly, so doing nothing gets more expensive with time.
--
-- A column on `trips` for the same three reasons as chat_turns: one integer nothing joins on,
-- atomic to increment, and deleted with the trip so delete_trip() needs no edit.
--
-- Safe to re-run.
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'trips' AND column_name = 'media_bytes');
SET @s := IF(@c = 0, 'ALTER TABLE trips ADD COLUMN media_bytes BIGINT NOT NULL DEFAULT 0', 'DO 0');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
