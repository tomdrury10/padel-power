-- ============================================================
-- Padel Power · late joins on confirmed classes
-- Applied live 2026-09-14 (migration late_join_cutoff).
--
-- Joe: "Auto cancel for 24 hours, then if class is going ahead allow
-- people to join up to 1 hour before."
--
-- cutoff_hours (24) keeps its two jobs: the auto-cancel decision point
-- and the online cancellation cutoff. New join_cutoff_hours (1) is when
-- online booking finally closes on a class that is going ahead.
--
-- Online booking for a member is therefore allowed when
--   hours_left >= cutoff_hours                              (normal window)
--   or hours_left >= join_cutoff_hours and booked >= min    (confirmed, late join)
-- Anything else raises 'cutoff'. Staff are exempt: the desk can add a
-- member right up to the start, as they do today.
--
-- Before this, the trigger had no cutoff check at all: free and credit
-- bookings relied on the front end, only card checkout enforced it.
-- ============================================================

alter table public.settings
  add column if not exists join_cutoff_hours integer not null default 1;

create or replace function public.enforce_booking_rules()
returns trigger language plpgsql security definer
set search_path = public as $$
declare
  cap int; cur int; d date; t text; ty text; pr int;
  r text; prof public.profiles; has_prof boolean; needs_phone boolean;
  min_r int; cutoff int; join_cutoff int; hours_left numeric;
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

  select max_riders, min_riders, cutoff_hours, coalesce(join_cutoff_hours, 1)
    into cap, min_r, cutoff, join_cutoff from settings where id = 1;
  select count(*) into cur from bookings where class_id = new.class_id and cancelled_at is null;

  -- members: the normal window, or a late join onto a class that is going ahead
  if r = 'member' then
    hours_left := extract(epoch from ((d + t::time) - (now() at time zone 'Europe/London'))) / 3600;
    if hours_left < join_cutoff then raise exception 'cutoff'; end if;
    if hours_left < cutoff and cur < min_r then raise exception 'cutoff'; end if;
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
