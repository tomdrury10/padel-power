# Plan: create league players as Padel Power customers in Playtomic

## Goal

When a league registration is ready to be enrolled in Playtomic, make sure the player is also a
customer in Padel Power's Playtomic Manager, with the name, email and mobile we hold. Adding a
player to a Playtomic league does not make them a customer (Tom tested this), so today league
players are missing from the club's customer list.

## Acceptance criteria

1. For each registration the enrolment sweep processes (card saved, player id known, league has a
   Playtomic id; for doubles both partners), before the team is added:
   - If the player is already a customer (lookup by player id): fill in email and phone on the
     customer record **only where Playtomic's club-side record has them blank**. Never overwrite
     a value staff already hold. Status `linked`.
   - If not a customer: create one with name, email, phone, country GB. If the `user_id` Playtomic
     returns equals the registration's `playtomic_player_id`, status `linked`. Otherwise status
     `mismatch`, with the returned user id recorded in the audit log and the registration.
   - On any API failure: status `error` with the message.
2. A customer problem never blocks the league add. The team is still added with the player ids from
   the share links (that path is proven and is what puts the person in the league).
3. `mismatch` is terminal for automation (never POST again for that registration, which would
   create more duplicate customers). Staff see it and resolve it by hand in Manager, then can mark
   it resolved.
4. `error` (and never-attempted) registrations that are already in a team are retried on later
   sweeps, so a registration enrolled before this change, or one whose customer call failed, still
   gets a customer. Retry eligibility does not depend on the current payment state (a failed weekly
   payment sets `card_status = failed` but the player is still in the league). Errors back off for
   6 hours; never-attempted rows go first, then least-recently attempted.
5. The Studio Manager Leagues table shows the customer state per registration next to the
   Playtomic team state: `Customer ✓`, `Customer: duplicate, check Manager` (mismatch, with the
   returned user id), or `Customer failed` with the error.
6. Admin can clear a mismatch/error (set status to `linked` manually after fixing it in Manager) via
   the existing per-row action menu.
