-- ============================================================
-- Padel Power · membership from Playtomic benefits
-- Applied live 2026-09-14 (migration league_membership_from_playtomic).
--
-- Playtomic's third-party API returns each venue player's "benefits";
-- the club's memberships live there. Which benefits count as a member
-- for league pricing is a staff decision, kept in this table and edited
-- from the Leagues page. The manual league_members list stays as an
-- override for anyone Playtomic does not know about.
-- ============================================================

create table if not exists public.league_member_benefits (
  benefit_id text primary key,
  name text not null,
  counts boolean not null default true,
  seen_at timestamptz not null default now()
);
alter table public.league_member_benefits enable row level security;
drop policy if exists lmb_staff_read on public.league_member_benefits;
create policy lmb_staff_read on public.league_member_benefits for select using (pp_is_staff());
drop policy if exists lmb_admin_write on public.league_member_benefits;
create policy lmb_admin_write on public.league_member_benefits for all using (pp_is_admin()) with check (pp_is_admin());

insert into public.league_member_benefits (benefit_id, name, counts) values
  ('bd87f0da-7f9b-488a-bac0-59512b58ac7a', '🎾 Padel Power Full Membership', true),
  ('e48718bd-a12e-4953-a2bf-ed95b5012780', 'Padel Power Concession Members ⭐', true),
  ('44753b76-4ee0-4664-b85b-bffbaba89445', 'Founders Membership 2026', true)
on conflict (benefit_id) do nothing;

alter table public.league_registrations
  add column if not exists playtomic_found boolean,
  add column if not exists playtomic_benefits jsonb not null default '[]'::jsonb,
  add column if not exists membership_source text
    check (membership_source is null or membership_source in ('playtomic', 'list', 'none', 'admin'));

create or replace function public.league_note_benefits(p_benefits jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.league_member_benefits (benefit_id, name, counts)
  select b->>'benefit_id', coalesce(b->>'name', b->>'benefit_id'), false
  from jsonb_array_elements(coalesce(p_benefits, '[]'::jsonb)) b
  where b->>'benefit_id' is not null
  on conflict (benefit_id) do update set name = excluded.name, seen_at = now();
$$;
revoke execute on function public.league_note_benefits(jsonb) from public, anon, authenticated;
