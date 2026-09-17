-- ============================================================
-- Padel Power · security audit fixes, 17 Sept 2026
-- NOT YET APPLIED. Review before running.
--
-- Five fixes, each independent of the others:
--   1. phone codes verify the number they were sent to, not whatever is on
--      the profile when the code is submitted
--   2. league reads are admin-only, matching the UI, the RPCs and the sync
--      function (instructors could read every registrant's details)
--   3. the class join and minimum cutoffs bind the webhook's insert, not only
--      a member's own
--   4. the same for soft play, plus the booking-open switch
--   5. a member cancelling their own class no longer extends a credit pack's
--      expiry; the club's own cancellations still do
--
-- Fix 5 needs a new column, so it is written to be safe to run more than once.
-- ============================================================

-- ---- 1. bind a phone code to the number it was sent to -------------
create or replace function public.check_phone_code(p_user_id uuid, p_code text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare v phone_verifications; cur_phone text;
begin
  select phone into cur_phone from profiles where user_id = p_user_id;

  -- the code proves the number it was texted to, so a profile phone changed
  -- after the code was issued no longer matches and cannot be verified by it
  select * into v from phone_verifications
    where user_id = p_user_id and verified_at is null and expires_at > now()
      and phone = cur_phone
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
  update profiles set phone_verified_at = now(), updated_at = now()
    where user_id = p_user_id and phone = v.phone;
  return jsonb_build_object('ok', true);
end $$;

-- a number change also retires any code still outstanding, so none can be
-- redeemed against the new number
create or replace function public.reset_phone_verification() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.phone is distinct from old.phone then
    new.phone_verified_at := null;
    update public.phone_verifications set expires_at = now()
      where user_id = new.user_id and verified_at is null and expires_at > now();
  end if;
  return new;
end $$;

-- ---- 2. league data is admin-only, not any staff row ---------------
-- members still see their own registration and their partner's
drop policy if exists league_reg_read on public.league_registrations;
create policy league_reg_read on public.league_registrations for select
  using (pp_is_admin() or user_id = auth.uid() or pair_id in (select pp_my_pair_ids()));

drop policy if exists league_audit_staff on public.league_audit;
create policy league_audit_staff on public.league_audit for select using (pp_is_admin());

drop policy if exists league_members_staff on public.league_members;
create policy league_members_staff on public.league_members for select using (pp_is_admin());

drop policy if exists lmb_staff_read on public.league_member_benefits;
create policy lmb_staff_read on public.league_member_benefits for select using (pp_is_admin());

-- ---- 3. class cutoffs bind every online insert ---------------------
-- The body below is migration 017's verbatim, with only the cutoff guard
-- widened to the service role. Nothing else about booking changes.
create or replace function public.enforce_booking_rules()
returns trigger language plpgsql security definer
set search_path = public as $$
declare
  cap int; cur int; d date; t text; ty text; pr int;
  r text; prof public.profiles; has_prof boolean; needs_phone boolean;
  min_r int; min_cutoff int; join_cutoff int; hours_left numeric;
begin
  if new.cancelled_at is not null then return new; end if;

  r := public.pp_role();
  if r = 'anon' then raise exception 'account_required'; end if;

  if r = 'member' then
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

  if new.user_id is not null and exists (
      select 1 from bookings b where b.user_id = new.user_id and b.class_id = new.class_id and b.cancelled_at is null) then
    raise exception 'already_booked';
  end if;

  select max_riders, min_riders, coalesce(min_cutoff_hours, cutoff_hours), coalesce(join_cutoff_hours, 1)
    into cap, min_r, min_cutoff, join_cutoff from settings where id = 1;
  select count(*) into cur from bookings where class_id = new.class_id and cancelled_at is null;

  -- The cutoff belongs to the class and the clock, not to whoever writes the
  -- row. 'service' is the Stripe webhook finishing a member's payment, so it is
  -- held to the same rule: a class under its minimum stays open until
  -- min_cutoff, one that has its minimum stays open to late joiners until
  -- join_cutoff. Only the desk (admin / instructor) is exempt.
  if r in ('member', 'service') then
    hours_left := extract(epoch from ((d + t::time) - (now() at time zone 'Europe/London'))) / 3600;
    if hours_left < join_cutoff then raise exception 'cutoff'; end if;
    if hours_left < min_cutoff and cur < min_r then raise exception 'cutoff'; end if;
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
  if cur >= cap then raise exception 'class_full'; end if;
  return new;
end $$;

-- ---- 4. soft play cutoffs and the open switch bind every online insert ----
-- Migration 015's body verbatim, with the open switch and the cutoffs
-- widened the same way.
create or replace function public.enforce_softplay_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s public.softplay_sessions; r text; prof public.profiles;
  cur int; live_bookings int; min_c int; cutoff int; join_cutoff int;
  hours_left numeric; is_open boolean;
begin
  if new.cancelled_at is not null then return new; end if;
  r := public.pp_role();
  if r = 'anon' then raise exception 'account_required'; end if;

  select * into s from public.softplay_sessions where id = new.session_id;
  if s.id is null then raise exception 'no_such_session'; end if;
  if s.cancelled_at is not null then raise exception 'session_cancelled'; end if;
  if (s.session_date + s.start_time::time) < now() at time zone 'Europe/London' then
    raise exception 'session_in_past';
  end if;

  select softplay_open, softplay_min_children, cutoff_hours, coalesce(join_cutoff_hours, 1)
    into is_open, min_c, cutoff, join_cutoff from public.settings where id = 1;

  -- the master switch applies to every online sale, whoever writes the row
  if r in ('member', 'service') and not coalesce(is_open, false) then
    raise exception 'softplay_closed';
  end if;

  if r = 'member' then
    new.user_id := auth.uid();
    new.email := lower(btrim(coalesce(auth.jwt()->>'email', '')));
    new.source := 'Online';
    select * into prof from public.profiles where user_id = auth.uid();
    if coalesce(btrim(new.name), '') = '' then new.name := coalesce(prof.full_name, split_part(new.email, '@', 1)); end if;
    if coalesce(btrim(new.phone), '') = '' then new.phone := coalesce(prof.phone, ''); end if;
    -- members pay through Stripe; the webhook inserts the paid row
    if new.paid_at is null then raise exception 'payment_required'; end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('softplay:' || s.id::text));
  select coalesce(sum(children), 0), count(*) into cur, live_bookings
    from public.softplay_bookings where session_id = s.id and cancelled_at is null;

  if new.user_id is not null and exists (
      select 1 from public.softplay_bookings b
      where b.session_id = s.id and b.user_id = new.user_id and b.cancelled_at is null) then
    raise exception 'already_booked';
  end if;
  if s.mode = 'hire' and live_bookings > 0 then raise exception 'session_taken'; end if;
  if cur + new.children > s.capacity then raise exception 'session_full'; end if;

  -- the cutoffs bind the webhook's insert too, not only a member's own
  if r in ('member', 'service') then
    hours_left := extract(epoch from ((s.session_date + s.start_time::time) - (now() at time zone 'Europe/London'))) / 3600;
    if hours_left < join_cutoff then raise exception 'cutoff'; end if;
    if s.mode = 'supervised' and hours_left < cutoff and cur < min_c then raise exception 'cutoff'; end if;
  end if;
  return new;
end $$;

-- ---- 5. the goodwill week is for club cancellations only -----------
alter table public.bookings
  add column if not exists cancelled_by text
    check (cancelled_by is null or cancelled_by in ('member', 'club'));

create or replace function public.return_credit_on_cancel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.cancelled_at is not null and old.cancelled_at is null
     and new.credit_pack_id is not null and new.credit_returned_at is null then
    -- the credit always comes back
    update public.credit_packs
       set credits_left = least(credits_total, credits_left + 1)
     where id = new.credit_pack_id;
    -- The extra week is compensation for a class the club cancelled, so a
    -- member cancelling their own booking no longer renews a pack's expiry.
    -- Anything that does not say who cancelled is treated as the club, so the
    -- staff cancel and the auto-cancel job keep behaving exactly as they do
    -- now: only cancel-booking, the member's own route, stamps 'member'.
    if coalesce(new.cancelled_by, 'club') = 'club' then
      update public.credit_packs
         set expires_at = greatest(expires_at, now() + interval '7 days')
       where id = new.credit_pack_id;
    end if;
    new.credit_returned_at := now();
  end if;
  return new;
end $$;
