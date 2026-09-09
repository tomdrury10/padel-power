-- ============================================================
-- Padel Power · password reset by text
-- Applied to the Padel Power project on 2026-09-09 via MCP.
-- Safe to run more than once.
--
-- Members reset their password from a link texted to the mobile they
-- have already proved, instead of an emailed link. That matters here
-- because auth email still goes through Supabase's shared testing
-- sender, which refuses everything after about two messages an hour.
-- With this in place nothing in the member journey touches email.
--
-- Only accounts with a VERIFIED mobile can use it. Staff have no
-- verified mobile on file, so they still reset by email or by hand.
--
-- The token is high entropy (32 random bytes) and goes in a URL, so it
-- is stored as a plain sha256 digest rather than bcrypt: bcrypt exists
-- to slow down guessing of low entropy secrets, and there is nothing to
-- guess here.
-- ============================================================

create table if not exists public.password_resets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_hash text not null unique,
  phone text not null,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists password_resets_user_idx
  on public.password_resets (user_id, created_at desc);

alter table public.password_resets enable row level security;
-- nobody reads this over the API. The edge function uses the service
-- role; members and staff have no business seeing reset tokens at all.
revoke all on public.password_resets from anon, authenticated;

alter table public.settings add column if not exists sms_reset_template text not null default
  'Padel Power: tap to set a new password. The link works once and expires in 15 minutes.

{link}';
alter table public.settings add column if not exists reset_link_minutes integer not null default 15
  check (reset_link_minutes between 5 and 120);

-- ------------------------------------------------------------------
-- issue: look the account up by email, refuse unless the mobile is
-- proved, rate limit, store the digest. Returns the phone so the edge
-- function knows where to send. The CALLER must return the same
-- response to the browser whatever comes back here, so the page never
-- reveals whether an address has an account.
-- ------------------------------------------------------------------
create or replace function public.issue_password_reset(p_email text, p_token text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare
  uid uuid; ph text; verified timestamptz; mins int; last_at timestamptz; n int;
begin
  select u.id into uid from auth.users u
    where lower(u.email) = lower(btrim(p_email)) limit 1;
  if uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_account');
  end if;

  select phone, phone_verified_at into ph, verified from profiles where user_id = uid;
  if verified is null or coalesce(btrim(ph), '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_verified_phone');
  end if;

  -- a reset link is an account takeover if it lands in the wrong hands,
  -- so these limits are tighter than the verification code ones
  select max(created_at) into last_at from password_resets where user_id = uid;
  if last_at is not null and last_at > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'cooldown');
  end if;
  select count(*) into n from password_resets
    where user_id = uid and created_at > now() - interval '1 hour';
  if n >= 3 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  select reset_link_minutes into mins from settings where id = 1;

  -- any earlier link for this account stops working the moment a new
  -- one is issued, so only the newest text is ever live
  update password_resets set used_at = now()
    where user_id = uid and used_at is null and expires_at > now();

  insert into password_resets (user_id, phone, token_hash, expires_at)
    values (uid, ph, encode(extensions.digest(p_token, 'sha256'), 'hex'),
            now() + make_interval(mins => mins));

  return jsonb_build_object('ok', true, 'user_id', uid, 'phone', ph, 'minutes', mins);
end $$;

-- ------------------------------------------------------------------
-- consume: single use. Locks the row, marks it spent, hands back the
-- account so the edge function can set the new password.
-- ------------------------------------------------------------------
create or replace function public.consume_password_reset(p_token text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare r password_resets; em text;
begin
  select * into r from password_resets
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if r.used_at is not null then return jsonb_build_object('ok', false, 'reason', 'used'); end if;
  if r.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;

  update password_resets set used_at = now() where id = r.id;
  select email into em from auth.users where id = r.user_id;
  return jsonb_build_object('ok', true, 'user_id', r.user_id, 'email', em);
end $$;

-- peek without spending it, so the page can say who it is for before
-- they type a new password
create or replace function public.peek_password_reset(p_token text)
returns jsonb language plpgsql security definer
set search_path = public, extensions as $$
declare r password_resets; em text;
begin
  select * into r from password_resets
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if not found or r.used_at is not null or r.expires_at <= now() then
    return jsonb_build_object('ok', false);
  end if;
  select email into em from auth.users where id = r.user_id;
  return jsonb_build_object('ok', true, 'email', em);
end $$;

revoke execute on function public.issue_password_reset(text, text) from public, anon, authenticated;
revoke execute on function public.consume_password_reset(text) from public, anon, authenticated;
revoke execute on function public.peek_password_reset(text) from public, anon, authenticated;
