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

/* Load real GSTR-2A / 2B JSON shapes through the page's own file path — detect
   the source, parse, merge — then reconcile against books rows. */
const runJson = (files, bks) => page.evaluate(([files, bks]) => {
  loadedFiles = files.map((f) => {
    const src = srcOfJson(f.json, f.name);
    const rows = parseGstJson(f.json, src, f.name);
    return { name: f.name, rows, count: rows.length, src };
  });
  rebuild2b();
  booksRows = bks;
  ['hIGST', 'hINTRA', 'hNIL'].forEach((id) => { const e = document.getElementById(id); if (e) e.checked = true; });
  reconcile();
  const pick = (r) => ({ doc: r.docNo, src: r.src, cat: r._cat, remarks: r.remarks, note: r.note,
    vch: r.vchBk, gst2b: r.gst2b, only2a: !!r._only2a });
  return { detected: loadedFiles.map((f) => f.src), merge: mergeStats,
    recs: report.recs.map(pick), cn: report.cn.map(pick) };
}, [files, bks]);

/* A GSTR-2A file as the portal gives it: tax inside itms[].itm_det as
   iamt/camt/samt, the invoice date as idt, no itcavl anywhere. */
const j2a = (invs, opts) => ({
  gstin: '06AAGCE4293A1ZX', fp: (opts && opts.fp) || '112025',
  b2b: [{ ctin: '07BICPL2786D1ZB', trdnm: 'DEEPALI ENGINEERING', cfs: 'Y',
    inv: invs.map((i) => ({ inum: i.no, idt: i.dt || '05-11-2025', val: i.val || 0, pos: '07', rchrg: 'N', inv_typ: 'R',
      itms: [{ num: 1, itm_det: { rt: 18, txval: i.txval, iamt: i.iamt || 0, camt: i.camt || 0, samt: i.samt || 0, csamt: 0 } }] })) }],
});
/* The same invoices as GSTR-2B gives them: docdata, dt, flat igst/cgst/sgst. */
const j2b = (invs, cdnr) => ({
  data: { gstin: '06AAGCE4293A1ZX', rtnprd: '112025', docdata: {
    b2b: invs.length ? [{ ctin: '07BICPL2786D1ZB', trdnm: 'DEEPALI ENGINEERING',
      inv: invs.map((i) => ({ inum: i.no, dt: i.dt || '05-11-2025', val: i.val || 0, txval: i.txval,
        igst: i.igst || 0, cgst: i.cgst || 0, sgst: i.sgst || 0, itcavl: 'Y' })) }] : [],
    cdnr: (cdnr || []).length ? [{ ctin: '07BICPL2786D1ZB', trdnm: 'DEEPALI ENGINEERING',
      nt: cdnr.map((n) => ({ ntty: n.ntty || 'C', nt_num: n.no, nt_dt: n.dt || '20-12-2025', val: n.val || 0,
        txval: n.txval, igst: n.igst || 0, cgst: n.cgst || 0, sgst: n.sgst || 0, itcavl: 'Y' })) }] : [],
  } },
});

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

console.log('\n── a one-digit invoice number ──');
await t('a supplier who bills "6" is still found in the books', async () => {
  /* Maa Kalyani's invoice 6, ₹1,34,964 taxable: present in the books with the
     same number, the same party and the same tax, and reported as not booked
     because a one-character number was dropped before matching began. */
  const r = await label(doc({ invNo: '6', party: 'MAA KALYANI TRADERS', gstin: '21ADQPP3838N1ZE',
                              taxable: 134964, igst: 24293.52 }),
                        book({ voucherNo: '6', supplierInvNo: '6', ref: '6',
                               party: 'MAA KALYANI TRADERS', gstin: '21ADQPP3838N1ZE',
                               taxable: 134964, igst: 24293.52 }));
  assert(r.cat === 'matched', `expected booked, got ${r.cat} (${r.remarks})`);
});
await t('but "6" alone does not pair two unrelated suppliers', async () => {
  const r = await label(doc({ invNo: '6', party: 'MAA KALYANI TRADERS', gstin: '21ADQPP3838N1ZE',
                              taxable: 134964, igst: 24293.52 }),
                        book({ voucherNo: '6', supplierInvNo: '6', ref: '6',
                               party: 'SHREE BALAJI HARDWARE', gstin: '07AAACS1234B1Z1',
                               taxable: 9100, igst: 1638 }));
  assert(r.cat === 'only2b',
    `a shared one-digit number is not evidence — expected unbooked, got ${r.cat} (${r.remarks})`);
});

