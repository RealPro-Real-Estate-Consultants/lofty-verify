/**
 * Tests /lookup-stats reporting and the lineTypeStatus field, with a stubbed
 * Twilio client. No network calls, no cost.
 *
 *   node test-lookup-stats.js
 */
const Module = require('module');
const assert = require('assert');

let lookupResponses = {};
let zapierPayloads = [];

const stub = () => ({
  lookups: {
    v2: {
      phoneNumbers: (n) => ({
        fetch: async () => {
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
        verifications: { create: async () => ({ status: 'pending' }) },
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

const PORT = 45872;
process.env.PORT = String(PORT);
process.env.VERIFY_SERVICE_SID = 'VAtest';
process.env.RATE_LIMIT_MAX = '0';            // disable for this run
process.env.ZAPIER_UPDATE_PHONE_URL = 'https://hooks.zapier.com/hooks/catch/TEST/';
process.env.ZAPIER_CATCH_HOOK_URL = 'https://hooks.zapier.com/hooks/catch/TEST2/';
delete process.env.STATS_TOKEN;

// Capture what would be sent to Zapier.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('hooks.zapier.com')) {
    zapierPayloads.push(JSON.parse(opts.body));
    return { ok: true };
  }
  return realFetch(url, opts);
};

require('./index.js');

const post = (path, body) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async r => {
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    return { status: r.status, body };
  });
const getStats = (qs = '') =>
  fetch(`http://127.0.0.1:${PORT}/lookup-stats${qs}`)
    .then(async r => ({ status: r.status, body: r.status === 200 ? await r.json() : null }));

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
    '+15551230004': new Error('HTTP 403 not authorized for this data package'),
    '+15551230006': { type: null, errorCode: 60600 }
  };

  await post('/send-verification', { phoneNumber: '15551230001' });  // mobile
  await post('/send-verification', { phoneNumber: '15551230002' });  // landline -> blocked
  await post('/send-verification', { phoneNumber: '15551230003' });  // voip -> flagged
  await post('/send-verification', { phoneNumber: '15551230006' });  // unresolved
  await post('/send-verification', { phoneNumber: '15551230004' });  // lookup failed

  let s = await getStats();
  check('stats tallies every send attempt', () => {
    assert.strictEqual(s.body.sendAttempts, 5);
    assert.strictEqual(s.body.blocked, 1);
    assert.strictEqual(s.body.flagged, 1);
    assert.strictEqual(s.body.allowed, 3);
  });

  check('unknown is split into unresolved vs lookup_failed', () => {
    assert.strictEqual(s.body.byLineType.unknown, 2, 'both land on unknown');
    assert.strictEqual(s.body.byStatus.unresolved, 1, 'Twilio could not resolve');
    assert.strictEqual(s.body.byStatus.lookup_failed, 1, 'the call itself failed');
    assert.strictEqual(s.body.byStatus.resolved, 3);
  });

  check('last lookup failure is surfaced', () => {
    assert.ok(s.body.lastLookupFailure, 'expected lastLookupFailure');
    assert.ok(/403/.test(s.body.lastLookupFailure.error));
  });

  check('health reads degraded when some lookups fail', () => {
    assert.ok(/degraded/.test(s.body.health), 'got: ' + s.body.health);
  });

  check('stats leak no phone numbers', () => {
    assert.ok(!JSON.stringify(s.body).includes('5551230001'));
  });

  // lineTypeStatus reaches Lofty on both Zaps
  zapierPayloads = [];
  await post('/update-lead-phone', { phoneNumber: '15551230004', email: 'a@b.com', leadId: '1' });
  check('update-lead-phone forwards lookup_failed to Lofty', () => {
    assert.strictEqual(zapierPayloads.length, 1);
    assert.strictEqual(zapierPayloads[0].lineTypeStatus, 'lookup_failed');
    assert.strictEqual(zapierPayloads[0].lineType, 'unknown');
  });

  zapierPayloads = [];
  await post('/verify-otp', { phoneNumber: '15551230006', otp: '123456', email: 'a@b.com' });
  check('verify-otp forwards unresolved to Lofty', () => {
    assert.strictEqual(zapierPayloads.length, 1);
    assert.strictEqual(zapierPayloads[0].lineTypeStatus, 'unresolved');
  });

  zapierPayloads = [];
  await post('/verify-otp', { phoneNumber: '15551230003', otp: '123456', email: 'a@b.com' });
  check('a real type still reports resolved + flagged', () => {
    assert.strictEqual(zapierPayloads[0].lineTypeStatus, 'resolved');
    assert.strictEqual(zapierPayloads[0].lineTypeFlagged, 'Yes');
  });

  // STATS_TOKEN is read per-request, so it can be toggled live.
  const openAccess = await getStats();
  check('stats are open when STATS_TOKEN is unset', () => {
    assert.strictEqual(openAccess.status, 200);
  });

  process.env.STATS_TOKEN = 'sekrit';
  const noToken = await getStats();
  const badToken = await getStats('?token=wrong');
  const goodToken = await getStats('?token=sekrit');
  delete process.env.STATS_TOKEN;

  check('STATS_TOKEN gates the endpoint', () => {
    assert.strictEqual(noToken.status, 404, 'missing token should 404');
    assert.strictEqual(badToken.status, 404, 'wrong token should 404');
    assert.strictEqual(goodToken.status, 200, 'correct token should pass');
  });

  const reopened = await getStats();
  check('gate lifts again once STATS_TOKEN is cleared', () => {
    assert.strictEqual(reopened.status, 200);
  });

  console.log('\n===== RESULTS =====');
  results.forEach(([st, nm]) => console.log(st + '  ' + nm));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
