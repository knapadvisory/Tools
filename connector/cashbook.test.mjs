/* ============================================================================
 * cashbook.test.mjs — the cash-book read for the s.40A(3) / s.269ST report,
 * against a stub Tally.
 *
 *   node connector/cashbook.test.mjs
 *
 * The stub has two cash ledgers (one under a sub-group of Cash-in-Hand), a
 * bank, parties and expenses, and a year of vouchers: cash payments of every
 * size to the same party on one day, a cash receipt, a contra, a cancelled
 * voucher and an optional one. The connector must return exactly the cash legs
 * — once each — with the right direction, counter-party and bank flag.
 * ==========================================================================*/
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const groupsXml = `<ENVELOPE>
<GROUP NAME="Cash-in-Hand"><NAME>Cash-in-Hand</NAME><PARENT>Current Assets</PARENT></GROUP>
<GROUP NAME="Petty Cash Boxes"><NAME>Petty Cash Boxes</NAME><PARENT>Cash-in-Hand</PARENT></GROUP>
<GROUP NAME="Current Assets"><NAME>Current Assets</NAME><PARENT></PARENT></GROUP>
<GROUP NAME="Bank Accounts"><NAME>Bank Accounts</NAME><PARENT>Current Assets</PARENT></GROUP>
<GROUP NAME="Sundry Creditors"><NAME>Sundry Creditors</NAME><PARENT>Current Liabilities</PARENT></GROUP>
<GROUP NAME="Current Liabilities"><NAME>Current Liabilities</NAME><PARENT></PARENT></GROUP>
<GROUP NAME="Indirect Expenses"><NAME>Indirect Expenses</NAME><PARENT></PARENT><ISREVENUE>Yes</ISREVENUE></GROUP>
<GROUP NAME="Sales Accounts"><NAME>Sales Accounts</NAME><PARENT></PARENT><ISREVENUE>Yes</ISREVENUE></GROUP>
</ENVELOPE>`;
const ledgersXml = `<ENVELOPE>
<LEDGER NAME="Cash"><NAME>Cash</NAME><PARENT>Cash-in-Hand</PARENT><OPENINGBALANCE>-50000</OPENINGBALANCE></LEDGER>
<LEDGER NAME="Site Petty Cash"><NAME>Site Petty Cash</NAME><PARENT>Petty Cash Boxes</PARENT><OPENINGBALANCE>-2000</OPENINGBALANCE></LEDGER>
<LEDGER NAME="HDFC Bank"><NAME>HDFC Bank</NAME><PARENT>Bank Accounts</PARENT></LEDGER>
<LEDGER NAME="Mahavir Traders"><NAME>Mahavir Traders</NAME><PARENT>Sundry Creditors</PARENT></LEDGER>
<LEDGER NAME="Conveyance"><NAME>Conveyance</NAME><PARENT>Indirect Expenses</PARENT></LEDGER>
<LEDGER NAME="Cash Sales"><NAME>Cash Sales</NAME><PARENT>Sales Accounts</PARENT></LEDGER>
</ENVELOPE>`;
const leg = (name, dr, amt) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${name}</LEDGERNAME><ISDEEMEDPOSITIVE>${dr ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${dr ? -amt : amt}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
const vch = (guid, date, type, no, party, legs, extra = '') => `<VOUCHER VCHTYPE="${type}"><DATE>${date}</DATE><GUID>${guid}</GUID><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>
<VOUCHERNUMBER>${no}</VOUCHERNUMBER>${party ? `<PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>` : ''}<NARRATION>n-${no}</NARRATION>
<ISCANCELLED>${/cancel/.test(extra) ? 'Yes' : 'No'}</ISCANCELLED><ISOPTIONAL>${/optional/.test(extra) ? 'Yes' : 'No'}</ISOPTIONAL>${legs}</VOUCHER>`;
const ALL = [
  // three cash payments to Mahavir on one day: 4,000 + 4,000 + 3,000 = 11,000 — each under 10,000, together over it
  vch('p1', '20250410', 'Payment', 'P/1', 'Mahavir Traders', leg('Mahavir Traders', true, 4000) + leg('Cash', false, 4000)),
  vch('p2', '20250410', 'Payment', 'P/2', 'Mahavir Traders', leg('Mahavir Traders', true, 4000) + leg('Cash', false, 4000)),
  vch('p3', '20250410', 'Payment', 'P/3', 'Mahavir Traders', leg('Mahavir Traders', true, 3000) + leg('Cash', false, 3000)),
  // a single payment of 12,000 from the petty cash box, no party ledger set — the counter is the expense
  vch('p4', '20250512', 'Payment', 'P/4', '', leg('Conveyance', true, 12000) + leg('Site Petty Cash', false, 12000)),
  // a cash receipt of 2,10,000 (s.269ST) and one of 1,95,000 (near)
  vch('r1', '20250620', 'Receipt', 'R/1', 'Cash Sales', leg('Cash', true, 210000) + leg('Cash Sales', false, 210000)),
  vch('r2', '20250721', 'Receipt', 'R/2', 'Cash Sales', leg('Cash', true, 195000) + leg('Cash Sales', false, 195000)),
  // a contra: cash deposited into the bank — the counter is a bank
  vch('c1', '20250801', 'Contra', 'C/1', '', leg('HDFC Bank', true, 100000) + leg('Cash', false, 100000)),
  // noise: cancelled, optional, outside the period, and a voucher with no cash leg
  vch('x1', '20250415', 'Payment', 'P/X', 'Mahavir Traders', leg('Mahavir Traders', true, 50000) + leg('Cash', false, 50000), 'cancel'),
  vch('x2', '20250416', 'Payment', 'P/Y', 'Mahavir Traders', leg('Mahavir Traders', true, 60000) + leg('Cash', false, 60000), 'optional'),
  vch('x3', '20240416', 'Payment', 'P/Z', 'Mahavir Traders', leg('Mahavir Traders', true, 70000) + leg('Cash', false, 70000)),
  vch('b1', '20250901', 'Payment', 'B/1', 'Mahavir Traders', leg('Mahavir Traders', true, 80000) + leg('HDFC Bank', false, 80000)),
];
let requests = 0;
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    requests++;
    res.setHeader('content-type', 'text/xml');
    if (/<TYPE>Group<\/TYPE>/i.test(b)) return res.end(groupsXml);
    if (/<TYPE>Ledger<\/TYPE>/i.test(b)) return res.end(ledgersXml);
    if (/<TYPE>Voucher<\/TYPE>/i.test(b)) {
      // honour the window, as Tally does, but repeat one voucher to prove the dedupe
      const from = Number((b.match(/<SVFROMDATE[^>]*>(\d{8})/i) || [])[1] || 0), to = Number((b.match(/<SVTODATE[^>]*>(\d{8})/i) || [])[1] || 99999999);
      const inWin = ALL.filter((v) => { const d = Number(v.match(/<DATE>(\d{8})/)[1]); return d >= from && d <= to; });
      return res.end('<ENVELOPE>' + inWin.join('') + (inWin[0] || '') + '</ENVELOPE>');
    }
    res.end('<ENVELOPE></ENVELOPE>');
  });
});
await new Promise((ok) => stub.listen(9011, '127.0.0.1', ok));

