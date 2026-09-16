# Plan: league registration windows, returning-player head start, auto-close when full, league texts

## Goal

Joe's rules for league registration on the site, plus the missing league SMS:

1. Registration opens automatically **21 days before the league start date set in Playtomic**.
2. **Returning players** get a **5-day head start** (opens 26 days before the start for them).
3. Registration closes automatically at **Playtomic's enrolment end date**, or earlier when the
   league is **full**, and reopens by itself if a space frees up while the window is still open.
4. Opening is fully automatic, but staff keep a manual override per league (Auto / Force open /
   Force closed).
5. Players get a text when their registration is confirmed (card saved) and when staff cancel it.

## Decisions (Tom, 16 Sept 2026)

- Returning player = has an **active team** (not left/removed) in a Padel Power Playtomic league
  that is in progress, or finished with an end date in the last 4 months. Matched by the player id
  in the Playtomic profile link they paste. Each registrant is checked individually (both partners
  of a doubles pair must qualify to register during the head start).
- Close time = Playtomic `registration_info.enrolment_end_date`.
- Reopen automatically when space frees (only while the window is open and the override is Auto).
- Fully automatic, with a manual override kept.

## Evidence (live, 16 Sept 2026)

- `GET https://manager.playtomic.io/api/v1/leagues?tenant_id=T&status=...` returns, per league:
  `league_start_date` / `league_end_date` (UTC, no zone suffix: the Oct leagues show
  `2026-10-18T23:00:00`, i.e. 19 Oct 00:00 London), `registration_info.enrolment_start_date`,
  `enrolment_end_date` (`2026-10-18T06:00:00`), `registration_status` (UPCOMING/OPEN/CLOSED),
  `number_of_groups`, `teams_per_group`, `players_per_team`, and `registered_teams[]` with
  `team_id`, `players[{user_id,...}]`, `registered_info{registration_date, leaving_date,
  leaving_reason}`.
- Capacity = `number_of_groups * teams_per_group`. Active teams = `leaving_reason` null.
  Check: Men's Doubles S5 has 120 active of 120 (plus 16 left/removed).
- **Write test passed:** a manager `POST /api/v1/leagues/{id}/teams` into Men's Singles S3
  (PENDING, enrolment UPCOMING until 17 Oct) returned 200 with a team id; `DELETE` returned 200.
  So enrolment works before Playtomic's own window opens; no change needed in `league-enrol`.
- **Bug found:** `playtomic-sync` stores `league_start_date.slice(0,10)`, so the five October
  leagues have `season_start = 2026-10-18` instead of 19 Oct. Billing (`T07:00Z` on that date) and
  the new window would be a day early.
- Current code: `leagueOpen()` in `league-register` and `open()` in `assets/league-register.js`
  use `registration_open && prices && season_start && weeks`. `leagues` is world-readable (RLS
  `using (true)`). Admin checkbox writes `registration_open`. Sync sets `registration_open=false,
  playtomic_status='GONE'` for leagues no longer listed.
- Make master scenario 9736516 routes on `{{2.event}}`; league route exists only for
  `league_payment_failed`; last route is a catch-all email to Tom listing every routed event with
  `text:notequal`.

## Approach

### Database: `supabase/migrations/021_league_windows.sql`

Columns on `leagues`:
- `registration_mode text not null default 'auto' check in ('auto','open','closed')`
- `enrolment_end_at timestamptz` (from Playtomic)
- `capacity_teams integer` (groups x teams per group)
- `playtomic_active_teams integer` (synced)
- `opens_at timestamptz` (optional staff override of the general opening time)

Data: every existing league gets `registration_mode = case when registration_open then 'open' else 'auto' end`,
except leagues named like `%test%` which get `'closed'`. `registration_open` is kept (not dropped)
but no longer read; a comment marks it deprecated.

Table `league_returning_players(player_id text primary key, last_league_id text, seen_at timestamptz)`,
RLS on, no policies (service role only). Holds ids only, no names.

Function `league_state(p_league uuid) returns text` (stable, security definer, granted to anon and
authenticated because the result is public information): one of
`closed | not_yet | early | open | full`, computed from:
- missing price/weeks/start, or `playtomic_status = 'GONE'`, or mode `closed` -> `closed`
- mode `open` -> `open` (force open ignores dates and capacity)
- `general_open = coalesce(opens_at, (season_start::timestamp at time zone 'Europe/London') - interval '21 days')`
- `early_open = general_open - interval '5 days'`
- `close_at = coalesce(enrolment_end_at, season_start::timestamp at time zone 'Europe/London')`
- now >= close_at -> `closed`; now < early_open -> `not_yet`
- full check (only in auto): `taken >= capacity_teams` -> `full`, where
  `taken = coalesce(playtomic_active_teams,0) + local_waiting`,
  `local_waiting` = our registrations for that league with `cancelled_at is null`,
  `card_status = 'authorised'`, `playtomic_team_id is null`, counting a doubles pair once and an
  unpaired doubles registration once. If `capacity_teams` is null, never full.
- now < general_open -> `early`; else `open`.

Function `league_windows(p_league uuid)` returning `general_open, early_open, close_at` for display
(same grants), so the page and admin show dates computed in one place.

`league_upsert_from_playtomic` gains `p_enrol_end timestamptz, p_capacity int, p_active int` and
now **sets `season_start = p_start` whenever no registration for that league has a Stripe
subscription** (Playtomic is the source of truth for the start date until billing is scheduled;
after that it is left alone and a mismatch is reported in the sync response).
One-off data fix: the five October leagues' `season_start` becomes 2026-10-19 via the corrected sync.

