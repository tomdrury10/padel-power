-- ============================================================
--  Padel Power · Northampton Padel League — public standings
--  ------------------------------------------------------------
--  Populated nightly by a Make.com scenario that reads
--  GET https://manager.playtomic.io/api/v1/leagues/{league_id}
--  and flattens rounds[].groups[].team_classification[].
--
--  Only public-facing columns live here. The Playtomic payload
--  also contains user_ids, profile pictures, payment ids and
--  leaving_reason (e.g. EXPELLED_BY_MANAGER) — none of that
--  belongs in a table the anon key can read.
-- ============================================================

create table if not exists public.league_standings (
  league_id       uuid        not null,
  league_name     text        not null,
  round_id        uuid        not null,
  group_id        uuid        not null,
  group_number    int         not null,   -- display order, 1-based
  position        int         not null,   -- within the group, 1-based
  team_id         uuid        not null,
  team_name       text        not null,   -- "Alex Ramsden & Juan Suárez"
  avg_level       numeric(4,2),

  points          numeric(5,1) not null default 0,
  matches_played  int not null default 0,
  matches_won     int not null default 0,
  matches_tied    int not null default 0,
  matches_lost    int not null default 0,
  sets_won        int not null default 0,
  sets_lost       int not null default 0,
  sets_balance    int not null default 0,
  games_won       int not null default 0,
  games_lost      int not null default 0,
  games_balance   int not null default 0,

  updated_at      timestamptz not null default now(),

  primary key (league_id, group_id, team_id)
);

create index if not exists league_standings_display_idx
  on public.league_standings (league_id, group_number, position);

-- ---------- row level security ----------
alter table public.league_standings enable row level security;

-- Anyone (anon key, from the public site) may read.
drop policy if exists "league standings are public" on public.league_standings;
create policy "league standings are public"
  on public.league_standings
  for select
  to anon, authenticated
  using (true);

-- No insert/update/delete policy: writes require the service role
-- key, which lives only in the Make.com connection. Never ship
-- the service role key to the browser.

-- ---------- freshness ----------
-- The page shows "updated <x>" so a stale table is obvious rather
-- than quietly wrong. One row per league, written at the end of
-- each successful sync.
create table if not exists public.league_sync (
  league_id    uuid primary key,
  synced_at    timestamptz not null default now(),
  ok           boolean     not null default true,
  note         text
);

alter table public.league_sync enable row level security;

drop policy if exists "league sync is public" on public.league_sync;
create policy "league sync is public"
  on public.league_sync
  for select
  to anon, authenticated
  using (true);
