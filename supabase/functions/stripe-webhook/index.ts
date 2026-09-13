// Padel Power · Stripe webhook
// Authenticated by Stripe's signature (STRIPE_WEBHOOK_SECRET), not JWT.
//
// checkout.session.completed, mode=payment ->
//   metadata.type = "pack"  : create the member's credit pack
//   otherwise               : insert the paid class booking, stamped with
//                             the member's account. If the class filled up
//                             between checkout and webhook, refund automatically.
// checkout.session.completed, mode=setup, metadata.type=league ->
//   the card is saved: create the weekly league subscription, trial until
//   the season starts, ending after the configured number of weeks.
// checkout.session.completed, mode=setup, metadata.type=league_card ->
//   swap the card on a live league subscription.
// invoice.paid / invoice.payment_failed -> update the league registration.
// customer.subscription.deleted -> mark league billing ended.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const WH_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const MAKE_HOOK = "https://hook.eu2.make.com/gv6vj6l1s6cdiambazifcxho189o9zo7";
const SITE = "https://www.padelpower.uk";

const enc = new TextEncoder();

async function validSignature(payload: string, header: string | null): Promise<boolean> {
  if (!header || !WH_SECRET) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts["t"];
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(WH_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
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

async function stripe(path: string, params?: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: params ? "POST" : "GET",
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "stripe_error");
  return data;
}
const refund = (paymentIntent: string) => stripe("refunds", { payment_intent: paymentIntent }).catch(() => {});

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`db_error ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
function insert(table: string, row: Record<string, unknown>) {
  return fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
}
const patchReg = (id: string, body: Record<string, unknown>) =>
  db(`league_registrations?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
const log = (reg: string, action: string, detail: Record<string, unknown> = {}) =>
  db("rpc/league_log", { method: "POST", body: JSON.stringify({ p_reg: reg, p_action: action, p_detail: detail, p_actor: null }) }).catch(() => {});

const UUID = /^[0-9a-f-]{36}$/;

// ---------------- leagues ----------------
async function leagueCardSaved(s: Record<string, unknown>, m: Record<string, string>) {
  const regId = m.registration_id;
  if (!UUID.test(regId || "")) return new Response("no registration", { status: 200 });
  const [reg] = await db(`league_registrations?id=eq.${regId}&select=*`);
  if (!reg) return new Response("no registration", { status: 200 });

  const si = await stripe(`setup_intents/${s.setup_intent}`);
  const pmId = String(si.payment_method);
  const pm = await stripe(`payment_methods/${pmId}`);
  const label = pm.card ? `${pm.card.brand} ending ${pm.card.last4}` : "card";
  const customer = String(s.customer);
  await stripe(`customers/${customer}`, { "invoice_settings[default_payment_method]": pmId });

  if (m.type === "league_card") {
    if (reg.stripe_subscription_id && !reg.billing_ended_at) {
      await stripe(`subscriptions/${reg.stripe_subscription_id}`, { default_payment_method: pmId });
    }
    await patchReg(reg.id, { stripe_payment_method_id: pmId, card_label: label, card_status: "authorised", stripe_customer_id: customer });
    await log(reg.id, "card_updated", { card: label });
    return new Response("card updated", { status: 200 });
  }

  if (reg.stripe_subscription_id) return new Response("already scheduled", { status: 200 });
  const [league] = await db(`leagues?id=eq.${reg.league_id}&select=*`);
  if (!league?.season_start || !league?.weeks) {
    await patchReg(reg.id, { stripe_payment_method_id: pmId, card_label: label, card_status: "authorised", stripe_customer_id: customer });
    await log(reg.id, "card_authorised_no_schedule", { card: label });
    return new Response("league not configured", { status: 200 });
  }

  let product = league.stripe_product_id as string | null;
  if (!product) {
    const p = await stripe("products", { name: `Padel League: ${league.name}` });
    product = p.id;
    await db(`leagues?id=eq.${league.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ stripe_product_id: product }) });
  }

  // first charge at 08:00 UK-ish on the season start date, then weekly;
  // the subscription ends itself after the configured number of weeks
  const startUnix = Math.floor(Date.parse(`${league.season_start}T07:00:00Z`) / 1000);
  const nowUnix = Math.floor(Date.now() / 1000);
  const cancelAt = startUnix + Number(league.weeks) * 7 * 86400 - 3600;
  if (cancelAt <= nowUnix) {
    await patchReg(reg.id, { stripe_payment_method_id: pmId, card_label: label, card_status: "authorised", stripe_customer_id: customer });
    await log(reg.id, "card_authorised_season_over", {});
    return new Response("season over", { status: 200 });
  }
  const params: Record<string, string> = {
    customer,
    default_payment_method: pmId,
    "items[0][price_data][currency]": "gbp",
    "items[0][price_data][unit_amount]": String(reg.weekly_price_pence),
    "items[0][price_data][recurring][interval]": "week",
    "items[0][price_data][product]": product!,
    cancel_at: String(cancelAt),
    "metadata[registration_id]": reg.id,
    "metadata[league]": league.name,
    "metadata[player]": reg.name,
  };
  if (startUnix > nowUnix + 120) params.trial_end = String(startUnix);
  const sub = await stripe("subscriptions", params);

  await patchReg(reg.id, {
    stripe_subscription_id: sub.id, stripe_payment_method_id: pmId, card_label: label,
    card_status: "authorised", stripe_customer_id: customer,
  });
  await log(reg.id, "card_authorised", { card: label });
  await log(reg.id, "billing_scheduled", { subscription: sub.id, first_payment: startUnix > nowUnix ? league.season_start : "now", weeks: league.weeks, weekly_price_pence: reg.weekly_price_pence });
  return new Response("scheduled", { status: 200 });
}

async function leagueInvoice(inv: Record<string, unknown>, paid: boolean) {
  const subId = typeof inv.subscription === "string" ? inv.subscription : (inv.subscription as Record<string, unknown>)?.id;
  if (!subId) return new Response("no subscription", { status: 200 });
  const [reg] = await db(`league_registrations?stripe_subscription_id=eq.${subId}&select=*`);
  if (!reg) return new Response("not a league", { status: 200 });

  if (paid) {
    if (Number(inv.amount_paid) <= 0) return new Response("zero invoice", { status: 200 });
    await patchReg(reg.id, { payments_taken: reg.payments_taken + 1, last_payment_status: "paid", last_payment_at: new Date().toISOString(), card_status: "authorised" });
    await log(reg.id, "payment_collected", { amount_pence: inv.amount_paid, invoice: inv.id, number: reg.payments_taken + 1 });
    return new Response("paid", { status: 200 });
  }

  await patchReg(reg.id, { last_payment_status: "failed", last_payment_at: new Date().toISOString(), card_status: "failed" });
  await log(reg.id, "payment_failed", { amount_pence: inv.amount_due, invoice: inv.id, attempt: inv.attempt_count });
  const [league] = await db(`leagues?id=eq.${reg.league_id}&select=name`);
  await fetch(MAKE_HOOK, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "league_payment_failed",
      registration_id: reg.id, first_name: String(reg.name).split(" ")[0], full_name: reg.name,
      email: reg.email, phone: reg.phone, phone_e164: String(reg.phone).replace(/\s+/g, ""),
      league: league?.name ?? "", amount: (Number(inv.amount_due) / 100).toFixed(2),
      update_url: `${SITE}/leagues/register/`,
    }),
  }).catch(() => {});
  return new Response("failed recorded", { status: 200 });
}

async function leagueSubscriptionEnded(sub: Record<string, unknown>) {
  const [reg] = await db(`league_registrations?stripe_subscription_id=eq.${sub.id}&select=id,billing_ended_at`);
  if (!reg) return new Response("not a league", { status: 200 });
  if (!reg.billing_ended_at) {
    await patchReg(reg.id, { billing_ended_at: new Date().toISOString() });
    await log(reg.id, "billing_ended", { subscription: sub.id });
  }
  return new Response("ended", { status: 200 });
}

// ---------------- entry ----------------
Deno.serve(async (req) => {
  const payload = await req.text();
  if (!(await validSignature(payload, req.headers.get("stripe-signature")))) {
    return new Response("bad signature", { status: 400 });
  }
  const event = JSON.parse(payload);
  const obj = event.data.object;

  try {
    if (event.type === "invoice.paid") return await leagueInvoice(obj, true);
    if (event.type === "invoice.payment_failed") return await leagueInvoice(obj, false);
    if (event.type === "customer.subscription.deleted") return await leagueSubscriptionEnded(obj);
    if (event.type !== "checkout.session.completed") return new Response("ignored", { status: 200 });

    const s = obj;
    const m = s.metadata || {};
    if (s.mode === "setup") {
      if (m.type === "league" || m.type === "league_card") return await leagueCardSaved(s, m);
      return new Response("ignored setup", { status: 200 });
    }
  } catch (err) {
    console.error(`league webhook failed: ${String((err as Error).message)}`);
    return new Response("retry", { status: 500 });
  }

  // ---------------- pilates (unchanged) ----------------
  const s = obj;
  if (s.payment_status !== "paid") return new Response("not paid", { status: 200 });
  const m = s.metadata || {};
  const userId = UUID.test(String(m.user_id || "")) ? m.user_id : null;

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
      user_id: userId, credits_total: credits, credits_left: credits, amount_pence: s.amount_total,
      stripe_session_id: s.id, payment_intent_id: s.payment_intent, expires_at: expires.toISOString(),
    });
    if (res.ok) return new Response("credited", { status: 200 });
    const body = await res.text();
    if (res.status === 409 || body.includes("credit_packs_session_uidx")) return new Response("already credited", { status: 200 });
    console.error(`pack insert failed: ${res.status} ${body}`);
    return new Response("retry", { status: 500 });
  }

  const booking = {
    class_id: m.class_id, name: m.name || "Unknown", email: m.email || s.customer_email || "", phone: m.phone || "",
    source: "Online", user_id: userId, amount_pence: s.amount_total, stripe_session_id: s.id,
    payment_intent_id: s.payment_intent, paid_at: new Date().toISOString(), paid_with: "card",
  };
  const res = await insert("bookings", booking);
  if (res.ok) return new Response("booked", { status: 200 });
  const body = await res.text();
  if (res.status === 409 || body.includes("bookings_stripe_session_uidx")) return new Response("already booked", { status: 200 });
  if (/class_full|class_cancelled|class_in_past|already_booked/.test(body)) {
    console.error(`refunding ${s.id}: ${body}`);
    await refund(s.payment_intent);
    await insert("bookings", { ...booking, cancelled_at: new Date().toISOString(), refunded_at: new Date().toISOString() }).catch(() => {});
    return new Response("refunded", { status: 200 });
  }
  console.error(`webhook insert failed: ${res.status} ${body}`);
  return new Response("retry", { status: 500 });
});
