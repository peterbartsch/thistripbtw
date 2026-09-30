-- D-093: a per-trip cap on the paid chat.
--
-- NOTE FOR FUTURE MIGRATIONS: scripts/migrate.php splits on ";" without understanding comments,
-- so a semicolon anywhere in prose cuts the file into fragments. Use commas or full stops.
--
-- trip/chat was gated on edit access with six tool rounds per request and a GLOBAL monthly token
-- ceiling, and nothing in between. So one buyer of a $2.50 trip could consume the whole 5M-token
-- budget and turn the chat off for every other customer, silently, and nothing would report it.
-- CHAT_AGENT_SPEC asked for exactly this cap and it was never built.
--
-- A column on `trips` rather than a table of its own, for three reasons. It is one integer per
-- trip and nothing joins on it. `UPDATE trips SET chat_turns = chat_turns + 1` is atomic, so it
-- cannot lose increments the way the file counters did before D-091. And it is deleted with the
-- trip for free, so `make check-delete` has nothing new to enforce and delete_trip() needs no
-- edit -- which is precisely how account_trips was missed for three days.
--
-- Safe to re-run. `ADD COLUMN IF NOT EXISTS` is MariaDB syntax and MySQL 8 rejects it, so the
-- existence check is done against information_schema and the ALTER is prepared only if needed.
-- Each statement below is valid standalone, which is what migrate.php's split on ";" requires.
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'trips' AND column_name = 'chat_turns');
SET @s := IF(@c = 0, 'ALTER TABLE trips ADD COLUMN chat_turns INT NOT NULL DEFAULT 0', 'DO 0');   -- DO, not SELECT: a no-op SELECT leaves an unbuffered result set and migrate.php then fails on the NEXT statement, so a re-run errored even though it had nothing to do
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