console.log('\n── reading GSTR-2A ──');
await t('a 2A file is recognised as 2A and its figures read correctly', async () => {
  const out = await runJson(
    [{ name: 'GSTR2A_06AAGCE4293A1ZX_112025.json',
       json: j2a([{ no: 'DEE/2025-26/196', txval: 1493300, iamt: 268794, val: 1762094 }]) }],
    [book({})]);
  assert(out.detected[0] === '2A', `expected 2A, detected ${out.detected[0]}`);
  assert(out.recs.length === 1, `expected one document, got ${out.recs.length}`);
  assert(Math.abs(out.recs[0].gst2b - 268794) < 0.01,
    `iamt should be read as IGST, got ${out.recs[0].gst2b}`);
  assert(out.recs[0].vch === 'DEE/2025-26/196', 'it must still match the books voucher: ' + out.recs[0].remarks);
});
await t('a 2B file is still recognised as 2B', async () => {
  const out = await runJson(
    [{ name: '2B_06AAGCE4293A1ZX_112025.json',
       json: j2b([{ no: 'DEE/2025-26/196', txval: 1493300, igst: 268794 }]) }], [book({})]);
  assert(out.detected[0] === '2B', `expected 2B, detected ${out.detected[0]}`);
  assert(out.recs[0].cat === 'matched', `expected booked, got ${out.recs[0].cat}`);
  assert(!out.recs[0].only2a, 'a 2B document is not "2A only"');
});

console.log('\n── 2A and 2B together ──');
await t('a document in both is kept once, as 2B reports it', async () => {
  const out = await runJson([
    { name: '2B_112025.json', json: j2b([{ no: 'DEE/2025-26/196', txval: 1493300, igst: 268794 }]) },
    { name: '2A_112025.json', json: j2a([{ no: 'DEE/2025-26/196', txval: 1493300, iamt: 268794 }]) },
  ], [book({})]);
  assert(out.recs.length === 1, `the same document twice must collapse to one, got ${out.recs.length}`);
  assert(out.recs[0].src === '2B', `kept copy should be the 2B one, got ${out.recs[0].src}`);
  assert(out.merge.common === 1, `it should be counted as common, got ${out.merge.common}`);
  assert(!/2A only/.test(out.recs[0].remarks), 'a common document is not 2A-only: ' + out.recs[0].remarks);
});
await t('a document only in 2A is reconciled with the books and tagged', async () => {
  const out = await runJson([
    { name: '2B_112025.json', json: j2b([{ no: 'DEE/2025-26/196', txval: 1493300, igst: 268794 }]) },
    { name: '2A_112025.json', json: j2a([
      { no: 'DEE/2025-26/196', txval: 1493300, iamt: 268794 },
      { no: 'DEE/2025-26/214', txval: 200000, iamt: 36000, dt: '28-11-2025' }]) },
  ], [book({}),
      book({ voucherNo: 'DEE/2025-26/214', supplierInvNo: 'DEE/2025-26/214', ref: 'DEE/2025-26/214',
             date: '2025-11-28', taxable: 200000, igst: 36000 })]);
  const only = out.recs.find((r) => r.doc === 'DEE/2025-26/214');
  assert(out.merge.only2a === 1, `expected one 2A-only document, got ${out.merge.only2a}`);
  assert(only.src === '2A' && only.only2a, `it should carry its source, got ${only.src}`);
  assert(only.vch === 'DEE/2025-26/214',
    'a 2A-only document must still be matched against the books: ' + only.remarks);
  assert(/in 2A only/.test(only.remarks), 'the remark must say so: ' + only.remarks);
  assert(/16\(2\)\(aa\)/.test(only.note), 'the note should say why it is not claimable yet: ' + only.note);
});
await t('a 2A-only document missing from the books says both things', async () => {
  const out = await runJson([
    { name: '2A_112025.json', json: j2a([{ no: 'DEE/2025-26/214', txval: 200000, iamt: 36000 }]) },
  ], [book({})]);
  const r = out.recs.find((x) => x.doc === 'DEE/2025-26/214');
  assert(r.cat === 'only2b', `expected not-in-books, got ${r.cat}`);
  assert(/not booked/.test(r.remarks) && /in 2A only/.test(r.remarks),
    'both facts belong in the remark: ' + r.remarks);
});

