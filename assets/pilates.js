/* ============================================================
   Padel Power · Reformer Pilates — timetable widget
   Requires pilates-core.js (config + Store + helpers).
   Book buttons link to book.html, the class's own event page.
   ============================================================ */

const dateStrip = document.getElementById('dateStrip');
const classList = document.getElementById('classList');
let dates = [];        // filled once ppReady has loaded the real opening date
let activeDate = null;

function renderDates() {
  dateStrip.innerHTML = dates.map((d, i) => `
    <button class="pdate ${iso(d) === iso(activeDate) ? 'on' : ''}" data-i="${i}">
      <span class="dw">${fmtDay.format(d)}</span>
      <span class="dd">${fmtDate.format(d)}</span>
    </button>`).join('');
  dateStrip.querySelectorAll('.pdate').forEach(btn =>
    btn.addEventListener('click', () => { activeDate = dates[+btn.dataset.i]; renderDates(); renderClasses(); }));
}

function renderClasses() {
  const day = classesFor(activeDate);
  document.getElementById('classDayLabel').textContent = fmtFull.format(activeDate);
  if (!day.length) {
    classList.innerHTML = '<p class="pempty">No classes scheduled this day.</p>';
    return;
  }
  classList.innerHTML = day.map(({ time, type: typeKey, instructor }) => {
    const t = CLASS_TYPES[typeKey];
    const id = `${iso(activeDate)}_${time}`;
    const spots = RULES.maxRiders - Store.count(id);
    const closed = withinCutoff(id);
    const mine = Store.mine(id);
    let action;
    if (mine)            action = '<span class="pbooked">Booked ✓</span>';
    else if (spots <= 0) action = '<span class="pfull">Class full</span>';
    else if (closed)     action = '<span class="pfull">Closed · book 24h ahead</span>';
    else                 action = `<a class="btn btn-blue pbook" href="../book/?date=${iso(activeDate)}&time=${time}&type=${typeKey}">Book <span class="arr">→</span></a>`;
    return `
    <div class="pclass ${spots <= 0 || closed ? 'off' : ''}">
      <div class="pc-time"><b>${time}</b><span>1 hour</span></div>
      <div class="pc-info">
        <div class="pc-name">${t.name} <span class="pc-level">${t.level}</span></div>
        <div class="pc-desc">${instructor ? `With ${instructor} · ` : ''}${t.desc}</div>
      </div>
      <div class="pc-right">
        <div class="pc-spots ${spots > 0 && spots <= 2 ? 'low' : ''}">${spots > 0 ? `${spots} of ${RULES.maxRiders} beds left` : 'Fully booked'}</div>
        ${action}
      </div>
    </div>`;
  }).join('');
}

ppReady.then(() => {
  dates = bookableDates();
  activeDate = dates[0];
  renderDates();
  renderClasses();
}).catch(() => {
  classList.innerHTML = '<p class="pempty">The booking system is temporarily unavailable. Please try again shortly, or message us on WhatsApp.</p>';
});
