/* ============================================================
   Padel Power · Studio Manager (staff dashboard)
   No login yet (auth to be added before go-live).
   Requires pilates-core.js. Real bookings only.
   Pages: Overview / Schedule (week calendar + detail panel) /
   Bookings (search table) / Settings (types + rules).
   Everything here shows on the public booking page immediately.
   ============================================================ */

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const wait = ms => new Promise(r => setTimeout(r, ms));

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/* ---------- state ---------- */
let page = 'overview';
let weekOffset = 0;
{ // before opening day, land the schedule on the opening week
  const opening = new Date(RULES.openingDate + 'T00:00:00');
  if (startOfToday() < opening) weekOffset = Math.floor((opening - startOfToday()) / (7 * 86400000));
}
let selectedClass = null;   // classId shown in the schedule detail panel
let drawerClass = null;     // classId the booking drawer is writing to
let bkQuery = '', bkSrc = '';

/* ---------- shared data helpers ---------- */
function weekDates() {
  const start = addDays(startOfToday(), weekOffset * 7);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}
function classInfo(d, c) {
  const id = `${iso(d)}_${c.time}`;
  return { id, date: new Date(d), ...c, t: CLASS_TYPES[c.type], count: Store.count(id) };
}
function dayClasses(d) { return classesFor(d, true).map(c => classInfo(d, c)); }
function statusOf(c) {
  if (c.cancelled)                return { key: 'off',   label: 'Cancelled' };
  if (c.count >= RULES.maxRiders) return { key: 'full',  label: 'Full' };
  if (withinCutoff(c.id))         return c.count >= RULES.minRiders ? { key: 'on', label: 'Confirmed' } : { key: 'risk', label: 'Below minimum' };
  if (c.count < RULES.minRiders)  return { key: 'needs', label: `Needs ${RULES.minRiders - c.count} more` };
  return { key: 'on', label: 'Confirmed' };
}
function findClass(classId) {
  const [date, time] = classId.split('_');
  const d = new Date(date + 'T00:00:00');
  const c = classesFor(d, true).find(x => x.time === time);
  return c ? classInfo(d, c) : null;
}
function allBookings() {
  return cache.bookings.map(b => ({ ...b, cls: findClass(b.classId) }));
}
function upcoming(days = RULES.windowDays) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(...dayClasses(addDays(startOfToday(), i)));
  return out;
}

/* ---------- navigation ---------- */
const TITLES = { overview: 'Overview', schedule: 'Schedule', bookings: 'Bookings', enquiries: 'Enquiries', settings: 'Settings' };
function goto(p) {
  page = p;
  document.querySelectorAll('.d2-nav button').forEach(b => b.classList.toggle('on', b.dataset.page === p));
  ['Overview', 'Schedule', 'Bookings', 'Enquiries', 'Settings'].forEach(n => { $('pg' + n).hidden = n.toLowerCase() !== p; });
  $('pageTitle').textContent = TITLES[p];
  render();
}
document.querySelectorAll('.d2-nav button').forEach(b => b.addEventListener('click', () => goto(b.dataset.page)));
document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => goto(b.dataset.goto)));

function render() {
  if (page === 'overview') renderOverview();
  if (page === 'schedule') renderSchedule();
  if (page === 'bookings') renderBookings();
  if (page === 'enquiries') renderEnquiries();
  if (page === 'settings') renderSettings();
}
function refresh() { render(); }

/* ============================================================
   OVERVIEW
   ============================================================ */
