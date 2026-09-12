// Padel Power · booking-lookup
// Given a booking id (or cancel token, or class id), return the class and the
// instructor teaching it, with the instructor's contact details if on file,
// so Make can send the instructor a text.
//
// Auth, either of:
//   x-pp-key: <internal key>        (Make; checked against Vault in the DB)
//   Authorization: Bearer <service role key>
// The platform still requires a valid project JWT in Authorization, so Make
// sends the public anon key there alongside x-pp-key. The anon key on its
// own is refused: without that, anyone with the website key could read
// member details.
//
// GET  /booking-lookup?booking_id=...   (or ?cancel_token=... or ?class_id=...)
// POST /booking-lookup  {"booking_id": "..."}

const URL_BASE = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-pp-key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

async function rest(path: string, init: RequestInit = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`rest_${res.status}`);
  return await res.json();
}

// role claim from the caller's JWT (payload only; the platform has already
// verified the signature because verify_jwt is on)
function callerRole(req: Request): string | null {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const pad = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(pad + '='.repeat((4 - pad.length % 4) % 4)));
    return payload.role ?? null;
  } catch {
    return null;
  }
}

async function internalCaller(req: Request): Promise<boolean> {
  const key = req.headers.get('x-pp-key') || '';
  if (!key) return false;
  try {
    const ok = await rest('rpc/pp_internal_key_ok', { method: 'POST', body: JSON.stringify({ p_key: key }) });
    return ok === true;
  } catch {
    return false;
  }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (callerRole(req) !== 'service_role' && !(await internalCaller(req))) {
    return json({ error: 'forbidden', detail: 'Send x-pp-key or use the service role key.' }, 403);
  }

  // accept params from the query string or a JSON body
  const url = new URL(req.url);
  let p: Record<string, string> = Object.fromEntries(url.searchParams);
  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    p = { ...p, ...body };
  }

  const bookingId = p.booking_id || p.id || '';
  const cancelToken = p.cancel_token || '';
  let classId = p.class_id || '';

  if (!bookingId && !cancelToken && !classId) {
    return json({ error: 'missing_param', detail: 'Pass booking_id, cancel_token or class_id.' }, 400);
  }

  try {
    let booking: Record<string, unknown> | null = null;

    if (bookingId || cancelToken) {
      const filter = bookingId
        ? `id=eq.${encodeURIComponent(bookingId)}`
        : `cancel_token=eq.${encodeURIComponent(cancelToken)}`;
      const rows = await rest(`bookings?${filter}&select=*&limit=1`);
      booking = rows[0] ?? null;
      if (!booking) return json({ error: 'booking_not_found' }, 404);
      classId = booking.class_id as string;
    }

    const [date, time] = String(classId).split('_');
    if (!date || !time) return json({ error: 'bad_class_id' }, 400);

    const d = new Date(`${date}T00:00:00Z`);
    if (isNaN(d.getTime())) return json({ error: 'bad_class_id' }, 400);
    const weekday = d.getUTCDay();

    // one-off classes win over the weekly template at the same time, the same
    // way the booking pages resolve a class
    let instructor: string | null = null;
    let typeKey: string | null = null;
    let isCustom = false;

    const custom = await rest(
      `custom_classes?class_date=eq.${date}&start_time=eq.${encodeURIComponent(time)}&select=instructor,type_key&limit=1`);
    if (custom[0]) {
      instructor = custom[0].instructor;
      typeKey = custom[0].type_key;
      isCustom = true;
    } else {
      const slot = await rest(
        `timetable?weekday=eq.${weekday}&start_time=eq.${encodeURIComponent(time)}&select=instructor,type_key&limit=1`);
      if (slot[0]) {
        instructor = slot[0].instructor;
        typeKey = slot[0].type_key;
      }
    }

    // class name: from the type, falling back to what was stored on the booking
    let className: string | null = (booking?.class_type as string) ?? null;
    if (typeKey) {
      const types = await rest(`class_types?key=eq.${encodeURIComponent(typeKey)}&select=name&limit=1`);
      if (types[0]) className = types[0].name;
    }

    // instructor contact details, if they are on file
    let inst: Record<string, unknown> | null = null;
    if (instructor) {
      const rows = await rest(
        `instructors?name=ilike.${encodeURIComponent(instructor)}&select=name,email,phone,active&limit=1`);
      inst = rows[0] ?? null;
    }

    const cancelledRows = await rest(
      `cancelled_classes?class_date=eq.${date}&start_time=eq.${encodeURIComponent(time)}&select=reason&limit=1`);
    const cancelledRow = cancelledRows[0] ?? null;
    const classCancelled = !!cancelledRow && !String(cancelledRow.reason ?? '').startsWith('moved to ');

    const phone = (inst?.phone as string) ?? null;
    const memberName = (booking?.name as string) ?? null;

    return json({
      found: true,
      class_id: classId,
      date,
      time,
      day: DAYS[weekday],
      date_pretty: `${DAYS[weekday]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`,
      class_name: className,
      class_type_key: typeKey,
      one_off: isCustom,
      class_cancelled: classCancelled,

      instructor: instructor || null,
      instructor_email: (inst?.email as string) ?? null,
      instructor_phone: phone,
      instructor_phone_e164: phone ? phone.replace(/\s+/g, '') : null,
      instructor_on_file: !!inst,
      instructor_active: inst ? !!inst.active : null,

      booking_id: (booking?.id as string) ?? null,
      member_name: memberName,
      member_first_name: memberName ? memberName.split(' ')[0] : null,
      member_email: (booking?.email as string) ?? null,
      member_phone: (booking?.phone as string) ?? null,
      booking_source: (booking?.source as string) ?? null,
      booking_cancelled: booking ? !!booking.cancelled_at : null,
      booking_paid: booking ? !!booking.paid_at && !booking.refunded_at : null,
      paid_with: (booking?.paid_with as string) ?? null,
    });
  } catch (err) {
    return json({ error: 'lookup_failed', detail: String((err as Error).message) }, 500);
  }
});
