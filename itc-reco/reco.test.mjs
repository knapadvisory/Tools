/* ============================================================================
 * reco.test.mjs — how a matched document is LABELLED.
 *
 *   npm i --no-save playwright-core && node itc-reco/reco.test.mjs
 *
 * Built from a real run (ECLAT, FY 2025-26). Three documents there had their
 * value and tax agreeing with 2B to the paisa and were still reported as
 * "booked - amount mismatch", because the wrong-registration branch overwrote
 * the remark whatever the figures said. That sends a preparer hunting for a
 * rate error that does not exist, and buries the finding that matters — ITC
 * claimed in the wrong GSTIN — inside a pile of value differences.
 * ==========================================================================*/
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(8143, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium/chrome-linux/chrome',
  args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:8143/itc-reco/');

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

/* Run several 2B documents against several books vouchers, and report how each
   was labelled and which voucher it was given. */
const runAll = (bs, bks) => page.evaluate(([bs, bks]) => {
  booksRows = bks;
  twoBRows = bs;
  loadedFiles = [{ name: 'x.json', count: bs.length, rows: bs }];
  ['hIGST', 'hINTRA', 'hNIL'].forEach((id) => { const e = document.getElementById(id); if (e) e.checked = true; });
  reconcile();
  return report.recs.map((r) => ({ doc: r.docNo, cat: r._cat, remarks: r.remarks, vch: r.vchBk }));
}, [bs, bks]);

/* Run one 2B document against one books voucher and report how it is labelled. */
const label = (b, bk) => page.evaluate(([b, bk]) => {
  booksRows = [bk];
  twoBRows = [b];
  loadedFiles = [{ name: 'x.json', count: 1, rows: [b] }];
  ['hIGST', 'hINTRA', 'hNIL'].forEach((id) => { const e = document.getElementById(id); if (e) e.checked = true; });
  reconcile();
  const r = report.recs[0];
  return { cat: r._cat, remarks: r.remarks, note: r.note, gstChk: r.gstChk, taxChk: r.taxChk };
}, [b, bk]);

const doc = (o) => Object.assign({
  regn: '06AAGCE4293A1ZX', period: '112025', gstin: '07BICPL2786D1ZB', party: 'DEEPALI ENGINEERING',
  invNo: 'DEE/2025-26/196', invDate: '2025-11-05', invoiceValue: 1762094,
  taxable: 1493300, igst: 268794, cgst: 0, sgst: 0, rcm: false, isCN: false, itcBlocked: false,
}, o);
const book = (o) => Object.assign({
  _ownGstin: '06AAGCE4293A1ZX', _company: 'ECLAT', date: '2025-11-05',
  voucherNo: 'DEE/2025-26/196', supplierInvNo: 'DEE/2025-26/196', ref: '',
  party: 'DEEPALI ENGINEERING', gstin: '07BICPL2786D1ZB',
  taxable: 1493300, igst: 268794, cgst: 0, sgst: 0, rcmIgst: 0, rcmCgst: 0, rcmSgst: 0,
}, o);

console.log('\n── a document whose figures agree ──');
await t('booked under the right GSTIN, figures agreeing, reads as booked', async () => {
  const r = await label(doc({}), book({}));
  assert(r.cat === 'matched', `expected matched, got ${r.cat} (${r.remarks})`);
  assert(!/mismatch/.test(r.remarks), 'nothing is mismatched here: ' + r.remarks);
});
await t('booked under the WRONG GSTIN is not called an amount mismatch', async () => {
  // the real DEE/2025-26/196: belongs to 06…, booked under 37…, figures identical
  const r = await label(doc({}), book({ _ownGstin: '37AAGCE4293A1ZS' }));
  assert(Math.abs(r.gstChk) < 0.01 && Math.abs(r.taxChk) < 0.01,
    `the fixture must have figures that agree: gst ${r.gstChk}, taxable ${r.taxChk}`);
  assert(!/amount mismatch/.test(r.remarks),
    'the value and tax agree to the paisa — calling it an amount mismatch is untrue: ' + r.remarks);
  assert(/wrong registration/.test(r.remarks), 'it must still be flagged: ' + r.remarks);
  assert(/registration question only/.test(r.note), 'the note should say the figures are fine: ' + r.note);
});
await t('it gets its own bucket, not the amount-mismatch pile', async () => {
  const cat = await page.evaluate(() => report.recs[0]._cat);
  assert(cat === 'wrongreg', `expected its own category, got ${cat}`);
});

console.log('\n── wrong GSTIN and wrong figures ──');
await t('when both are wrong, both are said', async () => {
  // the real KNDIN022701/2526: wrong registration AND 32.93 of GST difference
  const r = await label(doc({ invNo: 'KNDIN022701/2526', taxable: 163064.41, igst: 29351.59 }),
                        book({ _ownGstin: '21AAGCE4293A1Z5', voucherNo: 'KNDIN022701/2526',
                               supplierInvNo: 'KNDIN022701/2526', taxable: 162881.44, igst: 29318.66 }));
  assert(/amount mismatch/.test(r.remarks), 'the figures DO differ here: ' + r.remarks);
  assert(/wrong registration/.test(r.remarks), 'and the registration is wrong too: ' + r.remarks);
  assert(/ALSO differs/.test(r.note), 'the note should say both: ' + r.note);
});

console.log('\n── a genuine value difference, right GSTIN ──');
await t('a real GST difference is still an amount mismatch', async () => {
  // the real 2557: same taxable, 684.00 of GST missing in the books
  const r = await label(doc({ invNo: '2557', taxable: 74170, igst: 13350.60 }),
                        book({ voucherNo: '2557', supplierInvNo: '2557', taxable: 74170, igst: 12666.60 }));
  assert(r.cat === 'mismatch', `expected mismatch, got ${r.cat}`);
  assert(!/wrong registration/.test(r.remarks), 'the registration is fine: ' + r.remarks);
});


console.log('\n── a taxable difference where the GST agrees ──');
await t('freight on the voucher does not turn a confirmed match into "verify"', async () => {
  // the real ST/25-26/221: same invoice number, GST 109031.40 both sides,
  // books taxable 5,000 higher because freight was charged on the voucher
  const r = await label(doc({ invNo: 'ST/25-26/221', taxable: 605730, igst: 109031.40 }),
                        book({ voucherNo: 'ST/25-26/221', supplierInvNo: 'ST/25-26/221',
                               taxable: 610730, igst: 109031.40 }));
  assert(r.cat === 'matched', `the invoice number and the GST both agree — expected booked, got ${r.cat}`);
  assert(!/verify/.test(r.remarks), 'nothing needs verifying here: ' + r.remarks);
  assert(/credit is unaffected/.test(r.note), 'the difference should still be explained: ' + r.note);
});
await t('but an unconfirmed match with a taxable gap is still worth a look', async () => {
  // same figures, except the books voucher number tells us nothing
  const r = await label(doc({ invNo: 'ST/25-26/221', taxable: 605730, igst: 109031.40 }),
                        book({ voucherNo: 'PUR/0012', supplierInvNo: '', ref: '',
                               taxable: 610730, igst: 109031.40 }));
  assert(r.cat === 'probable', `nothing confirms this pairing — expected probable, got ${r.cat}`);
});

console.log('\n── a run of identical invoices from one supplier ──');
await t('pairing 913900250 with voucher 913900258 is not called booked', async () => {
  // Ultratech billed 8,424.00 many times over; the amounts tie but the
  // document numbers plainly differ, so party+amount is the only evidence
  const r = await label(doc({ invNo: '913900250', party: 'M/s Ultratech Cement Ltd.',
                              taxable: 46800, igst: 8424 }),
                        book({ voucherNo: '913900258', supplierInvNo: '913900258',
                               party: 'ULTRATECH CEMENT LTD', taxable: 46800, igst: 8424 }));
  assert(r.cat !== 'matched', 'a different document number must not read as booked: ' + r.remarks);
  assert(/verify/.test(r.remarks), 'it should ask for a look: ' + r.remarks);
  assert(/wrong two/.test(r.note), 'the note should say why: ' + r.note);
});
await t('books with no invoice number at all still match on amount', async () => {
  // an internal voucher number and nothing else: amount matching is all there is
  const r = await label(doc({ invNo: '913900250', taxable: 46800, igst: 8424 }),
                        book({ voucherNo: '', supplierInvNo: '', ref: '', taxable: 46800, igst: 8424 }));
  assert(r.cat === 'matched', `nothing contradicts this pairing — expected booked, got ${r.cat} (${r.remarks})`);
});


console.log('\n── a weak match must not eat a voucher an exact one needs ──');
await t('SA/25-26/10 and SA/25-26/100 each get their own voucher', async () => {
  /* The real pair. One invoice number contains the other and the party is the
     same, so in file order SA/25-26/100 took voucher SA/25-26/10 and the real
     SA/25-26/10 was reported as not booked at all. */
  const out = await runAll(
    [doc({ invNo: 'SA/25-26/100', party: 'SARA ASSOCIATES', gstin: '33BDRPR3498A1Z9', taxable: 68005, igst: 12240.90 }),
     doc({ invNo: 'SA/25-26/10',  party: 'SARA ASSOCIATES', gstin: '33BDRPR3498A1Z9', taxable: 164440, igst: 29599.20 })],
    [book({ voucherNo: 'SA/25-26/10', supplierInvNo: 'SA/25-26/10', ref: 'SA/25-26/10',
            party: 'SARA ASSOCIATES', gstin: '33BDRPR3498A1Z9', taxable: 164440, igst: 29599.20 })]);
  const exact = out.find((r) => r.doc === 'SA/25-26/10');
  const other = out.find((r) => r.doc === 'SA/25-26/100');
  assert(exact.vch === 'SA/25-26/10',
    `the document with the SAME number must get the voucher, got "${exact.vch}" (${exact.remarks})`);
  assert(exact.cat === 'matched', `expected booked, got ${exact.cat} (${exact.remarks})`);
  assert(!other.vch, `SA/25-26/100 has no voucher of its own, got "${other.vch}"`);
});
await t("RAMCO's two documents are not cross-matched either", async () => {
  /* KNDIN022701/2526 took VGDIN026605/2526's voucher on party and amount, and
     the resulting registration difference was then reported as an ITC booked
     under the wrong GSTIN — a finding that did not exist. */
  const out = await runAll(
    [doc({ regn: '06AAGCE4293A1ZX', invNo: 'KNDIN022701/2526', party: 'THE RAMCO CEMENTS LIMITED',
           gstin: '37AABCM8375L1ZV', taxable: 163064.41, igst: 29351.59 }),
     doc({ regn: '21AAGCE4293A1Z5', invNo: 'VGDIN026605/2526', party: 'THE RAMCO CEMENTS LIMITED',
           gstin: '37AABCM8375L1ZV', taxable: 162881.54, igst: 29318.64 })],
    [book({ _ownGstin: '21AAGCE4293A1Z5', voucherNo: 'VGDIN026605/2526', supplierInvNo: 'VGDIN026605/2526',
            ref: 'VGDIN026605/2526', party: 'THE RAMCO CEMENTS LIMITED', gstin: '37AABCM8375L1ZV',
            taxable: 162881.54, igst: 29318.66 })]);
  const right = out.find((r) => r.doc === 'VGDIN026605/2526');
  const wrong = out.find((r) => r.doc === 'KNDIN022701/2526');
  assert(right.vch === 'VGDIN026605/2526', `the exact number should win the voucher, got "${right.vch}"`);
  assert(right.cat === 'matched', `expected booked, got ${right.cat} (${right.remarks})`);
  assert(!/wrong registration/.test(wrong.remarks),
    'a mis-pairing must not be reported as ITC in the wrong GSTIN: ' + wrong.remarks);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (errs.length) { console.log('\nBROWSER ERRORS:'); errs.slice(0, 5).forEach((e) => console.log('  ' + e)); }
await browser.close(); srv.close();
process.exit(fail || errs.length ? 1 : 0);