console.log('\n── credit notes against the books ──');
await t('a credit note answered by a debit note reads as reversed', async () => {
  const out = await runJson(
    [{ name: '2B_122025.json', json: j2b([], [{ no: 'CN/25-26/9', txval: 50000, igst: 9000, val: 59000 }]) }],
    // In Tally the supplier's credit note is a DEBIT NOTE: it credits the input
    // tax ledger, so the tax reaches us negative.
    [book({ voucherNo: 'DN/12', voucherType: 'Debit Note', supplierInvNo: 'CN/25-26/9',
            ref: 'CN/25-26/9', date: '2025-12-20', taxable: -50000, igst: -9000 })]);
  assert(out.cn.length === 1, `the note should be in the credit-note set, got ${out.cn.length}`);
  assert(out.cn[0].cat === 'cnok', `expected reversed, got ${out.cn[0].cat} (${out.cn[0].remarks})`);
  assert(out.cn[0].vch === 'DN/12', `it should name the reversal voucher, got "${out.cn[0].vch}"`);
  assert(/Debit Note DN\/12/.test(out.cn[0].note),
    'the note should say what kind of voucher answered it: ' + out.cn[0].note);
});
await t('a credit note with no reversal is an ITC reversal due', async () => {
  const out = await runJson(
    [{ name: '2B_122025.json', json: j2b([], [{ no: 'CN/25-26/9', txval: 50000, igst: 9000 }]) }], []);
  assert(out.cn[0].cat === 'cnmiss', `expected not-reversed, got ${out.cn[0].cat}`);
  assert(/not reversed/.test(out.cn[0].remarks), 'the remark must say it: ' + out.cn[0].remarks);
  assert(/9,000\.00/.test(out.cn[0].note), 'the note should name the amount to reverse: ' + out.cn[0].note);
});
await t('a credit note does not eat the purchase it refers to', async () => {
  /* Suppliers often number the credit note after the invoice it relates to. If
     the note is allowed to match the original PURCHASE, the reconciliation
     reads "credit note reversed" and the reversal that is actually missing is
     never reported. */
  const out = await runJson(
    [{ name: '2B_122025.json', json: j2b(
        [{ no: 'DEE/2025-26/196', txval: 1493300, igst: 268794 }],
        [{ no: 'DEE/2025-26/196', txval: 50000, igst: 9000 }]) }],
    [book({})]);
  const inv = out.recs.find((r) => r.doc === 'DEE/2025-26/196');
  assert(inv.cat === 'matched', `the purchase keeps its voucher: got ${inv.cat} (${inv.remarks})`);
  assert(out.cn[0].cat === 'cnmiss',
    'the note must NOT claim the purchase as its reversal: ' + out.cn[0].remarks);
  assert(!out.cn[0].vch, `and it has no reversal voucher, got "${out.cn[0].vch}"`);
});
await t('a reversal in the books with no supplier note gets its own bucket', async () => {
  const out = await runJson(
    [{ name: '2B_122025.json', json: j2b([{ no: 'DEE/2025-26/196', txval: 1493300, igst: 268794 }]) }],
    [book({}), book({ voucherNo: 'DN/7', supplierInvNo: 'DN/7', ref: '', date: '2025-12-31',
                      taxable: -12000, igst: -2160 })]);
  const rev = out.recs.find((r) => r.cat === 'onlybkCN');
  assert(rev, 'expected a reversal-without-note record, got ' + out.recs.map((r) => r.cat).join(','));
  assert(/no supplier credit note/.test(rev.remarks), 'said plainly: ' + rev.remarks);
  assert(/Rule 37/.test(rev.note), 'and the usual innocent explanations given: ' + rev.note);
});

