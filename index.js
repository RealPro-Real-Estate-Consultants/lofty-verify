const express = require('express');
const path = require('path');
require('dotenv').config();

const client = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();
const port = process.env.PORT || 3000;

// Railway terminates TLS upstream, so req.ip is the proxy's address unless we
// trust the X-Forwarded-For header. The rate limiter below needs the real one.
app.set('trust proxy', true);

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

// ============================================================================
//  Twilio Lookup — Line Type Intelligence
// ============================================================================
// Twilio Verify only confirms "did this person type back the correct code".
// It has no visibility into WHAT KIND of line received that code, so non-fixed
// VOIP numbers — the category free burner / SMS-receiving services live in —
// complete the OTP flow exactly like a real mobile. Lookup's Line Type
// Intelligence tells us the line type BEFORE an OTP is ever sent.
//
// Requires Line Type Intelligence to be enabled on the Twilio account. It uses
// the same Account SID / Auth Token as Verify — no new credentials.
// Cost: ~$0.008 per uncached lookup.
//
// Per-type policy:
//   block — no OTP, nothing written to Lofty; the phone modal shows an error
//   flag  — OTP sends as normal, but the line type rides along to Lofty so the
//           record can be filtered or reviewed later
//   allow — untouched
//
// Defaults below are the agreed policy. Both lists are overridable from the
// Railway variables without a code change, e.g.
//   BLOCKED_LINE_TYPES=landline,tollFree
//   FLAGGED_LINE_TYPES=nonFixedVoip,fixedVoip
//
// Possible Twilio values: mobile, landline, fixedVoip, nonFixedVoip, personal,
// tollFree, premium, sharedCost, uan, voicemail, pager, unknown.

const parseTypeList = (raw, fallback) =>
  (raw || fallback).split(',').map(s => s.trim()).filter(Boolean);

const BLOCKED_LINE_TYPES = parseTypeList(process.env.BLOCKED_LINE_TYPES, 'landline');
const FLAGGED_LINE_TYPES = parseTypeList(process.env.FLAGGED_LINE_TYPES, 'nonFixedVoip');

// Shown to the lead in the phone modal when their number is blocked.
const BLOCK_MESSAGES = {
  landline: "That looks like a landline, which can't receive text messages. Please enter a mobile number.",
  tollFree: 'Please enter a personal mobile number that can receive text messages.',
  premium: 'Please enter a personal mobile number that can receive text messages.',
  sharedCost: 'Please enter a personal mobile number that can receive text messages.',
  uan: 'Please enter a personal mobile number that can receive text messages.',
  voicemail: "That number can't receive text messages. Please enter a mobile number.",
  pager: "That number can't receive text messages. Please enter a mobile number.",
  nonFixedVoip: 'Please enter a mobile number that can receive text messages.'
};
const DEFAULT_BLOCK_MESSAGE =
  'Please enter a mobile number that can receive text messages.';

function policyFor(lineType) {
  if (BLOCKED_LINE_TYPES.includes(lineType)) return 'block';
  if (FLAGGED_LINE_TYPES.includes(lineType)) return 'flag';
  return 'allow';
}

// Every lookup costs money, and one lead can legitimately hit /send-verification
// several times (initial send, Resend Code, "Wrong number? Edit"). /verify-otp
// and /update-lead-phone also want the line type for the Lofty payload. Cache
// by E.164 so a single lead is billed once.
const LOOKUP_CACHE_TTL_MS = 60 * 60 * 1000;   // 1 hour
const LOOKUP_CACHE_MAX = 5000;
const lookupCache = new Map();

function readCache(e164) {
  const hit = lookupCache.get(e164);
  if (!hit) return null;
  if (Date.now() - hit.at > LOOKUP_CACHE_TTL_MS) {
    lookupCache.delete(e164);
    return null;
  }
  return hit;
}

function writeCache(e164, entry) {
  // Map preserves insertion order, so the first key is the oldest.
  if (lookupCache.size >= LOOKUP_CACHE_MAX) {
    lookupCache.delete(lookupCache.keys().next().value);
  }
  lookupCache.set(e164, Object.assign({}, entry, { at: Date.now() }));
}

/**
 * Resolve the line type for an E.164 number (with leading +).
 *
 * FAILS OPEN. If Lookup errors, times out, is not enabled on the account, or
 * returns "unknown", the result is policy "allow" — turning away real leads
 * during a Twilio outage is far more costly than letting a VOIP number through.
 */
