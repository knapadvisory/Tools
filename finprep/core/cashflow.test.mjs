/* Acceptance tests for the cash flow statement (spec §9, §16.9).
 * Run: node finprep/core/cashflow.test.mjs                                  */
import assert from 'node:assert/strict';
import { build } from './engine.js';
import { buildCashFlow } from './cashflow.js';
import { toPaise, toRupees, format } from './money.js';

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const L = (name, path, cur, pri, extra = {}) =>
  ({ name, group: path[0], primary: path[path.length - 1], groupPath: path, current: cur, prior: pri, ...extra });

/* A coherent set of books.
 * Prior year PAT 5,00,000 was transferred to reserves (2,00,000 → 7,00,000).
 * Current year: income 10,00,000, salary 3,40,000, depreciation 1,40,000
 *   → PBT 5,20,000, add back depreciation → operating cash 6,60,000.
 * Net block falls 1,40,000 purely through depreciation (no capex, no disposal).
 * Cash therefore moves 4,00,000 → 10,60,000. Both trial balances sum to nil.  */
const ledgers = [
  L('Share Capital', ['Capital Account'], -1000000, -1000000),
  L('Profit & Loss A/c', ['Reserves & Surplus'], -700000, -200000),
  L('Plant & Machinery', ['Fixed Assets'], 1460000, 1600000),
  L('HDFC Bank', ['Bank Accounts'], 1060000, 400000),
  L('Sundry Creditors A', ['Sundry Creditors'], -300000, -300000),
  L('Fees', ['Sales Accounts'], -1000000, -900000, { isRevenue: true }),
  L('Salary', ['Indirect Expenses'], 340000, 300000, { isRevenue: true }),
  L('Depreciation', ['Indirect Expenses'], 140000, 100000, { isRevenue: true }),
];
/** clone the book, adding ledgers and moving the bank by the same net amount */
const withBank = (extra, bankDelta) =>
  ledgers.map((l) => (l.name === 'HDFC Bank' ? { ...l, current: l.current + bankDelta } : l)).concat(extra);

console.log('\n── cash flow: built bottom-up, reconciled ──');

t('operating starts at PBT and adds back depreciation — it is not a plug', () => {
  const r = build({ ledgers });
  const cf = buildCashFlow(r);
  assert.equal(cf.operating.pbt, r.pl.current.pbt);
  const dep = cf.operating.adjustments.find((a) => /Depreciation/.test(a.label));
  assert.equal(dep.amount, toPaise(140000));
});

t('the statement reconciles to the movement in cash per the balance sheet', () => {
  const r = build({ ledgers });
  const cf = buildCashFlow(r);
  assert.equal(cf.openingCash, toPaise(400000));
  assert.equal(cf.closingCashPerBS, toPaise(1060000));
  assert.equal(cf.operating.net, toPaise(660000));   // PBT 5,20,000 + depreciation 1,40,000
  assert.equal(cf.unreconciled, 0, 'unreconciled by ' + format(cf.unreconciled));
  assert.equal(cf.reconciled, true);
});

t('depreciation is NOT reported as an investing inflow', () => {
  const r = build({ ledgers });
  const cf = buildCashFlow(r);
  // net block fell 1,40,000 purely through depreciation → no real capex, no inflow
  const ppe = cf.investing.items.find((i) => /property, plant/i.test(i.label));
  assert.ok(!ppe || ppe.amount <= 0, 'depreciation must not create an investing inflow');
  assert.equal(cf.investing.net, 0, 'investing should be nil, got ' + format(cf.investing.net));
});

t('a genuine difference is REPORTED, never absorbed into operating', () => {
  const r = build({ ledgers });
  // claim taxes were paid that the books never funded -> the statement must not tie
  const cf = buildCashFlow(r, { schedules: { taxPaid: 50000 } });
  assert.notEqual(cf.unreconciled, 0);
  assert.equal(cf.reconciled, false);
  assert.ok(cf.checks.some((c) => c.id === 'CF-RECON' && c.severity === 'CRITICAL'));
  // the residual stays outside the activities -- nothing is plugged
  assert.equal(cf.operating.net + cf.investing.net + cf.financing.net, cf.netChange);
});

t('interest income is moved out of operating into investing', () => {
  const led = withBank([L('Interest Received on FD', ['Indirect Incomes'], -60000, 0, { isRevenue: true })], 60000);
  const r = build({ ledgers: led });
  const cf = buildCashFlow(r);
  const adj = cf.operating.adjustments.find((a) => /Interest and dividend/.test(a.label));
  assert.equal(adj.amount, toPaise(-60000), 'must be removed from operating');
  const inv = cf.investing.items.find((i) => /Interest and dividend received/.test(i.label));
  assert.equal(inv.amount, toPaise(60000), 'and shown as investing');
});

t('finance costs are reclassified out of operating into financing', () => {
  const led = withBank([L('Interest on Term Loan', ['Indirect Expenses'], 90000, 0, { isRevenue: true })], -90000);
  const r = build({ ledgers: led });
  const cf = buildCashFlow(r);
  assert.ok(cf.operating.adjustments.some((a) => /Finance costs/.test(a.label) && a.amount === toPaise(90000)));
  assert.ok(cf.financing.items.some((f) => /Finance costs paid/.test(f.label) && f.amount === toPaise(-90000)));
});

t('every estimate made from a two-period TB is recorded as an assumption', () => {
  const r = build({ ledgers });
  const cf = buildCashFlow(r);
  const ids = cf.assumptions.map((a) => a.id);
  assert.ok(ids.includes('CF-FA'), 'net capex assumption must be disclosed');
  assert.ok(ids.includes('CF-TAX'), 'derived taxes-paid assumption must be disclosed');
});

t('supplied schedules replace the assumptions with gross figures', () => {
  const r = build({ ledgers });
  const cf = buildCashFlow(r, { schedules: { fixedAssets: { additions: 0, disposalProceeds: 0 }, taxPaid: 0 } });
  const ids = cf.assumptions.map((a) => a.id);
  assert.ok(!ids.includes('CF-FA'));
  assert.ok(!ids.includes('CF-TAX'));
  assert.ok(cf.investing.items.some((i) => /Purchase of property/.test(i.label)));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
