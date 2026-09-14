/* ============================================================
   Padel Power · Studio Manager: soft play
   Sessions week by week, desk bookings, check-in, cancellations and the
   soft play settings. Loaded after admin.js; renderSoftplay() is called
   by its router. Admin only.
   ============================================================ */
const SP = { week: 0, sessions: [], bookings: [], cfg: null, open: null, bkSession: null };
const spGbp = p => '£' + (p % 100 === 0 ? p / 100 : (p / 100).toFixed(2));
const spPence = v => v === '' || v == null ? null : Math.round(parseFloat(v) * 100);
const spStart = s => new Date(`${s.session_date}T${s.start_time}:00`);
const spEnd = s => new Date(spStart(s).getTime() + s.duration_min * 60000);
const hhmm = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function spWeekDates() {
  const start = addDays(startOfToday(), SP.week * 7);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

async function renderSoftplay() {
  const days = spWeekDates();
  const from = iso(days[0]), to = iso(days[6]);
  const [cfg, sessions] = await Promise.all([
    ppApi('settings?id=eq.1&select=softplay_open,softplay_min_children,softplay_max_children,softplay_hire_price_pence,softplay_supervised_price_pence,softplay_min_age,softplay_max_age,cutoff_hours,join_cutoff_hours'),
    ppApi(`softplay_sessions?session_date=gte.${from}&session_date=lte.${to}&select=*&order=session_date,start_time`),
  ]);
  SP.cfg = cfg[0];
  SP.sessions = sessions;
  const ids = sessions.map(s => s.id);
  SP.bookings = ids.length
    ? await ppApi(`softplay_bookings?session_id=in.(${ids.join(',')})&order=created_at&select=*`)
    : [];
  drawSpSettings(); drawSpWeek();
}

/* ---- settings ---- */
function drawSpSettings() {
  const f = $('spRules'), c = SP.cfg;
  if (!c || document.activeElement && f.contains(document.activeElement)) return;
  f.spSupervised.value = c.softplay_supervised_price_pence != null ? (c.softplay_supervised_price_pence / 100) : '';
  f.spHire.value = (c.softplay_hire_price_pence ?? 500) / 100;
  f.spMin.value = c.softplay_min_children; f.spMax.value = c.softplay_max_children;
  f.spAgeMin.value = c.softplay_min_age; f.spAgeMax.value = c.softplay_max_age;
  f.spOpen.checked = !!c.softplay_open;
  const tag = $('spOpenTag');
  tag.textContent = c.softplay_open ? 'Online booking open' : 'Online booking closed';
  tag.className = 'd2-tag st ' + (c.softplay_open ? 'on' : 'off');
}
$('spRules').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const body = {
    softplay_supervised_price_pence: spPence(f.spSupervised.value),
    softplay_hire_price_pence: spPence(f.spHire.value),
    softplay_min_children: +f.spMin.value, softplay_max_children: +f.spMax.value,
    softplay_min_age: +f.spAgeMin.value, softplay_max_age: +f.spAgeMax.value,
    softplay_open: f.spOpen.checked,
  };
  if (body.softplay_open && !body.softplay_supervised_price_pence) {
    if (!confirm('The supervised price is not set, so supervised sessions cannot be booked online yet. Hire slots will sell. Open anyway?')) return;
  }
  try {
    await ppApi('settings?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    $('spRulesSaved').hidden = false; setTimeout(() => { $('spRulesSaved').hidden = true; }, 2000);
    f.querySelector('button').blur();
    renderSoftplay();
  } catch (err) { alert('Could not save: ' + err.message); }
});

