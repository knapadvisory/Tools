/* Note lines: Grouping ▸ Sub-grouping ▸ Ledger, as Tally holds it. */
import assert from 'node:assert/strict';
import { deriveSubGroups, subGroupOf, isDefaultGroup, tokens } from './subgroup.js';
let p=0,f=0; const t=(n,fn)=>{try{fn();p++;console.log('  PASS  '+n)}catch(e){f++;console.log('  FAIL  '+n+'\n        '+e.message)}};

/* ---------------------------- reading the chart of accounts ------------- */
t('a company-created group under a Tally group is the sub-grouping', () => {
  const led = { name: 'Neeraj', groupPath: ['Reimbursement Payable', 'Other Current Liabilities', 'Current Liabilities'] };
  assert.equal(subGroupOf(led), 'Reimbursement Payable');
});
t('a ledger sitting directly under a Tally group has no sub-grouping', () => {
  assert.equal(subGroupOf({ name: 'HDFC Bank', groupPath: ['Bank Accounts', 'Current Assets'] }), null);
  assert.equal(subGroupOf({ name: 'Ram Traders', groupPath: ['Sundry Creditors', 'Current Liabilities'] }), null);
  assert.equal(subGroupOf({ name: 'CGST Input', groupPath: ['Duties & Taxes', 'Current Liabilities'] }), null);
});
t('nested company groups report the OUTERMOST one, nearest the head', () => {
  const led = { name: 'Neeraj', groupPath: ['Team A', 'Reimbursement Payable', 'Other Current Liabilities'] };
  assert.equal(subGroupOf(led), 'Reimbursement Payable');
});
t('a chain handed over the other way round is still read correctly', () => {
  const led = { name: 'Neeraj', groupPath: ['Current Liabilities', 'Other Current Liabilities', 'Reimbursement Payable'] };
  assert.equal(subGroupOf(led), 'Reimbursement Payable');
});
t('Tally’s own groups are never mistaken for sub-groupings', () => {
  for (const g of ['Bank Accounts', 'Sundry Debtors', 'Duties & Taxes', 'Capital Account',
                   'Reserves & Surplus', 'Cash-in-Hand', 'Provisions', 'Stock-in-Hand',
                   'Loans & Advances (Asset)', 'Indirect Expenses', 'Sales Accounts']) {
    assert.ok(isDefaultGroup(g), `${g} must count as one of Tally's own`);
  }
  assert.ok(!isDefaultGroup('Reimbursement Payable'));
  assert.ok(!isDefaultGroup('Salary Payable'));
});
t('an older connector with no groupPath falls back to group/primary', () => {
  assert.equal(subGroupOf({ name: 'Neeraj', group: 'Reimbursement Payable', primary: 'Other Current Liabilities' }),
    'Reimbursement Payable');
  assert.equal(subGroupOf({ name: 'HDFC Bank', group: 'Bank Accounts', primary: 'Current Assets' }), null);
});

/* ---------------------------- note lines -------------------------------- */
t('a sub-grouping becomes ONE note line carrying its ledgers', () => {
  const m = deriveSubGroups([
    { name: 'Neeraj', subGroup: 'Reimbursement Payable' },
    { name: 'Yong Ki Hong', subGroup: 'Reimbursement Payable' },
    { name: 'Yeeun Choi', subGroup: 'Salary Payable' },
  ], {}, 'other_current_liabilities');
  assert.equal(m.get('Neeraj').label, 'Reimbursement Payable');
  assert.equal(m.get('Yong Ki Hong').label, 'Reimbursement Payable');
  assert.equal(m.get('Yeeun Choi').label, 'Salary Payable');
  assert.equal(m.get('Neeraj').source, 'tally');
  assert.match(m.get('Neeraj').basis, /sub-grouped in Tally/);
});
t('a ledger with no sub-grouping is shown directly, under its own name', () => {
  const m = deriveSubGroups([
    { name: 'Neeraj', subGroup: 'Reimbursement Payable' },
    { name: 'Director Loan A/c', subGroup: null },
  ], {}, 'other_current_liabilities');
  assert.equal(m.get('Director Loan A/c').label, 'Director Loan A/c');
});
t('the preparer’s caption always wins, even over Tally', () => {
  const m = deriveSubGroups([{ name: 'Neeraj', subGroup: 'Reimbursement Payable' }],
    { Neeraj: 'Employee dues' }, 'other_current_liabilities');
  assert.equal(m.get('Neeraj').label, 'Employee dues');
  assert.equal(m.get('Neeraj').source, 'preparer');
});
t('Tally’s sub-grouping is never overridden by the tool’s own wording rules', () => {
  const m = deriveSubGroups([{ name: 'Yeeun Choi Salary Payable', subGroup: 'Employee Dues Payable' }],
    {}, 'other_current_liabilities');
  assert.equal(m.get('Yeeun Choi Salary Payable').label, 'Employee Dues Payable');
});