function renderOverview() {
  const today = startOfToday();
  const todays = dayClasses(today);
  const week = upcoming(7).filter(c => !c.cancelled);
  const bookedToday = todays.reduce((n, c) => n + c.count, 0);
  const weekBooked = week.reduce((n, c) => n + c.count, 0);
  const weekBeds = week.length * RULES.maxRiders;
  const fill = weekBeds ? Math.round(weekBooked / weekBeds * 100) : 0;
  const attention = week.filter(c => statusOf(c).key === 'needs' || statusOf(c).key === 'risk').length;

  $('ovStats').innerHTML = [
    { n: todays.filter(c => !c.cancelled).length, l: 'Classes today' },
    { n: `${bookedToday}`, l: 'Beds booked today' },
    { n: fill + '%', l: 'Fill rate · 7 days', bar: fill },
    { n: attention, l: 'Need more bookings', warn: attention > 0 },
  ].map(k => `
    <div class="d2-stat ${k.warn ? 'warn' : ''}">
      <b>${k.n}</b><span>${k.l}</span>
      ${k.bar != null ? `<div class="d2-mini"><i style="width:${k.bar}%"></i></div>` : ''}
    </div>`).join('');

  // today's schedule
  $('ovTodayTitle').textContent = `Today · ${fmtFull.format(today)}`;
  $('ovToday').innerHTML = todays.length ? todays.map(c => {
    const s = statusOf(c);
    const past = classStart(c.id) < new Date();
    return `
    <button class="d2-trow ${past ? 'past' : ''}" data-id="${c.id}">
      <span class="tm">${c.time}</span>
      <span class="nm">${esc(c.t.name)}</span>
      <span class="oc"><span class="d2-bar"><i class="${s.key}" style="width:${Math.round(c.count / RULES.maxRiders * 100)}%"></i></span>${c.count}/${RULES.maxRiders}</span>
      <span class="d2-dot ${s.key}" title="${s.label}"></span>
    </button>`;
  }).join('') : '<p class="d2-empty">No classes today.</p>';
  $('ovToday').querySelectorAll('.d2-trow').forEach(r =>
    r.addEventListener('click', () => { selectedClass = r.dataset.id; weekOffset = 0; goto('schedule'); }));

  // next class
  const now = new Date();
  const next = upcoming(45).find(c => !c.cancelled && classStart(c.id) > now);
  if (next) {
    const mins = Math.round((classStart(next.id) - now) / 60000);
    const inTxt = mins < 60 ? `in ${mins} min` : mins < 1440 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : `${fmtDay.format(next.date)} ${fmtDate.format(next.date)}`;
    $('ovNext').innerHTML = `
      <div class="d2-next">
        <div class="when"><b>${next.time}</b><span>${inTxt}</span></div>
        <div class="what">
          <b>${esc(next.t.name)}</b>
          <span>${fmtFull.format(next.date)} · ${next.count}/${RULES.maxRiders} booked</span>
        </div>
        <button class="d2-btn ghost" data-id="${next.id}" id="nextAdd" ${next.count >= RULES.maxRiders ? 'disabled' : ''}>+ Booking</button>
      </div>`;
    const btn = $('nextAdd');
    if (btn && !btn.disabled) btn.addEventListener('click', () => openBooking(next.id));
  } else {
    $('ovNext').innerHTML = '<p class="d2-empty">No upcoming classes.</p>';
  }

  // latest bookings feed
  const feed = allBookings().sort((a, b) => b.at - a.at).slice(0, 6);
  $('ovFeed').innerHTML = feed.length ? feed.map(b => `
    <div class="d2-feed-row">
      <span class="who">${esc(b.name)}</span>
      <span class="what">${b.cls ? esc(b.cls.t.name) + ' · ' + fmtDate.format(b.cls.date) + ' ' + b.cls.time : 'Removed class'}</span>
      <span class="d2-tag ${b.source === 'Online' ? 'online' : ''}">${esc(b.source || 'Online')}</span>
    </div>`).join('') : '<p class="d2-empty">No bookings yet. They\'ll appear here as they come in.</p>';
}

/* ============================================================
   SCHEDULE — week calendar + detail panel
   ============================================================ */
const TG_START = 6 * 60, TG_END = 21 * 60, TG_H = 52; // grid: 06:00 to 21:00, px per hour
const TYPE_COLORS = { flow: 'tc-flow', foundations: 'tc-found', strength: 'tc-str', restore: 'tc-rest' };
const EXTRA_TC = ['tc-a', 'tc-b', 'tc-c'];
function typeClass(type) {
  if (TYPE_COLORS[type]) return TYPE_COLORS[type];
  let h = 0; for (const ch of type) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return EXTRA_TC[h % EXTRA_TC.length];
}

