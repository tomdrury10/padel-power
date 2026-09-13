// Padel Power · league registration and billing
// Every call needs a signed-in member (the anon key is refused).
//
// Member actions, POST JSON:
//   quote       { league_id }                                -> price + schedule, nothing saved
//   register    { league_id, playtomic_url, partner_code?, return_url } -> { url } Stripe card setup
//   resume      { registration_id, return_url }               -> { url } finish a registration with no card
//   update_card { registration_id, return_url }               -> { url } swap the card on a live registration
// Admin actions (staff_roles.role = admin):
//   set_membership { registration_id, status }   set_price { registration_id, pence }
//   stop_billing   { registration_id }           cancel    { registration_id }
//
// Nothing is charged here. The card is saved through a Stripe Checkout
// session in setup mode; the stripe-webhook function creates the weekly
// subscription when Stripe confirms the card. Prices come from the
// leagues table, never the client, and are fixed once the first payment
// has been taken.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const SITE = "https://www.padelpower.uk";
const ALLOWED_ORIGINS = [SITE, "https://padelpower.uk", "http://localhost:4173", "http://localhost:8123"];
const PLAYTOMIC = /^https:\/\/([a-z0-9-]+\.)*playtomic\.(io|com)\/.{3,}$/i;
// a share link looks like https://app.playtomic.com/profile/user/17020714?utm_...
// so the id is the path segment after /user/; older links may carry a UUID
// a league or club link pasted by mistake yields no id rather than a wrong one
const playerIdFrom = (url: string) => (url.match(/\/profile\/user\/([A-Za-z0-9-]+)/) || [null, null])[1];

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`db_error ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
const rpc = (fn: string, args: Record<string, unknown>) => db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
const patch = (table: string, id: string, body: Record<string, unknown>) =>
  db(`${table}?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
const log = (reg: string, action: string, detail: Record<string, unknown> = {}, actor: string | null = null) =>
  rpc("league_log", { p_reg: reg, p_action: action, p_detail: detail, p_actor: actor }).catch(() => {});

async function stripe(path: string, params?: Record<string, string>, method?: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: method ?? (params ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "stripe_error");
  return data;
}

