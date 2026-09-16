-- ============================================================
-- Padel Power · league registration windows (Joe, 16 Sept 2026)
-- Applied live 2026-09-16 (migration league_windows).
--
-- Registration follows the Playtomic league dates by itself:
--   returning players   from 26 days before the start
--   everyone            from 21 days before the start
--   closes              at Playtomic's enrolment end (or the start)
--   full                when active Playtomic teams plus our paid-up
--                       registrations reach groups x teams per group;
--                       reopens by itself if a space frees up
-- Staff can override per league: auto (the dates), open, closed.
-- registration_open is kept for history but no longer read.
-- ============================================================

alter table public.leagues
  add column if not exists registration_mode text not null default 'auto'
    check (registration_mode in ('auto', 'open', 'closed')),
  add column if not exists enrolment_end_at timestamptz,
  add column if not exists capacity_teams integer check (capacity_teams is null or capacity_teams > 0),
  add column if not exists playtomic_team_ids text[],
  add column if not exists teams_fetched_at timestamptz,
  add column if not exists opens_at timestamptz;
comment on column public.leagues.registration_open is 'deprecated: replaced by registration_mode (021)';

update public.leagues set registration_mode = case
  when name ilike '%test%' then 'closed'
  when registration_open then 'open'
  else 'auto' end;

-- players with an active team in a recent Padel Power league (ids only).
-- Rebuilt in full by every successful sync; expires 4 months after that league ends.
create table if not exists public.league_returning_players (
  player_id text primary key,
  last_league_id text,
  expires_at timestamptz not null
);
alter table public.league_returning_players enable row level security;
revoke all on public.league_returning_players from anon, authenticated;