function renderSchedule() {
  const dates = weekDates();
  $('wkLabel').textContent = `${fmtDate.format(dates[0])} to ${fmtDate.format(dates[6])}`;
  $('wkPrev').disabled = weekOffset <= 0;

  const todayIso = iso(startOfToday());
  const colH = (TG_END - TG_START) / 60 * TG_H;

  const times = [];
  for (let m = TG_START; m < TG_END; m += 60)
    times.push(`<div class="d2-tg-time" style="height:${TG_H}px"><span>${String(Math.floor(m / 60)).padStart(2, '0')}:00</span></div>`);

  const heads = dates.map(d =>
    `<div class="d2-tg-day ${iso(d) === todayIso ? 'today' : ''}"><span class="dw">${fmtDay.format(d)}</span><b>${fmtDate.format(d)}</b></div>`).join('');

  const cols = dates.map(d => {
    const blocks = dayClasses(d).map(c => {
      const [h, mn] = c.time.split(':').map(Number);
      const top = ((h * 60 + mn) - TG_START) / 60 * TG_H;
      const s = statusOf(c);
      return `<button class="d2-ev ${typeClass(c.type)} ${c.cancelled ? 'off' : ''} ${selectedClass === c.id ? 'sel' : ''}" style="top:${top + 1}px;height:${TG_H - 3}px" data-id="${c.id}">
        <span class="row"><span class="t">${c.time}</span><span class="c ${s.key}">${c.cancelled ? 'Cancelled' : c.count + '/' + RULES.maxRiders}</span></span>
        <span class="n">${esc(c.instructor || shortName(c.t.name))}${c.custom ? ' +' : ''}</span>
      </button>`;
    }).join('');
    return `<div class="d2-tg-col ${iso(d) === todayIso ? 'today' : ''}" style="height:${colH}px">${blocks}</div>`;
  }).join('');

  $('calGrid').innerHTML = `
    <div class="d2-tg">
      <div class="d2-tg-head"><div class="d2-tg-corner"></div>${heads}</div>
      <div class="d2-tg-body"><div class="d2-tg-times">${times.join('')}</div>${cols}</div>
    </div>`;

  $('calLegend').innerHTML = Object.entries(CLASS_TYPES).map(([k, t]) =>
    `<span class="d2-leg-item ${typeClass(k)}"><i></i>${esc(shortName(t.name))}</span>`).join('');

  $('calGrid').querySelectorAll('.d2-ev').forEach(b =>
    b.addEventListener('click', () => { selectedClass = b.dataset.id; renderSchedule(); }));

  renderDetail();
}
function shortName(name) { return name.replace(/^Reformer\s+/i, ''); }

function renderDetail() {
  const el = $('classDetail');
  const c = selectedClass && findClass(selectedClass);
  if (!c) { el.innerHTML = '<p class="d2-empty">Select a class to see its bookings.</p>'; return; }
  const s = statusOf(c);
  const people = Store.attendees(c.id);
  const free = RULES.maxRiders - c.count;
  el.innerHTML = `
    <div class="d2-det-head">
      <div>
        <b>${esc(c.t.name)}</b>
        <span>${fmtFull.format(c.date)} · ${c.time} · 1 hour${c.instructor ? ' · ' + esc(c.instructor) : ''}</span>
      </div>
      <span class="d2-tag st ${s.key}">${s.label}</span>
    </div>
    <div class="d2-beds">${Array.from({ length: RULES.maxRiders }, (_, i) => `<i class="${i < c.count ? 'taken' : ''}"></i>`).join('')}</div>
    <div class="d2-det-spots">${free} of ${RULES.maxRiders} beds free</div>
    <div class="d2-det-list">
      ${c.cancelled ? '<p class="d2-empty">This class is cancelled. It no longer appears on the public timetable.</p>' : ''}
      ${people.length ? people.map(p => `
        <div class="d2-att">
          <div><b>${esc(p.name)}</b><span>${esc(p.phone || '')}${p.email ? ' · ' + esc(p.email) : ''}${p.paid ? ' · Paid ' + gbp(p.amount) : ''}${waiverMark(p.email)}</span></div>
          <span class="d2-tag ${p.source === 'Online' ? 'online' : ''}">${esc(p.source)}</span>
          <button class="d2-x" data-bid="${p.id}" title="Remove booking"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M5 5l14 14M19 5L5 19"/></svg></button>
        </div>`).join('') : '<p class="d2-empty">No bookings yet.</p>'}
    </div>
    <div class="d2-det-actions">
      ${!c.cancelled && free > 0 ? `<button class="d2-btn primary" id="detAdd">+ New booking</button>` : ''}
      ${c.cancelled
        ? `<button class="d2-btn ghost" id="detRestore">Put class back on</button>`
        : `<button class="d2-btn danger" id="detCancelClass">Cancel class</button>`}
    </div>`;
  el.querySelectorAll('.wv-view').forEach(b =>
    b.addEventListener('click', () => openWaiverView(b.dataset.em)));
  el.querySelectorAll('.d2-x').forEach(b =>
    b.addEventListener('click', async () => {
      const p = people.find(x => x.id === b.dataset.bid);
      const paidBooking = p && p.paid && !p.refunded;
      if (!confirm(paidBooking
        ? `Remove this booking? ${gbp(p.amount)} will be refunded to their card automatically.`
        : 'Remove this booking?')) return;
      try {
        if (paidBooking) {
          const { results } = await Store.refund([p.id]);
          if (results[p.id] !== 'refunded') throw new Error(results[p.id]);
        } else {
          await Store.cancel(c.id, { id: b.dataset.bid });
        }
      } catch { alert('Could not remove the booking. Please try again.'); }
      refresh();
    }));
  const add = $('detAdd');
  if (add) add.addEventListener('click', () => openBooking(c.id));

  const cancelCls = $('detCancelClass');
  if (cancelCls) cancelCls.addEventListener('click', async () => {
    const n = people.length;
    const paidPeople = people.filter(p => p.paid && !p.refunded);
    const msg = n
      ? `Cancel this class?\n\n${n} booking${n === 1 ? '' : 's'} will be cancelled and the class will come off the public timetable.`
        + (paidPeople.length ? `\n${paidPeople.length} paid booking${paidPeople.length === 1 ? '' : 's'} will be refunded to their card automatically.` : '')
        + `\nContact those members yourself:\n\n`
        + people.map(p => `${p.name} · ${p.phone}`).join('\n')
      : 'Cancel this class? It will come off the public timetable.';
    if (!confirm(msg)) return;
    try {
      // cancel first so every member (including paid) gets the cancellation
      // text while their booking is still active, then refund the paid ones
      await Store.cancelClass(iso(c.date), c.time, { custom: c.custom });
      if (c.custom) selectedClass = null;
      if (paidPeople.length) {
        const { results } = await Store.refund(paidPeople.map(p => p.id));
        const failed = paidPeople.filter(p => results[p.id] !== 'refunded');
        if (failed.length) {
          alert('The class is cancelled and members have been notified, but these refunds FAILED and need doing in the Stripe dashboard: '
            + failed.map(p => p.name).join(', '));
        }
      }
    } catch { alert('Could not cancel the class. Please try again.'); }
    refresh();
  });

  const restore = $('detRestore');
  if (restore) restore.addEventListener('click', async () => {
    if (!confirm('Put this class back on the timetable? Cancelled bookings are not restored.')) return;
    try { await Store.restoreClass(iso(c.date), c.time); } catch { alert('Could not restore the class.'); }
    refresh();
  });
}