console.log('\n── the dialect GSTR-2B actually speaks ──');
await t('a 2B credit note keeps its number and reduces the credit', async () => {
  /* 2B names a note's fields ntnum / typ / dt; 2A and GSTR-1 use nt_num / ntty /
     nt_dt. Reading only the 2A names left every 2B credit note with a blank
     document number and — the type being unreadable — a POSITIVE sign, so a
     reversal looked like an extra invoice. Found by comparing a real CGST run
     against the same books reconciled by hand. */
  const out = await runJson([{ name: '2B_072025.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '072025',
      docdata: { cdnr: [{ ctin: '06ALSPB8304K1ZX', trdnm: 'Sachkhand Enterprises',
        nt: [{ ntnum: 'SE/CN/1', typ: 'C', dt: '01-07-2025', val: 24718, txval: 20947.5,
               cgst: 1885.28, sgst: 1885.28, itcavl: 'Y' }] }] } } } }],
    [book({ voucherNo: 'DN/4', voucherType: 'Debit Note', supplierInvNo: 'SE/CN/1', ref: '',
            date: '2025-07-01', party: 'Sachkhand Enterprises', gstin: '06ALSPB8304K1ZX',
            taxable: -20947.5, igst: 0, cgst: -1885.28, sgst: -1885.28 })]);
  assert(out.cn.length === 1, `expected one note, got ${out.cn.length}`);
  assert(out.cn[0].doc === 'SE/CN/1', `the note number must survive, got "${out.cn[0].doc}"`);
  assert(out.cn[0].gst2b < 0, `a credit note must reduce the credit, got ${out.cn[0].gst2b}`);
  assert(out.cn[0].cat === 'cnok', `and it should find its reversal: got ${out.cn[0].cat} (${out.cn[0].remarks})`);
});
await t('zero padding is not a different invoice number', async () => {
  // 2B document 005, books voucher 5 — 27 of these in the CGST run were
  // hand-labelled "booked - different invoice no." in the other tool.
  const r = await label(doc({ invNo: '005', party: 'Shree Ganesh Construction & Fabrication',
                              gstin: '06AABCS1429B1ZX', taxable: 4252170, igst: 765390.6 }),
                        book({ voucherNo: '5', supplierInvNo: '', ref: '',
                               party: 'Shree Ganesh Construction & Fabrication', gstin: '06AABCS1429B1ZX',
                               taxable: 4252170, igst: 765390.6 }));
  assert(r.cat === 'matched', `expected booked, got ${r.cat} (${r.remarks})`);
  assert(!/verify/.test(r.remarks), 'nothing needs verifying: ' + r.remarks);
});
await t('but padding alone still does not pair two suppliers', async () => {
  const r = await label(doc({ invNo: '005', party: 'Shree Ganesh Construction', gstin: '06AABCS1429B1ZX',
                              taxable: 4252170, igst: 765390.6 }),
                        book({ voucherNo: '5', supplierInvNo: '', ref: '',
                               party: 'PARAMOUNT INFRATECH', gstin: '07AAACP9999Q1ZZ',
                               taxable: 9100, igst: 1638 }));
  assert(r.cat === 'only2b', `a bare "5" is not evidence — expected unbooked, got ${r.cat} (${r.remarks})`);
});
await t('TDS deducted on the voucher is shown, not folded into the taxable', async () => {
  const r = await page.evaluate(() => {
    booksRows = [{ _ownGstin: '06AAGCE4293A1ZX', date: '2025-11-05', voucherNo: '80/YT-HR/25-26',
      supplierInvNo: '80/YT-HR/25-26', ref: '', party: 'YANKIT TECHNO FLOORING SYSTEMS',
      gstin: '06AAAFY1234C1ZL', taxable: 8175705.22, igst: 0, cgst: 735813.47, sgst: 735813.47,
      rcmIgst: 0, rcmCgst: 0, rcmSgst: 0, tds: 163514.10 }];
    twoBRows = [{ regn: '06AAGCE4293A1ZX', period: '112025', gstin: '06AAAFY1234C1ZL',
      party: 'YANKIT TECHNO FLOORING SYSTEMS', invNo: '80/YT-HR/25-26', invDate: '2025-11-05',
      invoiceValue: 9647332, taxable: 8175705.22, igst: 0, cgst: 735813.47, sgst: 735813.47,
      rcm: false, isCN: false, itcBlocked: false }];
    loadedFiles = [{ name: 'x.json', count: 1, rows: twoBRows, src: '2B' }];
    ['hIGST', 'hINTRA', 'hNIL'].forEach((id) => { const e = document.getElementById(id); if (e) e.checked = true; });
    reconcile();
    const x = report.recs[0];
    return { cat: x._cat, taxChk: x.taxChk, tdsBk: x.tdsBk };
  });
  assert(Math.abs(r.taxChk) < 0.01,
    `the taxable must tie once TDS is out of it, differs by ${r.taxChk}`);
  assert(Math.abs(r.tdsBk - 163514.10) < 0.01, `the TDS should be shown, got ${r.tdsBk}`);
  assert(r.cat === 'matched', `expected booked, got ${r.cat}`);
});

