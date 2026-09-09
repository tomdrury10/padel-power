# booking-lookup

Look up a class and the instructor teaching it from a booking id, so a Make
scenario can find the instructor's number in its own data store and text them,
without rebuilding the automation around a new webhook payload.

Deployed to the Padel Power Supabase project. Source lives in the Supabase
dashboard (Edge Functions > booking-lookup); this file is the reference.

## Endpoint

```
https://bejshhlkatpjcydlokfk.supabase.co/functions/v1/booking-lookup
```

GET with a query string, or POST with a JSON body. One of these is required:

| Param | Example | Notes |
|---|---|---|
| `booking_id` | `06936989-7ba9-...` | the `bookings.id` uuid |
| `cancel_token` | `x7f2...` | the token from a cancel link |
| `class_id` | `2026-09-14_19:30` | no booking needed, class details only |

## Auth

**Service role key only.** Both headers, same key:

```
apikey: <service role key>
Authorization: Bearer <service role key>
```

The anon key is also a valid JWT, so the function checks the `role` claim and
returns 403 for anything that is not `service_role`. Without that check the
public website key would read member contact details. The service role key is
in Supabase > Project Settings > API. It belongs only in Make (server side),
never in the site.

## Response

```json
{
  "found": true,
  "class_id": "2026-09-14_19:30",
  "date": "2026-09-14",
  "time": "19:30",
  "day": "Monday",
  "date_pretty": "Monday 14 September",
  "class_name": "Reformer Flow",
  "class_type_key": "flow",
  "one_off": false,
  "class_cancelled": false,

  "instructor": "Laura",
  "instructor_email": null,
  "instructor_phone": null,
  "instructor_phone_e164": null,
  "instructor_on_file": true,
  "instructor_active": true,

  "booking_id": "06936989-7ba9-4ac9-88a9-a3837037946a",
  "member_name": "Jemma Astle",
  "member_first_name": "Jemma",
  "member_email": "...",
  "member_phone": "+44 7...",
  "booking_source": "Online",
  "booking_cancelled": false,
  "booking_paid": true
}
```

`instructor` is resolved the same way the booking pages do it: a one-off class
in `custom_classes` wins over the weekly `timetable` slot at the same time.
`instructor_phone` is filled from the `instructors` table when contact details
have been entered in Studio Manager, otherwise null: use the Make data store.

Errors: `400 missing_param` / `400 bad_class_id`, `403 forbidden`,
`404 booking_not_found`, `500 lookup_failed`.

## Note on names

The dashboard and database use full names (Christie Manning, Verity Game,
Gabby Deere, Laura); the public pilates page shows first names only. Key the
Make data store on the full name, which is what this endpoint returns.
