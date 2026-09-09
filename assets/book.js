/* ============================================================
   Padel Power · Reformer Pilates — class event page
   Reads ?date=YYYY-MM-DD&time=HH:MM&type=key, validates against
   the timetable and renders the class. Requires pilates-core.js.
   Booking needs an account: the card shows sign in / create
   account until there is a session, then credit or card payment.
   ============================================================ */

(async function () {
  const q = new URLSearchParams(location.search);
  const date = q.get('date'), time = q.get('time'), type = q.get('type');

  const grid = document.getElementById('evGrid');
  const missing = document.getElementById('evMissing');
  const fail = () => { grid.style.display = 'none'; missing.style.display = ''; };
  const $ = id => document.getElementById(id);

  // arriving back from a confirmation email lands the tokens in the hash
  if (Auth.adoptHashSession()) { location.reload(); return; }

  try { await ppReady; } catch { return fail(); }

  // validate: real timetable slot, inside the booking window
  const t = CLASS_TYPES[type];
  if (!date || !time || !t) return fail();
  const day = new Date(date + 'T00:00:00');
  if (isNaN(day)) return fail();
  const slot = classesFor(day).find(c => c.time === time && c.type === type);
  const inWindow = bookableDates().some(d => iso(d) === date);
  if (!slot || !inWindow) return fail();

  const id = `${date}_${time}`;
  const booked = Store.count(id);
  const spots = RULES.maxRiders - booked;
  const closed = withinCutoff(id);
  const price = t.price;   // pence, or null while classes are free to reserve
  const session = q.get('session');   // set when returning from Stripe Checkout

  /* ---- render ---- */
  const [name, accent] = splitTitle(t.name);
  document.title = `${t.name} · ${fmtFull.format(day)} ${time} | Padel Power`;
  $('evDate').textContent = `${fmtFull.format(day)} · ${time}`;
  $('evTitle').innerHTML = `${esc(name)}<br><span class="blue">${esc(accent)}</span>`;
  $('evMeta').innerHTML = [
    `${time} to ${endTime(time)}`,
    '1 hour',
    t.level,
    `${RULES.maxRiders} beds`,
  ].map(x => `<span>${x}</span>`).join('');
  if (slot.instructor) {
    $('evInstructor').innerHTML = `${esc(slot.instructor)}<br><em>Reformer instructor</em>`;
    $('evInstructorFact').style.display = '';
  }
  $('evDesc').textContent = t.desc
    + (slot.instructor
      ? ` Led by ${slot.instructor} in the brand-new studio, with never more than eight people in the room.`
      : ' Led by our reformer instructors in the brand-new studio, with never more than eight people in the room.');

  // bed dots
  $('evBeds').innerHTML = Array.from({ length: RULES.maxRiders },
    (_, i) => `<i class="${i < booked ? 'taken' : ''}"></i>`).join('');

  const spotsEl = $('evSpots');
  const authBox = $('evAuth');
  const bookBox = $('evBook');
  const small = document.querySelector('.ev-small');
  const signedIn = !!Auth.userId();

  const spotsLabel = () => (price ? `${gbp(price)} · ` : '') + `${spots} of ${RULES.maxRiders} beds left`;

  function hideAll() { authBox.hidden = true; bookBox.hidden = true; small.style.display = 'none'; }

  if (session) {
    handleReturn();
  } else if (signedIn && Store.mine(id)) {
    spotsEl.textContent = 'Booked ✓';
    spotsEl.classList.add('ok');
    hideAll();
    showDone();
  } else if (spots <= 0) {
    spotsEl.textContent = 'Fully booked';
    lockCard('This class is full. Pick another session on the timetable.');
  } else if (closed) {
    spotsEl.textContent = 'Booking closed';
    lockCard('Bookings close 24 hours before class so instructors know who’s coming. Pick a later session.');
  } else {
    spotsEl.textContent = spotsLabel();
    if (spots <= 2) spotsEl.classList.add('low');
    if (signedIn) renderBook(); else renderAuth();
  }

  // The mobile has to be proved before a bed can be held, because the
  // confirmation and the cancel link both go by text. Returns true when
  // we are clear to book; otherwise opens the code screen and returns false.
  function phoneReady(retry) {
    if (!Member.needsPhone()) return true;
    PhoneVerify.open({
      reason: 'Before we hold your bed, we need to know we can text you. Your confirmation and cancellation link both go by text.',
      onDone: () => { renderBook(); if (retry) retry(); },
      onSkip: () => renderBook(),
    });
    return false;
  }

  /* ---- signed in: choose how to pay ---- */
  function renderBook() {
    authBox.hidden = true;
    bookBox.hidden = false;
    const who = Member.profile?.name || Auth.email();
    $('evWho').innerHTML = `Booking as <b>${esc(who || '')}</b>${Member.profile?.name ? ` · ${esc(Auth.email() || '')}` : ''}`;
    const credits = Member.credits();
    let html = '';
    if (Member.needsPhone()) {
      html = `
        <button class="btn btn-blue" id="evVerify" style="width:100%;justify-content:center">Verify my mobile <span class="arr">→</span></button>
        <p class="ev-credits">One text, one code, then you can book.</p>`;
      small.textContent = 'We text your confirmation and your cancellation link, so the number has to be right.';
    } else if (!price) {
      html = `<button class="btn btn-blue" id="evFree" style="width:100%;justify-content:center">Confirm booking <span class="arr">→</span></button>`;
      small.textContent = 'Cancel up to 24 hours before class from your account.';
    } else if (credits > 0) {
      html = `
        <button class="btn btn-blue" id="evCredit" style="width:100%;justify-content:center">Use 1 class credit <span class="arr">→</span></button>
        <p class="ev-credits">You have ${credits} credit${credits === 1 ? '' : 's'} left${expiryNote()}.</p>
        <button class="btn btn-ghost" id="evPayCard" style="width:100%;justify-content:center">Pay ${gbp(price)} by card instead</button>`;
      small.textContent = 'Cancel up to 24 hours before class and the credit goes back on your account.';
    } else {
      html = `
        <button class="btn btn-blue" id="evPayCard" style="width:100%;justify-content:center">Book and pay ${gbp(price)} <span class="arr">→</span></button>
        <a class="ev-packlink" href="../account/#packs">Or get ${RULES.packCredits} classes for ${gbp(RULES.packPrice)} <span>→</span></a>`;
      small.textContent = 'Secure card payment. Cancel up to 24 hours before class for a full refund.';
    }
    $('evActions').innerHTML = html;
    small.style.display = '';

    const verify = $('evVerify');
    if (verify) verify.addEventListener('click', () => phoneReady());

    const free = $('evFree'), credit = $('evCredit'), card = $('evPayCard');
    if (free) free.addEventListener('click', () => phoneReady(() => free.click()) && run(free, 'Booking…', async () => {
      await Store.book(id, { name: Member.profile?.name || '', email: Auth.email(), phone: Member.profile?.phone || '' });
      hideAll(); showDone();
    }));
    if (credit) credit.addEventListener('click', () => phoneReady(() => credit.click()) && run(credit, 'Booking…', async () => {
      await Store.bookWithCredit(id);
      hideAll(); showDone(true);
    }));
    if (card) card.addEventListener('click', () => phoneReady(() => card.click()) && run(card, 'Taking you to payment…', async () => {
      const { url } = await Store.checkout(id);
      location.href = url;
      await new Promise(() => {});   // leave the button disabled while we navigate
    }));
  }

  function expiryNote() {
    const e = Member.nextExpiry();
    if (!e) return '';
    return `, next expiry ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(e))}`;
  }

  // run an action with the button disabled; maps server errors to messages
  async function run(btn, busy, fn) {
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = busy;
    try {
      await fn();
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = label;
      const msg = String(err.message || '');
      if (msg.includes('waiver_required')) {
        openWaiver(() => btn.click());
      } else if (msg.includes('already_booked')) {
        await Member.load().catch(() => {});
        hideAll(); spotsEl.textContent = 'Booked ✓'; spotsEl.classList.add('ok'); showDone();
      } else if (msg.includes('class_full')) {
        alert('Sorry, that class has just filled up. Pick another session on the timetable.');
        location.href = '../pilates/#book';
      } else if (msg.includes('no_credits')) {
        alert('You have no class credits left. Pay by card, or buy a pack from your account.');
        await Member.load().catch(() => {}); renderBook();
      } else if (msg.includes('phone_unverified')) {
        await Member.load().catch(() => {});
        phoneReady(() => btn.click());
      } else if (msg.includes('profile_incomplete')) {
        alert('Add your mobile number to your account first so we can text you about the class.');
        location.href = '../account/#details';
      } else if (msg.includes('account_required') || msg.includes('JWT') || msg.includes('signed_out')) {
        Auth.signOut(); location.reload();
      } else if (msg.includes('cutoff') || msg.includes('class_in_past')) {
        alert('Bookings for this class have closed.');
        location.href = '../pilates/#book';
      } else if (msg.includes('payments_not_configured')) {
        alert('Online payment is not available right now. Please call the club to book.');
      } else if (msg.includes('rate_limited')) {
        alert('Too many bookings from this account in the last hour. Please try again later.');
      } else {
        alert('Something went wrong saving your booking. Please try again.');
      }
    }
  }

  /* ---- not signed in: sign in or create an account ---- */
  function renderAuth() {
    bookBox.hidden = true;
    authBox.hidden = false;
    small.style.display = '';
    small.textContent = price
      ? `${gbp(price)} per class, or ${RULES.packCredits} classes for ${gbp(RULES.packPrice)}. Cancel up to 24 hours before class.`
      : 'Cancel up to 24 hours before class.';
    const tabs = authBox.querySelectorAll('.ev-tab');
    const panes = { in: $('evSignIn'), up: $('evSignUp') };
    const show = which => {
      tabs.forEach(b => b.classList.toggle('on', b.dataset.tab === which));
      panes.in.hidden = which !== 'in';
      panes.up.hidden = which !== 'up';
    };
    tabs.forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
    show(q.get('auth') === 'in' ? 'in' : 'up');

    panes.up.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      if (f.suWebsite.value) return;   // honeypot
      const btn = f.querySelector('button[type=submit]');
      const err = $('suError'); err.hidden = true;
      btn.disabled = true; btn.textContent = 'Creating your account…';
      const phone = `${f.suCode.value} ${f.suPhone.value.trim().replace(/^0+/, '')}`;
      try {
        const r = await Auth.signUp(f.suEmail.value.trim().toLowerCase(), f.suPass.value, { name: f.suName.value.trim(), phone });
        if (r.confirm) {
          authBox.innerHTML = `
            <div class="ev-confirm">
              <h3>Check your inbox</h3>
              <p>We have sent a confirmation link to <b>${esc(f.suEmail.value.trim())}</b>. Tap it and you will land back here, signed in and ready to book.</p>
              <p class="dim">No email after a minute? Check your junk folder, or message us on WhatsApp.</p>
            </div>`;
          return;
        }
        await Member.load().catch(() => {});
        if (Member.needsPhone()) {
          authBox.hidden = true;
          spotsEl.textContent = spotsLabel();
          PhoneVerify.open({
            reason: 'Account created. Now we just need to know we can text you, because that is how your confirmation and cancellation link arrive.',
            onDone: () => location.reload(),
            onSkip: () => location.reload(),
          });
          return;
        }
        location.reload();
      } catch (ex) {
        btn.disabled = false; btn.innerHTML = 'Create account and book <span class="arr">→</span>';
        const m = String(ex.message);
        err.textContent = m === 'already_registered' || /already registered|already exists/i.test(m)
          ? 'There is already an account for that email. Sign in instead.'
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
      try {
        await Auth.signIn(f.siEmail.value.trim(), f.siPass.value);
        location.reload();
      } catch (ex) {
        btn.disabled = false; btn.innerHTML = 'Sign in and book <span class="arr">→</span>';
        const m = String(ex.message);
        err.textContent = /invalid/i.test(m) ? 'That email and password combination was not recognised.'
          : /not confirmed/i.test(m) ? 'Please confirm your email first. Check your inbox for the link.' : m;
        err.hidden = false;
        f.siPass.value = '';
      }
    });
  }

  function showDone(byCredit) {
    $('evDoneMeta').textContent = `${fmtFull.format(day)} · ${time} · 1 hour`;
    $('evDoneNote').textContent = byCredit
      ? `One credit used. ${Member.credits()} left on your account. We will text you a confirmation.`
      : 'Your booking is confirmed. We will text you a confirmation.';
    $('evDone').style.display = '';
  }

  // returning from Stripe Checkout: confirm against the server, allowing a
  // few seconds for the webhook to record the booking
  async function handleReturn() {
    hideAll();
    spotsEl.textContent = 'Confirming…';
    for (let i = 0; i < 6; i++) {
      let s;
      try { s = await Store.checkoutStatus(session); } catch { break; }
      if (s.booked) {
        My.add(id);
        await Member.load().catch(() => {});
        spotsEl.textContent = 'Booked ✓';
        spotsEl.classList.add('ok');
        showDone();
        return;
      }
      if (s.refunded) {
        spotsEl.textContent = 'Refunded';
        small.style.display = '';
        small.textContent = 'That class filled up before your payment completed, so your card has been refunded in full. Pick another session on the timetable.';
        return;
      }
      if (!s.paid && i >= 1) break;   // payment abandoned or failed
      await new Promise(r => setTimeout(r, 1500));
    }
    // no confirmed payment: put the card back
    spotsEl.textContent = spotsLabel();
    if (signedIn) renderBook(); else renderAuth();
  }
  function lockCard(msg) {
    hideAll();
    small.style.display = '';
    small.textContent = msg;
    $('evBeds').classList.add('dim');
  }

  /* ---- health questionnaire and waiver (first booking per account) ---- */
  const wvOverlay = $('wvOverlay');
  let wvRetry = null;
  let wvBuilt = false;

  function buildWaiver() {
    if (wvBuilt) return;
    wvBuilt = true;
    $('wvQuestions').innerHTML = PP_WAIVER_QUESTIONS.map((q, i) => `
      <div class="wv-q">
        <p><span class="n">${i + 1}.</span>${esc(q)}</p>
        <div class="wv-yn">
          <label><input type="radio" name="q${i}" value="no" required> No</label>
          <label><input type="radio" name="q${i}" value="yes"> Yes</label>
        </div>
        <textarea name="c${i}" placeholder="If yes, please give details" maxlength="500" hidden></textarea>
      </div>`).join('');
    document.querySelectorAll('#wvQuestions input[type=radio]').forEach(r =>
      r.addEventListener('change', () => {
        const ta = document.querySelector(`#wvQuestions textarea[name=c${r.name.slice(1)}]`);
        const yes = r.form.elements['q' + r.name.slice(1)].value === 'yes';
        ta.hidden = !yes;
        ta.required = yes;
        if (!yes) ta.value = '';
      }));
    $('wvCancel').addEventListener('click', closeWaiver);
    $('wvForm').addEventListener('submit', submitWaiver);
  }

  function openWaiver(retry) {
    buildWaiver();
    wvRetry = retry;
    $('wvDate').textContent =
      new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    const nameEl = $('wvName');
    if (!nameEl.value) nameEl.value = Member.profile?.name || '';
    wvOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
    wvOverlay.scrollTop = 0;
  }

  function closeWaiver() {
    wvOverlay.hidden = true;
    document.body.style.overflow = '';
  }

  async function submitWaiver(e) {
    e.preventDefault();
    const wf = e.target;
    const btn = $('wvSubmit');
    btn.disabled = true;
    const answers = PP_WAIVER_QUESTIONS.map((q, i) => ({
      n: i + 1,
      yes: wf.elements['q' + i].value === 'yes',
      comment: wf.elements['c' + i].value.trim(),
    }));
    try {
      await Store.saveWaiver({
        email: (Auth.email() || '').trim().toLowerCase(),
        full_name: wf.wvName.value.trim(),
        emergency_contact: wf.wvEmergency.value.trim(),
        answers,
        declaration: true,
        signature: wf.wvSign.value.trim(),
      });
    } catch (err) {
      const m = String(err.message);
      if (!/duplicate|waivers_email/i.test(m)) {
        btn.disabled = false;
        alert(m.includes('rate_limited')
          ? 'Too many submissions just now. Please wait a few minutes and try again.'
          : 'Could not save the questionnaire. Please check your answers and try again.');
        return;
      }
      // a waiver already exists for this email: that is fine, carry on
    }
    Member.waiver = true;
    btn.disabled = false;
    closeWaiver();
    if (wvRetry) wvRetry();
  }

  /* ---- helpers ---- */
  function endTime(hm) {
    const [h, m] = hm.split(':').map(Number);
    const end = new Date(2000, 0, 1, h, m + 60);
    return `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
  }
  function splitTitle(full) {
    const words = full.split(' ');
    return [words.slice(0, -1).join(' '), words[words.length - 1]];
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
