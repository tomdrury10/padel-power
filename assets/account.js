/* ============================================================
   Padel Power · member account
   Sign in / create account / reset password, then: credits and
   packs, upcoming bookings (with cancel), history, details.
   Requires pilates-core.js (Auth, Member, Store, RULES).
   ============================================================ */

(async function () {
  const $ = id => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtWhen = d => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const fmtLong = d => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const show = id => {
    ['acLoading', 'acAuth', 'acRecover', 'acHome'].forEach(x => { $(x).hidden = x !== id; });
  };

  // tokens in the hash: confirmation, magic link or password recovery
  const arrived = Auth.adoptHashSession();

  try { await ppReady; } catch {
    show('acAuth');
    notice('The booking system is temporarily unavailable. Please try again shortly.');
    return;
  }

  if (arrived === 'recovery') return renderRecover();
  if (Auth.userId()) return renderHome();
  renderAuth();

  /* ================= signed out ================= */
  function renderAuth() {
    show('acAuth');
    const card = $('acAuth');
    const tabs = card.querySelectorAll('.ev-tab');
    const panes = { in: $('acSignIn'), up: $('acSignUp'), reset: $('acReset') };
    const pick = which => {
      tabs.forEach(b => b.classList.toggle('on', b.dataset.tab === which));
      Object.entries(panes).forEach(([k, el]) => { el.hidden = k !== which; });
      $('acNotice').hidden = true;
    };
    tabs.forEach(b => b.addEventListener('click', () => pick(b.dataset.tab)));
    card.querySelectorAll('[data-tab="in"].ev-forgot').forEach(b => b.addEventListener('click', () => pick('in')));
    $('acForgotLink').addEventListener('click', () => pick('reset'));
    pick(q.get('reset') ? 'reset' : q.get('signup') ? 'up' : 'in');

    panes.in.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('button[type=submit]'), err = $('siError');
      err.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        await Auth.signIn(f.siEmail.value.trim(), f.siPass.value);
        location.replace(location.pathname);
      } catch (ex) {
        btn.disabled = false; btn.innerHTML = 'Sign in <span class="arr">→</span>';
        const m = String(ex.message);
        err.textContent = /invalid/i.test(m) ? 'That email and password combination was not recognised.'
          : /not confirmed/i.test(m) ? 'Please confirm your email first. Check your inbox for the link.' : m;
        err.hidden = false; f.siPass.value = '';
      }
    });

    panes.up.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('button[type=submit]'), err = $('suError');
      if (f.suWebsite.value) return;
      err.hidden = true; btn.disabled = true; btn.textContent = 'Creating your account…';
      const phone = `${f.suCode.value} ${f.suPhone.value.trim().replace(/^0+/, '')}`;
      try {
        const r = await Auth.signUp(f.suEmail.value.trim().toLowerCase(), f.suPass.value, { name: f.suName.value.trim(), phone });
        if (r.confirm) {
          Object.values(panes).forEach(el => { el.hidden = true; });
          notice(`<h3>Check your inbox</h3><p>We have sent a confirmation link to <b>${esc(f.suEmail.value.trim())}</b>. Tap it and you will land back here, signed in.</p><p class="dim">No email after a minute? Check your junk folder, or message us on WhatsApp.</p>`);
          return;
        }
        location.replace(location.pathname);
      } catch (ex) {
        btn.disabled = false; btn.innerHTML = 'Create account <span class="arr">→</span>';
        const m = String(ex.message);
        err.textContent = m === 'already_registered' || /already registered|already exists/i.test(m)
          ? 'There is already an account for that email. Sign in instead.'
          : /password/i.test(m) ? 'Password needs to be at least 8 characters.' : m;
        err.hidden = false;
      }
    });

    panes.reset.addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('button[type=submit]'), err = $('rsError');
      err.hidden = true; btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await Auth.requestPasswordReset(f.rsEmail.value.trim().toLowerCase());
        Object.values(panes).forEach(el => { el.hidden = true; });
        notice(`<h3>Check your inbox</h3><p>If there is an account for <b>${esc(f.rsEmail.value.trim())}</b> we have sent a link to choose a new password.</p>`);
      } catch (ex) {
        btn.disabled = false; btn.innerHTML = 'Send reset link <span class="arr">→</span>';
        err.textContent = /rate/i.test(String(ex.message)) ? 'Please wait a minute before requesting another link.' : 'Could not send the link just now. Please try again.';
        err.hidden = false;
      }
    });
  }

  function notice(html) {
    const n = $('acNotice');
    n.innerHTML = html;
    n.hidden = false;
  }

  /* ================= password recovery ================= */
  function renderRecover() {
    show('acRecover');
    $('acNewPass').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target, btn = f.querySelector('button[type=submit]'), err = $('npError');
      err.hidden = true;
      if (f.npPass.value !== f.npConfirm.value) { err.textContent = 'Those passwords do not match.'; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await Auth.setPassword(f.npPass.value);
        await Auth.loadUser();
        location.replace(location.pathname + '?saved=password');
      } catch (ex) {
        btn.disabled = false; btn.innerHTML = 'Save password <span class="arr">→</span>';
        err.textContent = /signed_out|JWT|expired/i.test(String(ex.message))
          ? 'That reset link has expired. Request a new one.' : String(ex.message);
        err.hidden = false;
      }
    });
  }

  /* ================= signed in ================= */
  async function renderHome() {
    if (!Auth.email()) await Auth.loadUser().catch(() => {});
    if (!Member.loaded) await Member.load().catch(() => {});
    show('acHome');

    const first = (Member.profile?.name || '').split(' ')[0];
    $('acTitle').innerHTML = first ? `Hi<br><span class="blue">${esc(first)}</span>` : `Your<br><span class="blue">account</span>`;
    $('acEmail').textContent = Auth.email() || '';
    $('acStaffNote').hidden = !Auth.isStaff();

    if (q.get('saved') === 'password') flash('Your new password is saved.');
    if (q.get('pack_session')) await confirmPack(q.get('pack_session'));

    renderVerify();
    renderCredits();
    renderBookings();
    renderDetails();

    // arrived from signup with the number still unproved: get it done now
    if (Member.needsPhone() && q.get('verify') === '1') openVerify();

    $('acSignOut').addEventListener('click', () => { Auth.signOut(); location.replace('../pilates/#book'); });
  }

  function flash(msg) {
    const f = $('acFlash');
    f.textContent = msg; f.hidden = false;
    history.replaceState(null, '', location.pathname + location.hash);
  }

  /* ---- mobile verification ---- */
  function openVerify() {
    PhoneVerify.open({
      reason: 'We text your booking confirmation and your cancellation link, so we need to know the number works.',
      onDone: () => { renderVerify(); renderDetails(); flash('Mobile verified. You are all set to book.'); },
      onSkip: () => renderVerify(),
    });
  }

  function renderVerify() {
    const card = $('acVerify');
    if (!Member.needsPhone()) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    $('acVerifyPhone').textContent = Member.profile?.phone || 'No number on your account';
    const btn = $('acVerifyBtn');
    btn.disabled = !Member.profile?.phone;
    btn.onclick = openVerify;
  }

  /* ---- credits ---- */
  function renderCredits() {
    const credits = Member.credits();
    $('acCredits').textContent = credits;
    $('acCreditsLabel').textContent = credits === 1 ? 'credit left' : 'credits left';
    const exp = Member.nextExpiry();
    $('acCreditsNote').textContent = credits
      ? `Use them on any reformer class. Next expiry ${fmtLong(new Date(exp))}.`
      : `Buy a pack and book with one tap: pay for ${RULES.packCredits - 1}, get ${RULES.packCredits}.`;
    const per = Math.round(RULES.packPrice / RULES.packCredits) / 100;
    $('acBuy').innerHTML = `${credits ? 'Top up: ' : ''}${RULES.packCredits} classes for ${gbp(RULES.packPrice)} <span class="arr">→</span>`;
    $('acPackFine').textContent = `That is £${per % 1 ? per.toFixed(2) : per} a class. Credits last ${RULES.packMonths} months from purchase. Cancel a class up to 24 hours ahead and the credit comes straight back.`;

    $('acPacks').innerHTML = Member.packs.length ? Member.packs.map(p => {
      const now = Date.now();
      const state = p.left === 0 ? 'Used up' : p.expiresAt < now ? 'Expired' : `${p.left} of ${p.total} left`;
      return `
      <div class="ac-item ${p.left === 0 || p.expiresAt < now ? 'dim' : ''}">
        <div><b>${p.total} class pack</b><span>Bought ${fmtWhen(new Date(p.purchasedAt))} · ${p.expiresAt < now ? 'expired' : 'expires'} ${fmtWhen(new Date(p.expiresAt))}${p.note ? ' · ' + esc(p.note) : ''}</span></div>
        <span class="ac-tag">${state}</span>
      </div>`;
    }).join('') : '';

    $('acBuy').onclick = async () => {
      const btn = $('acBuy');
      btn.disabled = true; btn.textContent = 'Taking you to payment…';
      try {
        const { url } = await Store.buyPack(location.origin + location.pathname);
        location.href = url;
      } catch (err) {
        btn.disabled = false; renderCredits();
        const m = String(err.message);
        alert(m.includes('payments_not_configured') ? 'Online payment is not available right now. Please call the club.'
          : m.includes('account_required') ? 'Please sign in again.' : 'Could not start the payment. Please try again.');
      }
    };
  }

  // back from Stripe: wait for the webhook to credit the pack
  async function confirmPack(sessionId) {
    for (let i = 0; i < 8; i++) {
      let s;
      try { s = await Store.checkoutStatus(sessionId); } catch { break; }
      if (s.credited) {
        await Member.load().catch(() => {});
        flash(`${s.credits} class credits added to your account. They are valid until ${fmtLong(new Date(s.expires_at))}.`);
        return;
      }
      if (!s.paid && i >= 1) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    flash('We are still confirming your payment. Your credits will appear here in a moment; refresh if they have not.');
  }

  /* ---- bookings ---- */
  function bookingRow(b, upcoming) {
    const start = classStart(b.classId);
    const [, time] = b.classId.split('_');
    const paid = b.paidWith === 'credit' ? '1 credit' : b.paid && b.amount ? gbp(b.amount) : 'Reserved';
    let status = '';
    if (b.cancelledAt) status = b.refunded ? 'Cancelled · refunded' : b.paidWith === 'credit' ? 'Cancelled · credit returned' : 'Cancelled';
    else if (!upcoming) status = 'Attended';
    const canCancel = upcoming && !withinCutoff(b.classId);
    return `
    <div class="ac-item ${b.cancelledAt ? 'dim' : ''}">
      <div>
        <b>${esc(b.classType || 'Reformer Pilates')}</b>
        <span>${fmtWhen(start)} · ${time} · ${paid}${status ? ' · ' + status : ''}</span>
      </div>
      ${upcoming && !b.cancelledAt
        ? (canCancel
          ? `<button class="ac-cancel" data-id="${b.id}">Cancel</button>`
          : `<span class="ac-tag">Within 24h</span>`)
        : ''}
    </div>`;
  }

  function renderBookings() {
    const up = Member.upcoming();
    $('acUpcoming').innerHTML = up.length
      ? up.map(b => bookingRow(b, true)).join('')
      : `<p class="ac-empty">Nothing booked yet. <a href="../pilates/#book">Pick a class</a>.</p>`;
    const past = Member.past();
    $('acPast').innerHTML = past.length
      ? past.slice(0, 30).map(b => bookingRow(b, false)).join('')
      : '<p class="ac-empty">Your past classes will show here.</p>';

    $('acUpcoming').querySelectorAll('.ac-cancel').forEach(btn => btn.addEventListener('click', async () => {
      const b = Member.bookings.find(x => x.id === btn.dataset.id);
      const what = b.paidWith === 'credit' ? 'Your credit goes back on your account.'
        : b.paid && b.amount ? `${gbp(b.amount)} will be refunded to your card within 5 to 10 working days.` : '';
      if (!confirm(`Cancel your bed on ${fmtWhen(classStart(b.classId))} at ${b.classId.split('_')[1]}? ${what}`)) return;
      btn.disabled = true; btn.textContent = 'Cancelling…';
      try {
        await Store.cancelMine(b.id);
        flash(b.paidWith === 'credit' ? 'Booking cancelled and your credit is back on your account.'
          : b.paid ? 'Booking cancelled. Your refund is on its way.' : 'Booking cancelled.');
        renderCredits(); renderBookings();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Cancel';
        const m = String(err.message);
        alert(m === 'cutoff' ? 'Online cancellation closes 24 hours before class. Call the club and we will do what we can.'
          : m === 'refund_failed' || m === 'refund_unavailable' ? 'We could not process the refund automatically, so the booking is still active. Call the club and we will sort it.'
          : 'Could not cancel just now. Please try again.');
      }
    }));
  }

  /* ---- details, waiver, password ---- */
  function renderDetails() {
    const f = $('acProfile');
    f.pfName.value = Member.profile?.name || '';
    const [dial, national] = splitDial(Member.profile?.phone || '');
    f.pfCode.value = dial;
    f.pfPhone.value = national;
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await Member.saveProfile({
          name: f.pfName.value.trim(),
          phone: joinDial(f.pfCode.value, f.pfPhone.value),
        });
        $('pfSaved').hidden = false; setTimeout(() => { $('pfSaved').hidden = true; }, 2500);
        const first = f.pfName.value.trim().split(' ')[0];
        if (first) $('acTitle').innerHTML = `Hi<br><span class="blue">${esc(first)}</span>`;
        renderVerify();
        renderDetails();
        if (Member.needsPhone()) flash('Details saved. That is a new number, so it needs verifying before your next booking.');
      } catch { alert('Could not save your details. Please try again.'); }
      btn.disabled = false;
    });

    $('acPhoneTag').innerHTML = Member.profile?.verifiedAt
      ? `<span class="ac-tag ok">Mobile verified</span>`
      : RULES.requirePhone
        ? `<span class="ac-tag warn">Mobile not verified</span>`
        : `<span class="ac-tag">Mobile not verified</span>`;

    $('acWaiver').innerHTML = Member.waiver
      ? `<span class="ac-tag ok">Health questionnaire signed</span><p class="ac-fine">Tell your instructor if anything changes: injuries, pregnancy or a new medical condition.</p>`
      : `<span class="ac-tag">Health questionnaire not yet signed</span><p class="ac-fine">You will be asked to complete it on your first booking. It takes two minutes and we only ask once.</p>`;

    $('acPass').addEventListener('submit', async e => {
      e.preventDefault();
      const pf = e.target;
      if (pf.cpNew.value !== pf.cpConfirm.value) { alert('Those passwords do not match.'); return; }
      const btn = pf.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await Auth.setPassword(pf.cpNew.value);
        pf.reset();
        $('cpSaved').hidden = false; setTimeout(() => { $('cpSaved').hidden = true; }, 2500);
      } catch (ex) { alert('Could not update the password. ' + String(ex.message)); }
      btn.disabled = false;
    });
  }
})();
