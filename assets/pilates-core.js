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

/* ---------- auth (Supabase Auth, email + password) ----------
   One session store for everyone: staff (admin / instructor) and members.
   What a session can DO is decided by the role row server-side (RLS);
   PP_ROLE mirrors it for the UI once loadRole() has run. */
const Auth = {
  key: 'pp-session',
  legacyKey: 'pp-staff-session',
  session() {
    try {
      const s = JSON.parse(localStorage.getItem(this.key));
      if (s) return s;
      // staff signed in before accounts existed: carry the session over
      const old = JSON.parse(localStorage.getItem(this.legacyKey));
      if (old) { localStorage.setItem(this.key, JSON.stringify(old)); localStorage.removeItem(this.legacyKey); }
      return old;
    } catch { return null; }
  },
  email() { return this.session()?.email || null; },
  userId() { return this.session()?.user_id || null; },
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
      user_id: data.user?.id || this.userId(),
    }));
  },
  // create a member account. Name and phone travel as signup metadata and
  // become the profile row server-side. If email confirmation is on, no
  // session comes back until they click the link: returns { confirm: true }.
  async signUp(email, password, profile) {
    const res = await fetch(`${PP_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: PP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, password,
        data: { full_name: profile.name, phone: profile.phone },
        options: { email_redirect_to: PP_SITE + '/account/' },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || data.error || 'Sign up failed');
    if (data.access_token) { this.save(data); return { confirm: false }; }
    // a repeat signup for an existing address returns a fake user with no identities
    if (Array.isArray(data.identities) && !data.identities.length) throw new Error('already_registered');
    return { confirm: true };
  },
  async requestPasswordReset(email) {
    const res = await fetch(`${PP_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: { apikey: PP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, options: { email_redirect_to: PP_SITE + '/account/' } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error_description || data.msg || 'reset_failed');
    }
    return true;
  },
  // arriving from a recovery / confirmation email: the tokens are in the URL hash
  adoptHashSession() {
    const h = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (!h.get('access_token')) return null;
    this.save({
      access_token: h.get('access_token'),
      refresh_token: h.get('refresh_token'),
      expires_in: +h.get('expires_in') || 3600,
      user: {},
    });
    history.replaceState(null, '', location.pathname + location.search);
    return h.get('type') || 'session';
  },
  // set a new password with the current (recovery) session
  async setPassword(next) {
    const token = await this.ensure();
    if (!token) throw new Error('signed_out');
    const res = await fetch(`${PP_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey: PP_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: next }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error_description || data.msg || 'update_failed');
    }
    return true;
  },
  // who the token belongs to (fills email / id after a hash session)
  async loadUser() {
    const token = await this.ensure();
    if (!token) return null;
    const res = await fetch(`${PP_URL}/auth/v1/user`, { headers: { apikey: PP_KEY, Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const u = await res.json();
    const s = this.session();
    if (s) { s.email = u.email; s.user_id = u.id; localStorage.setItem(this.key, JSON.stringify(s)); }
    return u;
  },
  isStaff() { return PP_ROLE === 'admin' || PP_ROLE === 'instructor'; },
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
  // change the signed-in user's password. Proves the current password
  // first (fresh sign-in), then updates it on the auth server.
  async changePassword(current, next) {
    const check = await fetch(`${PP_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: PP_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.email(), password: current }),
    });
    const session = await check.json();
    if (!check.ok) throw new Error('wrong_password');
    this.save(session);
    const res = await fetch(`${PP_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey: PP_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: next }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error_description || data.msg || 'update_failed');
    }
    return true;
  },
  signOut() {
    localStorage.removeItem(this.key);
    localStorage.removeItem(this.legacyKey);
    PP_ROLE = null;
    Member.reset();
  },
};

const PP_SITE = location.hostname === 'localhost' ? location.origin : 'https://www.padelpower.uk';

async function ppApi(path, opts = {}) {
  const token = Auth.token();   // staff or member; RLS decides what it may see
  const res = await fetch(`${PP_API}/${path}`, {
    ...opts,
    headers: {
      apikey: PP_KEY,
      Authorization: `Bearer ${token || PP_KEY}`,
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

// edge functions (Stripe checkout, refunds)
async function ppFn(path, opts = {}) {
  const token = Auth.token();
  const res = await fetch(`${PP_URL}/functions/v1/${path}`, {
    ...opts,
    headers: {
      apikey: PP_KEY,
      Authorization: `Bearer ${token || PP_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'request_failed');
  return data;
}

