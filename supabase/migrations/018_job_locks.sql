-- ============================================================
-- Padel Power · one sweep at a time
-- Applied live 2026-09-15 (migration job_locks).
--
-- The 15 minute league-enrol cron and a card-save nudge can overlap and
-- add the same team to Playtomic twice. A sweep claims a named lock for
-- up to two minutes and releases it when done; a second sweep that
-- cannot claim it skips.
-- ============================================================

create table if not exists public.job_locks (
  name text primary key,
  locked_until timestamptz not null
);
alter table public.job_locks enable row level security;
revoke all on public.job_locks from anon, authenticated;

create or replace function public.job_claim(p_name text, p_seconds integer default 120)
returns boolean language sql security definer set search_path = public as $$
  with c as (
    insert into public.job_locks (name, locked_until)
      values (p_name, now() + make_interval(secs => p_seconds))
      on conflict (name) do update set locked_until = excluded.locked_until
        where public.job_locks.locked_until < now()
      returning 1)
  select exists (select 1 from c);
$$;
create or replace function public.job_release(p_name text)
returns void language sql security definer set search_path = public as $$
  delete from public.job_locks where name = p_name;
$$;
revoke execute on function public.job_claim(text, integer) from public, anon, authenticated;
revoke execute on function public.job_release(text) from public, anon, authenticated;
grant execute on function public.job_claim(text, integer) to service_role;
grant execute on function public.job_release(text) to service_role;
