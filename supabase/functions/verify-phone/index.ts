// Padel Power · mobile verification by SMS code
// A signed-in member proves the number on their profile with a 6 digit
// code, sent by ClickSend. The code is generated here, hashed and stored
// by the database, and never returned to the browser.
//
// GET                            -> { verified, phone_masked, pending, configured }
// POST { action: "send" }        -> { sent, phone_masked, minutes }
// POST { action: "check", code } -> { verified }
//
// Rate limits, the attempt counter and the expiry all live in SQL
// (issue_phone_code / check_phone_code) so two racing requests cannot
// both slip past the same limit.
//
// Secrets, set in Supabase → Edge Functions → Secrets:
//   CLICKSEND_USERNAME   ClickSend account username
//   CLICKSEND_API_KEY    ClickSend API key
//   CLICKSEND_FROM       optional sender ID; omit to use the account default

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CS_USER = Deno.env.get("CLICKSEND_USERNAME") ?? "";
const CS_KEY = Deno.env.get("CLICKSEND_API_KEY") ?? "";
const CS_FROM = Deno.env.get("CLICKSEND_FROM") ?? "";

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

const rpc = (fn: string, args: Record<string, unknown>) =>
  db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

async function currentUser(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const who = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  const user = who.ok ? await who.json() : null;
  return user?.id ? user : null;
}

// 6 digits from a real random source, never Math.random
function makeCode(): string {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(b[0] % 1000000).padStart(6, "0");
}

// keep the last three digits so the member can tell which number it went to
function mask(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length < 4 ? "your mobile" : `•••••• ${digits.slice(-3)}`;
}

// ClickSend wants E.164 with no spaces. A UK number typed as 07... is
// assumed to be UK, matching the country code picker on the signup form.
function e164(phone: string): string {
  let p = phone.replace(/[^\d+]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (p.startsWith("0")) p = "+44" + p.slice(1);
  if (!p.startsWith("+")) p = "+" + p;
  return p;
}

async function sendSms(to: string, body: string) {
  const message: Record<string, string> = { to, body, source: "padelpower-web" };
  if (CS_FROM) message.from = CS_FROM;

  const res = await fetch("https://rest.clicksend.com/v3/sms/send", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${CS_USER}:${CS_KEY}`),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messages: [message] }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error(`clicksend ${res.status}: ${JSON.stringify(data)}`);
    return { ok: false, reason: res.status === 401 ? "sms_auth_failed" : "sms_failed" };
  }
  const m = data?.data?.messages?.[0] ?? {};
  const status = String(m.status ?? "").toUpperCase();
  if (status !== "SUCCESS") {
    console.error(`clicksend rejected: ${JSON.stringify(m)}`);
    // the number itself is wrong, which is worth saying plainly
    const bad = /INVALID|BAD_?REQUEST|NOT_?VALID/.test(status);
    return { ok: false, reason: bad ? "bad_number" : "sms_failed", status };
  }
  return { ok: true, id: String(m.message_id ?? ""), status };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const user = await currentUser(req);
    if (!user) return json({ error: "account_required" }, 401);

    const [profiles, settings] = await Promise.all([
      db(`profiles?user_id=eq.${user.id}&select=phone,phone_verified_at`),
      db("settings?id=eq.1&select=sms_verification_template,verification_code_minutes,require_phone_verification"),
    ]);
    const profile = profiles[0] || {};
    const cfg = settings[0] || {};
    const configured = !!(CS_USER && CS_KEY);

    // ---- GET: where this member stands ----
    if (req.method === "GET") {
      const pending = await db(
        `phone_verifications?user_id=eq.${user.id}&verified_at=is.null&expires_at=gt.${new Date().toISOString()}&select=expires_at&order=created_at.desc&limit=1`,
      );
      return json({
        verified: !!profile.phone_verified_at,
        required: !!cfg.require_phone_verification,
        configured,
        phone_masked: profile.phone ? mask(profile.phone) : null,
        pending: pending.length > 0,
        expires_at: pending[0]?.expires_at ?? null,
      });
    }

    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await req.json().catch(() => ({}));

    // ---- check a code ----
    if (body.action === "check") {
      const code = String(body.code ?? "").replace(/\D/g, "");
      if (code.length !== 6) return json({ error: "wrong_code", attempts_left: null }, 400);
      const r = await rpc("check_phone_code", { p_user_id: user.id, p_code: code });
      if (!r?.ok) {
        return json({ error: r?.reason ?? "wrong_code", attempts_left: r?.attempts_left ?? null }, 400);
      }
      return json({ verified: true });
    }

    // ---- send a code ----
    if (body.action === "send") {
      if (profile.phone_verified_at) return json({ verified: true, already: true });
      if (!configured) return json({ error: "sms_not_configured" }, 503);

      const code = makeCode();
      const issued = await rpc("issue_phone_code", { p_user_id: user.id, p_code: code });
      if (!issued?.ok) {
        const status = issued?.reason === "no_phone" ? 400 : 429;
        return json({ error: issued?.reason ?? "rate_limited", retry_after: issued?.retry_after ?? null }, status);
      }

      const minutes = issued.minutes ?? cfg.verification_code_minutes ?? 10;
      const text = String(cfg.sms_verification_template ?? "")
        .replaceAll("{code}", code)
        .replaceAll("{minutes}", String(minutes));

      const sent = await sendSms(e164(issued.phone), text);

      // record what the provider said, then bin the code if it never went
      await db(`phone_verifications?id=eq.${issued.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          provider_message_id: sent.ok ? sent.id : null,
          provider_status: sent.ok ? sent.status : (sent.status ?? sent.reason),
          // a code that was never delivered should not sit there blocking
          // the next attempt, so expire it immediately
          ...(sent.ok ? {} : { expires_at: new Date().toISOString() }),
        }),
      });

      if (!sent.ok) return json({ error: sent.reason }, sent.reason === "bad_number" ? 400 : 502);

      return json({ sent: true, phone_masked: mask(issued.phone), minutes });
    }

    return json({ error: "bad_request" }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: "server_error" }, 500);
  }
});
