/* ============================================================
   Padel Power · Northampton Padel League — live standings table
   ------------------------------------------------------------
   Reads public.league_standings from Supabase with the anon key
   (select-only under RLS). Data is written nightly by a Make.com
   scenario that pulls the Playtomic manager API.

   Usage on the page:
     <div id="league-table" data-league="52ddffe9-1188-47d2-8811-ac2dd7e31a63"></div>
     <script src="../assets/league-standings.js?v=1" defer></script>
   ============================================================ */

(() => {
  const PP_URL = 'https://bejshhlkatpjcydlokfk.supabase.co';
  const PP_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlanNoaGxrYXRwamN5ZGxva2ZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwNzYxOTYsImV4cCI6MjEwMjY1MjE5Nn0.EQghTZaE2bLdOb7w1Ashg4o493iNiieyfJdF1xmN2qQ';

  const root = document.getElementById('league-table');
  if (!root) return;
  const leagueId = root.dataset.league;
  if (!leagueId) return;

  const api = (path) =>
    fetch(`${PP_URL}/rest/v1/${path}`, {
      headers: { apikey: PP_KEY, Authorization: `Bearer ${PP_KEY}` },
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))));

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  };

  /* Columns mirror the Playtomic manager view. Short heads, full
     names in title= so the abbreviations are not a guessing game. */
  const COLS = [
    ['points', 'P', 'Points'],
    ['matches_played', 'MP', 'Matches played'],
    ['matches_won', 'W', 'Won'],
    ['matches_tied', 'T', 'Tied'],
    ['matches_lost', 'L', 'Lost'],
    ['sets_won', 'SW', 'Sets won'],
    ['sets_lost', 'SL', 'Sets lost'],
    ['sets_balance', 'SB', 'Sets balance'],
    ['games_won', 'GW', 'Games won'],
    ['games_lost', 'GL', 'Games lost'],
    ['games_balance', 'GB', 'Games balance'],
  ];

  const num = (v) => (Number(v) % 1 === 0 ? Number(v) : Number(v).toFixed(1));

  function renderGroup(rows) {
    const body = rows
      .map(
        (r) => `<tr>
        <td class="ls-pos">${r.position}</td>
        <td class="ls-team">
          ${r.avg_level != null ? `<span class="ls-lvl">${Number(r.avg_level).toFixed(2)}</span>` : ''}
          <span>${esc(r.team_name)}</span>
        </td>
        ${COLS.map(([k]) => `<td>${num(r[k])}</td>`).join('')}
      </tr>`
      )
      .join('');

    return `<div class="ls-scroll"><table class="ls-table">
      <thead><tr>
        <th class="ls-pos"></th><th class="ls-team">Team</th>
        ${COLS.map(([, s, full]) => `<th title="${full}">${s}</th>`).join('')}
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  function render(rows, syncedAt) {
    if (!rows.length) {
      root.innerHTML =
        '<p class="ls-empty">Standings will appear here once the season is under way.</p>';
      return;
    }

    const groups = [...new Set(rows.map((r) => r.group_number))].sort((a, b) => a - b);

    root.innerHTML = `
      <div class="ls-tabs" role="tablist">
        ${groups
          .map(
            (g, i) =>
              `<button class="ls-tab${i === 0 ? ' on' : ''}" role="tab" data-g="${g}">Group ${g}</button>`
          )
          .join('')}
      </div>
      <div class="ls-panels">
        ${groups
          .map(
            (g, i) =>
              `<div class="ls-panel" data-g="${g}"${i ? ' hidden' : ''}>${renderGroup(
                rows.filter((r) => r.group_number === g)
              )}</div>`
          )
          .join('')}
      </div>
      <p class="ls-meta">
        ${syncedAt ? `Updated ${esc(when(syncedAt))} · ` : ''}
        <a href="https://app.playtomic.io/leagues/${esc(leagueId)}" target="_blank" rel="noopener">View on Playtomic ↗︎</a>
      </p>`;

    root.querySelectorAll('.ls-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        root.querySelectorAll('.ls-tab').forEach((b) => b.classList.toggle('on', b === btn));
        root.querySelectorAll('.ls-panel').forEach((p) => {
          p.hidden = p.dataset.g !== btn.dataset.g;
        });
      });
    });
  }

  Promise.all([
    api(
      `league_standings?league_id=eq.${leagueId}` +
        `&select=group_number,position,team_name,avg_level,${COLS.map(([k]) => k).join(',')}` +
        `&order=group_number.asc,position.asc`
    ),
    api(`league_sync?league_id=eq.${leagueId}&select=synced_at&limit=1`).catch(() => []),
  ])
    .then(([rows, sync]) => render(rows, sync[0]?.synced_at))
    .catch(() => {
      /* Never leave a half-dead table on a public page — say so and
         point at the source of truth. */
      root.innerHTML =
        '<p class="ls-empty">Standings are temporarily unavailable. ' +
        `<a href="https://app.playtomic.io/leagues/${esc(leagueId)}" target="_blank" rel="noopener">View them on Playtomic ↗︎</a></p>`;
    });
})();
