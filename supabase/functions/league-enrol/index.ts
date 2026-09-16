// Padel Power · put completed registrations into their Playtomic league
// Key-locked (x-pp-key). Called every 15 minutes by pg_cron, nudged when a
// card is saved, and by league-register when a registration is cancelled.
//
// POST { action: "sweep" }                       enrol everything that is ready
// POST { action: "remove", registration_id }     take a registration's team out
// POST { action: "customer", registration_id }   make one player a club customer
//
// Uses the internal Manager API found by watching Playtomic Manager:
//   POST   /api/v1/leagues/{league}/teams   { players: [ids], invited_by_manager: true } -> { team_id }
//   DELETE /api/v1/leagues/{league}/teams/{team_id}
// Ready means: card saved, a Playtomic player id from the share link,
// the league has a Playtomic id, and for doubles a partner who is also
// ready. Failures are written to playtomic_error and retried next sweep.
// Only one sweep runs at a time (job_claim_owned), so a nudge and the cron
// job cannot add the same team, or create the same customer, twice.
//
// Being in a league does not make someone a club customer, so each player
// is also made a Playtomic customer with the name, email and mobile we hold:
//   GET   /api/v1/tenant_profiles?user_id={player}&tenant_id=T   -> [] or [profile]
//   POST  /api/v1/tenant_profiles                               { tenant_id, tenant_customer_profile }
//   PATCH /api/v1/tenant_profiles/{tenant_profile_id}           { tenant_customer_profile }
// Playtomic links a new customer by email, so a different email can give a
// different account: that is recorded as "mismatch" for staff and never
// retried. An existing customer only has blank email/phone filled in.
// A customer problem never stops the league add.

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EMAIL = Deno.env.get("PLAYTOMIC_MANAGER_EMAIL") ?? "";
const PASSWORD = Deno.env.get("PLAYTOMIC_MANAGER_PASSWORD") ?? "";
const TENANT = "95214d52-1a73-44be-b5f8-7aafee310010";
const MGR = "https://manager.playtomic.io";
const LOCK = "league-enrol";
const LEASE_S = 300;          // lock lease
const BUDGET_MS = 150_000;    // stop starting new work after this
const RETRY_MS = 6 * 3600_000; // back-off for failed customer calls
const HTTP_MS = 15_000;
const DB_MS = 10_000;

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { "Content-Type": "application/json" } });
const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) }, signal: AbortSignal.timeout(DB_MS) });
  if (!r.ok) throw new Error(`db ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
const rpc = (fn: string, args: Record<string, unknown>) => db(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
const patchReg = (id: string, body: Record<string, unknown>) =>
  db(`league_registrations?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
const log = (reg: string, action: string, detail: Record<string, unknown> = {}) =>
  rpc("league_log", { p_reg: reg, p_action: action, p_detail: detail, p_actor: null }).catch(() => {});

async function keyOk(req: Request) {
  const k = req.headers.get("x-pp-key") || "";
  if (!k) return false;
  const r = await fetch(`${SB_URL}/rest/v1/rpc/pp_internal_key_ok`, { method: "POST", headers: H, body: JSON.stringify({ p_key: k }) });
  return r.ok && (await r.json()) === true;
}

// what we keep from a failed Playtomic call: the step, the status and
// Playtomic's own error code, never the response body (it can echo an
// email or phone). A thrown PtError without a status means no answer came back.
class PtError extends Error {
  constructor(step: string, readonly status: number | null, code = "") {
    super(`${step} ${status ?? "no response"}${code ? ` ${code}` : ""}`);
  }
}
async function ptFail(step: string, r: Response): Promise<never> {
  const txt = await r.text().catch(() => "");
  let code = "";
  try {
    const d = JSON.parse(txt);
    code = [d.status, d.code, d.error, d.error_code].map((v) => String(v ?? "")).find((v) => /^[A-Z][A-Z0-9_]{2,79}$/.test(v)) ?? "";
  } catch { /* not JSON */ }
  throw new PtError(step, r.status, code);
}
const safeMsg = (e: unknown) => e instanceof PtError ? e.message : `${String((e as Error)?.name || "error")}`.slice(0, 80);

const pt = (path: string, init: RequestInit = {}) => fetch(`${MGR}${path}`, { ...init, signal: AbortSignal.timeout(HTTP_MS) });

async function managerToken(): Promise<string> {
  const login = await pt(`/api/v3/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requested_user_scopes: [{ role: "ROLE_CUSTOMER", scope_id: null }], token_generation_mode: "USER_PERMISSION", email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`playtomic login ${login.status}`);
  const l = await login.json();
  const ex = await pt(`/api/v3/auth/token`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: l.refresh_token, token_generation_mode: "USER_PERMISSION", requested_user_scopes: [{ role: "ROLE_TENANT_MANAGER", scope_id: TENANT }] }),
  });
  if (!ex.ok) throw new Error(`playtomic token ${ex.status}`);
  return (await ex.json()).access_token;
}

type Reg = Record<string, unknown> & {
  id: string; league_id: string; pair_id: string | null; playtomic_player_id: string | null; playtomic_team_id: string | null;
  card_status: string; cancelled_at: string | null; name: string; email: string; phone: string;
  playtomic_customer_status: string | null; playtomic_customer_at: string | null;
};

async function addTeam(tok: string, leagueId: string, players: string[]) {
  const r = await pt(`/api/v1/leagues/${leagueId}/teams`, {
    method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ players, invited_by_manager: true }),
  }).catch(() => { throw new PtError("add team", null, "NO_RESPONSE"); });
  const txt = await r.text().catch(() => { throw new PtError("add team", null, "RESPONSE_LOST"); });
  if (!r.ok) {
    let code = "";
    try { code = String(JSON.parse(txt).status ?? ""); } catch { /* not JSON */ }
    throw new PtError("add team", r.status, /^[A-Z][A-Z0-9_]{2,79}$/.test(code) ? code : "");
  }
  let id = "";
  try { id = String(JSON.parse(txt).team_id ?? ""); } catch { /* unreadable */ }
  if (!id) throw new PtError("add team", null, "UNREADABLE_RESPONSE");
  return id;
}
async function removeTeam(tok: string, leagueId: string, teamId: string) {
  const r = await pt(`/api/v1/leagues/${leagueId}/teams/${teamId}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok && r.status !== 404) await ptFail("remove team", r);
}

// "+44 7123456789", the way Manager shows UK mobiles
function ptPhone(phone: string) {
  const p = String(phone || "").replace(/\s+/g, "");
  return p.startsWith("+44") ? `+44 ${p.slice(3)}` : p;
}

async function findCustomer(tok: string, player: string) {
  const q = new URLSearchParams({ user_id: player, tenant_id: TENANT });
  const look = await pt(`/api/v1/tenant_profiles?${q}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!look.ok) await ptFail("customer lookup", look);
  const found = (await look.json()) as Record<string, any>[];
  return Array.isArray(found) && found.length ? found[0] : null;
}

// only blank email/phone are filled; staff values are never overwritten
async function fillCustomer(tok: string, prof: Record<string, any>, reg: Reg) {
  const cur = (prof.tenant_customer_profile || {}) as Record<string, unknown>;
  const fill: Record<string, string> = {};
  const email = String(reg.email || "").trim();
  const phone = ptPhone(reg.phone);
  if (!cur.email && email) fill.email = email;
  if (!cur.phone && phone) fill.phone = phone;
  if (!Object.keys(fill).length) return [];
  const body = {
    tenant_customer_profile: {
      full_name: cur.full_name ?? reg.name, phone: cur.phone ?? null, gender: cur.gender ?? null,
      birth_date: cur.birth_date ?? null, country_code: cur.country_code ?? "GB", email: cur.email ?? null, ...fill,
    },
  };
  const up = await pt(`/api/v1/tenant_profiles/${encodeURIComponent(String(prof.tenant_profile_id))}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!up.ok) await ptFail("customer update", up);
  return Object.keys(fill);
}

async function createCustomer(tok: string, reg: Reg) {
  const made = await pt(`/api/v1/tenant_profiles`, {
    method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      tenant_id: TENANT,
      tenant_customer_profile: {
        email: String(reg.email || "").trim(), full_name: reg.name, phone: ptPhone(reg.phone) || null,
        country_code: "GB", gender: null, birth_date: null, private_notes: null,
      },
    }),
  }).catch(() => { throw new PtError("customer create", null, "NO_RESPONSE"); });
  if (!made.ok) await ptFail("customer create", made);
  let uid = "";
  try { uid = String((await made.json()).user_id ?? ""); } catch { /* unreadable */ }
  return uid;
}

