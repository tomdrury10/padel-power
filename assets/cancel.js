/* ============================================================
   Padel Power · self-service booking cancellation
   Reads ?b=<cancel token> from the confirmation text message.
   No account needed: the token authenticates the booking.
   Requires pilates-core.js (ppFn); does not wait for ppReady.
   ============================================================ */

(async function () {
  const token = new URLSearchParams(location.search).get('b') || '';
  const show = id => {
    ['cnLoading', 'cnCard', 'cnDone', 'cnBlocked'].forEach(x => {
      document.getElementById(x).style.display = x === id ? '' : 'none';
    });
  };
  const el = id => document.getElementById(id);

  function blocked(title, desc, showCall) {
    el('cnBlockedTitle').innerHTML = title;
    el('cnBlockedDesc').textContent = desc;
    if (!showCall) el('cnBlocked').querySelector('a.btn-blue').style.display = 'none';
    show('cnBlocked');
  }

  const money = p => '£' + (p % 100 === 0 ? p / 100 : (p / 100).toFixed(2));
  const fmtDay = d => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    .format(new Date(d + 'T00:00:00'));

  if (!token) return blocked('Link<br><span class="outline">not right</span>', 'That cancellation link is incomplete. Open the link from your confirmation text, or call the club and we will sort it.', true);

  let s;
  try {
    s = await ppFn(`cancel-booking?t=${encodeURIComponent(token)}`);
  } catch (err) {
    if (String(err.message) === 'invalid_link') {
      return blocked('Booking<br><span class="outline">not found</span>', 'That cancellation link does not match a booking. Open the link from your confirmation text, or call the club and we will sort it.', true);
    }
    return blocked('Something<br><span class="outline">went wrong</span>', 'We could not look up your booking just now. Please try again in a minute, or call the club.', true);
  }

  const when = `${fmtDay(s.date)} · ${s.time}`;

  if (s.cancelled) {
    el('cnDoneDate').textContent = when;
    el('cnDoneDesc').textContent = 'This booking has already been cancelled. Nothing more to do.';
    return show('cnDone');
  }
  if (s.past) {
    return blocked('This class has<br><span class="outline">already run</span>', 'This booking is in the past, so there is nothing to cancel.', false);
  }
  if (s.within_cutoff) {
    return blocked('Too late to<br><span class="outline">cancel online</span>', `Online cancellation closes ${s.cutoff_hours} hours before class so instructors know who is coming. If you cannot make it, call the club and we will do what we can.`, true);
  }

  el('cnDate').textContent = when;
  el('cnDesc').textContent = `Hi ${s.name}. This cancels your bed in ${s.class_name} on ${fmtDay(s.date)} at ${s.time}.`;
  el('cnNote').textContent = s.paid && s.amount_pence
    ? `Your ${money(s.amount_pence)} payment will be refunded to your card. Refunds usually appear within 5 to 10 working days.`
    : '';
  show('cnCard');

  el('cnConfirm').addEventListener('click', async () => {
    const btn = el('cnConfirm');
    btn.disabled = true;
    btn.textContent = 'Cancelling…';
    try {
      const r = await ppFn('cancel-booking', { method: 'POST', body: JSON.stringify({ token }) });
      el('cnDoneDate').textContent = when;
      if (r.refunded && s.amount_pence) {
        el('cnDoneDesc').textContent = `Your bed has been freed up and ${money(s.amount_pence)} is on its way back to your card. Refunds usually appear within 5 to 10 working days.`;
      }
      show('cnDone');
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Cancel my booking';
      const msg = String(err.message);
      if (msg === 'cutoff') {
        blocked('Too late to<br><span class="outline">cancel online</span>', `Online cancellation closes ${s.cutoff_hours} hours before class. If you cannot make it, call the club.`, true);
      } else if (msg === 'refund_unavailable' || msg === 'refund_failed') {
        blocked('We need to do<br><span class="outline">this one by phone</span>', 'We could not process your refund automatically, so your booking has not been cancelled. Call the club and we will cancel and refund it for you.', true);
      } else {
        alert('Could not cancel the booking just now. Please try again.');
      }
    }
  });
})();
