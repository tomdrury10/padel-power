-- ============================================================
-- Padel Power · member accounts + class credit packs
-- Applied to the Padel Power project on 2026-09-09 via MCP.
-- Safe to run more than once.
--
-- What this does
--   1. Every existing auth user gets an explicit staff_roles row
--      (admin), then the role default flips: NO ROW = MEMBER.
--      pp_is_admin() is now strict; pp_is_staff() / pp_role() added.
--      The migration refuses to run if any current user would be
--      left without a role row.
--   2. Every "authenticated = staff" policy is re-pointed at
--      pp_is_staff(), because members are authenticated too.
--      Members can read only their own bookings / packs / waiver.
--   3. profiles (name + phone per account), auto-created on signup
--      from the signup metadata. Old bookings with the same email
--      are linked to the new account.
--   4. credit_packs: a block of classes bought up front. Settings
--      gains pack_credits / pack_price_pence / pack_expiry_months.
--   5. bookings gains user_id, paid_with ('card' | 'credit'),
--      credit_pack_id, credit_returned_at. Cancelling a credit
--      booking (by the member, staff, a class cancellation or the
--      auto-cancel job) hands the credit back automatically.
--   6. book_with_credit(class_id): spends one credit from the
--      earliest-expiring valid pack, inside a lock.
--   7. Booking rules: guests can no longer book (account_required).
--      A member booking is stamped with their account's user_id and
--      email server-side, so nobody can book as someone else.
--   8. Lock-down: move_class_* require admin inside the function;
--      the cron helpers can no longer be called over the API;
--      members can only INSERT the plain booking columns.
--   9. booking_counts view runs as definer so the public count
--      works without a public read policy on bookings.
-- ============================================================

-- 1 ▸ roles -------------------------------------------------------
insert into public.staff_roles (user_id, role)
select id, 'admin' from auth.users
where lower(email) in ('tom@getjuno.uk', 'joe@padelpower.uk', 'info@padelpower.uk', 'grace@padelpower.uk')
on conflict (user_id) do nothing;

-- refuse to flip the default while any existing user has no role row
do $$
declare n int;
begin
  select count(*) into n from auth.users u
    left join public.staff_roles r on r.user_id = u.id
    where r.user_id is null;
  if n > 0 then
    raise exception 'unassigned_staff: % auth user(s) have no staff_roles row. Add them before running this migration.', n;
  end if;
end $$;

create or replace function public.pp_role() returns text
language sql stable security definer set search_path = public as $$
  select case
    when auth.role() = 'service_role' then 'service'
    when auth.uid() is null then 'anon'
    else coalesce((select role from public.staff_roles where user_id = auth.uid()), 'member')
  end;
$$;

create or replace function public.pp_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.staff_roles where user_id = auth.uid()), false);
$$;

create or replace function public.pp_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff_roles where user_id = auth.uid());
$$;

grant execute on function public.pp_role(), public.pp_is_admin(), public.pp_is_staff() to anon, authenticated;

-- nobody but the SQL editor writes roles
revoke insert, update, delete, truncate, references, trigger on public.staff_roles from anon, authenticated;

-- 2 ▸ settings: pack config ----------------------------------------
alter table public.settings add column if not exists pack_credits integer not null default 6
  check (pack_credits between 1 and 50);
alter table public.settings add column if not exists pack_price_pence integer not null default 10000
  check (pack_price_pence between 100 and 100000);
alter table public.settings add column if not exists pack_expiry_months integer not null default 3
  check (pack_expiry_months between 1 and 24);

-- 3 ▸ profiles -----------------------------------------------------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (full_name is null or char_length(full_name) between 1 and 80),
  phone text check (phone is null or char_length(phone) between 5 and 25),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select to authenticated using (user_id = auth.uid() or public.pp_is_staff());
drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (user_id, full_name, phone) on public.profiles to authenticated;
grant update (full_name, phone, updated_at) on public.profiles to authenticated;

-- profile from signup metadata, and claim earlier bookings made with the same email
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, full_name, phone)
  values (
    new.id,
    nullif(left(btrim(coalesce(new.raw_user_meta_data->>'full_name', '')), 80), ''),
    nullif(left(btrim(coalesce(new.raw_user_meta_data->>'phone', '')), 25), '')
  )
  on conflict (user_id) do nothing;
  update public.bookings set user_id = new.id
    where user_id is null and lower(email) = lower(new.email);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- profiles for the staff who already exist
insert into public.profiles (user_id) select id from auth.users on conflict do nothing;