/* ---------- live config (filled from the database) ---------- */
const RULES = {
  openingDate: '2026-09-01',
  cutoffHours: 24,
  minRiders: 3,
  maxRiders: 8,
  windowDays: 14,
  packCredits: 6,
  packPrice: 10000,     // pence
  packMonths: 3,
  requirePhone: false,  // master switch; off until ClickSend is wired up
  codeMinutes: 10,
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
  // custom entries first: a one-off at the same time overrides the template slot
  const all = [
    ...extra.map(c => ({ time: c.time, type: c.type, instructor: c.instructor || null, custom: true })),
    ...base.map(([time, type, instructor]) => ({ time, type, instructor: instructor || null, custom: false })),
  ].sort((a, b) => a.time.localeCompare(b.time) || (a.custom ? -1 : 1));
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

/* ---------- my bookings (this device, fallback for the Booked tick) ---------- */
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
  mine(classId) { return Member.has(classId) || (!Auth.userId() && My.has(classId)); },

  // free class: a signed-in member books directly (the server stamps the
  // booking with their account), staff book on a member's behalf
  async book(classId, person) {
    const staff = Auth.isStaff();
    const rows = await ppApi('bookings', {
      method: 'POST',
      headers: staff ? {} : { Prefer: 'return=minimal' },
      body: JSON.stringify({
        class_id: classId,
        name: person.name,
        email: person.email || '',
        phone: person.phone,
        source: person.source || 'Online',
        user_id: staff ? (person.userId || null) : Auth.userId(),
      }),
    });
    cache.counts[classId] = (cache.counts[classId] || 0) + 1;
    if (staff && rows?.[0]) cache.bookings.push(mapBooking(rows[0]));
    if (!staff) { My.add(classId); await Member.load().catch(() => {}); }
    return { ok: true };
  },

  // member: spend one class credit
  async bookWithCredit(classId) {
    const r = await ppApi('rpc/book_with_credit', { method: 'POST', body: JSON.stringify({ p_class_id: classId }) });
    cache.counts[classId] = (cache.counts[classId] || 0) + 1;
    await Member.load().catch(() => {});
    return r;
  },

  // paid booking: create a Stripe Checkout session and hand back its URL.
  // The account behind the token supplies the name, email and phone.
  async checkout(classId) {
    return ppFn('checkout', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'class',
        class_id: classId,
        return_url: location.origin + location.pathname + location.search,
      }),
    });
  },
  async buyPack(returnUrl) {
    return ppFn('checkout', {
      method: 'POST',
      body: JSON.stringify({ kind: 'pack', return_url: returnUrl || (location.origin + location.pathname) }),
    });
  },
  async checkoutStatus(sessionId) {
    return ppFn(`checkout?session=${encodeURIComponent(sessionId)}`);
  },
  // member: mobile verification by SMS code
  phoneState() { return ppFn('verify-phone'); },
  sendCode() { return ppFn('verify-phone', { method: 'POST', body: JSON.stringify({ action: 'send' }) }); },
  async checkCode(code) {
    const r = await ppFn('verify-phone', { method: 'POST', body: JSON.stringify({ action: 'check', code }) });
    await Member.load().catch(() => {});
    return r;
  },

  // member: cancel one of their own bookings (refund / credit handled server-side)
  async cancelMine(bookingId) {
    const r = await ppFn('cancel-booking', { method: 'POST', body: JSON.stringify({ booking_id: bookingId }) });
    await Member.load().catch(() => {});
    return r;
  },
  // staff: refund paid bookings via Stripe and soft-cancel them
  async refund(bookingIds) {
    const data = await ppFn('refund', { method: 'POST', body: JSON.stringify({ booking_ids: bookingIds }) });
    cache.bookings.filter(b => bookingIds.includes(b.id) && data.results?.[b.id] === 'refunded')
      .forEach(b => { cache.counts[b.classId] = Math.max(0, (cache.counts[b.classId] || 0) - 1); });
    cache.bookings = cache.bookings.filter(b => !(bookingIds.includes(b.id) && data.results?.[b.id] === 'refunded'));
    return data;
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

  // cancel a whole class occurrence and every booking on it.
  // The cancelled_classes insert comes FIRST: a database trigger texts every
  // still-active booking the moment the marker lands, so the bookings must
  // not be cancelled until after it.
  async cancelClass(dateIso, time, opts = {}) {
    const classId = `${dateIso}_${time}`;
    await ppApi('cancelled_classes', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ class_date: dateIso, start_time: time, reason: opts.reason || '' }),
    });
    (cache.cancelled[dateIso] = cache.cancelled[dateIso] || new Set()).add(time);
    await ppApi(`bookings?class_id=eq.${classId}&cancelled_at=is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ cancelled_at: new Date().toISOString() }),
    });
    if (opts.custom) await this.removeClass(dateIso, time);
    cache.counts[classId] = 0;
    cache.bookings = cache.bookings.filter(b => b.classId !== classId);
    return { ok: true };
  },

  async restoreClass(dateIso, time) {
    await ppApi(`cancelled_classes?class_date=eq.${dateIso}&start_time=eq.${encodeURIComponent(time)}`, { method: 'DELETE' });
    cache.cancelled[dateIso]?.delete(time);
    return { ok: true };
  },

  async addClass(dateIso, time, type, instructor) {
    const [row] = await ppApi('custom_classes', {
      method: 'POST',
      body: JSON.stringify({ class_date: dateIso, start_time: time, type_key: type, instructor: instructor || null }),
    });
    (cache.custom[dateIso] = cache.custom[dateIso] || []).push({ time, type, instructor: instructor || null, id: row.id });
    cache.custom[dateIso].sort((a, b) => a.time.localeCompare(b.time));
    return { ok: true };
  },

  async removeClass(dateIso, time) {
    await ppApi(`custom_classes?class_date=eq.${dateIso}&start_time=eq.${encodeURIComponent(time)}`, { method: 'DELETE' });
    cache.custom[dateIso] = (cache.custom[dateIso] || []).filter(c => c.time !== time);
    if (!cache.custom[dateIso].length) delete cache.custom[dateIso];
    return { ok: true };
  },

  // one-off health waiver, keyed by email (the server enforces it on booking)
  async saveWaiver(w) {
    await ppApi('waivers', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(w),
    });
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
    amount: r.amount_pence || null, paid: !!r.paid_at, refunded: !!r.refunded_at,
    userId: r.user_id || null,
    paidWith: r.paid_with || (r.paid_at ? 'card' : null),   // 'card' | 'credit' | null
    cancelledAt: r.cancelled_at ? Date.parse(r.cancelled_at) : null,
    classType: r.class_type || null,
  };
}

/* ---------- member: profile, credits, own bookings ---------- */
const Member = {
  profile: null,     // { name, phone, verifiedAt }
  packs: [],         // { id, total, left, expiresAt, purchasedAt, amount }
  bookings: [],      // own bookings, mapped, newest first (incl. cancelled)
  waiver: false,
  loaded: false,
  reset() { this.profile = null; this.packs = []; this.bookings = []; this.waiver = false; this.loaded = false; },
  // true when the mobile is proved, or when the studio is not asking yet
  phoneOk() { return !RULES.requirePhone || !!this.profile?.verifiedAt; },
  needsPhone() { return RULES.requirePhone && !this.profile?.verifiedAt; },
  credits() {
    const now = Date.now();
    return this.packs.filter(p => p.left > 0 && p.expiresAt > now).reduce((n, p) => n + p.left, 0);
  },
  nextExpiry() {
    const now = Date.now();
    const live = this.packs.filter(p => p.left > 0 && p.expiresAt > now).sort((a, b) => a.expiresAt - b.expiresAt);
    return live[0]?.expiresAt || null;
  },
  has(classId) { return this.bookings.some(b => b.classId === classId && !b.cancelledAt); },
  upcoming() {
    const now = Date.now();
    return this.bookings.filter(b => !b.cancelledAt && classStart(b.classId) >= now).sort((a, b) => classStart(a.classId) - classStart(b.classId));
  },
  past() {
    const now = Date.now();
    return this.bookings.filter(b => b.cancelledAt || classStart(b.classId) < now).sort((a, b) => classStart(b.classId) - classStart(a.classId));
  },
  async load() {
    const uid = Auth.userId();
    if (!uid) { this.reset(); return; }
    const email = (Auth.email() || '').toLowerCase();
    const [prof, packs, rows, waiver] = await Promise.all([
      ppApi(`profiles?user_id=eq.${uid}&select=full_name,phone,phone_verified_at`),
      ppApi(`credit_packs?user_id=eq.${uid}&select=*&order=expires_at.asc`),
      ppApi(`bookings?user_id=eq.${uid}&select=*&order=created_at.desc&limit=200`),
      email ? ppApi(`waivers?email=eq.${encodeURIComponent(email)}&select=signed_at`) : Promise.resolve([]),
    ]);
    this.profile = {
      name: prof[0]?.full_name || '',
      phone: prof[0]?.phone || '',
      verifiedAt: prof[0]?.phone_verified_at ? Date.parse(prof[0].phone_verified_at) : null,
    };
    this.packs = packs.map(p => ({
      id: p.id, total: p.credits_total, left: p.credits_left, amount: p.amount_pence,
      expiresAt: Date.parse(p.expires_at), purchasedAt: Date.parse(p.purchased_at), note: p.note || '',
    }));
    this.bookings = rows.map(mapBooking);
    this.waiver = waiver.length > 0;
    this.loaded = true;
  },
  async saveProfile(fields) {
    const uid = Auth.userId();
    const body = { full_name: fields.name, phone: fields.phone };
    const existing = await ppApi(`profiles?user_id=eq.${uid}&select=user_id`);
    if (existing.length) {
      await ppApi(`profiles?user_id=eq.${uid}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }) });
    } else {
      await ppApi('profiles', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: uid, ...body }) });
    }
    // changing the number clears the verification server-side, so re-read
    await this.load().catch(() => {
      this.profile = { name: fields.name, phone: fields.phone, verifiedAt: null };
    });
  },
};