/* ------------- books kept flat, with no sub-groups at all --------------- */
t('with no sub-grouping anywhere, an unmistakable nature is PROPOSED', () => {
  const names = ['Yeeun Choi Salary Payable', 'Yeeun Cho Salary Payable', 'Welmin Manar Salary Payable'];
  const m = deriveSubGroups(names.map((name) => ({ name, subGroup: null })), {}, 'other_current_liabilities');
  assert.equal(new Set(names.map((n) => m.get(n).label)).size, 1);
  assert.equal(m.get(names[0]).label, 'Salary payable');
  assert.equal(m.get(names[0]).source, 'proposed');
  assert.match(m.get(names[0]).basis, /not sub-grouped in Tally/);
});
t('a proposal can come from wording the tool has never seen', () => {
  const names = ['Ravi Kumar Tour Advance', 'Sita Devi Tour Advance', 'Mohan Tour Advance'];
  const m = deriveSubGroups(names.map((name) => ({ name, subGroup: null })), {}, 'st_loans_advances');
  assert.equal(m.get('Mohan Tour Advance').label, 'Tour Advance');
  assert.equal(m.get('Mohan Tour Advance').source, 'proposed');
});
t('a one-off is never merged on a guess', () => {
  const m = deriveSubGroups([{ name: 'Ravi Kumar Tour Advance' }, { name: 'Electricity Deposit' }],
    {}, 'other_current_assets');
  assert.equal(m.get('Ravi Kumar Tour Advance').label, 'Ravi Kumar Tour Advance');
  assert.equal(m.get('Ravi Kumar Tour Advance').source, 'ledger');
});
t('two banks are two balances, never one line called "Bank"', () => {
  const m = deriveSubGroups([{ name: 'HDFC Bank' }, { name: 'Axis Bank' }, { name: 'Kotak Bank' }],
    {}, 'cash_and_equivalents');
  assert.equal(m.get('Axis Bank').label, 'Axis Bank');
  assert.match(m.get('Axis Bank').basis, /part of the disclosure/);
});
t('trade payables are not collapsed by the parties’ legal form', () => {
  const m = deriveSubGroups([{ name: 'Alpha Traders Pvt Ltd' }, { name: 'Beta Supplies Pvt Ltd' }],
    {}, 'trade_payables_others');
  assert.equal(m.get('Alpha Traders Pvt Ltd').label, 'Alpha Traders Pvt Ltd');
});
t('even off an identity head, a caption is never just a legal form', () => {
  const m = deriveSubGroups([{ name: 'Alpha Traders Pvt Ltd' }, { name: 'Beta Supplies Pvt Ltd' }],
    {}, 'other_current_liabilities');
  assert.equal(m.get('Alpha Traders Pvt Ltd').label, 'Alpha Traders Pvt Ltd');
});
t('a lone ledger of a known nature is shown as named, not renamed', () => {
  const m = deriveSubGroups([{ name: 'Audit Fee Payable' }, { name: 'Director Loan A/c' }],
    {}, 'other_current_liabilities');
  assert.equal(m.get('Audit Fee Payable').label, 'Audit Fee Payable');
  assert.equal(m.get('Audit Fee Payable').source, 'ledger');
});
t('two ledgers of one nature still merge', () => {
  const m = deriveSubGroups([{ name: 'Audit Fee Payable' }, { name: 'Statutory Audit Fee Payable' }],
    {}, 'other_current_liabilities');
  assert.equal(m.get('Audit Fee Payable').label, 'Audit fee payable');
  assert.equal(m.get('Statutory Audit Fee Payable').label, 'Audit fee payable');
});
t('Tally’s A/c suffix and stop words are ignored', () => {
  assert.deepEqual(tokens('Profit & Loss A/c'), ['profit','loss']);
});

/* --------------- end to end: trial balance -> note line ----------------- */
import { build } from './engine.js';
import { buildNotes } from './notes.js';
import { toRupees } from './money.js';
t('a sub-grouped set of ledgers reaches the note as ONE line', () => {
  const OCL = ['Other Current Liabilities', 'Current Liabilities'];
  const ledgers = [
    { name: 'Share Capital', groupPath: ['Capital Account'], current: -1000000, prior: -1000000 },
    { name: 'Neeraj', groupPath: ['Reimbursement Payable', ...OCL], current: -30000, prior: -10000 },
    { name: 'Yong Ki Hong', groupPath: ['Reimbursement Payable', ...OCL], current: -20000, prior: -5000 },
    { name: 'Audit Fee Payable', groupPath: OCL, current: -50000, prior: -50000 },
    { name: 'HDFC Bank', groupPath: ['Bank Accounts', 'Current Assets'], current: 600000, prior: 565000 },
    { name: 'Axis Bank', groupPath: ['Bank Accounts', 'Current Assets'], current: 500000, prior: 500000 },
  ];
  const r = build({ ledgers, division: 'AS' });
  const notes = buildNotes(r);

  const ocl = notes.find((n) => n.lineId === 'other_current_liabilities');
  const reimb = ocl.subLines.find((s) => s.name === 'Reimbursement Payable');
  assert.ok(reimb, 'the sub-grouping must be one note line');
  assert.equal(reimb.source, 'tally');
  assert.equal(toRupees(reimb.current), 50000);            // 30,000 + 20,000
  assert.deepEqual(reimb.members.map((m) => m.name).sort(), ['Neeraj', 'Yong Ki Hong']);
  // a ledger with no sub-grouping stays on its own line
  assert.ok(ocl.subLines.some((s) => s.name === 'Audit Fee Payable' && s.members.length === 1));

  // banks are not sub-grouped, so they remain two lines
  const cash = notes.find((n) => n.lineId === 'cash_and_equivalents');
  assert.deepEqual(cash.subLines.map((s) => s.name).sort(), ['Axis Bank', 'HDFC Bank']);
});
console.log(`\n${p} passed, ${f} failed\n`); process.exit(f?1:0);
