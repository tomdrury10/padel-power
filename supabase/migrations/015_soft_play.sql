-- ============================================================
-- Padel Power · soft play booking
-- Applied live 2026-09-14 (migration soft_play).
--
-- Joe's brief: a booking system like Pilates. Supervised sessions need a
-- minimum of 3 children and take a maximum of 10, or parents hire the
-- space at £5 per child per hour and supervise themselves.
--
-- Two tables: softplay_sessions (staff put slots on the calendar, each
-- either 'supervised' or 'hire') and softplay_bookings (one row per
-- booking, carrying how many children). A hire slot is exclusive: one
-- booking takes the whole space. Supervised slots fill up to capacity.
--
-- Same rhythm as Pilates: supervised sessions under the minimum are
-- cancelled 24h out (cutoff_hours) with refunds; a session going ahead
-- stays open to book until join_cutoff_hours before. Online cancellation
-- closes at cutoff_hours. Staff are exempt from the cutoffs.
--
-- settings.softplay_open is the master switch: nothing sells online
-- until it is on. softplay_supervised_price_pence stays null until Joe
-- sets it, and supervised sessions cannot be bought while it is null.
-- ============================================================

alter table public.settings
  add column if not exists softplay_open boolean not null default false,
  add column if not exists softplay_min_children integer not null default 3,
  add column if not exists softplay_max_children integer not null default 10,
  add column if not exists softplay_hire_price_pence integer not null default 500,
  add column if not exists softplay_supervised_price_pence integer,
  add column if not exists softplay_min_age integer not null default 3,
  add column if not exists softplay_max_age integer not null default 8;

create table if not exists public.softplay_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  start_time text not null check (start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  duration_min integer not null default 60 check (duration_min between 30 and 240),
  mode text not null check (mode in ('supervised', 'hire')),
  capacity integer not null default 10 check (capacity between 1 and 30),
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancel_reason text,
  unique (session_date, start_time)
);

create table if not exists public.softplay_bookings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.softplay_sessions(id),
  user_id uuid,
  name text not null,
  email text not null default '',
  phone text not null default '',
  children integer not null check (children between 1 and 30),
  child_names text,
  source text not null default 'Online',
  amount_pence integer,
  stripe_session_id text,
  payment_intent_id text,
  paid_at timestamptz,
  refund_id text,
  refunded_at timestamptz,
  cancelled_at timestamptz,
  checked_in_at timestamptz,
  checked_in_by text,
  consent_at timestamptz,
  cancel_token text not null default encode(extensions.gen_random_bytes(12), 'hex'),
  created_at timestamptz not null default now()
);
create unique index if not exists softplay_bookings_session_uidx on public.softplay_bookings (stripe_session_id) where stripe_session_id is not null;
create index if not exists softplay_bookings_session_idx on public.softplay_bookings (session_id);
create index if not exists softplay_bookings_user_idx on public.softplay_bookings (user_id);
create unique index if not exists softplay_bookings_token_uidx on public.softplay_bookings (cancel_token);

-- public headcount per session, no names
create or replace view public.softplay_session_counts with (security_invoker = off) as
  select s.id as session_id,
         coalesce(sum(b.children), 0)::int as children_booked,
         count(b.id)::int as bookings
  from public.softplay_sessions s
  left join public.softplay_bookings b on b.session_id = s.id and b.cancelled_at is null
  group by s.id;
grant select on public.softplay_session_counts to anon, authenticated;

-- ---- booking rules -------------------------------------------------
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

  if r = 'member' then
    if not coalesce(is_open, false) then raise exception 'softplay_closed'; end if;
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

  if r = 'member' then
    hours_left := extract(epoch from ((s.session_date + s.start_time::time) - (now() at time zone 'Europe/London'))) / 3600;
    if hours_left < join_cutoff then raise exception 'cutoff'; end if;
    if s.mode = 'supervised' and hours_left < cutoff and cur < min_c then raise exception 'cutoff'; end if;
  end if;
  return new;
