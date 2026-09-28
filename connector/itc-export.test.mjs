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

console.log('\n── an All Vouchers export: sales, receipts, payments and journals mixed in ──');
/* TallyPrime 4's Transactions export has no voucher-type filter — it is All
   Vouchers or nothing. So the file the field will actually produce holds the
   whole company's year, and the read must take from it exactly the vouchers
   that touch the tagged input-GST ledgers and not one more. */
const other = (i, type, legs) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="o-${i}" VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View">
<DATE>${dnum(i % 150)}</DATE><GUID>og-${i}</GUID><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${type.slice(0, 2).toUpperCase()}/${i}</VOUCHERNUMBER>
<PARTYLEDGERNAME>${legs[0][0]}</PARTYLEDGERNAME><CMPGSTIN>06AAACE1234F1Z5</CMPGSTIN><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>
${legs.map(([nm, amt, dp]) => `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${nm}</LEDGERNAME><ISDEEMEDPOSITIVE>${dp}</ISDEEMEDPOSITIVE><AMOUNT>${amt}</AMOUNT></ALLLEDGERENTRIES.LIST>`).join('')}
</VOUCHER>
</TALLYMESSAGE>`;
const mixed = [];
for (let i = 0; i < 600; i++) mixed.push(vch(i, (i % ITC_EVERY) === 0));                                 // 120 purchases with ITC
for (let i = 0; i < 900; i++) mixed.push(other(i, 'Sales', [['Customer ' + (i % 40), '-23600', 'Yes'], ['Sales', '20000', 'No'], ['Output IGST', '3600', 'No']]));
for (let i = 0; i < 700; i++) mixed.push(other(i + 1000, 'Receipt', [['Customer ' + (i % 40), '23600', 'No'], ['HDFC Bank', '-23600', 'Yes']]));
for (let i = 0; i < 500; i++) mixed.push(other(i + 2000, 'Payment', [['Supplier ' + (i % 50), '-11800', 'Yes'], ['HDFC Bank', '11800', 'No']]));
/* the month-end ITC set-off: Input IGST CREDITED against Output IGST, no party — a journal, not a purchase */
for (let i = 0; i < 12; i++) mixed.push(other(i + 3000, 'Journal', [['Output IGST', '-3600', 'Yes'], ['Input IGST', '3600', 'No']]).replace(/<PARTYLEDGERNAME>[^<]*<\/PARTYLEDGERNAME>/, '<PARTYLEDGERNAME></PARTYLEDGERNAME>'));
const MIXED = wrap(mixed.join('\n'));
const all = await send(Buffer.from(MIXED, 'utf8'), { label: 'All Vouchers' });
t('only the purchases that touch the tagged input ledger come out', () => {
  assert(all.j.ok, 'the read failed: ' + JSON.stringify(all.j).slice(0, 200));
  assert(all.j.rows.length === 120, `120 ITC purchases among 2,712 vouchers, got ${all.j.rows.length}`);
  assert(all.j.rows.every((r) => r.voucherType === 'Purchase'), 'a non-purchase came through: ' + JSON.stringify(all.j.rows.find((r) => r.voucherType !== 'Purchase')));
});
t('the set-off journals are not counted as negative ITC', () => {
  assert(!all.j.rows.some((r) => /^JO\//.test(r.voucherNo)), 'an ITC set-off journal was read as a purchase');
});
const cenAll = await census(Buffer.from(MIXED, 'utf8'), 'census of All Vouchers');
t('and the census shows the whole company, so the right ledgers can be picked from it', () => {
  const by = Object.fromEntries(cenAll.ledgers.map((l) => [l.name, l]));
  assert(by['Output IGST'] && by['Input IGST'] && by['HDFC Bank'] && by['Sales'], 'every ledger touched must be listed: ' + Object.keys(by).length);
  assert(by['Input IGST'].vouchers === 120 + 12, `Input IGST is touched by 120 purchases and 12 set-off journals: ${by['Input IGST'].vouchers}`);
  const types = Object.fromEntries(cenAll.types.map((x) => [x.name, x.vouchers]));
  assert(types.Sales === 900 && types.Purchase === 600 && types.Journal === 12, JSON.stringify(types));
});

console.log('\n── a bill booked as a Journal: no party field, no supplier invoice field ──');
/* The voucher from the field, exactly: Dr CONSULTANCY CHARGES 12,000, Dr Input
   IGST 2,160, Cr TDS on Professional@10% 1,200, Cr GARG & ASSOCIATES 12,960,
   narration "professional fees month of Mar-26", and no PARTYLEDGERNAME. */
const journal = (no, narr, extra = '') => `<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER REMOTEID="j-${no}" VCHTYPE="Journal" ACTION="Create" OBJVIEW="Accounting Voucher View">
<DATE>20260331</DATE><GUID>jg-${no}</GUID><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><VOUCHERNUMBER>25-26/GST-${no}</VOUCHERNUMBER>
<PARTYLEDGERNAME></PARTYLEDGERNAME><CMPGSTIN>06AAACE1234F1Z5</CMPGSTIN><NARRATION>${narr}</NARRATION>
<ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>${extra}
<ALLLEDGERENTRIES.LIST><LEDGERNAME>CONSULTANCY CHARGES</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-12000</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input IGST</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-2160</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>TDS on Professional@10%</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1200</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>GARG &amp; ASSOCIATES</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>12960</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>`;
const jr = await send(Buffer.from(wrap(journal(101, 'professional fees month of Mar-26') + journal(102, 'being bill no GA/2526/041 for consultancy')), 'utf8'), { label: 'journals, no masters' });
t('the supplier is the one leg opposite the tax, and the base is the expense', () => {
  assert(jr.j.ok && jr.j.rows.length === 2, 'two journals: ' + JSON.stringify(jr.j).slice(0, 200));
  const r = jr.j.rows.find((x) => x.voucherNo === '25-26/GST-101');
  assert(r.party === 'GARG & ASSOCIATES' && r.partyInferred === true, `party: ${r.party} inferred=${r.partyInferred}`);
  assert(Math.abs(r.taxable - 12000) < 0.01, `taxable is the expense, not net of the supplier: ${r.taxable}`);
  assert(Math.abs(r.igst - 2160) < 0.01 && Math.abs(r.tds - 1200) < 0.01, `igst ${r.igst} tds ${r.tds}`);
});
t('a bill number in the narration is carried; a month name is not', () => {
  const a = jr.j.rows.find((x) => x.voucherNo === '25-26/GST-101'), b = jr.j.rows.find((x) => x.voucherNo === '25-26/GST-102');
  assert(a.narrationRef === '', `"Mar-26" is not a bill number: got "${a.narrationRef}"`);
  assert(b.narrationRef === 'GA/2526/041', `the bill number is: got "${b.narrationRef}"`);
});
/* With "Include dependent masters: Yes" the ledger masters ride in the same
   file, and the inferred party gets its group and GSTIN from them. */
const withMasters = wrap(`<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="GARG &amp; ASSOCIATES" RESERVEDNAME=""><PARENT>Sundry Creditors</PARENT><PARTYGSTIN>06AAKFG1234B1Z9</PARTYGSTIN></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="CONSULTANCY CHARGES" RESERVEDNAME=""><PARENT>Indirect Expenses</PARENT></LEDGER></TALLYMESSAGE>` + journal(103, 'fees'));
const jm = await send(Buffer.from(withMasters, 'utf8'), { label: 'journal, masters included' });
t('with the masters in the file, the party is picked by its group and gets its GSTIN', () => {
  const r = jm.j.rows[0];
  assert(r && r.party === 'GARG & ASSOCIATES', `party: ${JSON.stringify(r)}`);
  assert(r.gstin === '06AAKFG1234B1Z9', `GSTIN from the ledger master: ${r.gstin}`);
});
const cm = await census(Buffer.from(withMasters, 'utf8'), 'census with masters');
t('and the census shows each ledger\u2019s group, so step 2 can tell a creditor from an expense', () => {
  const by = Object.fromEntries(cm.ledgers.map((l) => [l.name, l]));
  assert(by['GARG & ASSOCIATES'].group === 'Sundry Creditors', JSON.stringify(by['GARG & ASSOCIATES']));
  assert(by['CONSULTANCY CHARGES'].group === 'Indirect Expenses', JSON.stringify(by['CONSULTANCY CHARGES']));
  assert(cm.mastersIncluded === 2, `masters seen: ${cm.mastersIncluded}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
conn.kill();
process.exit(fail ? 1 : 0);
