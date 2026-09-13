-- ============================================================
-- Padel Power · league registration + weekly billing
-- Applied live 2026-09-13 (migration padel_leagues). Safe to re-run.
--
-- Every player registers individually against a league. Membership is
-- matched against an allowlist staff keep (league_members) until a real
-- lookup exists; no self-declaring. The weekly price is fixed at
-- registration and only an admin can change it, and only before the
-- first payment. Doubles players are joined through a partner code into
-- a league_pairs row. Billing is a Stripe subscription created by the
-- webhook once the card is saved; nothing is charged at sign-up.
--
-- The full SQL is the one applied through the Supabase MCP; it is kept
-- here verbatim so the repo matches the database.
-- ============================================================

create table if not exists public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 2 and 60),
  kind text not null check (kind in ('singles', 'doubles')),
  member_price_pence integer check (member_price_pence is null or member_price_pence between 100 and 20000),
  nonmember_price_pence integer check (nonmember_price_pence is null or nonmember_price_pence between 100 and 20000),
  season_start date,
  weeks integer check (weeks is null or weeks between 1 and 52),
  registration_open boolean not null default false,
  playtomic_url text,
  stripe_product_id text,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);

insert into public.leagues (name, kind, sort) values
  ('Men''s Doubles', 'doubles', 1),
  ('Women''s Doubles', 'doubles', 2),
  ('Men''s Singles', 'singles', 3),
  ('Women''s Singles', 'singles', 4),
  ('Daytime Mixed Doubles', 'doubles', 5)
on conflict (name) do nothing;

-- staff-kept list of club members, matched by email or mobile
create table if not exists public.league_members (
  id uuid primary key default gen_random_uuid(),
  email text check (email is null or email = lower(btrim(email))),
  phone text,
  note text,
  created_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);

create table if not exists public.league_pairs (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  created_at timestamptz not null default now()
);

