/* The PDF export: built from the engine's own model, every page produced, the
 * text it must carry present, nothing thrown on characters the font lacks.
 * Run: node finprep/export/pdf.test.mjs                                     */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../core/engine.js';
import { buildCashFlow } from '../core/cashflow.js';
import { presentationModel } from '../core/notes.js';
import { toRupees } from '../core/money.js';
import { buildPdf, inr, wrap } from './pdf.js';

const tmp = path.join(os.tmpdir(), 'finprep-pdflib-test.cjs');
fs.copyFileSync('/home/user/Tools/pdftools/pdf-lib.min.js', tmp);
const PDFLib = createRequire(import.meta.url)(tmp);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
const L = (name, p, cur, pri, extra = {}) => ({ name, group: p[0], primary: p[p.length - 1], groupPath: p, current: cur, prior: pri, ...extra });
const firm = [
  L('Ramesh Capital A/c', ['Capital Account'], -560000, -400000, { drTotal: 60000, crTotal: 220000 }),
  L('Suresh Capital A/c', ['Capital Account'], -260000, -300000, { drTotal: 40000, crTotal: 0 }),
  L('Remuneration - Ramesh', ['Indirect Expenses'], 120000, 0, { isRevenue: true }),
  L('Remuneration - Suresh', ['Indirect Expenses'], 120000, 0, { isRevenue: true }),
  L('Sales', ['Sales Accounts'], -1500000, 0, { isRevenue: true }),
  L('Purchases', ['Purchase Accounts'], 700000, 0, { isRevenue: true }),
  L('Shop Rent', ['Indirect Expenses'], 120000, 0, { isRevenue: true }),
  L('HDFC Bank', ['Bank Accounts'], 1060000, 500000),
  L('Sundry Creditors X', ['Sundry Creditors'], -100000, -100000),
  L('Furniture', ['Fixed Assets'], 300000, 300000),
];
const owners = [{ id: 'own_r', name: 'Ramesh Kumar', role: 'Partner', pan: 'AAAPR1111A', ratio: 60 }, { id: 'own_s', name: 'Suresh Kumar', role: 'Partner', pan: 'AAAPS2222B', ratio: 40 }];
const r = build({ ledgers: firm, constitution: 'partnership', owners });
const cf = buildCashFlow(r);
const pm = presentationModel(r);
const NON_MONEY = new Set(['number', 'note', 'id', 'key', 'lineId', 'caption', 'name', 'reason', 'severity', 'status', 'requirement', 'evidence', 'section', 'title', 'period', 'method', 'reconciled', 'drcr', 'group', 'primary', 'lineCaption', 'text', 'label', 'ratio', 'ownerId', 'kind', 'owner', 'basis', 'profitTo', 'shareBasis']);
const rup = (v, k) => (typeof v === 'number' ? (NON_MONEY.has(k) ? v : toRupees(v)) : Array.isArray(v) ? v.map((x) => rup(x, k)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, rup(x, kk)])) : v);
const payload = {
  meta: { entity: 'M/s Kumar Traders', pan: 'AAAFK1234A', division: 'NCE', constitution: 'partnership', constitutionLabel: 'Partnership firm',
    ownersLabel: 'Partners', ownerRole: 'Partner', framework: 'ICAI Guidance Note on Financial Statements of Non-Corporate Entities',
    owners, currentLabel: '31 March 2026', priorLabel: '31 March 2025', status: 'Draft', scaleLabel: 'Amounts in ₹' },
  balanceSheet: rup(pm.balanceSheet), profitAndLoss: rup(pm.profitAndLoss), notes: rup(pm.notes), ownersAccounts: rup(pm.ownersAccounts),
  checks: r.checks.concat(cf.checks), policies: 'Basis of preparation: the financial statements are prepared under the historical cost convention on the accrual basis.\nRevenue: recognised on transfer of goods.',
};

/* text drawn with a standard font lands in the (flate-compressed) page content
   streams as hex strings; inflate every page's stream and decode them */
async function drawnText(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes);
  const out = [];
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const refs = contents instanceof PDFLib.PDFArray ? contents.asArray() : [contents];
    for (const ref of refs) {
      const stream = doc.context.lookup(ref);
      const raw = PDFLib.decodePDFRawStream(stream).decode();
      const s = Buffer.from(raw).toString('latin1');
      for (const m of s.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(m[1], 'hex').toString('latin1'));
    }
  }
  return out.join('\n');
}

console.log('\n── formatting ──');
await t('amounts are grouped the Indian way, negatives in brackets, nil as a dash', async () => {
  assert.equal(inr(1260000), '12,60,000.00'); assert.equal(inr(-5000.5), '(5,000.50)'); assert.equal(inr(0), '-'); assert.equal(inr(999), '999.00'); assert.equal(inr(123456789.1), '12,34,56,789.10');
});
await t('wrap breaks on words and never loses one', async () => {
  const fake = { widthOfTextAtSize: (t, s) => t.length * s * 0.5 };
  const lines = wrap(fake, 'one two three four five six seven', 10, 60);
  assert.equal(lines.join(' '), 'one two three four five six seven');
  assert.ok(lines.length >= 3);
});

console.log('\n── the document ──');
let bytes;
await t('the PDF is produced with a page for each statement, the owners’ accounts and the notes', async () => {
  bytes = await buildPdf(PDFLib, payload);
  assert.ok(bytes.length > 5000);
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 4, 'pages: ' + doc.getPageCount());
  assert.match(doc.getTitle(), /Kumar Traders/);
});
await t('the faces, the partners’ accounts, the signatures and the policies are on the pages', async () => {
  const text = await drawnText(bytes);
  for (const must of ['Balance sheet as at 31 March 2026', 'Statement of profit and loss', "Partners' capital accounts", 'Ramesh Kumar', 'Suresh Kumar',
    '12,60,000.00', '2,64,000.00', '1,76,000.00', 'PAN AAAPR1111A', 'For M/s Kumar Traders', 'Significant accounting policies', 'historical cost', 'Page 1 of']) {
    assert.ok(text.includes(must), 'missing: ' + must);
  }
  assert.ok(!text.includes('Board of Directors'));
  assert.ok(!text.includes('CIN'));
});
await t('a draft with a critical exception is watermarked; a clean one is not', async () => {
  const dirty = await buildPdf(PDFLib, { ...payload, checks: [{ id: 'X', severity: 'CRITICAL', message: 'x' }] });
  assert.ok((await drawnText(dirty)).includes('DRAFT - NOT FOR ISSUE'));
  assert.ok(!(await drawnText(bytes)).includes('DRAFT - NOT FOR ISSUE'));
});
await t('a character the font cannot draw does not stop the export', async () => {
  const odd = await buildPdf(PDFLib, { ...payload, meta: { ...payload.meta, entity: 'कुमार Traders ₹' } });
  assert.ok(odd.length > 5000);
  assert.ok((await drawnText(odd)).includes('Traders'));
});
await t('a company payload signs with directors and shows a CIN', async () => {
  const co = await buildPdf(PDFLib, { ...payload, ownersAccounts: null, meta: { ...payload.meta, division: 'AS', cin: 'U74999DL2019PTC000001', pan: '', framework: '', owners: [], directors: [{ name: 'A Director', din: '01234567' }] } });
  const text = await drawnText(co);
  assert.ok(text.includes('Board of Directors') && text.includes('CIN: U74999DL2019PTC000001') && text.includes('DIN 01234567'));
  assert.ok(text.includes('Schedule III, Division I'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
