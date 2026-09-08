-- ============================================================
-- Padel Power · instructors, staff roles, enquiry assignees
-- Run in the Supabase SQL editor (project: Padel Power).
--
-- What this does:
--   1. instructors table (name, contact, hourly rate) + RLS
--   2. staff_roles table (admin vs instructor) + pp_is_admin()
--   3. Admin-only writes on timetable / custom_classes /
--      cancelled_classes (drops the old authenticated write
--      policies on those three tables and recreates them
--      admin-only). Staff with no role row count as admin,
--      so nobody is locked out before roles are assigned.
--   4. enquiries: assignee + replies columns
--   5. Trigger: when a class is cancelled, POST the instructor's
--      details to the Make webhook (same pattern as the member
--      texts). PASTE THE REAL WEBHOOK URL before running.
-- ============================================================

-- 1 ▸ instructors
create table if not exists public.instructors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  email text,
  phone text,
  hourly_rate_pence integer not null default 4000,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2 ▸ staff roles
create table if not exists public.staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('admin','instructor')),
  instructor_id uuid references public.instructors(id)
);

-- Staff with no role row are treated as admin until roles are assigned.
create or replace function public.pp_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role = 'admin' from public.staff_roles where user_id = auth.uid()),
    auth.uid() is not null
  );
$$;

alter table public.instructors enable row level security;
alter table public.staff_roles enable row level security;

drop policy if exists "staff read instructors" on public.instructors;
create policy "staff read instructors" on public.instructors
  for select to authenticated using (true);
drop policy if exists "admin write instructors" on public.instructors;
create policy "admin write instructors" on public.instructors
  for all to authenticated using (public.pp_is_admin()) with check (public.pp_is_admin());

drop policy if exists "read own role" on public.staff_roles;
create policy "read own role" on public.staff_roles
  for select to authenticated using (user_id = auth.uid());

-- 3 ▸ only admins may add/remove/change classes.
-- Drops every non-select policy on the three class tables, then
-- recreates them admin-only. Select policies (public timetable
-- reads) are left untouched.
do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('timetable', 'custom_classes', 'cancelled_classes')
      and cmd <> 'SELECT'
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

create policy "admin write timetable" on public.timetable
  for all to authenticated using (public.pp_is_admin()) with check (public.pp_is_admin());
create policy "admin write custom_classes" on public.custom_classes
  for all to authenticated using (public.pp_is_admin()) with check (public.pp_is_admin());
create policy "admin write cancelled_classes" on public.cancelled_classes
  for all to authenticated using (public.pp_is_admin()) with check (public.pp_is_admin());

-- 4 ▸ enquiries: assignee (Grace / Joe) and dashboard replies
alter table public.enquiries add column if not exists assignee text;
alter table public.enquiries add column if not exists replies jsonb not null default '[]'::jsonb;

-- 5 ▸ notify the instructor when a class is cancelled.
-- Same pg_net + Make pattern as the member cancellation texts.
-- ⚠ Replace REPLACE_ME with the real Make webhook URL first.
create or replace function public.notify_instructor_cancelled() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text; v_email text; v_phone text;
begin
  select instructor into v_name from public.custom_classes
    where class_date = new.class_date and start_time = new.start_time;
  if v_name is null then
    select instructor into v_name from public.timetable
      where weekday = extract(dow from new.class_date)::int
        and start_time = new.start_time
      limit 1;
  end if;
  if v_name is null or v_name = '' then return new; end if;

  select email, phone into v_email, v_phone
    from public.instructors
    where lower(name) = lower(v_name) and active
    limit 1;

  perform net.http_post(
    url := 'https://hook.eu2.make.com/REPLACE_ME',
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object(
      'type', 'instructor_class_cancelled',
      'instructor', v_name,
      'email', v_email,
      'phone', v_phone,
      'class_date', new.class_date,
      'start_time', new.start_time,
      'reason', coalesce(new.reason, '')
    )
  );
  return new;
end $$;

drop trigger if exists trg_notify_instructor_cancelled on public.cancelled_classes;
create trigger trg_notify_instructor_cancelled
  after insert on public.cancelled_classes
  for each row execute function public.notify_instructor_cancelled();
