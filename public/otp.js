/**
 * EverySWFLHome — Two-stage phone-verification flow for the Lofty register popup.
 *
 * Loader (paste once in Lofty Custom Style & Script Script box):
 *   (function(){var s=document.createElement('script');
 *     s.src='https://lofty-verify-production-3aee.up.railway.app/otp.js?v=N';
 *     s.async=true;document.head.appendChild(s)})();
 *
 * Sequence:
 *   1. Register popup mounts → we hide the phone field and seed it with a
 *      placeholder so Lofty's submit button enables on consent-check.
 *   2. User clicks "Show Me Homes" → we intercept, open the BRANDED PHONE
 *      MODAL with value props + capture form.
 *   3. User submits the phone modal → we write the real phone into Lofty's
 *      hidden field, re-click submit with a bypass flag, close the Lofty
 *      popup, and open the OTP code-entry modal.
 *   4. OTP code-entry modal: 6-digit input, 10-min expiry countdown, Resend.
 *   5. Approved → success → BRANDED SUCCESS MODAL with feature highlights
 *      and Start Searching Homes CTA.
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

// --- Two-stage OTP verification flow -----------------------------------------
(function () {
  // Guard against the bootstrap loader running twice on the same page.
  if (window.__loftyOTPLoaded) return;
  window.__loftyOTPLoaded = true;

  // ---- Config --------------------------------------------------------------
  const BACKEND = 'https://lofty-verify-production-3aee.up.railway.app';
  const ZAPIER_HOOK = '';
  const CODE_TTL_SECONDS = 600;
  const RESEND_COOLDOWN = 30;
  const COMPANY_PHONE = '239-202-0788';
  const SEARCH_URL = '/listing';   // where the "Start Searching Homes" button takes the user
  const HEADERS = { 'Content-Type': 'application/json' };

  // Florida-style house photo for the off-market section of the success modal.
  // Replace this URL with your own listing photo if desired.
  const HOUSE_PHOTO = 'https://images.unsplash.com/photo-1605276373954-0c4a0dac5b12?auto=format&fit=crop&w=900&q=70';

  // ---- State ---------------------------------------------------------------
  let verified = false;
  let bypassRegister = false;
  const hooked = new WeakSet();

  // ---- Utilities -----------------------------------------------------------
  function normalizePhone(raw) {
    const d = (raw || '').replace(/\D/g, '');
    return d.length === 10 ? '1' + d : d;
  }

  // Returns { local: '2394944663', e164: '12394944663' } or null if invalid.
  // Lofty's phone field truncates to 10 digits, so we feed it the local part
  // while still using the E.164-style 1+10 for Twilio Verify.
  function parsePhone(raw) {
    const d = (raw || '').replace(/\D/g, '');
    let local;
    if (d.length === 10) local = d;
    else if (d.length === 11 && d[0] === '1') local = d.slice(1);
    else return null;
    if (!/^[2-9]\d{9}$/.test(local)) return null;   // valid US area code
    return { local: local, e164: '1' + local };
  }

  function formatUSDisplay(digits) {
    const d = (digits || '').replace(/\D/g, '').slice(0, 10);
    if (d.length === 0) return '';
    if (d.length <= 3) return '(' + d;
    if (d.length <= 6) return '(' + d.slice(0, 3) + ') ' + d.slice(3);
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
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
    if (!document.querySelector('.lof-overlay')) {
      document.documentElement.style.overflow = '';
    }
  }

  // Render a 10- or 11-digit phone as "+1 (239) 494-4663"
  function formatPhonePretty(input) {
    const d = (input || '').replace(/\D/g, '');
    const local = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
    if (local.length !== 10) return '+' + d;
    return '+1 (' + local.slice(0, 3) + ') ' + local.slice(3, 6) + '-' + local.slice(6);
  }

  function formatMMSS(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function setReactiveValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function closeLoftyRegister() {
    const popup = document.querySelector('.sign-log.classic-one-step');
    if (!popup) return;
    const closeIcon = popup.querySelector('.iconfont.icon-close, .icon-close');
    if (closeIcon) {
      closeIcon.click();
      setTimeout(function () {
        const stillThere = document.querySelector('.sign-log.classic-one-step');
        if (stillThere) stillThere.remove();
      }, 300);
    } else {
      popup.remove();
    }
  }

  // ---- Inline SVG icons ----------------------------------------------------
  const ICONS = {
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><line x1="10.85" y1="12.15" x2="22" y2="1"/><line x1="18" y1="5" x2="22" y2="9"/><line x1="15" y1="8" x2="19" y2="12"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    bellDollar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M12 11v4M10.5 13.5h3"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.7 2.3a1 1 0 0 0-1.02-.24L2.65 8.04a1 1 0 0 0-.06 1.86l6.85 2.92 2.92 6.85a1 1 0 0 0 1.86-.06l5.98-18.03a1 1 0 0 0-.5-1.28zM10.5 13.5l-4.3-1.84L18.6 6.5l-8.1 7zm1 1l7-8.1-5.16 12.4-1.84-4.3z"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.4-1.4L10 14.2l6.6-6.6L18 9l-8 8z"/></svg>',
    checkBig: '<svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="38" fill="#fff" stroke="#22c55e" stroke-width="3"/><path d="M22 41l13 13 24-26" fill="none" stroke="#22c55e" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    house: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    keyOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 9.5a4 4 0 1 1-5 5l-7 7v-3l1-1 6-6"/><path d="M14.5 9.5L19 5l-2-2-4.5 4.5"/></svg>',
    checkSm: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#f97316"/><path d="M4.5 8.2l2.3 2.3 4.7-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    mapPin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    handshake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 17l-2 2-3-3-3 3 3-3-3-3 6-6 4 4M13 7l3-3 6 6-4 4-4-4"/><path d="M14 14l3 3"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    flagUS: '<svg viewBox="0 0 30 20" preserveAspectRatio="xMidYMid slice"><rect width="30" height="20" fill="#B22234"/><rect width="30" height="1.54" y="1.54" fill="#fff"/><rect width="30" height="1.54" y="4.62" fill="#fff"/><rect width="30" height="1.54" y="7.69" fill="#fff"/><rect width="30" height="1.54" y="10.77" fill="#fff"/><rect width="30" height="1.54" y="13.85" fill="#fff"/><rect width="30" height="1.54" y="16.92" fill="#fff"/><rect width="12" height="10.77" fill="#3C3B6E"/></svg>',
    houseLock: '<svg viewBox="0 0 40 40" fill="none"><path d="M5 17L20 5l15 12v15a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V17z" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><path d="M15 34V24h10v10" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><circle cx="31" cy="31" r="7" fill="currentColor" stroke="#fff8ed" stroke-width="2"/><rect x="28" y="30" width="6" height="4.5" rx="0.6" fill="#fff"/><path d="M29.3 30v-1.6a1.7 1.7 0 0 1 3.4 0V30" stroke="#fff" stroke-width="1.1" fill="none"/></svg>',
    shieldCheck: '<svg viewBox="0 0 40 40"><path d="M20 3L4 9v11c0 9.5 6.5 17.5 16 19 9.5-1.5 16-9.5 16-19V9z" fill="#2b5fdb"/><path d="M12 21l5 5 11-12" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    shieldHouse:
      '<svg viewBox="0 0 40 40">' +
        '<path d="M20 3L4 9v11c0 9.5 6.5 17.5 16 19 9.5-1.5 16-9.5 16-19V9z" fill="#1e3a8a"/>' +
        '<g transform="translate(20 19)">' +
          '<path d="M-7 0L0 -6 7 0v9a1 1 0 0 1-1 1H-6a1 1 0 0 1-1-1z" fill="#fff"/>' +
          '<rect x="-2.5" y="4" width="5" height="6" fill="#1e3a8a"/>' +
        '</g>' +
      '</svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/><circle cx="19" cy="5" r="1.5"/><circle cx="5" cy="19" r="1.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    arrowR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    lock2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="11" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    phoneLockIllu:
      '<svg viewBox="0 0 220 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<circle cx="115" cy="100" r="78" fill="#eef2fb"/>' +
        '<g fill="#1e3a8a" opacity=".18">' +
          '<circle cx="8"  cy="148" r="2.5"/><circle cx="22" cy="148" r="2.5"/><circle cx="36" cy="148" r="2.5"/>' +
          '<circle cx="8"  cy="162" r="2.5"/><circle cx="22" cy="162" r="2.5"/><circle cx="36" cy="162" r="2.5"/>' +
          '<circle cx="8"  cy="176" r="2.5"/><circle cx="22" cy="176" r="2.5"/><circle cx="36" cy="176" r="2.5"/>' +
        '</g>' +
        '<rect x="78" y="28" width="84" height="160" rx="16" fill="#1e3a8a"/>' +
        '<rect x="84" y="36" width="72" height="144" rx="9" fill="#f7f9fd"/>' +
        '<rect x="105" y="42" width="30" height="6.5" rx="3.25" fill="#1e3a8a"/>' +
        '<rect x="106" y="180" width="28" height="2.6" rx="1.3" fill="#1e3a8a" opacity=".25"/>' +
        '<rect x="100" y="60" width="100" height="68" rx="12" fill="#fff" stroke="#dde4f0" stroke-width="1.2"/>' +
        '<path d="M115 128 L108 142 L125 128 Z" fill="#fff" stroke="#dde4f0" stroke-width="1.2"/>' +
        '<line x1="116" y1="128" x2="124" y2="128" stroke="#fff" stroke-width="2.5"/>' +
        '<g transform="translate(150 78)">' +
          '<path d="M-6 6 V2 A6 6 0 0 1 6 2 V6" fill="none" stroke="#1e3a8a" stroke-width="2.4"/>' +
          '<rect x="-8" y="6" width="16" height="13" rx="2" fill="#1e3a8a"/>' +
          '<circle cx="0" cy="12" r="1.5" fill="#fff"/>' +
        '</g>' +
        '<g fill="#1e3a8a">' +
          '<circle cx="125" cy="112" r="3"/><circle cx="138" cy="112" r="3"/><circle cx="150" cy="112" r="3"/>' +
          '<circle cx="162" cy="112" r="3"/><circle cx="175" cy="112" r="3"/>' +
        '</g>' +
      '</svg>'
  };

  function svg(name, cls) {
    return '<span class="lof-svg' + (cls ? ' ' + cls : '') + '">' + ICONS[name] + '</span>';
  }

  // ==========================================================================
  //  Register-popup setup: hide phone field, seed placeholder
  // ==========================================================================
  function setupRegisterPopup() {
    const phoneInput = document.querySelector('.pop-sign-log.register input[name="phone"]');
    if (!phoneInput || phoneInput.dataset.otpReady === '1') return;
    phoneInput.dataset.otpReady = '1';

    // Lofty has the phone field set to optional, so we only need to hide it.
    // The real phone is written in via setReactiveValue() right before submit.
    const container = phoneInput.closest('.v-input');
    if (container) container.style.display = 'none';
  }

  // ==========================================================================
  //  Modal 1: branded phone-number capture screen
  // ==========================================================================
  function buildPhoneModal(submitBtn) {
    const overlay = document.createElement('div');
    overlay.className = 'lof-overlay';
    overlay.id = 'lof-phone-modal';
    overlay.innerHTML = `
      <div class="lof-backdrop"></div>
      <div class="lof-card lof-phone-card">
        <button class="lof-close" type="button" aria-label="Close">${ICONS.close}</button>
        <div class="lof-phone-grid">
          <!-- LEFT: value props -->
          <div class="lof-phone-left">
            <h2 class="lof-h2">Access SW Florida<br>Homes Like an Agent</h2>
            <p class="lof-sub">Enter your phone number and we'll text you a 6-digit code to continue.</p>

            <ul class="lof-benefits">
              <li>
                <span class="lof-bicon">${ICONS.search}</span>
                <div>
                  <h4>Advanced MLS Filters</h4>
                  <p>Search like an agent with powerful filters Zillow doesn't offer.</p>
                </div>
              </li>
              <li>
                <span class="lof-bicon">${ICONS.key}</span>
                <div>
                  <h4>Access Exclusive Opportunities</h4>
                  <p>Get access to pre-market, off-market, and private seller homes.</p>
                </div>
              </li>
              <li>
                <span class="lof-bicon">${ICONS.heart}</span>
                <div>
                  <h4>Save Favorites &amp; Get Alerts</h4>
                  <p>Save homes, create custom searches, and get instant updates.</p>
                </div>
              </li>
              <li>
                <span class="lof-bicon">${ICONS.bellDollar}</span>
                <div>
                  <h4>Instant Price Drop Notifications</h4>
                  <p>Be the first to know when prices drop on homes you love.</p>
                </div>
              </li>
            </ul>
          </div>

          <!-- RIGHT: phone capture -->
          <div class="lof-phone-right">
            <div class="lof-phone-illu">${ICONS.phoneLockIllu}</div>
            <h3 class="lof-h3">Get Your 6-Digit Code</h3>
            <p class="lof-sub-sm">Enter your number below and we'll text you a code right away.</p>

            <div class="lof-tel-row">
              <span class="lof-flag" aria-hidden="true">${ICONS.flagUS}</span>
              <input id="lof-phone" type="tel" inputmode="numeric" autocomplete="tel"
                     placeholder="(XXX) XXX-XXXX" maxlength="14">
            </div>
            <p class="lof-err" id="lof-phone-err"></p>

            <button id="lof-send" type="button" class="lof-btn-primary">
              <span class="lof-svg lof-plane">${ICONS.plane}</span>
              Text Me the Code
            </button>

            <p class="lof-fineprint">
              By providing your phone number you agree to receive transactional
              and marketing texts via SMS.
            </p>

            <div class="lof-or"><span>OR</span></div>

            <div class="lof-privacy-box">
              <div class="lof-privacy-head">
                <span class="lof-svg lof-shield">${ICONS.shield}</span>
                <strong>Your Privacy Matters</strong>
              </div>
              <ul>
                <li>No spam. No pressure.</li>
                <li>Opt out anytime.</li>
                <li>Your information is never sold to third parties like the national real estate portals.</li>
              </ul>
            </div>
          </div>
        </div>

        <!-- bottom CTA bar -->
        <div class="lof-bottom-bar">
          <div class="lof-bar-left">
            <span class="lof-svg lof-bar-chat">${ICONS.chat}</span>
            <div>
              <strong>Questions? Text us anytime.</strong>
              <span class="lof-bar-sub">We're local and happy to help!</span>
            </div>
          </div>
          <a href="tel:+1${COMPANY_PHONE.replace(/-/g, '')}" class="lof-bar-phone">
            <span class="lof-svg">${ICONS.phone}</span>
            ${COMPANY_PHONE}
          </a>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';

    const phoneEl = overlay.querySelector('#lof-phone');
    const errEl   = overlay.querySelector('#lof-phone-err');
    const sendBtn = overlay.querySelector('#lof-send');
    const closeBtn = overlay.querySelector('.lof-close');

    closeBtn.onclick = function () { closeOverlay(overlay); };

    // Live phone formatting
    phoneEl.addEventListener('input', function () {
      const display = formatUSDisplay(phoneEl.value);
      if (display !== phoneEl.value) phoneEl.value = display;
    });

    let submitting = false;
    sendBtn.onclick = function () {
      if (submitting) return;
      const parsed = parsePhone(phoneEl.value);
      if (!parsed) {
        errEl.textContent = 'Please enter a valid US mobile number with area code.';
        phoneEl.focus();
        return;
      }
      errEl.textContent = '';
      submitting = true;
      sendBtn.disabled = true;
      sendBtn.innerHTML = 'Sending...';

      // Lofty's phone field truncates to 10 digits → write the local part only.
      // Twilio Verify requires E.164 (1+10), passed as `parsed.e164`.
      const loftyPhone = document.querySelector('.pop-sign-log.register input[name="phone"]');
      if (loftyPhone) setReactiveValue(loftyPhone, parsed.local);

      closeOverlay(overlay);

      bypassRegister = true;
      setTimeout(function () {
        submitBtn.click();
        setTimeout(closeLoftyRegister, 400);
        setTimeout(function () { fireOTP(parsed.e164); }, 600);
        setTimeout(function () { bypassRegister = false; }, 1500);
      }, 50);
    };

    phoneEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendBtn.click(); }
    });

    setTimeout(function () { phoneEl.focus(); }, 50);
  }

  // ==========================================================================
  //  Modal 2: OTP code-entry — redesigned
  // ==========================================================================
  function buildOTPModal(phone) {
    const overlay = document.createElement('div');
    overlay.className = 'lof-overlay';
    overlay.id = 'lof-otp-modal';
    overlay.innerHTML = `
      <div class="lof-backdrop"></div>
      <div class="lof-card lof-otp-card">
        <button class="lof-close" type="button" aria-label="Close">${ICONS.close}</button>

        <div class="lof-otp-hero">
          <span class="lof-shield-house">${ICONS.shieldHouse}</span>
        </div>

        <h2 class="lof-otp-title">
          Enter Your<br>
          <span class="lof-otp-title-em">Verification Code</span>
        </h2>

        <p class="lof-otp-sub">We just texted a 6-digit code to:</p>

        <div class="lof-phone-pill">
          <span class="lof-svg lof-pill-ic">${ICONS.phone}</span>
          <span id="lof-phone-display">${formatPhonePretty(phone)}</span>
        </div>
        <p class="lof-wrong">
          Wrong number? <a href="#" id="lof-edit-phone">Edit</a>
        </p>

        <div class="lof-info-box">
          <span class="lof-svg lof-info-ic">${ICONS.sparkle}</span>
          <p>Search homes with <b>advanced filters</b> and discover <b>opportunities</b> not found on major portals.</p>
        </div>

        <div class="lof-otp-boxes">
          <input class="lof-otp-box" type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code">
          <input class="lof-otp-box" type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code">
          <input class="lof-otp-box" type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code">
          <input class="lof-otp-box" type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code">
          <input class="lof-otp-box" type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code">
          <input class="lof-otp-box" type="text" inputmode="numeric" maxlength="1" autocomplete="one-time-code">
        </div>

        <p id="lof-ttl" class="lof-ttl">
          <span class="lof-svg">${ICONS.clock}</span>
          Your code will expire in <b>10:00</b>
        </p>

        <button id="lof-verify" class="lof-btn-primary lof-btn-hero">
          <span class="lof-svg">${ICONS.house}</span>
          <span>Continue to Homes</span>
          <span class="lof-svg lof-btn-arrow">${ICONS.arrowR}</span>
        </button>

        <button id="lof-resend" type="button" class="lof-link-btn">
          <span class="lof-svg">${ICONS.refresh}</span>
          Resend Code
        </button>

        <p id="lof-msg" class="lof-msg"></p>

        <p class="lof-otp-foot">
          <span class="lof-svg">${ICONS.lock2}</span>
          Used only for account access and property updates.
        </p>
      </div>
    `;
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';

    const boxes     = Array.from(overlay.querySelectorAll('.lof-otp-box'));
    const msg       = overlay.querySelector('#lof-msg');
    const verifyBtn = overlay.querySelector('#lof-verify');
    const resendBtn = overlay.querySelector('#lof-resend');
    const timerEl   = overlay.querySelector('#lof-ttl');
    const closeBtn  = overlay.querySelector('.lof-close');
    const editLink  = overlay.querySelector('#lof-edit-phone');

    let ttl = CODE_TTL_SECONDS;
    let expiryTimer = null;
    let busy = false;

    function getCode() {
      return boxes.map(b => b.value).join('');
    }
    function clearBoxes() {
      boxes.forEach(b => { b.value = ''; });
    }
    function setMessage(text, kind) {
      msg.textContent = text;
      msg.style.color = kind === 'ok' ? '#1c8a3a' : kind === 'info' ? '#3e5da4' : '#c33';
    }
    function tickExpiry() {
      if (ttl <= 0) {
        clearInterval(expiryTimer);
        timerEl.innerHTML = '<span class="lof-svg">' + ICONS.clock + '</span> <b>Code expired</b> — tap Resend';
        timerEl.classList.add('lof-ttl-exp');
        verifyBtn.disabled = true;
        return;
      }
      timerEl.innerHTML = '<span class="lof-svg">' + ICONS.clock + '</span> Your code will expire in <b>' + formatMMSS(ttl) + '</b>';
      ttl--;
    }
    function startExpiryCountdown() {
      ttl = CODE_TTL_SECONDS;
      clearInterval(expiryTimer);
      timerEl.classList.remove('lof-ttl-exp');
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
          resendBtn.innerHTML = '<span class="lof-svg">' + ICONS.refresh + '</span> Resend Code';
          return;
        }
        resendBtn.innerHTML = 'Resend in ' + left + 's';
        left--;
        setTimeout(tick, 1000);
      })();
    }

    // 6-box behavior: auto-advance, backspace, paste
    boxes.forEach(function (box, i) {
      box.addEventListener('input', function (e) {
        const val = (e.target.value || '').replace(/\D/g, '');
        if (val.length > 1) {
          // Pasted multiple digits — distribute starting at this index
          const digits = val.split('').slice(0, 6 - i);
          digits.forEach(function (d, j) { boxes[i + j].value = d; });
          const lastIdx = Math.min(i + digits.length, 5);
          boxes[lastIdx].focus();
        } else {
          box.value = val;
          if (val && i < 5) boxes[i + 1].focus();
        }
        if (getCode().length === 6) doVerify();
      });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Backspace' && !box.value && i > 0) {
          boxes[i - 1].focus();
          boxes[i - 1].value = '';
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' && i > 0) {
          boxes[i - 1].focus();
        } else if (e.key === 'ArrowRight' && i < 5) {
          boxes[i + 1].focus();
        }
      });
      box.addEventListener('paste', function (e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
        text.split('').forEach(function (d, j) { if (boxes[j]) boxes[j].value = d; });
        const lastIdx = Math.min(text.length, 5);
        boxes[lastIdx].focus();
        if (getCode().length === 6) doVerify();
      });
    });

    closeBtn.onclick = function () { closeOverlay(overlay); };

    editLink.onclick = function (e) {
      e.preventDefault();
      const localPhone = phone.length === 11 && phone[0] === '1' ? phone.slice(1) : phone;
      closeOverlay(overlay);
      clearInterval(expiryTimer);
      buildEditPhoneModal(localPhone, function (newE164) {
        post('/send-verification', { phoneNumber: newE164 }).catch(function () {});
        buildOTPModal(newE164);
      });
    };

    resendBtn.onclick = function () {
      setMessage('New code sent.', 'ok');
      clearBoxes();
      boxes[0].focus();
      post('/send-verification', { phoneNumber: phone }).catch(function () {
        setMessage('Could not resend. Try again.', 'err');
      });
      startExpiryCountdown();
      startResendCooldown(RESEND_COOLDOWN);
    };

    async function doVerify() {
      if (busy) return;
      const code = getCode();
      if (code.length !== 6) { setMessage('Enter the 6-digit code.', 'err'); return; }
      busy = true;
      setMessage('Checking...', 'info');
      try {
        const res = await post('/verify-otp', { phoneNumber: phone, otp: code });
        const data = await res.json();
        if (data && data.status === 'approved') {
          verified = true;
          clearInterval(expiryTimer);
          if (ZAPIER_HOOK) {
            fetch(ZAPIER_HOOK, {
              method: 'POST', headers: HEADERS,
              body: JSON.stringify({ phoneNumber: phone, status: 'approved' })
            }).catch(function () {});
          }
          closeOverlay(overlay);
          buildSuccessModal();
        } else {
          setMessage('Incorrect or expired code. Tap Resend Code for a new one.', 'err');
          busy = false;
        }
      } catch (e) {
        setMessage('Network error. Try again.', 'err');
        busy = false;
      }
    }
    verifyBtn.onclick = doVerify;

    startExpiryCountdown();
    startResendCooldown(RESEND_COOLDOWN);
    setTimeout(function () { boxes[0].focus(); }, 50);
  }

  // ==========================================================================
  //  Modal 2b: "Wrong number? Edit" inline phone editor
  // ==========================================================================
  function buildEditPhoneModal(prevLocal, onSubmit) {
    const overlay = document.createElement('div');
    overlay.className = 'lof-overlay';
    overlay.id = 'lof-edit-modal';
    overlay.innerHTML = `
      <div class="lof-backdrop"></div>
      <div class="lof-card lof-edit-card">
        <button class="lof-close" type="button" aria-label="Close">${ICONS.close}</button>
        <h3 class="lof-h3 lof-center">Change Phone Number</h3>
        <p class="lof-sub-sm lof-center">Enter the correct mobile number and we'll send a new verification code.</p>
        <div class="lof-tel-row">
          <span class="lof-flag" aria-hidden="true">${ICONS.flagUS}</span>
          <input id="lof-edit-input" type="tel" inputmode="numeric" autocomplete="tel"
                 placeholder="(XXX) XXX-XXXX" maxlength="14">
        </div>
        <p class="lof-err" id="lof-edit-err"></p>
        <button id="lof-edit-go" class="lof-btn-primary">Send New Code</button>
      </div>
    `;
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';

    const input = overlay.querySelector('#lof-edit-input');
    const errEl = overlay.querySelector('#lof-edit-err');

    if (prevLocal) input.value = formatUSDisplay(prevLocal);

    input.addEventListener('input', function () {
      const display = formatUSDisplay(input.value);
      if (display !== input.value) input.value = display;
    });

    overlay.querySelector('.lof-close').onclick = function () { closeOverlay(overlay); };

    overlay.querySelector('#lof-edit-go').onclick = function () {
      const parsed = parsePhone(input.value);
      if (!parsed) {
        errEl.textContent = 'Please enter a valid US mobile number with area code.';
        return;
      }
      closeOverlay(overlay);
      onSubmit(parsed.e164);
    };

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); overlay.querySelector('#lof-edit-go').click(); }
    });

    setTimeout(function () { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 50);
  }

  function fireOTP(phone) {
    if (verified || document.getElementById('lof-otp-modal')) return;
    post('/send-verification', { phoneNumber: phone }).catch(function () {});
    buildOTPModal(phone);
  }

  // Treat any of these paths as "the home page".
  function isHomePage() {
    const p = window.location.pathname.replace(/\/+$/, '');
    return p === '' || p === '/index' || p === '/home';
  }

  // ==========================================================================
  //  Modal 3: branded success screen
  // ==========================================================================
  function buildSuccessModal() {
    closeLoftyRegister();   // safety net

    const onHome = isHomePage();
    const searchBtnHTML = onHome
      ? '<span>Start Searching Homes</span><small>Advanced Home Search Access Unlocked</small>'
      : '<span>Continue Browsing</span><small>Account unlocked &mdash; keep exploring this page</small>';

    const overlay = document.createElement('div');
    overlay.className = 'lof-overlay';
    overlay.id = 'lof-success-modal';
    overlay.innerHTML = `
      <div class="lof-backdrop"></div>
      <div class="lof-card lof-success-card">
        <button class="lof-close" type="button" aria-label="Close">${ICONS.close}</button>

        <!-- Hero -->
        <div class="lof-succ-hero">
          <div class="lof-check">${ICONS.checkBig}</div>
          <h2 class="lof-h2 lof-center">Access SW Florida<br>Homes Like an Agent</h2>
          <p class="lof-succ-sub">Advanced Home Search Activated</p>
          <p class="lof-sub lof-center">
            Search Southwest Florida homes with powerful MLS-based filters
            most public websites don't offer.
          </p>
        </div>

        <!-- 4-up feature row -->
        <div class="lof-feat-row">
          <div class="lof-feat">
            <span class="lof-feat-ic">${ICONS.search}</span>
            <h4>Advanced Search</h4>
            <p>Powerful filters to find exactly what you're looking for</p>
          </div>
          <div class="lof-feat">
            <span class="lof-feat-ic">${ICONS.heart}</span>
            <h4>Save Favorites</h4>
            <p>Save homes and create custom searches to come back to anytime</p>
          </div>
          <div class="lof-feat">
            <span class="lof-feat-ic">${ICONS.bellDollar}</span>
            <h4>Instant Updates</h4>
            <p>Be the first to know when new homes match your criteria</p>
          </div>
          <div class="lof-feat">
            <span class="lof-feat-ic">${ICONS.chart}</span>
            <h4>Market Insights</h4>
            <p>Real insights to help you make smart, confident decisions</p>
          </div>
        </div>

        <!-- Primary CTA -->
        <button id="lof-search" class="lof-btn-primary lof-btn-hero">
          <span class="lof-svg">${ICONS.house}</span>
          <span class="lof-btn-stack">${searchBtnHTML}</span>
        </button>

        <!-- Off-market section -->
        <div class="lof-offmkt">
          <div class="lof-offmkt-content">
            <div class="lof-offmkt-head">
              <span class="lof-svg lof-offmkt-ic">${ICONS.houseLock}</span>
              <h3>Want Access to Homes That <span class="lof-stk">Never</span> Hit Zillow?</h3>
            </div>
            <p>Our local team can help you uncover opportunities you won't find on the big real estate portals.</p>
            <div class="lof-offmkt-grid">
              <div>${ICONS.checkSm}<span>Off-market homes</span></div>
              <div>${ICONS.checkSm}<span>Private seller opportunities</span></div>
              <div>${ICONS.checkSm}<span>Pre-market opportunities</span></div>
              <div>${ICONS.checkSm}<span>Coming soon listings</span></div>
              <div>${ICONS.checkSm}<span>Estate sales</span></div>
              <div>${ICONS.checkSm}<span>Investor opportunities</span></div>
            </div>
            <button id="lof-offmkt-btn" class="lof-btn-orange">
              <span class="lof-svg">${ICONS.key}</span>
              <span class="lof-btn-stack">
                <span>Find Off-Market Homes</span>
                <small>Let our local experts find opportunities for you</small>
              </span>
            </button>
          </div>
          <div class="lof-offmkt-img" style="background-image:url('${HOUSE_PHOTO}')"></div>
        </div>

        <!-- Local. Proactive. Connected. -->
        <div class="lof-lpc">
          <div class="lof-lpc-intro">
            <span class="lof-lpc-shield">${ICONS.shieldCheck}</span>
            <div>
              <h4>Local. Proactive. Connected.</h4>
              <p>We work behind the scenes to find opportunities others don't even know about.</p>
            </div>
          </div>
          <div class="lof-lpc-feats">
            <div class="lof-lpc-feat">
              <span class="lof-lpc-ic">${ICONS.people}</span>
              <strong>Local Experts</strong>
              <span class="lof-lpc-sub">Who Know the Market</span>
            </div>
            <div class="lof-lpc-feat">
              <span class="lof-lpc-ic">${ICONS.handshake}</span>
              <strong>Strong Agent</strong>
              <span class="lof-lpc-sub">Relationships</span>
            </div>
            <div class="lof-lpc-feat">
              <span class="lof-lpc-ic">${ICONS.house}</span>
              <strong>Access You</strong>
              <span class="lof-lpc-sub">Won't Find Online</span>
            </div>
          </div>
        </div>

        <p class="lof-footnote">Your information is secure and will never be shared.</p>
      </div>
    `;
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';

    overlay.querySelector('.lof-close').onclick = function () { closeOverlay(overlay); };
    overlay.querySelector('#lof-search').onclick = function () {
      if (onHome) {
        window.location.href = SEARCH_URL;
      } else {
        // On a sub-page (e.g. property detail) — just dismiss so the user
        // can keep doing what they were doing.
        closeOverlay(overlay);
      }
    };
    overlay.querySelector('#lof-offmkt-btn').onclick = function () {
      window.location.href = '/contact';
    };
  }

  // ==========================================================================
  //  Hook the Lofty register popup
  // ==========================================================================
  function scan() {
    setupRegisterPopup();

    document
      .querySelectorAll('.pop-sign-log.register input[type=submit]')
      .forEach(function (btn) {
        if (hooked.has(btn)) return;
        hooked.add(btn);
        btn.addEventListener('click', function (e) {
          if (bypassRegister) return;
          const wrap = btn.closest('.submit');
          if (wrap && wrap.classList.contains('disabled')) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          buildPhoneModal(btn);
        }, true);
      });
  }
  setInterval(scan, 700);
  scan();

  // ==========================================================================
  //  Styles
  // ==========================================================================
  const style = document.createElement('style');
  style.textContent = `
    /* ===== Shared primitives ===== */
    .lof-overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #1f2a44;
    }
    .lof-overlay * { box-sizing: border-box; }
    .lof-backdrop {
      position: absolute; inset: 0;
      background: rgba(15, 23, 42, 0.65);
      backdrop-filter: blur(2px);
    }
    .lof-card {
      position: relative; background: #fff; border-radius: 16px;
      box-shadow: 0 30px 70px rgba(0,0,0,.45);
      max-height: 94vh; overflow-y: auto; overflow-x: hidden;
    }
    .lof-card::-webkit-scrollbar { width: 8px; }
    .lof-card::-webkit-scrollbar-thumb { background: #d0d6e2; border-radius: 4px; }
    .lof-close {
      position: absolute; top: 14px; right: 14px;
      width: 32px; height: 32px; border: 0; border-radius: 50%;
      background: rgba(0,0,0,0.04); color: #5a6478;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      z-index: 2;
    }
    .lof-close:hover { background: rgba(0,0,0,0.08); color: #1f2a44; }
    .lof-close svg { width: 16px; height: 16px; }
    .lof-svg { display: inline-flex; align-items: center; justify-content: center; }
    .lof-svg svg { width: 100%; height: 100%; display: block; }
    .lof-center { text-align: center; }
    .lof-h2 { font-size: 30px; line-height: 1.2; font-weight: 800; margin: 0 0 10px; color: #0f1b3d; }
    .lof-h3 { font-size: 20px; line-height: 1.3; font-weight: 700; margin: 0 0 6px; color: #0f1b3d; }
    .lof-sub { font-size: 14.5px; color: #4d586e; line-height: 1.55; margin: 0 0 16px; }
    .lof-sub-sm { font-size: 13.5px; color: #4d586e; line-height: 1.5; margin: 0 0 14px; }
    .lof-err { min-height: 16px; font-size: 12.5px; color: #c33; margin: 4px 0 8px; }
    .lof-fineprint { font-size: 11.5px; color: #8b93a7; line-height: 1.5; margin: 10px 0 0; }
    .lof-btn-primary {
      width: 100%; padding: 14px 16px; border: 0; border-radius: 10px;
      background: #2b5fdb; color: #fff; font-size: 15px; font-weight: 700;
      cursor: pointer; transition: background .2s;
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    }
    .lof-btn-primary:hover:not(:disabled) { background: #1f4cb8; }
    .lof-btn-primary:disabled { background: #b8c5e0; cursor: not-allowed; }
    .lof-btn-primary .lof-plane { width: 16px; height: 16px; color: #fff; }
    .lof-btn-secondary {
      width: 100%; padding: 11px; border: 1px solid #d0d6e2; border-radius: 8px;
      background: #fff; color: #2b5fdb; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .lof-btn-secondary:hover:not(:disabled) { background: #f5f7fb; }
    .lof-btn-secondary:disabled { color: #8b93a7; border-color: #e5e8ee; cursor: not-allowed; }
    .lof-btn-block { margin-top: 8px; }

    /* ===== Phone modal ===== */
    .lof-phone-card { width: 92%; max-width: 920px; padding: 0; overflow: hidden; }
    .lof-phone-grid { display: grid; grid-template-columns: 1.15fr 1fr; }
    .lof-phone-left { padding: 36px 32px 24px; background: #fff; }
    .lof-phone-right {
      padding: 36px 32px 24px;
      background: linear-gradient(180deg, #f7faff 0%, #ffffff 100%);
      border-left: 1px solid #eef2f9;
    }
    .lof-benefits { list-style: none; margin: 6px 0 0; padding: 0; }
    .lof-benefits li {
      display: flex; gap: 14px; padding: 12px 0;
      align-items: flex-start;
    }
    .lof-benefits li + li { border-top: 1px solid #eef2f9; }
    .lof-bicon {
      width: 38px; height: 38px; flex-shrink: 0;
      border-radius: 50%; background: #e8eefc;
      display: flex; align-items: center; justify-content: center;
      color: #2b5fdb;
    }
    .lof-bicon svg { width: 19px; height: 19px; }
    .lof-benefits h4 { margin: 2px 0 4px; font-size: 15px; font-weight: 700; color: #0f1b3d; }
    .lof-benefits p { margin: 0; font-size: 13px; color: #5a6478; line-height: 1.5; }
    .lof-phone-illu {
      width: 150px; height: 130px; margin: 0 auto 10px;
      display: flex; align-items: center; justify-content: center;
    }
    .lof-phone-illu svg { width: 100%; height: 100%; }
    .lof-tel-row {
      display: flex; gap: 8px; align-items: stretch;
      border: 1px solid #d0d6e2; border-radius: 10px; padding: 0 6px 0 12px;
      background: #fff;
    }
    .lof-tel-row:focus-within {
      border-color: #2b5fdb;
      box-shadow: 0 0 0 3px rgba(43, 95, 219, 0.15);
    }
    .lof-flag {
      display: inline-flex; align-items: center;
      padding-right: 10px; margin-right: 2px;
      border-right: 1px solid #eef2f9;
    }
    .lof-flag svg {
      width: 26px; height: 18px;
      border-radius: 2px;
      box-shadow: 0 0 0 1px rgba(0,0,0,.06);
    }
    .lof-tel-row input {
      flex: 1; border: 0; outline: none; padding: 12px 8px;
      font-size: 16px; color: #1f2a44; background: transparent;
    }
    .lof-or {
      position: relative; text-align: center; margin: 18px 0 14px;
      color: #8b93a7; font-size: 12px; font-weight: 600; letter-spacing: 2px;
    }
    .lof-or:before, .lof-or:after {
      content: ''; position: absolute; top: 50%; width: 38%; height: 1px; background: #eef2f9;
    }
    .lof-or:before { left: 0; }
    .lof-or:after { right: 0; }
    .lof-or span { background: transparent; padding: 0 8px; }
    .lof-privacy-box {
      background: #fff8e7; border: 1px solid #ffe8a8;
      border-radius: 10px; padding: 14px 16px;
    }
    .lof-privacy-head {
      display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
    }
    .lof-shield { width: 22px; height: 22px; color: #f59e0b; }
    .lof-privacy-head strong { font-size: 14px; color: #92660b; font-weight: 700; }
    .lof-privacy-box ul { list-style: none; margin: 0; padding: 0; font-size: 12.5px; color: #6b5414; }
    .lof-privacy-box li { padding: 3px 0; line-height: 1.45; }
    .lof-privacy-box li:before { content: '✓ '; color: #f59e0b; font-weight: bold; margin-right: 4px; }

    .lof-bottom-bar {
      grid-column: 1 / -1;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 14px 24px; background: #14213d; color: #fff;
      flex-wrap: wrap;
    }
    .lof-bar-left { display: flex; align-items: center; gap: 12px; }
    .lof-bar-chat { width: 24px; height: 24px; color: #fcce17; }
    .lof-bar-left strong { display: block; font-size: 14px; }
    .lof-bar-sub { font-size: 12px; color: #b8c5e0; }
    .lof-bar-phone {
      display: inline-flex; align-items: center; gap: 8px;
      background: #fcce17; color: #14213d; text-decoration: none;
      padding: 10px 16px; border-radius: 8px; font-weight: 700; font-size: 14px;
    }
    .lof-bar-phone .lof-svg { width: 16px; height: 16px; }
    .lof-bar-phone:hover { background: #e8bb14; }

    /* Phone modal grid → bottom bar; wrap into the same flow */
    .lof-phone-card > .lof-phone-grid { }

    @media (max-width: 760px) {
      .lof-phone-grid { grid-template-columns: 1fr; }
      .lof-phone-right { border-left: 0; border-top: 1px solid #eef2f9; }
      .lof-h2 { font-size: 24px; }
    }

    /* ===== OTP modal ===== */
    .lof-otp-card {
      width: 92%; max-width: 440px; padding: 28px 28px 22px;
      text-align: center; position: relative;
    }
    .lof-otp-hero { display: flex; justify-content: center; margin: 4px 0 14px; position: relative; }
    .lof-shield-house { width: 48px; height: 48px; display: inline-flex; align-items: center; justify-content: center; }
    .lof-shield-house svg { width: 100%; height: 100%; }
    .lof-otp-hero:before, .lof-otp-hero:after {
      content: ''; position: absolute; top: 50%; width: 8px; height: 8px;
      border-radius: 50%; border: 1.5px solid #c9d4f0; transform: translateY(-50%);
    }
    .lof-otp-hero:before { left: calc(50% - 50px); }
    .lof-otp-hero:after { right: calc(50% - 50px); }
    .lof-otp-title {
      font-size: 18px; font-weight: 600; color: #0f1b3d;
      margin: 0 0 12px; line-height: 1.15; letter-spacing: -0.2px;
    }
    .lof-otp-title-em {
      display: block; font-size: 30px; font-weight: 800; color: #0f1b3d;
      margin-top: 2px;
    }
    .lof-otp-sub {
      font-size: 13.5px; color: #5a6478; margin: 0 0 12px;
    }
    .lof-phone-pill {
      display: inline-flex; align-items: center; gap: 8px;
      background: #fff; border: 1px solid #d8dfeb;
      border-radius: 999px; padding: 8px 18px;
      font-size: 15px; font-weight: 600; color: #0f1b3d;
    }
    .lof-pill-ic { width: 16px; height: 16px; color: #2b5fdb; }
    .lof-wrong {
      font-size: 12.5px; color: #5a6478; margin: 8px 0 14px;
    }
    .lof-wrong a {
      color: #2b5fdb; text-decoration: underline; font-weight: 600; cursor: pointer;
    }
    .lof-info-box {
      display: flex; align-items: flex-start; gap: 10px;
      background: #eef3fc; border-radius: 10px;
      padding: 11px 14px; margin: 0 0 18px;
      text-align: left;
    }
    .lof-info-ic { width: 18px; height: 18px; color: #2b5fdb; flex-shrink: 0; margin-top: 1px; }
    .lof-info-box p {
      margin: 0; font-size: 12px; color: #3d4763; line-height: 1.5;
    }
    .lof-info-box b { color: #2b5fdb; font-weight: 700; }

    .lof-otp-boxes {
      display: flex; gap: 8px; justify-content: center; margin: 0 0 14px;
    }
    .lof-otp-box {
      width: 44px; height: 52px; text-align: center;
      font-size: 22px; font-weight: 700; color: #0f1b3d;
      border: 1.5px solid #d8dfeb; border-radius: 10px;
      background: #fff; transition: border-color .15s, box-shadow .15s;
      caret-color: #2b5fdb;
    }
    .lof-otp-box:focus {
      outline: none; border-color: #2b5fdb;
      box-shadow: 0 0 0 3px rgba(43,95,219,.15);
    }
    .lof-ttl {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 12.5px; color: #f97316;
      margin: 0 0 16px; font-weight: 500;
    }
    .lof-ttl .lof-svg { width: 14px; height: 14px; }
    .lof-ttl b { color: #f97316; font-weight: 700; }
    .lof-ttl-exp, .lof-ttl-exp b { color: #c33; }

    #lof-verify.lof-btn-hero {
      gap: 10px; padding: 14px 18px; font-size: 15px;
      box-shadow: 0 6px 18px rgba(43,95,219,.30);
    }
    #lof-verify .lof-svg { width: 18px; height: 18px; }
    #lof-verify .lof-btn-arrow { width: 18px; height: 18px; }

    .lof-link-btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: transparent; border: 0;
      color: #2b5fdb; font-size: 13px; font-weight: 600;
      cursor: pointer; padding: 10px;
      margin: 4px 0 0;
    }
    .lof-link-btn .lof-svg { width: 14px; height: 14px; }
    .lof-link-btn:hover:not(:disabled) { text-decoration: underline; }
    .lof-link-btn:disabled { color: #8b93a7; cursor: not-allowed; }

    .lof-msg { min-height: 16px; font-size: 12.5px; margin: 6px 0 0; }
    .lof-otp-foot {
      display: inline-flex; align-items: center; gap: 6px; justify-content: center;
      margin: 14px 0 0; padding-top: 14px; border-top: 1px solid #eef2f9;
      font-size: 11.5px; color: #8b93a7;
    }
    .lof-otp-foot .lof-svg { width: 12px; height: 12px; }

    /* Edit phone modal */
    .lof-edit-card { width: 92%; max-width: 420px; padding: 32px 28px 24px; }
    .lof-edit-card .lof-btn-primary { margin-top: 8px; }

    @media (max-width: 480px) {
      .lof-otp-title-em { font-size: 24px; }
      .lof-otp-box { width: 38px; height: 46px; font-size: 18px; }
      .lof-otp-boxes { gap: 6px; }
    }

    /* ===== Success modal ===== */
    .lof-success-card { width: 92%; max-width: 820px; padding: 40px 38px 28px; }
    .lof-succ-hero { text-align: center; margin-bottom: 22px; }
    .lof-check { width: 76px; height: 76px; margin: 0 auto 14px; }
    .lof-check svg { width: 100%; height: 100%; }
    .lof-succ-sub {
      color: #2b5fdb; font-size: 16px; font-weight: 700;
      margin: 4px 0 10px; letter-spacing: .2px;
    }

    .lof-feat-row {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px;
      margin: 0 0 22px;
    }
    .lof-feat { text-align: center; padding: 4px; }
    .lof-feat-ic {
      width: 44px; height: 44px; margin: 0 auto 10px; border-radius: 50%;
      background: #e8eefc; color: #2b5fdb;
      display: flex; align-items: center; justify-content: center;
    }
    .lof-feat-ic svg { width: 22px; height: 22px; }
    .lof-feat h4 { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: #0f1b3d; }
    .lof-feat p { margin: 0; font-size: 11.5px; color: #5a6478; line-height: 1.45; }

    .lof-btn-hero {
      padding: 16px 18px; font-size: 16px; gap: 12px;
      box-shadow: 0 6px 18px rgba(43, 95, 219, 0.30);
    }
    .lof-btn-hero .lof-svg { width: 22px; height: 22px; }
    .lof-btn-stack { display: flex; flex-direction: column; align-items: center; line-height: 1.2; }
    .lof-btn-stack small { font-size: 11px; font-weight: 500; opacity: .85; margin-top: 2px; }

    /* Off-market */
    .lof-offmkt {
      margin: 26px 0 22px;
      display: grid; grid-template-columns: 1.55fr 1fr; gap: 0;
      background: #fff6ed; border: 1px solid #ffd6b0;
      border-radius: 14px; overflow: hidden;
    }
    .lof-offmkt-content { padding: 24px 26px; }
    .lof-offmkt-head { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
    .lof-offmkt-ic { width: 34px; height: 34px; color: #f97316; flex-shrink: 0; margin-top: 2px; }
    .lof-offmkt h3 { font-size: 18px; font-weight: 800; color: #0f1b3d; margin: 0; line-height: 1.25; }
    .lof-stk { color: #f97316; }
    .lof-offmkt p { font-size: 13px; color: #5a6478; line-height: 1.5; margin: 0 0 14px; }
    .lof-offmkt-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; margin: 0 0 16px;
    }
    .lof-offmkt-grid > div {
      display: flex; align-items: center; gap: 8px;
      font-size: 12.5px; color: #1f2a44;
      white-space: nowrap;
    }
    .lof-offmkt-grid svg { width: 14px; height: 14px; flex-shrink: 0; }
    .lof-btn-orange {
      width: 100%; padding: 13px 16px; border: 0; border-radius: 10px;
      background: #f97316; color: #fff; font-size: 14px; font-weight: 700;
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 10px;
      transition: background .2s;
    }
    .lof-btn-orange:hover { background: #ea6a0c; }
    .lof-btn-orange .lof-svg { width: 18px; height: 18px; color: #fcce17; }
    .lof-offmkt-img {
      min-height: 280px;
      background-size: cover; background-position: center; background-repeat: no-repeat;
    }

    /* Local. Proactive. Connected. */
    .lof-lpc {
      background: #f5f7fb; border-radius: 12px; padding: 20px 24px;
      margin: 0 0 16px;
      display: grid; grid-template-columns: 1.3fr 2fr; gap: 20px;
      align-items: center;
    }
    .lof-lpc-intro {
      display: flex; align-items: center; gap: 14px;
    }
    .lof-lpc-shield { width: 42px; height: 42px; flex-shrink: 0; }
    .lof-lpc-shield svg { width: 100%; height: 100%; }
    .lof-lpc h4 { margin: 0 0 4px; font-size: 15px; font-weight: 800; color: #0f1b3d; }
    .lof-lpc-intro p { margin: 0; font-size: 12px; color: #5a6478; line-height: 1.45; }
    .lof-lpc-feats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .lof-lpc-feat {
      display: flex; flex-direction: column; align-items: center;
      text-align: center; font-size: 12px; color: #1f2a44; gap: 2px;
    }
    .lof-lpc-ic {
      width: 36px; height: 36px; margin-bottom: 6px;
      border-radius: 50%; background: #e8eefc; color: #2b5fdb;
      display: flex; align-items: center; justify-content: center;
    }
    .lof-lpc-ic svg { width: 18px; height: 18px; }
    .lof-lpc-feat strong { font-weight: 700; }
    .lof-lpc-sub { font-size: 11.5px; color: #5a6478; }

    .lof-footnote {
      text-align: center; font-size: 11px; color: #8b93a7;
      margin: 12px 0 0;
    }

    @media (max-width: 820px) {
      .lof-success-card { padding: 28px 22px 22px; }
      .lof-feat-row { grid-template-columns: repeat(2, 1fr); }
      .lof-offmkt { grid-template-columns: 1fr; }
      .lof-offmkt-img { min-height: 180px; order: 2; }
      .lof-offmkt-grid { grid-template-columns: 1fr; }
      .lof-offmkt-grid > div { white-space: normal; }
      .lof-lpc { grid-template-columns: 1fr; gap: 14px; text-align: center; }
      .lof-lpc-intro { flex-direction: column; gap: 8px; }
      .lof-h2 { font-size: 22px; }
    }
  `;
  document.head.appendChild(style);
})();
