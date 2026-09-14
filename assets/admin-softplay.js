/* ============================================================
   Padel Power · Studio Manager: soft play
   The same week and month calendar as Pilates, with a detail panel for
   the selected session: bookings, check-in, desk booking, cancel.
   Loaded after admin.js (uses its helpers, TG_* grid constants and the
   d2-tg / d2-mg styles); renderSoftplay() is called by its router.
   ============================================================ */
const SP = { view: 'week', week: 0, month: 0, sel: null, sessions: [], bookings: [], cfg: null, bkSession: null };
const spGbp = p => '£' + (p % 100 === 0 ? p / 100 : (p / 100).toFixed(2));
const spPence = v => v === '' || v == null ? null : Math.round(parseFloat(v) * 100);
const spStart = s => new Date(`${s.session_date}T${s.start_time}:00`);
const spEnd = s => new Date(spStart(s).getTime() + s.duration_min * 60000);
const spHHMM = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const spClass = s => s.mode === 'hire' ? 'tc-str' : 'tc-found';
const spKids = s => SP.bookings.filter(b => b.session_id === s.id && !b.cancelled_at).reduce((n, b) => n + b.children, 0);
const spBks = s => SP.bookings.filter(b => b.session_id === s.id && !b.cancelled_at);
const spPrice = s => s.mode === 'hire' ? Math.round((SP.cfg?.softplay_hire_price_pence || 0) * s.duration_min / 60) : SP.cfg?.softplay_supervised_price_pence;

function spRange() {
  if (SP.view === 'month') {
    const today = startOfToday();
    const first = new Date(today.getFullYear(), today.getMonth() + SP.month, 1);
    const lead = (first.getDay() + 6) % 7;
    const start = addDays(first, -lead);
    return [start, addDays(start, 41)];
  }
  const start = addDays(startOfToday(), SP.week * 7);
  return [start, addDays(start, 6)];
}

async function renderSoftplay() {
  const [from, to] = spRange();
  const [cfg, sessions] = await Promise.all([
    ppApi('settings?id=eq.1&select=softplay_open,softplay_min_children,softplay_max_children,softplay_hire_price_pence,softplay_supervised_price_pence,softplay_min_age,softplay_max_age,cutoff_hours,join_cutoff_hours'),
    ppApi(`softplay_sessions?session_date=gte.${iso(from)}&session_date=lte.${iso(to)}&select=*&order=session_date,start_time`),
  ]);
  SP.cfg = cfg[0]; SP.sessions = sessions;
  const ids = sessions.map(s => s.id);
  SP.bookings = ids.length ? await ppApi(`softplay_bookings?session_id=in.(${ids.join(',')})&order=created_at&select=*`) : [];
  drawSpSettings(); drawSpCalendar();
}

/* ---- status, shared by grid and panel ---- */
function spStatus(s) {
  const kids = spKids(s), n = spBks(s).length;
  if (s.cancelled_at) return { key: 'off', label: (s.cancel_reason || '').startsWith('auto:') ? 'Auto-cancelled' : 'Cancelled' };
  if (s.mode === 'hire') return n ? { key: 'full', label: 'Hired' } : { key: 'on', label: 'Available' };
  const min = SP.cfg.softplay_min_children;
  if (kids >= s.capacity) return { key: 'full', label: 'Full' };
  const left = (spStart(s) - new Date()) / 3600000;
  if (kids >= min) return { key: 'on', label: 'Confirmed' };
  if (left < SP.cfg.cutoff_hours) return { key: 'risk', label: 'Below minimum' };
  return { key: 'needs', label: `Needs ${min - kids} more` };
}

