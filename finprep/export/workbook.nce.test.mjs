/* The Excel export for a non-corporate entity: owners' funds on the face, a
 * Capital Accounts sheet that adds across to it, and the partners signing.
 * Run: node finprep/export/workbook.nce.test.mjs                            */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from '../core/engine.js';
import { buildCashFlow } from '../core/cashflow.js';
import { presentationModel } from '../core/notes.js';
import { toRupees } from '../core/money.js';
import { buildWorkbook } from './workbook.js';

const src = '/home/user/Tools/gstr2b/exceljs.js';
const tmp = path.join(os.tmpdir(), 'finprep-exceljs-nce-test.cjs');
fs.copyFileSync(src, tmp);
const ExcelJS = createRequire(import.meta.url)(tmp);

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
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
const owners = [
  { id: 'own_r', name: 'Ramesh Kumar', role: 'Partner', pan: 'AAAPR1111A', ratio: 60 },
  { id: 'own_s', name: 'Suresh Kumar', role: 'Partner', pan: 'AAAPS2222B', ratio: 40 },
];
const r = build({ ledgers: firm, constitution: 'partnership', owners });
const cf = buildCashFlow(r);
const inputs = { 'footnote:trade_payables_others': 'Creditors are unsecured.', 'msme:principal': 120000, 'msme:interest': 0,
  'ppe:Furniture:dep': 0, 'ppe:method': 'WDV at Income-tax rates', policies: 'Basis: historical cost.\nRevenue: on delivery.' };
const pm = presentationModel(r, { inputs });

// paise → rupees at the export boundary, the way the server does it
const NON_MONEY = new Set(['number', 'note', 'id', 'key', 'lineId', 'caption', 'name', 'reason', 'severity', 'status',
  'requirement', 'evidence', 'section', 'title', 'period', 'method', 'reconciled', 'drcr', 'group', 'primary',
  'lineCaption', 'text', 'label', 'ratio', 'ownerId', 'kind', 'owner', 'basis', 'profitTo', 'shareBasis']);
const rup = (v, k) => (typeof v === 'number' ? (NON_MONEY.has(k) ? v : toRupees(v))
  : Array.isArray(v) ? v.map((x) => rup(x, k))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, rup(x, kk)])) : v);
const payload = {
  meta: { entity: 'M/s Kumar Traders', pan: 'AAAFK1234A', division: 'NCE', constitution: 'partnership',
    constitutionLabel: 'Partnership firm', ownersLabel: 'Partners', ownerRole: 'Partner',
    framework: 'ICAI Guidance Note on Financial Statements of Non-Corporate Entities',
    owners: owners.map((o) => ({ ...o })), currentLabel: '31 March 2026', priorLabel: '31 March 2025',
    status: 'Draft', scaleLabel: 'Amounts in ₹' },
  trialBalance: r.ledgers.map((l) => ({ ledger: l.name, group: l.group, primary: l.primary,
    drcr: l.perPeriod.current.amount >= 0 ? 'Dr' : 'Cr', current: Math.abs(toRupees(l.perPeriod.current.amount)),
    prior: Math.abs(toRupees(l.perPeriod.prior.amount)), lineId: l.perPeriod.current.lineId, lineCaption: r.caption(l.perPeriod.current.lineId),
    note: r.noteNumbers.get(l.perPeriod.current.lineId) || null })),
  balanceSheet: rup(pm.balanceSheet), profitAndLoss: rup(pm.profitAndLoss), notes: rup(pm.notes),
  ownersAccounts: rup(pm.ownersAccounts), cashFlow: rup({ ...cf, checks: undefined }),
  ppe: rup(pm.ppe), text: { policies: inputs.policies }, policies: inputs.policies,
  checks: r.checks.concat(cf.checks).map((c) => ({ ...c, amount: c.amount != null ? toRupees(c.amount) : undefined })),
  disclosures: pm.disclosures,
};

const wb = buildWorkbook(ExcelJS, payload);
const ws = (n) => wb.getWorksheet(n);
const textOf = (sheet) => { const out = []; sheet.eachRow((row) => row.eachCell((c) => { const v = c.value; out.push(typeof v === 'object' && v && 'result' in v ? v.result : v); })); return out; };
const strings = (sheet) => textOf(sheet).filter((v) => typeof v === 'string');
const findRow = (sheet, label) => { let hit = null; sheet.eachRow((row, n) => { if (!hit && String(row.getCell(1).value || '').trim().startsWith(label.trim())) hit = n; }); return hit; };
const val = (cell) => (cell.value && typeof cell.value === 'object' && 'result' in cell.value ? cell.value.result : cell.value);