end $$;
drop trigger if exists softplay_bookings_rules on public.softplay_bookings;
create trigger softplay_bookings_rules before insert on public.softplay_bookings
  for each row execute function public.enforce_softplay_rules();

-- ---- Make: booking confirmation ---------------------------------------
create or replace function public.notify_softplay_booking() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  s public.softplay_sessions;
  site text := 'https://www.padelpower.uk';
  hook text := 'https://hook.eu2.make.com/gv6vj6l1s6cdiambazifcxho189o9zo7';
begin
  if new.cancelled_at is not null then return new; end if;
  select * into s from public.softplay_sessions where id = new.session_id;
  perform net.http_post(
    url := hook,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'event',        'softplay_booking_created',
      'booking_id',   new.id,
      'first_name',   split_part(new.name, ' ', 1),
      'full_name',    new.name,
      'email',        new.email,
      'phone',        new.phone,
      'phone_e164',   replace(new.phone, ' ', ''),
      'session_kind', case when s.mode = 'hire' then 'Soft play hire' else 'Supervised soft play session' end,
      'mode',         s.mode,
      'children',     new.children,
      'child_names',  coalesce(new.child_names, ''),
      'date',         to_char(s.session_date, 'YYYY-MM-DD'),
      'day',          trim(to_char(s.session_date, 'FMDay')),
      'date_pretty',  trim(to_char(s.session_date, 'FMDay FMDD FMMonth')),
      'time',         s.start_time,
      'end_time',     to_char((s.session_date + s.start_time::time) + make_interval(mins => s.duration_min), 'HH24:MI'),
      'source',       new.source,
      'paid',         new.paid_at is not null,
      'amount',       case when new.amount_pence is not null then round(new.amount_pence / 100.0, 2) end,
      'cancel_url',   site || '/cancel/?b=' || new.cancel_token,
      'account_url',  site || '/account/',
      'created_at',   new.created_at
    )
  );
  return new;
end $$;
drop trigger if exists softplay_booking_created_webhook on public.softplay_bookings;
create trigger softplay_booking_created_webhook after insert on public.softplay_bookings
  for each row execute function public.notify_softplay_booking();

-- ---- refunds via the refund edge function (internal key) --------------
create or replace function public._post_softplay_refunds(p_ids uuid[], p_source text default 'softplay_cancel')
returns integer language plpgsql security definer
set search_path = public, extensions, vault as $$
declare k text; i int := 1; n int := coalesce(array_length(p_ids, 1), 0); posted int := 0;
begin
  if n = 0 then return 0; end if;
  select decrypted_secret into k from vault.decrypted_secrets where name = 'pp_internal_key';
  if k is null then raise warning 'pp_internal_key missing: soft play refunds not posted'; return 0; end if;
  while i <= n loop
    perform net.http_post(
      url := 'https://bejshhlkatpjcydlokfk.supabase.co/functions/v1/refund',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-pp-key', k),
      body := jsonb_build_object('softplay_booking_ids', to_jsonb(p_ids[i:i+19]), 'source', p_source),
      timeout_milliseconds := 20000);
    posted := posted + least(20, n - i + 1);
    i := i + 20;
  end loop;
  return posted;
end $$;
revoke execute on function public._post_softplay_refunds(uuid[], text) from public, anon, authenticated;

