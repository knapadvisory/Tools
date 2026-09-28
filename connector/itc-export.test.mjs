/* ============================================================================
 * itc-export.test.mjs — the ITC register read from Tally's OWN export file.
 *
 *   node connector/itc-export.test.mjs
 *
 * No stub Tally at all. That is the point: a Tally shown through a remote-app
 * window has no port and no desktop, but Export (Alt+E) is a menu inside that
 * window and the file it writes holds the same <VOUCHER> blocks the connector
 * reads over HTTP. The file is streamed to the connector in small chunks, in
 * UTF-8 and in the UTF-16 ("Unicode") older Tally releases write, and every
 * voucher must come out exactly as a live read would have produced it.
 * ==========================================================================*/
import { spawn } from 'node:child_process';

const DAY0 = Date.UTC(2025, 3, 1);
const dnum = (k) => { const x = new Date(DAY0 + k * 86400000);
  return x.getUTCFullYear() * 10000 + (x.getUTCMonth() + 1) * 100 + x.getUTCDate(); };

/* What TallyPrime writes for a Day Book exported as XML. */
const vch = (i, itc, extra = '') => `<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="r-${i}" VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Accounting Voucher View">
<DATE>${dnum(Math.floor(i / 20))}</DATE><GUID>g-${i}</GUID>
<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>PI/${i}</VOUCHERNUMBER>
<PARTYLEDGERNAME>Supplier ${i % 50}</PARTYLEDGERNAME><PARTYGSTIN>07ABCDE${String(1000 + i % 50)}F1Z${i % 10}</PARTYGSTIN>
<SUPPLIERINVOICENO>INV-${i}</SUPPLIERINVOICENO><CMPGSTIN>06AAACE1234F1Z5</CMPGSTIN>
<ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>${extra}
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Supplier ${i % 50}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>11800</AMOUNT></ALLLEDGERENTRIES.LIST>
${itc ? '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchases</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-10000</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Input IGST</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1800</AMOUNT></ALLLEDGERENTRIES.LIST>'
     : '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchases</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-11800</AMOUNT></ALLLEDGERENTRIES.LIST>'}
</VOUCHER>
</TALLYMESSAGE>`;
const wrap = (msgs) => `<ENVELOPE>\n<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>\n<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>\n${msgs}\n</REQUESTDATA></IMPORTDATA></BODY>\n</ENVELOPE>\n`;

const TOTAL = 3000, ITC_EVERY = 5;
const body = [];
for (let i = 0; i < TOTAL; i++) body.push(vch(i, (i % ITC_EVERY) === 0));
/* one cancelled and one optional voucher, both carrying input GST — must be skipped */
body.push(vch(90001, true).replace('<ISCANCELLED>No</ISCANCELLED>', '<ISCANCELLED>Yes</ISCANCELLED>'));
body.push(vch(90002, true).replace('<ISOPTIONAL>No</ISOPTIONAL>', '<ISOPTIONAL>Yes</ISOPTIONAL>'));
const XML = wrap(body.join('\n'));

const conn = spawn('node', [new URL('./knap-tally-connector.mjs', import.meta.url).pathname],
  { env: { ...process.env, PORT: '8910' }, stdio: ['ignore', 'pipe', 'pipe'] });
const tallyCalls = [];
conn.stderr.on('data', (d) => { const s = String(d); if (/Error|error/.test(s)) console.log('CONN:', s.trim().slice(0, 200)); });
await new Promise((r) => setTimeout(r, 2500));

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

/* Stream the file in small chunks — vouchers WILL be cut mid-tag at the
   boundaries, which is what the reader has to cope with. */