-- 4 ▸ credit packs -------------------------------------------------
create table if not exists public.credit_packs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  credits_total integer not null check (credits_total between 1 and 100),
  credits_left integer not null check (credits_left between 0 and 100),
  amount_pence integer,
  stripe_session_id text,
  payment_intent_id text,
  purchased_at timestamptz not null default now(),
  expires_at timestamptz not null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists credit_packs_session_uidx
  on public.credit_packs (stripe_session_id) where stripe_session_id is not null;
create index if not exists credit_packs_user_idx on public.credit_packs (user_id);
alter table public.credit_packs enable row level security;

drop policy if exists "read own packs" on public.credit_packs;
create policy "read own packs" on public.credit_packs
  for select to authenticated using (user_id = auth.uid() or public.pp_is_staff());
drop policy if exists "admin grant packs" on public.credit_packs;
create policy "admin grant packs" on public.credit_packs
  for insert to authenticated with check (public.pp_is_admin());
drop policy if exists "admin adjust packs" on public.credit_packs;
create policy "admin adjust packs" on public.credit_packs
  for update to authenticated using (public.pp_is_admin()) with check (public.pp_is_admin());

revoke all on public.credit_packs from anon, authenticated;
grant select on public.credit_packs to authenticated;
grant insert (user_id, credits_total, credits_left, amount_pence, expires_at, note, created_by) on public.credit_packs to authenticated;
grant update (credits_left, expires_at, note) on public.credit_packs to authenticated;

-- tell Make when a pack is bought (same master webhook, event = pack_purchased)
create or replace function public.notify_pack_purchased() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare em text; nm text; ph text;
begin
  select u.email, p.full_name, p.phone into em, nm, ph
    from auth.users u left join public.profiles p on p.user_id = u.id
    where u.id = new.user_id;
  perform net.http_post(
    url := 'https://hook.eu2.make.com/gv6vj6l1s6cdiambazifcxho189o9zo7',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'event',        'pack_purchased',
      'pack_id',      new.id,
      'first_name',   split_part(coalesce(nm, ''), ' ', 1),
      'last_name',    nullif(btrim(substr(coalesce(nm, ''), length(split_part(coalesce(nm, ''), ' ', 1)) + 1)), ''),
      'full_name',    nm,
      'email',        em,
      'phone',        ph,
      'phone_e164',   replace(coalesce(ph, ''), ' ', ''),
      'credits',      new.credits_total,
      'amount',       case when new.amount_pence is not null then round(new.amount_pence / 100.0, 2) end,
      'expires',      to_char(new.expires_at at time zone 'Europe/London', 'YYYY-MM-DD'),
      'expires_pretty', trim(to_char(new.expires_at at time zone 'Europe/London', 'FMDD FMMonth YYYY')),
      'granted_by_staff', new.stripe_session_id is null,
      'account_url',  'https://www.padelpower.uk/account/',
      'created_at',   new.created_at));
  return new;
end $$;
drop trigger if exists pack_purchased_webhook on public.credit_packs;
create trigger pack_purchased_webhook
  after insert on public.credit_packs for each row execute function public.notify_pack_purchased();

-- 5 ▸ bookings: account + credit columns --------------------------
alter table public.bookings add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.bookings add column if not exists paid_with text check (paid_with in ('card', 'credit'));
alter table public.bookings add column if not exists credit_pack_id uuid references public.credit_packs(id) on delete set null;
alter table public.bookings add column if not exists credit_returned_at timestamptz;
create index if not exists bookings_user_idx on public.bookings (user_id);

update public.bookings set paid_with = 'card' where paid_with is null and payment_intent_id is not null;

-- hand the credit back whenever a credit booking is cancelled, by any route
create or replace function public.return_credit_on_cancel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.cancelled_at is not null and old.cancelled_at is null
     and new.credit_pack_id is not null and new.credit_returned_at is null then
    update public.credit_packs
      set credits_left = least(credits_total, credits_left + 1),
          expires_at = greatest(expires_at, now() + interval '7 days')
      where id = new.credit_pack_id;
    new.credit_returned_at := now();
  end if;
  return new;
end $$;
drop trigger if exists bookings_return_credit on public.bookings;
create trigger bookings_return_credit
  before update on public.bookings for each row execute function public.return_credit_on_cancel();

