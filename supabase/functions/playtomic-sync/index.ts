// Padel Power · mirror the club's Playtomic leagues into the leagues table
// Runs hourly from pg_cron (x-pp-key), or by hand with the same header.
// Uses the internal Manager API with a real Manager login, the same way
// the standings feed does: login for a customer token, exchange it for a
// tenant-manager token, list leagues. Tokens last an hour, so log in every run.
//
// Secrets: PLAYTOMIC_MANAGER_EMAIL, PLAYTOMIC_MANAGER_PASSWORD

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL = Deno.env.get("PLAYTOMIC_MANAGER_EMAIL") ?? "";
const PASSWORD = Deno.env.get("PLAYTOMIC_MANAGER_PASSWORD") ?? "";
const TENANT = "95214d52-1a73-44be-b5f8-7aafee310010";
const MGR = "https://manager.playtomic.io";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };

async function keyOk(req: Request) {
  const k = req.headers.get("x-pp-key") || "";
  if (!k) return false;
  const r = await fetch(`${SB_URL}/rest/v1/rpc/pp_internal_key_ok`, { method: "POST", headers: H, body: JSON.stringify({ p_key: k }) });
  return r.ok && (await r.json()) === true;
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

// singles or doubles from whatever Playtomic gives us, falling back to the name
function kindOf(l: Record<string, unknown>): string {
  const size = Number(l.team_size ?? l.players_per_team ?? (l.team_config as Record<string, unknown>)?.size ?? 0);
  if (size === 1) return "singles";
  if (size === 2) return "doubles";
  return /single/i.test(String(l.name ?? "")) ? "singles" : "doubles";
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await keyOk(req))) return json({ error: "forbidden" }, 403);
  if (!EMAIL || !PASSWORD) return json({ error: "manager_login_not_configured" }, 503);
  try {
    const tok = await managerToken();
    const u = `${MGR}/api/v1/leagues?tenant_id=${TENANT}&status=OPEN,PENDING,IN_PROGRESS&visibility=PRIVATE,PUBLIC&sport_id=PADEL&sort=league_start_date,desc&page=0&size=50`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return json({ error: "list_failed", status: r.status, body: (await r.text()).slice(0, 300) }, 502);
    const d = await r.json();
    const leagues: Record<string, unknown>[] = Array.isArray(d) ? d : (d.leagues ?? d.data ?? d.content ?? []);
    const out: unknown[] = [];
    for (const l of leagues) {
      const id = String(l.league_id ?? l.id ?? "");
      const name = String(l.name ?? "").trim();
      if (!id || !name) continue;
      const rr = await fetch(`${SB_URL}/rest/v1/rpc/league_upsert_from_playtomic`, {
        method: "POST", headers: H,
        body: JSON.stringify({ p_playtomic_id: id, p_name: name, p_kind: kindOf(l), p_status: String(l.status ?? ""), p_url: `https://app.playtomic.io/leagues/${id}` }),
      });
      out.push({ id, name, status: l.status, kind: kindOf(l), ok: rr.ok });
    }
    return json({ synced: out.length, leagues: out, sample_keys: leagues[0] ? Object.keys(leagues[0]).slice(0, 40) : [] });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 502);
  }
});