/* ---------- phone numbers ----------
   Stored readable with the country code on the front ("+44 7786 479635"),
   which is what every webhook and ClickSend expect once the spaces come
   out. Longest codes first, so +353 is not mistaken for +33. */
const PP_DIAL_CODES = ['+971', '+353', '+351', '+92', '+91', '+64', '+61', '+49', '+48', '+46',
                       '+44', '+40', '+39', '+34', '+33', '+31', '+27', '+1'];
function splitDial(stored) {
  const s = String(stored || '').trim();
  const code = PP_DIAL_CODES.find(c => s.startsWith(c));
  return code ? [code, s.slice(code.length).trim()] : ['+44', s.replace(/^0+/, '')];
}
const joinDial = (code, national) => `${code} ${String(national).trim().replace(/^0+/, '')}`;

const gbp = pence => '£' + (pence % 100 === 0 ? pence / 100 : (pence / 100).toFixed(2));

/* ---------- health questionnaire and waiver ---------- */
const PP_WAIVER_QUESTIONS = [
  'Do you currently have any injuries, pain, or physical conditions that may affect your ability to take part in Pilates?',
  'Do you have any medical conditions that the instructor should be aware of?',
  'Have you had any recent surgery, treatment, or significant injury?',
  'Are you currently receiving treatment from a doctor, physiotherapist, chiropractor, or other healthcare professional for a condition that may affect exercise?',
  'Do you experience dizziness, fainting, chest pain, shortness of breath, or any other symptoms during physical activity?',
  'Are you currently pregnant or have you given birth recently?',
  'Is there anything else regarding your health, mobility, or wellbeing that your Pilates instructor should know before the session?',
];