-- 6 ▸ spend a credit ----------------------------------------------
create or replace function public.book_with_credit(p_class_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  pack public.credit_packs;
  prof public.profiles;
  em text; bid uuid;
begin
  if uid is null then raise exception 'account_required'; end if;
  if p_class_id !~ '^\d{4}-\d{2}-\d{2}_[0-2][0-9]:[0-5][0-9]$' then raise exception 'bad_class'; end if;
  perform pg_advisory_xact_lock(hashtext('credits:' || uid::text));

  select * into pack from public.credit_packs
    where user_id = uid and credits_left > 0 and expires_at > now()
    order by expires_at asc limit 1 for update;
  if not found then raise exception 'no_credits'; end if;

  select * into prof from public.profiles where user_id = uid;
  em := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  if coalesce(prof.phone, '') = '' then raise exception 'profile_incomplete'; end if;

  insert into public.bookings (class_id, name, email, phone, source, user_id, paid_at, paid_with, credit_pack_id)
    values (p_class_id, coalesce(prof.full_name, split_part(em, '@', 1)), em, prof.phone, 'Online', uid, now(), 'credit', pack.id)
    returning id into bid;
  update public.credit_packs set credits_left = credits_left - 1 where id = pack.id;

  return jsonb_build_object('booking_id', bid, 'credits_left', pack.credits_left - 1, 'pack_id', pack.id);
end $$;
revoke execute on function public.book_with_credit(text) from public, anon;
grant execute on function public.book_with_credit(text) to authenticated;

-- 7 ▸ booking rules ------------------------------------------------
create or replace function public.enforce_booking_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cap int; cur int; d date; t text; ty text; pr int;
  r text; prof public.profiles; has_prof boolean;
begin
  if new.cancelled_at is not null then return new; end if;

  r := public.pp_role();
  if r = 'anon' then raise exception 'account_required'; end if;

  if r = 'member' then
    -- a member can only ever book as themselves
    new.user_id := auth.uid();
    new.email := lower(btrim(coalesce(auth.jwt()->>'email', '')));
    new.source := 'Online';
    select * into prof from public.profiles where user_id = auth.uid();
    has_prof := found;
    if coalesce(btrim(new.name), '') = '' then new.name := coalesce(prof.full_name, split_part(new.email, '@', 1)); end if;
    if coalesce(btrim(new.phone), '') = '' then new.phone := coalesce(prof.phone, ''); end if;
    if not has_prof then
      insert into public.profiles (user_id, full_name, phone)
        values (auth.uid(), new.name, nullif(new.phone, '')) on conflict do nothing;
    elsif prof.full_name is null or prof.phone is null then
      update public.profiles set full_name = coalesce(full_name, new.name),
        phone = coalesce(phone, nullif(new.phone, '')), updated_at = now()
        where user_id = auth.uid();
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.class_id));
  d := split_part(new.class_id, '_', 1)::date;
  t := split_part(new.class_id, '_', 2);
  if exists (select 1 from cancelled_classes cx where cx.class_date = d and cx.start_time = t) then
    raise exception 'class_cancelled';
  end if;
  select cc.type_key into ty from custom_classes cc where cc.class_date = d and cc.start_time = t;
  if ty is null then
    select tt.type_key into ty from timetable tt
      where tt.weekday = extract(dow from d)::int and tt.start_time = t;
  end if;
  if ty is null then raise exception 'no_such_class'; end if;
  if (d + t::time) < now() at time zone 'Europe/London' then raise exception 'class_in_past'; end if;

  -- one booking per member per class
  if new.user_id is not null and exists (
      select 1 from bookings b where b.user_id = new.user_id and b.class_id = new.class_id and b.cancelled_at is null) then
    raise exception 'already_booked';
  end if;

  select price_pence into pr from class_types where key = ty;
  if pr is not null and r = 'member' and new.paid_at is null then
    raise exception 'payment_required';
  end if;
  if r in ('member', 'admin', 'instructor')
     and not exists (select 1 from waivers w where w.email = lower(btrim(new.email))) then
    raise exception 'waiver_required';
  end if;
  select name into new.class_type from class_types where key = ty;
  select max_riders into cap from settings where id = 1;
  select count(*) into cur from bookings where class_id = new.class_id and cancelled_at is null;
  if cur >= cap then raise exception 'class_full'; end if;
  return new;
end $$;

