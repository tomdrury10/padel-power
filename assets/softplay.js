/* ============================================================
   Padel Power · Soft play timetable (public)
   Date strip + sessions for the chosen day. Requires pilates-core.js
   (RULES, Softplay, Auth, Member). Booking happens on soft-play/book/.
   ============================================================ */
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const gbp = p => '£' + (p % 100 === 0 ? p / 100 : (p / 100).toFixed(2));
  const endOf = s => { const d = Softplay.end(s); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  let dates = [], activeDate = null;

  function renderDates() {
    $('spDates').innerHTML = dates.map(d => {
      return `<button class="pdate ${iso(d) === iso(activeDate) ? 'on' : ''}" data-d="${iso(d)}">
        <span class="dw">${fmtDay.format(d)}</span>
        <span class="dd">${fmtDate.format(d)}</span>
      </button>`;
    }).join('');
    $('spDates').querySelectorAll('.pdate').forEach(b => b.addEventListener('click', () => {
      activeDate = new Date(b.dataset.d + 'T00:00:00'); renderDates(); renderList();
    }));
  }

  function renderList() {
    $('spDayLabel').textContent = fmtFull.format(activeDate);
    const list = Softplay.forDate(iso(activeDate));
    if (!list.length) { $('spList').innerHTML = '<p class="pempty">No soft play sessions this day. Try another date.</p>'; return; }
    const sp = RULES.softplay;
    $('spList').innerHTML = list.map(s => {
      const price = Softplay.price(s);
      const spaces = Softplay.spaces(s);
      const closed = Softplay.closed(s);
      const mine = Auth.userId() && Member.hasSoftplay(s.id);
      const hire = s.mode === 'hire';
      let action;
      if (!sp.open)          action = '<span class="pfull">Opening soon</span>';
      else if (mine)         action = '<span class="pbooked">Booked ✓</span>';
      else if (!price)       action = '<span class="pfull">Price coming</span>';
      else if (spaces <= 0)  action = `<span class="pfull">${hire ? 'Taken' : 'Full'}</span>`;
      else if (closed)       action = `<span class="pfull">${Softplay.hoursLeft(s) < RULES.joinCutoffHours ? 'Bookings closed' : 'Closed · not enough booked'}</span>`;
      else                   action = `<a class="btn btn-blue pbook" href="book/?session=${s.id}">Book <span class="arr">→</span></a>`;
      const spots = hire
        ? (s.bookings ? 'Already hired' : `Whole space · up to ${s.capacity} children`)
        : (spaces > 0 ? `${spaces} of ${s.capacity} places left` : 'Fully booked');
      return `
      <div class="pclass ${(!sp.open || spaces <= 0 || closed) && !mine ? 'off' : ''}">
        <div class="pc-time"><b>${s.time}</b><span>${s.duration} min</span></div>
        <div class="pc-info">
          <div class="pc-name">${hire ? 'Hire the space' : 'Supervised session'} <span class="pc-level">${hire ? 'You supervise' : 'Staff supervised'}</span></div>
          <div class="pc-desc">${s.time} to ${endOf(s)} · ${hire
            ? `${gbp(sp.hirePrice)} per child per hour, a parent or carer stays in the soft play`
            : `run by our team, needs ${sp.minChildren} children booked to go ahead`}${s.notes ? ' · ' + esc(s.notes) : ''}</div>
        </div>
        <div class="pc-right">
          <div class="pc-spots ${!hire && spaces > 0 && spaces <= 2 ? 'low' : ''}">${price ? gbp(price) + ' per child · ' : ''}${spots}</div>
          ${action}
        </div>
      </div>`;
    }).join('');
  }

  function renderStrip() {
    const el = $('spStrip');
    if (!RULES.softplay.open) {
      el.innerHTML = '<span>Soft play is opening soon. Sessions appear here as they are added and booking switches on with the doors.</span><a href="https://wa.me/447595250776" target="_blank" rel="noopener">Ask on WhatsApp →</a>';
      return;
    }
    if (Auth.userId()) {
      const who = Member.profile?.name?.split(' ')[0] || Auth.email();
      el.innerHTML = `<span>Signed in as <b>${esc(who)}</b></span><a href="../account/">My account →</a>`;
    } else {
      el.innerHTML = '<span>Booking needs a quick account. Sign in or create one on the next step.</span><a href="../account/">Sign in →</a>';
    }
  }

  ppReady.then(async () => {
    dates = bookableDates();
    activeDate = dates[0];
    await Softplay.load(iso(dates[0]), iso(dates[dates.length - 1]));
    if (Auth.userId()) await Member.load().catch(() => {});
    const sp = RULES.softplay;
    $('spNote').textContent = `Supervised sessions need ${sp.minChildren} children booked to go ahead and take up to ${sp.maxChildren}. If one is not going ahead you'll get a text ${RULES.cutoffHours} hours before the start and a full refund. Ages ${sp.minAge} to ${sp.maxAge}.`;
    renderStrip(); renderDates(); renderList();
  }).catch(() => {
    $('spList').innerHTML = '<p class="pempty">The booking system is temporarily unavailable. Please try again shortly, or message us on WhatsApp.</p>';
  });
})();
