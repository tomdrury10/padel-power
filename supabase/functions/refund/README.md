# refund

`POST { booking_ids: [...] }` — refunds each paid, unrefunded card booking via
Stripe and soft-cancels it. Idempotent: an already-refunded booking returns
`already_refunded`, and Stripe's own `charge_already_refunded` counts as success.
Maximum 20 ids per call.

Source lives in the Supabase dashboard (Edge Functions > refund).

## Who may call it

Two ways in, and nothing else:

1. **An admin session.** The dashboard sends the signed-in user's token; the
   function resolves it to a user and requires a `staff_roles` row with
   `role = 'admin'`.
2. **The internal key**, header `x-pp-key`, compared inside the database via
   `pp_internal_key_ok`. Used by `_post_refunds`, which is how `auto_cancel_under_min`,
   `retry_class_refunds` and `cancel_class_as_staff` send refunds.

`verify_jwt` is off because the function authenticates itself — the database
has no JWT to send.

## Fixed 2026-09-13

The check used to be "does this token resolve to a user", named `staffCaller`
but never looking at the role. Once members had logins, that meant **any
signed-in member could refund any booking whose id they could name**, which
also sidestepped the 24-hour cancellation policy. There are 30 member accounts
against 4 admins, so the blast radius was real.

It now requires `role = 'admin'`. Instructors deliberately cannot refund from
the browser: when one cancels their own class, `cancel_class_as_staff` runs the
refunds server-side through the internal key path instead.

Verified after deploy — no auth, the anon key, a bogus token and a guessed
`x-pp-key` all return `401 not_admin`.
