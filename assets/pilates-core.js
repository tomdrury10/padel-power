/* ============================================================
   Padel Power · Reformer Pilates — shared config + booking store
   ------------------------------------------------------------
   Loaded by pilates.html, book.html and admin.html.
   Backed by Supabase (project: Padel Power). The weekly
   timetable, class types, studio rules, staff-added classes
   and all bookings live in the database, so every device sees
   the same data. Pages must wait for `ppReady` before rendering.
   ============================================================ */

const PP_URL = 'https://bejshhlkatpjcydlokfk.supabase.co';
const PP_API = `${PP_URL}/rest/v1`;
const PP_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlanNoaGxrYXRwamN5ZGxva2ZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwNzYxOTYsImV4cCI6MjEwMjY1MjE5Nn0.EQghTZaE2bLdOb7w1Ashg4o493iNiieyfJdF1xmN2qQ';

/* ---------- staff auth (Supabase Auth, email + password) ---------- */
const Auth = {
  key: 'pp-staff-session',
  session() { try { return JSON.parse(localStorage.getItem(this.key)); } catch { return null; } },
  email() { return this.session()?.email || null; },
  token() {
    const s = this.session();
    return s && s.expires_at > Date.now() / 1000 + 30 ? s.access_token : null;
  },
  save(data) {
    localStorage.setItem(this.key, JSON.stringify({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      email: data.user?.email || this.email(),
    }));
  },
  async signIn(email, password) {
    const res = await fetch(`${PP_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: PP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign in failed');
    this.save(data);
    return data;
  },
  async refresh() {
    const s = this.session();
    if (!s?.refresh_token) return null;
    const res = await fetch(`${PP_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: PP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!res.ok) { this.signOut(); return null; }
    const data = await res.json();
    this.save(data);
    return data.access_token;
  },
  // valid token, refreshing if it has expired
  async ensure() { return this.token() || await this.refresh(); },
  signOut() { localStorage.removeItem(this.key); },
};

async function ppApi(path, opts = {}) {
  const staff = Auth.token();
  const res = await fetch(`${PP_API}/${path}`, {
    ...opts,
    headers: {
      apikey: PP_KEY,
      Authorization: `Bearer ${staff || PP_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const body = await res.text();          // minimal-return writes come back empty
  if (!res.ok) {
    let msg = 'request_failed';
    try { msg = JSON.parse(body).message || msg; } catch {}
    throw new Error(msg);
  }
  return body ? JSON.parse(body) : null;
}

/* ---------- live config (filled from the database) ---------- */
const RULES = {
  openingDate: '2026-09-01',
  cutoffHours: 24,
  minRiders: 3,
  maxRiders: 8,
  windowDays: 14,
};
const CLASS_TYPES = {};   // key -> { name, level, desc, custom }
const TIMETABLE = {};     // weekday -> [[time, typeKey], ...]

const cache = {
  custom: {},    // dateIso -> [{ time, type, id }]
  cancelled: {}, // dateIso -> Set of times cancelled by staff
  counts: {},    // classId -> active booking count
  bookings: [],  // full rows (staff dashboard only)
};

/* ---------- date helpers ---------- */
const fmtDay  = new Intl.DateTimeFormat('en-GB', { weekday: 'short' });
const fmtDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const fmtFull = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function bookableDates() {
  const out = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const opening = new Date(RULES.openingDate + 'T00:00:00');
  let start = today > opening ? today : opening;
  for (let i = 0; i < RULES.windowDays; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    out.push(d);
  }
  return out;
}

// scheduled classes for a date: weekly template + staff-added one-offs.
// Cancelled occurrences are hidden from the public; pass true to keep them
// (the dashboard shows them greyed out so staff can restore).
function classesFor(d, includeCancelled = false) {
  const opening = new Date(RULES.openingDate + 'T00:00:00');
  const base = d < opening ? [] : (TIMETABLE[d.getDay()] || []);
  const extra = cache.custom[iso(d)] || [];
  const off = cache.cancelled[iso(d)] || new Set();
  const all = [
    ...base.map(([time, type]) => ({ time, type, custom: false })),
    ...extra.map(c => ({ time: c.time, type: c.type, custom: true })),
  ].sort((a, b) => a.time.localeCompare(b.time));
  const seen = new Set();
  return all
    .filter(c => CLASS_TYPES[c.type] && !seen.has(c.time) && seen.add(c.time))
    .map(c => ({ ...c, cancelled: off.has(c.time) }))
    .filter(c => includeCancelled || !c.cancelled);
}

function classStart(classId) {
  const [date, time] = classId.split('_');
  return new Date(`${date}T${time}:00`);
}
const withinCutoff = classId => (classStart(classId) - new Date()) < RULES.cutoffHours * 3600 * 1000;

/* ---------- my bookings (this device, for the Booked tick) ---------- */
const My = {
  key: 'pp-my-bookings',
  all() { try { return JSON.parse(localStorage.getItem(this.key)) || []; } catch { return []; } },
  add(classId) { const a = this.all(); if (!a.includes(classId)) { a.push(classId); localStorage.setItem(this.key, JSON.stringify(a)); } },
  has(classId) { return this.all().includes(classId); },
};

/* ---------- store ---------- */
const Store = {
  count(classId) { return Math.min(RULES.maxRiders, cache.counts[classId] || 0); },
  attendees(classId) { return cache.bookings.filter(b => b.classId === classId); },
  mine(classId) { return My.has(classId); },

  async book(classId, person) {
    const staff = !!Auth.token();
    const rows = await ppApi('bookings', {
      method: 'POST',
      // the public may write bookings but never read them back
      headers: staff ? {} : { Prefer: 'return=minimal' },
      body: JSON.stringify({
        class_id: classId,
        name: person.name,
        email: person.email || '',
        phone: person.phone,
        source: person.source || 'Online',
      }),
    });
    cache.counts[classId] = (cache.counts[classId] || 0) + 1;
    if (staff && rows?.[0]) cache.bookings.push(mapBooking(rows[0]));
    if (!person.source || person.source === 'Online') My.add(classId);
    return { ok: true };
  },

  async cancel(classId, booking) {
    await ppApi(`bookings?id=eq.${booking.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ cancelled_at: new Date().toISOString() }),
    });
    cache.counts[classId] = Math.max(0, (cache.counts[classId] || 0) - 1);
    cache.bookings = cache.bookings.filter(b => b.id !== booking.id);
    return { ok: true };
  },

  // cancel a whole class occurrence and every booking on it
  async cancelClass(dateIso, time, opts = {}) {
    const classId = `${dateIso}_${time}`;
    await ppApi(`bookings?class_id=eq.${classId}&cancelled_at=is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ cancelled_at: new Date().toISOString() }),
    });
    if (opts.custom) {
      await this.removeClass(dateIso, time);
    } else {
      await ppApi('cancelled_classes', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ class_date: dateIso, start_time: time, reason: opts.reason || '' }),
      });
      (cache.cancelled[dateIso] = cache.cancelled[dateIso] || new Set()).add(time);
    }
    cache.counts[classId] = 0;
    cache.bookings = cache.bookings.filter(b => b.classId !== classId);
    return { ok: true };
  },

  async restoreClass(dateIso, time) {
    await ppApi(`cancelled_classes?class_date=eq.${dateIso}&start_time=eq.${encodeURIComponent(time)}`, { method: 'DELETE' });
    cache.cancelled[dateIso]?.delete(time);
    return { ok: true };
  },

  async addClass(dateIso, time, type) {
    const [row] = await ppApi('custom_classes', {
      method: 'POST',
      body: JSON.stringify({ class_date: dateIso, start_time: time, type_key: type }),
    });
    (cache.custom[dateIso] = cache.custom[dateIso] || []).push({ time, type, id: row.id });
    cache.custom[dateIso].sort((a, b) => a.time.localeCompare(b.time));
    return { ok: true };
  },

  async removeClass(dateIso, time) {
    await ppApi(`custom_classes?class_date=eq.${dateIso}&start_time=eq.${encodeURIComponent(time)}`, { method: 'DELETE' });
    cache.custom[dateIso] = (cache.custom[dateIso] || []).filter(c => c.time !== time);
    if (!cache.custom[dateIso].length) delete cache.custom[dateIso];
    return { ok: true };
  },

  // staff dashboard: load every active booking (names + contacts)
  async loadBookings() {
    const rows = await ppApi('bookings?cancelled_at=is.null&order=created_at.asc&select=*');
    cache.bookings = rows.map(mapBooking);
    const counts = {};
    cache.bookings.forEach(b => { counts[b.classId] = (counts[b.classId] || 0) + 1; });
    cache.counts = counts;
  },

  async refreshCounts() {
    const rows = await ppApi('booking_counts?select=*');
    const counts = {};
    rows.forEach(r => { counts[r.class_id] = r.booked; });
    cache.counts = counts;
  },
};

function mapBooking(r) {
  return {
    id: r.id, classId: r.class_id, name: r.name, email: r.email,
    phone: r.phone, source: r.source, at: Date.parse(r.created_at),
  };
}

/* ---------- staff settings ---------- */
const Settings = {
  async saveRules(rules) {
    await ppApi('settings?id=eq.1', {
      method: 'PATCH',
      body: JSON.stringify({
        max_riders: rules.maxRiders, min_riders: rules.minRiders,
        cutoff_hours: rules.cutoffHours, window_days: rules.windowDays,
      }),
    });
    Object.assign(RULES, rules);
  },
  async addType(key, type) {
    await ppApi('class_types', {
      method: 'POST',
      body: JSON.stringify({ key, name: type.name, level: type.level, descr: type.desc, custom: true }),
    });
    CLASS_TYPES[key] = { ...type, custom: true };
  },
  async removeType(key) {
    await ppApi(`class_types?key=eq.${encodeURIComponent(key)}&custom=eq.true`, { method: 'DELETE' });
    delete CLASS_TYPES[key];
    Object.keys(cache.custom).forEach(d => {
      cache.custom[d] = cache.custom[d].filter(c => c.type !== key);
      if (!cache.custom[d].length) delete cache.custom[d];
    });
  },
};

/* ---------- boot: load everything the pages need ---------- */
async function ppInit() {
  const today = iso(new Date());
  if (Auth.session()) await Auth.ensure();   // keep staff signed in across reloads
  const [types, slots, custom, cancelled, settings, counts] = await Promise.all([
    ppApi('class_types?select=*'),
    ppApi('timetable?select=weekday,start_time,type_key'),
    ppApi(`custom_classes?class_date=gte.${today}&select=*`),
    ppApi(`cancelled_classes?class_date=gte.${today}&select=*`),
    ppApi('settings?id=eq.1&select=*'),
    ppApi('booking_counts?select=*'),
  ]);
  cancelled.forEach(c => { (cache.cancelled[c.class_date] = cache.cancelled[c.class_date] || new Set()).add(c.start_time); });
  types.forEach(t => { CLASS_TYPES[t.key] = { name: t.name, level: t.level, desc: t.descr, custom: t.custom }; });
  slots.forEach(s => { (TIMETABLE[s.weekday] = TIMETABLE[s.weekday] || []).push([s.start_time, s.type_key]); });
  Object.values(TIMETABLE).forEach(day => day.sort((a, b) => a[0].localeCompare(b[0])));
  custom.forEach(c => { (cache.custom[c.class_date] = cache.custom[c.class_date] || []).push({ time: c.start_time, type: c.type_key, id: c.id }); });
  if (settings[0]) {
    const s = settings[0];
    Object.assign(RULES, {
      maxRiders: s.max_riders, minRiders: s.min_riders,
      cutoffHours: s.cutoff_hours, windowDays: s.window_days,
      openingDate: s.opening_date,
    });
  }
  counts.forEach(r => { cache.counts[r.class_id] = r.booked; });
}

const ppReady = ppInit();