7. Customer attempts are serialised: the sweep and the single-registration action take the same
   lock, the lock is owner-aware (a late release cannot delete a newer worker's lock), every
   Playtomic request has a timeout, and a sweep stops starting new work well before its lease ends.
8. A registration's Playtomic identity cannot silently change under recorded state: once it has a
   team, `register` refuses a different player id (409 `playtomic_locked`); before that, a changed
   player id clears `linked`/`error` customer state (but keeps `mismatch`) and is audited.

## Evidence (captured 16 Sept 2026 from Manager in Chrome, Tom's account)

- Create: `POST https://manager.playtomic.io/api/v1/tenant_profiles`
  body `{"tenant_id": T, "tenant_customer_profile": {"email","full_name","phone","country_code":"GB","gender":null,"birth_date":null,"private_notes":null}}`
  -> 201 `{tenant_profile_id, user_id, tenant_id, customer_profile{...}, tenant_customer_profile{email, full_name, phone, country_code, gender, birth_date, created_from:"MANUAL", private_notes, ...}, family_members, medical_certificate, created_at}`.
  There is no player id field; Playtomic matches/creates the underlying user by email.
- Update: `PATCH /api/v1/tenant_profiles/{tenant_profile_id}`
  body `{"tenant_customer_profile": {"full_name","phone","gender","birth_date","country_code","email"}}` -> 200.
  The UI sends the full set, so we send the existing values merged with our fills (so we never null
  gender/birth date).
- Lookup: `GET /api/v1/tenant_profiles?user_id={player_id}&tenant_id=T` -> 200, array (0 or 1).
  Verified with Tom's id 17020714: 1 row, `user_id` "17020714", created_from MANUAL, email verified.
- Phone format in Manager: `+44 7xxxxxxxxx`. Our `profiles.phone` is almost always already
  `+44 7xxxxxxxxx` (50 of 53); normalise: strip spaces; if it starts `+44`, send `+44 ` + rest; else
  send as held.
- Auth: the existing two-step Manager login in `league-enrol` (ROLE_TENANT_MANAGER token). Same
  login did the create/update in the browser.
- Uncertain: what POST returns when the email already belongs to a *different* existing customer
  (likely 409 or returns that customer). Either way the user_id comparison or the error path covers it.

## Approach

### Database: `supabase/migrations/019_league_playtomic_customer.sql`

```sql
alter table public.league_registrations
  add column if not exists playtomic_customer_status text
    check (playtomic_customer_status in ('linked','mismatch','error')),
  add column if not exists playtomic_customer_user_id text,   -- user_id Playtomic returned
  add column if not exists playtomic_customer_error text,
  add column if not exists playtomic_customer_at timestamptz,
  add column if not exists playtomic_enrolling_at timestamptz;
```

Owner-aware locks (new functions, old ones left in place for other callers):

```sql
alter table public.job_locks add column if not exists owner uuid;
job_claim_owned(p_name text, p_seconds int, p_owner uuid) returns boolean  -- same upsert, sets owner
job_release_owned(p_name text, p_owner uuid) returns void                  -- delete where name and owner match
```
service_role only.

Plus `league_mark_customer(p_reg uuid)` security definer, admin-only (same check style as
`league_mark_playtomic`), sets status `linked`, clears error, logs `playtomic_customer_resolved`.
Applied live through the Supabase connector (not `db push`; history differs).

### Function: `supabase/functions/league-enrol/index.ts`

- `ensureCustomer(tok, reg)`:
  1. GET lookup by `reg.playtomic_player_id`. If a row: compute fills for blank `email`/`phone` on
     `tenant_customer_profile`; PATCH only if there is something to fill; return `linked`.
  2. Else POST create. Compare `String(resp.user_id)` to `reg.playtomic_player_id`:
     equal -> `linked`; different -> `mismatch` (store returned user id).
  3. Throw on non-2xx; caller records `error`.
- Locking: every entry point that can create customers (`sweep`, `customer`) claims
  `league-enrol` with `job_claim_owned` (lease 300s, random owner) and releases with
  `job_release_owned` in `finally`. `customer` returns `{skipped}` if the lock is busy. After the
  claim, the registration row is re-read and terminal status (`linked`/`mismatch`) re-checked.
- Every Playtomic fetch uses `AbortSignal.timeout(15000)`. The sweep has a 150s work budget: it
  checks elapsed time before each team add / customer attempt and stops starting new ones after
  that, so worst case finishes well inside the 300s lease.
- Sweep, per team to add: for each member whose status is not `linked`/`mismatch`, run
  `ensureCustomer`, patch the four columns, audit `playtomic_customer_linked|mismatch|failed`.
  Errors are caught per member and never skip the team add.
- Second pass in the same locked sweep: registrations with `cancelled_at is null`,
  `playtomic_team_id not null`, `playtomic_player_id not null` (any `card_status`), and
  status null, or status `error` with `playtomic_customer_at` older than 6 hours ->
  `ensureCustomer`. Ordered `playtomic_customer_at.asc.nullsfirst`, capped at 25 per sweep.
  `playtomic_customer_at` is written on every attempt, success or failure.

### Function: `supabase/functions/league-register/index.ts` (register, existing row)

- The identity (player id + profile link) is only changed through a new service-role SQL function
  `league_set_identity(p_reg, p_player, p_url) returns boolean`. It is one `UPDATE ... WHERE id = p_reg
  AND playtomic_team_id IS NULL AND playtomic_enrolling_at IS NULL`, which in the same statement
  clears customer status/user id/error/at **unless the current row's status is `mismatch`** (decided
  from the row being updated, not an earlier read). Returns true if updated or if the row already
  holds `p_player`; false otherwise -> 409 `playtomic_locked`. `register` calls it only when the id
  differs, audits `playtomic_identity_changed` (ids only), and its ordinary PATCH no longer writes
  `playtomic_player_id`/`playtomic_url`.
- Front end (`assets/league-register.js`) maps `playtomic_locked` to a "message the club" line.

### Enrolment reservation

New column `playtomic_enrolling_at timestamptz`. Before `addTeam`, the sweep reserves each member
with a compare-and-set PATCH (`id`, `playtomic_player_id=eq.<id it will send>`,
`playtomic_team_id=is.null`) setting `playtomic_enrolling_at = now()`. If any member's reservation
updates 0 rows, the team is skipped this sweep and reservations taken for it are released. After
`addTeam`: success writes the team id (reservation stays set, harmless); failure clears the
reservation. Because `league_set_identity` refuses reserved rows, an identity cannot change between
the reservation and the external team add. A crash mid-add leaves the row reserved (identity
locked), which is the safe side; the sweep does not filter on the reservation, so it retries.

### Stale customer results (compare-and-set)

