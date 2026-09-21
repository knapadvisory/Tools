/* Deterministic acceptance tests for the accounting core (spec §16).
 * Run: node finprep/core/engine.test.mjs                                    */
import assert from 'node:assert/strict';
import { build, validateJournal } from './engine.js';
import { classifyLedger, lineForBalance, hasWord } from './classify.js';
import { toPaise, allocate, format, permittedScales } from './money.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
const L = (name, path, cur, pri, extra = {}) =>
  ({ name, group: path[0], primary: path[path.length - 1], groupPath: path, current: cur, prior: pri, ...extra });
const ruleLine = (led) => {
  const r = classifyLedger(led);
  return lineForBalance(r, toPaise(led.current)).line;
};

console.log('\n── money ──');
t('integer paise, no float drift', () => {
  assert.equal(toPaise(0.1) + toPaise(0.2), toPaise(0.3));
  assert.equal(toPaise('1,23,456.78'), 12345678);
  assert.equal(toPaise('(1,000.50)'), -100050);
});
t('allocate never loses or invents a paisa', () => {
  const parts = allocate(10000, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 10000);
});
t('Schedule III rounding units follow turnover', () => {
  assert.deepEqual(permittedScales(toPaise(50_00_00_000)), ['hundreds', 'thousands', 'lakhs', 'millions']);
  assert.deepEqual(permittedScales(toPaise(500_00_00_000)), ['lakhs', 'millions', 'crores']);
});

console.log('\n── C1: substring collisions ──');
t('Indirect Income is Other income, NOT Revenue', () => {
  assert.equal(ruleLine(L('Interest Received', ['Indirect Incomes'], -50000, 0, { isRevenue: true })), 'other_income');
});
t('Sales still reaches Revenue from operations', () => {
  assert.equal(ruleLine(L('Domestic Sales', ['Sales Accounts'], -900000, 0, { isRevenue: true })), 'revenue_operations');
});
t('Unsecured Loan is not matched by the "secured loan" rule', () => {
  const r = classifyLedger(L('ICICI Car Loan', ['Unsecured Loans'], -300000, 0));
  assert.equal(r.line, 'lt_borrowings');
  assert.match(r.reason, /Unsecured/);
});
t('word matching does not match inside a longer word', () => {
  assert.equal(hasWord(' indirect income ', 'direct income'), false);
  assert.equal(hasWord(' indirect income ', 'indirect income'), true);
});

console.log('\n── C5: depreciation ──');
t('depreciation goes to the P&L, never to PPE', () => {
  assert.equal(ruleLine(L('Depreciation', ['Indirect Expenses'], 140000, 0)), 'depreciation_amortisation');
  // even with no isRevenue flag from the connector
  assert.equal(ruleLine(L('Depreciation on Plant', ['Fixed Assets'], 140000, 0)), 'depreciation_amortisation');
});

console.log('\n── C4: no netting of control accounts ──');
t('creditor with a debit balance becomes an advance to suppliers', () => {
  const r = classifyLedger(L('ABC Traders', ['Sundry Creditors'], 0, 0));
  assert.equal(lineForBalance(r, toPaise(18000)).line, 'advances_to_suppliers');
  assert.equal(lineForBalance(r, toPaise(-18000)).line, 'trade_payables_others');
});
t('debtor with a credit balance becomes an advance from customers', () => {
  const r = classifyLedger(L('XYZ Ltd', ['Sundry Debtors'], 0, 0));
  assert.equal(lineForBalance(r, toPaise(-25000)).line, 'advances_from_customers');
});
t('bank overdraft is a short-term borrowing, not negative cash', () => {
  const r = classifyLedger(L('HDFC CC', ['Bank Accounts'], 0, 0));
  assert.equal(lineForBalance(r, toPaise(-400000)).line, 'st_borrowings');
});

console.log('\n── M2: finance costs ──');
t('bank charges are other expenses', () => {
  assert.equal(ruleLine(L('Bank Charges', ['Indirect Expenses'], 5000, 0)), 'other_expenses');
});
t('interest on TDS is not a finance cost', () => {
  assert.equal(ruleLine(L('Interest on TDS', ['Indirect Expenses'], 2000, 0)), 'other_expenses');
});
t('interest on term loan is a finance cost', () => {
  assert.equal(ruleLine(L('Interest on Term Loan', ['Indirect Expenses'], 90000, 0)), 'finance_costs');
});

console.log('\n── H2: heads that previously did not exist ──');
t('share application money has its own head', () => {
  assert.equal(ruleLine(L('Share Application Money Pending Allotment', ['Capital Account'], -500000, 0)), 'share_application_money');
});
t('CWIP is not presented as PPE', () => {
  assert.equal(ruleLine(L('Capital Work in Progress', ['Fixed Assets'], 700000, 0)), 'cwip');
});
t('software is an intangible, not PPE', () => {
  assert.equal(ruleLine(L('ERP Software', ['Fixed Assets'], 300000, 0)), 'intangibles');
});

console.log('\n── H4: TDS receivable precedence ──');
t('TDS receivable under Duties & Taxes is a receivable, not a statutory due', () => {
  assert.equal(ruleLine(L('TDS Receivable', ['Duties & Taxes'], 45000, 0)), 'other_current_assets');
});

