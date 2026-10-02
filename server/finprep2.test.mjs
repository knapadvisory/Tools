/* End-to-end test of the engagement API against a scratch database:
 * a partnership firm from creation to statements and release.
 * Run: node server/finprep2.test.mjs                                        */
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knap-fin2-'));
process.env.KNAP_UPLOADS = path.join(dir, 'uploads');
const { openAt } = await import('./db.js');
openAt(path.join(dir, 'test.db'));
const { router } = await import('./routes/finprep2.js');
const { router: inputs } = await import('./routes/inputs.js');

const app = express();
app.use('/api/fin2', router);
app.use('/api/fin2', inputs);
const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/fin2`;
const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-actor': 'test' },
    body: body ? JSON.stringify(body) : undefined });
  return r.json();
};

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
const L = (name, path, cur, pri, extra = {}) =>
  ({ name, group: path[0], primary: path[path.length - 1], groupPath: path, current: cur, prior: pri, ...extra });

console.log('\n── constitutions ──');
await t('the server lists the constitutions and the format each reports in', async () => {
  const j = await call('GET', '/constitutions');
  assert.ok(j.ok);
  const firm = j.constitutions.find((c) => c.key === 'partnership');
  assert.equal(firm.division, 'NCE');
  assert.equal(j.constitutions.find((c) => c.key === 'company').division, 'AS');
});

let engId;
await t('a partnership engagement reports in the NCE format whatever framework was asked for', async () => {
  const j = await call('POST', '/engagements', { clientName: 'M/s Kumar Traders', pan: 'AAAFK1234A', constitution: 'partnership',
    fyStart: '2025-04-01', fyEnd: '2026-03-31', division: 'INDAS' });
  assert.ok(j.ok, j.error);
  assert.equal(j.division, 'NCE');
  engId = j.id;
  const list = await call('GET', '/engagements');
  const e = list.engagements.find((x) => x.id === engId);
  assert.equal(e.constitution, 'partnership');
  assert.equal(e.constitutionLabel, 'Partnership firm');
  assert.equal(e.pan, 'AAAFK1234A');
});
await t('an unknown constitution is refused', async () => {
  const j = await call('POST', '/engagements', { clientName: 'X', constitution: 'cooperative', fyStart: '2025-04-01', fyEnd: '2026-03-31' });
  assert.equal(j.ok, false);
});

console.log('\n── the firm’s books ──');
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
await t('the snapshot stores gross movements and seals with the books balanced', async () => {
  const j = await call('POST', `/engagements/${engId}/snapshots`, { source: 'tally', method: 'live', periodFrom: '2025-04-01', periodTo: '2026-03-31', ledgers: firm });
  assert.ok(j.ok, j.error);
  assert.equal(j.balanced, true);
  const snaps = await call('GET', `/engagements/${engId}/snapshots`);
  assert.equal(snaps.snapshots[0].sealed, 1);
  assert.equal(snaps.snapshots[0].complete, 1);
});
await t('a snapshot whose books do not balance is sealed but NOT marked complete', async () => {
  const j2 = await call('POST', '/engagements', { clientName: 'Unbalanced Ltd', constitution: 'company', fyStart: '2025-04-01', fyEnd: '2026-03-31' });
  const s = await call('POST', `/engagements/${j2.id}/snapshots`, { ledgers: [L('Cash', ['Cash in Hand'], 100, 0)] });
  assert.equal(s.balanced, false);
  const snaps = await call('GET', `/engagements/${j2.id}/snapshots`);
  assert.equal(snaps.snapshots[0].sealed, 1);
  assert.equal(snaps.snapshots[0].complete, 0, 'sealing must not overwrite "complete"');
});

console.log('\n── statements before and after the partners are recorded ──');
await t('without partners the capital account carries the profit in total and says so', async () => {
  const j = await call('GET', `/engagements/${engId}/statements`);
  assert.ok(j.ok, j.error);
  assert.equal(j.meta.division, 'NCE');
  assert.equal(j.meta.framework, 'ICAI Guidance Note on Financial Statements of Non-Corporate Entities');
  assert.equal(j.meta.sectionTitles.EQUITY, 'Owners’ funds');
  const eq = j.balanceSheet.equityAndLiabilities[0];
  assert.equal(eq.title, 'Owners’ funds');
  const cap = eq.rows.find((r) => r.lineId === 'owners_capital');
  assert.equal(cap.caption, 'Partners’ capital accounts');
  assert.equal(cap.current, 820000 + 440000);
  assert.equal(cap.prior, 700000);
  assert.ok(!eq.rows.some((r) => r.lineId === 'share_capital'));
  assert.ok(j.checks.some((c) => c.id === 'OWN-NONE'));
  assert.equal(j.balanceSheet.difference.current, 0);
  assert.equal(j.ownersAccounts.capital.rows.find((r) => r.key === 'closing').total, 1260000);
});
await t('the owners are saved, auto-matched to their ledgers, and the profit shared 60:40', async () => {
  const put = await call('PUT', `/engagements/${engId}/owners`, { profitTo: 'capital', owners: [
    { name: 'Ramesh Kumar', role: 'Partner', pan: 'AAAPR1111A', ratio: 60 },
    { name: 'Suresh Kumar', role: 'Partner', pan: 'AAAPS2222B', ratio: 40 },
  ] });
  assert.ok(put.ok, put.error);
  assert.equal(put.owners.length, 2);
  const j = await call('GET', `/engagements/${engId}/statements`);
  const sched = j.ownersAccounts.capital;
  const [r, s] = sched.owners;
  const row = (k) => sched.rows.find((x) => x.key === k);
  assert.equal(row('share').byOwner[r.id], 264000);
  assert.equal(row('share').byOwner[s.id], 176000);
  assert.equal(row('closing').byOwner[r.id], 400000 + 100000 + 120000 + 264000 - 60000);
  assert.equal(row('closing').total, 1260000);
  assert.ok(j.ownersAccounts.assignments.some((a) => a.ledger === 'Remuneration - Suresh' && a.owner === 'Suresh Kumar'));
  assert.ok(!j.checks.some((c) => c.id === 'OWN-NONE'));
  assert.equal(j.meta.owners.length, 2);
  assert.equal(j.meta.owners[0].pan, 'AAAPR1111A');
  const note = j.notes.find((n) => n.lineId === 'owners_capital');
  assert.equal(note.kind, 'owners');
  assert.equal(note.current, 1260000);
});
await t('the chart offered for grouping is the NCE chart with the firm’s wording', async () => {
  const j = await call('GET', '/lines?division=NCE&constitution=partnership');
  const ids = j.lines.map((l) => l.lineId);
  assert.ok(ids.includes('owners_capital') && !ids.includes('share_capital'));
  assert.equal(j.lines.find((l) => l.lineId === 'owners_capital').caption, 'Partners’ capital accounts');
  assert.equal(j.lines.find((l) => l.lineId === 'owners_capital').sectionTitle, 'Owners’ funds');
});
await t('the trial balance rows carry the gross movements', async () => {
  const j = await call('GET', `/engagements/${engId}/statements`);
  const r = j.trialBalance.find((x) => x.ledger === 'Ramesh Capital A/c');
  assert.equal(r.movDr, 60000); assert.equal(r.movCr, 220000);
  assert.equal(r.lineCaption, 'Partners’ capital accounts');
});
await t('a manual split that does not add up blocks release', async () => {
  const cur = (await call('GET', `/engagements/${engId}/owners`)).owners;
  await call('PUT', `/engagements/${engId}/owners`, { owners: cur.map((o) => ({ ...o, split: 1 })) });
  const j = await call('GET', `/engagements/${engId}/statements`);
  assert.ok(j.checks.some((c) => c.id === 'OWN-SPLIT' && c.severity === 'CRITICAL'));
  const rel = await call('POST', `/engagements/${engId}/release`, { status: 'final' });
  assert.equal(rel.ok, false);
  await call('PUT', `/engagements/${engId}/owners`, { owners: cur.map((o) => ({ ...o, split: null })) });
  const rel2 = await call('POST', `/engagements/${engId}/release`, { status: 'final' });
  assert.ok(rel2.ok, rel2.error);
});

console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