console.log('\n── an amendment restates a document, it does not add one ──');
await t('the original is not counted twice when a later 2B amends it', async () => {
  /* The real 172/2025-26: reported in the June 2B and restated in July's
     amendment table. Both sheets — ours and the portal's own tool — added both,
     so the year's CGST was ₹3,55,466.25 too high across four such documents,
     and the two agreed on a figure that was wrong in both. */
  const out = await runJson([
    { name: '2B_062025.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '062025', docdata: {
        b2b: [{ ctin: '37AEAFS6902D1Z8', trdnm: 'SS ASSOCIATES',
          inv: [{ inum: '172/2025-26', dt: '15-06-2025', val: 418782, txval: 354900,
                  cgst: 31941, sgst: 31941, itcavl: 'Y' }] }] } } } },
    { name: '2B_072025.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '072025', docdata: {
        b2ba: [{ ctin: '37AEAFS6902D1Z8', trdnm: 'SS ASSOCIATES',
          inv: [{ inum: '172/2025-26', oinum: '172/2025-26', dt: '15-06-2025', val: 418782,
                  txval: 354900, cgst: 31941, sgst: 31941, itcavl: 'Y' }] }] } } } },
  ], []);
  assert(out.merge.superseded === 1,
    `the original should be marked superseded, got ${out.merge.superseded}`);
  const live = out.recs.filter((r) => r.cat !== 'superseded');
  const dead = out.recs.filter((r) => r.cat === 'superseded');
  assert(live.length === 1 && dead.length === 1,
    `expected one live and one superseded, got ${live.length}/${dead.length}`);
  assert(/amended/.test(live[0].remarks), 'the live one is the amendment: ' + live[0].remarks);
  assert(/not counted/i.test(dead[0].note), 'and the original says it is not counted: ' + dead[0].note);
});
await t('an amendment that moves the invoice to another registration says so', async () => {
  /* The real SS Associates 23/2025-26 and 38/2025-26: reported against 06 in the
     April 2B, amended to 37 in the May 2B. Not a change of figures at all — the
     supplier had the wrong registration of the group's, and the books (which
     carried it under 37) were right. */
  const out = await runJson([
    { name: '2B_06_042025.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '042025', docdata: {
        b2b: [{ ctin: '37AEAFS6902D1Z8', trdnm: 'SS ASSOCIATES',
          inv: [{ inum: '23/2025-26', dt: '10-04-2025', val: 522120.5, txval: 442475,
                  cgst: 39822.75, sgst: 39822.75, itcavl: 'Y' }] }] } } } },
    { name: '2B_37_052025.json', json: { data: { gstin: '37AAGCE4293A1ZS', rtnprd: '052025', docdata: {
        b2ba: [{ ctin: '37AEAFS6902D1Z8', trdnm: 'SS ASSOCIATES',
          inv: [{ inum: '23/2025-26', oinum: '23/2025-26', dt: '10-04-2025', val: 522120.5,
                  txval: 442475, cgst: 39822.75, sgst: 39822.75, itcavl: 'Y' }] }] } } } },
  ], []);
  const dead = out.recs.find((r) => r.cat === 'superseded');
  assert(dead, 'the 06 original must be superseded: ' + out.recs.map((r) => r.cat).join(','));
  assert(/moved it to 37AAGCE4293A1ZS/.test(dead.remarks),
    'the remark must name where it went: ' + dead.remarks);
  assert(/credit belongs to 37AAGCE4293A1ZS/.test(dead.note) && /they are right/.test(dead.note),
    'and the note must say the books under 37 are right: ' + dead.note);
});
await t('a superseded original cannot take the voucher the live one needs', async () => {
  const out = await runJson([
    { name: '2B_062025.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '062025', docdata: {
        b2b: [{ ctin: '37AEAFS6902D1Z8', trdnm: 'SS ASSOCIATES',
          inv: [{ inum: '172/2025-26', dt: '15-06-2025', txval: 354900, cgst: 31941, sgst: 31941, itcavl: 'Y' }] }] } } } },
    { name: '2B_072025.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '072025', docdata: {
        b2ba: [{ ctin: '37AEAFS6902D1Z8', trdnm: 'SS ASSOCIATES',
          inv: [{ inum: '172/2025-26', oinum: '172/2025-26', dt: '15-06-2025', txval: 360000, cgst: 32400, sgst: 32400, itcavl: 'Y' }] }] } } } },
  ], [book({ _ownGstin: '06AAGCE4293A1ZX', date: '2025-06-15', voucherNo: '172/2025-26',
             supplierInvNo: '172/2025-26', ref: '', party: 'SS ASSOCIATES', gstin: '37AEAFS6902D1Z8',
             taxable: 360000, igst: 0, cgst: 32400, sgst: 32400 })]);
  const live = out.recs.find((r) => r.cat !== 'superseded');
  assert(live.vch === '172/2025-26', `the amendment gets the voucher, got "${live.vch}"`);
  assert(/booked/.test(live.remarks) && !/not booked/.test(live.remarks),
    'and it reconciles against the revised figures: ' + live.remarks);
});

