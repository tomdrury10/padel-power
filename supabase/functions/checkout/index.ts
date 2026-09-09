// Padel Power · Pilates checkout (Stripe)
// Every checkout needs a signed-in member: the JWT in the Authorization
// header must belong to a real auth user (the anon key is refused).
//
// POST { kind: "class", class_id, return_url }  -> { url }  pay for one class
// POST { kind: "pack",  return_url }            -> { url }  buy a credit pack
// GET  ?session=cs_...                          -> post-payment state
//
// Prices, pack size and expiry come from the DB, never the client.
// A signed health waiver (one per email) is required before a class session.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

// TRANSITION FLAG: the old booking page (no accounts) is still live until the
// accounts site is pushed. While true, a guest can still pay for a single
// class with name/email/phone. Set to false (and redeploy) at push time.
const ALLOW_GUEST_CHECKOUT = true;

// www.padelpower.uk is the canonical domain; legacy hosts are not accepted
const ALLOWED_ORIGINS = [
  "https://www.padelpower.uk",
  "https://padelpower.uk",
  "http://localhost:4173",
  "http://localhost:8123",
  // PREVIEW ONLY: the pilates-member-accounts branch preview, so the full
  // pay-by-card and buy-a-pack flow can be tried before go-live.
  // Remove this line when the branch merges.
  "https://padel-power-demo-git-pilates-member-accounts-juno-northampton.vercel.app",
];

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
  return res.json();
}

async function stripe(path: string, params: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "stripe_error");
  return data;
}

// the signed-in user behind the request, or null for the bare anon key
async function currentUser(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const who = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  const user = who.ok ? await who.json() : null;
  return user?.id ? user : null;
}

const FMT = new Intl.DateTimeFormat("en-GB", {
  weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London",
});

