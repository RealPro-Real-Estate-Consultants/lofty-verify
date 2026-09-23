/**
 * End-to-end test of the Lookup gate in index.js, with a stubbed Twilio client.
 * Covers block / flag / allow, fail-open, caching and rate limiting.
 * No network calls, no cost.
 *
 *   node test-lookup.js
 */
const Module = require('module');
const assert = require('assert');

// ---- Stub twilio ----------------------------------------------------------
let lookupCalls = [];
let smsSent = [];
let lookupResponses = {};   // e164 -> { type } | Error

const stub = () => ({
  lookups: {
    v2: {
      phoneNumbers: (n) => ({
        fetch: async () => {
          lookupCalls.push(n);
          const r = lookupResponses[n];
          if (r instanceof Error) throw r;
          return { valid: true, lineTypeIntelligence: r };
        }
      })
    }
  },
  verify: {
    v2: {
      services: () => ({
        verifications: {
          create: async ({ to }) => { smsSent.push(to); return { status: 'pending' }; }
        },
        verificationChecks: { create: async () => ({ status: 'approved' }) }
      })
    }
  }
});

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'twilio') return stub;
  return origLoad.apply(this, arguments);
};

const PORT = 45871;
process.env.PORT = String(PORT);
process.env.VERIFY_SERVICE_SID = 'VAtest';
process.env.RATE_LIMIT_MAX = '10';
delete process.env.BLOCKED_LINE_TYPES;
delete process.env.FLAGGED_LINE_TYPES;

require('./index.js');

const send = (phoneNumber) =>
  fetch(`http://127.0.0.1:${PORT}/send-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber })
  }).then(async r => ({ status: r.status, body: await r.json() }));

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' -> ' + e.message]); }
}

(async () => {
  await new Promise(r => setTimeout(r, 300));

  lookupResponses = {
    '+15551230001': { type: 'mobile', carrierName: 'Verizon' },
    '+15551230002': { type: 'landline', carrierName: 'CenturyLink' },
    '+15551230003': { type: 'nonFixedVoip', carrierName: 'TextNow' },
    '+15551230004': new Error('Lookup unavailable'),
    '+15551230005': { type: 'fixedVoip', carrierName: 'Comcast' },
    '+15551230006': { type: null, errorCode: 60600 }
  };

  // 1. mobile -> allowed, not flagged, SMS sent
  let r = await send('15551230001');
  check('mobile is allowed', () => {
    assert.strictEqual(r.body.sent, true);
    assert.strictEqual(r.body.flagged, false);
    assert.strictEqual(r.body.lineType, 'mobile');
    assert.ok(smsSent.includes('+15551230001'), 'SMS should be sent');
  });

  // 2. landline -> BLOCKED, no SMS
  smsSent = [];
  r = await send('15551230002');
  check('landline is blocked with no SMS', () => {
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.sent, false);
    assert.strictEqual(r.body.reason, 'blocked_line_type');
    assert.strictEqual(r.body.lineType, 'landline');
    assert.ok(/landline/i.test(r.body.message), 'message should explain why');
    assert.strictEqual(smsSent.length, 0, 'no SMS may be sent for a blocked number');
  });

  // 3. nonFixedVoip -> allowed but FLAGGED, SMS sent
  smsSent = [];
  r = await send('15551230003');
  check('nonFixedVoip is allowed but flagged', () => {
    assert.strictEqual(r.body.sent, true);
    assert.strictEqual(r.body.flagged, true);
    assert.strictEqual(r.body.lineType, 'nonFixedVoip');
    assert.deepStrictEqual(smsSent, ['+15551230003']);
  });

  // 4. Lookup throws -> FAIL OPEN, SMS still sent
  smsSent = [];
  r = await send('15551230004');
  check('lookup failure fails open', () => {
    assert.strictEqual(r.body.sent, true);
    assert.strictEqual(r.body.lineType, 'unknown');
    assert.deepStrictEqual(smsSent, ['+15551230004']);
  });

  // 5. fixedVoip -> allowed, not flagged
  r = await send('15551230005');
  check('fixedVoip is allowed and unflagged', () => {
    assert.strictEqual(r.body.sent, true);
    assert.strictEqual(r.body.flagged, false);
  });

  // 6. LTI errorCode with null type -> unknown -> allowed
  r = await send('15551230006');
  check('unresolvable line type fails open', () => {
    assert.strictEqual(r.body.sent, true);
    assert.strictEqual(r.body.lineType, 'unknown');
  });

  // 7. Cache: repeat of a previously looked-up number costs no new lookup
  lookupCalls = [];
  await send('15551230001');
  await send('15551230001');
  check('repeat lookups are served from cache', () => {
    assert.strictEqual(lookupCalls.length, 0, 'expected 0 billed lookups, got ' + lookupCalls.length);
  });

  // 8. A failed lookup is NOT cached (so it retries next time)
  lookupCalls = [];
  await send('15551230004');
  check('failed lookup is not cached', () => {
    assert.strictEqual(lookupCalls.length, 1, 'expected a retry, got ' + lookupCalls.length);
  });

  // 9. Rate limit trips after RATE_LIMIT_MAX in the window
  let limited = null;
  for (let i = 0; i < 12; i++) {
    const resp = await send('15551230001');
    if (resp.status === 429) { limited = resp; break; }
  }
  check('rate limit trips and blocks the send', () => {
    assert.ok(limited, 'expected a 429 within 12 requests');
    assert.strictEqual(limited.body.sent, false);
    assert.strictEqual(limited.body.reason, 'rate_limited');
  });

  console.log('\n===== RESULTS =====');
  results.forEach(([s, n]) => console.log(s + '  ' + n));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