console.log('\n── a total is only as complete as the files behind it ──');
await t('a March 2B is not the end of the year, and the report says so', async () => {
  await runJson([{ name: '2B_032026.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '032026',
      docdata: { b2b: [{ ctin: '07BICPL2786D1ZB', trdnm: 'DEEPALI ENGINEERING',
        inv: [{ inum: 'X/1', dt: '15-03-2026', txval: 100000, igst: 18000, itcavl: 'Y' }] }] } } } }], []);
  const html = await page.evaluate(() => spilloverWarning());
  assert(/April 2026/.test(html) && /May 2026/.test(html),
    'it must name the two returns that carry late-filed March invoices: ' + html.slice(0, 200));
  const sub = await page.evaluate(() => document.getElementById('repSub').textContent);
  assert(/Mar 2026/.test(sub), 'the periods loaded belong on the report: ' + sub);
});
await t('a month missing from the middle of the range is named', async () => {
  const mk = (p, dt, no) => ({ name: '2B_' + p + '.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: p,
    docdata: { b2b: [{ ctin: '07BICPL2786D1ZB', trdnm: 'DEEPALI ENGINEERING',
      inv: [{ inum: no, dt, txval: 100000, igst: 18000, itcavl: 'Y' }] }] } } } });
  await runJson([mk('042025', '10-04-2025', 'A/1'), mk('062025', '10-06-2025', 'A/3')], []);
  const html = await page.evaluate(() => periodGapWarning());
  assert(/May 2025/.test(html), 'May is missing and must be named: ' + html.slice(0, 200));
});
await t('no gap, no warning', async () => {
  const mk = (p, dt, no) => ({ name: '2B_' + p + '.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: p,
    docdata: { b2b: [{ ctin: '07BICPL2786D1ZB', trdnm: 'DEEPALI ENGINEERING',
      inv: [{ inum: no, dt, txval: 100000, igst: 18000, itcavl: 'Y' }] }] } } } });
  await runJson([mk('042025', '10-04-2025', 'A/1'), mk('052025', '10-05-2025', 'A/2')], []);
  const html = await page.evaluate(() => periodGapWarning());
  assert(html === '', 'nothing is missing, so nothing should be said: ' + html.slice(0, 120));
});

await t('one registration having every month says nothing about another', async () => {
  /* The real set: Haryana and Andhra had all twelve returns, Odisha had four.
     Pooled, every month looked covered and no gap was reported — while eight of
     Odisha's months were simply absent. */
  const mk = (gstin, p, dt, no) => ({ name: '2B_' + gstin.slice(0, 2) + '_' + p + '.json',
    json: { data: { gstin, rtnprd: p, docdata: { b2b: [{ ctin: '07BICPL2786D1ZB', trdnm: 'DEEPALI ENGINEERING',
      inv: [{ inum: no, dt, txval: 100000, igst: 18000, itcavl: 'Y' }] }] } } } });
  await runJson([
    mk('06AAGCE4293A1ZX', '042025', '10-04-2025', 'H/1'),
    mk('06AAGCE4293A1ZX', '052025', '10-05-2025', 'H/2'),
    mk('06AAGCE4293A1ZX', '062025', '10-06-2025', 'H/3'),
    mk('21AAGCE4293A1Z5', '042025', '10-04-2025', 'O/1'),
    mk('21AAGCE4293A1Z5', '062025', '10-06-2025', 'O/3'),   // May missing for Odisha only
  ], []);
  const pooled = await page.evaluate(() => periods2b().gaps);
  assert(pooled.length === 0, 'pooled, nothing looks missing — that is the trap');
  const html = await page.evaluate(() => periodGapWarning());
  assert(/21AAGCE4293A1Z5/.test(html), 'the warning must name the registration: ' + html.slice(0, 300));
  assert(/May 2025/.test(html), 'and the month it is missing: ' + html.slice(0, 300));
  assert(!/06AAGCE4293A1ZX/.test(html), 'and must not accuse the complete one: ' + html.slice(0, 300));
});

