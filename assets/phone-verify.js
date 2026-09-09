/* ============================================================
   Padel Power · mobile verification overlay
   Shared by the booking page and the account page. Builds its own
   markup so neither page has to carry a copy.

   PhoneVerify.open({ onDone, onSkip, reason })
     onDone  called once the number is proved
     onSkip  called if they close it; omit to make it unskippable
     reason  short line explaining why they are seeing this

   Requires pilates-core.js (Store, Member, RULES).
   ============================================================ */

const PhoneVerify = (() => {
  let el = null, opts = {}, cooldown = 0, timer = null;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const $ = sel => el.querySelector(sel);

  function build() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'pv-overlay';
    el.hidden = true;
    el.innerHTML = `
      <div class="pv-panel" role="dialog" aria-modal="true" aria-labelledby="pvTitle">
        <button class="pv-close" type="button" aria-label="Close" hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5L5 19"/></svg>
        </button>
        <span class="pv-eyebrow">Verify your mobile</span>
        <h2 id="pvTitle">Check your <span class="blue">phone</span></h2>
        <p class="pv-sub" id="pvSub"></p>

        <form class="pv-form" id="pvForm">
          <label class="pv-label" for="pvCode">6 digit code</label>
          <input class="pv-code" id="pvCode" name="pvCode" type="text" inputmode="numeric"
                 autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"
                 placeholder="000000" required>
          <div class="pv-error" id="pvError" hidden></div>
          <button class="btn btn-blue pv-submit" type="submit">Verify and continue <span class="arr">→</span></button>
        </form>

        <div class="pv-foot">
          <button type="button" class="pv-link" id="pvResend">Send it again</button>
          <button type="button" class="pv-link" id="pvWrong">Wrong number?</button>
        </div>

        <div class="pv-done" id="pvDone" hidden>
          <div class="pv-tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M4 12.5l5 5L20 6.5"/></svg></div>
          <h3>Mobile verified</h3>
          <p>That is the number we will text your booking confirmation and cancellation link to.</p>
        </div>
      </div>`;
    document.body.appendChild(el);

    $('#pvForm').addEventListener('submit', submit);
    $('#pvResend').addEventListener('click', () => send(true));
    $('#pvWrong').addEventListener('click', () => { location.href = '../account/#details'; });
    $('.pv-close').addEventListener('click', close);
    // digits only, and submit itself once six are in
    $('#pvCode').addEventListener('input', e => {
      const v = e.target.value.replace(/\D/g, '').slice(0, 6);
      e.target.value = v;
      hideError();
      if (v.length === 6) $('#pvForm').requestSubmit();
    });
  }

  function showError(msg) { const e = $('#pvError'); e.textContent = msg; e.hidden = false; }
  function hideError() { $('#pvError').hidden = true; }

  function tick() {
    const b = $('#pvResend');
    if (cooldown > 0) {
      b.disabled = true;
      b.textContent = `Send it again in ${cooldown}s`;
      cooldown--;
    } else {
      b.disabled = false;
      b.textContent = 'Send it again';
      clearInterval(timer);
      timer = null;
    }
  }
  function startCooldown(seconds) {
    cooldown = seconds;
    clearInterval(timer);
    tick();
    timer = setInterval(tick, 1000);
  }

  async function send(isResend) {
    hideError();
    const b = $('#pvResend');
    if (isResend) { b.disabled = true; b.textContent = 'Sending…'; }
    try {
      const r = await Store.sendCode();
      if (r.verified) return finish();
      $('#pvSub').innerHTML = `We have sent a 6 digit code to <b>${esc(r.phone_masked || 'your mobile')}</b>. It runs out in ${r.minutes || RULES.codeMinutes} minutes.`;
      startCooldown(60);
      $('#pvCode').focus();
    } catch (err) {
      const m = String(err.message || '');
      startCooldown(15);
      if (m === 'sms_not_configured') {
        showError('Text messages are not switched on yet. Call the club and we will verify you over the phone.');
      } else if (m === 'bad_number') {
        showError('That number would not accept a text. Check it is a UK mobile and update it on your account.');
      } else if (m === 'no_phone') {
        showError('There is no mobile number on your account yet. Add one first.');
      } else if (m === 'cooldown') {
        showError('Give it a few more seconds before asking for another code.');
      } else if (m === 'rate_limited') {
        showError('That is a lot of codes in one go. Wait an hour, or call the club and we will sort it.');
      } else {
        showError('We could not send the code just now. Try again in a moment.');
      }
    }
  }

  async function submit(e) {
    e.preventDefault();
    const btn = $('.pv-submit');
    const code = $('#pvCode').value.replace(/\D/g, '');
    if (code.length !== 6) return;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      await Store.checkCode(code);
      finish();
    } catch (err) {
      const m = String(err.message || '');
      btn.disabled = false;
      btn.innerHTML = 'Verify and continue <span class="arr">→</span>';
      $('#pvCode').value = '';
      $('#pvCode').focus();
      if (m === 'too_many_attempts') {
        showError('Too many wrong tries on that code. Ask for a new one.');
      } else if (m === 'no_code') {
        showError('That code has run out. Ask for a new one.');
      } else {
        showError('That code was not right. Check the text and try again.');
      }
    }
  }

  function finish() {
    $('#pvForm').hidden = true;
    $('.pv-foot').hidden = true;
    $('#pvSub').hidden = true;
    $('#pvDone').hidden = false;
    clearInterval(timer);
    setTimeout(() => { close(true); opts.onDone && opts.onDone(); }, 1400);
  }

  function close(silent) {
    el.hidden = true;
    document.body.style.overflow = '';
    clearInterval(timer);
    if (!silent && opts.onSkip) opts.onSkip();
  }

  return {
    async open(o = {}) {
      opts = o;
      build();
      $('#pvForm').hidden = false;
      $('.pv-foot').hidden = false;
      $('#pvSub').hidden = false;
      $('#pvDone').hidden = true;
      $('#pvCode').value = '';
      hideError();
      $('.pv-submit').disabled = false;
      $('.pv-submit').innerHTML = 'Verify and continue <span class="arr">→</span>';
      $('.pv-close').hidden = !o.onSkip;
      $('#pvSub').textContent = o.reason || 'Sending you a code now.';
      el.hidden = false;
      document.body.style.overflow = 'hidden';
      await send(false);
    },
    close,
  };
})();
