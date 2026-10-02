/* The owners' capital accounts of a non-corporate entity.
 * Run: node finprep/core/owners.test.mjs                                    */
import assert from 'node:assert/strict';
import { build } from './engine.js';
import { classifyLedger, lineForBalance } from './classify.js';
import { linesFor, captionFor, divisionForConstitution } from './schedule3.js';
import { toPaise, format } from './money.js';
import { normaliseOwners, autoAssign } from './owners.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
const L = (name, path, cur, pri, extra = {}) =>
  ({ name, group: path[0], primary: path[path.length - 1], groupPath: path, current: cur, prior: pri, ...extra });
const nceLine = (led) => lineForBalance(classifyLedger(led, { nce: true }), toPaise(led.current)).line;
const corpLine = (led) => lineForBalance(classifyLedger(led), toPaise(led.current)).line;
const row = (sched, key) => sched.rows.find((r) => r.key === key);

console.log('\n── the chart knows three divisions ──');
t('the non-corporate format has owners’ lines and no share capital', () => {
  const ids = new Set(linesFor('NCE').map((l) => l.id));
  assert.ok(ids.has('owners_capital') && ids.has('partners_current') && ids.has('partners_remuneration') && ids.has('interest_on_capital'));
  assert.ok(!ids.has('share_capital') && !ids.has('share_warrants') && !ids.has('share_application_money'));
  assert.ok(ids.has('extraordinary_items'), 'the NCE format follows Division I, which still has extraordinary items');
});
t('companies see no owners’ lines', () => {
  for (const d of ['AS', 'INDAS']) {
    const ids = new Set(linesFor(d).map((l) => l.id));
    assert.ok(ids.has('share_capital') && !ids.has('owners_capital') && !ids.has('partners_remuneration'), d);
  }
});
t('the wording follows the constitution', () => {
  assert.equal(captionFor('owners_capital', 'NCE', 'proprietorship'), 'Proprietor’s capital account');
  assert.equal(captionFor('owners_capital', 'NCE', 'partnership'), 'Partners’ capital accounts');
  assert.equal(divisionForConstitution('partnership'), 'NCE');
  assert.equal(divisionForConstitution('company', 'INDAS'), 'INDAS');
  assert.equal(divisionForConstitution('llp', 'INDAS'), 'NCE', 'an LLP cannot opt into Schedule III');
});

console.log('\n── classification for a firm ──');
t('partners’ capital, current and drawings ledgers reach the owners’ lines', () => {
  assert.equal(nceLine(L('Ramesh Capital A/c', ['Capital Account'], -500000, -400000)), 'owners_capital');
  assert.equal(nceLine(L('Ramesh Drawings', ['Capital Account'], 60000, 0)), 'owners_capital');
  assert.equal(nceLine(L('Suresh Current A/c', ['Capital Account'], -20000, -10000)), 'partners_current');
});
t('the same ledgers in a company are still share capital', () => {
  assert.equal(corpLine(L('Share Capital', ['Capital Account'], -1000000, -1000000)), 'share_capital');
});
t('remuneration and interest to partners are appropriations, not employee or finance costs', () => {
  assert.equal(nceLine(L('Partners Remuneration', ['Indirect Expenses'], 240000, 0, { isRevenue: true })), 'partners_remuneration');
  assert.equal(nceLine(L('Salary to Partner Ramesh', ['Indirect Expenses'], 120000, 0, { isRevenue: true })), 'partners_remuneration');
  assert.equal(nceLine(L('Interest on Capital', ['Indirect Expenses'], 36000, 0, { isRevenue: true })), 'interest_on_capital');
  // but staff salary and bank interest stay where they belong
  assert.equal(nceLine(L('Staff Salary', ['Indirect Expenses'], 300000, 0, { isRevenue: true })), 'employee_benefits');
  assert.equal(nceLine(L('Interest on Term Loan', ['Indirect Expenses'], 50000, 0, { isRevenue: true })), 'finance_costs');
});