/* ---- the week ---- */
function spStatus(s, kids, n) {
  if (s.cancelled_at) return { key: 'off', label: s.cancel_reason && s.cancel_reason.startsWith('auto:') ? 'Auto-cancelled' : 'Cancelled' };
  if (s.mode === 'hire') return n ? { key: 'full', label: 'Hired' } : { key: 'on', label: 'Available' };
  const min = SP.cfg.softplay_min_children;
  if (kids >= s.capacity) return { key: 'full', label: 'Full' };
  const left = (spStart(s) - new Date()) / 3600000;
  if (kids >= min) return { key: 'on', label: 'Confirmed' };
  if (left < SP.cfg.cutoff_hours) return { key: 'risk', label: 'Below minimum' };
  return { key: 'needs', label: `Needs ${min - kids} more` };
}
function drawSpWeek() {
  const days = spWeekDates();
  $('spWeekLabel').textContent = `${fmtDate.format(days[0])} – ${fmtDate.format(days[6])}`;
  const price = s => s.mode === 'hire' ? Math.round(SP.cfg.softplay_hire_price_pence * s.duration_min / 60) : SP.cfg.softplay_supervised_price_pence;
  const html = days.map(d => {
    const list = SP.sessions.filter(s => s.session_date === iso(d));
    if (!list.length) return '';
    return `<div class="sp-day"><h4>${fmtFull.format(d)}</h4>${list.map(s => {
      const bks = SP.bookings.filter(b => b.session_id === s.id && !b.cancelled_at);
      const kids = bks.reduce((n, b) => n + b.children, 0);
      const st = spStatus(s, kids, bks.length);
      const here = bks.filter(b => b.checked_in_at).reduce((n, b) => n + b.children, 0);
      const open = SP.openId === s.id;
      const past = spStart(s) < new Date();
      return `
      <div class="sp-sess ${s.cancelled_at ? 'off' : ''} ${open ? 'open' : ''}" data-id="${s.id}">
        <button class="sp-sess-head" data-toggle="${s.id}">
          <span class="tm">${s.start_time}<small>${hhmm(spEnd(s))}</small></span>
          <span class="nm">${s.mode === 'hire' ? 'Hire slot' : 'Supervised'}${s.notes ? ` <em>· ${esc(s.notes)}</em>` : ''}</span>
          <span class="ct">${kids}/${s.capacity} children · ${bks.length} booking${bks.length === 1 ? '' : 's'}${here ? ` · ${here} here` : ''}${price(s) ? ` · ${spGbp(price(s))}/child` : ' · price not set'}</span>
          <span class="d2-tag st ${st.key}">${st.label}</span>
        </button>
        ${open ? `
        <div class="sp-sess-body">
          ${bks.length ? bks.map(b => `
            <div class="d2-att${b.checked_in_at ? ' here' : ''}">
              <div class="d2-att-info">
                <b>${esc(b.name)} <small style="font-weight:500;color:var(--tx2)">· ${b.children} ${b.children === 1 ? 'child' : 'children'}</small></b>
                ${b.phone ? `<span class="d2-att-line">${esc(b.phone)}</span>` : ''}
                ${b.child_names ? `<span class="d2-att-line">${esc(b.child_names)}</span>` : ''}
              </div>
              <div class="d2-att-act">
                ${!s.cancelled_at ? `<button class="d2-ci${b.checked_in_at ? ' on' : ''}" data-ci="${b.id}" title="${b.checked_in_at ? 'Checked in. Press again to undo' : 'Mark as here'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="11" height="11"><path d="M4 12.5l5 5L20 7"/></svg>${b.checked_in_at ? 'Here' : 'Check in'}</button>` : ''}
                <button class="d2-x" data-rm="${b.id}" title="Remove booking"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
              </div>
              <span class="d2-att-meta"><em class="${b.source === 'Online' ? 'online' : ''}">${esc(b.source)}</em>${b.paid_at ? ` · Paid ${spGbp(b.amount_pence || 0)}${b.refunded_at ? ' · refunded' : ''}` : ' · Pay at desk'}${b.email ? ' · ' + esc(b.email) : ''}</span>
            </div>`).join('') : '<p class="d2-empty">No bookings yet.</p>'}
          <div class="d2-det-actions">
            ${!s.cancelled_at && !past && kids < s.capacity && !(s.mode === 'hire' && bks.length) ? `<button class="d2-btn primary" data-desk="${s.id}">+ Desk booking</button>` : ''}
            ${!s.cancelled_at && !past ? `<button class="d2-btn danger" data-cancel="${s.id}">Cancel session</button>` : ''}
            ${s.cancelled_at ? `<p class="d2-hint" style="grid-column:1 / -1;margin:0">Cancelled: ${esc(s.cancel_reason || '')}. Everyone booked was texted and card payments refunded.</p>` : ''}
          </div>
        </div>` : ''}
      </div>`;
    }).join('')}</div>`;
  }).join('');
  $('spSessions').innerHTML = html || '<p class="d2-empty">No soft play sessions this week. Press Add sessions to put some on the timetable.</p>';

  const el = $('spSessions');
  el.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => { SP.openId = SP.openId === b.dataset.toggle ? null : b.dataset.toggle; drawSpWeek(); }));
  el.querySelectorAll('[data-ci]').forEach(b => b.addEventListener('click', async () => {
    const bk = SP.bookings.find(x => x.id === b.dataset.ci);
    b.disabled = true;
    try { await ppApi('rpc/set_softplay_check_in', { method: 'POST', body: JSON.stringify({ p_id: bk.id, p_present: !bk.checked_in_at }) }); }
    catch { alert('Could not save the check-in. Please try again.'); }
    renderSoftplay();
  }));
  el.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
    const bk = SP.bookings.find(x => x.id === b.dataset.rm);
    const paid = bk.paid_at && !bk.refunded_at && bk.payment_intent_id;
    if (!confirm(paid ? `Remove this booking? ${spGbp(bk.amount_pence || 0)} will be refunded to their card automatically.` : 'Remove this booking?')) return;
    try {
      if (paid) {
        const { results } = await Store.refundSoftplay([bk.id]);
        if (results[bk.id] !== 'refunded') throw new Error(results[bk.id]);
      } else {
        await ppApi(`softplay_bookings?id=eq.${bk.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ cancelled_at: new Date().toISOString() }) });
      }
    } catch (err) { alert('Could not remove the booking: ' + err.message); }
    renderSoftplay();
  }));
  el.querySelectorAll('[data-desk]').forEach(b => b.addEventListener('click', () => openSpDesk(b.dataset.desk)));
  el.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
    const s = SP.sessions.find(x => x.id === b.dataset.cancel);
    const n = SP.bookings.filter(x => x.session_id === s.id && !x.cancelled_at).length;
    if (!confirm(`Cancel the ${s.start_time} ${s.mode === 'hire' ? 'hire slot' : 'supervised session'} on ${fmtFull.format(spStart(s))}?${n ? ` ${n} booking${n === 1 ? '' : 's'} will be cancelled, everyone texted and card payments refunded automatically.` : ''}`)) return;
    const reason = prompt('Reason (shown to parents in the text):', 'cancelled by the club') || 'cancelled_by_club';
    try { await ppApi('rpc/cancel_softplay_session', { method: 'POST', body: JSON.stringify({ p_id: s.id, p_reason: reason }) }); }
    catch (err) { alert('Could not cancel: ' + err.message); }
    renderSoftplay();
  }));
}
$('spPrev').addEventListener('click', () => { SP.week--; renderSoftplay(); });
$('spNext').addEventListener('click', () => { SP.week++; renderSoftplay(); });
$('spToday').addEventListener('click', () => { SP.week = 0; renderSoftplay(); });

/* ---- add sessions ---- */
$('spAddBtn').addEventListener('click', () => {
  const f = $('spAddForm'); f.reset();
  f.spDate.value = iso(spWeekDates()[0] < startOfToday() ? startOfToday() : spWeekDates()[0]);
  f.spTime.value = '10:00';
  f.spCap.value = SP.cfg?.softplay_max_children || 10;
  openDrawer('spDrawer');
});
$('spDrClose').addEventListener('click', closeDrawers);
$('spAddForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const btn = $('spAddGo'); btn.disabled = true; btn.textContent = 'Adding…';
  const first = new Date(f.spDate.value + 'T00:00:00');
  const rows = Array.from({ length: +f.spRepeat.value }, (_, i) => ({
    session_date: iso(addDays(first, i * 7)), start_time: f.spTime.value.slice(0, 5), duration_min: +f.spDuration.value,
    mode: f.spMode.value, capacity: +f.spCap.value, notes: f.spNotes.value.trim() || null, created_by: Auth.userId(),
  }));
  try {
    await ppApi('softplay_sessions', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
    closeDrawers();
    renderSoftplay();
  } catch (err) {
    alert(String(err.message).includes('duplicate') || String(err.message).includes('unique')
      ? 'There is already a session at that time on one of those dates. Nothing was added; pick a different time.'
      : 'Could not add the sessions: ' + err.message);
  }
  btn.disabled = false; btn.textContent = 'Add to the timetable';
});

/* ---- desk booking ---- */
function openSpDesk(sessionId) {
  const s = SP.sessions.find(x => x.id === sessionId);
  SP.bkSession = s;
  $('spBkWhen').textContent = `${s.mode === 'hire' ? 'Hire slot' : 'Supervised session'} · ${fmtFull.format(spStart(s))} · ${s.start_time}`;
  const f = $('spBkForm'); f.reset(); $('spBkKids').value = 1;
  const kids = SP.bookings.filter(b => b.session_id === s.id && !b.cancelled_at).reduce((n, b) => n + b.children, 0);
  $('spBkKids').max = Math.max(1, s.capacity - kids);
  openDrawer('spBkDrawer');
}
$('spBkClose').addEventListener('click', closeDrawers);
$('spBkForm').addEventListener('submit', async e => {
  e.preventDefault();
  const s = SP.bkSession; if (!s) return;
  const btn = $('spBkGo'); btn.disabled = true; btn.textContent = 'Booking…';
  try {
    await ppApi('softplay_bookings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
      session_id: s.id, name: $('spBkName').value.trim(), phone: $('spBkPhone').value.trim(), email: $('spBkEmail').value.trim().toLowerCase(),
      children: +$('spBkKids').value, child_names: $('spBkNames').value.trim() || null, source: 'Front desk', consent_at: new Date().toISOString(),
    }) });
    closeDrawers();
    SP.openId = s.id;
    renderSoftplay();
  } catch (err) {
    const m = String(err.message);
    alert(m.includes('session_full') ? 'Not enough places left for that many children.'
      : m.includes('session_taken') ? 'That hire slot already has a booking.'
      : m.includes('session_in_past') ? 'That session has already started.'
      : m.includes('phone_check') ? 'Enter the mobile with the country code, e.g. +44 7…'
      : 'Could not save the booking: ' + m);
  }
  btn.disabled = false; btn.textContent = 'Confirm booking';
});