/* ---------- staff settings ---------- */
const Settings = {
  async saveRules(rules) {
    await ppApi('settings?id=eq.1', {
      method: 'PATCH',
      body: JSON.stringify({
        max_riders: rules.maxRiders, min_riders: rules.minRiders,
        cutoff_hours: rules.cutoffHours, window_days: rules.windowDays,
        pack_credits: rules.packCredits, pack_price_pence: rules.packPrice, pack_expiry_months: rules.packMonths,
        require_phone_verification: rules.requirePhone, verification_code_minutes: rules.codeMinutes,
      }),
    });
    Object.assign(RULES, rules);
  },
  // move a class, calendar-style: one date only, or the weekly slot itself.
  // The server re-points bookings and texts each member a class_moved message.
  async moveOccurrence(dateIso, oldTime, newTime, instructor) {
    return ppApi('rpc/move_class_occurrence', {
      method: 'POST',
      body: JSON.stringify({ p_date: dateIso, p_old_time: oldTime, p_new_time: newTime, p_instructor: instructor || null }),
    });
  },
  async moveTemplateSlot(slotId, newTime, instructor) {
    return ppApi('rpc/move_class_template', {
      method: 'POST',
      body: JSON.stringify({ p_id: slotId, p_new_time: newTime, p_instructor: instructor || null }),
    });
  },

  // recurring weekly timetable management (staff)
  async addTimetableSlot(weekday, time, typeKey, instructor) {
    const [row] = await ppApi('timetable', {
      method: 'POST',
      body: JSON.stringify({ weekday, start_time: time, type_key: typeKey, instructor: instructor || null }),
    });
    (TIMETABLE[weekday] = TIMETABLE[weekday] || []).push([row.start_time, row.type_key, row.instructor, row.id]);
    TIMETABLE[weekday].sort((a, b) => a[0].localeCompare(b[0]));
  },
  async updateTimetableSlot(id, weekday, fields) {
    await ppApi(`timetable?id=eq.${id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(fields),
    });
    const slot = (TIMETABLE[weekday] || []).find(s => s[3] === id);
    if (slot) {
      if (fields.start_time) slot[0] = fields.start_time;
      if ('instructor' in fields) slot[2] = fields.instructor;
      TIMETABLE[weekday].sort((a, b) => a[0].localeCompare(b[0]));
    }
  },
  async removeTimetableSlot(id, weekday) {
    await ppApi(`timetable?id=eq.${id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    TIMETABLE[weekday] = (TIMETABLE[weekday] || []).filter(s => s[3] !== id);
  },

  async setPrice(key, pence) {
    await ppApi(`class_types?key=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ price_pence: pence }),
    });
    if (CLASS_TYPES[key]) CLASS_TYPES[key].price = pence;
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

/* ---------- roles + instructors ---------- */
// 'admin' | 'instructor' | 'member' | null (not signed in / not loaded yet).
// The database enforces all of this; PP_ROLE only shapes the UI.
let PP_ROLE = null;
const INSTRUCTORS = [];  // { id, name, email, phone, rate, active }

const Instructors = {
  active() { return INSTRUCTORS.filter(i => i.active); },
  byName(name) { return name ? INSTRUCTORS.find(i => i.name.toLowerCase() === String(name).toLowerCase()) : null; },
  async load() {
    const rows = await ppApi('instructors?select=*&order=name.asc');
    INSTRUCTORS.length = 0;
    rows.forEach(r => INSTRUCTORS.push({
      id: r.id, name: r.name, email: r.email || '', phone: r.phone || '',
      rate: r.hourly_rate_pence, active: r.active,
    }));
  },
  async add(i) {
    const [row] = await ppApi('instructors', {
      method: 'POST',
      body: JSON.stringify({ name: i.name, email: i.email || null, phone: i.phone || null, hourly_rate_pence: i.rate }),
    });
    INSTRUCTORS.push({ id: row.id, name: row.name, email: row.email || '', phone: row.phone || '', rate: row.hourly_rate_pence, active: row.active });
    INSTRUCTORS.sort((a, b) => a.name.localeCompare(b.name));
  },
  async update(id, fields) {
    await ppApi(`instructors?id=eq.${id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(fields),
    });
    const i = INSTRUCTORS.find(x => x.id === id);
    if (i) {
      if ('name' in fields) i.name = fields.name;
      if ('email' in fields) i.email = fields.email || '';
      if ('phone' in fields) i.phone = fields.phone || '';
      if ('hourly_rate_pence' in fields) i.rate = fields.hourly_rate_pence;
      if ('active' in fields) i.active = fields.active;
    }
  },
};

// a signed-in user with no staff_roles row is a member
async function loadRole() {
  if (!Auth.token()) { PP_ROLE = null; return PP_ROLE; }
  try {
    const rows = await ppApi('staff_roles?select=role');
    PP_ROLE = rows[0]?.role || 'member';
  } catch { PP_ROLE = 'member'; }
  return PP_ROLE;
}
const loadStaffRole = loadRole;

/* ---------- boot: load everything the pages need ---------- */
async function ppInit() {
  const today = iso(new Date());
  if (Auth.session()) {
    await Auth.ensure();                       // keep anyone signed in across reloads
    if (Auth.token() && !Auth.userId()) await Auth.loadUser().catch(() => {});
    await loadRole();
  }
  const [types, slots, custom, cancelled, settings, counts] = await Promise.all([
    ppApi('class_types?select=*'),
    ppApi('timetable?select=id,weekday,start_time,type_key,instructor'),
    ppApi(`custom_classes?class_date=gte.${today}&select=*`),
    ppApi(`cancelled_classes?class_date=gte.${today}&select=*`),
    ppApi('settings?id=eq.1&select=*'),
    ppApi('booking_counts?select=*'),
  ]);
  cancelled.forEach(c => { (cache.cancelled[c.class_date] = cache.cancelled[c.class_date] || new Set()).add(c.start_time); });
  types.forEach(t => { CLASS_TYPES[t.key] = { name: t.name, level: t.level, desc: t.descr, custom: t.custom, price: t.price_pence || null }; });
  slots.forEach(s => { (TIMETABLE[s.weekday] = TIMETABLE[s.weekday] || []).push([s.start_time, s.type_key, s.instructor, s.id]); });
  Object.values(TIMETABLE).forEach(day => day.sort((a, b) => a[0].localeCompare(b[0])));
  custom.forEach(c => { (cache.custom[c.class_date] = cache.custom[c.class_date] || []).push({ time: c.start_time, type: c.type_key, instructor: c.instructor || null, id: c.id }); });
  if (settings[0]) {
    const s = settings[0];
    Object.assign(RULES, {
      maxRiders: s.max_riders, minRiders: s.min_riders,
      cutoffHours: s.cutoff_hours, windowDays: s.window_days,
      openingDate: s.opening_date,
      packCredits: s.pack_credits ?? RULES.packCredits,
      packPrice: s.pack_price_pence ?? RULES.packPrice,
      packMonths: s.pack_expiry_months ?? RULES.packMonths,
      requirePhone: s.require_phone_verification ?? RULES.requirePhone,
      codeMinutes: s.verification_code_minutes ?? RULES.codeMinutes,
    });
  }
  counts.forEach(r => { cache.counts[r.class_id] = r.booked; });
  if (Auth.userId()) await Member.load().catch(() => {});
}

const ppReady = ppInit();
