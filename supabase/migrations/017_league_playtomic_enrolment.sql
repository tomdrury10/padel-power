-- ============================================================
-- Padel Power · automatic Playtomic enrolment
-- Applied live 2026-09-15 (migration league_playtomic_enrolment).
--
-- A completed registration (card saved; for doubles both partners) is
-- posted into the Playtomic league as a team by the league-enrol
-- function, which records the team id here. Cancelling removes the team.
-- The function runs every 15 minutes and is also nudged the moment a
-- card is saved.
-- ============================================================

alter table public.league_registrations
  add column if not exists playtomic_team_id text,
  add column if not exists playtomic_error text;

create or replace function public.pp_internal_key() returns text
language sql stable security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'pp_internal_key';
$$;
revoke execute on function public.pp_internal_key() from public, anon, authenticated;
grant execute on function public.pp_internal_key() to service_role;

create or replace function public.trigger_league_enrol() returns void
language plpgsql security definer set search_path = public, extensions, vault as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'pp_internal_key';
  perform net.http_post(
    url := 'https://bejshhlkatpjcydlokfk.supabase.co/functions/v1/league-enrol',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-pp-key', k),
    body := '{"action":"sweep"}'::jsonb, timeout_milliseconds := 30000);
end $$;
revoke execute on function public.trigger_league_enrol() from public, anon, authenticated;

create or replace function public.league_reg_card_saved() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.card_status = 'authorised' and (old.card_status is distinct from 'authorised') then
    perform public.trigger_league_enrol();
  end if;
  return new;
end $$;
drop trigger if exists league_reg_card_saved on public.league_registrations;
create trigger league_reg_card_saved after update on public.league_registrations
  for each row execute function public.league_reg_card_saved();

do $$ begin
  if not exists (select 1 from cron.job where jobname = 'league-enrol') then
    perform cron.schedule('league-enrol', '*/15 * * * *', 'select public.trigger_league_enrol()');
  end if;
end $$;