$('wkPrev').addEventListener('click', () => { if (weekOffset > 0) { weekOffset--; renderSchedule(); } });
$('wkNext').addEventListener('click', () => { weekOffset++; renderSchedule(); });
$('wkToday').addEventListener('click', () => { weekOffset = 0; renderSchedule(); });

/* ============================================================
   BOOKINGS — searchable table
   ============================================================ */
function renderBookings() {
  const q = bkQuery.toLowerCase();
  let rows = allBookings()
    .filter(b => b.cls) // skip bookings whose class was removed
    .sort((a, b) => classStart(a.classId) - classStart(b.classId));
  if (bkSrc) rows = rows.filter(b => (b.source || 'Online') === bkSrc);
  if (q) rows = rows.filter(b =>
    b.name.toLowerCase().includes(q) ||
    (b.phone || '').toLowerCase().includes(q) ||
    b.cls.t.name.toLowerCase().includes(q));
  $('bkTable').querySelector('tbody').innerHTML = rows.map(b => `
    <tr>
      <td class="nm">${esc(b.name)}</td>
      <td class="ct">${esc(b.phone || '')}${b.email ? '<br>' + esc(b.email) : ''}${waiverMark(b.email)}</td>
      <td>${esc(b.cls.t.name)}</td>
      <td class="ct">${fmtDay.format(b.cls.date)} ${fmtDate.format(b.cls.date)} · ${b.cls.time}</td>
      <td><span class="d2-tag ${(b.source || 'Online') === 'Online' ? 'online' : ''}">${esc(b.source || 'Online')}</span>${b.paid ? `<br><span class="d2-tag" style="margin-top:5px">Paid ${gbp(b.amount)}</span>` : ''}</td>
      <td class="rm"><button class="d2-x" data-id="${b.classId}" data-bid="${b.id}" title="Remove booking"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M5 5l14 14M19 5L5 19"/></svg></button></td>
    </tr>`).join('');
  $('bkEmpty').hidden = rows.length > 0;
  $('bkTable').querySelector('thead').style.display = rows.length ? '' : 'none';
  $('bkTable').querySelectorAll('.wv-view').forEach(b =>
    b.addEventListener('click', () => openWaiverView(b.dataset.em)));
  $('bkTable').querySelectorAll('.d2-x').forEach(b =>
    b.addEventListener('click', async () => {
      const bk = rows.find(x => x.id === b.dataset.bid);
      const paidBooking = bk && bk.paid && !bk.refunded;
      if (!confirm(paidBooking
        ? `Remove this booking? ${gbp(bk.amount)} will be refunded to their card automatically.`
        : 'Remove this booking?')) return;
      try {
        if (paidBooking) {
          const { results } = await Store.refund([bk.id]);
          if (results[bk.id] !== 'refunded') throw new Error(results[bk.id]);
        } else {
          await Store.cancel(b.dataset.id, { id: b.dataset.bid });
        }
      } catch { alert('Could not remove the booking. Please try again.'); }
      refresh();
    }));
}
$('bkSearch').addEventListener('input', e => { bkQuery = e.target.value; renderBookings(); });
$('srcFilter').querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => {
    bkSrc = b.dataset.src;
    $('srcFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderBookings();
  }));