console.log('\n── a partnership firm, two partners 60:40 ──');
// Books with gross movements, the way the connector supplies them.
// Ramesh: opening 4,00,000 Cr; introduced 1,00,000; remuneration 1,20,000 credited; drawings 60,000 → ledger closing 5,60,000 Cr
// Suresh: opening 3,00,000 Cr; drawings 40,000; remuneration 1,20,000 paid out in cash (not through capital) → closing 2,60,000 Cr
const firm = [
  L('Ramesh Capital A/c', ['Capital Account'], -560000, -400000, { drTotal: 60000, crTotal: 220000 }),
  L('Suresh Capital A/c', ['Capital Account'], -260000, -300000, { drTotal: 40000, crTotal: 0 }),
  L('Remuneration - Ramesh', ['Indirect Expenses'], 120000, 0, { isRevenue: true, drTotal: 120000, crTotal: 0 }),
  L('Remuneration - Suresh', ['Indirect Expenses'], 120000, 0, { isRevenue: true, drTotal: 120000, crTotal: 0 }),
  L('Sales', ['Sales Accounts'], -1500000, -1200000, { isRevenue: true }),
  L('Purchases', ['Purchase Accounts'], 700000, 600000, { isRevenue: true }),
  L('Shop Rent', ['Indirect Expenses'], 120000, 120000, { isRevenue: true }),
  L('HDFC Bank', ['Bank Accounts'], 1120000, 500000),
  L('Sundry Creditors X', ['Sundry Creditors'], -100000, -100000),
  L('Furniture', ['Fixed Assets'], 300000, 300000),
  // prior: bank 5,00,000 + furniture 3,00,000 = capital 7,00,000 + creditors 1,00,000 — last year's
  // profit (4,80,000, shown as the comparative P&L) is already inside the opening capital.
  // current: bank 10,60,000 + furniture 3,00,000 = capital 8,20,000 + profit 4,40,000 + creditors 1,00,000.
];
firm[7] = L('HDFC Bank', ['Bank Accounts'], 1060000, 500000);
const owners = [
  { id: 'own_r', name: 'Ramesh Kumar', ratio: 60, ledgers: { capital: ['Ramesh Capital A/c'], remuneration: ['Remuneration - Ramesh'] } },
  { id: 'own_s', name: 'Suresh Kumar', ratio: 40, ledgers: { capital: ['Suresh Capital A/c'], remuneration: ['Remuneration - Suresh'] } },
];
const r = build({ ledgers: firm, constitution: 'partnership', owners });

