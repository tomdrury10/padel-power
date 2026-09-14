-- ============================================================
-- Padel Power · instructor mobile numbers
-- Applied live 2026-09-14.
--
-- Puts each Pilates instructor's mobile on their row in the
-- Studio Manager (instructors table) so the cancellation and
-- move triggers (see 010_instructor_events.sql) send them a
-- text instead of falling back to an email to Tom.
--
-- Safe to run more than once. Only touches the four named rows.
-- ============================================================

update public.instructors set phone = v.phone
from (values
  ('Verity Game',      '+44 7443 518801'),
  ('Laura Allanson',   '+44 7841 530030'),
  ('Gabby Deere',      '+44 7714 245888'),
  ('Christie Manning', '+44 7885 619922')
) as v(name, phone)
where lower(public.instructors.name) = lower(v.name);
