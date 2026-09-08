-- Padel Power: point the instructor cancellation trigger at the live
-- Make webhook, and add the two missing instructors.
-- Run in the Supabase SQL editor. Safe to run more than once.

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
    url := 'https://hook.eu2.make.com/gv6vj6l1s6cdiambazifcxho189o9zo7',
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

-- Add the missing instructors (fill contact details in Settings > Instructors)
insert into public.instructors (name, hourly_rate_pence)
values ('Christie Manning', 4000), ('Verity', 4000)
on conflict (name) do nothing;