-- throttle members the way guests used to be throttled
create or replace function public.throttle_anon_bookings() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.pp_role() not in ('anon', 'member') then return new; end if;
  if (select count(*) from bookings where created_at > now() - interval '1 hour') >= 60 then
    raise exception 'rate_limited';
  end if;
  if (select count(*) from bookings
      where (phone = new.phone or (auth.uid() is not null and user_id = auth.uid()))
        and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limited';
  end if;
  return new;
end $$;

-- booking_created payload: say how it was paid
create or replace function public.notify_booking_created() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  d date; t text;
  site text := 'https://www.padelpower.uk';
  hook text := 'https://hook.eu2.make.com/gv6vj6l1s6cdiambazifcxho189o9zo7';
begin
  if new.cancelled_at is not null then return new; end if;
  d := split_part(new.class_id, '_', 1)::date;
  t := split_part(new.class_id, '_', 2);
  perform net.http_post(
    url := hook,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'event',       'booking_created',
      'booking_id',  new.id,
      'first_name',  split_part(new.name, ' ', 1),
      'last_name',   nullif(btrim(substr(new.name, length(split_part(new.name, ' ', 1)) + 1)), ''),
      'full_name',   new.name,
      'email',       new.email,
      'phone',       new.phone,
      'phone_e164',  replace(new.phone, ' ', ''),
      'class_name',  coalesce(new.class_type, 'Reformer Pilates'),
      'class_id',    new.class_id,
      'date',        to_char(d, 'YYYY-MM-DD'),
      'day',         trim(to_char(d, 'FMDay')),
      'date_pretty', trim(to_char(d, 'FMDay FMDD FMMonth')),
      'time',        t,
      'source',      new.source,
      'paid',        new.paid_at is not null,
      'paid_with',   coalesce(new.paid_with, case when new.paid_at is not null then 'card' else 'none' end),
      'amount',      case when new.amount_pence is not null then round(new.amount_pence / 100.0, 2) end,
      'cancel_url',  site || '/cancel/?b=' || new.cancel_token,
      'account_url', site || '/account/',
      'created_at',  new.created_at
    )
  );
  return new;
end $$;

-- 8 ▸ policies: staff means a role row, members see their own -----
-- bookings
drop policy if exists "read bookings" on public.bookings;
drop policy if exists "create booking" on public.bookings;
drop policy if exists "staff update bookings" on public.bookings;
drop policy if exists "staff delete bookings" on public.bookings;
create policy "read bookings" on public.bookings
  for select to authenticated using (public.pp_is_staff() or user_id = auth.uid());
create policy "create booking" on public.bookings
  for insert to authenticated
  with check (cancelled_at is null and (public.pp_is_staff() or user_id = auth.uid()));
create policy "staff update bookings" on public.bookings
  for update to authenticated using (public.pp_is_staff()) with check (public.pp_is_staff());
create policy "staff delete bookings" on public.bookings
  for delete to authenticated using (public.pp_is_staff());

-- members may only write the plain booking columns; money columns are server-only
revoke all on public.bookings from anon;
revoke insert, update, delete on public.bookings from authenticated;
grant insert (class_id, name, email, phone, source, user_id) on public.bookings to authenticated;
grant update (cancelled_at) on public.bookings to authenticated;
grant delete on public.bookings to authenticated;

-- public bed counts no longer need a read policy on bookings
alter view public.booking_counts set (security_invoker = off);

-- class types
drop policy if exists "staff add class type" on public.class_types;
drop policy if exists "staff remove class type" on public.class_types;
drop policy if exists "staff set prices" on public.class_types;
create policy "staff add class type" on public.class_types
  for insert to authenticated with check (custom = true and public.pp_is_admin());
create policy "staff remove class type" on public.class_types
  for delete to authenticated using (custom = true and public.pp_is_admin());
create policy "staff set prices" on public.class_types
  for update to authenticated using (public.pp_is_staff()) with check (public.pp_is_staff());

-- settings
drop policy if exists "staff update settings" on public.settings;
create policy "staff update settings" on public.settings
  for update to authenticated using (public.pp_is_staff()) with check (public.pp_is_staff());

-- enquiries
drop policy if exists "staff read enquiries" on public.enquiries;
drop policy if exists "staff update enquiries" on public.enquiries;
create policy "staff read enquiries" on public.enquiries
  for select to authenticated using (public.pp_is_staff());
create policy "staff update enquiries" on public.enquiries
  for update to authenticated using (public.pp_is_staff()) with check (public.pp_is_staff());

-- instructors
drop policy if exists "staff read instructors" on public.instructors;
create policy "staff read instructors" on public.instructors
  for select to authenticated using (public.pp_is_staff());

-- waivers: staff read all, a member reads their own
drop policy if exists "staff read waivers" on public.waivers;
create policy "staff read waivers" on public.waivers
  for select to authenticated
  using (public.pp_is_staff() or email = lower(btrim(coalesce(auth.jwt()->>'email', ''))));

