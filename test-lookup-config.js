/**
 * Tests that the line-type lists can be reconfigured from Railway variables:
 * an empty value must switch a list OFF (not fall back to its default), and a
 * type moved into BLOCKED_LINE_TYPES must actually block.
 * Stubbed Twilio client — no network calls, no cost.
 *
 *   node test-lookup-config.js
 */
const Module = require('module');
const assert = require('assert');

let smsSent = [];
const lookupResponses = {
  '+15551230002': { type: 'landline', carrierName: 'CenturyLink' },
  '+15551230003': { type: 'nonFixedVoip', carrierName: 'TextNow' }
};

const stub = () => ({
  lookups: {
    v2: {
      phoneNumbers: (n) => ({
        fetch: async () => ({ valid: true, lineTypeIntelligence: lookupResponses[n] })
      })
    }
  },
  verify: {
    v2: {
      services: () => ({
        verifications: { create: async ({ to }) => { smsSent.push(to); return { status: 'pending' }; } },
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

const PORT = 45874;
process.env.PORT = String(PORT);
process.env.VERIFY_SERVICE_SID = 'VAtest';
process.env.RATE_LIMIT_MAX = '0';
// The configuration under test: landline blocked outright, the other two
// lists explicitly emptied.
process.env.BLOCKED_LINE_TYPES = 'landline';
process.env.NO_SMS_LINE_TYPES = '';
process.env.FLAGGED_LINE_TYPES = '';

require('./index.js');

const send = (phoneNumber) =>
  fetch(`http://127.0.0.1:${PORT}/send-verification`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber })
  }).then(async r => ({ status: r.status, body: await r.json() }));

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' -> ' + e.message]); }
}

(async () => {
  await new Promise(r => setTimeout(r, 300));

  smsSent = [];
  let r = await send('15551230002');
  check('BLOCKED_LINE_TYPES=landline blocks, with no save-to-Lofty', () => {
    assert.strictEqual(r.body.sent, false);
    assert.strictEqual(r.body.reason, 'blocked_line_type');
    assert.ok(!r.body.saveToLofty, 'a blocked number must not be saved');
    assert.strictEqual(smsSent.length, 0);
  });

  smsSent = [];
  r = await send('15551230003');
  check('FLAGGED_LINE_TYPES set empty really turns flagging off', () => {
    assert.strictEqual(r.body.sent, true);
    assert.strictEqual(r.body.flagged, false, 'empty value must not fall back to the nonFixedVoip default');
    assert.deepStrictEqual(smsSent, ['+15551230003']);
  });

  const stats = await fetch(`http://127.0.0.1:${PORT}/lookup-stats`).then(x => x.json());
  check('lookup-stats reports the live policy', () => {
    assert.deepStrictEqual(stats.policy.blocked, ['landline']);
    assert.deepStrictEqual(stats.policy.noSms, []);
    assert.deepStrictEqual(stats.policy.flagged, []);
  });

  console.log('\n===== RESULTS =====');
  results.forEach(([st, nm]) => console.log(st + '  ' + nm));
  const failed = results.filter(x => x[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
