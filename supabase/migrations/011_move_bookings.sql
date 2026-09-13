-- ============================================================
-- Padel Power · move members from one class to another
-- Applied live 2026-09-13 (migration move_bookings_between_classes).
--
-- Grace's case: the 17:30 is thin, the 18:30 has room. Pick the members,
-- pick the destination, they move and each gets a "your class has been
-- rescheduled" text. The source class is left alone; if it is now empty
-- the dashboard offers to cancel it. Works across days, not just times.
--
-- Rules: destination must exist, not be cancelled, be in the future and
-- have enough free beds for everyone selected. A member already booked
-- on the destination is skipped rather than doubled up. Admins can move
-- anyone; an instructor can move members off their own classes.
--
-- Both move paths (whole class, chosen members) now send old_date and
-- old_date_pretty in the class_moved event, so the Make text reads the
-- same whether the class moved an hour or a week.
-- ============================================================

create or replace function public._notify_booking_moved(
  b public.bookings, p_old_class_id text, p_new_class_id text, p_cname text, p_instructor text)
returns void language plpgsql security definer
set search_path = public, extensions as $$
declare
  od date := split_part(p_old_class_id, '_', 1)::date; ot text := split_part(p_old_class_id, '_', 2);
  nd date := split_part(p_new_class_id, '_', 1)::date; nt text := split_part(p_new_class_id, '_', 2);
begin
  perform net.http_post(
    url := 'https://hook.eu2.make.com/gv6vj6l1s6cdiambazifcxho189o9zo7',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'event',           'class_moved',
      'old_time',        ot,
      'old_date',        to_char(od, 'YYYY-MM-DD'),
      'old_date_pretty', trim(to_char(od, 'FMDay FMDD FMMonth')),
      'same_day',        od = nd,
      'time',            nt,
      'booking_id',      b.id,
      'first_name',      split_part(b.name, ' ', 1),
      'last_name',       nullif(btrim(substr(b.name, length(split_part(b.name, ' ', 1)) + 1)), ''),
      'full_name',       b.name,
      'email',           b.email,
      'phone',           b.phone,
      'phone_e164',      replace(b.phone, ' ', ''),
      'class_name',      coalesce(p_cname, b.class_type, 'Reformer Pilates'),
      'class_id',        p_new_class_id,
      'date',            to_char(nd, 'YYYY-MM-DD'),
      'day',             trim(to_char(nd, 'FMDay')),
      'date_pretty',     trim(to_char(nd, 'FMDay FMDD FMMonth')),
      'instructor',      p_instructor,
      'source',          b.source,
      'paid',            b.paid_at is not null and b.refunded_at is null,
      'amount',          case when b.amount_pence is not null then round(b.amount_pence / 100.0, 2) end,
      'cancel_url',      'https://www.padelpower.uk/cancel/?b=' || b.cancel_token,
      'created_at',      b.created_at));
end $$;
revoke execute on function public._notify_booking_moved(public.bookings, text, text, text, text) from public, anon, authenticated;

create or replace function public._notify_class_moved(
  b public.bookings, p_old_time text, p_new_time text, p_date date, p_cname text, p_instructor text)
returns void language plpgsql security definer
set search_path = public, extensions as $$
begin
  perform public._notify_booking_moved(b, p_date::text || '_' || p_old_time, p_date::text || '_' || p_new_time, p_cname, p_instructor);
end $$;

create or replace function public.move_bookings(p_ids uuid[], p_to_class_id text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  to_date date; to_time text; ty text; instr text; cname text;
  maxr int; taken int; n int; b public.bookings;
  moved int := 0; skipped jsonb := '[]'::jsonb; src text;
begin
  if p_to_class_id !~ '^\d{4}-\d{2}-\d{2}_[0-2][0-9]:[0-5][0-9]$' then raise exception 'bad_class'; end if;
  to_date := split_part(p_to_class_id, '_', 1)::date;
  to_time := split_part(p_to_class_id, '_', 2);
  n := coalesce(array_length(p_ids, 1), 0);
  if n = 0 then raise exception 'nothing_to_move'; end if;

  -- destination: a one-off wins over the weekly slot, same as everywhere else
  select cc.type_key, cc.instructor into ty, instr from custom_classes cc
    where cc.class_date = to_date and cc.start_time = to_time;
  if ty is null then
    select tt.type_key, tt.instructor into ty, instr from timetable tt
      where tt.weekday = extract(dow from to_date)::int and tt.start_time = to_time limit 1;
  end if;
  if ty is null then raise exception 'no_such_class'; end if;
  if exists (select 1 from cancelled_classes where class_date = to_date and start_time = to_time) then
    raise exception 'class_cancelled';
  end if;
  if (to_date + to_time::time) <= (now() at time zone 'Europe/London') then raise exception 'class_in_past'; end if;

  select max_riders into maxr from settings where id = 1;
  select count(*) into taken from bookings where class_id = p_to_class_id and cancelled_at is null;
  if taken + n > maxr then raise exception 'class_full'; end if;
  select name into cname from class_types where key = ty;

  for b in select * from bookings where id = any(p_ids) and cancelled_at is null for update loop
    if not (public.pp_is_admin() or public.pp_teaches(b.class_id)) then raise exception 'forbidden'; end if;
    if b.class_id = p_to_class_id then
      skipped := skipped || jsonb_build_object('id', b.id, 'name', b.name, 'reason', 'already_there'); continue;
    end if;
    if b.email <> '' and exists (
      select 1 from bookings x where x.class_id = p_to_class_id and x.cancelled_at is null
        and lower(x.email) = lower(b.email) and x.id <> b.id) then
      skipped := skipped || jsonb_build_object('id', b.id, 'name', b.name, 'reason', 'already_booked'); continue;
    end if;
    src := b.class_id;
    update bookings set class_id = p_to_class_id where id = b.id;
    perform public._notify_booking_moved(b, src, p_to_class_id, cname, instr);
    moved := moved + 1;
  end loop;

  return jsonb_build_object('moved', moved, 'skipped', skipped, 'to', p_to_class_id);
end $$;
revoke execute on function public.move_bookings(uuid[], text) from public, anon;
grant execute on function public.move_bookings(uuid[], text) to authenticated;