`league_note_returning(p_ids text[], p_league text)` upserts ids with `seen_at = now()`;
rows older than 4 months are deleted at the end of each sync.

### Sync: `supabase/functions/playtomic-sync/index.ts`

- Start date: convert `league_start_date` (treated as UTC) to the Europe/London calendar date
  (`Intl.DateTimeFormat('en-CA', {timeZone:'Europe/London'})`).
- Send `enrolment_end_date` (UTC) as `p_enrol_end`, capacity, active team count.
- Second list call with `status=IN_PROGRESS,PLAYED`; for leagues in progress, or played with
  `league_end_date` within 4 months, collect `players[].user_id` from active teams and call
  `league_note_returning`. Upcoming leagues are not a source (otherwise registering would qualify).
- Replace the GONE close patch: set `playtomic_status='GONE'` only (state function closes it).
- Response gains `returning: n`.

### Registration: `supabase/functions/league-register/index.ts`

- `leagueOpen(l)` replaced by `state = rpc('league_state', {p_league})`. `quote`/`register`:
  - `open` -> proceed.
  - `early` -> proceed only if the pasted player id is in `league_returning_players`
    (and, for a partner code, the partner registration's player id is too); otherwise
    409 `early_access_only` with the general opening time.
  - `full` -> 409 `league_full`; `not_yet` -> 409 `league_not_open` with the opening time;
    `closed` -> 409 `league_closed`.
  - Existing half-finished registrations follow the same rule on `register`.
- `resume` (save card for an existing registration) allows `open` and `early` (the id was already
  checked when the registration was made) and `full` only if the registration is already counted
  (it is not, because card is not authorised) -> refused with `league_full`.
- Stripe webhook: a card saved after the league filled still creates the subscription (the member
  had started checkout); accepted over-capacity risk is at most the checkouts in flight.
- Cancel (admin): after cancelling, post `league_cancelled` to the Make hook (below).

### Stripe webhook: `supabase/functions/stripe-webhook/index.ts`

After a league subscription is claimed (the existing once-only point), post `league_registered`:
`{event, registration_id, first_name, full_name, email, phone, phone_e164, league,
weekly_price, first_payment_pretty, weeks, partner_needed (bool), share_url}`.

### Public page: `assets/league-register.js` + `northampton-padel-league/register/index.html`

- League picker uses `league_windows`/`league_state` (one RPC per league or a view) instead of the
  old `open()` test. Shows: "Opens {date} (returning players from {date})", "Returning players
  only until {date}", "Full", "Closed". Only `open`/`early` are selectable.
- Maps new errors: `early_access_only`, `league_full`, `league_not_open`.
- Cache-bump the script.

### Studio Manager: `assets/admin-leagues.js` + cache bump

- Replace the "Registration open" checkbox with a select: Auto (dates) / Force open / Force closed.
- Show state pill, the three dates, capacity (`taken / capacity`), and an optional "Opens at"
  override date-time input.
- Save validation: Force open requires prices, start and weeks (as today).

### Make scenario 9736516

Add two ClickSend routes before the catch-all, same connection (14557698), same Break retry
pattern, and add both event names to the catch-all's `text:notequal` list:
- `league_registered`: "Padel Power: Hi {first_name}, you're registered for {league}. £{weekly_price}
  a week for {weeks} weeks, first payment {first_payment_pretty}. We'll add you to the league on
  Playtomic shortly.{if partner_needed: Your partner can join with this link: {share_url}}"
- `league_cancelled`: "Padel Power: Hi {first_name}, your {league} registration has been cancelled
  and no further payments will be taken. Questions? Reply on WhatsApp: https://wa.me/447595250776"
Edit via the Make MCP: fetch blueprint, insert routes, validate, update; confirm with a test
payload to the hook that routes correctly (to Tom's number only).

## Non-goals

- Changing Playtomic's own enrolment dates or writing the start date to Playtomic.
- Weeks/price auto-fill from Playtomic (Grace still sets them).
- Waiting lists.
- Emails.

## Risks

- Undocumented Manager API; field names could change. Sync failures leave the last synced values.
- Capacity is only as fresh as the hourly sync plus local registrations; teams added by staff
  directly in Manager are counted after the next sync (Sync now button forces it).
- Over-capacity by in-flight checkouts is possible and accepted.
- Returning-player check trusts the pasted link; borrowing someone else's link would enrol that
  other person, so it is self-defeating.

## Verification

- `npx esbuild` parse of each changed function; `node --check` on changed JS.
- Apply migration; SQL assertions on `league_state` with a temp league row covering
  closed/not_yet/early/open/full/force open/force closed (inside a transaction, rolled back).
- Deploy sync; run it; confirm October leagues have `season_start = 2026-10-19`,
  `capacity_teams` (140/40/30/30/10), `enrolment_end_at = 2026-10-18 06:00 UTC`,
  and `league_returning_players` populated (> 150 ids).
- `quote` via the register function for an October league returns `league_closed` (no prices)
  today; with a temporary price on a test copy, state transitions verified in SQL rather than
  waiting for dates.
- Make: blueprint validates; a test `league_registered` payload to the hook produces an execution
  that takes the new route.
- Register page and admin page load with no console errors (preview).