/* ============================================================
   HEALTH WAIVERS (one per member email, signed at first booking)
   ============================================================ */
let waiverEmails = new Set();
async function loadWaivers() {
  const rows = await ppApi('waivers?select=email');
  waiverEmails = new Set(rows.map(r => r.email));
}
function waiverMark(email) {
  if (!email) return '';
  const em = email.trim().toLowerCase();
  return waiverEmails.has(em)
    ? ` · <button class="d2-link wv-view" data-em="${esc(em)}">Waiver ✓</button>`
    : ' · No waiver';
}
async function openWaiverView(email) {
  let w;
  try {
    const rows = await ppApi(`waivers?email=eq.${encodeURIComponent(email)}&select=*`);
    w = rows[0];
  } catch {}
  if (!w) { alert('Could not load the waiver.'); return; }
  const fmtD = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  $('wvBody').innerHTML = `
    <div class="row"><b>${esc(w.full_name)}</b><span class="q">${esc(w.email)} · signed ${fmtD.format(new Date(w.signed_at))}</span></div>
    <div class="row"><div class="q">Emergency contact</div><div class="a">${esc(w.emergency_contact)}</div></div>
    ${(w.answers || []).map(a => `
      <div class="row">
        <div class="q">${a.n}. ${esc(PP_WAIVER_QUESTIONS[a.n - 1] || '')}</div>
        <div class="a">${a.yes ? '<span class="yes">Yes</span>' : 'No'}${a.yes && a.comment ? ' · ' + esc(a.comment) : ''}</div>
      </div>`).join('')}
    <div class="row"><div class="q">Declaration agreed · signature</div><div class="a">${esc(w.signature)}</div></div>`;
  openDrawer('wvDrawer');
}

/* ============================================================
   ENQUIRIES (contact form submissions)
   ============================================================ */