// PATCH one registration only while it is still in the state we expect;
// false when someone else (identity change, staff, another attempt) got there first
async function casReg(id: string, filters: string, body: Record<string, unknown>) {
  const rows = await db(`league_registrations?id=eq.${id}${filters}`, {
    method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body),
  }) as unknown[];
  return rows.length > 0;
}
const ver = (at: string | null) => at ? `eq.${encodeURIComponent(at)}` : "is.null";

const customerDone = (r: Reg) => r.playtomic_customer_status === "linked" || r.playtomic_customer_status === "mismatch";
// a failed customer call waits RETRY_MS before the next try
const customerDue = (r: Reg) => !customerDone(r) &&
  !(r.playtomic_customer_status === "error" && r.playtomic_customer_at && Date.now() - Date.parse(r.playtomic_customer_at) < RETRY_MS);

// Make one registration's player a club customer and record the outcome.
// Never throws. Before creating a customer the row is claimed by writing
// "mismatch / creating customer": whatever happens next (crash, timeout, a
// changed profile link, a lost database write) the row stays with staff and
// is never POSTed again. Only a clear answer from Playtomic replaces it.
async function customerStep(token: () => Promise<string>, seen: Reg) {
  const [reg] = await db(`league_registrations?id=eq.${seen.id}&select=*`) as Reg[];
  if (!reg || reg.cancelled_at || !reg.playtomic_player_id || !customerDue(reg)) return { id: seen.id, customer: "skipped" };
  const player = String(reg.playtomic_player_id);
  const same = `&playtomic_player_id=eq.${encodeURIComponent(player)}&playtomic_customer_at=${ver(reg.playtomic_customer_at)}`;
  const record = async (body: Record<string, unknown>, filters: string) => {
    const ok = await casReg(reg.id, filters, body).catch(() => false);
    if (!ok) await log(reg.id, "playtomic_customer_stale", { player_id: player });
    return ok;
  };
  let tok: string;
  let prof: Record<string, any> | null;
  try {
    tok = await token();
    prof = await findCustomer(tok, player);
    if (prof) {
      const filled = await fillCustomer(tok, prof, reg);
      const at = new Date().toISOString();
      if (await record({ playtomic_customer_status: "linked", playtomic_customer_user_id: String(prof.user_id), playtomic_customer_error: null, playtomic_customer_at: at }, same)) {
        await log(reg.id, "playtomic_customer_linked", { user_id: String(prof.user_id), player_id: player, created: false, filled });
      }
      return { id: reg.id, customer: "linked" };
    }
  } catch (e) {
    const msg = safeMsg(e);
    if (await record({ playtomic_customer_status: "error", playtomic_customer_error: msg, playtomic_customer_at: new Date().toISOString() }, same)) {
      await log(reg.id, "playtomic_customer_failed", { error: msg });
    }
    return { id: reg.id, customer: "error", error: msg };
  }

  const claimAt = new Date().toISOString();
  const claimed = await casReg(reg.id, same,
    { playtomic_customer_status: "mismatch", playtomic_customer_user_id: null, playtomic_customer_error: "creating customer, not confirmed", playtomic_customer_at: claimAt }).catch(() => false);
  if (!claimed) return { id: reg.id, customer: "stale" };
  // from here only the claim version matters: an identity change keeps a mismatch
  const mine = `&playtomic_customer_at=eq.${encodeURIComponent(claimAt)}`;
  try {
    const uid = await createCustomer(tok, reg);
    const linked = uid === player;
    await record({
      playtomic_customer_status: linked ? "linked" : "mismatch", playtomic_customer_user_id: uid || null,
      playtomic_customer_error: linked ? null : uid ? "Playtomic linked a different account" : "created, account not returned",
      playtomic_customer_at: new Date().toISOString(),
    }, linked ? `${mine}&playtomic_player_id=eq.${encodeURIComponent(player)}` : mine);
    await log(reg.id, linked ? "playtomic_customer_linked" : "playtomic_customer_mismatch", { user_id: uid, player_id: player, created: true });
    return { id: reg.id, customer: linked ? "linked" : "mismatch" };
  } catch (e) {
    const msg = safeMsg(e);
    // a clear refusal means nothing was created, so it can be retried;
    // no answer means it might have been, so it stays with staff
    const refused = e instanceof PtError && e.status !== null;
    await record({ playtomic_customer_status: refused ? "error" : "mismatch", playtomic_customer_error: msg, playtomic_customer_at: new Date().toISOString() }, mine);
    await log(reg.id, "playtomic_customer_failed", { error: msg, uncertain: !refused });
    return { id: reg.id, customer: refused ? "error" : "mismatch", error: msg };
  }
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
        body: JSON.stringify({ playtomic_team_id: null, playtomic_added_at: null, playtomic_enrolling_at: null }),
      });
      await log(reg.id, "playtomic_removed", { team_id: reg.playtomic_team_id });
      return json({ ok: true, removed: reg.playtomic_team_id });
    }

    const owner = crypto.randomUUID();
    const started = Date.now();
    const inBudget = () => Date.now() - started < BUDGET_MS;
    if ((await rpc("job_claim_owned", { p_name: LOCK, p_seconds: LEASE_S, p_owner: owner })) !== true) {
      return json({ skipped: "another sweep is running" });
    }
    try {
      if (action === "customer") {
        const [reg] = await db(`league_registrations?id=eq.${encodeURIComponent(String(body.registration_id))}&select=*`) as Reg[];
        if (!reg) return json({ error: "not_found" }, 404);
        if (!reg.playtomic_player_id) return json({ ok: true, skipped: "no player id" });
        if (customerDone(reg)) return json({ ok: true, skipped: reg.playtomic_customer_status });
        return json(await customerStep(token, reg));
      }
      if (action !== "sweep") return json({ error: "bad_request" }, 400);

      const regs = await db(
        "league_registrations?select=*,leagues(kind,playtomic_league_id)&cancelled_at=is.null&card_status=eq.authorised&playtomic_team_id=is.null&playtomic_enrolling_at=is.null&playtomic_player_id=not.is.null",
      ) as (Reg & { leagues: { kind: string; playtomic_league_id: string | null } })[];
      const done: unknown[] = []; const seenPairs = new Set<string>();
      for (const r of regs) {
        if (!inBudget()) break;
        const lid = r.leagues?.playtomic_league_id;
        if (!lid) continue;
        let members: Reg[] = [r];
        if (r.leagues.kind !== "singles") {
          if (!r.pair_id || seenPairs.has(r.pair_id)) continue;
          const partner = regs.find((x) => x.pair_id === r.pair_id && x.id !== r.id);
          if (!partner) continue;                       // partner not ready yet
          seenPairs.add(r.pair_id);
          members = [r, partner];
        }
        for (const m of members) {
          if (customerDue(m) && inBudget()) done.push(await customerStep(token, m));
        }
        if (!inBudget()) break;
        // freeze each member's profile before sending the team (league-register
        // cannot change it once this is set); skip the team if anyone changed
        const reserved: Reg[] = [];
        for (const m of members) {
          const rows = await db(
            `league_registrations?id=eq.${m.id}&playtomic_player_id=eq.${encodeURIComponent(String(m.playtomic_player_id))}` +
            `&playtomic_team_id=is.null&playtomic_enrolling_at=is.null&cancelled_at=is.null&card_status=eq.authorised` +
            (m.pair_id ? `&pair_id=eq.${m.pair_id}` : ""),
            { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ playtomic_enrolling_at: new Date().toISOString() }) },
          ) as unknown[];
          if (!rows.length) break;
          reserved.push(m);
        }
        if (reserved.length < members.length) {
          for (const m of reserved) await patchReg(m.id, { playtomic_enrolling_at: null }).catch(() => {});
          done.push({ ids: members.map((m) => m.id), skipped: "registration changed" });
          continue;
        }
        let teamId: string;
        try {
          teamId = await addTeam(await token(), lid, members.map((m) => String(m.playtomic_player_id)));
        } catch (e) {
          // a clear refusal: nothing was added, release and retry next sweep.
          // no answer: the team may exist, so the reservation stays and the
          // registration waits for staff ("Retry Playtomic add" in the admin)
          const msg = safeMsg(e);
          const refused = e instanceof PtError && e.status !== null;
          for (const m of members) {
            await patchReg(m.id, refused ? { playtomic_error: msg, playtomic_enrolling_at: null } : { playtomic_error: `${msg}; check Playtomic` }).catch(() => {});
            await log(m.id, "playtomic_failed", { error: msg, uncertain: !refused });
          }
          done.push({ ids: members.map((m) => m.id), error: msg });
          continue;
        }
        // all members in one statement, so a doubles pair is never half-saved;
        // if this write fails the rows stay reserved for staff
        try {
          await rpc("league_set_team", { p_regs: members.map((m) => m.id), p_team: teamId });
        } catch {
          for (const m of members) await patchReg(m.id, { playtomic_error: `added as team ${teamId} but not saved; check Playtomic` }).catch(() => {});
          done.push({ ids: members.map((m) => m.id), error: "team not saved" });
          continue;
        }
        for (const m of members) await log(m.id, "playtomic_added", { team_id: teamId, by: "auto", players: members.map((x) => x.id) });
        // cancelled or re-paired while the team was being added: take it back out
        const now2 = await db(`league_registrations?id=in.(${members.map((m) => m.id).join(",")})&select=id,cancelled_at,pair_id`) as Reg[];
        const changed = members.some((m) => {
          const x = now2.find((y) => y.id === m.id);
          return !x || x.cancelled_at || (x.pair_id ?? null) !== (m.pair_id ?? null);
        });
        if (changed) {
          try {
            await removeTeam(await token(), lid, teamId);
            await db(`league_registrations?playtomic_team_id=eq.${encodeURIComponent(teamId)}`, {
              method: "PATCH", headers: { Prefer: "return=minimal" },
              body: JSON.stringify({ playtomic_team_id: null, playtomic_added_at: null, playtomic_enrolling_at: null }),
            });
            for (const m of members) await log(m.id, "playtomic_removed", { team_id: teamId, reason: "changed during add" });
            done.push({ ids: members.map((m) => m.id), removed: teamId });
          } catch (e) {
            for (const m of members) await patchReg(m.id, { playtomic_error: `changed during add; ${safeMsg(e)}` }).catch(() => {});
            done.push({ ids: members.map((m) => m.id), error: "changed during add" });
          }
          continue;
        }
        done.push({ ids: members.map((m) => m.id), team: teamId });
      }

      // players already in a league who still need a customer (enrolled before
      // this existed, or an earlier call failed). Payment state does not matter:
      // a failed weekly payment leaves them in the league.
      const retryBefore = new Date(Date.now() - RETRY_MS).toISOString();
      const later = await db(
        "league_registrations?select=*&cancelled_at=is.null&playtomic_team_id=not.is.null&playtomic_player_id=not.is.null" +
        `&or=(playtomic_customer_status.is.null,and(playtomic_customer_status.eq.error,playtomic_customer_at.lt."${retryBefore}"))` +
        "&order=playtomic_customer_at.asc.nullsfirst&limit=25",
      ) as Reg[];
      for (const r of later) {
        if (!inBudget()) break;
        done.push(await customerStep(token, r));
      }
      return json({ candidates: regs.length, customers: later.length, done });
    } finally {
      await rpc("job_release_owned", { p_name: LOCK, p_owner: owner }).catch(() => {});
    }
  } catch (e) {
    return json({ error: e instanceof PtError ? e.message : "server_error" }, 502);
  }
});