create table if not exists public.league_registrations (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  email text not null,
  phone text not null,
  playtomic_url text not null,
  membership_status text not null check (membership_status in ('member', 'non_member', 'review')),
  membership_checked_at timestamptz not null default now(),
  weekly_price_pence integer not null check (weekly_price_pence between 100 and 20000),
  terms_accepted_at timestamptz,
  stripe_customer_id text,
  stripe_setup_session_id text,
  stripe_payment_method_id text,
  stripe_subscription_id text,
  card_status text not null default 'pending' check (card_status in ('pending', 'authorised', 'failed')),
  card_label text,
  pair_id uuid references public.league_pairs(id),
  partner_code text not null unique default encode(extensions.gen_random_bytes(5), 'hex'),
  playtomic_added_at timestamptz,
  last_payment_status text,
  last_payment_at timestamptz,
  payments_taken integer not null default 0,
  billing_ended_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists league_reg_one_live_per_league
  on public.league_registrations (league_id, user_id) where cancelled_at is null;
create index if not exists league_reg_pair_idx on public.league_registrations (pair_id);
create index if not exists league_reg_sub_idx on public.league_registrations (stripe_subscription_id);

create table if not exists public.league_audit (
  id bigint generated always as identity primary key,
  registration_id uuid references public.league_registrations(id) on delete cascade,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  actor uuid,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists stripe_customer_id text;

-- ---- row security ---------------------------------------------------
alter table public.leagues enable row level security;
alter table public.league_members enable row level security;
alter table public.league_pairs enable row level security;
alter table public.league_registrations enable row level security;
alter table public.league_audit enable row level security;

drop policy if exists leagues_read on public.leagues;
create policy leagues_read on public.leagues for select using (true);
drop policy if exists leagues_admin on public.leagues;
create policy leagues_admin on public.leagues for all using (pp_is_admin()) with check (pp_is_admin());

drop policy if exists league_members_staff on public.league_members;
create policy league_members_staff on public.league_members for select using (pp_is_staff());
drop policy if exists league_members_admin on public.league_members;
create policy league_members_admin on public.league_members for all using (pp_is_admin()) with check (pp_is_admin());

-- a member sees their own registration and their partner's, staff see all
create or replace function public.pp_my_pair_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select pair_id from public.league_registrations
  where user_id = auth.uid() and pair_id is not null;
$$;

drop policy if exists league_reg_read on public.league_registrations;
create policy league_reg_read on public.league_registrations for select
  using (pp_is_staff() or user_id = auth.uid() or pair_id in (select pp_my_pair_ids()));
-- writes go through the edge function (service role) or the admin functions below

drop policy if exists league_pairs_read on public.league_pairs;
create policy league_pairs_read on public.league_pairs for select
  using (pp_is_staff() or id in (select pp_my_pair_ids()));

drop policy if exists league_audit_staff on public.league_audit;
create policy league_audit_staff on public.league_audit for select using (pp_is_staff());

-- ---- helpers --------------------------------------------------------
create or replace function public.league_touch() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists league_reg_touch on public.league_registrations;
create trigger league_reg_touch before update on public.league_registrations
  for each row execute function public.league_touch();

-- digits only, UK leading 0 becomes +44, so 07786... and +44 7786... match
create or replace function public.pp_phone_key(p text) returns text
language sql immutable as $$
  select case
    when p is null then null
    when regexp_replace(p, '\D', '', 'g') ~ '^0' then '44' || substr(regexp_replace(p, '\D', '', 'g'), 2)
    else regexp_replace(p, '\D', '', 'g') end;
$$;

create or replace function public.league_membership_check(p_email text, p_phone text) returns text
language sql stable security definer set search_path = public as $$
  select case when exists (
    select 1 from public.league_members m
    where (m.email is not null and m.email = lower(btrim(coalesce(p_email, ''))))
       or (m.phone is not null and pp_phone_key(m.phone) = pp_phone_key(p_phone)))
  then 'member' else 'non_member' end;
$$;
revoke execute on function public.league_membership_check(text, text) from public, anon, authenticated;

create or replace function public.league_log(p_reg uuid, p_action text, p_detail jsonb default '{}'::jsonb, p_actor uuid default null)
returns void language sql security definer set search_path = public as $$
  insert into public.league_audit (registration_id, action, detail, actor)
  values (p_reg, p_action, coalesce(p_detail, '{}'::jsonb), p_actor);
$$;
revoke execute on function public.league_log(uuid, text, jsonb, uuid) from public, anon, authenticated;

-- ---- admin actions that never touch Stripe --------------------------
create or replace function public.league_mark_playtomic(p_reg uuid, p_added boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not pp_is_admin() then raise exception 'forbidden'; end if;
  update league_registrations set playtomic_added_at = case when p_added then now() end where id = p_reg;
  perform league_log(p_reg, case when p_added then 'playtomic_added' else 'playtomic_unmarked' end, '{}'::jsonb, auth.uid());
end $$;

create or replace function public.league_link_pair(p_a uuid, p_b uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare a league_registrations; b league_registrations; pid uuid;
begin
  if not pp_is_admin() then raise exception 'forbidden'; end if;
  select * into a from league_registrations where id = p_a for update;
  select * into b from league_registrations where id = p_b for update;
  if a.id is null or b.id is null then raise exception 'not_found'; end if;
  if a.league_id <> b.league_id then raise exception 'league_mismatch'; end if;
  if a.user_id = b.user_id then raise exception 'same_player'; end if;
  if a.pair_id is not null or b.pair_id is not null then raise exception 'already_paired'; end if;
  insert into league_pairs (league_id) values (a.league_id) returning id into pid;
  update league_registrations set pair_id = pid where id in (p_a, p_b);
  perform league_log(p_a, 'partner_linked', jsonb_build_object('partner', p_b, 'by', 'admin'), auth.uid());
  perform league_log(p_b, 'partner_linked', jsonb_build_object('partner', p_a, 'by', 'admin'), auth.uid());
  return pid;
end $$;

create or replace function public.league_unlink(p_reg uuid)
returns void language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  if not pp_is_admin() then raise exception 'forbidden'; end if;
  select pair_id into pid from league_registrations where id = p_reg;
  if pid is null then return; end if;
  update league_registrations set pair_id = null where pair_id = pid;
  delete from league_pairs where id = pid;
  perform league_log(p_reg, 'partner_unlinked', '{}'::jsonb, auth.uid());
end $$;

-- called by the edge function (service role) when a partner code is used
create or replace function public.league_join_by_code(p_reg uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me league_registrations; them league_registrations; pid uuid; n int;
begin
  select * into me from league_registrations where id = p_reg for update;
  select * into them from league_registrations
    where partner_code = lower(btrim(p_code)) and cancelled_at is null for update;
  if them.id is null then return jsonb_build_object('ok', false, 'reason', 'code_not_found'); end if;
  if them.user_id = me.user_id then return jsonb_build_object('ok', false, 'reason', 'own_code'); end if;
  if them.league_id <> me.league_id then return jsonb_build_object('ok', false, 'reason', 'league_mismatch'); end if;
  if me.pair_id is not null then return jsonb_build_object('ok', false, 'reason', 'already_paired'); end if;
  if them.pair_id is not null then
    select count(*) into n from league_registrations where pair_id = them.pair_id and cancelled_at is null;
    if n >= 2 then return jsonb_build_object('ok', false, 'reason', 'partner_taken'); end if;
    pid := them.pair_id;
  else
    insert into league_pairs (league_id) values (me.league_id) returning id into pid;
    update league_registrations set pair_id = pid where id = them.id;
  end if;
  update league_registrations set pair_id = pid where id = me.id;
  perform league_log(me.id, 'partner_linked', jsonb_build_object('partner', them.id, 'by', 'code'));
  perform league_log(them.id, 'partner_linked', jsonb_build_object('partner', me.id, 'by', 'code'));
  return jsonb_build_object('ok', true, 'pair_id', pid, 'partner_name', them.name);
end $$;
revoke execute on function public.league_join_by_code(uuid, text) from public, anon, authenticated;

-- the id embedded in a Playtomic share link, when there is one, so a later
-- enrolment call has it without parsing the link again (applied 2026-09-13)
alter table public.league_registrations add column if not exists playtomic_player_id text;
