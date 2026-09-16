-- ============================================================
-- Padel Power · safe recovery for Playtomic enrolment
-- Applied live 2026-09-16 (migration league_enrol_recovery).
--
-- league_set_team saves a Playtomic team on every member in one statement,
-- so a doubles pair is never half-saved. A team add that got no answer from
-- Playtomic leaves the registration reserved and out of the automatic
-- sweep; once staff have checked Playtomic, league_retry_enrol releases it.
-- ============================================================

create or replace function public.league_set_team(p_regs uuid[], p_team text)
returns void language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update league_registrations
     set playtomic_team_id = p_team, playtomic_added_at = now(), playtomic_error = null
   where id = any(p_regs) and playtomic_team_id is null and playtomic_enrolling_at is not null;
  get diagnostics n = row_count;
  if n <> coalesce(array_length(p_regs, 1), 0) then raise exception 'team_not_saved'; end if;
end $$;
revoke execute on function public.league_set_team(uuid[], text) from public, anon, authenticated;
grant execute on function public.league_set_team(uuid[], text) to service_role;

-- staff checked Playtomic: the player is not in the league, try again
create or replace function public.league_retry_enrol(p_reg uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not pp_is_admin() then raise exception 'forbidden'; end if;
  update league_registrations
     set playtomic_enrolling_at = null, playtomic_error = null
   where id = p_reg and playtomic_team_id is null;
  perform league_log(p_reg, 'playtomic_retry', '{}'::jsonb, auth.uid());
end $$;
revoke execute on function public.league_retry_enrol(uuid) from public, anon;
grant execute on function public.league_retry_enrol(uuid) to authenticated;
