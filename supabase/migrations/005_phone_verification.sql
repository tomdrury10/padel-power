-- ============================================================
-- Padel Power · mobile number verification by SMS code
-- Applied to the Padel Power project on 2026-09-09 via MCP.
-- Safe to run more than once.
--
-- A member proves their mobile with a 6 digit code before they can
-- book. The number is the channel the studio actually uses (booking
-- confirmation, the cancel link, reminders, cancellations), so this
-- verifies the one that matters.
--
-- What this does
--   1. profiles.phone_verified_at — the flag everything keys off.
--      Changing your number in the account page clears it, so a new
--      number always has to be proved again.
--   2. phone_verifications — one row per code issued. The code is
--      stored bcrypt-hashed, never in the clear. Rows are kept so the
--      rate limits and support lookups have something to read.
--   3. settings gains:
--        require_phone_verification  master switch, OFF until the
--                                    ClickSend credentials are in place
--        sms_verification_template   the message wording, editable in
--                                    Studio Manager without a redeploy
--        verification_code_minutes   how long a code lasts
--   4. Booking rules: a member with an unverified number is refused
--      with 'phone_unverified', but only while the master switch is on.
--      Staff booking someone in at the front desk is unaffected.
--   5. Shared numbers are allowed. Two accounts on one household
--      mobile both verify independently. (Confirmed with Tom.)
--
-- The codes themselves are issued and checked by the verify-phone edge
-- function using the service role. Members never read or write these
-- tables directly.
-- ============================================================

-- 1 ▸ the flag ----------------------------------------------------
alter table public.profiles add column if not exists phone_verified_at timestamptz;

-- changing your number un-verifies it
create or replace function public.reset_phone_verification() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.phone is distinct from old.phone then
    new.phone_verified_at := null;
  end if;
  return new;
end $$;

drop trigger if exists profiles_phone_changed on public.profiles;
create trigger profiles_phone_changed
  before update on public.profiles for each row
  execute function public.reset_phone_verification();

-- 2 ▸ issued codes -------------------------------------------------
create table if not exists public.phone_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  phone text not null check (char_length(phone) between 5 and 25),
  code_hash text not null,
  attempts integer not null default 0,
  verified_at timestamptz,
  expires_at timestamptz not null,
  provider_message_id text,
  provider_status text,
  created_at timestamptz not null default now()
);
create index if not exists phone_verifications_user_idx
  on public.phone_verifications (user_id, created_at desc);
create index if not exists phone_verifications_phone_idx
  on public.phone_verifications (phone, created_at desc);

alter table public.phone_verifications enable row level security;

-- staff can look one up when a member says "no code arrived".
-- Members never touch this table; the edge function does the work.
drop policy if exists "staff read verifications" on public.phone_verifications;
create policy "staff read verifications" on public.phone_verifications
  for select to authenticated using (public.pp_is_staff());

revoke all on public.phone_verifications from anon, authenticated;
grant select on public.phone_verifications to authenticated;

-- 3 ▸ settings -----------------------------------------------------
alter table public.settings add column if not exists require_phone_verification boolean not null default false;
alter table public.settings add column if not exists verification_code_minutes integer not null default 10
  check (verification_code_minutes between 2 and 60);
alter table public.settings add column if not exists sms_verification_template text not null default
  'Padel Power: Your 6 digit verification code is {code}.

This code will expire in {minutes} minutes.';

-- 4 ▸ booking rules: refuse an unverified member -------------------
create or replace function public.enforce_booking_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cap int; cur int; d date; t text; ty text; pr int;
  r text; prof public.profiles; has_prof boolean; needs_phone boolean;
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

    -- the mobile has to be proved, once the switch is on
    select require_phone_verification into needs_phone from settings where id = 1;
    if coalesce(needs_phone, false) and (prof.phone_verified_at is null or not has_prof) then
      raise exception 'phone_unverified';
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

-- 5 ▸ spending a credit needs a proved number too ------------------
create or replace function public.book_with_credit(p_class_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  pack public.credit_packs;
  prof public.profiles;
  needs_phone boolean;
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

  select require_phone_verification into needs_phone from settings where id = 1;
  if coalesce(needs_phone, false) and prof.phone_verified_at is null then
    raise exception 'phone_unverified';
  end if;

  insert into public.bookings (class_id, name, email, phone, source, user_id, paid_at, paid_with, credit_pack_id)
    values (p_class_id, coalesce(prof.full_name, split_part(em, '@', 1)), em, prof.phone, 'Online', uid, now(), 'credit', pack.id)
    returning id into bid;
  update public.credit_packs set credits_left = credits_left - 1 where id = pack.id;

  return jsonb_build_object('booking_id', bid, 'credits_left', pack.credits_left - 1, 'pack_id', pack.id);
end $$;
revoke execute on function public.book_with_credit(text) from public, anon;
grant execute on function public.book_with_credit(text) to authenticated;

-- 6 ▸ issuing and checking codes -----------------------------------
-- Both run as the service role from the verify-phone edge function.
-- Keeping them in SQL makes the rate limit and the attempt counter
-- atomic: two requests racing cannot both slip past the same limit.

-- Rate limits: 60 seconds between codes, 3 an hour per account,
-- 5 an hour per number (higher, because a household can share one).
create or replace function public.issue_phone_code(p_user_id uuid, p_code text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  ph text; mins int; last_at timestamptz; n_user int; n_phone int; vid uuid;
begin
  select phone into ph from profiles where user_id = p_user_id;
  if coalesce(btrim(ph), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_phone');
  end if;
  select verification_code_minutes into mins from settings where id = 1;

  select max(created_at) into last_at from phone_verifications where user_id = p_user_id;
  if last_at is not null and last_at > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'cooldown',
      'retry_after', ceil(extract(epoch from (last_at + interval '60 seconds' - now()))));
  end if;

  select count(*) into n_user from phone_verifications
    where user_id = p_user_id and created_at > now() - interval '1 hour';
  if n_user >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  select count(*) into n_phone from phone_verifications
    where phone = ph and created_at > now() - interval '1 hour';
  if n_phone >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  insert into phone_verifications (user_id, phone, code_hash, expires_at)
    values (p_user_id, ph, extensions.crypt(p_code, extensions.gen_salt('bf')),
            now() + make_interval(mins => mins))
    returning id into vid;

  return jsonb_build_object('ok', true, 'id', vid, 'phone', ph, 'minutes', mins);
end $$;

-- Five wrong guesses kills the code; they have to ask for a new one.
create or replace function public.check_phone_code(p_user_id uuid, p_code text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare v phone_verifications;
begin
  select * into v from phone_verifications
    where user_id = p_user_id and verified_at is null and expires_at > now()
    order by created_at desc limit 1
    for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_code');
  end if;
  if v.attempts >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
  end if;

  update phone_verifications set attempts = attempts + 1 where id = v.id;

  if extensions.crypt(p_code, v.code_hash) <> v.code_hash then
    return jsonb_build_object('ok', false, 'reason', 'wrong_code',
      'attempts_left', 4 - v.attempts);
  end if;

  update phone_verifications set verified_at = now() where id = v.id;
  update profiles set phone_verified_at = now(), updated_at = now() where user_id = p_user_id;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.issue_phone_code(uuid, text) from public, anon, authenticated;
revoke execute on function public.check_phone_code(uuid, text) from public, anon, authenticated;
