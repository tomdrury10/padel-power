/* ============================================================
   Padel Power · Studio Manager (staff dashboard)
   No login yet (auth to be added before go-live).
   Requires pilates-core.js. Real bookings only.
   Pages: Overview / Schedule (week calendar + detail panel) /
   Bookings (search table) / Settings (types + rules).
   Everything here shows on the public booking page immediately.
   ============================================================ */

// Make.com master webhook: enquiry replies route through here to Outlook.
// Branch on the `type` field in the Make scenario.
const PP_MAKE_WEBHOOK = ''; // paste the hook.eu2.make.com URL, then replies go live

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

/* ---------- roles + instructors ---------- */
const isAdmin = () => PP_ROLE !== 'instructor';
function applyRole() {
  if (isAdmin()) return;
  $('addClassBtn').hidden = true;
  $('navReports').hidden = true; // financials are admin-only
}
// options for an instructor dropdown; keeps a legacy free-text name selectable
function instrOptions(selected) {
  const names = Instructors.active().map(i => i.name);
  if (selected && !names.includes(selected)) names.unshift(selected);
  return '<option value="">No instructor</option>'
    + names.map(n => `<option value="${esc(n)}"${n === selected ? ' selected' : ''}>${esc(n)}</option>`).join('');
}

/* ---------- navigation ---------- */
const TITLES = { overview: 'Overview', schedule: 'Schedule', bookings: 'Bookings', enquiries: 'Enquiries', reports: 'Reports', settings: 'Settings' };
function goto(p) {
  if (p === 'reports' && !isAdmin()) p = 'overview';
  page = p;
  document.querySelectorAll('.d2-nav button').forEach(b => b.classList.toggle('on', b.dataset.page === p));
  ['Overview', 'Schedule', 'Bookings', 'Enquiries', 'Reports', 'Settings'].forEach(n => { $('pg' + n).hidden = n.toLowerCase() !== p; });
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
  if (page === 'reports') renderReports();
  if (page === 'settings') {
    // don't wipe half-typed edits when the 60s poll re-renders
    const a = document.activeElement;
    if (a && $('pgSettings').contains(a) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
    renderSettings();
  }
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
      ${!c.cancelled && isAdmin() ? `<button class="d2-btn ghost" id="detEdit">Edit class</button>` : ''}
      ${!isAdmin() ? ''
        : c.cancelled
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

  const edit = $('detEdit');
  if (edit) edit.addEventListener('click', () => openMove(c));

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
let enqRows = [], enqState = 'new', enqWho = '', enqReplyOpen = null;
const ENQ_STAFF = ['Grace', 'Joe'];
async function loadEnquiries() {
  enqRows = await ppApi('enquiries?select=*&order=created_at.desc');
  const unread = enqRows.filter(e => !e.handled_at).length;
  const badge = $('enqBadge');
  badge.textContent = unread;
  badge.hidden = unread === 0;
}
function renderEnquiries() {
  let rows = enqState === 'new' ? enqRows.filter(e => !e.handled_at) : enqRows;
  if (enqWho === 'none') rows = rows.filter(e => !e.assignee);
  else if (enqWho) rows = rows.filter(e => e.assignee === enqWho);
  const fmtWhen = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('enqList').innerHTML = rows.length ? rows.map(e => `
    <div class="d2-enq ${e.handled_at ? 'done' : ''}">
      <div class="hd">
        <div>
          <b>${esc(e.name)}</b>
          <span class="d2-tag">${esc(e.topic || 'Enquiry')}</span>
          ${e.assignee ? `<span class="d2-tag online">${esc(e.assignee)}</span>` : ''}
        </div>
        <span class="when">${fmtWhen.format(new Date(e.created_at))}</span>
      </div>
      <p class="msg">${esc(e.message)}</p>
      ${(e.replies || []).map(r => `
        <div class="d2-enq-reply">
          <span class="who">Replied by ${esc(r.by)} · ${fmtWhen.format(new Date(r.at))}</span>
          <p>${esc(r.body)}</p>
        </div>`).join('')}
      <div class="ft">
        <a href="mailto:${encodeURIComponent(e.email)}">${esc(e.email)}</a>
        ${e.phone ? `<a href="tel:${encodeURIComponent(e.phone)}">${esc(e.phone)}</a>` : ''}
        <select class="d2-input enq-assign" data-id="${e.id}" title="Assign to">
          <option value="">Unassigned</option>
          ${ENQ_STAFF.map(w => `<option value="${w}"${e.assignee === w ? ' selected' : ''}>${w}</option>`).join('')}
        </select>
        <button class="d2-btn ghost sm enq-reply" data-id="${e.id}">${enqReplyOpen === String(e.id) ? 'Close reply' : 'Reply'}</button>
        ${e.handled_at ? '<span class="d2-tag">Handled</span>' : `<button class="d2-btn ghost sm enq-done" data-id="${e.id}">Mark handled</button>`}
      </div>
      ${enqReplyOpen === String(e.id) ? `
      <form class="d2-enq-form" data-id="${e.id}">
        <textarea class="d2-input" name="body" rows="4" required maxlength="4000" placeholder="Hi ${esc(e.name.split(' ')[0])}, thanks for getting in touch…"></textarea>
        <div class="d2-form-row">
          <select class="d2-input" name="sender" required style="max-width:130px">
            ${ENQ_STAFF.map(w => `<option value="${w}"${e.assignee === w ? ' selected' : ''}>${w}</option>`).join('')}
          </select>
          <button class="d2-btn primary sm" type="submit">Send email</button>
          <span class="d2-sub" style="margin:0">Sends from the Padel Power inbox via Outlook.</span>
        </div>
      </form>` : ''}
    </div>`).join('') : '<p class="d2-empty">No enquiries here.</p>';

  $('enqList').querySelectorAll('.enq-done').forEach(b =>
    b.addEventListener('click', async () => {
      try {
        await ppApi(`enquiries?id=eq.${b.dataset.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ handled_at: new Date().toISOString() }) });
        await loadEnquiries();
      } catch { alert('Could not update that enquiry.'); }
      renderEnquiries();
    }));
  $('enqList').querySelectorAll('.enq-assign').forEach(sel =>
    sel.addEventListener('change', async () => {
      try {
        await ppApi(`enquiries?id=eq.${sel.dataset.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ assignee: sel.value || null }) });
        const row = enqRows.find(e => String(e.id) === sel.dataset.id);
        if (row) row.assignee = sel.value || null;
      } catch { alert('Could not assign the enquiry. Has the database migration been run?'); }
      renderEnquiries();
    }));
  $('enqList').querySelectorAll('.enq-reply').forEach(b =>
    b.addEventListener('click', () => {
      enqReplyOpen = enqReplyOpen === b.dataset.id ? null : b.dataset.id;
      renderEnquiries();
      const f = $('enqList').querySelector('.d2-enq-form textarea');
      if (f) f.focus();
    }));
  $('enqList').querySelectorAll('.d2-enq-form').forEach(f =>
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (!PP_MAKE_WEBHOOK) { alert('Email sending is not wired up yet: the Make webhook URL needs adding first.'); return; }
      const e = enqRows.find(x => String(x.id) === f.dataset.id);
      const body = f.body.value.trim();
      const sender = f.sender.value;
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const res = await fetch(PP_MAKE_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'enquiry_reply',
            to_email: e.email,
            to_name: e.name,
            subject: `Re: your ${(e.topic || 'enquiry').toLowerCase()} enquiry — Padel Power`,
            body,
            sent_by: sender,
          }),
        });
        if (!res.ok) throw new Error('webhook_failed');
        const replies = [...(e.replies || []), { body, by: sender, at: new Date().toISOString() }];
        await ppApi(`enquiries?id=eq.${e.id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ replies, handled_at: e.handled_at || new Date().toISOString() }),
        });
        e.replies = replies;
        e.handled_at = e.handled_at || new Date().toISOString();
        enqReplyOpen = null;
        await loadEnquiries();
      } catch {
        alert('Could not send the reply. Please try again.');
        btn.disabled = false;
        return;
      }
      renderEnquiries();
    }));
}
$('enqAssignFilter').querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => {
    enqWho = b.dataset.who;
    $('enqAssignFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderEnquiries();
  }));
$('enqFilter').querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => {
    enqState = b.dataset.state;
    $('enqFilter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderEnquiries();
  }));

/* ============================================================
   REPORTS — occupancy + revenue vs instructor cost
   ============================================================ */
let rptDays = 30, rptLoaded = false;
const DEFAULT_RATE = 4000; // pence per hour when an instructor isn't matched

// past cancelled/custom rows aren't loaded at boot (ppInit only fetches from
// today), so pull the last 60 days into the same caches once
async function loadReportRange() {
  if (rptLoaded) return; rptLoaded = true;
  const from = iso(addDays(startOfToday(), -60));
  const today = iso(startOfToday());
  try {
    const [customPast, cancelledPast] = await Promise.all([
      ppApi(`custom_classes?class_date=lt.${today}&class_date=gte.${from}&select=*`),
      ppApi(`cancelled_classes?class_date=lt.${today}&class_date=gte.${from}&select=*`),
    ]);
    customPast.forEach(c => { (cache.custom[c.class_date] = cache.custom[c.class_date] || []).push({ time: c.start_time, type: c.type_key, instructor: c.instructor || null, id: c.id }); });
    cancelledPast.forEach(c => { (cache.cancelled[c.class_date] = cache.cancelled[c.class_date] || new Set()).add(c.start_time); });
  } catch {}
}

function reportOccurrences() {
  const now = new Date();
  const upcoming = rptDays < 0;
  const dates = upcoming
    ? Array.from({ length: -rptDays }, (_, i) => addDays(startOfToday(), i))
    : Array.from({ length: rptDays }, (_, i) => addDays(startOfToday(), i - rptDays + 1));
  const list = [];
  dates.forEach(d => {
    classesFor(d, true).forEach(c => {
      const info = classInfo(d, c);
      const started = classStart(info.id) < now;
      if (upcoming ? started : !started) return;
      list.push(info);
    });
  });
  return list;
}

function classMoney(c) {
  const paid = Store.attendees(c.id).filter(p => p.paid && !p.refunded);
  const revenue = paid.reduce((n, p) => n + (p.amount || 0), 0);
  const cost = c.cancelled ? 0 : (Instructors.byName(c.instructor)?.rate ?? DEFAULT_RATE);
  return { revenue, cost, profit: revenue - cost };
}

async function renderReports() {
  await loadReportRange();
  const all = reportOccurrences();
  const occ = all.filter(c => !c.cancelled);
  const upcoming = rptDays < 0;

  const beds = occ.length * RULES.maxRiders;
  const booked = occ.reduce((n, c) => n + c.count, 0);
  const fill = beds ? Math.round(booked / beds * 100) : 0;
  const money = occ.map(classMoney);
  const revenue = money.reduce((n, m) => n + m.revenue, 0);
  const cost = money.reduce((n, m) => n + m.cost, 0);

  $('rptStats').innerHTML = [
    { n: occ.length, l: upcoming ? 'Classes scheduled' : 'Classes run' },
    { n: `${booked}/${beds}`, l: 'Beds filled', bar: fill },
    { n: fill + '%', l: 'Occupancy' },
    { n: gbp(revenue), l: 'Online revenue' },
    { n: (revenue - cost < 0 ? '−' : '') + gbp(Math.abs(revenue - cost)), l: `Profit after £${cost / 100} instructor cost`, warn: revenue - cost < 0 },
  ].map(k => `
    <div class="d2-stat ${k.warn ? 'warn' : ''}">
      <b>${k.n}</b><span>${k.l}</span>
      ${k.bar != null ? `<div class="d2-mini"><i style="width:${k.bar}%"></i></div>` : ''}
    </div>`).join('');

  // occupancy by class type
  const byType = {};
  occ.forEach(c => {
    const t = byType[c.type] = byType[c.type] || { name: c.t.name, classes: 0, booked: 0 };
    t.classes++; t.booked += c.count;
  });
  const types = Object.values(byType).sort((a, b) => b.classes - a.classes);
  $('rptTypes').innerHTML = types.length ? types.map(t => {
    const pct = Math.round(t.booked / (t.classes * RULES.maxRiders) * 100);
    return `
    <div class="d2-rpt-row">
      <span class="nm">${esc(t.name)}</span>
      <span class="d2-bar"><i class="${pct >= 60 ? 'on' : pct >= 35 ? 'risk' : 'needs'}" style="width:${pct}%"></i></span>
      <span class="pc">${pct}%</span>
      <span class="ct">${t.booked}/${t.classes * RULES.maxRiders} beds · ${t.classes} class${t.classes === 1 ? '' : 'es'}</span>
    </div>`;
  }).join('') : '<p class="d2-empty">No classes in this period.</p>';

  // per instructor
  const byInstr = {};
  occ.forEach(c => {
    const key = c.instructor || 'Unassigned';
    const m = classMoney(c);
    const row = byInstr[key] = byInstr[key] || { classes: 0, booked: 0, revenue: 0, cost: 0 };
    row.classes++; row.booked += c.count; row.revenue += m.revenue; row.cost += m.cost;
  });
  const instrs = Object.entries(byInstr).sort((a, b) => b[1].classes - a[1].classes);
  $('rptInstr').innerHTML = instrs.length ? `
    <table class="d2-table">
      <thead><tr><th>Instructor</th><th>Classes</th><th>Beds</th><th>Revenue</th><th>Cost</th><th>Profit</th></tr></thead>
      <tbody>${instrs.map(([name, r]) => `
        <tr>
          <td class="nm">${esc(name)}</td>
          <td>${r.classes}</td>
          <td>${r.booked}/${r.classes * RULES.maxRiders}</td>
          <td>${gbp(r.revenue)}</td>
          <td>${gbp(r.cost)}</td>
          <td>${r.revenue - r.cost < 0 ? '−' + gbp(r.cost - r.revenue) : gbp(r.revenue - r.cost)}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<p class="d2-empty">No classes in this period.</p>';

  // class by class
  const rows = [...occ].sort((a, b) => upcoming
    ? classStart(a.id) - classStart(b.id)
    : classStart(b.id) - classStart(a.id));
  $('rptTable').querySelector('tbody').innerHTML = rows.map(c => {
    const m = classMoney(c);
    return `
    <tr>
      <td class="ct">${fmtDay.format(c.date)} ${fmtDate.format(c.date)} · ${c.time}</td>
      <td>${esc(c.t.name)}</td>
      <td class="ct">${esc(c.instructor || '')}</td>
      <td>${c.count}/${RULES.maxRiders}</td>
      <td>${gbp(m.revenue)}</td>
      <td>${gbp(m.cost)}</td>
      <td>${m.profit < 0 ? '−' + gbp(-m.profit) : gbp(m.profit)}</td>
    </tr>`;
  }).join('');
  $('rptEmpty').hidden = rows.length > 0;
  $('rptTable').querySelector('thead').style.display = rows.length ? '' : 'none';
}
$('rptRange').querySelectorAll('button').forEach(b =>
  b.addEventListener('click', () => {
    rptDays = +b.dataset.days;
    $('rptRange').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderReports();
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
      ${t.custom && isAdmin() ? `<button class="d2-btn danger sm tp-del" data-key="${k}">Delete</button>` : t.custom ? '' : '<span class="core">Core class</span>'}
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
  $('newType').hidden = !isAdmin();
  renderInstructors();
  renderTimetableEditor();
}

/* --- instructors --- */
function renderInstructors() {
  if (!isAdmin()) { $('instrCard').hidden = true; return; }
  $('instrList').innerHTML = INSTRUCTORS.length ? INSTRUCTORS.map(i => `
    <div class="d2-att ${i.active ? '' : 'off'}" style="${i.active ? '' : 'opacity:.5'}">
      <div>
        <b>${esc(i.name)}</b>
        <span>${esc([i.email, i.phone].filter(Boolean).join(' · ') || 'No contact details')} · £${(i.rate / 100)}/h</span>
      </div>
      <button class="d2-btn ghost sm in-edit" data-id="${i.id}">Edit</button>
      <button class="d2-btn ${i.active ? 'danger' : 'primary'} sm in-toggle" data-id="${i.id}">${i.active ? 'Deactivate' : 'Reactivate'}</button>
    </div>`).join('') : '<p class="d2-empty">No instructors yet. Add the first one below.</p>';
  $('instrList').querySelectorAll('.in-toggle').forEach(b =>
    b.addEventListener('click', async () => {
      const i = INSTRUCTORS.find(x => x.id === b.dataset.id);
      try { await Instructors.update(i.id, { active: !i.active }); } catch { alert('Could not update the instructor.'); }
      renderInstructors();
    }));
  $('instrList').querySelectorAll('.in-edit').forEach(b =>
    b.addEventListener('click', async () => {
      const i = INSTRUCTORS.find(x => x.id === b.dataset.id);
      const email = prompt('Email for ' + i.name + ':', i.email); if (email === null) return;
      const phone = prompt('Mobile for ' + i.name + ':', i.phone); if (phone === null) return;
      const rate = prompt('Hourly rate (£) for ' + i.name + ':', String(i.rate / 100)); if (rate === null) return;
      const pence = Math.round(parseFloat(rate) * 100);
      if (!isFinite(pence) || pence < 0 || pence > 50000) { alert('Enter a rate between £0 and £500.'); return; }
      try { await Instructors.update(i.id, { email: email.trim() || null, phone: phone.trim() || null, hourly_rate_pence: pence }); }
      catch { alert('Could not update the instructor.'); }
      renderInstructors();
    }));
}
$('newInstr').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const pence = Math.round(parseFloat(f.niRate.value) * 100);
  if (!isFinite(pence) || pence < 0 || pence > 50000) { alert('Enter an hourly rate between £0 and £500.'); return; }
  const name = f.niName.value.trim();
  if (INSTRUCTORS.some(i => i.name.toLowerCase() === name.toLowerCase())) { alert('An instructor with that name already exists.'); return; }
  try {
    await Instructors.add({ name, email: f.niEmail.value.trim(), phone: f.niPhone.value.trim(), rate: pence });
    f.reset(); f.niRate.value = '40';
  } catch (err) {
    alert(String(err.message).includes('does not exist')
      ? 'The instructors table is not set up yet. Run the database migration first.'
      : 'Could not add the instructor. Please try again.');
  }
  renderInstructors();
});

/* --- weekly timetable editor --- */
const TT_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TT_ORDER = [1, 2, 3, 4, 5, 6, 0];
function renderTimetableEditor() {
  if (!isAdmin()) {
    // instructors see the timetable but can't change it
    $('ttEditor').innerHTML = TT_ORDER.map(wd => `
      <div class="day">
        <h3>${TT_DAYS[wd]}</h3>
        ${(TIMETABLE[wd] || []).map(([time, , instr]) => `
          <div class="slot"><b style="font-family:var(--mono)">${time}</b><span>${esc(instr || 'No instructor')}</span></div>`).join('') || '<p class="d2-empty">No classes.</p>'}
      </div>`).join('');
    return;
  }
  $('ttEditor').innerHTML = TT_ORDER.map(wd => `
    <div class="day">
      <h3>${TT_DAYS[wd]}</h3>
      ${(TIMETABLE[wd] || []).map(([time, type, instr, id]) => `
        <div class="slot" data-id="${id}" data-wd="${wd}" data-orig="${time}">
          <input class="d2-input tt-time" type="time" value="${time}" required>
          <select class="d2-input tt-instr">${instrOptions(instr || '')}</select>
          <div class="row">
            <button class="d2-btn ghost sm tt-save" type="button">Save</button>
            <button class="d2-btn danger sm tt-del" type="button">Remove</button>
          </div>
        </div>`).join('')}
      <div class="slot add" data-wd="${wd}">
        <input class="d2-input tt-ntime" type="time">
        <select class="d2-input tt-ninstr">${instrOptions('')}</select>
        <div class="row"><button class="d2-btn primary sm tt-add" type="button">+ Add class</button></div>
      </div>
    </div>`).join('');

  $('ttEditor').querySelectorAll('.tt-add').forEach(b => b.addEventListener('click', async () => {
    const box = b.closest('.slot'), wd = +box.dataset.wd;
    const time = box.querySelector('.tt-ntime').value;
    const instr = box.querySelector('.tt-ninstr').value.trim();
    if (!time) { alert('Pick a start time.'); return; }
    if ((TIMETABLE[wd] || []).some(s => s[0] === time)) {
      alert(`There is already a class at ${time} on ${TT_DAYS[wd]}.`); return;
    }
    try { await Settings.addTimetableSlot(wd, time, Object.keys(CLASS_TYPES)[0], instr); }
    catch { alert('Could not add the class. Please try again.'); }
    renderTimetableEditor();
  }));

  $('ttEditor').querySelectorAll('.tt-save').forEach(b => b.addEventListener('click', async () => {
    const box = b.closest('.slot'), wd = +box.dataset.wd, id = +box.dataset.id;
    const time = box.querySelector('.tt-time').value;
    const instr = box.querySelector('.tt-instr').value.trim();
    if (!time) { alert('Pick a start time.'); return; }
    if (time !== box.dataset.orig) {
      if ((TIMETABLE[wd] || []).some(s => s[0] === time && s[3] !== id)) {
        alert(`There is already a class at ${time} on ${TT_DAYS[wd]}.`); return;
      }
      if (!confirm(`Move the ${TT_DAYS[wd]} ${box.dataset.orig} class to ${time} every week from now on?\n\nMembers already booked onto upcoming dates are moved with the class and get a text about the change.`)) return;
    }
    try {
      await Settings.moveTemplateSlot(id, time, instr);
      const slot = (TIMETABLE[wd] || []).find(s => s[3] === id);
      if (slot) { slot[0] = time; slot[2] = instr || null; TIMETABLE[wd].sort((a, b) => a[0].localeCompare(b[0])); }
      await Store.loadBookings().catch(() => {});
    } catch (err) {
      alert(String(err.message).includes('slot_taken')
        ? `There is already a class at ${time} on ${TT_DAYS[wd]}.`
        : 'Could not save the change. Please try again.');
    }
    renderTimetableEditor();
  }));

  $('ttEditor').querySelectorAll('.tt-del').forEach(b => b.addEventListener('click', async () => {
    const box = b.closest('.slot'), wd = +box.dataset.wd, id = +box.dataset.id;
    if (!confirm(`Remove the ${TT_DAYS[wd]} ${box.dataset.orig} class from every week?\n\nBookings already made for upcoming dates are NOT cancelled or notified. Cancel those classes from the Schedule first if anyone is booked.`)) return;
    try { await Settings.removeTimetableSlot(id, wd); }
    catch { alert('Could not remove the class. Please try again.'); }
    renderTimetableEditor();
  }));
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

/* --- move / edit class drawer --- */
let mvClassInfo = null;
function openMove(c) {
  mvClassInfo = c;
  $('mvClass').textContent = c.t.name;
  $('mvWhen').textContent = `${fmtFull.format(c.date)} · ${c.time}${c.instructor ? ' · ' + c.instructor : ''}`;
  $('mvTime').value = c.time;
  $('mvInstr').innerHTML = instrOptions(c.instructor || '');
  // custom one-offs have no recurring series to apply to
  $('mvScope').style.display = c.custom ? 'none' : '';
  $('mvAllLabel').textContent = `All future ${fmtDay.format(c.date)} ${c.time} classes`;
  $('mvForm').mvScopeR.value = 'one';
  $('mvHint').textContent = 'Members already booked are moved with the class and get a text about the change.';
  openDrawer('mvDrawer');
}
$('mvClose').addEventListener('click', closeDrawers);
$('mvForm').addEventListener('submit', async e => {
  e.preventDefault();
  const c = mvClassInfo;
  const newTime = $('mvTime').value;
  const instr = $('mvInstr').value.trim();
  const scope = c.custom ? 'one' : e.target.mvScopeR.value;
  const btn = e.target.querySelector('button[type=submit]');
  if (newTime === c.time && (instr || '') === (c.instructor || '')) { closeDrawers(); return; }
  btn.disabled = true;
  try {
    if (scope === 'all') {
      const slot = (TIMETABLE[c.date.getDay()] || []).find(s => s[0] === c.time);
      if (!slot) throw new Error('no_such_class');
      await Settings.moveTemplateSlot(slot[3], newTime, instr);
    } else {
      await Settings.moveOccurrence(iso(c.date), c.time, newTime, instr);
    }
  } catch (err) {
    btn.disabled = false;
    const msg = String(err.message);
    alert(msg.includes('slot_taken')
      ? 'There is already a class at that time. Pick a different time.'
      : 'Could not move the class. Please try again.');
    return;
  }
  // bookings, custom classes and cancellations all changed server-side: reload clean
  location.href = location.pathname + '?page=schedule';
});

/* --- add class drawer --- */
function renderTypeOptions() {
  $('clType').innerHTML = Object.entries(CLASS_TYPES).map(([k, t]) => `<option value="${k}">${esc(t.name)} (${esc(t.level)})</option>`).join('');
}
$('addClassBtn').addEventListener('click', () => {
  renderTypeOptions();
  $('clDate').innerHTML = weekDates().map(d =>
    `<option value="${iso(d)}">${fmtFull.format(d)}</option>`).join('');
  $('clForm').reset();
  $('clInstructor').innerHTML = instrOptions('');
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
    await Promise.all([Instructors.load().catch(() => {}), loadStaffRole()]);
    applyRole();
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
