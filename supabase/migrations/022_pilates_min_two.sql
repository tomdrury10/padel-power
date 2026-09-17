-- Pilates: minimum bookings for a class to run drops from 3 to 2.
--
-- The auto-cancel job and the booking rules both read settings.min_riders,
-- so this single update covers the live behaviour; assets/pilates-core.js
-- carries the matching fallback for the front end.

update public.settings set min_riders = 2 where id = 1;
