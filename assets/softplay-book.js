/* ============================================================
   Padel Power · Soft play booking page
   ?session=<id> picks the slot. Account required; card payment through
   the checkout function (kind: softplay). Requires pilates-core.js and
   phone-verify.js.
   ============================================================ */
(async function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const gbp = p => '£' + (p % 100 === 0 ? p / 100 : (p / 100).toFixed(2));
  const q = new URLSearchParams(location.search);
  const sessionId = q.get('session') || '';
  const spSession = q.get('sp_session');   // back from Stripe

  function fail() { $('evGrid').style.display = 'none'; $('evMissing').style.display = ''; }
  try { await ppReady; } catch { return fail(); }
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return fail();
  await Softplay.load(sessionId ? '2000-01-01' : '', '2100-01-01').catch(() => {});
  const s = Softplay.byId(sessionId);
  if (!s || s.cancelled) return fail();
  if (Auth.userId()) await Member.load().catch(() => {});

  const sp = RULES.softplay;
  const hire = s.mode === 'hire';            // exclusive: the whole room
  const staffed = s.mode === 'supervised';   // our team watches the children
  const price = Softplay.price(s);            // per child, pence
  const day = new Date(s.date + 'T00:00:00');
  const endD = Softplay.end(s);
  const end = `${String(endD.getHours()).padStart(2, '0')}:${String(endD.getMinutes()).padStart(2, '0')}`;
  const maxKids = hire ? s.capacity : Math.max(0, s.capacity - s.booked);
  let kids = Math.min(1, maxKids) || 1;

  document.title = `${Softplay.label(s)} · ${fmtFull.format(day)} ${s.time} | Padel Power`;
  $('evDate').textContent = `${fmtFull.format(day)} · ${s.time}`;
  $('evTitle').innerHTML = hire
    ? 'Hire the<br><span class="blue">Kids Zone</span>'
    : staffed ? 'Supervised<br><span class="blue">session</span>' : 'Soft<br><span class="blue">play</span>';
  $('evMeta').innerHTML = [`${s.time} to ${end}`, `${s.duration} minutes`, Softplay.supervision(s), `Up to ${s.capacity} children`]
    .map(x => `<span>${x}</span>`).join('');
  $('evDesc').textContent = hire
    ? `The whole Kids Zone for your crew. ${gbp(Softplay.rate(s))} per child per hour, and a parent or carer stays in the room with them.`
    : staffed
      ? `Drop the children off with a member of our team and go and play, train or sit down with a coffee. Sessions run with a minimum of ${sp.minChildren} children and a maximum of ${s.capacity}.`
      : `An unsupervised session: a parent or carer stays in the room and looks after their own children. ${gbp(Softplay.rate(s))} per child per hour, up to ${s.capacity} children in at once.`;
  $('evAges').innerHTML = `${sp.minAge} to ${sp.maxAge}<br><em>Roughly. Ask us if you're not sure</em>`;
  $('evNote').textContent = hire
    ? `Hire slots are yours once paid. Cancel up to ${RULES.cutoffHours} hours before for a full refund.`
    : staffed
      ? `Supervised sessions need ${sp.minChildren} children booked to go ahead. If this one is not going ahead you'll get a text ${RULES.cutoffHours} hours before the start and a full refund.`
      : `This session is unsupervised, so a parent or carer stays in the room for the whole booking. Cancel up to ${RULES.cutoffHours} hours before for a full refund.`;
  $('evKind').textContent = hire ? 'Hire this slot' : 'Book your places';
  if (!staffed) {
    $('spConsentText').textContent = 'I confirm the children are within the age range, that a parent or carer will stay in the room and supervise them for the whole session, and that everyone will wear grip socks.';
  } else {
    $('spConsentText').textContent = 'I confirm the children are within the age range and will wear grip socks, and that our team may contact me on the number on my account during the session.';
  }

  const spotsEl = $('evSpots'), authBox = $('evAuth'), bookBox = $('evBook'), kidsBox = $('evKids');
  const small = document.querySelector('.ev-small');
  const signedIn = !!Auth.userId();
  const spotsLabel = () => `${gbp(price || 0)} per child · ${hire ? (s.bookings ? 'Already hired' : 'Whole space') : `${maxKids} of ${s.capacity} left`}`;
  function hideAll() { authBox.hidden = true; bookBox.hidden = true; kidsBox.hidden = true; small.style.display = 'none'; }
  function lockCard(msg) { hideAll(); small.style.display = ''; small.textContent = msg; }

  function renderKids() {
    $('kidsCount').textContent = kids;
    $('kidsTotal').textContent = price ? `${kids} × ${gbp(price)} = ${gbp(price * kids)}` : '';
    $('kidsMinus').disabled = kids <= 1;
    $('kidsPlus').disabled = kids >= maxKids;
    const pay = $('evPayCard');
    if (pay) pay.innerHTML = `Book and pay ${gbp(price * kids)} <span class="arr">→</span>`;
  }
  $('kidsMinus').addEventListener('click', () => { kids = Math.max(1, kids - 1); renderKids(); });
  $('kidsPlus').addEventListener('click', () => { kids = Math.min(maxKids, kids + 1); renderKids(); });

  if (spSession) {
    handleReturn();
  } else if (signedIn && Member.hasSoftplay(s.id)) {
    spotsEl.textContent = 'Booked ✓'; spotsEl.classList.add('ok'); hideAll(); showDone();
  } else if (!sp.open) {
    lockCard('Kids Zone booking has not opened yet. Message us on WhatsApp and we will tell you the moment it does.');
  } else if (!price) {
    lockCard('The price for this session has not been set yet. Check back shortly or message us on WhatsApp.');
  } else if (maxKids <= 0) {
    spotsEl.textContent = hire ? 'Already hired' : 'Fully booked';
    lockCard(hire ? 'Someone has this slot. Pick another on the timetable.' : 'This session is full. Pick another on the timetable.');
  } else if (Softplay.closed(s)) {
    spotsEl.textContent = 'Booking closed';
    lockCard(Softplay.hoursLeft(s) < RULES.joinCutoffHours
      ? `Bookings close ${RULES.joinCutoffHours === 1 ? 'an hour' : RULES.joinCutoffHours + ' hours'} before a session. Pick a later one.`
      : `This session did not reach ${sp.minChildren} children ${RULES.cutoffHours} hours ahead, so it is not going ahead. Pick a later one.`);
  } else {
    spotsEl.textContent = spotsLabel();
    renderKids();
    if (signedIn) renderBook(); else renderAuth();
  }

  function phoneReady(retry) {
    if (!Member.needsPhone()) return true;
    PhoneVerify.open({
      reason: 'Before we hold your places, we need to know we can text you. Your confirmation and cancellation link both go by text.',
      onDone: () => { renderBook(); if (retry) retry(); },
      onSkip: () => renderBook(),
    });
    return false;
  }

  function renderBook() {
    authBox.hidden = true; bookBox.hidden = false; kidsBox.hidden = false;
    const who = Member.profile?.name || Auth.email();
    $('evWho').innerHTML = `Booking as <b>${esc(who || '')}</b>`;
    $('evActions').innerHTML = Member.needsPhone()
      ? `<button class="btn btn-blue" id="evVerify" style="width:100%;justify-content:center">Verify my mobile <span class="arr">→</span></button>
         <p class="ev-credits">One text, one code, then you can book.</p>`
      : `<button class="btn btn-blue" id="evPayCard" style="width:100%;justify-content:center">Book and pay ${gbp(price * kids)} <span class="arr">→</span></button>`;
    small.style.display = '';
    small.textContent = `Secure card payment. Cancel up to ${RULES.cutoffHours} hours before for a full refund.`;
    const verify = $('evVerify');
    if (verify) verify.addEventListener('click', () => phoneReady());
    const card = $('evPayCard');
    if (card) card.addEventListener('click', () => {
      if (!$('spConsent').checked) { alert('Please tick the box to confirm the supervision and age details first.'); return; }
      return phoneReady(() => card.click()) && run(card, 'Taking you to payment…', async () => {
        const { url } = await Store.softplayCheckout(s.id, kids, $('kidsNames').value.trim(), true);
        location.href = url;
        await new Promise(() => {});
      });
    });
  }

  async function run(btn, busy, fn) {
    const label = btn.innerHTML;
    btn.disabled = true; btn.textContent = busy;
    try { await fn(); } catch (err) {
      btn.disabled = false; btn.innerHTML = label;
      const msg = String(err.message || '');
      if (msg.includes('already_booked')) { await Member.load().catch(() => {}); hideAll(); spotsEl.textContent = 'Booked ✓'; spotsEl.classList.add('ok'); showDone(); }
      else if (msg.includes('session_full') || msg.includes('session_taken')) alert('Sorry, that slot has just gone. Pick another on the timetable.');
      else if (msg.includes('phone_unverified')) { await Member.load().catch(() => {}); phoneReady(() => btn.click()); }
      else if (msg.includes('profile_incomplete')) { alert('Add your mobile number to your account first so we can text you.'); location.href = '../../account/#details'; }
      else if (msg.includes('account_required') || msg.includes('JWT') || msg.includes('signed_out')) { Auth.signOut(); location.reload(); }
      else if (msg.includes('cutoff') || msg.includes('session_in_past')) { alert('Bookings for this session have closed.'); location.href = '../../kids-zone/#book'; }
      else if (msg.includes('softplay_closed')) alert('Kids Zone booking has not opened yet.');
      else if (msg.includes('price_not_set')) alert('The price for this session has not been set yet. Please try again later.');
      else if (msg.includes('payments_not_configured')) alert('Online payment is not available right now. Please call the club to book.');
      else alert('Something went wrong starting your booking. Please try again.');
    }
  }

  function renderAuth() {
    bookBox.hidden = true; authBox.hidden = false; kidsBox.hidden = true;
    small.style.display = '';
    small.textContent = `${gbp(price)} per child. Cancel up to ${RULES.cutoffHours} hours before for a full refund.`;
    const tabs = authBox.querySelectorAll('.ev-tab');
    const panes = { in: $('evSignIn'), up: $('evSignUp') };
    const show = which => { tabs.forEach(b => b.classList.toggle('on', b.dataset.tab === which)); panes.in.hidden = which !== 'in'; panes.up.hidden = which !== 'up'; };
    tabs.forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
    show(q.get('auth') === 'in' ? 'in' : 'up');
    panes.up.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      if (f.suWebsite.value) return;
      const btn = f.querySelector('button[type=submit]');
      const err = $('suError'); err.hidden = true;
      btn.disabled = true; btn.textContent = 'Creating your account…';
      const phone = `${f.suCode.value} ${f.suPhone.value.trim().replace(/^0+/, '')}`;
      try {
        const r = await Auth.signUp(f.suEmail.value.trim().toLowerCase(), f.suPass.value, { name: f.suName.value.trim(), phone });
        if (r.confirm) {
          authBox.innerHTML = `<div class="ev-confirm"><h3>Check your inbox</h3><p>We have sent a confirmation link to <b>${esc(f.suEmail.value.trim())}</b>. Tap it and you will land back here, signed in and ready to book.</p></div>`;
          return;
        }
        location.reload();
      } catch (ex) {
        btn.disabled = false; btn.innerHTML = 'Create account and book <span class="arr">→</span>';
        const m = String(ex.message);
        err.textContent = m === 'already_registered' || /already registered|already exists/i.test(m) ? 'There is already an account for that email. Sign in instead.'
          : /password/i.test(m) ? 'Password needs to be at least 8 characters.' : m;
        err.hidden = false;
        if (m === 'already_registered') { show('in'); $('siEmail').value = f.suEmail.value; }
      }
    });
    panes.in.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      const btn = f.querySelector('button[type=submit]');
      const err = $('siError'); err.hidden = true;
      btn.disabled = true; btn.textContent = 'Signing in…';
      try { await Auth.signIn(f.siEmail.value.trim(), f.siPass.value); location.reload(); }
      catch (ex) {
        btn.disabled = false; btn.innerHTML = 'Sign in and book <span class="arr">→</span>';
        const m = String(ex.message);
        err.textContent = /invalid/i.test(m) ? 'That email and password combination was not recognised.' : /not confirmed/i.test(m) ? 'Please confirm your email first.' : m;
        err.hidden = false; f.siPass.value = '';
      }
    });
  }

  function showDone(n) {
    const mine = Member.softplay.find(b => b.sessionId === s.id && !b.cancelledAt);
    const count = n || mine?.children || kids;
    $('evDoneMeta').textContent = `${fmtFull.format(day)} · ${s.time} to ${end} · ${count} ${count === 1 ? 'child' : 'children'}`;
    $('evDoneNote').textContent = 'Your booking is confirmed. We will text you a confirmation with a cancellation link.';
    $('evDone').style.display = '';
  }

  async function handleReturn() {
    hideAll();
    spotsEl.textContent = 'Confirming…';
    for (let i = 0; i < 6; i++) {
      let st;
      try { st = await Store.checkoutStatus(spSession); } catch { break; }
      if (st.booked) {
        await Member.load().catch(() => {});
        spotsEl.textContent = 'Booked ✓'; spotsEl.classList.add('ok'); showDone(st.children); return;
      }
      if (st.refunded) {
        spotsEl.textContent = 'Refunded';
        small.style.display = '';
        small.textContent = 'That slot went before your payment completed, so your card has been refunded in full. Pick another session on the timetable.';
        return;
      }
      if (!st.paid && i >= 1) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    spotsEl.textContent = spotsLabel();
    renderKids();
    if (signedIn) renderBook(); else renderAuth();
  }
})();