`register` does not take the enrolment lock. Instead every customer outcome is committed with a
PATCH filtered on `playtomic_player_id=eq.<the id the attempt used>`. If the identity changed while
the Playtomic call was in flight, 0 rows update, the outcome is discarded and audited as
`playtomic_customer_stale` (ids only); the new identity is picked up on a later sweep. The identity
change itself clears customer state in the same PATCH, so the order is always safe.
- New key-locked action `{ action: "customer", registration_id }` runs `ensureCustomer` for one
  registration (staff/test use, and lets us verify without a league). Respects the same
  mismatch-is-terminal rule.
- Customer fields: `full_name` = `reg.name`, `email` = `reg.email`, `phone` normalised,
  `country_code` "GB".
- Personal data (email/phone) is never written to logs or audit detail; audit carries ids and status.

### Admin: `assets/admin-leagues.js` + cache bump in `admin/index.html`

- Playtomic column gains a second line for customer state (criterion 5).
- Row action menu gains "Mark customer sorted" when status is mismatch/error, calling
  `league_mark_customer`.

## Non-goals

- Linking a mismatch automatically, deleting duplicate customers, or merging customers.
- Assigning Playtomic membership benefits.
- Changing registration pricing/membership logic.
- Privacy policy wording (flag to Tom: say league details are shared with Playtomic).

## Risks

- Internal, undocumented API: could change without notice. Failures surface as `error` and do not
  block league adds.
- Registrant uses a different email from their Playtomic account -> duplicate customer
  (`mismatch`), needs staff. That is the accepted trade-off; the alternative is no customer at all.
- Overwriting: avoided by fill-blanks-only.

## Verification

No local Deno toolchain; the function is deployed with the Supabase connector and verified live.

1. Apply migration; `select` confirms the four columns and the function exist.
2. Deploy `league-enrol`; call `{action:"sweep"}` with the internal key via `pg_net`
   (`trigger_league_enrol()`), check `net._http_response` -> 200 with `candidates` and no error.
3. Existing-customer path: insert a throwaway registration for Tom's player id 17020714 on a closed
   league, call `{action:"customer", registration_id}` -> status `linked`, no PATCH needed or PATCH
   fills only blanks; confirm in Manager nothing about Tom's record was overwritten. Delete the row.
4. Create path: Tom deletes the "Test" customer (tom@test.com, user 165317) in Manager; throwaway
   registration with player id 165317, email tom@test.com -> expect `linked` with returned user id
   165317 (proves email linking). Confirm the customer reappears in Manager with the phone set.
   Delete the row and the customer afterwards.
5. Admin page loads without console errors and shows the customer line; `node --check
   assets/admin-leagues.js` passes.

## Changes from code inspection (round 1)

- Stale creation: if a customer was *created* but the registration's profile changed meanwhile,
  the registration is still flagged `mismatch` with the returned user id (unless staff already
  marked it linked), so automation never creates another.
- Versioned commits: an outcome is written only if `playtomic_customer_at` is unchanged since the
  attempt read the row, so staff resolutions and other attempts are never overwritten.
- Uncertain creates (no response) are recorded as `mismatch` for staff, not retried.
- Team add failures never release the reservation (a timeout may have created the team); staff
  resolve. Reservation additionally requires `cancelled_at is null`, `card_status = authorised`
  and, for doubles, the same `pair_id`. After writing a team id the sweep re-reads the members; if
  any was cancelled or re-paired during the add, the team is removed again.
- Every database call has a 10s timeout; the work budget is checked before each customer attempt
  and before each team add.
- Stored and audited error text is `step + HTTP status + Playtomic error code` only, never a
  response body.

## Changes from code inspection (round 2)

- Claim before create: before POSTing a customer the row is compare-and-set to
  `mismatch / "creating customer, not confirmed"` (versioned by `playtomic_customer_at`). Only a
  clear Playtomic answer replaces it (`linked`, `mismatch` with the returned id, or `error` for an
  HTTP refusal). A crash, timeout, lost DB write or identity change leaves it with staff; nothing
  is POSTed twice. Each attempt re-reads the row first, so a staff resolution stops it.
- Team adds only use fresh reservations (`playtomic_enrolling_at is null` in selection and
  reservation). A clear HTTP refusal releases the reservation for retry; no answer keeps it and the
  row leaves the sweep until an admin uses "Retry Playtomic add" (`league_retry_enrol`, admin-only).
- `league_set_team(p_regs, p_team)` (migration 020, service-role) saves the team on all members in
  one statement and fails as a whole; on failure rows stay reserved with an error for staff.
