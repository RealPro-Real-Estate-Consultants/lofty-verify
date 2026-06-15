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
  const SEARCH_URL = 'https://everyswflhome.com/listing';   // where the "Start Searching Homes" button takes the user
  const HEADERS = { 'Content-Type': 'application/json' };

  // House photo for the off-market section. Served from the Railway /public
  // folder in production; from a relative path when running preview.html offline.
  // File lives at lofty-verify/public/success modal image.png.
  const HOUSE_PHOTO_FILE = 'success%20modal%20image.png';
  const HOUSE_PHOTO = location.protocol === 'file:'
    ? 'public/' + HOUSE_PHOTO_FILE
    : BACKEND + '/' + HOUSE_PHOTO_FILE;

  // ---- State ---------------------------------------------------------------
  let verified = false;
  const hooked = new WeakSet();

  // ---- Preview mode --------------------------------------------------------
  // Enable with `?lof-preview=phone|otp|edit|success` in the URL, OR call
  // window.__lofPreview.phone() / .otp() / .edit() / .success() in the console.
  // In preview mode all backend calls are stubbed (no SMS is sent) and the
  // OTP modal will accept any 6-digit code as "approved".
  let previewMode = false;

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
    if (previewMode) {
      console.log('[lof-preview] would POST', path, body);
      // /verify-otp returns approved so any code passes through.
      return Promise.resolve({
        ok: true,
        json: function () { return Promise.resolve({ status: 'approved' }); }
      });
    }
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
    key: '<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"><g transform="rotate(135 12 12)"><path d="M3 12a5 5 0 1 1 10 0 5 5 0 0 1-10 0zm5-1.8a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z"/><rect x="8" y="10.5" width="15" height="3"/><rect x="17" y="13.5" width="2.5" height="4.5"/><rect x="20.5" y="13.5" width="2.5" height="4.5"/></g></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    bellDollar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="13" width="6" height="8"/><rect x="9" y="8" width="6" height="13"/><rect x="15" y="3" width="6" height="18"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.7 2.3a1 1 0 0 0-1.02-.24L2.65 8.04a1 1 0 0 0-.06 1.86l6.85 2.92 2.92 6.85a1 1 0 0 0 1.86-.06l5.98-18.03a1 1 0 0 0-.5-1.28zM10.5 13.5l-4.3-1.84L18.6 6.5l-8.1 7zm1 1l7-8.1-5.16 12.4-1.84-4.3z"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.4-1.4L10 14.2l6.6-6.6L18 9l-8 8z"/></svg>',
    checkBig:
      '<svg viewBox="0 0 140 80" xmlns="http://www.w3.org/2000/svg">' +
        // Single pale-green circle (no outline, soft flat fill)
        '<circle cx="70" cy="40" r="32" fill="#dcefdf"/>' +
        // Medium-green checkmark — clean, rounded, naturally tilted up
        '<path d="M57 40l9 9 19-21" fill="none" stroke="#3aa544" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        // Left celebration accent lines — top angles down to the right, middle
        // horizontal, bottom angles up to the right (chevron pointing toward circle).
        '<g stroke="#6dbd72" stroke-width="2.6" stroke-linecap="round" fill="none">' +
          '<line x1="12" y1="18" x2="20" y2="24"/>' +
          '<line x1="6"  y1="40" x2="20" y2="40"/>' +
          '<line x1="12" y1="62" x2="20" y2="56"/>' +
        '</g>' +
        // Right celebration accent lines — mirror (top down-left, mid horizontal, bottom up-left)
        '<g stroke="#6dbd72" stroke-width="2.6" stroke-linecap="round" fill="none">' +
          '<line x1="128" y1="18" x2="120" y2="24"/>' +
          '<line x1="134" y1="40" x2="120" y2="40"/>' +
          '<line x1="128" y1="62" x2="120" y2="56"/>' +
        '</g>' +
      '</svg>',
    house: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      // Roof eaves overhang the walls (corners at x=2 and x=22, walls at x=5 and x=19)
      '<path d="M2 9L12 2 22 9 19 9V20a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9Z"/>' +
      // Chimney on the right roof slope — 3-sided so it cleanly meets the roof line
      '<path d="M17 5.5V3.5H18.5V6.5"/>' +
      // Door
      '<polyline points="9 22 9 14 15 14 15 22"/>' +
      '</svg>',
    houseWide: '<svg viewBox="0 0 30 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      // Roof: eaves at x=2 / x=28, peak (15, 2); walls at x=6 / x=24
      '<path d="M2 9L15 2 28 9 24 9V20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9Z"/>' +
      // Chimney on right slope
      '<path d="M22 5.5V3.5H23.5V6.5"/>' +
      // Door — centered (x=13 → x=17), 7-unit gap to each wall
      '<polyline points="13 22 13 14 17 14 17 22"/>' +
      '</svg>',
    keyOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 9.5a4 4 0 1 1-5 5l-7 7v-3l1-1 6-6"/><path d="M14.5 9.5L19 5l-2-2-4.5 4.5"/></svg>',
    checkSm: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#f97316"/><path d="M4.5 8.2l2.3 2.3 4.7-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    checkSmOutline: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.6" stroke="#f97316" stroke-width="1.4"/><path d="M4.8 8.2l2.3 2.3 4.5-5" fill="none" stroke="#f97316" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    checkMark: '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5 L6.5 12 L13 4.5" stroke="#f97316" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    mapPin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    handshake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      // Right-hand fingers gripping back over the wrist
      '<path d="m11 17 2 2a1 1 0 1 0 3-3"/>' +
      // Main arm/hand path coming in from the right with the clasp and forearm
      '<path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/>' +
      // Right sleeve / cuff
      '<path d="m21 3 1 11h-2"/>' +
      // Left arm/hand swinging in from the lower-left to grip
      '<path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/>' +
      // Left sleeve / cuff
      '<path d="M3 4h8"/>' +
      // LEFT SLEEVE on the OUTER side of the left arm — runs the full height
      // alongside the left edge of the hand (from top y=3 down to y=14).
      '<path d="M3 3 L1 3 L0 14 L2 14 Z"/>' +
      // RIGHT SLEEVE on the OUTER side of the right arm — mirror, full height.
      '<path d="M21 3 L23 3 L24 14 L22 14 Z"/>' +
      '</svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    flagUS: '<svg viewBox="0 0 30 20" preserveAspectRatio="xMidYMid slice"><rect width="30" height="20" fill="#B22234"/><rect width="30" height="1.54" y="1.54" fill="#fff"/><rect width="30" height="1.54" y="4.62" fill="#fff"/><rect width="30" height="1.54" y="7.69" fill="#fff"/><rect width="30" height="1.54" y="10.77" fill="#fff"/><rect width="30" height="1.54" y="13.85" fill="#fff"/><rect width="30" height="1.54" y="16.92" fill="#fff"/><rect width="12" height="10.77" fill="#3C3B6E"/></svg>',
    flagCA: '<svg viewBox="0 0 30 20" preserveAspectRatio="xMidYMid slice"><rect width="30" height="20" fill="#fff"/><rect width="7.5" height="20" fill="#d52b1e"/><rect x="22.5" width="7.5" height="20" fill="#d52b1e"/><path d="M15 5.5 L15.7 7.3 L17.5 6.8 L16.9 8.7 L18.5 9.5 L17 10.3 L17.5 12.2 L15.7 11.6 L15 13.5 L14.3 11.6 L12.5 12.2 L13 10.3 L11.5 9.5 L13.1 8.7 L12.5 6.8 L14.3 7.3 Z" fill="#d52b1e"/></svg>',
    caret: '<svg viewBox="0 0 12 8" fill="currentColor"><path d="M1 1l5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    chatCircle: '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#3e5da4"/><path d="M11 17a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4h-6.5l-3.5 3.5V25h-0.5a4 4 0 0 1-3.5-4z" fill="#fff"/></svg>',
    shieldOrange:
      '<svg viewBox="-3 -3 38 38" xmlns="http://www.w3.org/2000/svg">' +
        '<defs><linearGradient id="lofShOrange" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#fdba74"/>' +
          '<stop offset="100%" stop-color="#ea580c"/>' +
        '</linearGradient></defs>' +
        // Outer outline echoing the shield shape
        '<path d="M16 -1L1 5.5v10.5c0 8.5 6 15.5 15 18.5 9-3 15-10 15-18.5V5.5L16 -1z" fill="none" stroke="#fdba74" stroke-width="1.4" opacity=".75"/>' +
        // Inner gradient shield
        '<path d="M16 2L4 7v9c0 7.5 5 13.5 12 16 7-2.5 12-8.5 12-16V7L16 2z" fill="url(#lofShOrange)"/>' +
        // Checkmark
        '<path d="M10 16l4 4 9-9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>',
    planeFilled: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 L2 9 L11 13 L15 22 Z"/><path d="M22 2 L11 13"/></svg>',
    houseLock: '<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
      // Soft cream circular background
      '<circle cx="30" cy="30" r="27" fill="#fff1e3"/>' +
      // Whole house+lock group shifted so its visible bounding box (x:5-37, y:12-46)
      // is centered on the circle center (30, 30).
      '<g transform="translate(9 1)">' +
        // House
        '<g fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M5 25L21 12 37 25 33 25V44H9V25Z"/>' +
          '<path d="M17 44V34a4 4 0 0 1 8 0V44"/>' +
        '</g>' +
        // Lock cream halo (cleans house lines behind the lock with a small gap)
        '<rect x="22" y="33" width="17" height="15" rx="3" fill="#fff1e3"/>' +
        // Lock body
        '<rect x="24" y="35" width="13" height="11" rx="2" fill="#fff1e3" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>' +
        // Shackle
        '<path d="M27 35V32a3.5 3.5 0 0 1 7 0V35" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        // Keyhole
        '<circle cx="30.5" cy="39.5" r="1.2" fill="currentColor"/>' +
        '<line x1="30.5" y1="40.3" x2="30.5" y2="43.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '</g>' +
      '</svg>',
    shieldCheck: '<svg viewBox="0 0 40 40"><path d="M20 3L4 9v11c0 9.5 6.5 17.5 16 19 9.5-1.5 16-9.5 16-19V9z" fill="#2b5fdb"/><path d="M12 21l5 5 11-12" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    shieldCheckOutline:
      '<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">' +
        // Outer outlined shield — shoulders curve sharply down from a pointed apex
        '<path d="M20 2 C18 5 10 8 6 10 V18 C6 27 11 34 20 37 C29 34 34 27 34 18 V10 C30 8 22 5 20 2 Z" ' +
              'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>' +
        // Inner solid shield, slightly smaller, same silhouette
        '<path d="M20 6 C18.5 8.5 13 10.5 10 12 V18 C10 25 14 31 20 33 C26 31 30 25 30 18 V12 C27 10.5 21.5 8.5 20 6 Z" ' +
              'fill="currentColor"/>' +
        // White check centered inside the solid shield
        '<path d="M14.5 20 L18.5 24 L26 16.5" ' +
              'fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>',
    people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    shieldHouse:
      '<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">' +
        // Light circular halo
        '<circle cx="40" cy="40" r="32" fill="#e8eefc"/>' +
        // Shield — apex y=17, shoulders (22, 25)/(58, 25), bottom (40, 61).
        // Quadratic curves on each flank bulge outward from the shoulder before
        // sweeping in to the bottom point — classic heater-shield silhouette.
        '<path d="M40 17Q30 27 22 25Q19 46 36 58Q40 62 44 58Q61 46 58 25Q50 27 40 17Z" fill="#fff" stroke="#3e5da4" stroke-width="2.2" stroke-linejoin="round"/>' +
        // House — same scale (0.85), re-centered inside the lifted shield
        '<g transform="translate(40 39) scale(0.85)">' +
          // Walls (solid brand-blue rectangle)
          '<rect x="-9" y="-2" width="18" height="13" fill="#3e5da4"/>' +
          // Door (white cut-out, centered, reaches floor)
          '<rect x="-2.1" y="3.6" width="4.2" height="8.4" fill="#fff" rx="0.4"/>' +
          // Door knob
          '<circle cx="1.2" cy="8" r="0.42" fill="#3e5da4"/>' +
          // Grid window above the door
          '<rect x="-3.4" y="-1.4" width="6.8" height="3.6" fill="#fff" rx="0.4"/>' +
          '<line x1="0" y1="-1.4" x2="0" y2="2.2" stroke="#3e5da4" stroke-width="0.55"/>' +
          '<line x1="-3.4" y1="0.4" x2="3.4" y2="0.4" stroke="#3e5da4" stroke-width="0.55"/>' +
          // Roof — thicker brand-blue outline, lighter-blue fill, eaves overhang the walls
          '<path d="M-10.8 -2L0 -11 10.8 -2Z" fill="#a8b8de" stroke="#3e5da4" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>' +
          // Chimney on the right slope (slanted bottom follows the roof line)
          '<path d="M3.6 -12L5.2 -12 5.2 -5.8 3.6 -7.2Z" fill="#3e5da4"/>' +
          // Chimney cap
          '<rect x="3.2" y="-12.5" width="2.4" height="0.7" fill="#3e5da4" rx="0.15"/>' +
        '</g>' +
      '</svg>',
    sparkle: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/><circle cx="19" cy="5" r="1.5"/><circle cx="5" cy="19" r="1.5"/></svg>',
    sparkleOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l2.2 6.3L20.5 11l-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-1.7z"/></svg>',
    sparkleOutlineDuo:
      '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">' +
        // big star (lower-left)
        '<path d="M11 5l2 5.5 5.5 1.5-5.5 1.5-2 5.5-2-5.5L3.5 12l5.5-1.5z"/>' +
        // small star (upper-right)
        '<path d="M22 3.5l0.9 2.3 2.3 0.7-2.3 0.7-0.9 2.3-0.9-2.3-2.3-0.7 2.3-0.7z" stroke-width="1.4"/>' +
      '</svg>',
    phoneFilled: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 15.5c-1.3 0-2.5-.2-3.6-.6-.4-.1-.8 0-1.1.3l-2.2 2.2c-2.9-1.5-5.3-3.8-6.8-6.8l2.2-2.2c.3-.3.4-.7.3-1.1-.4-1.2-.6-2.4-.6-3.6 0-.6-.5-1-1-1H3.5C2.9 2.7 2.5 3.1 2.5 3.7 2.5 13.6 10.4 21.5 20.3 21.5c.6 0 1-.5 1-1V17c0-.6-.5-1-1-1z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    arrowR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    lock2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="11" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><line x1="12" y1="15" x2="12" y2="18.5"/></svg>',
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
        // Speech bubble — filled with brand blue (extended width for star padding)
        '<rect x="88" y="72" width="124" height="44" rx="10" fill="#3e5da4"/>' +
        '<path d="M112 116 L106 130 L122 116 Z" fill="#3e5da4"/>' +
        // Lock (white, keyhole shows through to bubble color)
        '<g transform="translate(116 94)">' +
          '<path d="M-4 0 V-3.5 A4 4 0 0 1 4 -3.5 V0" fill="none" stroke="#fff" stroke-width="1.8"/>' +
          '<rect x="-5.5" y="0" width="11" height="9" rx="1.3" fill="#fff"/>' +
          '<circle cx="0" cy="4.5" r="1" fill="#3e5da4"/>' +
        '</g>' +
        // 5 stars to the right of the lock, white
        '<g fill="#fff">' +
          '<polygon points="0,-5 1.5,-1.5 5,-1.5 2.2,0.8 3.2,4.5 0,2.2 -3.2,4.5 -2.2,0.8 -5,-1.5 -1.5,-1.5" transform="translate(138 94)"/>' +
          '<polygon points="0,-5 1.5,-1.5 5,-1.5 2.2,0.8 3.2,4.5 0,2.2 -3.2,4.5 -2.2,0.8 -5,-1.5 -1.5,-1.5" transform="translate(152 94)"/>' +
          '<polygon points="0,-5 1.5,-1.5 5,-1.5 2.2,0.8 3.2,4.5 0,2.2 -3.2,4.5 -2.2,0.8 -5,-1.5 -1.5,-1.5" transform="translate(166 94)"/>' +
          '<polygon points="0,-5 1.5,-1.5 5,-1.5 2.2,0.8 3.2,4.5 0,2.2 -3.2,4.5 -2.2,0.8 -5,-1.5 -1.5,-1.5" transform="translate(180 94)"/>' +
          '<polygon points="0,-5 1.5,-1.5 5,-1.5 2.2,0.8 3.2,4.5 0,2.2 -3.2,4.5 -2.2,0.8 -5,-1.5 -1.5,-1.5" transform="translate(194 94)"/>' +
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

    const container = phoneInput.closest('.v-input');
    if (container) container.style.display = 'none';

    // enhanceRegisterForm();
  }

  // Injects rich content (bullet lists, serving area, privacy note) and
  // the under-button subtext into the Lofty register popup. Idempotent.
  function enhanceRegisterForm() {
    const popup = document.querySelector('.pop-sign-log.register');
    if (!popup || popup.dataset.otpEnhanced === '1') return;
    popup.dataset.otpEnhanced = '1';

    const form = popup.querySelector('form');
    if (!form) return;
    const firstInput = form.querySelector('.v-input');
    if (!firstInput) return;

    // ---- Inject rich content above the form fields ------------------------
    const enrich = document.createElement('div');
    enrich.className = 'lof-form-enrich';
    enrich.innerHTML = `
      <div class="lof-search-by">
        <h4>Search by:</h4>
        <ul>
          <li>Gulf Access</li>
          <li>Canal Width</li>
          <li>Boat Lift</li>
          <li>Golf Communities</li>
          <li>55+ Communities</li>
          <li>Pet Restrictions</li>
          <li>HOA Requirements</li>
          <li>Insurance Requirements</li>
          <li>New Construction</li>
          <li>Acreage</li>
          <li>+41 other local MLS fields</li>
        </ul>
      </div>
      <div class="lof-unlock">
        <h4>Unlock advanced home search tools:</h4>
        <ul>
          <li>Discover private opportunities when available</li>
          <li>Access advanced MLS search filters</li>
          <li>Receive instant property alerts and price reductions</li>
          <li>Save searches and favorite properties</li>
        </ul>
      </div>
      <p class="lof-serving">
        <b>Serving</b> Cape Coral, Fort Myers, Fort Myers Beach, Estero,
        Bonita Springs, Sanibel, Captiva, Naples, and Marco Island.
      </p>
      <p class="lof-privacy-note">
        <b>We respect your privacy.</b> Your information is never sold to
        advertisers, lenders, or third-party lead networks.
      </p>
      <hr class="lof-form-rule">
    `;
    firstInput.parentNode.insertBefore(enrich, firstInput);

    // ---- Lock the submit button text --------------------------------------
    // Lofty's Vue layer re-renders the submit input whenever the form state
    // changes (consent toggled, field typed in, etc.) and resets `value`.
    // We override the input's value property descriptor so any attempt by
    // Vue to write a different value gets re-routed to our text. A
    // MutationObserver re-locks if Vue replaces the element entirely.
    const BTN_TEXT = 'CONTINUE TO ADVANCED HOME SEARCH';

    function lockButton(btn) {
      if (!btn || btn.dataset.otpLocked === '1') return;
      btn.dataset.otpLocked = '1';

      const proto = Object.getPrototypeOf(btn);
      const orig  = Object.getOwnPropertyDescriptor(proto, 'value');
      Object.defineProperty(btn, 'value', {
        get: function () { return BTN_TEXT; },
        set: function () { orig.set.call(this, BTN_TEXT); },
        configurable: true
      });
      orig.set.call(btn, BTN_TEXT);
      // Belt-and-suspenders: also pin the attribute (in case Vue reads
      // from the DOM attribute rather than the property at render time).
      btn.setAttribute('value', BTN_TEXT);
    }

    function lockAnySubmit() {
      lockButton(document.querySelector('.pop-sign-log.register .submit input[type="submit"]'));
    }
    lockAnySubmit();
    new MutationObserver(lockAnySubmit).observe(form, {
      childList: true, subtree: true
    });
    setInterval(lockAnySubmit, 500);

    // ---- Inject subtext below the submit button ---------------------------
    const submitWrap = form.querySelector('.submit');
    if (submitWrap) {
      const note = document.createElement('p');
      note.className = 'lof-submit-note';
      note.textContent =
        'Phone verification is required on the next step to protect your ' +
        'account and provide accurate property alerts.';
      if (submitWrap.nextSibling) {
        submitWrap.parentNode.insertBefore(note, submitWrap.nextSibling);
      } else {
        submitWrap.parentNode.appendChild(note);
      }
    }
  }

  // ==========================================================================
  //  Modal 1: branded phone-number capture screen
  // ==========================================================================
  function buildPhoneModal() {
    const overlay = document.createElement('div');
    overlay.className = 'lof-overlay';
    overlay.id = 'lof-phone-modal';
    overlay.innerHTML = `
      <div class="lof-backdrop"></div>
      <div class="lof-card lof-phone-card">
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
              <div class="lof-country" id="lof-country">
                <button class="lof-country-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
                  <span class="lof-flag-current">${ICONS.flagUS}</span>
                  <span class="lof-caret">${ICONS.caret}</span>
                </button>
                <ul class="lof-country-menu" role="listbox" hidden>
                  <li role="option" data-country="US" data-flag="flagUS">
                    <span class="lof-flag-mini">${ICONS.flagUS}</span>
                    <span class="lof-country-name">United States</span>
                    <span class="lof-dial">+1</span>
                  </li>
                  <li role="option" data-country="CA" data-flag="flagCA">
                    <span class="lof-flag-mini">${ICONS.flagCA}</span>
                    <span class="lof-country-name">Canada</span>
                    <span class="lof-dial">+1</span>
                  </li>
                </ul>
              </div>
              <input id="lof-phone" type="tel" inputmode="numeric" autocomplete="tel"
                     placeholder="(XXX) XXX-XXXX" maxlength="14">
            </div>
            <p class="lof-err" id="lof-phone-err"></p>

            <button id="lof-send" type="button" class="lof-btn-primary">
              <span class="lof-svg lof-plane">${ICONS.planeFilled}</span>
              Text Me the Code
            </button>

            <p class="lof-fineprint">
              By providing your phone number you agree to receive transactional
              and marketing texts via SMS.
            </p>

            <div class="lof-or"><span>OR</span></div>

            <div class="lof-privacy-box">
              <div class="lof-privacy-head">
                <span class="lof-svg lof-shield">${ICONS.shieldOrange}</span>
                <strong>Your Privacy Matters</strong>
              </div>
              <ul class="lof-priv-list">
                <li><span class="lof-priv-check">${ICONS.checkMark}</span>No spam. No pressure.</li>
                <li><span class="lof-priv-check">${ICONS.checkMark}</span>Opt out anytime.</li>
                <li><span class="lof-priv-check">${ICONS.checkMark}</span>Your information is never sold to third parties like the national real estate portals.</li>
              </ul>
            </div>
          </div>
        </div>

        <!-- bottom CTA bar -->
        <div class="lof-bottom-bar">
          <div class="lof-bar-left">
            <span class="lof-svg lof-bar-chat">${ICONS.chatCircle}</span>
            <span class="lof-bar-text">
              <strong>Questions? Text us anytime.</strong> We're local and happy to help!
            </span>
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

    // Country dropdown
    const countryRoot = overlay.querySelector('#lof-country');
    const countryBtn  = countryRoot.querySelector('.lof-country-btn');
    const countryMenu = countryRoot.querySelector('.lof-country-menu');
    const flagCurrent = countryRoot.querySelector('.lof-flag-current');
    countryBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      const willOpen = countryMenu.hidden;
      countryMenu.hidden = !willOpen;
      countryBtn.setAttribute('aria-expanded', String(willOpen));
    });
    countryMenu.querySelectorAll('li').forEach(function (li) {
      li.addEventListener('click', function () {
        const flag = ICONS[li.dataset.flag];
        if (flag) flagCurrent.innerHTML = flag;
        countryMenu.hidden = true;
        countryBtn.setAttribute('aria-expanded', 'false');
      });
    });
    document.addEventListener('click', function (e) {
      if (!countryRoot.contains(e.target)) {
        countryMenu.hidden = true;
        countryBtn.setAttribute('aria-expanded', 'false');
      }
    });

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

      closeOverlay(overlay);
      fireOTP(parsed.e164);
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
        <div class="lof-otp-hero">
          <span class="lof-fadeline-l"></span>
          <span class="lof-shield-house">${ICONS.shieldHouse}</span>
          <span class="lof-fadeline-r"></span>
        </div>

        <h2 class="lof-otp-title">
          Enter Your<br>
          <span class="lof-otp-title-em">Verification Code</span>
        </h2>

        <p class="lof-otp-sub">We just texted a 6-digit code to:</p>

        <div class="lof-phone-pill">
          <span class="lof-pill-ic-wrap"><span class="lof-svg lof-pill-ic">${ICONS.phoneFilled}</span></span>
          <span id="lof-phone-display">${formatPhonePretty(phone)}</span>
        </div>
        <p class="lof-wrong">
          Wrong number? <a href="#" id="lof-edit-phone">Edit</a>
        </p>

        <div class="lof-info-box">
          <span class="lof-info-ic-wrap"><span class="lof-svg lof-info-ic">${ICONS.sparkleOutlineDuo}</span></span>
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

    editLink.onclick = function (e) {
      e.preventDefault();
      const localPhone = phone.length === 11 && phone[0] === '1' ? phone.slice(1) : phone;
      closeOverlay(overlay);
      clearInterval(expiryTimer);
      buildEditPhoneModal(
        localPhone,
        function (newE164) {
          // Submit → send new code, reopen OTP with new phone
          post('/send-verification', { phoneNumber: newE164 }).catch(function () {});
          buildOTPModal(newE164);
        },
        function () {
          // Cancel → reopen OTP with the original phone, no new code sent
          buildOTPModal(phone);
        }
      );
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
  function buildEditPhoneModal(prevLocal, onSubmit, onCancel) {
    const overlay = document.createElement('div');
    overlay.className = 'lof-overlay';
    overlay.id = 'lof-edit-modal';
    overlay.innerHTML = `
      <div class="lof-backdrop"></div>
      <div class="lof-card lof-edit-card">
        <h3 class="lof-h3 lof-center">Change Phone Number</h3>
        <p class="lof-sub-sm lof-center">Enter the correct mobile number and we'll send a new verification code.</p>
        <div class="lof-tel-row">
          <span class="lof-flag" aria-hidden="true">${ICONS.flagUS}</span>
          <input id="lof-edit-input" type="tel" inputmode="numeric" autocomplete="tel"
                 placeholder="(XXX) XXX-XXXX" maxlength="14">
        </div>
        <p class="lof-err" id="lof-edit-err"></p>
        <button id="lof-edit-go" class="lof-btn-primary">Send New Code</button>
        <button id="lof-edit-cancel" type="button" class="lof-link-btn lof-link-center">Cancel</button>
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

    overlay.querySelector('#lof-edit-cancel').onclick = function () {
      closeOverlay(overlay);
      if (onCancel) onCancel();
    };

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
    const searchBtnHTML =
      '<span class="lof-btn-row1"><span class="lof-svg lof-btn-house">' + ICONS.houseWide + '</span>' +
        '<span>Start Searching Homes</span></span>' +
      '<small class="lof-btn-row2"><span class="lof-svg">' + ICONS.lock2 + '</span>' +
        'Advanced Search Access Unlocked</small>';

    const overlay = document.createElement('div');
    overlay.className = 'lof-overlay';
    overlay.id = 'lof-success-modal';
    overlay.innerHTML = `
      <div class="lof-backdrop"></div>
      <div class="lof-card lof-success-card">

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
        <div class="lof-cta-wrap">
          <button id="lof-search" class="lof-btn-primary lof-btn-hero lof-btn-fit">
            <span class="lof-btn-stack">${searchBtnHTML}</span>
          </button>
        </div>

        <!-- Off-market section -->
        <div class="lof-offmkt">
          <div class="lof-offmkt-content">
            <div class="lof-offmkt-head">
              <span class="lof-svg lof-offmkt-ic">${ICONS.houseLock}</span>
              <h3>Want Access to Homes<br>That <span class="lof-stk">Never</span> Hit Zillow?</h3>
            </div>
            <p>Our local team can help uncover opportunities you won't find on the big real estate portals.</p>
            <div class="lof-offmkt-grid">
              <div>${ICONS.checkSmOutline}<span>Off-market homes</span></div>
              <div>${ICONS.checkSmOutline}<span>Private seller opportunities</span></div>
              <div>${ICONS.checkSmOutline}<span>Pre-market opportunities</span></div>
              <div>${ICONS.checkSmOutline}<span>Coming soon listings</span></div>
              <div>${ICONS.checkSmOutline}<span>Estate sales</span></div>
              <div>${ICONS.checkSmOutline}<span>Investment opportunities</span></div>
            </div>
            <button id="lof-offmkt-btn" class="lof-btn-orange">
              <span class="lof-btn-stack">
                <span class="lof-orange-row1">
                  <span class="lof-svg lof-btn-people">${ICONS.people}</span>
                  <span>Find Off-Market Homes</span>
                </span>
                <small class="lof-orange-row2">Let our local experts find opportunities for you</small>
              </span>
            </button>
          </div>
          <div class="lof-offmkt-img" style="background-image:url('${HOUSE_PHOTO}')"></div>
        </div>

        <!-- Local. Proactive. Connected. -->
        <div class="lof-lpc">
          <div class="lof-lpc-col lof-lpc-intro">
            <span class="lof-lpc-shield">${ICONS.shieldCheckOutline}</span>
            <div>
              <h4>Local. Proactive. Connected.</h4>
              <p>We work behind the scenes to<br>find opportunities others don't<br>even know about.</p>
            </div>
          </div>
          <div class="lof-lpc-col lof-lpc-feat">
            <span class="lof-lpc-ic">${ICONS.people}</span>
            <span class="lof-lpc-line">Local Experts</span>
            <span class="lof-lpc-line">Who Know</span>
            <span class="lof-lpc-line">the Market</span>
          </div>
          <div class="lof-lpc-col lof-lpc-feat">
            <span class="lof-lpc-ic">${ICONS.handshake}</span>
            <span class="lof-lpc-line">Strong Agent</span>
            <span class="lof-lpc-line">Relationships</span>
          </div>
          <div class="lof-lpc-col lof-lpc-feat">
            <span class="lof-lpc-ic">${ICONS.house}</span>
            <span class="lof-lpc-line">Access You</span>
            <span class="lof-lpc-line">Won't Find Online</span>
          </div>
        </div>

        <p class="lof-footnote"><span class="lof-svg lof-footnote-ic">${ICONS.lock2}</span>Your information is secure and will never be shared.</p>
      </div>
    `;
    document.body.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';

    overlay.querySelector('#lof-search').onclick = function () {
      closeOverlay(overlay);
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
        btn.addEventListener('click', function () {
          const wrap = btn.closest('.submit');
          if (wrap && wrap.classList.contains('disabled')) return;
          // Let Lofty's submit fire naturally so the lead is created immediately.
          // Open our phone modal after a short delay for the OTP step.
          setTimeout(function () {
            if (document.getElementById('lof-phone-modal')) return;
            closeLoftyRegister();
            buildPhoneModal();
          }, 400);
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
    /* ===== Lofty register popup enhancements (DISABLED — uncomment to re-enable) =====

    .pop-sign-log.register .lof-form-enrich,
    .pop-sign-log.register .lof-submit-note {
      font-family: inherit;
      color: #37465a;
    }

    .pop-sign-log.register hgroup h2,
    .pop-sign-log.register hgroup h2 p {
      font-size: 25px !important;
      line-height: 1.2 !important;
      color: #3e5da4 !important;
      font-family: var(--font-bold, inherit) !important;
      font-weight: 800 !important;
      margin: 0 0 10px !important;
      letter-spacing: -0.3px;
      text-align: center;
    }

    .pop-sign-log.register hgroup h3,
    .pop-sign-log.register hgroup h3 p {
      font-size: 13.5px !important;
      line-height: 1.55 !important;
      color: #37465a !important;
      font-family: var(--font-normal, inherit) !important;
      font-weight: 400 !important;
      margin: 0 0 6px !important;
    }

    .pop-sign-log.register .lof-form-enrich { margin: 6px 0 14px; }
    .pop-sign-log.register .lof-form-enrich h4 {
      color: #3e5da4; font-size: 14.5px; font-weight: 700;
      margin: 14px 0 6px;
      font-family: var(--font-bold, inherit);
    }
    .pop-sign-log.register .lof-form-enrich ul {
      list-style: disc; padding-left: 22px; margin: 0;
      font-size: 13.5px; color: #37465a;
    }
    .pop-sign-log.register .lof-form-enrich li {
      padding: 2px 0; line-height: 1.5;
    }
    .pop-sign-log.register .lof-search-by ul {
      columns: 2; column-gap: 24px;
    }
    .pop-sign-log.register .lof-search-by ul li {
      break-inside: avoid;
    }
    .pop-sign-log.register .lof-serving,
    .pop-sign-log.register .lof-privacy-note {
      margin: 12px 0 0; font-size: 13.5px; color: #37465a; line-height: 1.5;
    }
    .pop-sign-log.register .lof-serving b,
    .pop-sign-log.register .lof-privacy-note b {
      color: #3e5da4; font-weight: 700;
    }
    .pop-sign-log.register .lof-form-rule {
      border: 0; border-top: 1px solid #e5e8ee; margin: 16px 0 12px;
    }

    .pop-sign-log.register .v-input { margin-bottom: 8px; }
    .pop-sign-log.register .v-input .input-container {
      display: flex; flex-direction: column; gap: 3px;
    }
    .pop-sign-log.register .v-input .prompt {
      position: static !important;
      transform: none !important;
      font-size: 12.5px; font-weight: 700;
      color: #37465a;
      order: -1; padding: 0; background: transparent !important;
      font-family: var(--font-bold, inherit);
    }
    .pop-sign-log.register .v-input input {
      border: 1px solid #d8dfeb !important;
      border-radius: 6px;
      padding: 8px 10px !important;
      font-size: 13.5px;
      height: auto !important;
      min-height: 0 !important;
      font-family: var(--font-normal, inherit);
      color: #37465a;
    }
    .pop-sign-log.register .v-input input::placeholder {
      color: #a5adbf;
    }
    .pop-sign-log.register .v-input input:focus {
      border-color: #3e5da4 !important;
      box-shadow: 0 0 0 3px rgba(62, 93, 164, 0.12);
      outline: none;
    }

    .pop-sign-log.register .submit {
      background: #14213d !important;
      border-radius: 8px !important;
      overflow: hidden;
      margin-top: 10px;
    }
    .pop-sign-log.register .submit.disabled {
      background: #c8d0e0 !important;
    }
    .pop-sign-log.register .submit input[type="submit"] {
      background: transparent !important;
      color: #fff !important;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 700;
      font-size: 13.5px;
      padding: 14px !important;
      font-family: var(--font-bold, inherit);
    }

    .pop-sign-log.register .lof-submit-note {
      text-align: center; font-size: 12px; color: #8b93a7;
      margin: 12px 6px 0; line-height: 1.55;
    }

    @media (max-width: 480px) {
      .pop-sign-log.register .lof-search-by ul { columns: 1; }
      .pop-sign-log.register hgroup h2,
      .pop-sign-log.register hgroup h2 p {
        font-size: 20px !important;
      }
    }

    ===== end disabled block ===== */

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
    .lof-h2 { font-size: 28px; line-height: 1.2; font-weight: 700; margin: 0 0 10px; color: #0f1b3d; letter-spacing: -0.3px; }
    .lof-h3 { font-size: 20px; line-height: 1.3; font-weight: 700; margin: 0 0 6px; color: #0f1b3d; }
    .lof-sub { font-size: 15.5px; color: #4d586e; line-height: 1.55; margin: 0 0 16px; }
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
    .lof-phone-card {
      width: 92%; max-width: 780px; padding: 0;
      overflow-x: hidden; overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .lof-phone-grid { display: grid; grid-template-columns: 1fr 1fr; }
    .lof-phone-left { padding: 36px 28px 24px; background: #fff; }
    .lof-phone-right {
      padding: 36px 28px 24px;
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
      width: 42px; height: 42px; flex-shrink: 0;
      border-radius: 50%; background: #e8eefc;
      display: flex; align-items: center; justify-content: center;
      color: #2b5fdb;
    }
    .lof-bicon svg { width: 24px; height: 24px; }
    .lof-benefits h4 { margin: 2px 0 4px; font-size: 15px; font-weight: 700; color: #0f1b3d; }
    .lof-benefits p { margin: 0; font-size: 13px; color: #5a6478; line-height: 1.5; }
    .lof-phone-illu {
      width: 150px; height: 130px; margin: 0 auto 10px;
      display: flex; align-items: center; justify-content: center;
    }
    .lof-phone-illu svg { width: 100%; height: 100%; }
    .lof-phone-right .lof-h3,
    .lof-phone-right .lof-sub-sm { text-align: center; }
    .lof-tel-row {
      display: flex; gap: 0; align-items: stretch;
      border: 1px solid #d0d6e2; border-radius: 10px;
      background: #fff; overflow: visible; position: relative;
    }
    .lof-tel-row:focus-within {
      border-color: #2b5fdb;
      box-shadow: 0 0 0 3px rgba(43, 95, 219, 0.15);
    }

    /* Country dropdown */
    .lof-country { position: relative; }
    .lof-country-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 0 10px 0 12px; height: 100%;
      background: transparent; border: 0; cursor: pointer;
      border-right: 1px solid #eef2f9;
    }
    .lof-flag-current {
      display: inline-flex; align-items: center;
    }
    .lof-flag-current svg {
      width: 26px; height: 18px;
      border-radius: 2px;
      box-shadow: 0 0 0 1px rgba(0,0,0,.08);
    }
    .lof-caret {
      width: 10px; height: 6px; color: #5a6478;
      display: inline-flex; align-items: center;
    }
    .lof-caret svg { width: 100%; height: 100%; }
    .lof-country-menu {
      position: absolute; top: calc(100% + 6px); left: -1px;
      list-style: none; margin: 0; padding: 6px;
      background: #fff; border: 1px solid #d8dfeb;
      border-radius: 10px; box-shadow: 0 8px 24px rgba(15,23,42,.12);
      min-width: 200px; z-index: 5;
    }
    .lof-country-menu[hidden] { display: none; }
    .lof-country-menu li {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 10px; border-radius: 6px;
      font-size: 13.5px; color: #1f2a44; cursor: pointer;
    }
    .lof-country-menu li:hover { background: #f5f7fb; }
    .lof-flag-mini {
      display: inline-flex; flex-shrink: 0;
    }
    .lof-flag-mini svg {
      width: 22px; height: 15px; border-radius: 2px;
      box-shadow: 0 0 0 1px rgba(0,0,0,.08);
    }
    .lof-country-name { flex: 1; }
    .lof-dial { color: #8b93a7; font-size: 12.5px; }
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
      border-radius: 10px; padding: 16px 18px;
    }
    .lof-privacy-head {
      display: flex; align-items: center; gap: 12px; margin-bottom: 8px;
    }
    .lof-shield { width: 34px; height: 34px; flex-shrink: 0; }
    .lof-shield svg { width: 100%; height: 100%; }
    .lof-privacy-head strong { font-size: 15px; color: #b45309; font-weight: 700; }
    /* Bullets use inline check icons; ul starts where "Your Privacy Matters" begins */
    .lof-privacy-box .lof-priv-list {
      list-style: none;
      margin: 6px 0 0 46px;
      padding: 0;
      font-size: 12.5px; color: #7c5418;
    }
    .lof-privacy-box .lof-priv-list li {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 3px 0; line-height: 1.45;
    }
    .lof-priv-check {
      display: inline-flex; flex-shrink: 0; margin-top: 1px;
    }
    .lof-priv-check svg { width: 14px; height: 14px; display: block; }

    .lof-bottom-bar {
      grid-column: 1 / -1;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 16px 24px;
      background: #e8eefc;
      color: #3e5da4;
      flex-wrap: wrap;
    }
    .lof-bar-left { display: flex; align-items: center; gap: 12px; flex: 1 1 auto; min-width: 0; }
    .lof-bar-chat { width: 34px; height: 34px; flex-shrink: 0; }
    .lof-bar-chat svg { width: 100%; height: 100%; }
    .lof-bar-text { font-size: 16px; color: #3e5da4; line-height: 1.35; }
    .lof-bar-text strong { font-weight: 700; }
    .lof-bar-phone {
      display: inline-flex; align-items: center; gap: 8px;
      background: #fff; color: #3e5da4; text-decoration: none;
      padding: 10px 16px; border: 2px solid #3e5da4;
      border-radius: 8px; font-weight: 700; font-size: 14px;
      transition: background .15s;
    }
    .lof-bar-phone .lof-svg { width: 16px; height: 16px; color: #3e5da4; }
    .lof-bar-phone:hover { background: #f0f3fb; }

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
    .lof-otp-hero { display: flex; justify-content: center; margin: 4px 0 18px; position: relative; }
    .lof-shield-house { width: 88px; height: 88px; display: inline-flex; align-items: center; justify-content: center; color: #3e5da4; }
    .lof-shield-house svg { width: 100%; height: 100%; }

    /* Side decoration: small ringed circles with a fading line just outside. */
    .lof-otp-hero:before, .lof-otp-hero:after {
      content: ''; position: absolute; top: 50%; width: 7px; height: 7px;
      border-radius: 50%; border: 2.4px solid #3e5da4; background: #fff;
      transform: translateY(-50%);
    }
    .lof-otp-hero:before { left: calc(50% - 58px); }
    .lof-otp-hero:after  { right: calc(50% - 58px); }

    .lof-otp-hero .lof-fadeline-l,
    .lof-otp-hero .lof-fadeline-r {
      position: absolute; top: 50%; height: 1.4px; width: 28px;
      transform: translateY(-50%); pointer-events: none;
      border-radius: 1px;
    }
    /* Left line: right edge sits 2px to the left of the left dot's left edge.
       Left dot left edge at 50% - 58px → line right edge at 50% - 60px. */
    .lof-otp-hero .lof-fadeline-l {
      right: calc(50% + 60px);
      background: linear-gradient(to left, #a8b8de 0%, rgba(168,184,222,0) 100%);
    }
    /* Right line: mirror — left edge at 50% + 60px. */
    .lof-otp-hero .lof-fadeline-r {
      left: calc(50% + 60px);
      background: linear-gradient(to right, #a8b8de 0%, rgba(168,184,222,0) 100%);
    }
    .lof-otp-title {
      font-size: 24px; font-weight: 500; color: #0f1b3d;
      margin: 0 0 12px; line-height: 1.15; letter-spacing: -0.3px;
    }
    .lof-otp-title-em {
      display: inline-block; position: relative;
      font-size: 34px; font-weight: 700; color: #0f1b3d;
      margin-top: 4px; letter-spacing: -0.5px;
    }
    /* Tapered blue brush stroke under "cation" — thick at the "c" end, thinner
       toward the "o" end. Drawn as a filled shape so the thickness can taper. */
    .lof-otp-title-em::after {
      content: '';
      position: absolute; left: 30%; bottom: -6px;
      width: 29%; height: 12px;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 15' preserveAspectRatio='none'><path d='M3 2 Q50 11 97 3 A1 1 0 0 1 97 5 Q50 13 3 6 A2 2 0 0 0 3 2 Z' fill='%233e5da4'/></svg>");
      background-repeat: no-repeat;
      background-position: center;
      background-size: 100% 100%;
      pointer-events: none;
    }
    .lof-otp-sub {
      font-size: 13.5px; color: #5a6478; margin: 0 0 12px;
    }
    .lof-phone-pill {
      display: inline-flex; align-items: center; gap: 10px;
      background: #fff; border: 1px solid #d8dfeb;
      border-radius: 999px; padding: 6px 20px 6px 6px;
      font-size: 17px; font-weight: 700; color: #0f1b3d;
      letter-spacing: 0.2px;
      line-height: 1;
    }
    .lof-phone-pill > #lof-phone-display {
      display: inline-flex; align-items: center; height: 32px;
      line-height: 1;
    }
    .lof-pill-ic-wrap {
      width: 32px; height: 32px; border-radius: 50%;
      background: #e8eefc;
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .lof-pill-ic { width: 17px; height: 17px; color: #3e5da4; }
    .lof-wrong {
      font-size: 12.5px; color: #5a6478; margin: 8px 0 14px;
    }
    .lof-wrong a {
      color: #2b5fdb; text-decoration: underline; font-weight: 600; cursor: pointer;
    }
    .lof-info-box {
      display: flex; flex-direction: row; align-items: center; gap: 12px;
      background: #f3f6fd;
      border: 1.5px solid #ccd6ea;
      border-radius: 10px;
      padding: 12px 14px; margin: 0 0 18px;
      text-align: left;
    }
    .lof-info-ic-wrap {
      width: 40px; height: 40px; border-radius: 50%;
      background: #e8eefc;
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .lof-info-ic { width: 26px; height: 26px; color: #3e5da4; }
    .lof-info-box p {
      margin: 0; font-size: 12.5px; color: #3d4763; line-height: 1.5;
    }
    .lof-info-box b { color: #3e5da4; font-weight: 700; }

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
      font-size: 12.5px; color: #3e5da4;
      margin: 0 0 16px; font-weight: 500;
    }
    .lof-ttl .lof-svg { width: 14px; height: 14px; }
    .lof-ttl b { color: #3e5da4; font-weight: 700; }
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
    .lof-link-center { display: flex; margin: 6px auto 0; }

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
    .lof-check { width: 140px; height: 80px; margin: 0 auto 14px; display: flex; align-items: center; justify-content: center; }
    .lof-check svg { width: 100%; height: 100%; }
    .lof-success-card .lof-h2 {
      font-size: 36px; line-height: 1.15; letter-spacing: -0.5px;
    }
    .lof-succ-sub {
      color: #0f1b3d; font-size: 16px; font-weight: 700;
      margin: 6px 0 12px; letter-spacing: .2px;
    }
    .lof-succ-hero .lof-sub {
      max-width: 360px; margin: 0 auto; line-height: 1.5;
    }

    .lof-feat-row {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 0;
      margin: 0 0 22px;
    }
    .lof-feat { text-align: center; padding: 4px 12px; position: relative; }
    .lof-feat + .lof-feat::before {
      content: ''; position: absolute; left: 0;
      top: 10%; bottom: 10%; width: 1px;
      background: #e3e9f4;
    }
    .lof-feat-ic {
      width: 44px; height: 44px; margin: 0 auto 10px; border-radius: 50%;
      background: #e8eefc; color: #2b5fdb;
      display: flex; align-items: center; justify-content: center;
    }
    .lof-feat-ic svg { width: 22px; height: 22px; }
    .lof-feat h4 { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: #0f1b3d; }
    .lof-feat p { margin: 0; font-size: 11.5px; color: #5a6478; line-height: 1.45; }

    .lof-btn-hero {
      padding: 14px 24px; font-size: 16px; gap: 12px;
      box-shadow: 0 6px 18px rgba(43, 95, 219, 0.30);
    }
    .lof-btn-hero .lof-svg { width: 20px; height: 20px; }
    .lof-btn-stack { display: flex; flex-direction: column; align-items: center; line-height: 1.2; }
    .lof-btn-stack small { font-size: 11px; font-weight: 500; opacity: .85; margin-top: 2px; }

    /* Primary CTA — wider fixed width, centered */
    .lof-cta-wrap { text-align: center; margin: 0 0 22px; }
    .lof-btn-fit {
      width: auto !important; display: inline-flex !important;
      padding-left: 90px !important; padding-right: 90px !important;
      min-width: 420px;
    }
    .lof-btn-fit .lof-btn-stack { gap: 4px; align-items: stretch; }
    .lof-btn-row1 {
      display: inline-flex; align-items: center; gap: 12px;
      font-size: 19px; font-weight: 700; line-height: 1.2;
      justify-content: center;
    }
    .lof-btn-row1 .lof-svg { width: 22px; height: 22px; flex-shrink: 0; }
    .lof-btn-row1 .lof-btn-house { width: 30px; height: 24px; transform: translateY(-2px); }
    .lof-btn-stack small.lof-btn-row2 {
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 13px; font-weight: 500; line-height: 1.2;
      opacity: .9; justify-content: center;
      margin-top: 0;
    }
    .lof-btn-stack small.lof-btn-row2 .lof-svg { width: 14px; height: 14px; flex-shrink: 0; }

    /* Off-market */
    .lof-offmkt {
      margin: 26px 0 8px;
      display: grid; grid-template-columns: 1.35fr 1fr; gap: 0;
      background: #fffefb;
      border: 1.5px solid #ffe6c8;
      border-radius: 20px; overflow: hidden;
      align-items: stretch;
    }
    .lof-offmkt-content {
      padding: 26px 28px;
      display: flex; flex-direction: column;
    }
    .lof-offmkt-head { display: flex; align-items: center; gap: 14px; margin-bottom: 10px; }
    .lof-offmkt-ic { width: 56px; height: 56px; color: #f97316; flex-shrink: 0; }
    .lof-offmkt-ic svg { width: 100%; height: 100%; }
    .lof-offmkt h3 {
      font-size: 23px; font-weight: 700; color: #0f1b3d;
      margin: 0; line-height: 1.22; letter-spacing: -0.3px;
    }
    /* "Never" with hand-drawn orange underline */
    .lof-stk {
      color: #f97316; font-weight: 800;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 10' preserveAspectRatio='none'><path d='M2 7 Q15 2 30 5 T58 6' stroke='%23f97316' stroke-width='2.4' fill='none' stroke-linecap='round'/></svg>");
      background-repeat: no-repeat;
      background-position: bottom center;
      background-size: 100% 7px;
      padding-bottom: 5px;
    }
    .lof-offmkt p {
      font-size: 13.5px; color: #1f2a44; line-height: 1.55;
      margin: 0 0 16px;
    }
    .lof-offmkt-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px 18px;
      margin: 0 0 20px;
    }
    .lof-offmkt-grid > div {
      display: flex; align-items: center; gap: 8px;
      font-size: 13px; color: #1f2a44; font-weight: 500;
      white-space: nowrap;
    }
    .lof-offmkt-grid svg { width: 16px; height: 16px; flex-shrink: 0; }

    /* CTA: orange gradient, white people icon, two-line label */
    .lof-btn-orange {
      width: 100%; padding: 16px 18px; border: 0; border-radius: 12px;
      background: linear-gradient(180deg, #fb923c 0%, #f57316 100%);
      color: #fff; font-size: 15px; font-weight: 700;
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 12px;
      transition: filter .2s;
      box-shadow: 0 4px 12px rgba(249, 115, 22, 0.22);
      margin-top: auto;
    }
    .lof-btn-orange:hover { filter: brightness(.96); }
    .lof-btn-orange .lof-svg { width: 20px; height: 20px; color: #fff; }
    .lof-btn-orange .lof-btn-stack { align-items: center; line-height: 1.25; }
    .lof-btn-orange .lof-orange-row1 {
      display: inline-flex; align-items: center; gap: 10px;
      font-size: 15px; font-weight: 700;
    }
    .lof-btn-orange .lof-orange-row1 .lof-btn-people { width: 22px; height: 22px; }
    .lof-btn-orange .lof-orange-row2 {
      font-size: 12px; font-weight: 500; opacity: .95; margin-top: 2px;
    }

    /* Image card on the right — softly rounded, breathing room around it */
    .lof-offmkt-img {
      margin: 18px 18px 18px 0;
      border-radius: 14px;
      min-height: 260px;
      background-size: cover; background-position: center; background-repeat: no-repeat;
    }

    /* Local. Proactive. Connected. — 4-column info bar, white bg, blue accents */
    .lof-lpc {
      background: #fff; border-radius: 12px; padding: 22px 0;
      margin: 0 0 16px;
      display: grid;
      grid-template-columns: 2.2fr 1fr 1fr 1fr;
      gap: 0;
      align-items: center;
    }
    .lof-lpc-col { padding: 0 22px; }
    .lof-lpc-col + .lof-lpc-col { border-left: 1px solid #e3e9f4; }

    .lof-lpc-intro {
      display: flex; align-items: flex-start; gap: 14px;
    }
    .lof-lpc-shield {
      width: 44px; height: 44px; flex-shrink: 0; color: #3e5da4;
      display: inline-flex; align-items: flex-start; justify-content: center;
      /* Apex sits at y=2 in the 40-unit viewBox (≈ 2.2px below container top).
         Push the container down so the apex lines up with the headline top. */
      margin-top: 2px;
    }
    .lof-lpc-shield svg { width: 100%; height: 100%; }
    .lof-lpc h4 {
      margin: 0 0 5px; font-size: 16px; font-weight: 700;
      color: #3e5da4; letter-spacing: -0.2px; line-height: 1.2;
    }
    .lof-lpc-intro p {
      margin: 0; font-size: 12.5px; color: #3e5da4;
      line-height: 1.5; font-weight: 400;
    }

    .lof-lpc-feat {
      display: flex; flex-direction: column; align-items: center;
      text-align: center;
      color: #3e5da4; font-size: 12.5px; font-weight: 500;
      line-height: 1.3;
    }
    .lof-lpc-ic {
      width: 34px; height: 34px;
      color: #3e5da4;
      margin-bottom: 10px;
      display: inline-flex; align-items: center; justify-content: center;
      background: none;
    }
    .lof-lpc-ic svg { width: 100%; height: 100%; }
    .lof-lpc-line { display: block; }

    .lof-footnote {
      display: inline-flex; align-items: center; gap: 6px;
      text-align: center; font-size: 11px; color: #8b93a7;
      margin: 12px 0 0;
    }
    .lof-success-card .lof-footnote {
      display: flex; justify-content: center;
    }
    .lof-footnote-ic { width: 12px; height: 12px; flex-shrink: 0; color: currentColor; }
    .lof-footnote-ic svg { width: 100%; height: 100%; }

    @media (max-width: 820px) {
      .lof-success-card { padding: 28px 22px 22px; }
      .lof-feat-row { grid-template-columns: repeat(2, 1fr); }
      .lof-feat + .lof-feat::before { display: none; }
      .lof-feat:nth-child(2)::before, .lof-feat:nth-child(4)::before {
        content: ''; position: absolute; left: 0;
        top: 10%; bottom: 10%; width: 1px;
        background: #e3e9f4; display: block;
      }
      .lof-offmkt { grid-template-columns: 1fr; }
      .lof-offmkt-img { min-height: 180px; order: 2; margin: 0 18px 18px; }
      .lof-offmkt-grid { grid-template-columns: 1fr; }
      .lof-offmkt-grid > div { white-space: normal; }
      .lof-lpc { grid-template-columns: 1fr; gap: 0; text-align: center; padding: 18px 0; }
      .lof-lpc-col + .lof-lpc-col { border-left: 0; border-top: 1px solid #e3e9f4; padding-top: 16px; margin-top: 4px; }
      .lof-lpc-intro { flex-direction: column; gap: 8px; }
      .lof-h2 { font-size: 22px; }
      .lof-success-card .lof-h2 { font-size: 26px; }
      .lof-check { width: 120px; height: 70px; }
      .lof-succ-hero .lof-sub { max-width: 300px; }
    }
  `;
  document.head.appendChild(style);

  // ==========================================================================
  //  Preview API
  // ==========================================================================
  //  Open any modal directly without going through the registration flow.
  //
  //  URL:        https://everyswflhome.com/?lof-preview=phone
  //              ?lof-preview=otp        — opens OTP modal w/ dummy number
  //              ?lof-preview=edit       — opens "change phone" submodal
  //              ?lof-preview=success    — opens success modal
  //
  //  Console:    window.__lofPreview.phone()
  //              window.__lofPreview.otp('12395550100')      // pass a phone
  //              window.__lofPreview.edit('2395550100')
  //              window.__lofPreview.success()
  //              window.__lofPreview.off()                   // exit preview mode
  //
  //  In preview mode the backend is stubbed — no SMS is sent, and any 6-digit
  //  code entered on the OTP modal is accepted.
  // ==========================================================================
  function enterPreview()  { previewMode = true;  document.documentElement.dataset.lofPreview = '1'; }
  function exitPreview()   { previewMode = false; delete document.documentElement.dataset.lofPreview; }
  function purgeOverlays() { document.querySelectorAll('.lof-overlay').forEach(function (o) { o.remove(); }); document.documentElement.style.overflow = ''; }

  window.__lofPreview = {
    phone: function () {
      enterPreview(); purgeOverlays();
      buildPhoneModal(document.createElement('button'));  // dummy submit btn
    },
    otp: function (phone) {
      enterPreview(); purgeOverlays();
      buildOTPModal(phone || '12395550100');
    },
    edit: function (localPhone) {
      enterPreview(); purgeOverlays();
      buildEditPhoneModal(
        localPhone || '2395550100',
        function (e164) { console.log('[lof-preview] submit', e164); },
        function ()     { console.log('[lof-preview] cancel'); }
      );
    },
    success: function () {
      enterPreview(); purgeOverlays();
      buildSuccessModal();
    },
    off: function () {
      exitPreview(); purgeOverlays();
    }
  };

  // Auto-open via ?lof-preview=<name>
  try {
    const which = new URLSearchParams(window.location.search).get('lof-preview');
    if (which && typeof window.__lofPreview[which] === 'function') {
      setTimeout(function () { window.__lofPreview[which](); }, 200);
    }
  } catch (e) { /* ignore */ }
})();
