-- ============================================================
-- Padel Power · internal key + automatic refunds on auto-cancel
-- Applied live 2026-09-12 (migration internal_key_and_auto_refunds).
-- Safe to run more than once.
--
-- One shared key, minted here and kept in Vault, lets server-side
-- callers talk to the edge functions without the service role key:
--   Make        -> booking-lookup   (header x-pp-key)
--   this DB     -> refund           (header x-pp-key, via pg_net)
-- Read it with:  select decrypted_secret from vault.decrypted_secrets
--                where name = 'pp_internal_key';
--
-- auto_cancel_under_min no longer walks away from classes with card
-- bookings. It cancels the class (texts fire), marks the bookings
-- cancelled (credits return by trigger), then posts the card bookings
-- to the refund function. pg_net is fire and forget, so
-- retry_class_refunds runs every 15 minutes and re-posts any card
-- booking on a cancelled class that is still unrefunded. The refund
-- function is idempotent, so a repeat is harmless.
-- ============================================================

-- ---- the key ------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'pp_internal_key') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'pp_internal_key',
      'Server-to-server key: Make -> booking-lookup, cron -> refund. Not the service role key.');
  end if;
end $$;

create or replace function public.pp_internal_key_ok(p_key text)
returns boolean language sql stable security definer
set search_path = public, vault as $$
  select coalesce(p_key, '') <> '' and exists (
    select 1 from vault.decrypted_secrets
    where name = 'pp_internal_key' and decrypted_secret = p_key);
$$;
revoke execute on function public.pp_internal_key_ok(text) from public, anon, authenticated;
grant execute on function public.pp_internal_key_ok(text) to service_role;

-- ---- post refunds to the edge function, 20 at a time ---------------
create or replace function public._post_refunds(p_ids uuid[], p_source text default 'auto_cancel')
returns integer language plpgsql security definer
set search_path = public, extensions, vault as $$
declare k text; i int := 1; n int := coalesce(array_length(p_ids, 1), 0); posted int := 0;
begin
  if n = 0 then return 0; end if;
  select decrypted_secret into k from vault.decrypted_secrets where name = 'pp_internal_key';
  if k is null then raise warning 'pp_internal_key missing: refunds not posted'; return 0; end if;
  while i <= n loop
    perform net.http_post(
      url := 'https://bejshhlkatpjcydlokfk.supabase.co/functions/v1/refund',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-pp-key', k),
      body := jsonb_build_object('booking_ids', to_jsonb(p_ids[i:i+19]), 'source', p_source),
      timeout_milliseconds := 20000);
    posted := posted + least(20, n - i + 1);
    i := i + 20;
  end loop;
  return posted;
end $$;
revoke execute on function public._post_refunds(uuid[], text) from public, anon, authenticated;

-- ---- auto-cancel: now refunds card bookings too --------------------
create or replace function public.auto_cancel_under_min(p_dry boolean default false)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  min_r int; opening date;
  now_ldn timestamp := now() at time zone 'Europe/London';
  cls record; cid text; cnt int; card_ids uuid[];
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
  return jsonb_build_object('ran_at', now_ldn, 'min_riders', min_r, 'classes', acted);
end $$;
revoke execute on function public.auto_cancel_under_min(boolean) from public, anon, authenticated;

-- ---- safety net: re-post anything still unrefunded -----------------
-- A card booking on a cancelled class that was closed at or after the
-- class was cancelled and still has no refund. Waits three minutes so
-- the inline post gets a chance first; looks back a week.
create or replace function public.retry_class_refunds()
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare ids uuid[]; posted int;
begin
  select array_agg(b.id) into ids
    from bookings b
    join cancelled_classes cx
      on (cx.class_date::text || '_' || cx.start_time) = b.class_id
    where cx.reason not like 'moved to %'
      and b.cancelled_at is not null
      and b.cancelled_at >= cx.created_at - interval '1 minute'
      and b.cancelled_at between now() - interval '7 days' and now() - interval '3 minutes'
      and b.paid_at is not null and b.refunded_at is null
      and b.payment_intent_id is not null
      and coalesce(b.paid_with, 'card') = 'card';
  posted := _post_refunds(ids, 'retry');
  return jsonb_build_object('ran_at', now(), 'reposted', posted);
end $$;
revoke execute on function public.retry_class_refunds() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'retry-class-refunds') then
    perform cron.schedule('retry-class-refunds', '*/15 * * * *', 'select public.retry_class_refunds()');
  end if;
end $$;
