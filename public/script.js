const phoneForm = document.getElementById('phone-form');
const verifyForm = document.getElementById('verify-form');
const responseText = document.getElementById('response-text');
const maskedNumber = document.getElementById('masked-number');
const resendBtn = document.getElementById('resend-btn');
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

async function sendCode() {
  const response = await fetch('/send-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber })
  });
  return response.ok;
}

phoneForm.addEventListener('submit', async e => {
  e.preventDefault();
  const submitBtn = phoneForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending...';

  phoneNumber = document.getElementById('phone-number-input').value.replace(/\D/g, '');

  const ok = await sendCode();
  submitBtn.disabled = false;
  submitBtn.textContent = 'Send Code';

  if (ok) {
    maskedNumber.textContent = maskPhone(phoneNumber);
    phoneForm.style.display = 'none';
    verifyForm.style.display = 'block';
    responseText.style.display = 'none';
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
    showMessage('✅ Phone verified! You can close this window.', 'success');
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
