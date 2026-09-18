-- 025: Kids Zone launch, Saturday 26 September 2026.
--
-- Jimmy's sign-off changes: ages 1 to 6 (every child toilet trained),
-- no minimum number of children for a supervised session to go ahead,
-- and online booking switched on so the opening weekend can be booked.
--
-- softplay_min_children = 0 is safe everywhere it is read: the checkout
-- function, enforce_softplay_rules and auto_cancel_softplay all compare
-- booked < min, which never fires at 0, so nothing is auto-cancelled.

alter table public.settings
  alter column softplay_min_children set default 0,
  alter column softplay_min_age set default 1,
  alter column softplay_max_age set default 6;

update public.settings
   set softplay_min_children = 0,
       softplay_min_age = 1,
       softplay_max_age = 6,
       softplay_open = true
 where id = 1;
