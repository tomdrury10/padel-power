// Padel Power · mirror the club's Playtomic leagues into the leagues table
// Runs hourly from pg_cron (x-pp-key), and on demand from the Sync now
// button on the Studio Manager Leagues page (admin session).
// Uses the internal Manager API with a real Manager login, the same way
// the standings feed does: login for a customer token, exchange it for a
// tenant-manager token, list leagues. Tokens last an hour, so log in every run.
// A linked league that Playtomic no longer lists as open, pending or in
// progress (deleted, cancelled or finished) is closed for registration here.
//
// Secrets: PLAYTOMIC_MANAGER_EMAIL, PLAYTOMIC_MANAGER_PASSWORD

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL = Deno.env.get("PLAYTOMIC_MANAGER_EMAIL") ?? "";
const PASSWORD = Deno.env.get("PLAYTOMIC_MANAGER_PASSWORD") ?? "";
const TENANT = "95214d52-1a73-44be-b5f8-7aafee310010";
const MGR = "https://manager.playtomic.io";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-pp-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

async function keyOk(req: Request) {
  const k = req.headers.get("x-pp-key") || "";
  if (!k) return false;
  const r = await fetch(`${SB_URL}/rest/v1/rpc/pp_internal_key_ok`, { method: "POST", headers: H, body: JSON.stringify({ p_key: k }) });
  return r.ok && (await r.json()) === true;
}

// an admin pressing Sync now in the Studio Manager; members and instructors are refused
async function adminOk(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const who = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } });
  const user = who.ok ? await who.json() : null;
  if (!user?.id) return false;
  const r = await fetch(`${SB_URL}/rest/v1/staff_roles?user_id=eq.${user.id}&select=role`, { headers: H });
  const rows = r.ok ? await r.json() : [];
  return rows[0]?.role === "admin";
}

async function managerToken(): Promise<string> {
  const login = await fetch(`${MGR}/api/v3/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requested_user_scopes: [{ role: "ROLE_CUSTOMER", scope_id: null }], token_generation_mode: "USER_PERMISSION", email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login ${login.status}`);
  const l = await login.json();
  const ex = await fetch(`${MGR}/api/v3/auth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: l.refresh_token, token_generation_mode: "USER_PERMISSION", requested_user_scopes: [{ role: "ROLE_TENANT_MANAGER", scope_id: TENANT }] }),
  });
  if (!ex.ok) throw new Error(`token ${ex.status}`);
  const t = await ex.json();
  return t.access_token;
}

// Playtomic says how many players make a team under registration_info
function kindOf(l: Record<string, unknown>): string {
  const reg = (l.registration_info ?? {}) as Record<string, unknown>;
  const size = Number(reg.players_per_team ?? 0);
  if (size === 1) return "singles";
  if (size >= 2) return "doubles";
  return /single/i.test(String(l.league_name ?? "")) ? "singles" : "doubles";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await keyOk(req)) && !(await adminOk(req))) return json({ error: "forbidden" }, 403);
  if (!EMAIL || !PASSWORD) return json({ error: "manager_login_not_configured" }, 503);
  try {
    const tok = await managerToken();
    const u = `${MGR}/api/v1/leagues?tenant_id=${TENANT}&status=OPEN,PENDING,IN_PROGRESS&visibility=PRIVATE,PUBLIC&sport_id=PADEL&sort=league_start_date,desc&page=0&size=50`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return json({ error: "list_failed", status: r.status, body: (await r.text()).slice(0, 300) }, 502);
    const d = await r.json();
    const leagues: Record<string, unknown>[] = Array.isArray(d) ? d : (d.leagues ?? d.data ?? d.content ?? []);
    const out: unknown[] = [];
    const liveIds: string[] = [];
    for (const l of leagues) {
      const id = String(l.league_id ?? "");
      const name = String(l.league_name ?? l.name ?? "").trim();
      if (!id || !name) continue;
      liveIds.push(id);
      const start = String(l.league_start_date ?? "").slice(0, 10) || null;
      const rr = await fetch(`${SB_URL}/rest/v1/rpc/league_upsert_from_playtomic`, {
        method: "POST", headers: H,
        body: JSON.stringify({ p_playtomic_id: id, p_name: name, p_kind: kindOf(l), p_status: String(l.league_status ?? ""), p_url: `https://app.playtomic.io/leagues/${id}`, p_start: start }),
      });
      const teams = Array.isArray(l.registered_teams) ? l.registered_teams.length : l.registered_teams;
      out.push({ id, name, status: l.league_status, start, teams, kind: kindOf(l), ok: rr.ok, rr: rr.ok ? undefined : await rr.text() });
    }

    // leagues Playtomic no longer lists stop taking registrations. Only when the
    // list came back with something, so a bad response never closes everything.
    let closed: string[] = [];
    if (liveIds.length) {
      const cr = await fetch(
        `${SB_URL}/rest/v1/leagues?playtomic_league_id=not.is.null&playtomic_league_id=not.in.(${liveIds.join(",")})&or=(registration_open.eq.true,playtomic_status.neq.GONE)&select=name`,
        { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ registration_open: false, playtomic_status: "GONE", synced_at: new Date().toISOString() }) },
      );
      closed = cr.ok ? (await cr.json()).map((x: { name: string }) => x.name) : [];
    }
    return json({ synced: out.length, leagues: out, closed });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 502);
  }
});