console.log('\n── a file that does not add up to its own stated total ──');
await t('a 2B file is checked against the itcsumm inside it', async () => {
  const j = { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '042025',
    itcsumm: { itcavl: { nonrevsup: { b2b: { txval: 100000, igst: 18000, cgst: 0, sgst: 0, cess: 0 } } } },
    docdata: { b2b: [{ ctin: '07BICPL2786D1ZB', trdnm: 'DEEPALI ENGINEERING',
      inv: [{ inum: 'X/1', dt: '10-04-2025', txval: 100000, igst: 18000, itcavl: 'Y' }] }] } } };
  const ok = await page.evaluate((j_) => fileCheck(j_, parseGstJson(j_, '2B', 'x.json')), j);
  assert(ok.state === 'ok', `it ties, so expected ok, got ${ok.state} (${JSON.stringify(ok.d)})`);
  // now hide half the return from the documents but leave the stated total alone
  const j2 = JSON.parse(JSON.stringify(j));
  j2.data.itcsumm.itcavl.nonrevsup.b2b.igst = 36000;
  const off = await page.evaluate((j_) => fileCheck(j_, parseGstJson(j_, '2B', 'x.json')), j2);
  assert(off.state === 'off' && Math.abs(off.worst + 18000) < 0.01,
    `a file that does not add up must say so, got ${off.state} ${JSON.stringify(off.d)}`);
});
await t('an amendment line is a differential and is left out of the check', async () => {
  /* June 2025, for real: the supplier cut three invoices from ₹2,86,644.96 of
     CGST to ₹66,990.52, and itcsumm's b2ba line reads negative. Comparing gross
     documents against a differential would fail every amended return. */
  const j = { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '062025',
    itcsumm: { itcavl: { nonrevsup: { b2b: { cgst: 540462.92, igst: 0, sgst: 540462.92, cess: 0 },
                                      b2ba: { cgst: -220654.44, igst: 0, sgst: -220654.44, cess: 0 } } } },
    docdata: {
      b2b: [{ ctin: '06EOMPK3595A1ZU', trdnm: 'M/S KAUSHIK ENTERPRISES',
        inv: [{ inum: '127', dt: '10-06-2025', txval: 6005143.55, cgst: 540462.92, sgst: 540462.92, itcavl: 'Y' }] }],
      b2ba: [{ ctin: '06EOMPK3595A1ZU', trdnm: 'M/S KAUSHIK ENTERPRISES',
        inv: [{ inum: '30/05/2025', oinum: '125', dt: '30-05-2025', txval: 733220,
                cgst: 65989.80, sgst: 65989.80, itcavl: 'Y' }] }] } } };
  const c = await page.evaluate((j_) => fileCheck(j_, parseGstJson(j_, '2B', 'x.json')), j);
  assert(c.state === 'ok', `the non-amendment documents tie; expected ok, got ${c.state} ${JSON.stringify(c.d)}`);
});
await t('an amendment that renumbers the document still supersedes the original', async () => {
  // 110 -> "26/05/2025" at ₹4, 121 -> "29/05/2025" at ₹4, 125 -> "30/05/2025"
  const out = await runJson([
    { name: '2B_052025.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '052025', docdata: {
        b2b: [{ ctin: '06EOMPK3595A1ZU', trdnm: 'M/S KAUSHIK ENTERPRISES',
          inv: [{ inum: '125', dt: '30-05-2025', txval: 1056440, cgst: 95079.60, sgst: 95079.60, itcavl: 'Y' }] }] } } } },
    { name: '2B_062025.json', json: { data: { gstin: '06AAGCE4293A1ZX', rtnprd: '062025', docdata: {
        b2ba: [{ ctin: '06EOMPK3595A1ZU', trdnm: 'M/S KAUSHIK ENTERPRISES',
          inv: [{ inum: '30/05/2025', oinum: '125', dt: '30-05-2025', txval: 733220,
                  cgst: 65989.80, sgst: 65989.80, itcavl: 'Y' }] }] } } } },
  ], []);
  const dead = out.recs.find((r) => r.cat === 'superseded');
  assert(dead && dead.doc === '125',
    'the original 125 must be superseded by the renumbered amendment: '
      + out.recs.map((r) => r.doc + ':' + r.cat).join(', '));
  const live = out.recs.find((r) => r.cat !== 'superseded');
  assert(Math.abs(live.gst2b - 131979.6) < 0.01,
    `and only the amended value counts, got ${live.gst2b}`);
});

