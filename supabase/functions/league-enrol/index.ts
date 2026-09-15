// Padel Power · put completed registrations into their Playtomic league
// Key-locked (x-pp-key). Called every 15 minutes by pg_cron, nudged when a
// card is saved, and by league-register when a registration is cancelled.
//
// POST { action: "sweep" }                       enrol everything that is ready
// POST { action: "remove", registration_id }     take a registration's team out
//
// Uses the internal Manager API found by watching Playtomic Manager:
//   POST   /api/v1/leagues/{league}/teams   { players: [ids], invited_by_manager: true } -> { team_id }
//   DELETE /api/v1/leagues/{league}/teams/{team_id}
// Ready means: card saved, a Playtomic player id from the share link,
// the league has a Playtomic id, and for doubles a partner who is also
// ready. Failures are written to playtomic_error and retried next sweep.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL = Deno.env.get("PLAYTOMIC_MANAGER_EMAIL") ?? "";
const PASSWORD = Deno.env.get("PLAYTOMIC_MANAGER_PASSWORD") ?? "";
const TENANT = "95214d52-1a73-44be-b5f8-7aafee310010";
const MGR = "https://manager.playtomic.io";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`db ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
const patchReg = (id: string, body: Record<string, unknown>) =>
  db(`league_registrations?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
const log = (reg: string, action: string, detail: Record<string, unknown> = {}) =>
  db("rpc/league_log", { method: "POST", body: JSON.stringify({ p_reg: reg, p_action: action, p_detail: detail, p_actor: null }) }).catch(() => {});

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
  if (!login.ok) throw new Error(`playtomic login ${login.status}`);
  const l = await login.json();
  const ex = await fetch(`${MGR}/api/v3/auth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: l.refresh_token, token_generation_mode: "USER_PERMISSION", requested_user_scopes: [{ role: "ROLE_TENANT_MANAGER", scope_id: TENANT }] }),
  });
  if (!ex.ok) throw new Error(`playtomic token ${ex.status}`);
  return (await ex.json()).access_token;
}

type Reg = Record<string, unknown> & { id: string; league_id: string; pair_id: string | null; playtomic_player_id: string | null; playtomic_team_id: string | null; card_status: string; cancelled_at: string | null; name: string };

async function addTeam(tok: string, leagueId: string, players: string[]) {
  const r = await fetch(`${MGR}/api/v1/leagues/${leagueId}/teams`, {
    method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ players, invited_by_manager: true }),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`add team ${r.status}: ${txt.slice(0, 200)}`);
  const d = JSON.parse(txt);
  return String(d.team_id);
}
async function removeTeam(tok: string, leagueId: string, teamId: string) {
  const r = await fetch(`${MGR}/api/v1/leagues/${leagueId}/teams/${teamId}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok && r.status !== 404) throw new Error(`remove team ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await keyOk(req))) return json({ error: "forbidden" }, 403);
  if (!EMAIL || !PASSWORD) return json({ error: "manager_login_not_configured" }, 503);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "sweep");
  let tok: string | null = null;
  const token = async () => tok ?? (tok = await managerToken());

  try {
    if (action === "remove") {
      const [reg] = await db(`league_registrations?id=eq.${body.registration_id}&select=*`) as Reg[];
      if (!reg?.playtomic_team_id) return json({ ok: true, skipped: "no team" });
      const [league] = await db(`leagues?id=eq.${reg.league_id}&select=playtomic_league_id`);
      if (!league?.playtomic_league_id) return json({ ok: true, skipped: "no league id" });
      await removeTeam(await token(), league.playtomic_league_id, reg.playtomic_team_id);
      // a doubles partner shares the team: they go back to waiting for a new one
      await db(`league_registrations?playtomic_team_id=eq.${reg.playtomic_team_id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ playtomic_team_id: null, playtomic_added_at: null }),
      });
      await log(reg.id, "playtomic_removed", { team_id: reg.playtomic_team_id });
      return json({ ok: true, removed: reg.playtomic_team_id });
    }

    // ---- sweep ----
    const regs = await db(
      "league_registrations?select=*,leagues(kind,playtomic_league_id)&cancelled_at=is.null&card_status=eq.authorised&playtomic_team_id=is.null&playtomic_player_id=not.is.null",
    ) as (Reg & { leagues: { kind: string; playtomic_league_id: string | null } })[];
    const done: unknown[] = []; const seenPairs = new Set<string>();
    for (const r of regs) {
      const lid = r.leagues?.playtomic_league_id;
      if (!lid) continue;
      try {
        if (r.leagues.kind === "singles") {
          const teamId = await addTeam(await token(), lid, [String(r.playtomic_player_id)]);
          await patchReg(r.id, { playtomic_team_id: teamId, playtomic_added_at: new Date().toISOString(), playtomic_error: null });
          await log(r.id, "playtomic_added", { team_id: teamId, by: "auto" });
          done.push({ id: r.id, team: teamId });
        } else {
          if (!r.pair_id || seenPairs.has(r.pair_id)) continue;
          const partner = regs.find((x) => x.pair_id === r.pair_id && x.id !== r.id);
          if (!partner) continue;                       // partner not ready yet
          seenPairs.add(r.pair_id);
          const teamId = await addTeam(await token(), lid, [String(r.playtomic_player_id), String(partner.playtomic_player_id)]);
          const now = new Date().toISOString();
          await patchReg(r.id, { playtomic_team_id: teamId, playtomic_added_at: now, playtomic_error: null });
          await patchReg(partner.id, { playtomic_team_id: teamId, playtomic_added_at: now, playtomic_error: null });
          await log(r.id, "playtomic_added", { team_id: teamId, partner: partner.id, by: "auto" });
          await log(partner.id, "playtomic_added", { team_id: teamId, partner: r.id, by: "auto" });
          done.push({ id: r.id, partner: partner.id, team: teamId });
        }
      } catch (e) {
        const msg = String((e as Error).message).slice(0, 300);
        await patchReg(r.id, { playtomic_error: msg });
        await log(r.id, "playtomic_failed", { error: msg });
        done.push({ id: r.id, error: msg });
      }
    }
    return json({ candidates: regs.length, done });
  } catch (e) {
    return json({ error: String((e as Error).message) }, 502);
  }
});