create or replace function public.league_replace_returning(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from league_returning_players where true;
  insert into league_returning_players (player_id, last_league_id, expires_at)
  select distinct on (r->>'player_id') r->>'player_id', r->>'league_id', (r->>'expires_at')::timestamptz
    from jsonb_array_elements(p_rows) r
   where coalesce(r->>'player_id', '') <> ''
   order by r->>'player_id', (r->>'expires_at')::timestamptz desc;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.league_replace_returning(jsonb) from public, anon, authenticated;
grant execute on function public.league_replace_returning(jsonb) to service_role;

create or replace function public.league_is_returning(p_player text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from league_returning_players where player_id = p_player and expires_at > now());
$$;
revoke execute on function public.league_is_returning(text) from public, anon, authenticated;
grant execute on function public.league_is_returning(text) to service_role;

-- the three moments that matter, worked out in one place
create or replace function public.league_windows(p_league uuid)
returns table (general_open timestamptz, early_open timestamptz, close_at timestamptz)
language sql stable security definer set search_path = public as $$
  select g, g - interval '5 days',
         coalesce(l.enrolment_end_at, (l.season_start::timestamp at time zone 'Europe/London'))
  from leagues l,
  lateral (select coalesce(l.opens_at, (l.season_start::timestamp at time zone 'Europe/London') - interval '21 days') as g) x
  where l.id = p_league;
$$;

-- teams already spoken for: active in Playtomic at the last sync, plus teams
-- we added after that listing was requested and it did not include, plus our paid-up registrations not yet sent
-- (a doubles pair or a lone doubles player counts once)
create or replace function public.league_taken(p_league uuid)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(cardinality(l.playtomic_team_ids), 0)
       + (select count(distinct r.playtomic_team_id)::int
            from league_registrations r
           where r.league_id = l.id and r.cancelled_at is null and r.playtomic_team_id is not null
             and not (r.playtomic_team_id = any(coalesce(l.playtomic_team_ids, '{}')))
             and (l.teams_fetched_at is null or r.playtomic_added_at > l.teams_fetched_at))
       + (select count(distinct coalesce(r.pair_id::text, r.id::text))::int
            from league_registrations r
           where r.league_id = l.id and r.cancelled_at is null
             and r.card_status = 'authorised' and r.playtomic_team_id is null
             and r.playtomic_added_at is null)  -- staff-added teams are counted by the snapshot
  from leagues l where l.id = p_league;
$$;

create or replace function public.league_state(p_league uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare l leagues; w record;
begin
  select * into l from leagues where id = p_league;
  if l.id is null then return 'closed'; end if;
  if l.member_price_pence is null or l.nonmember_price_pence is null or l.season_start is null or l.weeks is null
     or l.playtomic_status = 'GONE' or l.registration_mode = 'closed' then
    return 'closed';
  end if;
  if l.registration_mode = 'open' then return 'open'; end if;
  select * into w from league_windows(p_league);
  if now() >= w.close_at then return 'closed'; end if;
  if now() < w.early_open then return 'not_yet'; end if;
  if l.capacity_teams is not null and league_taken(p_league) >= l.capacity_teams then return 'full'; end if;
  if now() < w.general_open then return 'early'; end if;
  return 'open';
end $$;

-- may this request go ahead? open, or full but only finishing a team that is
-- already counted (the partner of a paid-up player who is waiting for them)
create or replace function public.league_admits(p_league uuid, p_reg uuid default null, p_partner_code text default null)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare st text := league_state(p_league); r league_registrations;
begin
  if st = 'open' then return true; end if;
  if st <> 'full' then return false; end if;
  if p_partner_code is not null and exists (
       select 1 from league_registrations o
        where o.partner_code = p_partner_code and o.league_id = p_league and o.cancelled_at is null
          and o.card_status = 'authorised' and o.pair_id is null and o.playtomic_team_id is null and o.playtomic_added_at is null
          and (p_reg is null or o.id <> p_reg)) then
    return true;
  end if;
  if p_reg is not null then
    select * into r from league_registrations where id = p_reg;
    if r.pair_id is not null and exists (
         select 1 from league_registrations o
          where o.pair_id = r.pair_id and o.id <> r.id and o.cancelled_at is null
            and o.card_status = 'authorised' and o.playtomic_team_id is null and o.playtomic_added_at is null) then
      return true;
    end if;
  end if;
  return false;
end $$;
revoke execute on function public.league_admits(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.league_admits(uuid, uuid, text) to service_role;

-- everything the public page needs for every league in one call
create or replace function public.league_public_states()
returns table (id uuid, state text, general_open timestamptz, early_open timestamptz, close_at timestamptz, taken integer, capacity integer)
language sql stable security definer set search_path = public as $$
  select l.id, league_state(l.id), w.general_open, w.early_open, w.close_at,
         league_taken(l.id), l.capacity_teams
  from leagues l, lateral league_windows(l.id) w;
$$;

revoke execute on function public.league_windows(uuid) from public;
revoke execute on function public.league_taken(uuid) from public;
revoke execute on function public.league_state(uuid) from public;
revoke execute on function public.league_public_states() from public;
grant execute on function public.league_windows(uuid) to anon, authenticated, service_role;
grant execute on function public.league_taken(uuid) to anon, authenticated, service_role;
grant execute on function public.league_state(uuid) to anon, authenticated, service_role;
grant execute on function public.league_public_states() to anon, authenticated, service_role;

-- Playtomic owns the start date until billing is scheduled for anyone
drop function if exists public.league_upsert_from_playtomic(text, text, text, text, text, date);
create or replace function public.league_upsert_from_playtomic(
  p_playtomic_id text, p_name text, p_kind text, p_status text, p_url text,
  p_start date default null, p_enrol_end timestamptz default null,
  p_capacity integer default null, p_team_ids text[] default null, p_fetched_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare lid uuid; cur date; billed boolean;
begin
  select id into lid from leagues where playtomic_league_id = p_playtomic_id;
  if lid is null then
    select id into lid from leagues
      where playtomic_league_id is null
        and regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(p_name), '[^a-z0-9]', '', 'g')
      limit 1;
  end if;
  if lid is null then
    insert into leagues (name, kind, playtomic_league_id, playtomic_status, playtomic_url, season_start,
                         enrolment_end_at, capacity_teams, playtomic_team_ids, teams_fetched_at, sort, synced_at)
      values (p_name, p_kind, p_playtomic_id, p_status, p_url, p_start, p_enrol_end,
              nullif(p_capacity, 0), p_team_ids, p_fetched_at, (select coalesce(max(sort), 0) + 1 from leagues), now())
      returning id into lid;
    return jsonb_build_object('id', lid, 'start_kept', false);
  end if;
  select season_start into cur from leagues where id = lid;
  select exists (select 1 from league_registrations where league_id = lid and stripe_subscription_id is not null) into billed;
  update leagues set name = p_name, kind = p_kind, playtomic_league_id = p_playtomic_id, playtomic_status = p_status,
    playtomic_url = coalesce(playtomic_url, p_url),
    season_start = case when billed then coalesce(season_start, p_start) else coalesce(p_start, season_start) end,
    enrolment_end_at = coalesce(p_enrol_end, enrolment_end_at),
    capacity_teams = coalesce(nullif(p_capacity, 0), capacity_teams),
    -- a snapshot only replaces an older one
    playtomic_team_ids = case when p_team_ids is not null and p_fetched_at is not null
                               and (teams_fetched_at is null or p_fetched_at > teams_fetched_at)
                              then p_team_ids else playtomic_team_ids end,
    teams_fetched_at   = case when p_team_ids is not null and p_fetched_at is not null
                               and (teams_fetched_at is null or p_fetched_at > teams_fetched_at)
                              then p_fetched_at else teams_fetched_at end,
    synced_at = now()
    where id = lid;
  return jsonb_build_object('id', lid, 'start_kept', billed and p_start is not null and cur is distinct from p_start);
end $$;
revoke execute on function public.league_upsert_from_playtomic(text, text, text, text, text, date, timestamptz, integer, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.league_upsert_from_playtomic(text, text, text, text, text, date, timestamptz, integer, text[], timestamptz) to service_role;

-- ---------------- league texts ----------------
-- queued with the change itself (pg_net writes its queue in this transaction)
create or replace function public._notify_league_reg() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare l leagues; ev text; body jsonb;
begin
  if new.stripe_subscription_id is not null and old.stripe_subscription_id is null and new.cancelled_at is null then
    ev := 'league_registered';
  elsif new.cancelled_at is not null and old.cancelled_at is null then
    ev := 'league_cancelled';
  else
    return new;
  end if;
  select * into l from leagues where id = new.league_id;
  body := jsonb_build_object(
    'event', ev,
    'registration_id', new.id,
    'first_name', split_part(new.name, ' ', 1),
    'full_name', new.name,
    'email', new.email,
    'phone', new.phone,
    'phone_e164', replace(new.phone, ' ', ''),
    'league', l.name,
    'league_kind', l.kind);
  if ev = 'league_registered' then
    body := body || jsonb_build_object(
      'weekly_price', to_char(new.weekly_price_pence / 100.0, 'FM999990.00'),
      'weeks', l.weeks,
      'first_payment_pretty', case when l.season_start > (now() at time zone 'Europe/London')::date
                                   then trim(to_char(l.season_start, 'FMDay FMDD FMMonth')) else 'today' end,
      'partner_needed', l.kind = 'doubles' and new.pair_id is null,
      'share_url', 'https://www.padelpower.uk/northampton-padel-league/register/?partner=' || new.partner_code);
  end if;
  -- a text must never stop the registration change itself
  begin
    if public.pp_make_hook() is not null then
      perform net.http_post(url := public.pp_make_hook(),
        headers := jsonb_build_object('Content-Type', 'application/json'), body := body);
    end if;
  exception when others then
    raise warning 'league text not queued: %', sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public._notify_league_reg() from public, anon, authenticated;
drop trigger if exists league_reg_notify on public.league_registrations;
create trigger league_reg_notify after update of stripe_subscription_id, cancelled_at on public.league_registrations
  for each row execute function public._notify_league_reg();

-- (inspection fix, applied as league_windows_fixes) the partner a request would
-- pair with: by partner code, or the other member of an existing pair
create or replace function public.league_partner_player(p_league uuid, p_reg uuid default null, p_partner_code text default null)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select o.playtomic_player_id from league_registrations o
      where p_partner_code is not null and o.partner_code = p_partner_code
        and o.league_id = p_league and o.cancelled_at is null limit 1),
    (select o.playtomic_player_id from league_registrations r
       join league_registrations o on o.pair_id = r.pair_id and o.id <> r.id and o.cancelled_at is null
      where p_reg is not null and r.id = p_reg limit 1));
$$;
revoke execute on function public.league_partner_player(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.league_partner_player(uuid, uuid, text) to service_role;

-- (inspection fix, applied as league_start_owned_by_sync) a Playtomic-linked
-- league's start date only changes through the sync, never from a stale form
create or replace function public.league_keep_synced_start() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.playtomic_league_id is not null and new.season_start is distinct from old.season_start
     and coalesce(auth.role(), '') <> 'service_role' then
    new.season_start := old.season_start;
  end if;
  return new;
end $$;
drop trigger if exists league_keep_synced_start on public.leagues;
create trigger league_keep_synced_start before update of season_start on public.leagues
  for each row execute function public.league_keep_synced_start();
