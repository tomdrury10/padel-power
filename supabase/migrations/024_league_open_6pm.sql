-- ============================================================
-- Padel Power · leagues open at 6pm on the day
-- Joe, 18 Sept 2026: leagues should only appear on the register page once
-- they are live, and going live at 6pm suits the club better than midnight.
--
-- Registration still opens 21 days before the league starts, and returning
-- players still get their 5 day head start, but both now land at 18:00
-- Europe/London instead of 00:00. A staff 'opens at' override is an exact
-- timestamp and is used as given.
--
-- Hiding a league until it is live is done on the register page, which reads
-- these same windows, so the two always agree.
-- ============================================================

create or replace function public.league_windows(p_league uuid)
returns table (general_open timestamptz, early_open timestamptz, close_at timestamptz)
language sql stable security definer set search_path = public as $$
  select g, g - interval '5 days',
         coalesce(l.enrolment_end_at, (l.season_start::timestamp at time zone 'Europe/London'))
  from leagues l,
  lateral (select coalesce(
      l.opens_at,
      (((l.season_start - 21)::date + time '18:00') at time zone 'Europe/London')
    ) as g) x
  where l.id = p_league;
$$;
