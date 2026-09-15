-- ============================================================
-- Padel Power · leagues mirrored from Playtomic
-- Applied live 2026-09-15 (migrations leagues_synced_from_playtomic +
-- league_upsert_loose_name_match).
--
-- The playtomic-sync function pulls the club's leagues from Playtomic
-- Manager every hour (cron playtomic-league-sync, minute 17) and upserts
-- them here by Playtomic id. New leagues arrive closed with no price;
-- staff open them from the Leagues page. Names and status follow
-- Playtomic; prices, dates and weeks are ours. The five seeded rows
-- adopt their Playtomic id by name, ignoring punctuation.
-- ============================================================

alter table public.leagues
  add column if not exists playtomic_league_id text unique,
  add column if not exists playtomic_status text,
  add column if not exists synced_at timestamptz;

create or replace function public.league_upsert_from_playtomic(
  p_playtomic_id text, p_name text, p_kind text, p_status text, p_url text)
returns uuid language plpgsql security definer set search_path = public as $$
declare lid uuid;
begin
  select id into lid from leagues where playtomic_league_id = p_playtomic_id;
  if lid is null then
    select id into lid from leagues
      where playtomic_league_id is null
        and regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(p_name), '[^a-z0-9]', '', 'g')
      limit 1;
  end if;
  if lid is null then
    insert into leagues (name, kind, playtomic_league_id, playtomic_status, playtomic_url, sort, synced_at)
      values (p_name, p_kind, p_playtomic_id, p_status, p_url, (select coalesce(max(sort), 0) + 1 from leagues), now())
      returning id into lid;
  else
    update leagues set name = p_name, playtomic_league_id = p_playtomic_id, playtomic_status = p_status,
      playtomic_url = coalesce(playtomic_url, p_url), synced_at = now()
      where id = lid;
  end if;
  return lid;
end $$;
revoke execute on function public.league_upsert_from_playtomic(text, text, text, text, text) from public, anon, authenticated;

create or replace function public.trigger_playtomic_sync() returns void
language plpgsql security definer set search_path = public, extensions, vault as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'pp_internal_key';
  perform net.http_post(
    url := 'https://bejshhlkatpjcydlokfk.supabase.co/functions/v1/playtomic-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pp-key', k),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
end $$;
revoke execute on function public.trigger_playtomic_sync() from public, anon, authenticated;
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'playtomic-league-sync') then
    perform cron.schedule('playtomic-league-sync', '17 * * * *', 'select public.trigger_playtomic_sync()');
  end if;
end $$;

-- (applied as league_upsert_with_start_date) the Playtomic start date
-- fills season_start when staff have not set one; kind follows
-- registration_info.players_per_team. The five hand-seeded rows were
-- deleted once real leagues had synced.
drop function if exists public.league_upsert_from_playtomic(text, text, text, text, text);
create or replace function public.league_upsert_from_playtomic(
  p_playtomic_id text, p_name text, p_kind text, p_status text, p_url text, p_start date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare lid uuid;
begin
  select id into lid from leagues where playtomic_league_id = p_playtomic_id;
  if lid is null then
    select id into lid from leagues
      where playtomic_league_id is null
        and regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(p_name), '[^a-z0-9]', '', 'g')
      limit 1;
  end if;
  if lid is null then
    insert into leagues (name, kind, playtomic_league_id, playtomic_status, playtomic_url, season_start, sort, synced_at)
      values (p_name, p_kind, p_playtomic_id, p_status, p_url, p_start, (select coalesce(max(sort), 0) + 1 from leagues), now())
      returning id into lid;
  else
    update leagues set name = p_name, kind = p_kind, playtomic_league_id = p_playtomic_id, playtomic_status = p_status,
      playtomic_url = coalesce(playtomic_url, p_url), season_start = coalesce(season_start, p_start), synced_at = now()
      where id = lid;
  end if;
  return lid;
end $$;
revoke execute on function public.league_upsert_from_playtomic(text, text, text, text, text, date) from public, anon, authenticated;
