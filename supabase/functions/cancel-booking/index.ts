// Padel Power · booking cancellation
// Two ways in, same rules:
//   - the cancel token from the confirmation text  (GET ?t=  /  POST { token })
//   - a signed-in member's own booking            (GET ?id= /  POST { booking_id })
// Cutoff enforced here. A card booking is refunded before it is cancelled
// (never cancelled without the refund). A credit booking gets its credit
// back automatically via the bookings_return_credit trigger.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`db_error ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function currentUser(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const who = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  const user = who.ok ? await who.json() : null;
  return user?.id ? user : null;
}

function hoursUntil(dateIso: string, time: string): number {
  const nowLondon = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/London" }),
  );
  const start = new Date(`${dateIso}T${time}:00`);
  return (start.getTime() - nowLondon.getTime()) / 3600000;
}

const FIELDS = "id,class_id,name,class_type,cancelled_at,paid_at,refunded_at,amount_pence,payment_intent_id,paid_with,credit_pack_id,user_id";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const token = req.method === "GET" ? url.searchParams.get("t") || "" : String(body?.token || "");
    const bookingId = req.method === "GET" ? url.searchParams.get("id") || "" : String(body?.booking_id || "");

    let bk;
    if (token) {
      if (!/^[a-f0-9]{24}$/.test(token)) return json({ error: "invalid_link" }, 404);
      bk = (await db(`bookings?cancel_token=eq.${token}&select=${FIELDS}`))[0];
    } else if (bookingId) {
      // a member cancelling from their account: must own the booking
      if (!/^[0-9a-f-]{36}$/.test(bookingId)) return json({ error: "invalid_link" }, 404);
      const user = await currentUser(req);
      if (!user) return json({ error: "account_required" }, 401);
      bk = (await db(`bookings?id=eq.${bookingId}&user_id=eq.${user.id}&select=${FIELDS}`))[0];
    } else {
      return json({ error: "invalid_link" }, 404);
    }
    if (!bk) return json({ error: "invalid_link" }, 404);

    const [dateIso, time] = bk.class_id.split("_");
    const settings = await db("settings?id=eq.1&select=cutoff_hours");
    const cutoff = settings[0]?.cutoff_hours ?? 24;
    const left = hoursUntil(dateIso, time);
    const byCard = !!bk.paid_at && !bk.refunded_at && bk.paid_with !== "credit" && !!bk.payment_intent_id;
    const byCredit = bk.paid_with === "credit" && !!bk.credit_pack_id;

    const state = {
      name: (bk.name || "").split(" ")[0],
      class_name: bk.class_type || "Reformer class",
      date: dateIso,
      time,
      cancelled: !!bk.cancelled_at,
      past: left <= 0,
      within_cutoff: left > 0 && left < cutoff,
      cutoff_hours: cutoff,
      paid: byCard,
      credit: byCredit,
      amount_pence: bk.amount_pence,
    };

    if (req.method === "GET") return json(state);
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    if (state.cancelled) return json({ ok: true, already: true });
    if (state.past) return json({ error: "class_in_past" }, 409);
    if (state.within_cutoff) return json({ error: "cutoff", cutoff_hours: cutoff }, 409);

    const patch: Record<string, unknown> = { cancelled_at: new Date().toISOString() };

    // card booking: refund first, cancel only if the money moved
    if (byCard) {
      if (!STRIPE_KEY) return json({ error: "refund_unavailable" }, 503);
      const res = await fetch("https://api.stripe.com/v1/refunds", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STRIPE_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ payment_intent: bk.payment_intent_id }),
      });
      const rf = await res.json();
      if (!res.ok && rf?.error?.code !== "charge_already_refunded") {
        console.error(`self-cancel refund failed for ${bk.id}: ${JSON.stringify(rf?.error)}`);
        return json({ error: "refund_failed" }, 502);
      }
      patch.refund_id = rf?.id || null;
      patch.refunded_at = new Date().toISOString();
    }

    // credit bookings: the bookings_return_credit trigger hands the credit back
    await db(`bookings?id=eq.${bk.id}&cancelled_at=is.null`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    });

    return json({
      ok: true,
      refunded: !!patch.refunded_at,
      credit_returned: byCredit,
      amount_pence: bk.amount_pence,
    });
  } catch (err) {
    console.error(err);
    return json({ error: "server_error" }, 500);
  }
});
