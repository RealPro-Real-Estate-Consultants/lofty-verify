/**
 * EverySWFLHome — Two-stage phone-verification flow for the Lofty register popup.
 *
 * Loaded from the Lofty Custom Style & Script bootstrapper:
 *   (function(){var s=document.createElement('script');
 *     s.src='https://lofty-verify-production-3aee.up.railway.app/otp.js?v=N';
 *     s.async=true;document.head.appendChild(s)})();
 *
 * Sequence:
 *   1. Register popup mounts → we hide its phone field and seed the input
 *      with "0000000000" so Lofty's submit button enables on consent-check.
 *   2. User clicks "Show Me Homes" → capture-phase click handler blocks the
 *      submit and opens the EXPLAINER modal with copy + icons + a phone input.
 *   3. User submits the explainer → we write the real phone into Lofty's
 *      hidden field (Vue-reactive setter) and re-click "Show Me Homes" with a
 *      bypass flag so Lofty submits the lead with the real phone number.
 *   4. Show Me Homes goes through → /send-verification fires → OTP modal opens
 *      with a 10-minute expiry countdown + Resend cooldown.
 *   5. On approved verification → success card with "Search Now" CTA.
 *
 * Bump ?v= in the Lofty bootstrapper whenever this file is updated (or add
 * a no-cache header in index.js for /otp.js).
 */

// --- Leadsy AI tag (preserved from original file) ----------------------------
(function () {
  const head = document.getElementsByTagName('head')[0];
  const script = document.createElement('script');
  script.src = 'https://r2.leadsy.ai/tag.js';
  script.setAttribute('async', true);
  script.setAttribute('data-pid', '1fAaJN39H3FwvwRmG');
  script.setAttribute('data-version', '062024');
  script.setAttribute('id', 'vtag-ai-js');
  head.appendChild(script);
})();
/* AM-466105  Kenneth Ibea end */

