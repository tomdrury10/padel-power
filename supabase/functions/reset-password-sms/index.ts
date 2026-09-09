// Padel Power · password reset by text
// A member who has proved their mobile gets a one-time link texted to it,
// rather than emailed. Auth email on this project still goes through
// Supabase's shared testing sender, which refuses everything after about
// two messages an hour, so email reset is not dependable.
//
// POST { action: "request", email }          -> { sent: true }  (always)
// POST { action: "peek",    token }          -> { ok, email }
// POST { action: "complete", token, password } -> { ok, email }
//
// "request" deliberately answers the same way whatever happens: no
// account, no verified mobile, rate limited or sent. Anything else turns
// this endpoint into a way of asking which email addresses are members.
//
// Secrets, shared with verify-phone:
//   CLICKSEND_USERNAME / CLICKSEND_API_KEY / CLICKSEND_FROM (optional)

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CS_USER = Deno.env.get("CLICKSEND_USERNAME") ?? "";
const CS_KEY = Deno.env.get("CLICKSEND_API_KEY") ?? "";
const CS_FROM = Deno.env.get("CLICKSEND_FROM") ?? "";

const SITE = "https://www.padelpower.uk";
const MIN_PASSWORD = 8;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
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
const rpc = (fn: string, args: Record<string, unknown>) =>
  db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

// 32 random bytes, hex. Long enough that the digest needs no salting.
function makeToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

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
  const status = String(data?.data?.messages?.[0]?.status ?? "").toUpperCase();
  if (!res.ok || status !== "SUCCESS") {
    console.error(`reset sms failed ${res.status}: ${JSON.stringify(data?.data?.messages?.[0] ?? data)}`);
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));

    // ---- ask for a link ----
    if (body.action === "request") {
      const email = String(body.email ?? "").trim().toLowerCase().slice(0, 120);
      // one response for every outcome, so this cannot be used to test
      // whether an address has an account here
      const sameAnswer = json({ sent: true });
      if (!email || !CS_USER || !CS_KEY) {
        if (!CS_USER || !CS_KEY) console.error("reset requested but ClickSend is not configured");
        return sameAnswer;
      }

      const token = makeToken();
      const issued = await rpc("issue_password_reset", { p_email: email, p_token: token });
      if (!issued?.ok) {
        console.log(`reset not issued for ${email}: ${issued?.reason}`);
        return sameAnswer;
      }

      const cfg = await db("settings?id=eq.1&select=sms_reset_template");
      const text = String(cfg[0]?.sms_reset_template ?? "")
        .replaceAll("{link}", `${SITE}/account/?reset_token=${token}`)
        .replaceAll("{minutes}", String(issued.minutes ?? 15));

      const ok = await sendSms(e164(issued.phone), text);
      // if the text never left, burn the token rather than leave a live
      // reset link sitting in the table
      if (!ok) {
        await rpc("consume_password_reset", { p_token: token }).catch(() => {});
      }
      return sameAnswer;
    }

    // ---- who is this link for ----
    if (body.action === "peek") {
      const token = String(body.token ?? "");
      if (!/^[a-f0-9]{64}$/.test(token)) return json({ ok: false });
      const r = await rpc("peek_password_reset", { p_token: token });
      return json({ ok: !!r?.ok, email: r?.email ?? null });
    }

    // ---- set the new password ----
    if (body.action === "complete") {
      const token = String(body.token ?? "");
      const password = String(body.password ?? "");
      if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: "invalid" }, 400);
      if (password.length < MIN_PASSWORD) return json({ error: "weak_password" }, 400);

      // spending the token and setting the password are one shot: if the
      // token was already used or has expired, nothing happens
      const r = await rpc("consume_password_reset", { p_token: token });
      if (!r?.ok) return json({ error: r?.reason ?? "invalid" }, 400);

      const res = await fetch(`${SB_URL}/auth/v1/admin/users/${r.user_id}`, {
        method: "PUT",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        console.error(`admin password update failed: ${res.status} ${await res.text()}`);
        return json({ error: "server_error" }, 500);
      }

      // whoever was signed in elsewhere is signed out: if someone else
      // had the account, changing the password should end their session
      await fetch(`${SB_URL}/auth/v1/admin/users/${r.user_id}/logout`, {
        method: "POST",
        headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      }).catch(() => {});

      return json({ ok: true, email: r.email });
    }

    return json({ error: "bad_request" }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: "server_error" }, 500);
  }
});
