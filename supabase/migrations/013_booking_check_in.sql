-- ============================================================
-- Padel Power · class check-in
-- Applied live 2026-09-14 (migration booking_check_in).
--
-- Joe: "a check in button on the admin side so the instructors can
-- confirm who's here". Instructors have no write access to bookings
-- (migration 006), so the tick goes through a security-definer RPC that
-- allows an admin or the class's own instructor and nobody else.
-- A booking left unticked after the class is the no-show record.
-- ============================================================

alter table public.bookings
  add column if not exists checked_in_at timestamptz,
  add column if not exists checked_in_by text;

create or replace function public.set_check_in(p_id uuid, p_present boolean)
returns jsonb language plpgsql security definer
set search_path = public as $$
declare
  b public.bookings;
  who text;
begin
  select * into b from public.bookings where id = p_id;
  if b.id is null then raise exception 'not_found'; end if;
  if b.cancelled_at is not null then raise exception 'booking_cancelled'; end if;
  if not (public.pp_is_admin() or public.pp_teaches(b.class_id)) then
    raise exception 'forbidden';
  end if;
  who := coalesce(public.pp_my_instructor_name(),
                  (select email from auth.users where id = auth.uid()),
                  'staff');
  update public.bookings set
    checked_in_at = case when p_present then coalesce(checked_in_at, now()) end,
    checked_in_by = case when p_present then coalesce(checked_in_by, who) end
  where id = p_id
  returning * into b;
  return jsonb_build_object('id', b.id, 'checked_in_at', b.checked_in_at, 'checked_in_by', b.checked_in_by);
end $$;

revoke all on function public.set_check_in(uuid, boolean) from public;
grant execute on function public.set_check_in(uuid, boolean) to authenticated;
