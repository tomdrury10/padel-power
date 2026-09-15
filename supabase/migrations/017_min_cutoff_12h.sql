-- ============================================================
-- Padel Power · short classes stay open until 12 hours before
-- Applied live 2026-09-15 (migration min_cutoff_hours).
--
-- Joe: "keep booking open until 12 hours before for ones with less than
-- 3 booked." Until now cutoff_hours (24) did two jobs: the point at which
-- an under-minimum class was cancelled (and stopped taking bookings) and
-- the point after which members cannot cancel online.
--
-- New settings.min_cutoff_hours (12) takes over the first job. A class
-- under its minimum stays bookable until 12 hours before; if it is still
-- short then, auto_cancel_under_min cancels it (refunds and texts as
-- before). cutoff_hours (24) is now only the online cancellation cutoff.
-- join_cutoff_hours (1) is unchanged: a class that has its minimum stays
-- open to late joiners until an hour before.
-- ============================================================

alter table public.settings
  add column if not exists min_cutoff_hours integer not null default 12;

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

  -- members: a class under its minimum stays open until min_cutoff; a class
  -- that has its minimum stays open to late joiners until join_cutoff
  if r = 'member' then
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

-- the auto-cancel job now looks min_cutoff_hours ahead instead of 24
create or replace function public.auto_cancel_under_min(p_dry boolean default false)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  min_r int; opening date; horizon int;
  now_ldn timestamp := now() at time zone 'Europe/London';
  cls record; cid text; cnt int; card_ids uuid[];
  acted jsonb := '[]'::jsonb;
begin
  select min_riders, opening_date, coalesce(min_cutoff_hours, cutoff_hours, 24)
    into min_r, opening, horizon from settings where id = 1;
  for cls in
    select x.class_date, x.start_time from (
      select dd::date as class_date, tt.start_time
        from generate_series(now_ldn::date, now_ldn::date + 3, interval '1 day') dd
        join timetable tt on tt.weekday = extract(dow from dd)::int
      union
      select cc.class_date, cc.start_time
        from custom_classes cc
        where cc.class_date between now_ldn::date and now_ldn::date + 3
    ) x
    where x.class_date >= opening
      and (x.class_date + x.start_time::time) > now_ldn
      and (x.class_date + x.start_time::time) <= now_ldn + make_interval(hours => horizon)
      and not exists (
        select 1 from cancelled_classes cx
        where cx.class_date = x.class_date and cx.start_time = x.start_time)
    order by x.class_date, x.start_time
  loop
    cid := cls.class_date::text || '_' || cls.start_time;
    select count(*) into cnt from bookings b where b.class_id = cid and b.cancelled_at is null;
    if cnt >= min_r then continue; end if;

    select array_agg(b.id) into card_ids from bookings b
      where b.class_id = cid and b.cancelled_at is null
        and b.paid_at is not null and b.refunded_at is null
        and b.payment_intent_id is not null
        and coalesce(b.paid_with, 'card') = 'card';

    acted := acted || jsonb_build_object('class_id', cid,
      'action', case when p_dry then 'would_cancel' else 'cancelled' end,
      'booked', cnt, 'card_refunds', coalesce(array_length(card_ids, 1), 0));
    if p_dry then continue; end if;

    -- order matters: the cancelled_classes insert texts everyone still
    -- booked, so it goes first; then the bookings close (credits return
    -- by trigger); then the card ones are sent for refund
    insert into cancelled_classes (class_date, start_time, reason)
      values (cls.class_date, cls.start_time, 'auto: below minimum (' || cnt || ' booked)');
    update bookings set cancelled_at = now() where class_id = cid and cancelled_at is null;
    perform _post_refunds(card_ids, 'auto_cancel');
  end loop;
  return jsonb_build_object('ran_at', now_ldn, 'min_riders', min_r, 'horizon_hours', horizon, 'classes', acted);
end $$;
