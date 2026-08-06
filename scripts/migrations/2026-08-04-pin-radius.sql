-- Custom geofences per easter egg (D-124). Peter, 2026-08-04: he wants a drop to open for
-- certain when the crew reaches a place, and 30 miles for everything is both too small for a
-- highway crossing and too big for a campsite.
--
-- NULL means "use the global default for this kind", so every existing pin keeps exactly the
-- behaviour it has today and nothing needs backfilling. Only a pin somebody deliberately tunes
-- carries a number.
--
-- Safe to re-run.
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'pins' AND column_name = 'radius_mi');
SET @s := IF(@c = 0, 'ALTER TABLE pins ADD COLUMN radius_mi SMALLINT NULL DEFAULT NULL', 'DO 0');
PREPARE stmt FROM @s;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