-- ---- cancel a session: texts everyone, closes bookings, refunds cards ----
create or replace function public._cancel_softplay_session(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  s public.softplay_sessions; b record; card_ids uuid[]; n int := 0;
  site text := 'https://www.padelpower.uk';
  hook text := 'https://hook.eu2.make.com/gv6vj6l1s6cdiambazifcxho189o9zo7';
begin
  select * into s from public.softplay_sessions where id = p_id for update;
  if s.id is null then raise exception 'not_found'; end if;
  if s.cancelled_at is not null then return jsonb_build_object('already', true); end if;
  update public.softplay_sessions set cancelled_at = now(), cancel_reason = p_reason where id = p_id;

  for b in select * from public.softplay_bookings where session_id = p_id and cancelled_at is null loop
    n := n + 1;
    perform net.http_post(
      url := hook,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object(
        'event',        'softplay_session_cancelled',
        'booking_id',   b.id,
        'first_name',   split_part(b.name, ' ', 1),
        'full_name',    b.name,
        'email',        b.email,
        'phone',        b.phone,
        'phone_e164',   replace(b.phone, ' ', ''),
        'session_kind', case when s.mode = 'hire' then 'Soft play hire' else 'Supervised soft play session' end,
        'mode',         s.mode,
        'children',     b.children,
        'date',         to_char(s.session_date, 'YYYY-MM-DD'),
        'day',          trim(to_char(s.session_date, 'FMDay')),
        'date_pretty',  trim(to_char(s.session_date, 'FMDay FMDD FMMonth')),
        'time',         s.start_time,
        'source',       b.source,
        'paid',         b.paid_at is not null and b.refunded_at is null,
        'amount',       case when b.amount_pence is not null then round(b.amount_pence / 100.0, 2) end,
        'reason',       p_reason,
        'auto',         p_reason like 'auto:%',
        'account_url',  site || '/account/',
        'created_at',   now()
      ));
  end loop;

  select array_agg(id) into card_ids from public.softplay_bookings
    where session_id = p_id and cancelled_at is null
      and paid_at is not null and refunded_at is null and payment_intent_id is not null;
  update public.softplay_bookings set cancelled_at = now() where session_id = p_id and cancelled_at is null;
  perform public._post_softplay_refunds(card_ids, 'session_cancel');
  return jsonb_build_object('cancelled_bookings', n, 'card_refunds', coalesce(array_length(card_ids, 1), 0));
end $$;
revoke execute on function public._cancel_softplay_session(uuid, text) from public, anon, authenticated;

create or replace function public.cancel_softplay_session(p_id uuid, p_reason text default 'cancelled_by_club')
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.pp_is_admin() then raise exception 'forbidden'; end if;
  return public._cancel_softplay_session(p_id, coalesce(nullif(btrim(p_reason), ''), 'cancelled_by_club'));
end $$;
revoke all on function public.cancel_softplay_session(uuid, text) from public;
grant execute on function public.cancel_softplay_session(uuid, text) to authenticated;

-- ---- 24h decision: supervised sessions under the minimum are cancelled ----
create or replace function public.auto_cancel_softplay(p_dry boolean default false)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  min_c int; cutoff int;
  now_ldn timestamp := now() at time zone 'Europe/London';
  s record; cnt int; acted jsonb := '[]'::jsonb;
begin
  select softplay_min_children, cutoff_hours into min_c, cutoff from public.settings where id = 1;
  for s in
    select x.id, x.session_date, x.start_time from public.softplay_sessions x
    where x.mode = 'supervised' and x.cancelled_at is null
      and (x.session_date + x.start_time::time) > now_ldn
      and (x.session_date + x.start_time::time) <= now_ldn + make_interval(hours => cutoff)
    order by x.session_date, x.start_time
  loop
    select coalesce(sum(children), 0) into cnt from public.softplay_bookings
      where session_id = s.id and cancelled_at is null;
    if cnt >= min_c then continue; end if;
    acted := acted || jsonb_build_object('session_id', s.id, 'when', s.session_date::text || ' ' || s.start_time,
      'action', case when p_dry then 'would_cancel' else 'cancelled' end, 'children', cnt);
    if p_dry then continue; end if;
    perform public._cancel_softplay_session(s.id, 'auto: below minimum (' || cnt || ' booked)');
  end loop;
  return jsonb_build_object('ran_at', now_ldn, 'min_children', min_c, 'sessions', acted);
end $$;
revoke execute on function public.auto_cancel_softplay(boolean) from public, anon, authenticated;

-- safety net: anything still unrefunded on a cancelled session, re-posted
create or replace function public.retry_softplay_refunds()
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare ids uuid[]; posted int;
begin
  select array_agg(b.id) into ids
    from public.softplay_bookings b
    join public.softplay_sessions s on s.id = b.session_id
    where s.cancelled_at is not null
      and b.cancelled_at is not null
      and b.cancelled_at between now() - interval '7 days' and now() - interval '3 minutes'
      and b.paid_at is not null and b.refunded_at is null and b.payment_intent_id is not null;
  posted := public._post_softplay_refunds(ids, 'retry');
  return jsonb_build_object('ran_at', now(), 'reposted', posted);
end $$;
revoke execute on function public.retry_softplay_refunds() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'auto-cancel-softplay') then
    perform cron.schedule('auto-cancel-softplay', '*/15 * * * *', 'select public.auto_cancel_softplay()');
  end if;
  if not exists (select 1 from cron.job where jobname = 'retry-softplay-refunds') then
    perform cron.schedule('retry-softplay-refunds', '*/15 * * * *', 'select public.retry_softplay_refunds()');
  end if;