async function* chunks(buf, size) { for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size); }
async function send(buf, opts = {}) {
  const q = new URLSearchParams({ from: opts.from || '2025-04-01', to: opts.to || '2026-03-31',
    taxLedgers: JSON.stringify(opts.ledgers || [{ name: 'Input IGST', kind: 'igst' }]), company: 'export.xml' });
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:8910/api/itc/register-xml?' + q, {
    method: 'POST', headers: { 'content-type': 'text/xml' }, body: chunks(buf, opts.chunk || 7919), duplex: 'half' });
  const j = await r.json();
  const prog = await (await fetch('http://127.0.0.1:8910/api/dc/progress')).json();
  console.log(`\n[${opts.label}] rows=${j.rows ? j.rows.length : '-'} bytes=${(buf.length / 1048576).toFixed(1)}MB time=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`         note: ${prog.note}`);
  return { j, note: prog.note };
}

console.log('── a Day Book exported as XML, streamed in pieces ──');
const utf8 = await send(Buffer.from(XML, 'utf8'), { label: 'UTF-8' });
t('every ITC voucher is found, and nothing else', () => {
  assert(utf8.j.ok, 'the read failed: ' + JSON.stringify(utf8.j).slice(0, 200));
  assert(utf8.j.rows.length === TOTAL / ITC_EVERY, `expected ${TOTAL / ITC_EVERY} rows, got ${utf8.j.rows.length}`);
});
t('a voucher is whole however the chunks fell', () => {
  const r = utf8.j.rows.find((x) => x.voucherNo === 'PI/1500');
  assert(r, 'PI/1500 is missing');
  assert(Math.abs(r.taxable - 10000) < 0.01 && Math.abs(r.igst - 1800) < 0.01, `figures: ${JSON.stringify(r)}`);
  assert(r.supplierInvNo === 'INV-1500', `supplier invoice no: ${r.supplierInvNo}`);
  assert(r.gstin === '07ABCDE1000F1Z0', `the GSTIN comes from the voucher itself, no masters needed: ${r.gstin}`);
  assert(r.ownGstin === '06AAACE1234F1Z5', `and so does our own registration: ${r.ownGstin}`);
});
t('cancelled and optional vouchers are skipped', () => {
  assert(!utf8.j.rows.some((x) => /9000[12]/.test(x.voucherNo)), 'a cancelled or optional voucher came through');
});
t('and it says where the books came from', () => {
  assert(/export file/.test(utf8.note) && /no live Tally/.test(utf8.note), 'the note must say so: ' + utf8.note);
});

console.log('\n── the same file as older Tally writes it: UTF-16 with a byte-order mark ──');
const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(XML, 'utf16le')]);
const utf16 = await send(u16, { label: 'UTF-16LE', chunk: 4097 });      // odd chunk: splits a code unit
t('a UTF-16 export reads identically', () => {
  assert(utf16.j.ok, 'the read failed: ' + JSON.stringify(utf16.j).slice(0, 200));
  assert(utf16.j.rows.length === TOTAL / ITC_EVERY, `expected ${TOTAL / ITC_EVERY} rows, got ${utf16.j.rows.length}`);
  const a = utf8.j.rows.map((x) => x.voucherNo + ':' + x.igst).join('|');
  const b = utf16.j.rows.map((x) => x.voucherNo + ':' + x.igst).join('|');
  assert(a === b, 'the two encodings must give the same rows');
});

console.log('\n── the period, and a file that is not an export ──');
const q1 = await send(Buffer.from(XML, 'utf8'), { label: 'Apr-Jun only', from: '2025-04-01', to: '2025-06-30' });
t('only the period asked for is kept', () => {
  const days = 91, expectedMax = Math.ceil((days * 20) / ITC_EVERY);
  assert(q1.j.rows.length > 0 && q1.j.rows.length <= expectedMax,
    `about ${expectedMax} rows for a quarter, got ${q1.j.rows.length}`);
  assert(q1.j.rows.every((x) => x.date >= '2025-04-01' && x.date <= '2025-06-30'), 'a row outside the period came through');
});
const bad = await send(Buffer.from('<?xml version="1.0"?><ENVELOPE><BODY><DATA><TALLYMESSAGE><LEDGER NAME="x"/></TALLYMESSAGE></DATA></BODY></ENVELOPE>', 'utf8'), { label: 'no vouchers' });
t('a file with no vouchers says what to export instead', () => {
  assert(bad.j.ok === false, 'it must fail: ' + JSON.stringify(bad.j).slice(0, 120));
  assert(/Day Book or Voucher Register/.test(bad.j.error), 'and say which report: ' + bad.j.error);
});

console.log(`\n${pass} passed, ${fail} failed`);
conn.kill();
process.exit(fail ? 1 : 0);