let enqRows = [], enqState = 'new';
async function loadEnquiries() {
  enqRows = await ppApi('enquiries?select=*&order=created_at.desc');
  const unread = enqRows.filter(e => !e.handled_at).length;
  const badge = $('enqBadge');
  badge.textContent = unread;
  badge.hidden = unread === 0;
}
function renderEnquiries() {
  const rows = enqState === 'new' ? enqRows.filter(e => !e.handled_at) : enqRows;
  $('enqList').innerHTML = rows.length ? rows.map(e => `
    <div class="d2-enq ${e.handled_at ? 'done' : ''}">
      <div class="hd">
        <div>
          <b>${esc(e.name)}</b>
          <span class="d2-tag">${esc(e.topic || 'Enquiry')}</span>
        </div>
        <span class="when">${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(e.created_at))}</span>
      </div>
      <p class="msg">${esc(e.message)}</p>
      <div class="ft">
        <a href="mailto:${encodeURIComponent(e.email)}">${esc(e.email)}</a>
        ${e.phone ? `<a href="tel:${encodeURIComponent(e.phone)}">${esc(e.phone)}</a>` : ''}
        ${e.handled_at ? '<span class="d2-tag">Handled</span>' : `<button class="d2-btn ghost sm enq-done" data-id="${e.id}">Mark handled</button>`}
      </div>
    </div>`).join('') : '<p class="d2-empty">No enquiries here.</p>';
  $('enqList').querySelectorAll('.enq-done').forEach(b =>
    b.addEventListener('click', async () => {
      try {
        await ppApi(`enquiries?id=eq.${b.dataset.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ handled_at: new Date().toISOString() }) });
        await loadEnquiries();
      } catch { alert('Could not update that enquiry.'); }
      renderEnquiries();
    }));
}
$('enqFilter').querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => {
    enqState = b.dataset.state;
    $('enqFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderEnquiries();
  }));

/* ============================================================
   SETTINGS
   ============================================================ */
function renderSettings() {
  $('typeList').innerHTML = Object.entries(CLASS_TYPES).map(([k, t]) => `
    <div class="d2-type ${t.custom ? 'custom' : ''}">
      <div class="hd"><b>${esc(t.name)}</b><span class="d2-tag">${esc(t.level)}</span></div>
      <p>${esc(t.desc)}</p>
      <label class="d2-label" style="display:flex;align-items:center;gap:8px;margin:10px 0 12px">Price £
        <input class="d2-input tp-price" data-key="${k}" type="number" min="1" max="1000" step="0.01"
          value="${t.price ? t.price / 100 : ''}" placeholder="Free" style="width:100px">
      </label>
      ${t.custom ? `<button class="d2-btn danger sm tp-del" data-key="${k}">Delete</button>` : '<span class="core">Core class</span>'}
    </div>`).join('') + `
    <div class="d2-form-row" style="grid-column:1 / -1;align-items:center;gap:14px">
      <button class="d2-btn primary" id="savePrices">Save prices</button>
      <span class="d2-saved" id="pricesSaved" hidden>Prices saved</span>
    </div>
    <p class="d2-sub" style="grid-column:1 / -1;margin:0">A price makes online bookings pay by card at the time of booking. Leave blank and the class stays free to reserve. Front desk and phone bookings are never charged online.</p>`;
  $('savePrices').addEventListener('click', async () => {
    const btn = $('savePrices'); btn.disabled = true;
    try {
      for (const inp of document.querySelectorAll('.tp-price')) {
        const key = inp.dataset.key;
        const pence = inp.value === '' ? null : Math.round(parseFloat(inp.value) * 100);
        if (pence !== null && (!isFinite(pence) || pence < 100 || pence > 100000)) {
          alert(`Enter a price between £1 and £1000 for ${CLASS_TYPES[key].name}, or leave it blank.`);
          btn.disabled = false; return;
        }
        if ((CLASS_TYPES[key].price || null) !== pence) await Settings.setPrice(key, pence);
      }
      $('pricesSaved').hidden = false;
      setTimeout(() => { $('pricesSaved').hidden = true; }, 2000);
    } catch { alert('Could not save the prices. Please try again.'); }
    btn.disabled = false;
  });
  $('typeList').querySelectorAll('.tp-del').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this class type? Scheduled classes of this type will be removed from the timetable.')) return;
      try { await Settings.removeType(btn.dataset.key); } catch { alert('Could not delete the class type.'); }
      renderSettings();
    }));
  const f = $('rulesForm');
  f.rMax.value = RULES.maxRiders;
  f.rMin.value = RULES.minRiders;
  f.rCutoff.value = RULES.cutoffHours;
  f.rWindow.value = RULES.windowDays;
  $('pwEmail').textContent = Auth.email() || '';
}
$('pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const current = f.pwCurrent.value, next = f.pwNew.value;
  if (next !== f.pwConfirm.value) { alert('New passwords do not match.'); return; }
  if (next === current) { alert('The new password must be different from the current one.'); return; }
  const btn = f.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await Auth.changePassword(current, next);
    f.reset();
    $('pwSaved').hidden = false;
    setTimeout(() => { $('pwSaved').hidden = true; }, 3000);
  } catch (err) {
    alert(String(err.message) === 'wrong_password'
      ? 'Your current password is incorrect.'
      : 'Could not update the password. ' + String(err.message).replace(/^update_failed$/, 'Please try again.'));
  }
  btn.disabled = false;
});
$('newType').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const name = f.ntName.value.trim();
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!key) return;
  if (CLASS_TYPES[key]) { alert('A class type with that name already exists.'); return; }
  try {
    await Settings.addType(key, { name, level: f.ntLevel.value, desc: f.ntDesc.value.trim() });
    f.reset();
  } catch { alert('Could not save the class type. Please try again.'); }
  renderSettings();
});
$('rulesForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const min = +f.rMin.value, max = +f.rMax.value;
  if (min > max) { alert('Minimum to run cannot be higher than beds per class.'); return; }
  try {
    await Settings.saveRules({ maxRiders: max, minRiders: min, cutoffHours: +f.rCutoff.value, windowDays: +f.rWindow.value });
    $('rulesSaved').hidden = false;
    setTimeout(() => { $('rulesSaved').hidden = true; }, 2000);
  } catch { alert('Could not save the rules. Please try again.'); }
});

/* ============================================================
   DRAWERS
   ============================================================ */
function openDrawer(id) { document.body.classList.add('drawer-open'); $(id).classList.add('open'); }
function closeDrawers() {
  document.body.classList.remove('drawer-open');
  document.querySelectorAll('.d2-drawer').forEach(d => d.classList.remove('open'));
  drawerClass = null;
}
$('scrim').addEventListener('click', closeDrawers);
$('bkClose').addEventListener('click', closeDrawers);
$('clClose').addEventListener('click', closeDrawers);
$('wvClose').addEventListener('click', closeDrawers);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawers(); });

/* --- new booking drawer --- */
function bookableUpcoming() {
  return upcoming(45).filter(c => !c.cancelled && !withinCutoff(c.id) && c.count < RULES.maxRiders).slice(0, 60);
}
function openBooking(classId) {
  const picker = $('bkPick');
  if (!classId) {
    const opts = bookableUpcoming();
    if (!opts.length) { alert('No upcoming classes are open for booking.'); return; }
    picker.innerHTML = opts.map(c =>
      `<option value="${c.id}">${fmtDay.format(c.date)} ${fmtDate.format(c.date)} · ${c.time} · ${esc(c.t.name)} (${RULES.maxRiders - c.count} free)</option>`).join('');
    picker.hidden = false; $('bkPickLabel').hidden = false;
    classId = opts[0].id;
  } else {
    picker.hidden = true; $('bkPickLabel').hidden = true;
  }
  setBookingClass(classId);
  $('bkForm').reset();
  $('bkForm').hidden = false;
  $('bkDone').hidden = true;
  openDrawer('bkDrawer');
  setTimeout(() => $('bkName').focus(), 250);
}
function setBookingClass(classId) {
  drawerClass = classId;
  const c = findClass(classId);
  $('bkClass').textContent = c.t.name;
  $('bkWhen').textContent = `${fmtFull.format(c.date)} · ${c.time} · 1 hour${c.instructor ? ' · ' + c.instructor : ''}`;
  $('bkBeds').innerHTML = Array.from({ length: RULES.maxRiders }, (_, i) => `<i class="${i < c.count ? 'taken' : ''}"></i>`).join('');
  $('bkSpots').textContent = `${RULES.maxRiders - c.count} of ${RULES.maxRiders} beds free`;
}
$('bkPick').addEventListener('change', e => setBookingClass(e.target.value));
$('globalNew').addEventListener('click', () => openBooking(null));

$('bkForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const person = {
    name: f.bkName.value.trim(),
    email: f.bkEmail.value.trim().toLowerCase(),
    phone: `${f.bkCode.value} ${f.bkPhone.value.trim().replace(/^0+/, '')}`,
    source: f.bkSrc.value,
  };
  if (!waiverEmails.has(person.email)) { openStaffWaiver(person); return; }
  await doStaffBook(person);
});

async function doStaffBook(person) {
  try {
    await Store.book(drawerClass, person);
  } catch (err) {
    const msg = String(err.message);
    if (msg.includes('waiver_required')) { openStaffWaiver(person); return; }
    alert(msg.includes('class_full') ? 'That class is now full.' : 'Could not save the booking. Please try again.');
    setBookingClass(drawerClass);
    return;
  }
  $('bkDoneMeta').textContent = `${$('bkClass').textContent} · ${$('bkWhen').textContent}`;
  $('bkForm').hidden = true;
  $('bkDone').hidden = false;
  render();
}

/* --- waiver signing drawer: member completes it on the staff device --- */
let wsPending = null;
let wsBuilt = false;
function buildStaffWaiver() {
  if (wsBuilt) return;
  wsBuilt = true;
  $('wsQuestions').innerHTML = PP_WAIVER_QUESTIONS.map((q, i) => `
    <div class="d2-wq">
      <p>${i + 1}. ${esc(q)}</p>
      <div class="yn">
        <label><input type="radio" name="wsq${i}" value="no" required> No</label>
        <label><input type="radio" name="wsq${i}" value="yes"> Yes</label>
      </div>
      <textarea class="d2-input" name="wsc${i}" placeholder="If yes, please give details" maxlength="500" hidden></textarea>
    </div>`).join('');
  document.querySelectorAll('#wsQuestions input[type=radio]').forEach(r =>
    r.addEventListener('change', () => {
      const i = r.name.slice(3);
      const ta = document.querySelector(`#wsQuestions textarea[name=wsc${i}]`);
      const yes = r.form.elements['wsq' + i].value === 'yes';
      ta.hidden = !yes;
      ta.required = yes;
      if (!yes) ta.value = '';
    }));
}
function openStaffWaiver(person) {
  buildStaffWaiver();
  wsPending = person;
  $('wsEmail').textContent = person.email;
  $('wsDate').textContent = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
  $('wsForm').reset();
  document.querySelectorAll('#wsQuestions textarea').forEach(t => { t.hidden = true; t.required = false; });
  $('wsName').value = person.name;
  $('wsDrawer').classList.add('open');
}
$('wsClose').addEventListener('click', () => { $('wsDrawer').classList.remove('open'); wsPending = null; });
$('wsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const wf = e.target;
  const btn = wf.querySelector('button[type=submit]');
  btn.disabled = true;
  const answers = PP_WAIVER_QUESTIONS.map((q, i) => ({
    n: i + 1,
    yes: wf.elements['wsq' + i].value === 'yes',
    comment: wf.elements['wsc' + i].value.trim(),
  }));
  try {
    await Store.saveWaiver({
      email: wsPending.email,
      full_name: $('wsName').value.trim(),
      emergency_contact: $('wsEmergency').value.trim(),
      answers,
      declaration: true,
      signature: $('wsSign').value.trim(),
    });
  } catch (err) {
    if (!/duplicate|waivers_email/i.test(String(err.message))) {
      btn.disabled = false;
      alert('Could not save the waiver. Please check the answers and try again.');
      return;
    }
  }
  btn.disabled = false;
  waiverEmails.add(wsPending.email);
  $('wsDrawer').classList.remove('open');
  const person = wsPending;
  wsPending = null;
  await doStaffBook(person);
});
$('bkAnother').addEventListener('click', () => {
  const id = drawerClass;
  if (Store.count(id) >= RULES.maxRiders) { closeDrawers(); return; }
  openBooking(id);
});
$('bkDoneClose').addEventListener('click', closeDrawers);

/* --- add class drawer --- */
function renderTypeOptions() {
  $('clType').innerHTML = Object.entries(CLASS_TYPES).map(([k, t]) => `<option value="${k}">${esc(t.name)} (${esc(t.level)})</option>`).join('');
}
$('addClassBtn').addEventListener('click', () => {
  renderTypeOptions();
  $('clDate').innerHTML = weekDates().map(d =>
    `<option value="${iso(d)}">${fmtFull.format(d)}</option>`).join('');
  $('clForm').reset();
  openDrawer('clDrawer');
});
$('clForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const d = new Date(f.clDate.value + 'T00:00:00');
  if (classesFor(d).some(c => c.time === f.clTime.value)) {
    alert('There is already a class at ' + f.clTime.value + ' that day.');
    return;
  }
  try { await Store.addClass(f.clDate.value, f.clTime.value, f.clType.value, f.clInstructor.value.trim()); } catch { alert('Could not add the class. Please try again.'); return; }
  closeDrawers();
  render();
});

