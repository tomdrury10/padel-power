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
  document.getElementById('evDesc').textContent = t.desc + ' Led by our reformer instructors in the brand-new studio, with never more than eight people in the room.';

  // bed dots
  document.getElementById('evBeds').innerHTML = Array.from({ length: RULES.maxRiders },
    (_, i) => `<i class="${i < booked ? 'taken' : ''}"></i>`).join('');

  const spotsEl = document.getElementById('evSpots');
  const form = document.getElementById('evForm');
  const small = document.querySelector('.ev-small');

  if (Store.mine(id)) {
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
    spotsEl.textContent = `${spots} of ${RULES.maxRiders} beds left`;
    if (spots <= 2) spotsEl.classList.add('low');
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await Store.book(id, { name: f.evName.value, email: f.evEmail.value, phone: `${f.evCode.value} ${f.evPhone.value.trim().replace(/^0+/, '')}` });
      form.style.display = 'none'; small.style.display = 'none';
      showDone();
    } catch (err) {
      btn.disabled = false;
      if (String(err.message).includes('class_full')) {
        alert('Sorry, that class has just filled up. Pick another session on the timetable.');
        location.href = 'pilates.html#book';
      } else {
        alert('Something went wrong saving your booking. Please try again.');
      }
    }
  });

  function showDone() {
    document.getElementById('evDoneMeta').textContent = `${fmtFull.format(day)} · ${time} · 1 hour`;
    document.getElementById('evDone').style.display = '';
  }
  function lockCard(msg) {
    form.style.display = 'none';
    small.textContent = msg;
    document.getElementById('evBeds').classList.add('dim');
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