async function checkLineType(e164) {
  const cached = readCache(e164);
  if (cached) {
    return Object.assign({}, cached, { policy: policyFor(cached.type), source: 'cache' });
  }

  try {
    const result = await client.lookups.v2
      .phoneNumbers(e164)
      .fetch({ fields: 'line_type_intelligence' });

    // When Line Type Intelligence cannot resolve a number, Twilio returns the
    // field with an errorCode and a null type. That lands on 'unknown', which
    // policyFor() allows — fail open, same as a thrown error.
    const lti = result.lineTypeIntelligence || {};
    if (lti.errorCode) {
      console.warn('lookup ' + e164 + ' — line type intelligence errorCode: ' + lti.errorCode);
    }
    const entry = {
      type: lti.type || 'unknown',
      carrier: lti.carrierName || '',
      valid: result.valid !== false
    };
    writeCache(e164, entry);
    return Object.assign({}, entry, { policy: policyFor(entry.type), source: 'lookup' });
  } catch (e) {
    // Deliberately NOT cached: a transient failure should not pin "unknown" on
    // the number for the next hour.
    console.error('lookup error for ' + e164 + ' — failing open:', e.message);
    return { type: 'unknown', carrier: '', valid: true, policy: 'allow', source: 'error', error: e.message };
  }
}

// ---- Reporting ------------------------------------------------------------
// "unknown" has two very different causes that must not be conflated:
//   unresolved    Twilio answered, but could not determine this number's type.
//                 Rare and harmless.
//   lookup_failed The Lookup CALL failed — 403 (account not billable for the
//                 data package), network error, Twilio outage. Every number
//                 becomes "unknown" and the gate silently stops filtering.
// The second is the failure mode worth alerting on, so it gets its own value
// rather than hiding inside "unknown".
//
// Safe across the cache: failed lookups are never cached, so a cache hit always
// came from a successful call.
function lineTypeStatus(lookup) {
  if (lookup.source === 'error') return 'lookup_failed';
  if (!lookup.type || lookup.type === 'unknown') return 'unresolved';
  return 'resolved';
}

// Running tally since the last deploy, exposed at GET /lookup-stats. Counted in
// /send-verification only — that is the one place a gate decision is made, so
// the numbers stay a clean per-attempt denominator. Aggregates only: no phone
// numbers, no lead data.
const lookupStats = {
  since: new Date().toISOString(),
  sendAttempts: 0,
  allowed: 0,
  flagged: 0,
  blocked: 0,
  byLineType: {},
  byStatus: {},
  bySource: {},
  lastLookupFailure: null
};

const bump = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };

function recordLookup(lookup) {
  const status = lineTypeStatus(lookup);
  lookupStats.sendAttempts++;
  bump(lookupStats.byLineType, lookup.type || 'unknown');
  bump(lookupStats.byStatus, status);
  bump(lookupStats.bySource, lookup.source);
  if (lookup.policy === 'block') lookupStats.blocked++;
  else if (lookup.policy === 'flag') lookupStats.flagged++;
  else lookupStats.allowed++;
  if (status === 'lookup_failed') {
    lookupStats.lastLookupFailure = { at: new Date().toISOString(), error: lookup.error || '' };
  }
}

// ---- Rate limiting --------------------------------------------------------
// Each /send-verification now costs a Lookup plus an SMS, so the endpoint is
// worth throttling. Limits are deliberately generous: a genuine lead makes at
// most ~4 calls (send, a resend or two, one edit). A trip is logged loudly so
// the ceiling can be tuned if shared-IP traffic ever hits it.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 10);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MIN || 15) * 60 * 1000;
const rateBuckets = new Map();

