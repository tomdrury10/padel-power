// Padel Power · Stripe webhook
// Authenticated by Stripe's signature (STRIPE_WEBHOOK_SECRET), not JWT.
// checkout.session.completed ->
//   metadata.type = "pack"  : create the member's credit pack
//   otherwise               : insert the paid class booking, stamped with
//                             the member's account. If the class filled up
//                             between checkout and webhook, refund automatically.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const WH_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

const enc = new TextEncoder();

async function validSignature(payload: string, header: string | null): Promise<boolean> {
  if (!header || !WH_SECRET) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=") as [string, string]),
  );
  const t = parts["t"];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(WH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  return sigs.some((s) => {
    if (s.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

async function refund(paymentIntent: string) {
  await fetch("https://api.stripe.com/v1/refunds", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ payment_intent: paymentIntent }),
  });
}

function insert(table: string, row: Record<string, unknown>) {
  return fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
}

const UUID = /^[0-9a-f-]{36}$/;

Deno.serve(async (req) => {
  const payload = await req.text();
  if (!(await validSignature(payload, req.headers.get("stripe-signature")))) {
    return new Response("bad signature", { status: 400 });
  }

  const event = JSON.parse(payload);
  if (event.type !== "checkout.session.completed") {
    return new Response("ignored", { status: 200 });
  }

  const s = event.data.object;
  if (s.payment_status !== "paid") return new Response("not paid", { status: 200 });

  const m = s.metadata || {};
  const userId = UUID.test(String(m.user_id || "")) ? m.user_id : null;

  // ---- credit pack ----
  if (m.type === "pack") {
    if (!userId) {
      console.error(`pack session ${s.id} has no user_id`);
      return new Response("no user", { status: 200 });
    }
    const credits = Math.max(1, Math.min(100, parseInt(m.credits, 10) || 6));
    const months = Math.max(1, Math.min(24, parseInt(m.months, 10) || 3));
    const expires = new Date();
    expires.setMonth(expires.getMonth() + months);
    const res = await insert("credit_packs", {
      user_id: userId,
      credits_total: credits,
      credits_left: credits,
      amount_pence: s.amount_total,
      stripe_session_id: s.id,
      payment_intent_id: s.payment_intent,
      expires_at: expires.toISOString(),
    });
    if (res.ok) return new Response("credited", { status: 200 });
    const body = await res.text();
    if (res.status === 409 || body.includes("credit_packs_session_uidx")) {
      return new Response("already credited", { status: 200 });
    }
    console.error(`pack insert failed: ${res.status} ${body}`);
    return new Response("retry", { status: 500 });
  }

  // ---- single class ----
  const booking = {
    class_id: m.class_id,
    name: m.name || "Unknown",
    email: m.email || s.customer_email || "",
    phone: m.phone || "",
    source: "Online",
    user_id: userId,
    amount_pence: s.amount_total,
    stripe_session_id: s.id,
    payment_intent_id: s.payment_intent,
    paid_at: new Date().toISOString(),
    paid_with: "card",
  };
  const res = await insert("bookings", booking);
  if (res.ok) return new Response("booked", { status: 200 });

  const body = await res.text();
  // duplicate webhook delivery: the unique index on stripe_session_id fired
  if (res.status === 409 || body.includes("bookings_stripe_session_uidx")) {
    return new Response("already booked", { status: 200 });
  }
  // class filled/cancelled between checkout and webhook, or the member
  // already holds a bed: give the money back, then mark the refund on a
  // tombstone row so the success page can explain
  if (/class_full|class_cancelled|class_in_past|already_booked/.test(body)) {
    console.error(`refunding ${s.id}: ${body}`);
    await refund(s.payment_intent);
    await insert("bookings", {
      ...booking,
      cancelled_at: new Date().toISOString(),
      refunded_at: new Date().toISOString(),
    }).catch(() => {});
    return new Response("refunded", { status: 200 });
  }

  console.error(`webhook insert failed: ${res.status} ${body}`);
  return new Response("retry", { status: 500 }); // Stripe will retry
});