t('the books balance and the division is NCE', () => {
  assert.equal(r.division, 'NCE');
  assert.equal(r.tbSum.current, 0);
  assert.equal(r.pl.current.pat, toPaise(440000));
  assert.equal(r.pl.prior.pat, toPaise(480000), 'last year’s P&L is a comparative');
  assert.ok(!r.checks.some((c) => c.id === 'TB-prior'), 'the comparative balance sheet ties on its own');
  assert.equal(r.bs.current.difference, 0, 'BS out by ' + format(r.bs.current.difference));
  assert.equal(r.bs.prior.difference, 0, 'prior BS out by ' + format(r.bs.prior.difference));
});
t('the face shows the capital accounts closing WITH the year’s profit, and reserves carry nothing', () => {
  assert.equal(r.bs.current.ownersCapital, toPaise(820000 + 440000));
  assert.equal(r.bs.current.reserves, 0);
  assert.equal(r.bs.prior.ownersCapital, toPaise(700000), 'last year’s profit was already in the opening capital');
});
t('profit is shared 60:40 to the paisa', () => {
  const sh = row(r.owners.capital, 'share');
  assert.equal(sh.byOwner.own_r, toPaise(264000));
  assert.equal(sh.byOwner.own_s, toPaise(176000));
  assert.equal(sh.total, toPaise(440000));
});
t('Ramesh: remuneration credited to capital is shown as a credit, not as capital introduced', () => {
  const c = r.owners.capital;
  assert.equal(row(c, 'opening').byOwner.own_r, toPaise(400000));
  assert.equal(row(c, 'remuneration').byOwner.own_r, toPaise(120000));
  assert.equal(row(c, 'introduced').byOwner.own_r, toPaise(100000));
  assert.equal(row(c, 'drawings').byOwner.own_r, toPaise(60000));
  assert.equal(row(c, 'closing').byOwner.own_r, toPaise(400000 + 100000 + 120000 + 264000 - 60000));
  assert.ok(r.checks.some((x) => x.id === 'OWN-CREDITED-capital'), 'the inference is reported');
});
t('Suresh: remuneration paid out directly does not pass through the capital account', () => {
  const c = r.owners.capital;
  assert.equal(row(c, 'remuneration').byOwner.own_s, 0);
  assert.equal(row(c, 'introduced').byOwner.own_s, 0);
  assert.equal(row(c, 'drawings').byOwner.own_s, toPaise(40000));
  assert.equal(row(c, 'closing').byOwner.own_s, toPaise(300000 - 40000 + 176000));
});
t('the statement adds across to the balance sheet', () => {
  assert.equal(row(r.owners.capital, 'closing').total, r.bs.current.ownersCapital);
  assert.ok(!r.checks.some((x) => x.id.startsWith('OWN-TIE')));
  assert.equal(r.releasable, true, r.checks.filter((c) => c.severity === 'CRITICAL').map((c) => c.message).join(' | '));
});
t('a ratio of nil never receives a rounding paisa', () => {
  const three = [
    { id: 'a', name: 'A', ratio: 1, ledgers: {} }, { id: 'b', name: 'B', ratio: 1, ledgers: {} },
    { id: 'c', name: 'C', ratio: 1, ledgers: {} }, { id: 'z', name: 'Sleeping', ratio: 0, ledgers: {} },
  ];
  const rr = build({ ledgers: firm, constitution: 'partnership', owners: three });
  const sh = row(rr.owners.capital, 'share');
  assert.equal(sh.byOwner.z, 0);
  assert.equal(sh.byOwner.a + sh.byOwner.b + sh.byOwner.c, toPaise(440000));
});
t('a manual split that does not add to the profit is refused, loudly', () => {
  const bad = owners.map((o) => ({ ...o, split: 100000 }));
  const rr = build({ ledgers: firm, constitution: 'partnership', owners: bad });
  assert.ok(rr.checks.some((x) => x.id === 'OWN-SPLIT' && x.severity === 'CRITICAL'));
  assert.equal(rr.releasable, false);
  // the ratios are used meanwhile, and the statement still ties
  assert.equal(row(rr.owners.capital, 'share').byOwner.own_r, toPaise(264000));
  assert.equal(row(rr.owners.capital, 'closing').total, rr.bs.current.ownersCapital);
});
t('a manual split that adds to the profit is honoured', () => {
  const good = owners.map((o, i) => ({ ...o, split: i === 0 ? 300000 : 140000 }));
  const rr = build({ ledgers: firm, constitution: 'partnership', owners: good });
  assert.equal(row(rr.owners.capital, 'share').byOwner.own_r, toPaise(300000));
  assert.equal(rr.owners.shareBasis, 'manual split recorded by the preparer');
});
t('with no ratios and several partners the profit cannot be allocated — CRITICAL, but the statement still ties', () => {
  const none = owners.map((o) => ({ ...o, ratio: 0 }));
  const rr = build({ ledgers: firm, constitution: 'partnership', owners: none });
  assert.ok(rr.checks.some((x) => x.id === 'OWN-RATIO' && x.severity === 'CRITICAL'));
  assert.equal(row(rr.owners.capital, 'closing').total, rr.bs.current.ownersCapital);
});
t('without gross movements the account is shown net and says so', () => {
  const net = firm.map((l) => { const { drTotal, crTotal, ...rest } = l; return rest; });
  const rr = build({ ledgers: net, constitution: 'partnership', owners });
  assert.ok(rr.checks.some((x) => x.id === 'OWN-GROSS-capital'));
  const c = rr.owners.capital;
  // Ramesh moved +1,60,000 net, of which 1,20,000 remuneration is inferred as credited
  assert.equal(row(c, 'introduced').byOwner.own_r, toPaise(40000));
  assert.equal(row(c, 'drawings').byOwner.own_r, 0);
  assert.equal(row(c, 'closing').total, rr.bs.current.ownersCapital);
});
t('ledgers are assigned to the partner whose name they carry', () => {
  const bare = owners.map((o) => ({ ...o, ledgers: {} }));
  const rr = build({ ledgers: firm, constitution: 'partnership', owners: bare });
  const kinds = Object.fromEntries(rr.owners.assignments.map((a) => [a.ledger, a.owner]));
  assert.equal(kinds['Ramesh Capital A/c'], 'Ramesh Kumar');
  assert.equal(kinds['Remuneration - Suresh'], 'Suresh Kumar');
  assert.equal(row(rr.owners.capital, 'closing').byOwner.own_s, toPaise(300000 - 40000 + 176000));
});
t('profit may close into the current accounts instead', () => {
  const withCurrent = firm.concat([L('Ramesh Current A/c', ['Capital Account'], -5000, -5000), L('Suresh Current A/c', ['Capital Account'], 5000, 5000)]);
  const rr = build({ ledgers: withCurrent, constitution: 'partnership', owners, profitTo: 'current' });
  assert.equal(rr.bs.current.ownersCapital, toPaise(820000));
  assert.equal(rr.bs.current.partnersCurrent, toPaise(440000));
  assert.equal(row(rr.owners.current, 'share').total, toPaise(440000));
  assert.equal(row(rr.owners.capital, 'share').total, 0);
  assert.equal(rr.bs.current.difference, 0);
});