function hoursUntil(dateIso: string, time: string): number {
  const nowLondon = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/London" }),
  );
  const start = new Date(`${dateIso}T${time}:00`);
  return (start.getTime() - nowLondon.getTime()) / 3600000;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    // ---- GET: post-payment status for the return page ----
    if (req.method === "GET") {
      const session = new URL(req.url).searchParams.get("session") || "";
      if (!/^cs_[a-zA-Z0-9_]+$/.test(session)) return json({ error: "bad_session" }, 400);
      if (!STRIPE_KEY) return json({ error: "payments_not_configured" }, 503);
      const res = await fetch(
        `https://api.stripe.com/v1/checkout/sessions/${session}`,
        { headers: { Authorization: `Bearer ${STRIPE_KEY}` } },
      );
      const s = await res.json();
      if (!res.ok) return json({ error: "unknown_session" }, 404);
      const paid = s.payment_status === "paid";

      if (s.metadata?.type === "pack") {
        const packs = await db(
          `credit_packs?stripe_session_id=eq.${session}&select=id,credits_total,expires_at`,
        );
        return json({
          kind: "pack",
          paid,
          credited: packs.length > 0,
          credits: packs[0]?.credits_total ?? null,
          expires_at: packs[0]?.expires_at ?? null,
        });
      }

      const rows = await db(
        `bookings?stripe_session_id=eq.${session}&select=class_id,name,refunded_at`,
      );
      return json({
        kind: "class",
        paid,
        booked: rows.length > 0 && !rows[0].refunded_at,
        refunded: rows.length > 0 && !!rows[0].refunded_at,
        class_id: s.metadata?.class_id || null,
        name: s.metadata?.name || null,
      });
    }

    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    // ---- POST: create a checkout session (account required) ----
    const b = await req.json();
    const kind = b.kind === "pack" ? "pack" : "class";
    const user = await currentUser(req);
    const guest = !user && ALLOW_GUEST_CHECKOUT && kind === "class";
    if (!user && !guest) return json({ error: "account_required" }, 401);
    const returnUrl = String(b.return_url || "");
    let origin: string;
    try { origin = new URL(returnUrl).origin; } catch { return json({ error: "bad_return_url" }, 400); }
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "bad_return_url" }, 400);
    if (!STRIPE_KEY) return json({ error: "payments_not_configured" }, 503);

    const email = String(guest ? b.email : user.email || "").trim().toLowerCase().slice(0, 120);
    const profiles = guest ? [] : await db(`profiles?user_id=eq.${user.id}&select=full_name,phone,phone_verified_at`);
    const profile = profiles[0] || {};

    // This function writes with the service role, so the member checks in
    // enforce_booking_rules do not fire for it. The unverified-mobile gate
    // has to be repeated here, or a card payment would slip past it and the
    // webhook would create the bed anyway. Packs are gated too: better to
    // stop someone before they pay than to refund them afterwards.
    if (!guest) {
      const gate = await db("settings?id=eq.1&select=require_phone_verification");
      if (gate[0]?.require_phone_verification && !profile.phone_verified_at) {
        return json({ error: "phone_unverified" }, 409);
      }
    }
    const name = String(b.name || profile.full_name || "").trim().slice(0, 80) || email.split("@")[0];
    const phone = String(b.phone || profile.phone || "").trim().slice(0, 30);
    if (!email) return json({ error: "missing_details" }, 400);
    const userId = user ? user.id : null;

    const base = returnUrl.split("#")[0];
    const sep = base.includes("?") ? "&" : "?";

    // ---- credit pack ----
    if (kind === "pack") {
      const settings = await db("settings?id=eq.1&select=pack_credits,pack_price_pence,pack_expiry_months");
      const { pack_credits, pack_price_pence, pack_expiry_months } = settings[0];
      const session = await stripe("checkout/sessions", {
        mode: "payment",
        "line_items[0][price_data][currency]": "gbp",
        "line_items[0][price_data][unit_amount]": String(pack_price_pence),
        "line_items[0][price_data][product_data][name]": `${pack_credits} class pack · Reformer Pilates`,
        "line_items[0][price_data][product_data][description]":
          `${pack_credits} reformer classes at Padel Power Northampton. Valid for ${pack_expiry_months} months from purchase.`,
        "line_items[0][quantity]": "1",
        customer_email: email,
        "metadata[type]": "pack",
        "metadata[user_id]": user.id,
        "metadata[credits]": String(pack_credits),
        "metadata[months]": String(pack_expiry_months),
        "metadata[name]": name,
        "metadata[phone]": phone,
        "metadata[email]": email,
        "payment_intent_data[description]": `${pack_credits} class pack · ${name}`,
        success_url: `${base}${sep}pack_session={CHECKOUT_SESSION_ID}`,
        cancel_url: base,
        expires_at: String(Math.floor(Date.now() / 1000) + 1800),
      });
      return json({ url: session.url });
    }

    // ---- single class ----
    const classId = String(b.class_id || "");
    if (!/^\d{4}-\d{2}-\d{2}_\d{2}:\d{2}$/.test(classId)) return json({ error: "bad_class" }, 400);
    if (!phone) return json({ error: guest ? "missing_details" : "profile_incomplete" }, 400);

    const [dateIso, time] = classId.split("_");

    // Resolve the class exactly the way the booking trigger does
    const [cancelled, custom, settings] = await Promise.all([
      db(`cancelled_classes?class_date=eq.${dateIso}&start_time=eq.${encodeURIComponent(time)}&select=id`),
      db(`custom_classes?class_date=eq.${dateIso}&start_time=eq.${encodeURIComponent(time)}&select=type_key`),
      db(`settings?id=eq.1&select=max_riders,cutoff_hours`),
    ]);
    if (cancelled.length) return json({ error: "class_cancelled" }, 409);

    let typeKey = custom[0]?.type_key as string | undefined;
    if (!typeKey) {
      const weekday = new Date(`${dateIso}T00:00:00`).getDay();
      const slot = await db(
        `timetable?weekday=eq.${weekday}&start_time=eq.${encodeURIComponent(time)}&select=type_key`,
      );
      typeKey = slot[0]?.type_key;
    }
    if (!typeKey) return json({ error: "no_such_class" }, 404);

    const { max_riders, cutoff_hours } = settings[0];
    const left = hoursUntil(dateIso, time);
    if (left <= 0) return json({ error: "class_in_past" }, 409);
    if (left < cutoff_hours) return json({ error: "cutoff" }, 409);

    // health waiver: required once per email before any paid booking
    const waiver = await db(`waivers?email=eq.${encodeURIComponent(email)}&select=id`);
    if (!waiver.length) return json({ error: "waiver_required" }, 409);

    const [booked, mine] = await Promise.all([
      db(`bookings?class_id=eq.${encodeURIComponent(classId)}&cancelled_at=is.null&select=id`),
      userId
        ? db(`bookings?class_id=eq.${encodeURIComponent(classId)}&user_id=eq.${userId}&cancelled_at=is.null&select=id`)
        : Promise.resolve([]),
    ]);
    if (mine.length) return json({ error: "already_booked" }, 409);
    if (booked.length >= max_riders) return json({ error: "class_full" }, 409);

    const types = await db(
      `class_types?key=eq.${encodeURIComponent(typeKey)}&select=name,price_pence`,
    );
    const type = types[0];
    if (!type) return json({ error: "no_such_class" }, 404);
    if (!type.price_pence) return json({ error: "no_payment_needed" }, 409);

    const when = `${FMT.format(new Date(`${dateIso}T12:00:00`))} at ${time}`;

    const session = await stripe("checkout/sessions", {
      mode: "payment",
      "line_items[0][price_data][currency]": "gbp",
      "line_items[0][price_data][unit_amount]": String(type.price_pence),
      "line_items[0][price_data][product_data][name]": type.name,
      "line_items[0][price_data][product_data][description]":
        `${when}, Padel Power Northampton. 1 hour reformer class.`,
      "line_items[0][quantity]": "1",
      customer_email: email,
      "metadata[type]": "class",
      "metadata[class_id]": classId,
      "metadata[user_id]": userId || "",
      "metadata[name]": name,
      "metadata[phone]": phone,
      "metadata[email]": email,
      "payment_intent_data[description]": `${type.name} · ${when}`,
      success_url: `${base}${sep}session={CHECKOUT_SESSION_ID}`,
      cancel_url: base,
      expires_at: String(Math.floor(Date.now() / 1000) + 1800),
    });

    return json({ url: session.url });
  } catch (err) {
    console.error(err);
    return json({ error: "server_error" }, 500);
  }
});