console.log('\n── C2 + C6: tax, PAT and reserves ──');
const base = [
  L('Share Capital', ['Capital Account'], -1000000, -1000000),
  L('Profit & Loss A/c', ['Reserves & Surplus'], -200000, -200000),
  L('Plant & Machinery', ['Fixed Assets'], 1500000, 1600000),
  L('HDFC Bank', ['Bank Accounts'], 560000, 400000),
  L('Sundry Creditors A', ['Sundry Creditors'], -300000, -300000),
  L('Sales', ['Sales Accounts'], -1000000, -900000, { isRevenue: true }),
  L('Salary', ['Indirect Expenses'], 300000, 300000, { isRevenue: true }),
  L('Depreciation', ['Indirect Expenses'], 140000, 100000, { isRevenue: true }),
];
t('a balanced book with every ledger classified ties in both periods', () => {
  const r = build({ ledgers: base });
  assert.equal(r.bs.current.difference, 0, 'current BS out by ' + format(r.bs.current.difference));
  assert.equal(r.bs.prior.difference, 0, 'prior BS out by ' + format(r.bs.prior.difference));
  assert.equal(r.releasable, true);
});
t('depreciation hits the P&L and not the asset', () => {
  const r = build({ ledgers: base });
  assert.equal(r.value('depreciation_amortisation', 'current'), toPaise(140000));
  assert.equal(r.value('ppe', 'current'), toPaise(1500000));
});
t('reserves roll forward on PAT, not PBT', () => {
  // Dr current tax 160000 / Cr provision for tax 160000, approved
  const journals = [{ id: 'J1', approved: true, period: 'current', narration: 'Provision for tax',
    entries: [{ lineId: 'current_tax', amount: 160000 }, { lineId: 'st_provisions', amount: -160000 }] }];
  const r = build({ ledgers: base, journals });
  assert.equal(r.pl.current.tax.total, toPaise(160000));
  assert.equal(r.pl.current.pat, toPaise(560000 - 160000));            // PBT 5,60,000 less tax
  // reserves = opening 2,00,000 + PAT 4,00,000
  assert.equal(r.bs.current.reserves, toPaise(200000 + 400000));
  // and the balance sheet STILL ties, because the provision is a real liability
  assert.equal(r.bs.current.difference, 0, 'BS out by ' + format(r.bs.current.difference));
});
t('an unbalanced journal is rejected, never silently posted', () => {
  const v = validateJournal({ id: 'X', narration: 'bad', entries: [{ lineId: 'current_tax', amount: 100 }] });
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /does not balance/);
});

console.log('\n── H1: unclassified is visible and blocks release ──');
t('an unclassified ledger is reported gross and stops release', () => {
  const led = base.concat([
    L('Mystery A', ['Suspense A/c'], 500000, 0),
    L('Mystery B', ['Suspense A/c'], -500000, 0),   // nets to nil — the old check missed this
  ]);
  const r = build({ ledgers: led });
  assert.equal(r.value('unclassified', 'current'), 0, 'net should be nil');
  assert.equal(r.unclassified.dr.current, toPaise(500000));
  assert.equal(r.unclassified.cr.current, toPaise(-500000));
  assert.equal(r.releasable, false, 'must not be releasable with unclassified balances');
  assert.ok(r.checks.some((c) => c.id === 'UNCL-current' && c.severity === 'CRITICAL'));
});
t('a trial balance that does not sum to nil is reported as a source defect', () => {
  const r = build({ ledgers: base.concat([L('Odd', ['Suspense A/c'], 1234, 0)]) });
  assert.ok(r.checks.some((c) => c.id === 'TB-current' && c.severity === 'CRITICAL'));
  assert.equal(r.releasable, false);
});

console.log('\n── C3/H7: per-period classification ──');
t('a ledger that changes side lands in the right head in each column', () => {
  const led = base.concat([L('GST Ledger', ['Duties & Taxes'], 200000, -500000)]);
  const r = build({ ledgers: led });
  assert.equal(r.value('other_current_assets', 'current'), toPaise(200000)); // Dr this year
  assert.equal(r.value('statutory_dues', 'prior'), toPaise(-500000));        // Cr last year
  assert.ok(r.checks.some((c) => c.id.startsWith('RCL-')), 'regrouping must be flagged');
});

console.log('\n── disclosure completeness ──');
t('used heads carry their Schedule III information requirements', () => {
  const r = build({ ledgers: base });
  const tr = r.disclosureGaps.find((g) => g.lineId === 'ppe');
  assert.ok(tr && tr.requires.some((x) => /gross block/i.test(x)));
});


console.log('\n── Tally group spellings seen in real books ──');
t('"Share Capital" group reaches share capital', () => {
  assert.equal(ruleLine(L('EDU KOREA CO., LTD Share Capital', ['Share Capital'], -101970, 0)), 'share_capital');
  assert.equal(ruleLine(L('Yong Ki Hong Capital', ['Share Capital'], -1030, 0)), 'share_capital');
});
t('Tally’s "Profit & Loss A/c" reaches reserves', () => {
  assert.equal(ruleLine(L('Profit & Loss A/c', ['Primary'], 956601, 0)), 'reserves_surplus');
});
t('"Capital Account" still works', () => {
  assert.equal(ruleLine(L('Share Capital', ['Capital Account'], -1000000, 0)), 'share_capital');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