end $$;

-- ---- check-in (admin) ---------------------------------------------------
create or replace function public.set_softplay_check_in(p_id uuid, p_present boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.softplay_bookings; who text;
begin
  if not public.pp_is_admin() then raise exception 'forbidden'; end if;
  select * into b from public.softplay_bookings where id = p_id;
  if b.id is null then raise exception 'not_found'; end if;
  if b.cancelled_at is not null then raise exception 'booking_cancelled'; end if;
  who := coalesce((select email from auth.users where id = auth.uid()), 'staff');
  update public.softplay_bookings set
    checked_in_at = case when p_present then coalesce(checked_in_at, now()) end,
    checked_in_by = case when p_present then coalesce(checked_in_by, who) end
  where id = p_id returning * into b;
  return jsonb_build_object('id', b.id, 'checked_in_at', b.checked_in_at);
end $$;
revoke all on function public.set_softplay_check_in(uuid, boolean) from public;
grant execute on function public.set_softplay_check_in(uuid, boolean) to authenticated;

-- ---- access -------------------------------------------------------------
alter table public.softplay_sessions enable row level security;
alter table public.softplay_bookings enable row level security;

drop policy if exists "public read softplay sessions" on public.softplay_sessions;
drop policy if exists "admin write softplay sessions" on public.softplay_sessions;
create policy "public read softplay sessions" on public.softplay_sessions
  for select to anon, authenticated using (true);
create policy "admin write softplay sessions" on public.softplay_sessions
  for all to authenticated using (public.pp_is_admin()) with check (public.pp_is_admin());

drop policy if exists "read softplay bookings" on public.softplay_bookings;
drop policy if exists "create softplay booking" on public.softplay_bookings;
drop policy if exists "admin update softplay bookings" on public.softplay_bookings;
drop policy if exists "admin delete softplay bookings" on public.softplay_bookings;
create policy "read softplay bookings" on public.softplay_bookings
  for select to authenticated using (public.pp_is_admin() or user_id = auth.uid());
create policy "create softplay booking" on public.softplay_bookings
  for insert to authenticated with check (cancelled_at is null and (public.pp_is_admin() or user_id = auth.uid()));
create policy "admin update softplay bookings" on public.softplay_bookings
  for update to authenticated using (public.pp_is_admin()) with check (public.pp_is_admin());
create policy "admin delete softplay bookings" on public.softplay_bookings
  for delete to authenticated using (public.pp_is_admin());

grant select on public.softplay_sessions to anon, authenticated;
grant insert, update, delete on public.softplay_sessions to authenticated;
grant select on public.softplay_bookings to authenticated;
grant insert (session_id, name, email, phone, children, child_names, source, user_id, consent_at) on public.softplay_bookings to authenticated;
grant update (cancelled_at) on public.softplay_bookings to authenticated;
grant delete on public.softplay_bookings to authenticated;
