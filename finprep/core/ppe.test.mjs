/* The PPE schedule and the MSMED block.
 * Run: node finprep/core/ppe.test.mjs                                       */
import assert from 'node:assert/strict';
import { build } from './engine.js';
import { ppeSchedule, msmeDisclosure } from './ppe.js';
import { toPaise } from './money.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
const L = (name, p, cur, pri, extra = {}) => ({ name, group: p[0], primary: p[p.length - 1], groupPath: p, current: cur, prior: pri, ...extra });
const row = (s, name) => s.rows.find((x) => x.ledger === name);

// Furniture: opened 3,00,000, bought 50,000, sold 20,000, depreciation 33,000 → closes 2,97,000 (gross: Dr 50,000, Cr 53,000)
// Vehicles: opened 5,00,000, depreciation 75,000, no movements → 4,25,000 (gross: Dr 0, Cr 75,000)
const books = [
  L('Capital A/c', ['Capital Account'], -1500000, -1000000),
  L('Furniture', ['Fixed Assets'], 297000, 300000, { drTotal: 50000, crTotal: 53000 }),
  L('Vehicles', ['Fixed Assets'], 425000, 500000, { drTotal: 0, crTotal: 75000 }),
  L('Depreciation on Furniture', ['Indirect Expenses'], 33000, 0, { isRevenue: true }),
  L('Depreciation on Vehicles', ['Indirect Expenses'], 75000, 0, { isRevenue: true }),
  L('Sales', ['Sales Accounts'], -900000, 0, { isRevenue: true }),
  L('Rent', ['Indirect Expenses'], 184000, 0, { isRevenue: true }),
  L('Cash', ['Cash in Hand'], 1386000, 200000),
];
const r = build({ ledgers: books, constitution: 'proprietorship', owners: [{ name: 'Mohan' }] });

console.log('\n── the schedule from gross movements ──');
t('the books balance', () => { assert.equal(r.bs.current.difference, 0, String(r.bs.current.difference)); });
t('each asset gets its own depreciation ledger, additions and deductions apart, and closes right', () => {
  const s = ppeSchedule(r, {});
  const f = row(s, 'Furniture');
  assert.equal(f.opening, toPaise(300000)); assert.equal(f.additions, toPaise(50000)); assert.equal(f.deductions, toPaise(20000));
  assert.equal(f.depreciation, toPaise(33000)); assert.equal(f.closing, toPaise(297000));
  assert.match(f.depBasis, /Depreciation on Furniture/);
  const v = row(s, 'Vehicles');
  assert.equal(v.depreciation, toPaise(75000)); assert.equal(v.deductions, 0); assert.equal(v.additions, 0);
  assert.equal(s.totals.depreciation, toPaise(108000));
  assert.ok(!s.checks.some((c) => c.id === 'PPE-DEP'), 'schedule agrees with the P&L');
  assert.ok(!s.checks.some((c) => c.id.startsWith('PPE-MOVE')));
});
t('a keyed depreciation overrides the match, and a mismatch with the P&L is reported', () => {
  const s = ppeSchedule(r, { 'ppe:Furniture:dep': 30000 });
  assert.equal(row(s, 'Furniture').depreciation, toPaise(30000));
  assert.equal(row(s, 'Furniture').deductions, toPaise(23000), 'what is left of the credits');
  const dep = s.checks.find((c) => c.id === 'PPE-DEP');
  assert.ok(dep && dep.amount === toPaise(-3000));
});
t('a personal-use share is computed on the depreciation and noted', () => {
  const s = ppeSchedule(r, { 'ppe:Vehicles:personal': 20 });
  assert.equal(row(s, 'Vehicles').personalUse, toPaise(15000));
  assert.equal(s.totals.personalUse, toPaise(15000));
  assert.ok(s.notes.some((n) => /personal use/.test(n)));
});

console.log('\n── without gross movements ──');
t('the net movement is split the only way it can be, and the schedule says so', () => {
  const net = books.map((l) => { const { drTotal, crTotal, ...rest } = l; return rest; });
  const rr = build({ ledgers: net, constitution: 'proprietorship', owners: [{ name: 'Mohan' }] });
  const s = ppeSchedule(rr, {});
  const f = row(s, 'Furniture');
  assert.equal(f.depreciation, toPaise(33000));
  assert.equal(f.additions, toPaise(30000), 'net of the 50,000 bought and 20,000 sold'); assert.equal(f.deductions, 0);
  assert.equal(f.closing, toPaise(297000));
  assert.ok(s.notes.some((n) => /shown net/.test(n)));
});
t('one asset ledger and one depreciation ledger of another name: the whole charge is taken', () => {
  const one = [L('Capital A/c', ['Capital Account'], -200000, -200000), L('Plant', ['Fixed Assets'], 180000, 200000, { drTotal: 0, crTotal: 20000 }),
    L('Depreciation', ['Indirect Expenses'], 20000, 0, { isRevenue: true }), L('Sales', ['Sales Accounts'], -20000, 0, { isRevenue: true }), L('Cash', ['Cash in Hand'], 20000, 0)];
  const rr = build({ ledgers: one });
  const s = ppeSchedule(rr, {});
  assert.equal(row(s, 'Plant').depreciation, toPaise(20000));
  assert.match(row(s, 'Plant').depBasis, /one asset ledger/);
});
t('no asset ledger → no schedule', () => {
  const rr = build({ ledgers: [L('Capital A/c', ['Capital Account'], -1000, -1000), L('Cash', ['Cash in Hand'], 1000, 1000)] });
  assert.equal(ppeSchedule(rr, {}), null);
});

console.log('\n── MSMED ──');
t('the MSMED block carries six figures in paise and knows when nothing was given', () => {
  assert.equal(msmeDisclosure({}).provided, false);
  const m = msmeDisclosure({ 'msme:principal': '1,20,000', 'msme:interest': 0 });
  assert.equal(m.provided, true);
  assert.equal(m.rows[0].amount, toPaise(120000)); assert.equal(m.rows[1].amount, 0); assert.equal(m.rows[2].amount, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