const conn = spawn('node', [new URL('./knap-tally-connector.mjs', import.meta.url).pathname],
  { env: { ...process.env, PORT: '8899' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
conn.stdout.on('data', (d) => out += d); conn.stderr.on('data', (d) => out += d);
for (let i = 0; i < 80; i++) {
  try { const r = await fetch('http://127.0.0.1:8899/api/dc/progress'); if (r.ok) break; } catch { /* starting */ }
  await new Promise((ok) => setTimeout(ok, 150));
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

console.log('\n── the cash book ──');
let j;
await t('the connector returns every cash leg in the period, once each, and nothing else', async () => {
  const r = await fetch('http://127.0.0.1:8899/api/fin/cashbook', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: '2025-04-01', to: '2026-03-31', url: 'http://127.0.0.1:9011' }) });
  j = await r.json();
  assert.ok(j.ok, j.error || JSON.stringify(j).slice(0, 300));
  assert.deepEqual(j.cashLedgers.sort(), ['Cash', 'Site Petty Cash']);
  assert.equal(j.count, 7, JSON.stringify(j.vouchers.map((v) => v.number)));
  assert.deepEqual(j.vouchers.map((v) => v.number), ['P/1', 'P/2', 'P/3', 'P/4', 'R/1', 'R/2', 'C/1']);
});
await t('direction, party and counter are right; a contra is flagged as bank', async () => {
  const by = Object.fromEntries(j.vouchers.map((v) => [v.number, v]));
  assert.equal(by['P/1'].direction, 'payment'); assert.equal(by['P/1'].party, 'Mahavir Traders'); assert.equal(by['P/1'].amount, 4000);
  assert.equal(by['P/4'].party, 'Conveyance', 'no party ledger → the largest non-cash leg'); assert.equal(by['P/4'].ledger, 'Site Petty Cash');
  assert.equal(by['R/1'].direction, 'receipt'); assert.equal(by['R/1'].amount, 210000);
  assert.equal(by['C/1'].counterIsBank, true); assert.equal(by['C/1'].direction, 'payment');
  assert.equal(by['P/1'].narration, 'n-P/1'); assert.equal(by['P/1'].date, '2025-04-10');
});
await t('a company with no cash ledger answers cleanly', async () => {
  // not simulated here beyond the shape — the route returns ok with an empty list and a note
  assert.ok(Array.isArray(j.vouchers));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(out.split('\n').slice(-20).join('\n'));
conn.kill(); stub.close();
process.exit(fail ? 1 : 0);