console.log('\n── the Excel layout ──');
await t('every formula in the export points at the column it means', async () => {
  /* The live formulas address columns by letter. Inserting "Source" shifted
     eleven of them, and a wrong letter silently computes a check against the
     wrong figure — so the mapping is asserted, not eyeballed. */
  const hdr = await page.evaluate(() => RECO_HDR);
  const at = (n) => hdr[n - 1];
  const want = { 7: 'Taxable (2B)', 11: 'GST (2B)', 14: 'Source', 15: 'GSTIN check',
    17: 'taxable check', 18: 'GST check', 20: 'spillover (mth)', 21: 'remarks',
    22: 'Regn (books)', 23: 'GSTIN (books)', 27: 'IGST (books)', 29: 'SGST (books)',
    30: 'GST as per Books', 31: 'Taxable (books)', 32: 'TDS (books)' };
  Object.keys(want).forEach((n) => assert(at(+n) === want[n],
    `column ${n} should be "${want[n]}", it is "${at(+n)}"`));
  const amt = await page.evaluate(() => AMT_COLS);
  amt.forEach((ci) => assert(/Value|Taxable|IGST|CGST|SGST|GST|TDS|check/.test(at(ci)),
    `column ${ci} ("${at(ci)}") is number-formatted but is not an amount`));
});

/* Build the workbook the download button builds, and read it back. */
const xlsxOut = () => page.evaluate(() => new Promise((res, rej) => {
  const orig = window.dl;
  window.__blob = null;
  window.dl = function (name, blob) { window.__blob = blob; };
  try { exportXlsx(); } catch (e) { window.dl = orig; return rej(e.message); }
  const t0 = Date.now();
  (function wait() {
    if (window.__blob) {
      window.dl = orig;
      const fr = new FileReader();
      fr.onload = function () {
        const wb = new ExcelJS.Workbook();
        wb.xlsx.load(fr.result).then(function (w) {
          const ws = w.getWorksheet('reconciled');
          res({ sheets: w.worksheets.map((s) => s.name),
                hdr: ws.getRow(1).values.slice(1),
                rows: ws.rowCount - 1,
                formulas: [2, 3, 4, 5].map((n) => (ws.getRow(n).getCell(21).formula || '')) });
        }, function (e) { rej(String(e)); });
      };
      fr.readAsArrayBuffer(window.__blob);
      return;
    }
    if (Date.now() - t0 > 15000) { window.dl = orig; return rej('no workbook was produced'); }
    setTimeout(wait, 50);
  })();
}));

await t('the workbook builds, with a sheet for the 2A-only documents', async () => {
  await runJson([
    { name: '2B_112025.json', json: j2b(
        [{ no: 'DEE/2025-26/196', txval: 1493300, igst: 268794 }],
        [{ no: 'CN/25-26/9', txval: 50000, igst: 9000 }]) },
    { name: '2A_112025.json', json: j2a([
        { no: 'DEE/2025-26/196', txval: 1493300, iamt: 268794 },
        { no: 'DEE/2025-26/214', txval: 200000, iamt: 36000, dt: '28-11-2025' }]) },
  ], [book({})]);
  const x = await xlsxOut();
  assert(x.sheets.join(',') === 'reconciled,Credit Notes,2A only',
    'expected three sheets, got ' + x.sheets.join(','));
  assert(x.hdr[13] === 'Source', `column N should be Source, it is "${x.hdr[13]}"`);
  assert(x.hdr.length === 33, `expected 33 columns, got ${x.hdr.length}`);
  // the matched row carries the live remark formula; it must address R/Q/A/V
  const f = x.formulas.find((s) => /booked/.test(s)) || '';
  assert(/ABS\(R\d+\)/.test(f) && /ABS\(Q\d+\)/.test(f) && /TRIM\(V\d+\)/.test(f),
    'the remark formula must follow the shifted columns: ' + f);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (errs.length) { console.log('\nBROWSER ERRORS:'); errs.slice(0, 5).forEach((e) => console.log('  ' + e)); }
await browser.close(); srv.close();
process.exit(fail || errs.length ? 1 : 0);
