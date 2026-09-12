// Padel Power · refunds
// POST { booking_ids: [...] }
// Refunds each paid, unrefunded card booking via Stripe and soft-cancels it.
// Idempotent: a booking already refunded comes back as already_refunded and
// Stripe's own charge_already_refunded is treated as success.
//
// Two ways in:
//   1. a signed-in staff session (the admin dashboard)
//   2. header x-pp-key matching the internal key held in Vault, used by the
//      database when auto-cancel closes a class holding card bookings
// verify_jwt is off because the function does its own authentication; the
// database has no JWT to send.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-pp-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

// the internal key is compared inside the database, never held here
async function internalCaller(req: Request): Promise<boolean> {
  const key = req.headers.get("x-pp-key") || "";
  if (!key) return false;
  try {
    const ok = await db("rpc/pp_internal_key_ok", { method: "POST", body: JSON.stringify({ p_key: key }) });
    return ok === true;
  } catch {
    return false;
  }
}

async function staffCaller(req: Request): Promise<boolean> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const who = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  const user = who.ok ? await who.json() : null;
  return !!user?.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  if (!(await internalCaller(req)) && !(await staffCaller(req))) {
    return json({ error: "not_staff" }, 401);
  }

  try {
    const { booking_ids } = await req.json();
    if (!Array.isArray(booking_ids) || !booking_ids.length || booking_ids.length > 20) {
      return json({ error: "bad_request" }, 400);
    }

    const results: Record<string, string> = {};
    for (const id of booking_ids) {
      if (!/^[0-9a-f-]{36}$/.test(String(id))) { results[id] = "bad_id"; continue; }
      const rows = await db(
        `bookings?id=eq.${id}&select=id,payment_intent_id,paid_at,refunded_at,cancelled_at`,
      );
      const bk = rows[0];
      if (!bk) { results[id] = "not_found"; continue; }
      if (!bk.paid_at || !bk.payment_intent_id) { results[id] = "not_paid"; continue; }
      if (bk.refunded_at) { results[id] = "already_refunded"; continue; }
      if (!STRIPE_KEY) { results[id] = "payments_not_configured"; continue; }

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
        console.error(`refund failed for ${id}: ${JSON.stringify(rf?.error)}`);
        results[id] = "refund_failed";
        continue;
      }

      await db(`bookings?id=eq.${id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          refund_id: rf?.id || null,
          refunded_at: new Date().toISOString(),
          cancelled_at: bk.cancelled_at || new Date().toISOString(),
        }),
      });
      results[id] = "refunded";
    }
    return json({ results });
  } catch (err) {
    console.error(err);
    return json({ error: "server_error" }, 500);
  }
});
