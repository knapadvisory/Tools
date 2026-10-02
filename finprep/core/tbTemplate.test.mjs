/* The Excel trial-balance template: built, filled, read back, and refused when wrong.
 * Run: node finprep/core/tbTemplate.test.mjs                                */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTemplate, parseTemplateRows, readTemplate, mapColumns, COLUMNS } from './tbTemplate.js';
import { linesFor, captionFor } from './schedule3.js';
import { build } from './engine.js';

const src = '/home/user/Tools/gstr2b/exceljs.js';
const tmp = path.join(os.tmpdir(), 'finprep-exceljs-tb-test.cjs');
fs.copyFileSync(src, tmp);
const ExcelJS = createRequire(import.meta.url)(tmp);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
const heads = linesFor('NCE').map((l) => ({ lineId: l.id, caption: captionFor(l.id, 'NCE', 'partnership'), sectionTitle: l.section }));
const H = COLUMNS.map((c) => c.head);
const R = (name, group, primary, oDr, oCr, mDr, mCr, cDr, cCr, head = '', gstin = '') => [name, group, primary, oDr, oCr, mDr, mCr, cDr, cCr, head, gstin];

console.log('\n── the template ──');
await t('the template has the sheets, the headings, a Heads list and drop-downs', async () => {
  const wb = buildTemplate(ExcelJS, { heads, entity: 'M/s Kumar Traders', fyEnd: '31 March 2026' });
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Trial Balance', 'Heads', 'Groups', 'How to fill']);
  const ws = wb.getWorksheet('Trial Balance');
  assert.deepEqual(ws.getRow(1).values.slice(1), H);
  assert.equal(wb.getWorksheet('Heads').getRow(2).getCell(1).value, 'Partners’ capital accounts');
  assert.equal(ws.getRow(2).getCell(10).dataValidation.type, 'list');
});

console.log('\n── reading a filled sheet ──');
const good = [H,
  R('Ramesh Capital A/c', 'Capital Account', '', 0, 400000, 60000, 220000, 0, 560000),
  R('Suresh Capital A/c', 'Capital Account', '', 0, 300000, 40000, 0, 0, 260000, 'Partners’ capital accounts'),
  R('Remuneration - Ramesh', 'Indirect Expenses', '', 0, 0, 120000, 0, 120000, 0, 'partners_remuneration'),
  R('Sales', 'Sales Accounts', '', 0, 0, 0, 0, 0, 1500000),
  R('Purchases', 'Purchase Accounts', '', 0, 0, 0, 0, 700000, 0),
  R('Shop Rent', 'Indirect Expenses', '', 0, 0, 0, 0, 120000, 0),
  R('HDFC Bank', 'Bank Accounts', '', 500000, 0, 0, 0, 1180000, 0),
  R('Sundry Creditors X', 'Sundry Creditors', 'Current Liabilities', 0, 100000, 0, 0, 0, 100000, '', '27AAAPX1234A1Z5'),
  R('Furniture', 'Fixed Assets', '', 300000, 0, 0, 0, 300000, 0),
  [], ['Total', '', '', 800000, 800000, '', '', 2420000, 2420000],
];
await t('a balanced sheet reads into ledgers with signs, groups, movements and heads', async () => {
  const res = parseTemplateRows(good, { heads });
  assert.deepEqual(res.errors, []);
  assert.equal(res.ledgers.length, 9);
  const ramesh = res.ledgers.find((l) => l.name === 'Ramesh Capital A/c');
  assert.equal(ramesh.current, -560000); assert.equal(ramesh.prior, -400000);
  assert.equal(ramesh.drTotal, 60000); assert.equal(ramesh.crTotal, 220000);
  assert.equal(ramesh.primary, 'Capital Account');
  const bank = res.ledgers.find((l) => l.name === 'HDFC Bank');
  assert.equal(bank.primary, 'Current Assets'); assert.deepEqual(bank.groupPath, ['Bank Accounts', 'Current Assets']);
  assert.equal(bank.drTotal, undefined, 'no movement given → none recorded');
  assert.equal(res.ledgers.find((l) => l.name === 'Sales').isRevenue, true);
  assert.equal(res.ledgers.find((l) => l.name === 'Furniture').isRevenue, false);
  assert.equal(res.ledgers.find((l) => l.name === 'Sundry Creditors X').gstin, '27AAAPX1234A1Z5');
  // heads by caption and by id
  assert.deepEqual(res.mappings.map((m) => [m.ledgerKey, m.lineId]),
    [['Suresh Capital A/c', 'owners_capital'], ['Remuneration - Ramesh', 'partners_remuneration']]);
  assert.equal(res.totals.closeDr, 2420000);
  assert.ok(res.warnings.some((w) => /total row/.test(w)));
});
await t('the parsed ledgers build a tied balance sheet for the firm', async () => {
  const res = parseTemplateRows(good, { heads });
  const r = build({ ledgers: res.ledgers, constitution: 'partnership',
    owners: [{ name: 'Ramesh Kumar', ratio: 1 }, { name: 'Suresh Kumar', ratio: 1 }] });
  assert.equal(r.bs.current.difference, 0);
  assert.equal(r.pl.current.pat, 56000000);          // 15,00,000 − 7,00,000 − 1,20,000 − 1,20,000 = 5,60,000
  assert.ok(!r.checks.some((c) => c.id === 'TB-prior'));
});
await t('columns are recognised by heading, in any order, with extra columns ignored', async () => {
  const rows = [['Sr', 'Closing Cr', 'Ledger', 'Under', 'Closing Dr', 'Remarks'],
    [1, 1000, 'Capital', 'Capital Account', 0, 'x'], [2, 0, 'Cash', 'Cash in Hand', 1000, 'y']];
  const res = parseTemplateRows(rows, { heads });
  assert.deepEqual(res.errors, []);
  assert.equal(res.ledgers[0].current, -1000);
  assert.equal(res.ledgers[1].group, 'Cash in Hand');
});
await t('a title row above the headings is skipped', async () => {
  const rows = [['M/s Kumar Traders — trial balance'], [], H, R('Capital', 'Capital Account', '', 0, 0, 0, 0, 0, 1000), R('Cash', 'Cash in Hand', '', 0, 0, 0, 0, 1000, 0)];
  assert.deepEqual(parseTemplateRows(rows, { heads }).errors, []);
});