-- 9 ▸ lock down callable functions --------------------------------
revoke execute on function public.auto_cancel_under_min(boolean) from public, anon, authenticated;
revoke execute on function public.send_class_reminders(boolean) from public, anon, authenticated;
revoke execute on function public._notify_class_moved(public.bookings, text, text, date, text, text) from public, anon, authenticated;

create or replace function public.move_class_occurrence(p_date date, p_old_time text, p_new_time text, p_instructor text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  ty text; cname text; is_custom boolean := false;
  cid_old text := p_date::text || '_' || p_old_time;
  cid_new text := p_date::text || '_' || p_new_time;
  mem bookings; moved int := 0;
begin
  if not public.pp_is_admin() then raise exception 'forbidden'; end if;
  select cc.type_key into ty from custom_classes cc
    where cc.class_date = p_date and cc.start_time = p_old_time;
  if ty is not null then is_custom := true;
  else
    select tt.type_key into ty from timetable tt
      where tt.weekday = extract(dow from p_date)::int and tt.start_time = p_old_time;
  end if;
  if ty is null then raise exception 'no_such_class'; end if;

  if p_new_time <> p_old_time then
    if exists (select 1 from custom_classes cc where cc.class_date = p_date and cc.start_time = p_new_time)
       or (exists (select 1 from timetable tt where tt.weekday = extract(dow from p_date)::int and tt.start_time = p_new_time)
           and not exists (select 1 from cancelled_classes cx where cx.class_date = p_date and cx.start_time = p_new_time)) then
      raise exception 'slot_taken';
    end if;
  end if;

  select ct.name into cname from class_types ct where ct.key = ty;

  if is_custom then
    update custom_classes set start_time = p_new_time, instructor = p_instructor
      where class_date = p_date and start_time = p_old_time;
  else
    insert into custom_classes (class_date, start_time, type_key, instructor)
      values (p_date, p_new_time, ty, p_instructor);
  end if;

  if p_new_time <> p_old_time then
    for mem in
      update bookings set class_id = cid_new
        where class_id = cid_old and cancelled_at is null
        returning *
    loop
      moved := moved + 1;
      perform _notify_class_moved(mem, p_old_time, p_new_time, p_date, cname, p_instructor);
    end loop;
    if not is_custom then
      insert into cancelled_classes (class_date, start_time, reason)
        values (p_date, p_old_time, 'moved to ' || p_new_time);
    end if;
  end if;

  return jsonb_build_object('moved_bookings', moved);
end $$;

create or replace function public.move_class_template(p_id bigint, p_new_time text, p_instructor text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  slot timetable; cname text; mem bookings; moved int := 0;
  today date := (now() at time zone 'Europe/London')::date;
begin
  if not public.pp_is_admin() then raise exception 'forbidden'; end if;
  select * into slot from timetable where id = p_id;
  if slot.id is null then raise exception 'no_such_class'; end if;

  if p_new_time <> slot.start_time and exists (
      select 1 from timetable tt where tt.weekday = slot.weekday and tt.start_time = p_new_time and tt.id <> p_id) then
    raise exception 'slot_taken';
  end if;

  select ct.name into cname from class_types ct where ct.key = slot.type_key;
  update timetable set start_time = p_new_time, instructor = p_instructor where id = p_id;

  if p_new_time <> slot.start_time then
    for mem in
      update bookings b set class_id = split_part(b.class_id, '_', 1) || '_' || p_new_time
        where b.cancelled_at is null
          and split_part(b.class_id, '_', 2) = slot.start_time
          and split_part(b.class_id, '_', 1)::date >= today
          and extract(dow from split_part(b.class_id, '_', 1)::date)::int = slot.weekday
        returning *
    loop
      moved := moved + 1;
      perform _notify_class_moved(mem, slot.start_time, p_new_time,
        split_part(mem.class_id, '_', 1)::date, cname, p_instructor);
    end loop;
  end if;

  return jsonb_build_object('moved_bookings', moved);
end $$;

revoke execute on function public.move_class_occurrence(date, text, text, text) from public, anon;
revoke execute on function public.move_class_template(bigint, text, text) from public, anon;
revoke execute on function public.move_class_day(date, text, date, text, text) from public, anon;
grant execute on function public.move_class_occurrence(date, text, text, text) to authenticated;
grant execute on function public.move_class_template(bigint, text, text) to authenticated;
grant execute on function public.move_class_day(date, text, date, text, text) to authenticated;
