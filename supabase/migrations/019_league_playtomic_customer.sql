-- ============================================================
-- Padel Power · league players become Playtomic customers
-- Applied live 2026-09-16 (migration league_playtomic_customer).
--
-- Adding a player to a Playtomic league does not make them a club
-- customer. league-enrol now makes sure each enrolled player is one,
-- with the name, email and mobile we hold, and records the outcome:
--   linked    customer exists for the player's own Playtomic account
--   mismatch  Playtomic created/matched a different account (usually a
--             different email); staff sort it out in Manager, never retried
--   error     the call failed; retried with a 6 hour back-off
-- Locks gain an owner so a late release cannot drop a newer worker's lock.
-- ============================================================

alter table public.league_registrations
  add column if not exists playtomic_customer_status text
    check (playtomic_customer_status in ('linked', 'mismatch', 'error')),
  add column if not exists playtomic_customer_user_id text,
  add column if not exists playtomic_customer_error text,
  add column if not exists playtomic_customer_at timestamptz,
  -- set just before a team is sent to Playtomic; the profile link is frozen from then on
  add column if not exists playtomic_enrolling_at timestamptz;

alter table public.job_locks add column if not exists owner uuid;

create or replace function public.job_claim_owned(p_name text, p_seconds integer, p_owner uuid)
returns boolean language sql security definer set search_path = public as $$
  with c as (
    insert into public.job_locks (name, locked_until, owner)
      values (p_name, now() + make_interval(secs => p_seconds), p_owner)
      on conflict (name) do update set locked_until = excluded.locked_until, owner = excluded.owner
        where public.job_locks.locked_until < now()
      returning 1)
  select exists (select 1 from c);
$$;
create or replace function public.job_release_owned(p_name text, p_owner uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.job_locks where name = p_name and owner = p_owner;
$$;
revoke execute on function public.job_claim_owned(text, integer, uuid) from public, anon, authenticated;
revoke execute on function public.job_release_owned(text, uuid) from public, anon, authenticated;
grant execute on function public.job_claim_owned(text, integer, uuid) to service_role;
grant execute on function public.job_release_owned(text, uuid) to service_role;

-- the only way a registration's Playtomic profile changes. One statement, so
-- it cannot race an enrolment or a customer result: refused once a team is
-- being or has been added; clears customer state made for the old profile
-- unless it is a mismatch staff still need to see.
create or replace function public.league_set_identity(p_reg uuid, p_player text, p_url text)
returns boolean language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  update league_registrations set
    playtomic_player_id = p_player,
    playtomic_url = p_url,
    playtomic_customer_status  = case when playtomic_customer_status = 'mismatch' then 'mismatch' end,
    playtomic_customer_user_id = case when playtomic_customer_status = 'mismatch' then playtomic_customer_user_id end,
    playtomic_customer_error   = case when playtomic_customer_status = 'mismatch' then playtomic_customer_error end,
    playtomic_customer_at      = case when playtomic_customer_status = 'mismatch' then playtomic_customer_at end
  where id = p_reg and playtomic_team_id is null and playtomic_enrolling_at is null;
  if found then return true; end if;
  select playtomic_player_id into cur from league_registrations where id = p_reg;
  return cur is not distinct from p_player;
end $$;
revoke execute on function public.league_set_identity(uuid, text, text) from public, anon, authenticated;
grant execute on function public.league_set_identity(uuid, text, text) to service_role;

-- staff fixed a duplicate or failed customer by hand in Manager
create or replace function public.league_mark_customer(p_reg uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not pp_is_admin() then raise exception 'forbidden'; end if;
  update league_registrations
     set playtomic_customer_status = 'linked', playtomic_customer_error = null, playtomic_customer_at = now()
   where id = p_reg;
  perform league_log(p_reg, 'playtomic_customer_resolved', '{}'::jsonb, auth.uid());
end $$;
revoke execute on function public.league_mark_customer(uuid) from public, anon;
grant execute on function public.league_mark_customer(uuid) to authenticated;
