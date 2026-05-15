const phoneForm = document.getElementById('phone-form');
const verifyForm = document.getElementById('verify-form');
const responseText = document.getElementById('response-text');
const maskedNumber = document.getElementById('masked-number');
const resendBtn = document.getElementById('resend-btn');
const loadingState = document.getElementById('loading-state');
let phoneNumber;

function maskPhone(num) {
  if (!num || num.length < 4) return num;
  return '•••• ' + num.slice(-4);
}

function showMessage(msg, type) {
  responseText.innerHTML = msg;
  responseText.className = type || '';
  responseText.style.display = 'block';
}

function normalizeUSPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return digits;
  return digits;
}

async function sendCode() {
  const response = await fetch('/send-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber })
  });
  return response.ok;
}

function showPhoneForm() {
  loadingState.style.display = 'none';
  verifyForm.style.display = 'none';
  phoneForm.style.display = 'block';
}

function showVerifyForm() {
  loadingState.style.display = 'none';
  phoneForm.style.display = 'none';
  responseText.style.display = 'none';
  maskedNumber.textContent = maskPhone(phoneNumber);
  verifyForm.style.display = 'block';
}

async function autoSendFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const rawPhone = params.get('phone');
  if (!rawPhone) return false;

  const normalized = normalizeUSPhone(rawPhone);
  if (normalized.length !== 11) return false;

  phoneNumber = normalized;
  loadingState.style.display = 'block';
  phoneForm.style.display = 'none';

  const ok = await sendCode();
  if (ok) {
    showVerifyForm();
    return true;
  }

  showPhoneForm();
  document.getElementById('phone-number-input').value = phoneNumber;
  showMessage('Could not send code automatically. Please confirm your number and try again.', 'error');
  return false;
}

phoneForm.addEventListener('submit', async e => {
  e.preventDefault();
  const submitBtn = phoneForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending...';

  phoneNumber = normalizeUSPhone(document.getElementById('phone-number-input').value);

  const ok = await sendCode();
  submitBtn.disabled = false;
  submitBtn.textContent = 'Send Code';

  if (ok) {
    showVerifyForm();
  } else {
    showMessage('Could not send code. Please check your number and try again.', 'error');
  }
});

verifyForm.addEventListener('submit', async e => {
  e.preventDefault();
  const submitBtn = verifyForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Verifying...';

  const otp = document.getElementById('otp-input').value;
  const response = await fetch('/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ phoneNumber, otp })
  });
  const check = await response.json().catch(() => ({}));

  submitBtn.disabled = false;
  submitBtn.textContent = 'Verify';

  if (response.ok && check.status === 'approved') {
    verifyForm.style.display = 'none';
    showMessage('✅ Phone verified! Redirecting to everyswflhome.com...', 'success');
    setTimeout(() => {
      window.location.href = 'https://everyswflhome.com/';
    }, 2500);
  } else if (response.ok && check.status === 'pending') {
    showMessage('❌ Incorrect code. Please try again.', 'error');
  } else if (response.ok && check.status === 'canceled') {
    showMessage('⏱ Code expired. Please request a new one.', 'error');
  } else {
    showMessage('Something went wrong. Please try again.', 'error');
  }
});

resendBtn.addEventListener('click', async () => {
  resendBtn.disabled = true;
  resendBtn.textContent = 'Sending...';
  const ok = await sendCode();
  resendBtn.disabled = false;
  resendBtn.textContent = 'Resend code';
  showMessage(
    ok ? 'New code sent.' : 'Could not resend code. Please try again.',
    ok ? 'success' : 'error'
  );
});

autoSendFromUrl().then(handled => {
  if (!handled) showPhoneForm();
});
