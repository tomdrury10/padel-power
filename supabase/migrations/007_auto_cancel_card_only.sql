-- ============================================================
-- Padel Power · narrow the auto-cancel guard to card payments
-- Applied live 2026-09-12 (migration auto_cancel_skip_card_only).
-- Safe to run more than once.
--
-- auto_cancel_under_min used to walk away from any class holding a
-- booking with paid_at set. Credit bookings stamp paid_at too, so a
-- class with two members booked on credit was skipped even though no
-- money is involved and the credits return on their own. With credit
-- packs being the way we want people booking, that guard would have
-- stopped the minimum-numbers rule doing anything useful.
--
-- The guard exists for a real reason: the cron job cannot refund a
-- card. Stripe refunds are issued by the refund edge function, which
-- requires a signed-in staff session, and a cron job has none. So the
-- guard now catches only card payments, the ones that would leave a
-- member out of pocket.
--
-- Credit bookings now cancel cleanly. bookings_return_credit puts the
-- credit back and extends the pack expiry by a week, and the insert
-- into cancelled_classes fires the texts to the members and to the
-- instructor.
--
-- Still outstanding: a class holding a card booking is reported as
-- skipped_card_bookings and left alone for staff to handle. Giving the
-- cron job a way to refund needs a shared secret on the refund
-- function; see the notes in that function.
-- ============================================================

create or replace function public.auto_cancel_under_min(p_dry boolean default false)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  min_r int; opening date;
  now_ldn timestamp := now() at time zone 'Europe/London';
  cls record; cid text; cnt int; cards int;
  acted jsonb := '[]'::jsonb;
begin
  select min_riders, opening_date into min_r, opening from settings where id = 1;
  for cls in
    select x.class_date, x.start_time from (
      select dd::date as class_date, tt.start_time
        from generate_series(now_ldn::date, now_ldn::date + 1, interval '1 day') dd
        join timetable tt on tt.weekday = extract(dow from dd)::int
      union
      select cc.class_date, cc.start_time
        from custom_classes cc
        where cc.class_date between now_ldn::date and now_ldn::date + 1
    ) x
    where x.class_date >= opening
      and (x.class_date + x.start_time::time) > now_ldn
      and (x.class_date + x.start_time::time) <= now_ldn + interval '24 hours'
      and not exists (
        select 1 from cancelled_classes cx
        where cx.class_date = x.class_date and cx.start_time = x.start_time)
    order by x.class_date, x.start_time
  loop
    cid := cls.class_date::text || '_' || cls.start_time;
    select count(*) into cnt from bookings b where b.class_id = cid and b.cancelled_at is null;
    if cnt >= min_r then continue; end if;

    -- only a card payment blocks this: it needs a Stripe refund the cron
    -- job cannot issue. Credit bookings are refunded by trigger.
    select count(*) into cards from bookings b
      where b.class_id = cid and b.cancelled_at is null
        and b.paid_at is not null and b.refunded_at is null
        and coalesce(b.paid_with, 'card') = 'card';
    if cards > 0 then
      acted := acted || jsonb_build_object('class_id', cid, 'action', 'skipped_card_bookings',
                                           'booked', cnt, 'card_bookings', cards);
      continue;
    end if;

    acted := acted || jsonb_build_object('class_id', cid, 'action',
      case when p_dry then 'would_cancel' else 'cancelled' end, 'booked', cnt);
    if p_dry then continue; end if;
    insert into cancelled_classes (class_date, start_time, reason)
      values (cls.class_date, cls.start_time, 'auto: below minimum (' || cnt || ' booked)');
    update bookings set cancelled_at = now() where class_id = cid and cancelled_at is null;
  end loop;
  return jsonb_build_object('ran_at', now_ldn, 'min_riders', min_r, 'classes', acted);
end $$;

revoke execute on function public.auto_cancel_under_min(boolean) from public, anon, authenticated;