console.log('\n── a sole proprietor ──');
const shop = [
  L('Capital A/c', ['Capital Account'], -250000, -200000, { drTotal: 150000, crTotal: 200000 }),
  L('Sales', ['Sales Accounts'], -900000, -800000, { isRevenue: true }),
  L('Purchases', ['Purchase Accounts'], 600000, 500000, { isRevenue: true }),
  L('Rent', ['Indirect Expenses'], 100000, 100000, { isRevenue: true }),
  L('Cash', ['Cash in Hand'], 450000, 200000),
];
t('one owner gets everything without being told which ledgers are theirs', () => {
  const rr = build({ ledgers: shop, constitution: 'proprietorship', owners: [{ name: 'Mohan Lal' }] });
  assert.equal(rr.pl.current.pat, toPaise(200000));
  assert.equal(rr.bs.current.ownersCapital, toPaise(450000));
  assert.equal(rr.bs.current.difference, 0);
  const c = rr.owners.capital;
  const id = rr.ownersUsed[0].id;
  assert.equal(row(c, 'opening').byOwner[id], toPaise(200000));
  assert.equal(row(c, 'introduced').byOwner[id], toPaise(200000));
  assert.equal(row(c, 'drawings').byOwner[id], toPaise(150000));
  assert.equal(row(c, 'share').byOwner[id], toPaise(200000));
  assert.equal(row(c, 'closing').byOwner[id], toPaise(450000));
  assert.equal(rr.caption('owners_capital'), 'Proprietor’s capital account');
});
t('a proprietor with no owner recorded still gets a tied statement and a HIGH check', () => {
  const rr = build({ ledgers: shop, constitution: 'proprietorship' });
  assert.ok(rr.checks.some((x) => x.id === 'OWN-NONE' && x.severity === 'HIGH'));
  assert.equal(row(rr.owners.capital, 'closing').total, rr.bs.current.ownersCapital);
  assert.equal(rr.bs.current.difference, 0);
});
t('a company build is untouched by all this', () => {
  const rr = build({ ledgers: [
    L('Share Capital', ['Capital Account'], -1000000, -1000000),
    L('Profit & Loss A/c', ['Reserves & Surplus'], -200000, -200000),
    L('HDFC Bank', ['Bank Accounts'], 1500000, 1200000),
    L('Sales', ['Sales Accounts'], -300000, 0, { isRevenue: true }),
  ] });
  assert.equal(rr.division, 'AS');
  assert.equal(rr.owners, null);
  assert.equal(rr.bs.current.reserves, toPaise(500000));
  assert.equal(rr.bs.current.difference, 0);
});

console.log('\n── helpers ──');
t('normaliseOwners cleans ratios, ledgers and splits', () => {
  const o = normaliseOwners([{ name: ' A ', ratio: '2', ledgers: { capital: 'A Cap' }, split: '1,000.50' }])[0];
  assert.equal(o.name, 'A'); assert.equal(o.ratio, 2);
  assert.deepEqual(o.ledgers.capital, ['A Cap']); assert.equal(o.split, 100050);
});
t('autoAssign leaves an ambiguous ledger alone', () => {
  const two = normaliseOwners([{ name: 'Kumar A' }, { name: 'Kumar B' }]);
  const { assignments } = autoAssign(two, [{ name: 'Kumar Capital', perPeriod: { current: { lineId: 'owners_capital' } } }]);
  assert.equal(assignments.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
