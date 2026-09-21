/* Note sub-grouping: ledgers of the same nature share one line. */
import assert from 'node:assert/strict';
import { deriveSubGroups, tokens } from './subgroup.js';
let p=0,f=0; const t=(n,fn)=>{try{fn();p++;console.log('  PASS  '+n)}catch(e){f++;console.log('  FAIL  '+n+'\n        '+e.message)}};

t('three employees’ salary payable become ONE line', () => {
  const names = ['Yeeun Choi Salary Payable','Yeeun Cho Salary Payable','Welmin Manar Salary Payable'];
  const m = deriveSubGroups(names);
  assert.equal(new Set(names.map(n=>m.get(n).label)).size, 1);
  assert.equal(m.get(names[0]).label, 'Salary payable');
});
t('different natures do NOT merge', () => {
  const m = deriveSubGroups(['Yong Ki Hong Reimbursement','Yeeun Choi Salary Payable','Audit Fee Payable']);
  assert.equal(m.get('Yong Ki Hong Reimbursement').label, 'Reimbursements payable');
  assert.equal(m.get('Yeeun Choi Salary Payable').label, 'Salary payable');
  assert.equal(m.get('Audit Fee Payable').label, 'Audit fee payable');
});
t('a one-off keeps its own line rather than being merged on a guess', () => {
  const m = deriveSubGroups(['Director Loan A/c','Sundry Balance Written Back']);
  assert.equal(m.get('Director Loan A/c').label, 'Director Loan A/c');
  assert.match(m.get('Director Loan A/c').basis, /own line/);
});
t('wording the tool has never seen still groups by shared trailing words', () => {
  const m = deriveSubGroups(['Ravi Kumar Tour Advance','Sita Devi Tour Advance','Mohan Tour Advance']);
  assert.equal(m.get('Mohan Tour Advance').label, 'Tour Advance');
  assert.match(m.get('Mohan Tour Advance').basis, /shared wording in 3/);
});
t('a single ledger with unknown wording is never merged with anything', () => {
  const m = deriveSubGroups(['Ravi Kumar Tour Advance','Electricity Deposit']);
  assert.equal(m.get('Ravi Kumar Tour Advance').label, 'Ravi Kumar Tour Advance');
});
t('the preparer’s caption always wins', () => {
  const m = deriveSubGroups(['Yeeun Choi Salary Payable'], {'Yeeun Choi Salary Payable':'Employee dues'});
  assert.equal(m.get('Yeeun Choi Salary Payable').label, 'Employee dues');
  assert.match(m.get('Yeeun Choi Salary Payable').basis, /preparer/);
});
t('Tally’s A/c suffix and stop words are ignored', () => {
  assert.deepEqual(tokens('Profit & Loss A/c'), ['profit','loss']);
});

/* --- where the counterparty IS the disclosure, nothing is merged on a guess --- */
t('two banks are two balances, never one line called "Bank"', () => {
  const m = deriveSubGroups(['HDFC Bank','Axis Bank','Kotak Bank'], {}, 'cash_and_equivalents');
  assert.equal(m.get('HDFC Bank').label, 'HDFC Bank');
  assert.equal(m.get('Axis Bank').label, 'Axis Bank');
  assert.match(m.get('Axis Bank').basis, /part of the disclosure/);
});
t('trade payables are not collapsed by the parties’ legal form', () => {
  const m = deriveSubGroups(['Alpha Traders Pvt Ltd','Beta Supplies Pvt Ltd'], {}, 'trade_payables_others');
  assert.equal(m.get('Alpha Traders Pvt Ltd').label, 'Alpha Traders Pvt Ltd');
  assert.equal(m.get('Beta Supplies Pvt Ltd').label, 'Beta Supplies Pvt Ltd');
});
t('the preparer can still merge on an identity head', () => {
  const m = deriveSubGroups(['HDFC Bank','Axis Bank'], { 'HDFC Bank':'Balances with banks','Axis Bank':'Balances with banks' }, 'cash_and_equivalents');
  assert.equal(m.get('HDFC Bank').label, 'Balances with banks');
  assert.equal(m.get('Axis Bank').label, 'Balances with banks');
});
t('even off an identity head, a caption is never just a legal form', () => {
  const m = deriveSubGroups(['Alpha Traders Pvt Ltd','Beta Supplies Pvt Ltd'], {}, 'other_current_liabilities');
  assert.equal(m.get('Alpha Traders Pvt Ltd').label, 'Alpha Traders Pvt Ltd');
});
console.log(`\n${p} passed, ${f} failed\n`); process.exit(f?1:0);
