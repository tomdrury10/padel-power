-- ============================================================
-- Padel Power · soft play: supervised weekends, unsupervised weekdays
-- Joe, 18 Sept 2026:
--   weekends supervised 08:00-16:00, weekdays unsupervised 09:00-17:00
--   (parents stay in the room), 60 / 90 / 120 minute bookings, 2 hours max,
--   private parties and exclusive hire by email enquiry rather than online.
--
-- Two changes only:
--   1. a third session mode, 'unsupervised'. It is a SHARED room like a
--      supervised session (capacity applies, no minimum, no auto-cancel),
--      unlike 'hire', which stays exclusive and is now staff / enquiry only.
--   2. its own price, per child per hour. Supervised is now charged per child
--      per hour too, so 90 and 120 minute sessions scale, which is why the
--      supervised price is read as an hourly rate from here on.
--
-- enforce_softplay_rules and auto_cancel_softplay need no change: the
-- exclusivity rule already tests only for 'hire' and the minimum-children
-- rule already tests only for 'supervised'.
-- ============================================================

alter table public.softplay_sessions drop constraint if exists softplay_sessions_mode_check;
alter table public.softplay_sessions
  add constraint softplay_sessions_mode_check
  check (mode in ('supervised', 'unsupervised', 'hire'));

alter table public.settings
  add column if not exists softplay_unsupervised_price_pence integer not null default 500;

comment on column public.settings.softplay_supervised_price_pence is
  'Supervised soft play: price per child PER HOUR (a 90 minute session bills 1.5x). Null means supervised sessions cannot be sold.';
comment on column public.settings.softplay_unsupervised_price_pence is
  'Unsupervised soft play, parents stay in the room: price per child PER HOUR.';
comment on column public.settings.softplay_hire_price_pence is
  'Exclusive hire of the whole room, per child per hour. Parties and exclusive hire are handled by email enquiry, so this is for staff-entered bookings.';
