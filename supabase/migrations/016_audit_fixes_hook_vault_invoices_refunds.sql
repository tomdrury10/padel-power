-- ============================================================
-- 016 · Padel Power security audit fixes
-- Applied live 15 Sept 2026 (migration make_hook_vault_invoice_idempotency_orphan_refunds).
--
-- 1. The Make webhook address moves into Vault (secret pp_make_hook) and every
--    function that used to embed it now calls pp_make_hook(). The old address
--    was served publicly from the website, so it was rotated. The secret value
--    is deliberately NOT in this file: it was inserted by hand with
--      select vault.create_secret('<url>', 'pp_make_hook', '...');
--    To rotate again: create a new Make hook, point the scenario at it, then
--      select vault.update_secret((select id from vault.secrets where name = 'pp_make_hook'), '<new url>');
-- 2. League invoices are recorded once per invoice id, so a redelivered Stripe
--    event cannot double-count a payment and a late failure notice cannot
--    overwrite a success.
-- 3. A paid checkout the webhook had to cancel on the spot (class full etc.)
--    whose refund did not complete is re-posted for refund every 15 minutes.
-- ============================================================

create or replace function public.pp_make_hook()
returns text language sql security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'pp_make_hook';
$$;
revoke execute on function public.pp_make_hook() from public, anon, authenticated;
grant execute on function public.pp_make_hook() to service_role;

-- rewrite every live function that embeds a hook address, exactly as it is
-- deployed, swapping the literal for the Vault lookup
do $$
declare r record; src text; n int := 0;
begin
  for r in
    select p.oid, p.proname from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.prokind = 'f'
      and pg_get_functiondef(p.oid) like '%hook.eu2.make.com%'
  loop
    src := pg_get_functiondef(r.oid);
    src := regexp_replace(src, '''https://hook\.eu2\.make\.com/[A-Za-z0-9_]+''', 'public.pp_make_hook()', 'g');
    execute src;
    n := n + 1;
  end loop;
  raise notice 'rewrote % functions', n;
end $$;

-- ---- 2. one record per league invoice --------------------------------
create table if not exists public.league_invoice_events (
  id bigint generated always as identity primary key,
  registration_id uuid not null references public.league_registrations(id) on delete cascade,
  invoice_id text not null,
  status text not null check (status in ('paid', 'failed')),
  attempt integer not null default 0,
  amount_pence integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists league_invoice_events_uidx
  on public.league_invoice_events (invoice_id, status, attempt);
alter table public.league_invoice_events enable row level security;
drop policy if exists league_invoice_events_admin_read on public.league_invoice_events;
create policy league_invoice_events_admin_read on public.league_invoice_events
  for select using (public.pp_is_admin());

create or replace function public.league_record_invoice(
  p_reg uuid, p_invoice text, p_status text, p_amount_pence integer default 0, p_attempt integer default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inserted int; taken int;
begin
  if p_status not in ('paid', 'failed') then raise exception 'bad_status'; end if;
  if p_invoice is null or p_invoice = '' then raise exception 'bad_invoice'; end if;
  -- serialise concurrent deliveries for the same registration
  perform 1 from league_registrations where id = p_reg for update;
  if not found then return jsonb_build_object('recorded', false, 'reason', 'no_registration'); end if;
  -- a failure notice for an invoice that has already been paid is stale
  if p_status = 'failed' and exists (
      select 1 from league_invoice_events where invoice_id = p_invoice and status = 'paid') then
    return jsonb_build_object('recorded', false, 'reason', 'already_paid');
  end if;
  insert into league_invoice_events (registration_id, invoice_id, status, attempt, amount_pence)
    values (p_reg, p_invoice, p_status,
            case when p_status = 'paid' then 0 else coalesce(p_attempt, 0) end,
            coalesce(p_amount_pence, 0))
    on conflict (invoice_id, status, attempt) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then return jsonb_build_object('recorded', false, 'reason', 'duplicate'); end if;

  if p_status = 'paid' then
    update league_registrations
       set payments_taken = payments_taken + 1, last_payment_status = 'paid',
           last_payment_at = now(), card_status = 'authorised'
     where id = p_reg returning payments_taken into taken;
    perform league_log(p_reg, 'payment_collected',
      jsonb_build_object('amount_pence', p_amount_pence, 'invoice', p_invoice, 'number', taken), null);
  else
    update league_registrations
       set last_payment_status = 'failed', last_payment_at = now(), card_status = 'failed'
     where id = p_reg returning payments_taken into taken;
    perform league_log(p_reg, 'payment_failed',
      jsonb_build_object('amount_pence', p_amount_pence, 'invoice', p_invoice, 'attempt', p_attempt), null);
  end if;
  return jsonb_build_object('recorded', true, 'payments_taken', taken);
end $$;
revoke execute on function public.league_record_invoice(uuid, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.league_record_invoice(uuid, text, text, integer, integer) to service_role;

-- ---- 3. refunds the webhook could not complete ------------------------
-- The webhook cancels a paid checkout on the spot when the class or session
-- is no longer bookable. If Stripe did not confirm the refund the row is left
-- cancelled + unrefunded; this re-posts it to the refund function (idempotent)
-- until it is done. Such rows are cancelled within moments of being created,
-- which is what separates them from a member's own later cancellation.
create or replace function public.retry_orphan_refunds()
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare ids uuid[]; sp uuid[]; a int := 0; b int := 0;
begin
  select array_agg(id) into ids from bookings
    where cancelled_at is not null and paid_at is not null and refunded_at is null
      and payment_intent_id is not null and coalesce(paid_with, 'card') = 'card'
      and cancelled_at - created_at < interval '2 minutes'
      and cancelled_at between now() - interval '7 days' and now() - interval '3 minutes';
  select array_agg(id) into sp from softplay_bookings
    where cancelled_at is not null and paid_at is not null and refunded_at is null
      and payment_intent_id is not null
      and cancelled_at - created_at < interval '2 minutes'
      and cancelled_at between now() - interval '7 days' and now() - interval '3 minutes';
  if ids is not null and array_length(ids, 1) > 0 then a := _post_refunds(ids, 'orphan_retry'); end if;
  if sp is not null and array_length(sp, 1) > 0 then b := _post_softplay_refunds(sp, 'orphan_retry'); end if;
  return jsonb_build_object('ran_at', now(), 'class', a, 'softplay', b);
end $$;
revoke execute on function public.retry_orphan_refunds() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'retry-orphan-refunds') then
    perform cron.schedule('retry-orphan-refunds', '*/15 * * * *', 'select public.retry_orphan_refunds()');
  end if;
end $$;