/* ---- calendar ---- */
function drawSpCalendar() {
  document.querySelectorAll('[data-spview]').forEach(b => b.classList.toggle('on', b.dataset.spview === SP.view));
  const tag = $('spOpenTag');
  tag.textContent = SP.cfg.softplay_open ? 'Online booking open' : 'Online booking closed';
  tag.className = 'd2-tag st ' + (SP.cfg.softplay_open ? 'on' : 'off');
  if (SP.view === 'month') drawSpMonth(); else drawSpWeek();
  drawSpDetail();
}
function drawSpWeek() {
  const [start] = spRange();
  const dates = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  $('spWeekLabel').textContent = `${fmtDate.format(dates[0])} to ${fmtDate.format(dates[6])}`;
  $('spPrev').disabled = SP.week <= 0;
  const todayIso = iso(startOfToday());
  const colH = (TG_END - TG_START) / 60 * TG_H;
  const times = [];
  for (let m = TG_START; m < TG_END; m += 60)
    times.push(`<div class="d2-tg-time" style="height:${TG_H}px"><span>${String(Math.floor(m / 60)).padStart(2, '0')}:00</span></div>`);
  const heads = dates.map(d => `<div class="d2-tg-day ${iso(d) === todayIso ? 'today' : ''}"><span class="dw">${fmtDay.format(d)}</span><b>${fmtDate.format(d)}</b></div>`).join('');
  const cols = dates.map(d => {
    const blocks = SP.sessions.filter(s => s.session_date === iso(d)).map(s => {
      const [h, mn] = s.start_time.split(':').map(Number);
      const top = ((h * 60 + mn) - TG_START) / 60 * TG_H;
      const height = Math.max(TG_H / 2, s.duration_min / 60 * TG_H) - 3;
      const st = spStatus(s);
      return `<button class="d2-ev ${spClass(s)} ${s.cancelled_at ? 'off' : ''} ${SP.sel === s.id ? 'sel' : ''}" style="top:${top + 1}px;height:${height}px" data-id="${s.id}">
        <span class="row"><span class="t">${s.start_time}</span><span class="c ${st.key}">${s.cancelled_at ? 'Cancelled' : spKids(s) + '/' + s.capacity}</span></span>
        <span class="n">${s.mode === 'hire' ? 'Hire slot' : 'Supervised'}${s.notes ? ' · ' + esc(s.notes) : ''}</span>
      </button>`;
    }).join('');
    return `<div class="d2-tg-col ${iso(d) === todayIso ? 'today' : ''}" data-date="${iso(d)}" style="height:${colH}px">${blocks}</div>`;
  }).join('');
  $('spGrid').innerHTML = `
    <div class="d2-tg">
      <div class="d2-tg-head"><div class="d2-tg-corner"></div>${heads}</div>
      <div class="d2-tg-body"><div class="d2-tg-times">${times.join('')}</div>${cols}</div>
    </div>`;
  $('spGrid').querySelectorAll('.d2-ev').forEach(b => b.addEventListener('click', () => { SP.sel = b.dataset.id; drawSpCalendar(); }));
}
function drawSpMonth() {
  const today = startOfToday();
  const first = new Date(today.getFullYear(), today.getMonth() + SP.month, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  $('spWeekLabel').textContent = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(first);
  $('spPrev').disabled = SP.month <= 0;
  const todayIso = iso(today);
  const [start] = spRange();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    if (i >= 35 && d > last) break;
    const inMonth = d.getMonth() === first.getMonth();
    const past = d < today;
    const chips = SP.sessions.filter(s => s.session_date === iso(d)).map(s => {
      const st = spStatus(s);
      return `<button class="d2-mev ${spClass(s)} ${s.cancelled_at ? 'off' : ''} ${SP.sel === s.id ? 'sel' : ''}" data-id="${s.id}" title="${s.mode === 'hire' ? 'Hire slot' : 'Supervised session'}${s.notes ? ' · ' + esc(s.notes) : ''}">
        <span class="t">${s.start_time}</span><span class="c ${st.key}">${s.cancelled_at ? 'off' : spKids(s) + '/' + s.capacity}</span></button>`;
    }).join('');
    cells.push(`<div class="d2-mg-day ${inMonth ? '' : 'out'} ${past ? 'past' : ''} ${iso(d) === todayIso ? 'today' : ''}"><span class="dn">${d.getDate()}</span>${chips}</div>`);
  }
  $('spGrid').innerHTML = `
    <div class="d2-mg">
      <div class="d2-mg-head">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(n => `<span>${n}</span>`).join('')}</div>
      <div class="d2-mg-body">${cells.join('')}</div>
    </div>`;
  $('spGrid').querySelectorAll('.d2-mev').forEach(b => b.addEventListener('click', () => { SP.sel = b.dataset.id; drawSpCalendar(); }));
}
document.querySelectorAll('[data-spview]').forEach(b => b.addEventListener('click', () => { SP.view = b.dataset.spview; renderSoftplay(); }));
$('spPrev').addEventListener('click', () => { if (SP.view === 'month') SP.month--; else SP.week--; renderSoftplay(); });
$('spNext').addEventListener('click', () => { if (SP.view === 'month') SP.month++; else SP.week++; renderSoftplay(); });
$('spToday').addEventListener('click', () => { SP.week = 0; SP.month = 0; renderSoftplay(); });

