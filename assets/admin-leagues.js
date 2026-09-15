/* ============================================================
   Padel Power · Studio Manager: leagues
   League setup, club member list, registrations with actions.
   Loaded after admin.js; renderLeagues() is called by its router.
   ============================================================ */
const LG = { leagues: [], regs: [], members: [], benefits: [], audit: [], league: '', status: '', search: '' };
const lgGbp = p => '£' + (p % 100 === 0 ? p / 100 : (p / 100).toFixed(2));
const lgDate = iso => iso ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso + 'T12:00:00')) : '';

async function renderLeagues() {
  [LG.leagues, LG.regs, LG.members, LG.benefits] = await Promise.all([
    ppApi('leagues?select=*&order=sort'),
    ppApi('league_registrations?select=*&order=created_at.desc'),
    ppApi('league_members?select=*&order=created_at.desc'),
    ppApi('league_member_benefits?select=*&order=name'),
  ]);
  drawLeagueSetup(); drawMembers(); drawBenefits(); drawRegs();
}

/* ---- setup ---- */
function drawLeagueSetup() {
  $('lgLeagueList').innerHTML = LG.leagues.map(l => `
    <form class="d2-league" data-id="${l.id}">
      <h4>${esc(l.name)} <span class="d2-tag">${l.kind}</span></h4>
      <p class="d2-hint wide" style="grid-column:1 / -1;margin:0">${l.playtomic_league_id
        ? `Playtomic: ${esc(l.playtomic_status || 'unknown')}${l.synced_at ? ', checked ' + new Date(l.synced_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}. Name and status follow Playtomic; prices, weeks and the open switch are yours.`
        : 'Not linked to a Playtomic league.'}</p>
      <label>Member £/week<input name="member" type="number" step="0.01" min="1" max="200" value="${l.member_price_pence ? l.member_price_pence / 100 : ''}"></label>
      <label>Non-member £/week<input name="nonmember" type="number" step="0.01" min="1" max="200" value="${l.nonmember_price_pence ? l.nonmember_price_pence / 100 : ''}"></label>
      <label>Season starts<input name="start" type="date" value="${l.season_start || ''}"></label>
      <label>Weeks<input name="weeks" type="number" min="1" max="52" value="${l.weeks || ''}"></label>
      <label class="wide">Playtomic league link<input name="playtomic" type="url" value="${esc(l.playtomic_url || '')}" placeholder="https://app.playtomic.io/..."></label>
      <div class="d2-form-row">
        <label class="d2-check"><input name="open" type="checkbox"${l.registration_open ? ' checked' : ''}><span>Registration open</span></label>
        <button class="d2-btn primary" type="submit"${isAdmin() ? '' : ' disabled'}>Save</button>
      </div>
    </form>`).join('');
  $('lgLeagueList').querySelectorAll('form').forEach(f => f.addEventListener('submit', async e => {
    e.preventDefault();
    const pence = v => v === '' ? null : Math.round(parseFloat(v) * 100);
    const body = {
      member_price_pence: pence(f.member.value), nonmember_price_pence: pence(f.nonmember.value),
      season_start: f.start.value || null, weeks: f.weeks.value ? parseInt(f.weeks.value, 10) : null,
      playtomic_url: f.playtomic.value.trim() || null, registration_open: f.open.checked,
    };
    if (body.registration_open && !(body.member_price_pence && body.nonmember_price_pence && body.season_start && body.weeks)) {
      alert('To open registration this league needs both prices, a start date and a number of weeks.'); return;
    }
    try {
      await ppApi(`leagues?id=eq.${f.dataset.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
      f.querySelector('button').textContent = 'Saved'; setTimeout(() => { f.querySelector('button').textContent = 'Save'; }, 1500);
    } catch (err) { alert('Could not save: ' + err.message); }
  }));
}

/* ---- members ---- */
function drawMembers() {
  $('lgMemberList').innerHTML = LG.members.map(m => `
    <div class="d2-type"><span>${esc(m.note || '')} <small>${esc(m.email || '')} ${esc(m.phone || '')}</small></span>
      ${isAdmin() ? `<button class="d2-x" data-del="${m.id}" title="Remove"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M5 5l14 14M19 5L5 19"/></svg></button>` : ''}</div>`).join('')
    || '<p class="d2-empty">Nobody on the list yet.</p>';
  $('lgMemberList').querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Remove from the member list? Anyone already registered keeps their price.')) return;
    await ppApi(`league_members?id=eq.${b.dataset.del}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    renderLeagues();
  }));
}
$('lgMemberAdd').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const email = f.mEmail.value.trim().toLowerCase(), phone = f.mPhone.value.trim();
  if (!email && !phone) { alert('Enter an email or a mobile.'); return; }
  try {
    await ppApi('league_members', { method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ email: email || null, phone: phone || null, note: f.mNote.value.trim() || null }) });
    f.reset(); renderLeagues();
  } catch (err) { alert('Could not add: ' + err.message); }
});

