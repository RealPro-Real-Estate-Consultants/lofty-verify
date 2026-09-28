/**
 * Local utility — confirms Twilio Lookup / Line Type Intelligence is working on
 * this account, and shows what the live policy would do with a given number.
 *
 * Not used by the server. Run it by hand:
 *
 *   node check-line-type.js 12395551234
 *   node check-line-type.js 12395551234 12395559999
 *
 * Reads credentials from .env, so there is nothing to paste on the command line.
 * Each number costs ~$0.008. See docs/08-phone-lookup.md.
 */
require('dotenv').config();

// Same parsing and defaults as index.js: unset takes the default, an empty
// value means "none".
const typeList = (raw, fallback) =>
  (raw === undefined ? fallback : raw).split(',').map(s => s.trim()).filter(Boolean);

const BLOCKED = typeList(process.env.BLOCKED_LINE_TYPES, '');
const NO_SMS  = typeList(process.env.NO_SMS_LINE_TYPES, 'landline');
const FLAGGED = typeList(process.env.FLAGGED_LINE_TYPES, 'nonFixedVoip');

const numbers = process.argv.slice(2);

if (!numbers.length) {
  console.error('Usage: node check-line-type.js <number> [more numbers...]');
  console.error('Format: country code + number, no plus sign, e.g. 12395551234');
  process.exit(1);
}

if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
  console.error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing from .env');
  process.exit(1);
}

const client = require('twilio')(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

function verdict(type) {
  if (BLOCKED.includes(type)) return 'BLOCKED  — no OTP, nothing written to Lofty';
  if (NO_SMS.includes(type))  return 'NO SMS   — saved to Lofty with its line type, no OTP sent';
  if (FLAGGED.includes(type)) return 'FLAGGED  — OTP sends, marked for review in Lofty';
  return 'ALLOWED  — normal flow';
}

(async () => {
  console.log('Policy — block: [' + BLOCKED.join(', ') + ']  no_sms: [' + NO_SMS.join(', ') + ']  flag: [' + FLAGGED.join(', ') + ']\n');

  let sawRealType = false;

  for (const raw of numbers) {
    const e164 = '+' + String(raw).replace(/\D/g, '');
    try {
      const result = await client.lookups.v2
        .phoneNumbers(e164)
        .fetch({ fields: 'line_type_intelligence' });

      const lti = result.lineTypeIntelligence;

      if (!lti) {
        console.log(e164 + '  no line_type_intelligence in the response');
        console.log('   The number validated, but the data package did not come back.');
        console.log('   Usually means the account is on trial or has no billing enabled.\n');
        continue;
      }

      if (lti.errorCode) {
        console.log(e164 + '  errorCode ' + lti.errorCode + ' — line type could not be resolved');
        console.log('   The live gate treats this as "unknown" and lets the number through.\n');
        continue;
      }

      sawRealType = true;
      console.log(e164);
      console.log('   type:    ' + lti.type);
      console.log('   carrier: ' + (lti.carrierName || '(none)'));
      console.log('   verdict: ' + verdict(lti.type) + '\n');
    } catch (e) {
      console.log(e164 + '  lookup FAILED — ' + e.message);
      if (e.status === 401) {
        console.log('   401 — check the credentials in .env.');
      } else if (e.status === 403) {
        console.log('   403 — the account is not permitted to request this data package.');
        console.log('   Upgrade the account / enable billing, then try again.');
      }
      console.log('   The live gate fails open on this: the lead would still get their code.\n');
    }
  }

  if (sawRealType) {
    console.log('Line Type Intelligence is working on this account.');
  } else {
    console.log('No real line type came back. The gate would allow every number through.');
    console.log('See docs/08-phone-lookup.md#enabling-line-type-intelligence.');
  }
})();