function rateLimited(ip) {
  if (!ip || RATE_LIMIT_MAX <= 0) return false;
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  if (rateBuckets.size > 10000) {
    for (const entry of rateBuckets) {
      const times = entry[1];
      if (!times.length || now - times[times.length - 1] > RATE_LIMIT_WINDOW_MS) {
        rateBuckets.delete(entry[0]);
      }
    }
  }
  return hits.length > RATE_LIMIT_MAX;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Aggregate Lookup report since the last deploy. Counts only — no phone numbers,
// no lead data. Set STATS_TOKEN in Railway to require ?token=... on this route.
//
// Read `health` first: "ok" means real line types are coming back. Anything else
// means the gate is letting everything through and needs attention.
app.get('/lookup-stats', (req, res) => {
  if (process.env.STATS_TOKEN && req.query.token !== process.env.STATS_TOKEN) {
    return res.sendStatus(404);
  }
  const failed = lookupStats.byStatus.lookup_failed || 0;
  const resolved = lookupStats.byStatus.resolved || 0;
  const attempts = lookupStats.sendAttempts;

  let health = 'no_data';
  if (attempts > 0) {
    if (failed === attempts) health = 'broken — every lookup failed; the gate is filtering nothing';
    else if (failed > 0) health = 'degraded — some lookups are failing';
    else if (resolved === 0) health = 'inert — lookups succeed but no line type is returned; check that the account is billable for the data package';
    else health = 'ok';
  }

  res.status(200).send(Object.assign({ health: health }, lookupStats, {
    policy: { blocked: BLOCKED_LINE_TYPES, flagged: FLAGGED_LINE_TYPES },
    cachedNumbers: lookupCache.size
  }));
});

// Gate: Lookup runs BEFORE Verify. A blocked number gets no SMS, and the
// browser never calls /update-lead-phone for it, so nothing reaches Lofty.
//
// Always answers with a body carrying the decision:
//   200 { sent: true,  lineType, flagged }
//   200 { sent: false, reason: 'blocked_line_type', lineType, message }
//   429 { sent: false, reason: 'rate_limited', message }
//   500 { sent: false, reason: 'send_failed', error }
// An older cached otp.js ignores the body entirely and still behaves as it did
// before — a blocked number simply never receives a code, which is the same
// dead end it hits today.
app.post('/send-verification', async (req, res) => {
  const e164 = '+' + req.body.phoneNumber;

  if (rateLimited(req.ip)) {
    console.warn('send-verification RATE LIMITED — ip: ' + req.ip + ', phone: ' + e164);
    return res.status(429).send({
      sent: false,
      reason: 'rate_limited',
      message: 'Too many attempts. Please wait a few minutes and try again.'
    });
  }

  const lookup = await checkLineType(e164);
  recordLookup(lookup);
  console.log(
    'lookup ' + e164 + ' — type: ' + lookup.type +
    ', carrier: ' + (lookup.carrier || '(none)') +
    ', policy: ' + lookup.policy + ', source: ' + lookup.source +
    ', status: ' + lineTypeStatus(lookup)
  );

  if (lookup.policy === 'block') {
    console.log('send-verification BLOCKED ' + e164 + ' — line type: ' + lookup.type);
    return res.status(200).send({
      sent: false,
      reason: 'blocked_line_type',
      lineType: lookup.type,
      message: BLOCK_MESSAGES[lookup.type] || DEFAULT_BLOCK_MESSAGE
    });
  }

  try {
    const verification = await client.verify.v2
      .services(process.env.VERIFY_SERVICE_SID)
      .verifications.create({ to: e164, channel: 'sms' });
    console.log('Verification sent to ' + e164 + ': ' + verification.status + ' (line type: ' + lookup.type + ')');
    res.status(200).send({
      sent: true,
      lineType: lookup.type,
      flagged: lookup.policy === 'flag'
    });
  } catch (e) {
    console.error('send-verification error:', e);
    res.status(500).send({
      sent: false,
      reason: 'send_failed',
      error: 'Unable to send verification code. Please try again.'
    });
  }
});

app.post('/update-lead-phone', async (req, res) => {
  const e164 = '+' + req.body.phoneNumber;
  console.log('update-lead-phone received — leadId: ' + (req.body.leadId || '(none)') + ', email: ' + (req.body.email || '(none)') + ', phone: ' + e164);
  if (!process.env.ZAPIER_UPDATE_PHONE_URL || process.env.ZAPIER_UPDATE_PHONE_URL.includes('REPLACE_ME')) {
    console.warn('update-lead-phone SKIPPED — ZAPIER_UPDATE_PHONE_URL is not set in Railway variables');
    return res.sendStatus(200);
  }
  // Normally a cache hit from the /send-verification that just ran — free.
  const lookup = await checkLineType(e164);
  try {
    await fetch(process.env.ZAPIER_UPDATE_PHONE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leadId: req.body.leadId,
        email: req.body.email,
        phoneNumber: req.body.phoneNumber,
        lineType: lookup.type,
        carrier: lookup.carrier,
        lineTypeFlagged: lookup.policy === 'flag' ? 'Yes' : 'No',
        lineTypeStatus: lineTypeStatus(lookup)
      })
    });
    console.log('Phone update triggered — leadId: ' + (req.body.leadId || '(none)') + ', email: ' + req.body.email + ', phone: ' + e164 + ', line type: ' + lookup.type);
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
        to: '+' + req.body.phoneNumber,
        code: req.body.otp
      });

    if (check.status === 'approved' && process.env.ZAPIER_CATCH_HOOK_URL && !process.env.ZAPIER_CATCH_HOOK_URL.includes('REPLACE_ME')) {
      // Cache hit from the earlier /send-verification in the normal flow.
      const lookup = await checkLineType('+' + req.body.phoneNumber);
      try {
        await fetch(process.env.ZAPIER_CATCH_HOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phoneNumber: req.body.phoneNumber,
            leadId: req.body.leadId,
            email: req.body.email,
            status: 'approved',
            verifiedAt: new Date().toISOString(),
            lineType: lookup.type,
            carrier: lookup.carrier,
            lineTypeFlagged: lookup.policy === 'flag' ? 'Yes' : 'No',
            lineTypeStatus: lineTypeStatus(lookup)
          })
        });
        console.log('Zapier notified for +' + req.body.phoneNumber + ' (line type: ' + lookup.type + ')');
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
  console.log('Server started at http://localhost:' + port);
  console.log('Lookup policy — block: [' + BLOCKED_LINE_TYPES.join(', ') + '] flag: [' + FLAGGED_LINE_TYPES.join(', ') + ']');
});
