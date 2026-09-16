// Padel Power · mirror the club's Playtomic leagues into the leagues table
// Runs hourly from pg_cron (x-pp-key), and on demand from the Sync now
// button on the Studio Manager Leagues page (admin session).
// Uses the internal Manager API with a real Manager login, the same way
// the standings feed does: login for a customer token, exchange it for a
// tenant-manager token, list leagues. Tokens last an hour, so log in every run.
// A linked league that Playtomic no longer lists as open, pending or in
// progress (deleted, cancelled or finished) is marked GONE, which closes it.
//
// Each league also brings the dates and size that drive registration
// (league_state in migration 021): the start date as a London calendar date,
// Playtomic's enrolment end, capacity (groups x teams per group) and the ids
// of active teams (no leaving_reason). Players in active teams of leagues in
// progress, or finished in the last 4 months, are the "returning players"
// who get the 5-day head start; that list is rebuilt on every complete sync.
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

const LIST = `${MGR}/api/v1/leagues?tenant_id=${TENANT}&visibility=PRIVATE,PUBLIC&sport_id=PADEL&sort=league_start_date,desc`;
const PAGE = 50;
const RETURNING_MONTHS = 4;

// Playtomic dates carry no zone and are UTC ("2026-10-18T23:00:00" is 19 Oct in London)
const utc = (v: unknown) => {
  const s = String(v ?? "");
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return isNaN(d.getTime()) ? null : d;
};
const londonDate = (d: Date | null) =>
  d ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d) : null;
const plusMonths = (d: Date, n: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };

type Team = { team_id?: string; players?: { user_id?: string }[]; registered_info?: { leaving_reason?: unknown } };
const activeTeams = (l: Record<string, unknown>) =>
  (Array.isArray(l.registered_teams) ? l.registered_teams as Team[] : []).filter((t) => !t.registered_info?.leaving_reason);

// every page of a listing; null if any page fails or is not a list
async function listAll(tok: string, statuses: string): Promise<Record<string, unknown>[] | null> {
  const all: Record<string, unknown>[] = [];
  for (let page = 0; page < 20; page++) {
    const r = await fetch(`${LIST}&status=${statuses}&page=${page}&size=${PAGE}`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!r || !r.ok) return null;
    const d = await r.json().catch(() => null);
    const rows = Array.isArray(d) ? d : null;
    if (!rows) return null;
    all.push(...rows);
    if (rows.length < PAGE) return all;
  }
  return null;
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
    const fetchedAt = new Date().toISOString();
    const leagues = await listAll(tok, "OPEN,PENDING,IN_PROGRESS");
    if (!leagues) return json({ error: "list_failed" }, 502);
    const out: unknown[] = [];
    const liveIds: string[] = [];
    for (const l of leagues) {
      const id = String(l.league_id ?? "");
      const name = String(l.league_name ?? l.name ?? "").trim();
      if (!id || !name) continue;
      liveIds.push(id);
      const ri = (l.registration_info ?? {}) as Record<string, unknown>;
      const start = londonDate(utc(l.league_start_date));
      const enrolEnd = utc(ri.enrolment_end_date)?.toISOString() ?? null;
      const capacity = Number(ri.number_of_groups ?? 0) * Number(ri.teams_per_group ?? 0) || null;
      const teamIds = activeTeams(l).map((t) => String(t.team_id ?? "")).filter(Boolean);
      const rr = await fetch(`${SB_URL}/rest/v1/rpc/league_upsert_from_playtomic`, {
        method: "POST", headers: H,
        body: JSON.stringify({
          p_playtomic_id: id, p_name: name, p_kind: kindOf(l), p_status: String(l.league_status ?? ""),
          p_url: `https://app.playtomic.io/leagues/${id}`, p_start: start, p_enrol_end: enrolEnd,
          p_capacity: capacity, p_team_ids: teamIds, p_fetched_at: fetchedAt,
        }),
      });
      const res = rr.ok ? await rr.json().catch(() => ({})) : null;
      out.push({ id, name, status: l.league_status, start, enrol_end: enrolEnd, capacity, teams: teamIds.length,
        kind: kindOf(l), ok: rr.ok, start_kept: res?.start_kept || undefined, rr: rr.ok ? undefined : (await rr.text()).slice(0, 200) });
    }

    // returning players: active teams in leagues in progress, or finished in the
    // last few months. Only a complete listing replaces the list.
    let returning: number | string = "skipped";
    const past = await listAll(tok, "IN_PROGRESS,PLAYED");
    if (past) {
      const now = Date.now();
      const rows: { player_id: string; league_id: string; expires_at: string }[] = [];
      for (const l of past) {
        const end = utc(l.league_end_date);
        const expires = end ? plusMonths(end, RETURNING_MONTHS) : null;
        if (l.league_status === "PLAYED" && (!expires || expires.getTime() <= now)) continue;
        const exp = (expires && expires.getTime() > now ? expires : plusMonths(new Date(), RETURNING_MONTHS)).toISOString();
        for (const t of activeTeams(l)) {
          for (const p of t.players ?? []) {
            if (p.user_id) rows.push({ player_id: String(p.user_id), league_id: String(l.league_id), expires_at: exp });
          }
        }
      }
      const rp = await fetch(`${SB_URL}/rest/v1/rpc/league_replace_returning`, { method: "POST", headers: H, body: JSON.stringify({ p_rows: rows }) });
      returning = rp.ok ? await rp.json() : `failed ${rp.status}`;
    }

    // leagues Playtomic no longer lists stop taking registrations. Only when the
    // list came back with something, so a bad response never closes everything.
    let closed: string[] = [];
    if (liveIds.length) {
      const cr = await fetch(
        `${SB_URL}/rest/v1/leagues?playtomic_league_id=not.is.null&playtomic_league_id=not.in.(${liveIds.join(",")})&playtomic_status=neq.GONE&select=name`,
        { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ playtomic_status: "GONE", synced_at: new Date().toISOString() }) },
      );
      closed = cr.ok ? (await cr.json()).map((x: { name: string }) => x.name) : [];
    }
    return json({ synced: out.length, leagues: out, closed, returning });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 502);
  }
});