// --- Two-stage OTP verification flow -----------------------------------------
(function () {
  // ---- Config --------------------------------------------------------------
  const BACKEND = 'https://lofty-verify-production-3aee.up.railway.app';
  const ZAPIER_HOOK = '';            // optional Zap #2 catch-hook URL
  const CODE_TTL_SECONDS = 600;      // Twilio Verify codes expire after 10 min
  const RESEND_COOLDOWN = 30;        // seconds between resend clicks
  const PHONE_PLACEHOLDER = '0000000000';
  const HEADERS = { 'Content-Type': 'application/json' };

  // ---- State ---------------------------------------------------------------
  let verified = false;
  let bypassRegister = false;
  const hooked = new WeakSet();

  // ---- Utilities -----------------------------------------------------------
  function normalizePhone(raw) {
    const d = (raw || '').replace(/\D/g, '');
    return d.length === 10 ? '1' + d : d;
  }

  function post(path, body) {
    return fetch(BACKEND + path, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body)
    });
  }

  function closeOverlay(overlay) {
    overlay.remove();
    document.documentElement.style.overflow = '';
  }

  function formatMMSS(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  // Vue-friendly value setter: write through the native HTMLInputElement
  // setter and dispatch input/change events so Vue picks the change up.
  function setReactiveValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---- SVG illustrations ---------------------------------------------------
  const PHONE_SVG =
    '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<rect x="16" y="6" width="32" height="52" rx="6" fill="#3e5da4"/>' +
      '<rect x="20" y="12" width="24" height="36" rx="2" fill="#fff"/>' +
      '<circle cx="32" cy="53" r="2" fill="#fff"/>' +
      '<rect x="24" y="18" width="16" height="4" rx="1" fill="#3e5da4" opacity=".25"/>' +
      '<rect x="24" y="26" width="12" height="3" rx="1" fill="#3e5da4" opacity=".25"/>' +
      '<rect x="24" y="32" width="14" height="3" rx="1" fill="#3e5da4" opacity=".25"/>' +
      '<g transform="translate(40 4)">' +
        '<circle cx="10" cy="10" r="10" fill="#fcce17"/>' +
        '<text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="#000">SMS</text>' +
      '</g>' +
    '</svg>';

  const LOCK_SVG =
    '<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M6 9V6a4 4 0 1 1 8 0v3h1a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h1zm2 0h4V6a2 2 0 1 0-4 0v3z" fill="#3e5da4"/>' +
    '</svg>';

  const CHECK_SVG =
    '<svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<circle cx="10" cy="10" r="10" fill="#3e5da4"/>' +
      '<path d="M5.5 10.5l3 3 6-6" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';

  // ---- Register popup: hide phone field + seed placeholder -----------------
  function setupRegisterPopup() {
    const phoneInput = document.querySelector('.pop-sign-log.register input[name="phone"]');
    if (!phoneInput || phoneInput.dataset.otpReady === '1') return;
    phoneInput.dataset.otpReady = '1';

    const container = phoneInput.closest('.v-input');
    if (container) container.style.display = 'none';

    if (!phoneInput.value) {
      setReactiveValue(phoneInput, PHONE_PLACEHOLDER);
    }
  }

  // ---- Explainer modal -----------------------------------------------------
  function buildExplainer(submitBtn) {
    const overlay = document.createElement('div');
    overlay.id = 'explO';
    overlay.innerHTML =
      '<div class="explB"></div>' +
      '<div class="explC">' +
        '<button class="explX" type="button" aria-label="Close">&times;</button>' +
        '<div class="explIcon">' + PHONE_SVG + '</div>' +
        '<h3>One More Step &mdash; Verify Your Phone</h3>' +
        '<p class="explSub">To activate your free account and unlock listings, ' +
          'we\'ll send a quick verification code to your mobile phone.</p>' +
        '<div class="explBenefits">' +
          '<div class="explBen">' + CHECK_SVG + '<span>Instant alerts on new listings that match your search</span></div>' +
          '<div class="explBen">' + CHECK_SVG + '<span>Transaction updates and direct messages from your agent</span></div>' +
          '<div class="explBen">' + CHECK_SVG + '<span>Confirms you\'re a real buyer so we can serve you better</span></div>' +
        '</div>' +
        '<div class="explHow">' +
          '<h4>How it works</h4>' +
          '<ol>' +
            '<li>Enter your mobile phone number below.</li>' +
            '<li>We\'ll text you a one-time <b>6-digit code</b>.</li>' +
            '<li>Enter the code on the next screen &mdash; that\'s it.</li>' +
          '</ol>' +
        '</div>' +
        '<label class="explLabel" for="explPhone">Mobile phone number</label>' +
        '<input id="explPhone" type="tel" inputmode="numeric" autocomplete="tel" ' +
               'placeholder="(239) 555-1234">' +
        '<p class="explErr" id="explErr"></p>' +
        '<button id="explGo" type="button">Send My Code</button>' +
        '<div class="explPrivacy">' + LOCK_SVG +
          '<span>Standard message and data rates may apply. Reply STOP to opt out. ' +
          '<b>Your number is private and never sold.</b></span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';

    const phoneEl = overlay.querySelector('#explPhone');
    const errEl   = overlay.querySelector('#explErr');
    const goBtn   = overlay.querySelector('#explGo');
    const xBtn    = overlay.querySelector('.explX');

    function dismiss() {
      closeOverlay(overlay);
    }
    xBtn.onclick = dismiss;

    goBtn.onclick = function () {
      const phone = normalizePhone(phoneEl.value);
      if (phone.length < 11) {
        errEl.textContent = 'Please enter a valid US mobile number with area code.';
        phoneEl.focus();
        return;
      }
      errEl.textContent = '';
      goBtn.disabled = true;
      goBtn.textContent = 'Sending...';

      // Write the real phone into Lofty's hidden field
      const loftyPhone = document.querySelector('.pop-sign-log.register input[name="phone"]');
      if (loftyPhone) setReactiveValue(loftyPhone, phone);

      // Close explainer
      closeOverlay(overlay);

      // Re-click Show Me Homes with bypass flag so Lofty submits the lead
      bypassRegister = true;
      setTimeout(function () {
        submitBtn.click();
        // After Lofty processes the click, open the OTP modal
        setTimeout(function () { fireOTP(phone); }, 600);
        // Reset bypass shortly after for safety
        setTimeout(function () { bypassRegister = false; }, 1500);
      }, 50);
    };

    phoneEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); goBtn.click(); }
    });

    setTimeout(function () { phoneEl.focus(); }, 50);
  }

  // ---- OTP modal -----------------------------------------------------------
  function buildOTPModal(phone) {
    const overlay = document.createElement('div');
    overlay.id = 'otpO';
    overlay.innerHTML =
      '<div class="otpB"></div>' +
      '<div class="otpC">' +
        '<h3>Verify your phone</h3>' +
        '<p>We texted a 6-digit code to <b>+' + phone + '</b>.</p>' +
        '<input id="otpI" type="tel" inputmode="numeric" maxlength="6" ' +
               'placeholder="123456" autocomplete="one-time-code">' +
        '<p id="otpT" class="otpT">Code expires in <b>10:00</b></p>' +
        '<button id="otpG">Verify</button>' +
        '<button id="otpR" type="button">Resend code</button>' +
        '<p id="otpM"></p>' +
      '</div>';
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';

    const card      = overlay.querySelector('.otpC');
    const codeInput = overlay.querySelector('#otpI');
    const msg       = overlay.querySelector('#otpM');
    const verifyBtn = overlay.querySelector('#otpG');
    const resendBtn = overlay.querySelector('#otpR');
    const timerEl   = overlay.querySelector('#otpT');

    let ttl = CODE_TTL_SECONDS;
    let expiryTimer = null;

    function setMessage(text, kind) {
      msg.textContent = text;
      msg.style.color =
        kind === 'ok'   ? '#1c8a3a' :
        kind === 'info' ? '#3e5da4' :
                          '#c33';
    }

    function tickExpiry() {
      if (ttl <= 0) {
        clearInterval(expiryTimer);
        timerEl.innerHTML = '<b>Code expired</b> &mdash; tap Resend';
        timerEl.classList.add('otpExp');
        verifyBtn.disabled = true;
        return;
      }
      timerEl.innerHTML = 'Code expires in <b>' + formatMMSS(ttl) + '</b>';
      ttl--;
    }

    function startExpiryCountdown() {
      ttl = CODE_TTL_SECONDS;
      clearInterval(expiryTimer);
      timerEl.classList.remove('otpExp');
      verifyBtn.disabled = false;
      tickExpiry();
      expiryTimer = setInterval(tickExpiry, 1000);
    }

    function startResendCooldown(seconds) {
      resendBtn.disabled = true;
      let left = seconds;
      (function tick() {
        if (left <= 0) {
          resendBtn.disabled = false;
          resendBtn.textContent = 'Resend code';
          return;
        }
        resendBtn.textContent = 'Resend in ' + left + 's';
        left--;
        setTimeout(tick, 1000);
      })();
    }

    function renderSuccess() {
      clearInterval(expiryTimer);
      card.innerHTML =
        '<div class="otpCheck">&#10003;</div>' +
        '<h3>Phone Verified</h3>' +
        '<p>You\'re all set! Now you can search properties across Southwest Florida.</p>' +
        '<button id="otpS">Search Now</button>';
      card.querySelector('#otpS').onclick = function () {
        closeOverlay(overlay);
      };
    }

    resendBtn.onclick = function () {
      setMessage('New code sent.', 'ok');
      post('/send-verification', { phoneNumber: phone }).catch(function () {
        setMessage('Could not resend. Try again.', 'err');
      });
      startExpiryCountdown();
      startResendCooldown(RESEND_COOLDOWN);
    };

    verifyBtn.onclick = async function () {
      const code = codeInput.value.trim();
      if (code.length !== 6) {
        setMessage('Enter the 6-digit code.', 'err');
        return;
      }
      setMessage('Checking...', 'info');
      try {
        const res = await post('/verify-otp', { phoneNumber: phone, otp: code });
        const data = await res.json();
        if (data && data.status === 'approved') {
          verified = true;
          if (ZAPIER_HOOK) {
            fetch(ZAPIER_HOOK, {
              method: 'POST',
              headers: HEADERS,
              body: JSON.stringify({ phoneNumber: phone, status: 'approved' })
            }).catch(function () {});
          }
          renderSuccess();
        } else {
          setMessage('Incorrect or expired code. Tap Resend for a new one.', 'err');
        }
      } catch (e) {
        setMessage('Network error. Try again.', 'err');
      }
    };

    startExpiryCountdown();
    startResendCooldown(RESEND_COOLDOWN);
    setTimeout(function () { codeInput.focus(); }, 50);
  }

  function fireOTP(phone) {
    if (verified || document.getElementById('otpO')) return;
    post('/send-verification', { phoneNumber: phone }).catch(function () {});
    buildOTPModal(phone);
  }

  // ---- DOM scan + hook -----------------------------------------------------
  function scan() {
    setupRegisterPopup();

    document
      .querySelectorAll('.pop-sign-log.register input[type=submit]')
      .forEach(function (btn) {
        if (hooked.has(btn)) return;
        hooked.add(btn);
        btn.addEventListener('click', function (e) {
          // Allow programmatic re-clicks from the explainer flow
          if (bypassRegister) return;

          const wrap = btn.closest('.submit');
          if (wrap && wrap.classList.contains('disabled')) return;

          // Block Lofty's submit and show the explainer instead
          e.preventDefault();
          e.stopImmediatePropagation();
          buildExplainer(btn);
        }, true);
      });
  }

  setInterval(scan, 700);
  scan();

  // ---- Styles --------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    /* ============= Shared overlay primitives ============= */
    #explO, #otpO {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-normal, "Helvetica Neue", Helvetica, Arial, sans-serif);
    }
    #explO .explB, #otpO .otpB {
      position: absolute;
      inset: 0;
      background: rgba(20, 20, 33, 0.72);
    }

    /* ============= Explainer modal ============= */
    #explO .explC {
      position: relative;
      background: #fff;
      padding: 36px 32px 28px;
      border-radius: 14px;
      max-width: 460px;
      width: 92%;
      max-height: 92vh;
      overflow-y: auto;
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
      text-align: center;
    }
    #explO .explX {
      position: absolute;
      top: 10px;
      right: 14px;
      background: transparent;
      border: 0;
      font-size: 26px;
      color: #8b93a7;
      cursor: pointer;
      line-height: 1;
      padding: 4px 8px;
    }
    #explO .explX:hover { color: #37465a; }
    #explO .explIcon {
      width: 72px;
      height: 72px;
      margin: 0 auto 14px;
    }
    #explO .explIcon svg { width: 100%; height: 100%; }
    #explO h3 {
      margin: 0 0 8px;
      font-size: 22px;
      font-family: var(--font-bold, "Helvetica Neue", Helvetica, Arial, sans-serif);
      color: #3e5da4;
    }
    #explO .explSub {
      margin: 0 0 18px;
      font-size: 14px;
      color: #37465a;
      line-height: 1.55;
    }
    #explO .explBenefits {
      text-align: left;
      background: #f5f7fb;
      border-radius: 10px;
      padding: 14px 16px;
      margin: 0 0 18px;
    }
    #explO .explBen {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      font-size: 13.5px;
      color: #37465a;
      line-height: 1.45;
      padding: 4px 0;
    }
    #explO .explBen svg {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      margin-top: 1px;
    }
    #explO .explHow {
      text-align: left;
      margin: 0 0 16px;
    }
    #explO .explHow h4 {
      margin: 0 0 6px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #8b93a7;
      font-family: var(--font-bold, sans-serif);
    }
    #explO .explHow ol {
      margin: 0;
      padding-left: 20px;
      font-size: 13.5px;
      color: #37465a;
      line-height: 1.6;
    }
    #explO .explLabel {
      display: block;
      text-align: left;
      font-size: 13px;
      color: #8b93a7;
      margin: 0 0 4px;
      font-family: var(--font-bold, sans-serif);
    }
    #explO #explPhone {
      width: 100%;
      padding: 12px 14px;
      font-size: 16px;
      border: 1px solid #d0d6e2;
      border-radius: 8px;
      box-sizing: border-box;
      color: #37465a;
      margin: 0 0 4px;
    }
    #explO #explPhone:focus {
      outline: none;
      border-color: #3e5da4;
      box-shadow: 0 0 0 3px rgba(62, 93, 164, 0.15);
    }
    #explO .explErr {
      min-height: 16px;
      font-size: 12.5px;
      color: #c33;
      margin: 4px 0 8px;
      text-align: left;
    }
    #explO #explGo {
      width: 100%;
      padding: 14px;
      background: #fcce17;
      color: #000;
      border: 0;
      border-radius: 8px;
      font-size: 16px;
      font-family: var(--font-bold, sans-serif);
      font-weight: 700;
      cursor: pointer;
      margin: 4px 0 14px;
      transition: background 0.2s;
    }
    #explO #explGo:hover:not(:disabled) { background: #e8bb14; }
    #explO #explGo:disabled { background: #f0e0a0; cursor: not-allowed; }
    #explO .explPrivacy {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 11.5px;
      color: #8b93a7;
      line-height: 1.5;
      text-align: left;
      padding-top: 10px;
      border-top: 1px solid #ececf2;
    }
    #explO .explPrivacy svg { width: 16px; height: 16px; flex-shrink: 0; margin-top: 1px; }
    #explO .explPrivacy b { color: #37465a; }

    /* ============= OTP verification modal ============= */
    #otpO .otpC {
      position: relative;
      background: #fff;
      padding: 32px 28px;
      border-radius: 12px;
      max-width: 400px;
      width: 90%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      text-align: center;
    }
    #otpO h3 {
      margin: 0 0 10px;
      font-size: 22px;
      font-family: var(--font-bold, "Helvetica Neue", Helvetica, Arial, sans-serif);
      color: #3e5da4;
    }
    #otpO p {
      margin: 8px 0;
      font-size: 14px;
      color: #37465a;
      line-height: 1.5;
    }
    #otpO input {
      width: 100%;
      padding: 12px;
      font-size: 22px;
      letter-spacing: 8px;
      text-align: center;
      border: 1px solid #d0d6e2;
      border-radius: 8px;
      margin: 14px 0 6px;
      box-sizing: border-box;
      color: #37465a;
    }
    #otpO input:focus {
      outline: none;
      border-color: #3e5da4;
      box-shadow: 0 0 0 3px rgba(62, 93, 164, 0.15);
    }
    #otpO .otpT {
      font-size: 12px;
      color: #8b93a7;
      margin: 4px 0 14px;
    }
    #otpO .otpT.otpExp { color: #c33; }
    #otpO button {
      width: 100%;
      padding: 12px;
      background: #3e5da4;
      color: #fff;
      border: 0;
      border-radius: 8px;
      font-size: 15px;
      font-family: var(--font-bold, "Helvetica Neue", Helvetica, Arial, sans-serif);
      cursor: pointer;
      margin-top: 8px;
      transition: background 0.2s;
    }
    #otpO button:hover:not(:disabled) { background: #324d8c; }
    #otpO button:disabled { background: #d0d6e2; cursor: not-allowed; }
    #otpO #otpR {
      background: transparent;
      color: #3e5da4;
      border: 1px solid #3e5da4;
    }
    #otpO #otpR:hover:not(:disabled) { background: rgba(62, 93, 164, 0.08); }
    #otpO #otpR:disabled {
      background: transparent;
      color: #8b93a7;
      border-color: #d0d6e2;
    }
    #otpO #otpS {
      background: #fcce17;
      color: #000;
      font-size: 16px;
      padding: 14px;
      margin-top: 16px;
    }
    #otpO #otpS:hover { background: #e8bb14; }
    #otpO #otpM {
      min-height: 18px;
      font-size: 13px;
      margin: 10px 0 0;
      color: #c33;
    }
    #otpO .otpCheck {
      width: 64px;
      height: 64px;
      margin: 0 auto 12px;
      border-radius: 50%;
      background: #3e5da4;
      color: #fff;
      font-size: 36px;
      font-weight: bold;
      line-height: 64px;
      text-align: center;
    }
  `;
  document.head.appendChild(style);
})();
