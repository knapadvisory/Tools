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
  assert(/Transactions/.test(bad.j.error), 'and name the menu: ' + bad.j.error);
});
/* What actually arrived from the field: the Ledger Vouchers screen of Input
   CGST, exported with "Current" — 3,432 lines of DSPVCHDATE / DSPVCHLEDACCOUNT
   / DSPVCHDRAMT / DSPEXPLVCHNUMBER, UTF-16, and not one <VOUCHER>. It is the
   report as displayed, with no GSTIN, no taxable value and no ledger legs.
   The right answer is not "no vouchers" but "wrong menu, here is the right one". */
const dsp = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('<ENVELOPE>\r\n' + Array.from({ length: 400 }, (_, i) =>
  ` <DSPVCHDATE>${1 + (i % 28)}-Apr-25</DSPVCHDATE>\r\n <DSPVCHLEDACCOUNT>SUPPLIER ${i}</DSPVCHLEDACCOUNT>\r\n <DSPVCHTYPE>Purc</DSPVCHTYPE>\r\n <DSPVCHDRAMT>-${(410 + i)}.40</DSPVCHDRAMT>\r\n <DSPVCHCRAMT></DSPVCHCRAMT>\r\n <DSPEXPLVCHNUMBER>(No. :GST/25-26/${i})</DSPEXPLVCHNUMBER>\r\n`).join('') + '</ENVELOPE>\r\n', 'utf16le')]);
const rep = await send(dsp, { label: 'report as displayed' });
t('a report exported "as displayed" is recognised, and the right menu named', () => {
  assert(rep.j.ok === false, 'it must fail: ' + JSON.stringify(rep.j).slice(0, 120));
  assert(/as it appears on screen/.test(rep.j.error), 'it must say what the file is: ' + rep.j.error);
  assert(/Alt\+E .* Transactions/.test(rep.j.error) && /not Current/.test(rep.j.error), 'and the menu that gives vouchers: ' + rep.j.error);
});

console.log('\n── what is in the file, before anything is read against it ──');
async function census(buf, label) {
  const r = await fetch('http://127.0.0.1:8910/api/itc/export-ledgers', {
    method: 'POST', headers: { 'content-type': 'text/xml' }, body: chunks(buf, 7919), duplex: 'half' });
  const j = await r.json();
  console.log(`\n[${label}] vouchers=${j.vouchers} ledgers=${j.ledgers ? j.ledgers.length : '-'} ${j.from}..${j.to}`);
  return j;
}
const cen = await census(Buffer.from(XML, 'utf8'), 'census');
t('every ledger in the vouchers is listed, with how many touch it', () => {
  assert(cen.ok, 'census failed: ' + JSON.stringify(cen).slice(0, 160));
  const by = Object.fromEntries(cen.ledgers.map((l) => [l.name, l]));
  assert(by['Input IGST'] && by['Input IGST'].vouchers === TOTAL / ITC_EVERY, `Input IGST: ${JSON.stringify(by['Input IGST'])}`);
  assert(by['Purchases'] && by['Purchases'].vouchers === TOTAL, `Purchases: ${JSON.stringify(by['Purchases'])}`);
  assert(by['Supplier 7'] && by['Supplier 7'].vouchers === TOTAL / 50, `a party ledger: ${JSON.stringify(by['Supplier 7'])}`);
  assert(Math.abs(by['Input IGST'].dr - 1800 * (TOTAL / ITC_EVERY)) < 0.01, `and what they total: Dr ${by['Input IGST'].dr}`);
});
t('the dates, the types and the registrations come with it', () => {
  assert(cen.from === '2025-04-01', `from ${cen.from}`);
  assert(cen.to === '2025-08-28', `to ${cen.to} (3,000 vouchers at twenty a day)`);
  assert(cen.types[0].name === 'Purchase' && cen.types[0].vouchers === TOTAL, JSON.stringify(cen.types));
  assert(cen.registrations.join() === '06AAACE1234F1Z5', `registrations: ${cen.registrations}`);
  /* 3,000 purchases plus one cancelled and one optional: all three thousand
     and two are vouchers in the file, and the census says so; the cancelled
     one is also counted as cancelled, so the reader knows what it will skip. */
  assert(cen.vouchers === TOTAL + 2 && cen.cancelled === 1, `vouchers in the file / cancelled among them: ${cen.vouchers}/${cen.cancelled}`);
});
const cenRep = await census(dsp, 'census of a report');
t('a report exported "as displayed" is named as such here too', () => {
  assert(cenRep.ok === false && cenRep.report === true, JSON.stringify(cenRep).slice(0, 160));
  assert(/Transactions/.test(cenRep.error), cenRep.error);
});

console.log(`\n${pass} passed, ${fail} failed`);
conn.kill();
process.exit(fail ? 1 : 0);
