/* ============================================================
   Padel Power · league registration
   Sign in, pick a league, give a Playtomic link, see the weekly
   price, save a card on Stripe. Doubles players get a partner code.
   Requires pilates-core.js (Auth, Member, ppApi, ppFn, RULES) and
   phone-verify.js.
   ============================================================ */
(async function () {
  const $ = id => document.getElementById(id);
  const q = new URLSearchParams(location.search);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const gbp = p => '£' + (p % 100 === 0 ? p / 100 : (p / 100).toFixed(2));
  const fmtLong = iso => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso + 'T12:00:00'));
  const show = id => ['lgLoading', 'lgAuth', 'lgForm', 'lgMine'].forEach(x => { $(x).hidden = x !== id; });
  const partnerCode = (q.get('partner') || '').trim().toLowerCase();

  try { await ppReady; } catch { show('lgAuth'); return; }

  // ---- signed out: send them through the account page and back here ----
  if (!Auth.userId()) {
    const back = encodeURIComponent(location.pathname + (partnerCode ? `?partner=${partnerCode}` : ''));
    $('lgSignIn').href = `../../account/?next=${back}`;
    $('lgSignUp').href = `../../account/?signup=1&next=${back}`;
    show('lgAuth');
    return;
  }

  const leagues = await ppApi('leagues?select=*&order=sort');
  const open = l => l.registration_open && l.member_price_pence && l.nonmember_price_pence && l.season_start && l.weeks;
  let mine = await loadMine();

  // returning from Stripe, or already registered and not asking for another
  if (q.get('done') || (mine.length && !q.get('new') && !partnerCode)) return renderMine();
  renderForm();

  /* ================= the form ================= */
  function renderForm() {
    show('lgForm');
    const sel = $('lgLeague');
    sel.innerHTML = '<option value="">Choose a league</option>' + leagues.map(l =>
      `<option value="${l.id}"${open(l) ? '' : ' disabled'}>${esc(l.name)}${open(l) ? '' : ' (registration closed)'}</option>`).join('');
    // ?league=mens-doubles from the league cards picks that league for them
    const want = (q.get('league') || '').toLowerCase();
    const slug = n => String(n).toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-');
    const pre = want && leagues.find(l => slug(l.name).startsWith(want));
    if (pre && open(pre)) sel.value = pre.id;
    if (partnerCode) {
      $('lgCode').value = partnerCode;
      $('lgPartnerNote').textContent = 'You have a partner code, so pick the same league your partner chose and we will pair you up.';
      $('lgPartnerNote').hidden = false;
    }
    const syncKind = () => {
      const l = leagues.find(x => x.id === sel.value);
      $('lgCodeRow').hidden = !(l && l.kind === 'doubles');
    };
    sel.addEventListener('change', syncKind); syncKind();

    let quote = null;
    $('lgRegForm').addEventListener('submit', async e => {
      e.preventDefault();
      const err = $('lgError'); err.hidden = true;
      const l = leagues.find(x => x.id === sel.value);
      if (!l) return;
      if (!/^https:\/\/([a-z0-9-]+\.)*playtomic\.(io|com)\/profile\/user\/[A-Za-z0-9-]+/i.test($('lgPlaytomic').value.trim())) {
        err.textContent = 'That does not look like a Playtomic profile link. Open your profile in the Playtomic app, tap Share, and paste the link. It contains /profile/user/.';
        err.hidden = false; return;
      }
      if (!(await phoneReady())) return;
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        quote = await ppFn('league-register', { method: 'POST', body: JSON.stringify({ action: 'quote', league_id: l.id, playtomic_url: $('lgPlaytomic').value.trim() }) });
        showQuote(l, quote);
      } catch (ex) {
        err.textContent = friendly(ex.message); err.hidden = false;
      }
      btn.disabled = false;
    });

    function showQuote(l, qt) {
      $('lgRegForm').hidden = true;
      $('lgQuote').hidden = false;
      const first = qt.first_payment_date ? fmtLong(qt.first_payment_date) : 'today';
      $('lgQuoteList').innerHTML = `
        <dt>League</dt><dd>${esc(l.name)}</dd>
        <dt>Membership</dt><dd>${qt.membership_status === 'member' ? 'Club member' : qt.membership_status === 'review' ? 'Not found on Playtomic, non-member price for now' : 'Non-member'}${qt.playtomic_found === false ? '<br><small>We could not find that Playtomic profile at Padel Power. Check the link, or carry on and the studio will review it.</small>' : ''}</dd>
        <dt>Weekly fee</dt><dd class="big">${gbp(qt.weekly_price_pence)}</dd>
        <dt>First payment</dt><dd>${first}</dd>
        <dt>Then</dt><dd>every week for ${qt.weeks} weeks, ${qt.payments_total} payments in total</dd>
        <dt>Last payment</dt><dd>${fmtLong(qt.last_payment_date)}</dd>`;
      $('lgConsentText').textContent =
        `I agree to Padel Power taking ${gbp(qt.weekly_price_pence)} from my card every week for ${qt.weeks} weeks, starting ${first}, for the ${l.name} league. My card may be charged automatically without me being present. The weekly fee is fixed for the season. If a payment fails I will be asked to update my card. I have read the league rules.`;
      $('lgAgree').checked = false; $('lgGo').disabled = true;
      $('lgAgree').onchange = () => { $('lgGo').disabled = !$('lgAgree').checked; };
      $('lgBack').onclick = () => { $('lgQuote').hidden = true; $('lgRegForm').hidden = false; };
      $('lgGo').onclick = async () => {
        const err = $('lgQuoteError'); err.hidden = true;
        $('lgGo').disabled = true; $('lgGo').textContent = 'Opening Stripe…';
        try {
          const r = await ppFn('league-register', { method: 'POST', body: JSON.stringify({
            action: 'register', league_id: l.id,
            playtomic_url: $('lgPlaytomic').value.trim(),
            partner_code: $('lgCode').value.trim() || null,
            return_url: location.origin + location.pathname,
          }) });
          location.href = r.url;
        } catch (ex) {
          err.textContent = friendly(ex.message); err.hidden = false;
          $('lgGo').disabled = false; $('lgGo').innerHTML = 'Save card and register <span class="arr">→</span>';
        }
      };
    }
  }

  /* ================= my registrations ================= */
  async function loadMine() {
    const rows = await ppApi('league_registrations?select=id,league_id,user_id,name,membership_status,weekly_price_pence,card_status,card_label,pair_id,partner_code,playtomic_added_at,playtomic_error,last_payment_status,payments_taken,billing_ended_at,cancelled_at&cancelled_at=is.null&order=created_at.desc');
    return rows;
  }
  async function renderMine() {
    if (q.get('done')) {
      // the webhook lands a second or two after Stripe sends us back
      for (let i = 0; i < 6; i++) {
        mine = await loadMine();
        if (mine.some(r => r.user_id === Auth.userId() && r.card_status === 'authorised')) break;
        await new Promise(r => setTimeout(r, 1500));
      }
      // a singles player is added to Playtomic within seconds of the card saving
      for (let i = 0; i < 4; i++) {
        const waiting = mine.some(r => r.user_id === Auth.userId() && r.card_status === 'authorised' && !r.playtomic_added_at && !r.playtomic_error
          && (leagues.find(x => x.id === r.league_id) || {}).kind === 'singles');
        if (!waiting) break;
        await new Promise(r => setTimeout(r, 1500));
        mine = await loadMine();
      }
    }
    show('lgMine');
    const own = mine.filter(r => r.user_id === Auth.userId());
    const partnerOf = r => mine.find(x => x.pair_id && x.pair_id === r.pair_id && x.id !== r.id);
    $('lgMineLede').textContent = q.get('done')
      ? 'Your card is saved. Nothing has been charged. Your weekly fee starts when the season does.'
      : 'Here is where you stand. Doubles players: send your partner code on if they have not registered yet.';
    if (q.get('cancelled')) $('lgMineLede').textContent = 'You left Stripe without saving a card, so your registration is not complete yet. Use the button below to finish it.';
    const fmtDay = d => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d);
    const lastPayment = l => {
      if (!l.season_start || !l.weeks) return null;
      const d = new Date(l.season_start + 'T12:00:00'); d.setDate(d.getDate() + 7 * (l.weeks - 1)); return d;
    };
    const cardName = c => String(c || 'Saved').replace(/^\w/, ch => ch.toUpperCase());
    $('lgMineList').innerHTML = own.map(r => {
      const l = leagues.find(x => x.id === r.league_id) || {};
      const p = partnerOf(r);
      const link = `${PP_SITE}/northampton-padel-league/register/?partner=${r.partner_code}`;
      const st = status(r, l, p);
      const saved = r.card_status === 'authorised';
      const doubles = l.kind === 'doubles';
      const last = lastPayment(l);
      const pt = r.playtomic_added_at ? { tone: 'good', label: 'You are in the league' }
        : r.playtomic_error ? { tone: 'warn', label: 'The club is adding you' }
        : !saved ? { tone: '', label: 'Added once your card is saved' }
        : doubles && !(p && p.card_status === 'authorised') ? { tone: '', label: 'Added once your partner registers' }
        : { tone: '', label: 'Adding you now' };
      const member = r.membership_status === 'member' ? 'Club member'
        : r.membership_status === 'review' ? 'Non-member price, being checked' : 'Non-member';
      return `<article class="lgr">
        <div class="lgr-head">
          <span class="lgr-kind">${doubles ? 'Doubles league' : 'Singles league'}</span>
          <span class="lgr-pill ${st.tone}">${st.label}</span>
        </div>
        <h3 class="lgr-name">${esc(l.name || 'League')}</h3>
        <div class="lgr-fee"><b>${gbp(r.weekly_price_pence)}</b><span>a week${l.weeks ? ` for ${l.weeks} weeks` : ''}</span></div>
        <dl class="lgr-rows">
          <div><dt>Membership</dt><dd>${member}</dd></div>
          <div><dt>First payment</dt><dd>${l.season_start ? fmtDay(new Date(l.season_start + 'T12:00:00')) : 'When the season starts'}</dd></div>
          ${last ? `<div><dt>Last payment</dt><dd>${fmtDay(last)}</dd></div>` : ''}
          <div><dt>Card</dt><dd>${saved ? `${esc(cardName(r.card_label))}<button class="lgr-link" data-card="${r.id}">Update</button>` : 'Not saved yet'}</dd></div>
          ${doubles && p ? `<div><dt>Partner</dt><dd>${esc(p.name)}${p.card_status === 'authorised' ? '' : '<span class="lgr-note">still to save their card</span>'}</dd></div>` : ''}
          <div><dt>Playtomic</dt><dd><i class="lgr-dot ${pt.tone}" aria-hidden="true"></i>${pt.label}</dd></div>
        </dl>
        ${saved ? '' : `<button class="btn btn-blue lgr-cta" data-finish="${r.id}">Save your card to finish <span class="arr">→</span></button>`}
        ${doubles && !p ? `<div class="lgr-share">
            <p>Send this link to your partner. When they register with it you are paired.</p>
            <div class="lgr-share-row"><input readonly value="${link}" id="share-${r.id}" aria-label="Partner link"><button class="btn btn-ghost" data-copy="share-${r.id}">Copy</button></div>
            <p class="lgr-code">Or give them the code <b>${r.partner_code}</b></p>
          </div>` : ''}
      </article>`;
    }).join('') || '<p class="lgr-empty">You have no league registrations yet.</p>';

    $('lgMineList').querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
      const inp = $(b.dataset.copy); inp.select();
      navigator.clipboard?.writeText(inp.value).then(() => { b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1500); });
    }));
    $('lgMineList').querySelectorAll('[data-card]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await ppFn('league-register', { method: 'POST', body: JSON.stringify({ action: 'update_card', registration_id: b.dataset.card, return_url: location.origin + location.pathname }) });
        location.href = r.url;
      } catch (ex) { alert(friendly(ex.message)); b.disabled = false; }
    }));
    $('lgMineList').querySelectorAll('[data-finish]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await ppFn('league-register', { method: 'POST', body: JSON.stringify({ action: 'resume', registration_id: b.dataset.finish, return_url: location.origin + location.pathname }) });
        location.href = r.url;
      } catch (ex) { alert(friendly(ex.message)); b.disabled = false; }
    }));
  }

  function status(r, l, p) {
    if (r.card_status === 'failed') return { label: 'Payment failed', tone: 'bad' };
    if (r.card_status !== 'authorised') return { label: 'Card not saved', tone: 'warn' };
    if (l.kind === 'doubles' && !p) return { label: 'Awaiting partner', tone: 'warn' };
    if (l.kind === 'doubles' && p && p.card_status !== 'authorised') return { label: 'Partner to finish', tone: 'warn' };
    if (r.billing_ended_at) return { label: 'Season complete', tone: '' };
    if (r.payments_taken > 0) return { label: 'Payments active', tone: 'good' };
    return { label: 'Registered', tone: 'good' };
  }

  // mobile verification gate, the same one booking uses
  function phoneReady() {
    if (!Member.needsPhone()) return Promise.resolve(true);
    return new Promise(res => PhoneVerify.open({
      reason: 'We text league updates to your mobile, so we need to check it is yours.',
      onDone: () => res(true), onSkip: () => res(false),
    }));
  }

  function friendly(code) {
    return {
      league_closed: 'Registration for that league is not open yet.',
      already_registered: 'You are already registered for that league.',
      profile_incomplete: 'Add your mobile number to your account first.',
      phone_unverified: 'Please verify your mobile first.',
      bad_playtomic_url: 'That does not look like a Playtomic profile link.',
      code_not_found: 'That partner code was not recognised. Check it with your partner.',
      own_code: 'That is your own partner code. Your partner needs to enter it, not you.',
      league_mismatch: 'Your partner registered for a different league. Pick the same one.',
      partner_taken: 'That partner already has a pair for this league.',
      already_paired: 'You already have a partner for this league.',
      payments_not_configured: 'Card saving is not available right now. Please try later.',
    }[code] || 'Something went wrong. Please try again.';
  }
})();