console.log('\n── what is refused ──');
const bad = (rows) => parseTemplateRows([H, ...rows], { heads }).errors;
await t('duplicate ledger names', async () => {
  const e = bad([R('Cash', 'Cash in Hand', '', 0, 0, 0, 0, 500, 0), R('cash ', 'Cash in Hand', '', 0, 0, 0, 0, 500, 0), R('Capital', 'Capital Account', '', 0, 0, 0, 0, 0, 1000)]);
  assert.ok(e.some((x) => /already on row/.test(x)), e.join(' | '));
});
await t('a blank group, or a number for a group', async () => {
  assert.ok(bad([R('Cash', '', '', 0, 0, 0, 0, 0, 0)]).some((x) => /no group/.test(x)));
  assert.ok(bad([R('Cash', '12', '', 0, 0, 0, 0, 0, 0)]).some((x) => /is a number/.test(x)));
});
await t('closing debits that do not equal closing credits', async () => {
  const e = bad([R('Cash', 'Cash in Hand', '', 0, 0, 0, 0, 1000, 0), R('Capital', 'Capital Account', '', 0, 0, 0, 0, 0, 900)]);
  assert.ok(e.some((x) => /closing balances do not balance.*100\.00/.test(x)), e.join(' | '));
});
await t('both sides on one row, a negative amount, a non-number', async () => {
  assert.ok(bad([R('Cash', 'Cash in Hand', '', 0, 0, 0, 0, 10, 10)]).some((x) => /both a closing debit and a closing credit/.test(x)));
  assert.ok(bad([R('Cash', 'Cash in Hand', '', 0, 0, 0, 0, -10, 0)]).some((x) => /negative/.test(x)));
  assert.ok(bad([R('Cash', 'Cash in Hand', '', 0, 0, 0, 0, 'ten', 0)]).some((x) => /not a number/.test(x)));
});
await t('a head the chart does not know', async () => {
  const e = bad([R('Cash', 'Cash in Hand', '', 0, 0, 0, 0, 10, 0, 'Petty things'), R('Capital', 'Capital Account', '', 0, 0, 0, 0, 0, 10)]);
  assert.ok(e.some((x) => /not one the tool knows/.test(x)));
});
await t('a sheet without the heading row', async () => {
  const res = parseTemplateRows([['a', 'b'], [1, 2]], { heads });
  assert.ok(res.errors[0].startsWith('The heading row was not found'));
});
await t('a movement that does not explain the change of balance is warned about, not refused', async () => {
  const res = parseTemplateRows([H, R('Capital', 'Capital Account', '', 0, 100, 0, 50, 0, 100), R('Cash', 'Cash in Hand', '', 100, 0, 0, 0, 100, 0)], { heads });
  assert.deepEqual(res.errors, []);
  assert.ok(res.warnings.some((w) => /is not the closing/.test(w)));
});

console.log('\n── round trip through a real workbook ──');
await t('a filled template saved by ExcelJS reads back identically', async () => {
  const wb = buildTemplate(ExcelJS, { heads });
  const ws = wb.getWorksheet('Trial Balance');
  good.slice(1, 10).forEach((row, i) => { ws.getRow(i + 2).values = row.map((v) => (v === '' ? null : v)); });
  const buf = await wb.xlsx.writeBuffer();
  const res = await readTemplate(ExcelJS, buf, { heads });
  assert.equal(res.sheet, 'Trial Balance');
  assert.deepEqual(res.errors, []);
  assert.equal(res.ledgers.length, 9);
  assert.equal(res.ledgers.find((l) => l.name === 'Ramesh Capital A/c').crTotal, 220000);
  assert.equal(res.mappings.length, 2);
});
await t('mapColumns tolerates Tally’s own export headings', async () => {
  const m = mapColumns(['Particulars', 'Opening Dr', 'Opening Cr', 'Debit', 'Credit', 'Closing Dr', 'Closing Cr']);
  assert.equal(m.name, 0); assert.equal(m.movDr, 3); assert.equal(m.closeCr, 6);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