/* ---- which Playtomic benefits make someone a member ---- */
function drawBenefits() {
  $('lgBenefitList').innerHTML = LG.benefits.map(b => `
    <label class="d2-check d2-type"><input type="checkbox" data-benefit="${b.benefit_id}"${b.counts ? ' checked' : ''}${isAdmin() ? '' : ' disabled'}>
      <span>${esc(b.name)}</span></label>`).join('') || '<p class="d2-empty">No Playtomic benefits seen yet.</p>';
  $('lgBenefitList').querySelectorAll('input[data-benefit]').forEach(i => i.addEventListener('change', async () => {
    try {
      await ppApi(`league_member_benefits?benefit_id=eq.${i.dataset.benefit}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ counts: i.checked }) });
    } catch (err) { alert('Could not save: ' + err.message); i.checked = !i.checked; }
  }));
}

/* ---- registrations ---- */
function lgStatus(r) {
  const l = LG.leagues.find(x => x.id === r.league_id) || {};
  const p = r.pair_id ? LG.regs.find(x => x.pair_id === r.pair_id && x.id !== r.id && !x.cancelled_at) : null;
  if (r.cancelled_at) return 'Cancelled';
  if (r.card_status === 'failed') return 'Payment failed';
  if (r.card_status !== 'authorised') return 'Card not saved';
  if (l.kind === 'doubles' && !p) return 'Awaiting partner';
  if (l.kind === 'doubles' && p.card_status !== 'authorised') return 'Partner incomplete';
  if (!r.playtomic_added_at) return 'Ready for Playtomic';
  if (r.billing_ended_at) return 'Season complete';
  if (r.payments_taken > 0) return 'Payment active';
  return 'Scheduled';
}
function drawRegs() {
  const lf = $('lgLeagueFilter');
  lf.innerHTML = '<button data-league="">All leagues</button>' + LG.leagues.map(l => `<button data-league="${l.id}">${esc(l.name)}</button>`).join('');
  lf.querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.league === LG.league); b.onclick = () => { LG.league = b.dataset.league; drawRegs(); }; });
  $('lgStatusFilter').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.status === LG.status); b.onclick = () => { LG.status = b.dataset.status; drawRegs(); }; });

  const s = LG.search.toLowerCase();
  const rows = LG.regs.filter(r => (!LG.league || r.league_id === LG.league))
    .map(r => ({ r, st: lgStatus(r) }))
    .filter(x => !LG.status || x.st === LG.status)
    .filter(x => !s || [x.r.name, x.r.email, x.r.phone].join(' ').toLowerCase().includes(s));

  const tone = st => /failed|Cancelled/.test(st) ? 'bad' : /Awaiting|incomplete|not saved|Ready/.test(st) ? 'warn' : /active|Scheduled|complete/.test(st) ? 'good' : '';
  $('lgTable').querySelector('tbody').innerHTML = rows.map(({ r, st }) => {
    const l = LG.leagues.find(x => x.id === r.league_id) || {};
    const p = r.pair_id ? LG.regs.find(x => x.pair_id === r.pair_id && x.id !== r.id && !x.cancelled_at) : null;
    return `<tr>
      <td><b>${esc(r.name)}</b><br><small>${esc(r.email)} · ${esc(r.phone)}</small><br><a class="d2-link" href="${esc(r.playtomic_url)}" target="_blank" rel="noopener">Playtomic profile ↗</a>${r.playtomic_player_id ? `<br><small>id ${esc(r.playtomic_player_id)}</small>` : ''}</td>
      <td>${esc(l.name || '')}</td>
      <td>${r.membership_status === 'member' ? 'Member' : r.membership_status === 'review' ? 'Review' : 'Non-member'}<br><small>${r.membership_source === 'playtomic' ? 'Playtomic' : r.membership_source === 'list' ? 'member list' : r.membership_source === 'admin' ? 'set by admin' : r.playtomic_found === false ? 'not found on Playtomic' : 'no match'}${(r.playtomic_benefits || []).length ? ': ' + esc(r.playtomic_benefits.map(b => b.name).join(', ')) : ''}</small></td>
      <td>${lgGbp(r.weekly_price_pence)}${r.payments_taken ? `<br><small>${r.payments_taken} taken</small>` : ''}</td>
      <td>${l.kind === 'singles' ? '<small>n/a</small>' : p ? esc(p.name) : `<small>code ${r.partner_code}</small>`}</td>
      <td class="lg-status"><span class="lg-pill ${tone(st)}">${st}</span></td>
      <td>${esc(r.card_label || (r.card_status === 'authorised' ? 'saved' : '—'))}${r.last_payment_status === 'failed' ? '<br><small>last payment failed</small>' : ''}</td>
      <td>${r.playtomic_added_at ? 'Added' : '—'}</td>
      <td>${isAdmin() ? `<select class="lg-act" data-id="${r.id}">
        <option value="">Action…</option>
        <option value="playtomic">${r.playtomic_added_at ? 'Unmark Playtomic' : 'Mark added to Playtomic'}</option>
        <option value="member">Set as member</option>
        <option value="non_member">Set as non-member</option>
        <option value="price">Set weekly price</option>
        ${l.kind === 'doubles' ? (p ? '<option value="unlink">Unlink partner</option>' : '<option value="link">Link a partner</option><option value="copy">Copy partner link</option>') : ''}
        ${r.card_status === 'authorised' && !r.billing_ended_at ? '<option value="stop">Stop future payments</option>' : ''}
        ${r.cancelled_at ? '' : '<option value="cancel">Cancel registration</option>'}
        <option value="history">History</option>
      </select>` : ''}</td>
    </tr>`;
  }).join('');
  $('lgEmpty').hidden = rows.length > 0;
  $('lgTable').querySelectorAll('.lg-act').forEach(sel => sel.addEventListener('change', () => lgAction(sel.dataset.id, sel.value).finally(() => { sel.value = ''; })));
}
$('lgSearch').addEventListener('input', e => { LG.search = e.target.value; drawRegs(); });

async function lgAction(id, act) {
  const r = LG.regs.find(x => x.id === id); if (!r || !act) return;
  const fn = body => ppFn('league-register', { method: 'POST', body: JSON.stringify({ registration_id: id, ...body }) });
  const rpc = (name, args) => ppApi(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
  try {
    if (act === 'playtomic') await rpc('league_mark_playtomic', { p_reg: id, p_added: !r.playtomic_added_at });
    if (act === 'member' || act === 'non_member') {
      if (!confirm(`Set ${r.name} as ${act === 'member' ? 'a member' : 'a non-member'}? Their weekly price changes to the league's ${act === 'member' ? 'member' : 'non-member'} rate. Only possible before their first payment.`)) return;
      await fn({ action: 'set_membership', status: act });
    }
    if (act === 'price') {
      const v = prompt(`Weekly price for ${r.name} in £ (currently ${lgGbp(r.weekly_price_pence)}). Only possible before their first payment.`);
      if (v === null || v === '') return;
      await fn({ action: 'set_price', pence: Math.round(parseFloat(v) * 100) });
    }
    if (act === 'link') {
      const cands = LG.regs.filter(x => x.league_id === r.league_id && x.id !== id && !x.pair_id && !x.cancelled_at);
      if (!cands.length) { alert('Nobody unpaired in this league to link with.'); return; }
      const pick = prompt('Link with which player? Type the number:\n' + cands.map((c, i) => `${i + 1}. ${c.name} (${c.email})`).join('\n'));
      const c = cands[parseInt(pick, 10) - 1]; if (!c) return;
      await rpc('league_link_pair', { p_a: id, p_b: c.id });
    }
    if (act === 'unlink') { if (!confirm(`Unlink ${r.name} from their partner?`)) return; await rpc('league_unlink', { p_reg: id }); }
    if (act === 'copy') {
      const link = `https://www.padelpower.uk/northampton-padel-league/register/?partner=${r.partner_code}`;
      await navigator.clipboard?.writeText(link); alert('Copied:\n' + link); return;
    }
    if (act === 'stop') { if (!confirm(`Stop all future weekly payments for ${r.name}? Payments already taken are not refunded. This cannot be undone.`)) return; await fn({ action: 'stop_billing' }); }
    if (act === 'cancel') { if (!confirm(`Cancel ${r.name}'s registration? Future payments stop and any partner is unlinked.`)) return; await fn({ action: 'cancel' }); }
    if (act === 'history') {
      const rows = await ppApi(`league_audit?registration_id=eq.${id}&select=action,detail,created_at&order=created_at.desc&limit=40`);
      alert(rows.map(a => `${new Date(a.created_at).toLocaleString('en-GB')}  ${a.action}  ${JSON.stringify(a.detail)}`).join('\n') || 'Nothing logged yet.');
      return;
    }
  } catch (err) {
    const m = String(err.message);
    alert(m.includes('payments_started') ? 'Their first payment has already been taken, so the price is fixed for the season.'
      : m.includes('league_mismatch') ? 'Those two players are in different leagues.'
      : m.includes('already_paired') ? 'One of them already has a partner.'
      : 'Could not do that: ' + m);
  }
  renderLeagues();
}
