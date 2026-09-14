# Make events: the contract

Everything the database or an edge function sends to Make goes to one webhook
(`hook.eu2.make.com/gv6vj6l1s6cdiambazifcxho189o9zo7`, scenario 9736516) and
carries an `event` key. The router matches on `event` and nothing else. A
payload whose `event` matches no route lands in the last route, which emails
tom@getjuno.uk with the raw fields. If you add an event, add its route and add
its name to that catch-all filter, or the catch-all will keep firing for it.

Phone numbers are always sent twice: `phone` as stored, `phone_e164` with
spaces removed. Dates are sent as `date` (YYYY-MM-DD), `day` (Monday) and
`date_pretty` (Monday 14 September). Times are `HH:MM`.

| event | sent by | who gets what |
|---|---|---|
| `booking_created` | trigger on `bookings` insert | member SMS with cancel link |
| `class_cancelled` | trigger on `cancelled_classes` insert, once per live booking | member SMS; wording depends on `reason` |
| `instructor_class_cancelled` | trigger on `cancelled_classes` insert, once | instructor SMS, or email to Tom if no mobile on file |
| `instructor_class_moved` | same trigger when `reason` starts `moved to` | instructor SMS with `old_time` and `time`, or email to Tom |
| `class_moved` | `move_class_occurrence` (whole class) or `move_bookings` (chosen members), once per moved booking | member SMS with `old_date_pretty`, `old_time`, `date_pretty`, `time`, `same_day`, cancel link |
| `class_reminder` | `send_class_reminders` cron, day before | member SMS |
| `pack_purchased` | stripe-webhook after a pack payment | member SMS with `credits`, `expires_pretty`, `account_url` |
| `enquiry_created` | trigger on `enquiries` insert | email to Joe and Grace, cc Tom |
| `league_payment_failed` | stripe-webhook on `invoice.payment_failed` | player SMS with `league`, `amount`, `update_url` |
| `softplay_booking_created` | trigger on `softplay_bookings` insert | parent SMS (route added 14 Sept) with `session_kind`, `children`, `child_names`, `date_pretty`, `time`, `end_time`, `cancel_url` |
| `softplay_session_cancelled` | `_cancel_softplay_session` (admin cancel or `auto_cancel_softplay` cron), once per live booking | parent SMS; `reason`, `auto`, `paid`, `amount`, `account_url` |

Common fields on member and instructor events: `first_name`, `full_name`,
`email`, `phone`, `phone_e164`, `class_name`, `class_id`, `date`, `day`,
`date_pretty`, `time`, `reason`, `created_at`. `class_cancelled` also carries
`booking_id`, `source`, `paid`, `amount`. Instructor events carry `instructor`
and `auto` (true when the minimum-numbers job cancelled it).

`reason` values on cancellations: `cancelled_by_studio`, `auto: below minimum
(N booked)`, `moved to HH:MM`. Match with *contains*, never equals, because N
varies.

Instructor mobiles come from `instructors.phone` in the Studio Manager. The
old Make data store of instructor numbers is no longer read by anything.