/* ---------- boot ---------- */
function clock() {
  $('clock').textContent = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date());
}
clock(); setInterval(clock, 30000);

/* ---------- staff session ---------- */
$('signOut').addEventListener('click', () => {
  Auth.signOut();
  location.replace('../login/');
});
if (!Auth.session()) location.replace('../login/?next=' + encodeURIComponent(location.pathname + location.search));
$('userEmail').textContent = Auth.email() || '';
// keep the access token fresh while the dashboard is open
setInterval(() => { Auth.ensure().catch(() => {}); }, 10 * 60 * 1000);

const startPage = new URLSearchParams(location.search).get('page');
ppReady
  .then(async () => {
    if (!await Auth.ensure()) { location.replace('../login/'); throw new Error('signed_out'); }
    await Store.loadBookings();
    await loadWaivers();
    return loadEnquiries();
  })
  .then(() => {
    goto(TITLES[startPage] ? startPage : 'overview');
    setInterval(async () => {
      try { await Store.loadBookings(); await loadWaivers(); await loadEnquiries(); render(); } catch {}
    }, 60000);
  })
  .catch(err => {
    if (String(err && err.message) === 'signed_out') return;
    document.querySelector('.d2-main').insertAdjacentHTML('afterbegin',
      '<div class="d2-errbar">Cannot reach the booking database. Check the connection and reload.</div>');
  });
