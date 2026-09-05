/* ============================================================
   Padel Power · Reformer Pilates — class event page
   Reads ?date=YYYY-MM-DD&time=HH:MM&type=key, validates against
   the timetable and renders the class. Requires pilates-core.js.
   ============================================================ */

(async function () {
  const q = new URLSearchParams(location.search);
  const date = q.get('date'), time = q.get('time'), type = q.get('type');

  const grid = document.getElementById('evGrid');
  const missing = document.getElementById('evMissing');
  const fail = () => { grid.style.display = 'none'; missing.style.display = ''; };

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
  document.getElementById('evDate').textContent = `${fmtFull.format(day)} · ${time}`;
  document.getElementById('evTitle').innerHTML = `${esc(name)}<br><span class="blue">${esc(accent)}</span>`;
  document.getElementById('evMeta').innerHTML = [
    `${time} to ${endTime(time)}`,
    '1 hour',
    t.level,
    `${RULES.maxRiders} beds`,
  ].map(x => `<span>${x}</span>`).join('');
  if (slot.instructor) {
    document.getElementById('evInstructor').innerHTML = `${esc(slot.instructor)}<br><em>Reformer instructor</em>`;
    document.getElementById('evInstructorFact').style.display = '';
  }
  document.getElementById('evDesc').textContent = t.desc
    + (slot.instructor
      ? ` Led by ${slot.instructor} in the brand-new studio, with never more than eight people in the room.`
      : ' Led by our reformer instructors in the brand-new studio, with never more than eight people in the room.');

  // bed dots
  document.getElementById('evBeds').innerHTML = Array.from({ length: RULES.maxRiders },
    (_, i) => `<i class="${i < booked ? 'taken' : ''}"></i>`).join('');

  const spotsEl = document.getElementById('evSpots');
  const form = document.getElementById('evForm');
  const small = document.querySelector('.ev-small');

  if (session) {
    handleReturn();
  } else if (Store.mine(id)) {
    spotsEl.textContent = 'Booked ✓';
    spotsEl.classList.add('ok');
    form.style.display = 'none'; small.style.display = 'none';
    showDone();
  } else if (spots <= 0) {
    spotsEl.textContent = 'Fully booked';
    lockCard('This class is full. Pick another session on the timetable.');
  } else if (closed) {
    spotsEl.textContent = 'Booking closed';
    lockCard('Bookings close 24 hours before class so instructors know who’s coming. Pick a later session.');
  } else {
    spotsEl.textContent = (price ? `${gbp(price)} · ` : '') + `${spots} of ${RULES.maxRiders} beds left`;
    if (spots <= 2) spotsEl.classList.add('low');
    if (price) {
      const btn = form.querySelector('button[type=submit]');
      btn.innerHTML = `Book and pay ${gbp(price)} <span class="arr">→</span>`;
      small.textContent = 'Secure card payment. Cancel up to 24 hours before class.';
    }
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    if (f.evWebsite.value) { form.style.display = 'none'; small.style.display = 'none'; showDone(); return; }
    btn.disabled = true;
    const person = { name: f.evName.value, email: f.evEmail.value, phone: `${f.evCode.value} ${f.evPhone.value.trim().replace(/^0+/, '')}` };
    try {
      if (price) {
        btn.textContent = 'Taking you to payment…';
        const { url } = await Store.checkout(id, person);
        location.href = url;
        return;
      }
      await Store.book(id, person);
      form.style.display = 'none'; small.style.display = 'none';
      showDone();
    } catch (err) {
      btn.disabled = false;
      if (price) btn.innerHTML = `Book and pay ${gbp(price)} <span class="arr">→</span>`;
      const msg = String(err.message);
      if (msg.includes('waiver_required')) {
        openWaiver(person, () => form.requestSubmit());
      } else if (msg.includes('class_full')) {
        alert('Sorry, that class has just filled up. Pick another session on the timetable.');
        location.href = '../pilates/#book';
      } else if (msg.includes('payment_required')) {
        alert('This class is now paid at booking. Reload the page to continue.');
        location.reload();
      } else if (msg.includes('payments_not_configured')) {
        alert('Online payment is not available right now. Please call the club to book.');
      } else {
        alert('Something went wrong saving your booking. Please try again.');
      }
    }
  });

  function showDone() {
    document.getElementById('evDoneMeta').textContent = `${fmtFull.format(day)} · ${time} · 1 hour`;
    document.getElementById('evDone').style.display = '';
  }

  // returning from Stripe Checkout: confirm against the server, allowing a
  // few seconds for the webhook to record the booking
  async function handleReturn() {
    form.style.display = 'none'; small.style.display = 'none';
    spotsEl.textContent = 'Confirming…';
    for (let i = 0; i < 6; i++) {
      let s;
      try { s = await Store.checkoutStatus(session); } catch { break; }
      if (s.booked) {
        My.add(id);
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
    // no confirmed payment: put the form back
    form.style.display = ''; small.style.display = '';
    spotsEl.textContent = (price ? `${gbp(price)} · ` : '') + `${spots} of ${RULES.maxRiders} beds left`;
    if (price) small.textContent = 'Secure card payment. Cancel up to 24 hours before class.';
  }
  function lockCard(msg) {
    form.style.display = 'none';
    small.textContent = msg;
    document.getElementById('evBeds').classList.add('dim');
  }

  /* ---- health questionnaire and waiver (first booking per email) ---- */
  const wvOverlay = document.getElementById('wvOverlay');
  let wvRetry = null;
  let wvBuilt = false;

  function buildWaiver() {
    if (wvBuilt) return;
    wvBuilt = true;
    document.getElementById('wvQuestions').innerHTML = PP_WAIVER_QUESTIONS.map((q, i) => `
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
    document.getElementById('wvCancel').addEventListener('click', closeWaiver);
    document.getElementById('wvForm').addEventListener('submit', submitWaiver);
  }

  function openWaiver(person, retry) {
    buildWaiver();
    wvRetry = retry;
    wvPerson = person;
    document.getElementById('wvDate').textContent =
      new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
    const nameEl = document.getElementById('wvName');
    if (!nameEl.value) nameEl.value = person.name || '';
    wvOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
    wvOverlay.scrollTop = 0;
  }
  let wvPerson = null;

  function closeWaiver() {
    wvOverlay.hidden = true;
    document.body.style.overflow = '';
  }

  async function submitWaiver(e) {
    e.preventDefault();
    const wf = e.target;
    const btn = document.getElementById('wvSubmit');
    btn.disabled = true;
    const answers = PP_WAIVER_QUESTIONS.map((q, i) => ({
      n: i + 1,
      yes: wf.elements['q' + i].value === 'yes',
      comment: wf.elements['c' + i].value.trim(),
    }));
    try {
      await Store.saveWaiver({
        email: (wvPerson.email || '').trim().toLowerCase(),
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
  function esc(s) { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