async function currentUser(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const who = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
  const user = who.ok ? await who.json() : null;
  return user?.id ? user : null;
}
async function isAdmin(userId: string) {
  const rows = await db(`staff_roles?user_id=eq.${userId}&select=role`);
  return rows[0]?.role === "admin";
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function schedule(league: Record<string, unknown>) {
  const start = new Date(`${league.season_start}T12:00:00Z`);
  const weeks = Number(league.weeks);
  const last = new Date(start.getTime() + (weeks - 1) * 7 * 86400000);
  const future = start.getTime() > Date.now() + 120000;
  return { season_start: league.season_start, weeks, payments_total: weeks,
    first_payment_date: future ? iso(start) : null, last_payment_date: iso(last) };
}
const leagueOpen = (l: Record<string, unknown>) =>
  !!(l && l.registration_open && l.member_price_pence && l.nonmember_price_pence && l.season_start && l.weeks);

async function customerFor(user: { id: string; email: string }, name: string) {
  const [prof] = await db(`profiles?user_id=eq.${user.id}&select=stripe_customer_id`);
  if (prof?.stripe_customer_id) return prof.stripe_customer_id as string;
  const c = await stripe("customers", { email: user.email, name, "metadata[user_id]": user.id });
  await db(`profiles?user_id=eq.${user.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ stripe_customer_id: c.id }) });
  return c.id as string;
}

async function setupSession(reg: Record<string, unknown>, customer: string, type: "league" | "league_card", origin: string) {
  const s = await stripe("checkout/sessions", {
    mode: "setup",
    customer,
    "payment_method_types[0]": "card",
    success_url: `${origin}/northampton-padel-league/register/?done=1`,
    cancel_url: `${origin}/northampton-padel-league/register/?cancelled=1`,
    "metadata[type]": type,
    "metadata[registration_id]": String(reg.id),
  });
  await patch("league_registrations", String(reg.id), { stripe_setup_session_id: s.id, stripe_customer_id: customer });
  return s.url as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!STRIPE_KEY) return json({ error: "payments_not_configured" }, 503);

  const user = await currentUser(req);
  if (!user) return json({ error: "account_required" }, 401);
  const reqOrigin = req.headers.get("origin") || "";
  const origin = ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : SITE;

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    // ---------------- member actions ----------------
    if (action === "quote" || action === "register") {
      const [league] = await db(`leagues?id=eq.${body.league_id}&select=*`);
      if (!leagueOpen(league)) return json({ error: "league_closed" }, 409);

      const [profile] = await db(`profiles?user_id=eq.${user.id}&select=full_name,phone,phone_verified_at`);
      const [settings] = await db("settings?id=eq.1&select=require_phone_verification");
      if (!profile?.phone) return json({ error: "profile_incomplete" }, 409);
      if (settings?.require_phone_verification && !profile.phone_verified_at) return json({ error: "phone_unverified" }, 409);

      const membership = await rpc("league_membership_check", { p_email: user.email, p_phone: profile.phone });
      const price = membership === "member" ? league.member_price_pence : league.nonmember_price_pence;
      const sched = schedule(league);

      if (action === "quote") {
        return json({ league: { id: league.id, name: league.name, kind: league.kind }, membership_status: membership, weekly_price_pence: price, ...sched });
      }

      const playtomic = String(body.playtomic_url || "").trim();
      if (!PLAYTOMIC.test(playtomic)) return json({ error: "bad_playtomic_url" }, 400);

      // one live registration per league; a half-finished one is picked up again
      let [reg] = await db(`league_registrations?league_id=eq.${league.id}&user_id=eq.${user.id}&cancelled_at=is.null&select=*`);
      if (reg && reg.card_status === "authorised") return json({ error: "already_registered" }, 409);
      const name = profile.full_name || user.email.split("@")[0];
      if (reg) {
        [reg] = await patch("league_registrations", reg.id, {
          playtomic_url: playtomic, playtomic_player_id: playerIdFrom(playtomic), membership_status: membership, membership_checked_at: new Date().toISOString(),
          weekly_price_pence: price, terms_accepted_at: new Date().toISOString(), name, email: user.email, phone: profile.phone,
        });
      } else {
        [reg] = await db("league_registrations", {
          method: "POST", headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            league_id: league.id, user_id: user.id, name, email: user.email, phone: profile.phone,
            playtomic_url: playtomic, playtomic_player_id: playerIdFrom(playtomic), membership_status: membership, weekly_price_pence: price,
            terms_accepted_at: new Date().toISOString(),
          }),
        });
        await log(reg.id, "registration_started", { membership, weekly_price_pence: price }, user.id);
      }

      if (league.kind === "doubles" && body.partner_code && !reg.pair_id) {
        const r = await rpc("league_join_by_code", { p_reg: reg.id, p_code: String(body.partner_code) });
        if (!r?.ok) return json({ error: r?.reason || "code_not_found" }, 409);
      }

      const customer = await customerFor(user, name);
      const url = await setupSession(reg, customer, "league", origin);
      return json({ url, registration_id: reg.id });
    }

    if (action === "resume" || action === "update_card") {
      const [reg] = await db(`league_registrations?id=eq.${body.registration_id}&user_id=eq.${user.id}&cancelled_at=is.null&select=*`);
      if (!reg) return json({ error: "not_found" }, 404);
      const [league] = await db(`leagues?id=eq.${reg.league_id}&select=*`);
      if (action === "resume" && reg.card_status === "authorised") return json({ error: "already_registered" }, 409);
      if (action === "resume" && !leagueOpen(league)) return json({ error: "league_closed" }, 409);
      const customer = reg.stripe_customer_id || await customerFor(user, reg.name);
      const url = await setupSession(reg, customer, action === "resume" ? "league" : "league_card", origin);
      return json({ url });
    }

    // ---------------- admin actions ----------------
    if (["set_membership", "set_price", "stop_billing", "cancel"].includes(action)) {
      if (!(await isAdmin(user.id))) return json({ error: "forbidden" }, 403);
      const [reg] = await db(`league_registrations?id=eq.${body.registration_id}&select=*`);
      if (!reg) return json({ error: "not_found" }, 404);
      const [league] = await db(`leagues?id=eq.${reg.league_id}&select=*`);

      if (action === "set_membership" || action === "set_price") {
        if (reg.payments_taken > 0) return json({ error: "payments_started" }, 409);
        let status = reg.membership_status, pence = reg.weekly_price_pence;
        if (action === "set_membership") {
          status = String(body.status);
          if (!["member", "non_member", "review"].includes(status)) return json({ error: "bad_request" }, 400);
          pence = status === "member" ? league.member_price_pence : league.nonmember_price_pence;
        } else {
          pence = parseInt(body.pence, 10);
          if (!(pence >= 100 && pence <= 20000)) return json({ error: "bad_request" }, 400);
        }
        // a scheduled subscription is re-priced in place; no payment has happened yet
        if (reg.stripe_subscription_id && league.stripe_product_id) {
          const sub = await stripe(`subscriptions/${reg.stripe_subscription_id}`);
          const itemId = sub.items?.data?.[0]?.id;
          if (itemId) {
            await stripe(`subscriptions/${reg.stripe_subscription_id}`, {
              "items[0][id]": itemId,
              "items[0][price_data][currency]": "gbp",
              "items[0][price_data][unit_amount]": String(pence),
              "items[0][price_data][recurring][interval]": "week",
              "items[0][price_data][product]": league.stripe_product_id,
              proration_behavior: "none",
            });
          }
        }
        await patch("league_registrations", reg.id, { membership_status: status, weekly_price_pence: pence, membership_checked_at: new Date().toISOString() });
        await log(reg.id, action === "set_membership" ? "membership_overridden" : "price_overridden",
          { from_status: reg.membership_status, to_status: status, from_pence: reg.weekly_price_pence, to_pence: pence }, user.id);
        return json({ ok: true, weekly_price_pence: pence, membership_status: status });
      }

      if (action === "stop_billing" || action === "cancel") {
        if (reg.stripe_subscription_id && !reg.billing_ended_at) {
          await stripe(`subscriptions/${reg.stripe_subscription_id}`, undefined, "DELETE").catch((e) => {
            if (!/No such subscription|canceled/i.test(String(e.message))) throw e;
          });
        }
        const upd: Record<string, unknown> = { billing_ended_at: new Date().toISOString() };
        if (action === "cancel") upd.cancelled_at = new Date().toISOString();
        await patch("league_registrations", reg.id, upd);
        await log(reg.id, action === "cancel" ? "registration_cancelled" : "billing_stopped", {}, user.id);
        if (action === "cancel" && reg.pair_id) {
          // the partner goes back to waiting, they are not cancelled
          await db(`league_registrations?pair_id=eq.${reg.pair_id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ pair_id: null }) });
          await db(`league_pairs?id=eq.${reg.pair_id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
        }
        return json({ ok: true });
      }
    }

    return json({ error: "bad_request" }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: "server_error", detail: String((err as Error).message) }, 500);
  }
});