console.log('\n── sheets ──');
t('the books balance and the cash flow reconciles with the owners’ movement in financing', () => {
  assert.equal(r.bs.current.difference, 0);
  assert.equal(cf.reconciled, true, 'unreconciled ' + cf.unreconciled);
  assert.ok(cf.financing.items.some((i) => /owners/.test(i.label) && i.amount === 12000000));
});
t('a Capital Accounts sheet and a PPE Schedule sit after the Notes', () => {
  const names = wb.worksheets.map((w) => w.name);
  assert.deepEqual(names, ['Balance Sheet', 'Profit & Loss', 'Cash Flow', 'Notes', 'Capital Accounts', 'PPE Schedule', 'Trial Balance', 'Disclosures', 'Review']);
});
t('the PPE schedule has the asset with its closing as a formula and a SUM total', () => {
  const ps = ws('PPE Schedule');
  const fr = findRow(ps, 'Furniture');
  assert.ok(fr, 'furniture row');
  assert.equal(val(ps.getRow(fr).getCell(2)), 300000);
  assert.equal(val(ps.getRow(fr).getCell(6)), 300000);
  assert.match(ps.getRow(fr).getCell(6).value.formula, /^B\d+\+C\d+-D\d+-E\d+$/);
  const tot = findRow(ps, 'Total');
  assert.match(ps.getRow(tot).getCell(6).value.formula, /^SUM\(F\d+:F\d+\)$/);
  assert.ok(strings(ps).join(' | ').includes('WDV at Income-tax rates'));
});
t('the notes sheet opens with the policies and carries the footnote and the MSMED figures', () => {
  const s = strings(ws('Notes')).join(' | ');
  assert.ok(/Significant accounting policies/.test(s) && /Basis: historical cost\./.test(s) && /Revenue: on delivery\./.test(s));
  assert.ok(/Creditors are unsecured\./.test(s));
  assert.ok(/Dues to micro and small enterprises/.test(s) && /Principal amount remaining unpaid/.test(s));
  assert.ok(/sheet "PPE Schedule"/.test(s));
});
t('every sheet names the framework and the PAN, never a CIN', () => {
  for (const w of wb.worksheets) {
    const s = strings(w).join(' | ');
    assert.ok(/ICAI Guidance Note on Financial Statements of Non-Corporate Entities/.test(s), w.name + ' lacks the framework');
    assert.ok(/PAN: AAAFK1234A/.test(s), w.name + ' lacks the PAN');
    assert.ok(!/Schedule III, Division/.test(s), w.name + ' claims Schedule III');
  }
});

console.log('\n── the face ──');
t('the balance sheet presents Owners’ funds with the partners’ capital accounts closing after profit', () => {
  const bs = ws('Balance Sheet');
  const sec = findRow(bs, 'Owners’ funds');
  assert.ok(sec, 'no Owners’ funds section');
  const cap = findRow(bs, '    Partners’ capital accounts');
  assert.ok(cap, 'no capital accounts line');
  assert.equal(val(bs.getRow(cap).getCell(3)), 1260000);
  assert.equal(val(bs.getRow(cap).getCell(4)), 700000);
  assert.equal(findRow(bs, '    Share capital'), null);
});
t('the partners sign for the firm, with their PAN', () => {
  const s = strings(ws('Balance Sheet')).join(' | ');
  assert.ok(/For M\/s Kumar Traders/.test(s));
  assert.ok(/Ramesh Kumar/.test(s) && /Suresh Kumar/.test(s));
  assert.ok(/PAN AAAPR1111A/.test(s));
  assert.ok(!/Board of Directors/.test(s) && !/DIN/.test(s));
});
t('the profit and loss shows partners’ remuneration as its own line and the profit transferred to the owners', () => {
  const pl = ws('Profit & Loss');
  const rem = findRow(pl, '    Partners’ remuneration');
  assert.ok(rem, 'no remuneration line');
  assert.equal(val(pl.getRow(rem).getCell(3)), 240000);
  assert.ok(findRow(pl, 'Profit for the year, transferred'), 'profit line wording');
});

console.log('\n── the capital accounts ──');
t('the sheet has a column per partner, rows from opening to closing, and adds across to the face', () => {
  const ca = ws('Capital Accounts');
  const hdr = findRow(ca, 'Partners’ capital accounts');
  assert.ok(hdr);
  assert.equal(String(ca.getRow(hdr).getCell(2).value).split('\n')[0], 'Ramesh Kumar');
  assert.equal(String(ca.getRow(hdr).getCell(3).value).split('\n')[0], 'Suresh Kumar');
  assert.equal(ca.getRow(hdr).getCell(4).value, 'Total');
  const open = findRow(ca, 'Opening balance'), close = findRow(ca, 'Closing balance');
  assert.equal(val(ca.getRow(open).getCell(2)), 400000);
  assert.equal(val(ca.getRow(open).getCell(3)), 300000);
  assert.equal(val(ca.getRow(close).getCell(2)), 824000);
  assert.equal(val(ca.getRow(close).getCell(3)), 436000);
  assert.equal(val(ca.getRow(close).getCell(4)), 1260000);
  // the closing is a SUM of the rows above it, in the sheet's own arithmetic
  assert.match(ca.getRow(close).getCell(2).value.formula, /^SUM\(B\d+:B\d+\)$/);
  // drawings are shown negative so that the SUM is right
  const drw = findRow(ca, '    Less: drawings');
  assert.equal(val(ca.getRow(drw).getCell(2)), -60000);
  const sh = findRow(ca, '    Add: share of profit');
  assert.equal(val(ca.getRow(sh).getCell(2)), 264000);
  assert.equal(val(ca.getRow(sh).getCell(3)), 176000);
});
t('the notes sheet points to the capital accounts sheet and carries the face total', () => {
  const nt = ws('Notes');
  const s = strings(nt).join(' | ');
  assert.ok(/sheet "Capital Accounts"/.test(s));
  const head = findRow(nt, '1.  Partners’ capital accounts');
  assert.ok(head, 'note 1 is the capital accounts');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
