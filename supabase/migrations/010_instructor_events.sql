-- ============================================================
-- Padel Power · instructor notifications speak the router's language
-- Applied live 2026-09-13 (migration instructor_events_same_shape).
--
-- Every payload to Make carries an `event` key and the same field names
-- as the member events. The instructor's mobile comes from the
-- instructors table (Studio Manager), so Make no longer needs its own
-- lookup chain or data store. See docs/make-events.md for the contract.
--
--   instructor_class_cancelled   any cancellation, auto or by staff
--   instructor_class_moved       a single date moved to a new time
-- ============================================================

create or replace function public.notify_instructor_cancelled()
returns trigger language plpgsql security definer
set search_path = public, extensions as $$
declare
  hook text := 'https://hook.eu2.make.com/gv6vj6l1s6cdiambazifcxho189o9zo7';
  v_name text; v_type text; v_email text; v_phone text; cname text;
  moved boolean := new.reason like 'moved to %';
  new_time text := case when moved then substr(new.reason, length('moved to ') + 1) end;
begin
  select instructor, type_key into v_name, v_type from public.custom_classes
    where class_date = new.class_date and start_time = new.start_time;
  if v_name is null then
    select instructor, type_key into v_name, v_type from public.timetable
      where weekday = extract(dow from new.class_date)::int and start_time = new.start_time
      limit 1;
  end if;
  if coalesce(v_name, '') = '' then return new; end if;

  select email, phone into v_email, v_phone from public.instructors
    where lower(name) = lower(v_name) and active limit 1;
  select name into cname from public.class_types where key = v_type;

  perform net.http_post(
    url := hook,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'event',       case when moved then 'instructor_class_moved' else 'instructor_class_cancelled' end,
      'instructor',  v_name,
      'first_name',  split_part(v_name, ' ', 1),
      'full_name',   v_name,
      'email',       v_email,
      'phone',       v_phone,
      'phone_e164',  nullif(replace(coalesce(v_phone, ''), ' ', ''), ''),
      'class_name',  coalesce(cname, 'Reformer Pilates'),
      'class_id',    new.class_date::text || '_' || new.start_time,
      'date',        to_char(new.class_date, 'YYYY-MM-DD'),
      'day',         trim(to_char(new.class_date, 'FMDay')),
      'date_pretty', trim(to_char(new.class_date, 'FMDay FMDD FMMonth')),
      'time',        case when moved then new_time else new.start_time end,
      'old_time',    case when moved then new.start_time end,
      'reason',      coalesce(nullif(new.reason, ''), 'cancelled_by_studio'),
      'auto',        new.reason like 'auto:%',
      'created_at',  new.created_at
    )
  );
  return new;
end $$;