/* ---- detail panel ---- */
function drawSpDetail() {
  const el = $('spDetail');
  const s = SP.sel && SP.sessions.find(x => x.id === SP.sel);
  if (!s) { el.innerHTML = '<p class="d2-empty">Select a session to see who is booked.</p>'; return; }
  const bks = spBks(s), kids = spKids(s), st = spStatus(s);
  const here = bks.filter(b => b.checked_in_at).reduce((n, b) => n + b.children, 0);
  const past = spStart(s) < new Date();
  const price = spPrice(s);
  const free = Math.max(0, s.capacity - kids);
  const canDesk = !s.cancelled_at && !past && free > 0 && !(s.mode === 'hire' && bks.length);
  el.innerHTML = `
    <div class="d2-det-head">
      <div>
        <b>${s.mode === 'hire' ? 'Soft play hire' : 'Supervised session'}</b>
        <span>${fmtFull.format(spStart(s))} · ${s.start_time} to ${spHHMM(spEnd(s))} · ${s.duration_min} min${price ? ' · ' + spGbp(price) + '/child' : ' · price not set'}${s.notes ? ' · ' + esc(s.notes) : ''}</span>
      </div>
      <span class="d2-tag st ${st.key}">${st.label}</span>
    </div>
    <div class="d2-beds">${Array.from({ length: s.capacity }, (_, i) => `<i class="${i < kids ? 'taken' : ''}"></i>`).join('')}</div>
    <div class="d2-det-spots">${kids} of ${s.capacity} children · ${bks.length} booking${bks.length === 1 ? '' : 's'}${bks.length ? ` · ${here} here` : ''}</div>
    <div class="d2-det-list">
      ${s.cancelled_at ? `<p class="d2-empty">This session is cancelled${s.cancel_reason ? ' (' + esc(s.cancel_reason) + ')' : ''}. Everyone booked was texted and card payments refunded.</p>` : ''}
      ${bks.length ? bks.map(b => `
        <div class="d2-att${b.checked_in_at ? ' here' : ''}">
          <div class="d2-att-info">
            <b>${esc(b.name)}</b>
            <span class="d2-att-line">${b.children} ${b.children === 1 ? 'child' : 'children'}${b.child_names ? ' · ' + esc(b.child_names) : ''}</span>
            ${b.phone ? `<span class="d2-att-line">${esc(b.phone)}</span>` : ''}
            ${b.email ? `<span class="d2-att-line" title="${esc(b.email)}">${esc(b.email)}</span>` : ''}
          </div>
          <div class="d2-att-act">
            ${!s.cancelled_at ? `<button class="d2-ci${b.checked_in_at ? ' on' : ''}" data-ci="${b.id}" title="${b.checked_in_at ? 'Checked in. Press again to undo' : 'Mark as here'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="11" height="11"><path d="M4 12.5l5 5L20 7"/></svg>${b.checked_in_at ? 'Here' : 'Check in'}</button>` : ''}
            <button class="d2-x" data-rm="${b.id}" title="Remove booking"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
          </div>
          <span class="d2-att-meta"><em class="${b.source === 'Online' ? 'online' : ''}">${esc(b.source)}</em>${b.paid_at ? ` · Paid ${spGbp(b.amount_pence || 0)}${b.refunded_at ? ' · refunded' : ''}` : ' · Pay at desk'}</span>
        </div>`).join('') : (s.cancelled_at ? '' : '<p class="d2-empty">No bookings yet.</p>')}
    </div>
    <div class="d2-det-actions">
      ${!s.cancelled_at && bks.some(b => !b.checked_in_at) ? '<button class="d2-btn ghost" id="spAllHere">Everyone is here</button>' : ''}
      ${canDesk ? `<button class="d2-btn primary" id="spDesk">+ Desk booking</button>` : ''}
      ${!s.cancelled_at && !past ? `<button class="d2-btn danger" id="spCancel">Cancel session</button>` : ''}
      ${!bks.length && !past ? `<button class="d2-btn danger ghost" id="spDelete">Remove slot</button>` : ''}
    </div>`;

  const busy = err => alert('Could not save: ' + (err && err.message || 'please try again'));
  el.querySelectorAll('[data-ci]').forEach(b => b.addEventListener('click', async () => {
    const bk = SP.bookings.find(x => x.id === b.dataset.ci); b.disabled = true;
    try { await ppApi('rpc/set_softplay_check_in', { method: 'POST', body: JSON.stringify({ p_id: bk.id, p_present: !bk.checked_in_at }) }); } catch (e) { busy(e); }
    renderSoftplay();
  }));
  const all = $('spAllHere');
  if (all) all.addEventListener('click', async () => {
    all.disabled = true; all.textContent = 'Saving…';
    try { for (const b of bks.filter(x => !x.checked_in_at)) await ppApi('rpc/set_softplay_check_in', { method: 'POST', body: JSON.stringify({ p_id: b.id, p_present: true }) }); } catch (e) { busy(e); }
    renderSoftplay();
  });
  el.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
    const bk = SP.bookings.find(x => x.id === b.dataset.rm);
    const paid = bk.paid_at && !bk.refunded_at && bk.payment_intent_id;
    if (!confirm(paid ? `Remove this booking? ${spGbp(bk.amount_pence || 0)} will be refunded to their card automatically.` : 'Remove this booking?')) return;
    try {
      if (paid) { const { results } = await Store.refundSoftplay([bk.id]); if (results[bk.id] !== 'refunded') throw new Error(results[bk.id]); }
      else await ppApi(`softplay_bookings?id=eq.${bk.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ cancelled_at: new Date().toISOString() }) });
    } catch (e) { busy(e); }
    renderSoftplay();
  }));
  const desk = $('spDesk'); if (desk) desk.addEventListener('click', () => openSpDesk(s));
  const cancel = $('spCancel');
  if (cancel) cancel.addEventListener('click', async () => {
    if (!confirm(`Cancel the ${s.start_time} ${s.mode === 'hire' ? 'hire slot' : 'supervised session'} on ${fmtFull.format(spStart(s))}?${bks.length ? ` ${bks.length} booking${bks.length === 1 ? '' : 's'} will be cancelled, everyone texted and card payments refunded automatically.` : ''}`)) return;
    const reason = prompt('Reason (shown to parents in the text):', 'cancelled by the club') || 'cancelled_by_club';
    try { await ppApi('rpc/cancel_softplay_session', { method: 'POST', body: JSON.stringify({ p_id: s.id, p_reason: reason }) }); } catch (e) { busy(e); }
    renderSoftplay();
  });
  const del = $('spDelete');
  if (del) del.addEventListener('click', async () => {
    if (!confirm('Take this empty slot off the timetable?')) return;
    try { await ppApi(`softplay_sessions?id=eq.${s.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); SP.sel = null; } catch (e) { busy(e); }
    renderSoftplay();
  });
}

