/**
 * EverySWFLHome — Twilio Verify OTP flow for the Lofty registration popup.
 *
 * Loaded from the Lofty Custom Style & Script bootstrapper:
 *   (function(){var s=document.createElement('script');
 *     s.src='https://lofty-verify-production-3aee.up.railway.app/otp.js?v=N';
 *     s.async=true;document.head.appendChild(s)})();
 *
 * When the user clicks "Show Me Homes" on the Lofty register popup with a
 * valid phone and consents checked, this script:
 *   1. Captures the phone, normalised to E.164 (no +).
 *   2. POSTs to /send-verification on the Railway backend (Twilio Verify SMS).
 *   3. Shows a modal with a 6-digit input, a 10-minute expiry countdown, and
 *      a Resend button (30-second client-side cooldown).
 *   4. On approved verification, swaps the modal to a "Phone Verified"
 *      confirmation with a Search Now CTA.
 *
 * Bump ?v= in the Lofty bootstrapper whenever this file is updated, or add
 * a no-cache header in index.js for /otp.js.
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

// --- OTP verification flow ---------------------------------------------------
(function () {
  // ---- Config --------------------------------------------------------------
  const BACKEND = 'https://lofty-verify-production-3aee.up.railway.app';
  const ZAPIER_HOOK = '';            // optional: Zap #2 catch-hook URL
  const CODE_TTL_SECONDS = 600;      // Twilio Verify codes expire after 10 min
  const RESEND_COOLDOWN = 30;        // seconds between resend clicks
  const HEADERS = { 'Content-Type': 'application/json' };

  // ---- State ---------------------------------------------------------------
  let verified = false;
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

  function closeModal(overlay) {
    overlay.remove();
    document.documentElement.style.overflow = '';
  }

  function formatMMSS(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  // ---- Modal ---------------------------------------------------------------
  function buildModal(phone) {
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
        closeModal(overlay);
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

  // ---- Trigger -------------------------------------------------------------
  function fireOTP(phone) {
    if (verified || document.getElementById('otpO')) return;
    post('/send-verification', { phoneNumber: phone }).catch(function () {});
    buildModal(phone);
  }

  function scan() {
    document
      .querySelectorAll('.pop-sign-log.register input[type=submit]')
      .forEach(function (btn) {
        if (hooked.has(btn)) return;
        hooked.add(btn);
        btn.addEventListener('click', function () {
          const wrap = btn.closest('.submit');
          if (wrap && wrap.classList.contains('disabled')) return;

          const popup = btn.closest('.pop-sign-log.register');
          const phoneEl = popup && popup.querySelector('input[name=phone]');
          if (!phoneEl) return;

          const phone = normalizePhone(phoneEl.value);
          if (phone.length < 11) return;

          // Let Lofty finish submitting the form first, then open the OTP modal.
          setTimeout(function () { fireOTP(phone); }, 600);
        }, true);
      });
  }

  setInterval(scan, 700);
  scan();

  // ---- Styles --------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    #otpO {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-normal, "Helvetica Neue", Helvetica, Arial, sans-serif);
    }
    #otpO .otpB {
      position: absolute;
      inset: 0;
      background: rgba(20, 20, 33, 0.7);
    }
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
    #otpO .otpT.otpExp {
      color: #c33;
    }
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
    #otpO button:hover:not(:disabled) {
      background: #324d8c;
    }
    #otpO button:disabled {
      background: #d0d6e2;
      cursor: not-allowed;
    }
    #otpO #otpR {
      background: transparent;
      color: #3e5da4;
      border: 1px solid #3e5da4;
    }
    #otpO #otpR:hover:not(:disabled) {
      background: rgba(62, 93, 164, 0.08);
    }
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
    #otpO #otpS:hover {
      background: #e8bb14;
    }
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
