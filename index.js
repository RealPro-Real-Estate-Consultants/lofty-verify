const express = require('express');
const path = require('path');
require('dotenv').config();

const client = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(__dirname + '/public'));
app.use('/otp.js', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
  const allowed = ['https://everyswflhome.com', 'https://www.everyswflhome.com'];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.post('/send-verification', async (req, res) => {
  try {
    const verification = await client.verify.v2
      .services(process.env.VERIFY_SERVICE_SID)
      .verifications.create({
        to: `+${req.body.phoneNumber}`,
        channel: 'sms'
      });
    console.log(`Verification sent to +${req.body.phoneNumber}: ${verification.status}`);
    res.sendStatus(200);
  } catch (e) {
    console.error('send-verification error:', e);
    res.status(500).send({ error: 'Unable to send verification code. Please try again.' });
  }
});

app.post('/update-lead-phone', async (req, res) => {
  if (!process.env.ZAPIER_UPDATE_PHONE_URL || process.env.ZAPIER_UPDATE_PHONE_URL.includes('REPLACE_ME')) {
    return res.sendStatus(200); // silently skip if not configured
  }
  try {
    await fetch(process.env.ZAPIER_UPDATE_PHONE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leadId: req.body.leadId,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber
      })
    });
    console.log(`Phone update triggered — leadId: ${req.body.leadId || '(none)'}, email: ${req.body.email}, phone: +${req.body.phoneNumber}`);
    res.sendStatus(200);
  } catch (e) {
    console.error('update-lead-phone error:', e.message);
    res.sendStatus(500);
  }
});

app.post('/verify-otp', async (req, res) => {
  try {
    const check = await client.verify.v2
      .services(process.env.VERIFY_SERVICE_SID)
      .verificationChecks.create({
        to: `+${req.body.phoneNumber}`,
        code: req.body.otp
      });

    if (check.status === 'approved' && process.env.ZAPIER_CATCH_HOOK_URL && !process.env.ZAPIER_CATCH_HOOK_URL.includes('REPLACE_ME')) {
      try {
        await fetch(process.env.ZAPIER_CATCH_HOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phoneNumber: req.body.phoneNumber,
            status: 'approved',
            verifiedAt: new Date().toISOString()
          })
        });
        console.log(`Zapier notified for +${req.body.phoneNumber}`);
      } catch (hookErr) {
        console.error('Zapier catch-hook error:', hookErr.message);
      }
    }

    res.status(200).send(check);
  } catch (e) {
    console.error('verify-otp error:', e);
    res.status(500).send({ error: 'Unable to verify code. Please try again.' });
  }
});

app.listen(port, () => {
  console.log(`Server started at http://localhost:${port}`);
});