/* ---- settings ---- */
function drawSpSettings() {
  const f = $('spRules'), c = SP.cfg;
  if (!c || (document.activeElement && f.contains(document.activeElement))) return;
  f.spSupervised.value = c.softplay_supervised_price_pence != null ? (c.softplay_supervised_price_pence / 100) : '';
  f.spHire.value = (c.softplay_hire_price_pence ?? 500) / 100;
  f.spMin.value = c.softplay_min_children; f.spMax.value = c.softplay_max_children;
  f.spAgeMin.value = c.softplay_min_age; f.spAgeMax.value = c.softplay_max_age;
  f.spOpen.checked = !!c.softplay_open;
}
$('spRules').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const body = {
    softplay_supervised_price_pence: spPence(f.spSupervised.value), softplay_hire_price_pence: spPence(f.spHire.value),
    softplay_min_children: +f.spMin.value, softplay_max_children: +f.spMax.value,
    softplay_min_age: +f.spAgeMin.value, softplay_max_age: +f.spAgeMax.value, softplay_open: f.spOpen.checked,
  };
  if (body.softplay_open && !body.softplay_supervised_price_pence
      && !confirm('The supervised price is not set, so supervised sessions cannot be booked online yet. Hire slots will sell. Open anyway?')) return;
  try {
    await ppApi('settings?id=eq.1', { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    $('spRulesSaved').hidden = false; setTimeout(() => { $('spRulesSaved').hidden = true; }, 2000);
    f.querySelector('button').blur();
    renderSoftplay();
  } catch (err) { alert('Could not save: ' + err.message); }
});

/* ---- add sessions ---- */
$('spAddBtn').addEventListener('click', () => {
  const f = $('spAddForm'); f.reset();
  const [start] = spRange();
  f.spDate.value = iso(start < startOfToday() ? startOfToday() : start);
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
    closeDrawers(); renderSoftplay();
  } catch (err) {
    alert(/duplicate|unique/.test(String(err.message))
      ? 'There is already a session at that time on one of those dates. Nothing was added; pick a different time.'
      : 'Could not add the sessions: ' + err.message);
  }
  btn.disabled = false; btn.textContent = 'Add to the timetable';
});

/* ---- desk booking ---- */
function openSpDesk(s) {
  SP.bkSession = s;
  $('spBkWhen').textContent = `${s.mode === 'hire' ? 'Hire slot' : 'Supervised session'} · ${fmtFull.format(spStart(s))} · ${s.start_time}`;
  const f = $('spBkForm'); f.reset(); $('spBkKids').value = 1;
  $('spBkKids').max = Math.max(1, s.capacity - spKids(s));
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
    closeDrawers(); SP.sel = s.id; renderSoftplay();
  } catch (err) {
    const m = String(err.message);
    alert(m.includes('session_full') ? 'Not enough places left for that many children.'
      : m.includes('session_taken') ? 'That hire slot already has a booking.'
      : m.includes('session_in_past') ? 'That session has already started.'
      : 'Could not save the booking: ' + m);
  }
  btn.disabled = false; btn.textContent = 'Confirm booking';
});
