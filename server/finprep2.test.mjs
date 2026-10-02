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

console.log('\n── a second import, and what changed ──');
await t('the variance report lists changed, new and dropped ledgers against the previous import', async () => {
  const before = await call('GET', `/engagements/${engId}/variance`);
  assert.equal(before.summary, null, 'one import has nothing to compare with');
  // the furniture ledger was renamed, rent went up by 10,000 and the bank down by the same
  const again = firm.map((l) => l.name === 'Furniture' ? { ...l, name: 'Furniture & Fixtures' }
    : l.name === 'Shop Rent' ? { ...l, current: 130000 }
    : l.name === 'HDFC Bank' ? { ...l, current: 1050000 } : l);
  const s = await call('POST', `/engagements/${engId}/snapshots`, { source: 'excel', method: 'file', ledgers: again });
  assert.ok(s.ok, s.error); assert.equal(s.balanced, true);
  const v = await call('GET', `/engagements/${engId}/variance`);
  assert.ok(v.ok, v.error);
  assert.equal(v.from.source, 'tally'); assert.equal(v.to.source, 'excel');
  const by = Object.fromEntries(v.rows.map((r) => [r.ledger, r]));
  assert.equal(by['Furniture'].status, 'dropped');
  assert.equal(by['Furniture & Fixtures'].status, 'added');
  assert.equal(by['Shop Rent'].status, 'changed'); assert.equal(by['Shop Rent'].deltaCurrent, 10000);
  assert.equal(by['HDFC Bank'].deltaCurrent, -10000);
  assert.equal(v.summary.changed, 2); assert.equal(v.summary.added, 1); assert.equal(v.summary.dropped, 1);
  assert.ok(!by['Sales'], 'an unchanged ledger is not listed');
});
await t('approved heads and the owners survive the re-import by ledger name', async () => {
  const j = await call('GET', `/engagements/${engId}/statements`);
  assert.equal(j.meta.snapshotId !== undefined, true);
  const sched = j.ownersAccounts.capital;
  assert.equal(sched.rows.find((x) => x.key === 'closing').total, 820000 + 430000);
  assert.equal(j.balanceSheet.difference.current, 0);
});

console.log('\n── adjustment entries, by ledger name ──');
let jid;
await t('an entry is recorded by ledger name and applied once approved', async () => {
  const j = await call('POST', `/engagements/${engId}/journals`, { narration: 'Rent accrued for March', kind: 'provision',
    entries: [{ ledgerKey: 'Shop Rent', amount: 5000 }, { lineId: 'other_current_liabilities', amount: -5000 }] });
  assert.ok(j.ok, j.error); jid = j.journalId;
  let s = await call('GET', `/engagements/${engId}/statements`);
  assert.ok(s.checks.some((c) => c.id === 'JRN-PENDING'), 'pending entries are flagged');
  assert.equal(s.profitAndLoss.pat.current, 430000, 'not applied while pending');
  const a = await call('POST', `/engagements/${engId}/journals/${jid}/approve`, { approved: true });
  assert.ok(a.ok && a.approved);
  s = await call('GET', `/engagements/${engId}/statements`);
  assert.equal(s.profitAndLoss.pat.current, 425000);
  assert.equal(s.balanceSheet.difference.current, 0);
  assert.equal(s.journals[0].entries[0].ledgerName, 'Shop Rent');
  assert.equal(s.journals[0].entries[1].lineCaption, 'Other current liabilities');
});
await t('an entry to a ledger not in the books, or that does not balance, is refused', async () => {
  const j = await call('POST', `/engagements/${engId}/journals`, { narration: 'x', entries: [{ ledgerKey: 'No Such Ledger', amount: 1 }, { ledgerKey: 'Shop Rent', amount: -1 }] });
  assert.equal(j.ok, false); assert.match(j.error, /not in the trial balance/);
  const k = await call('POST', `/engagements/${engId}/journals`, { narration: 'x', entries: [{ ledgerKey: 'Shop Rent', amount: 1 }, { ledgerKey: 'HDFC Bank', amount: -2 }] });
  assert.equal(k.ok, false); assert.match(k.error, /does not balance/);
});
await t('the entry survives a re-import of the books; a ledger that disappears is flagged CRITICAL until the entry is edited', async () => {
  const renamed = firm.map((l) => l.name === 'Shop Rent' ? { ...l, name: 'Rent - Shop', current: 130000 } : l.name === 'HDFC Bank' ? { ...l, current: 1050000 } : l);
  const s0 = await call('POST', `/engagements/${engId}/snapshots`, { source: 'excel', method: 'file', ledgers: renamed });
  assert.ok(s0.ok && s0.balanced);
  let s = await call('GET', `/engagements/${engId}/statements`);
  const flag = s.checks.find((c) => c.id.startsWith('JRN-LEDGER'));
  assert.ok(flag && flag.severity === 'CRITICAL', 'missing ledger must be flagged');
  assert.equal(s.journals[0].entries[0].missing, true);
  // edit the entry onto the renamed ledger: the old one is superseded, the new one applies
  const e = await call('PUT', `/engagements/${engId}/journals/${jid}`, { narration: 'Rent accrued for March', kind: 'provision', approve: true,
    entries: [{ ledgerKey: 'Rent - Shop', amount: 5000 }, { lineId: 'other_current_liabilities', amount: -5000 }] });
  assert.ok(e.ok, e.error); assert.equal(e.supersedes, jid); jid = e.journalId;
  s = await call('GET', `/engagements/${engId}/statements`);
  assert.ok(!s.checks.some((c) => c.id.startsWith('JRN-LEDGER')));
  assert.equal(s.journals.length, 1);
  assert.equal(s.profitAndLoss.pat.current, 425000);
});
await t('a withdrawn entry is no longer applied', async () => {
  const d0 = await call('DELETE', `/engagements/${engId}/journals/${jid}`);
  assert.ok(d0.ok);
  const s = await call('GET', `/engagements/${engId}/statements`);
  assert.equal(s.journals.length, 0);
  assert.equal(s.profitAndLoss.pat.current, 430000);
});

console.log('\n── what the preparer types: footnotes, MSMED, PPE depreciation, sign-off, policies ──');
await t('text inputs round-trip and reach the payload: footnote, MSMED block, sign-off, policies', async () => {
  const put = await call('PUT', `/engagements/${engId}/text`, { inputs: {
    'footnote:trade_payables_others': 'Creditors are unsecured and payable within 60 days.',
    'msme:principal': '120000', 'msme:interest': '0',
    'sign:firm': 'ABC & Associates', 'sign:frn': '012345N', 'sign:partner': 'CA Test', 'sign:membership': '123456', 'sign:place': 'Faridabad', 'sign:date': '2026-09-01',
    'policies': 'Basis: historical cost.', 'bad key with spaces': 'ignored', 'empty:thing': '' } });
  assert.ok(put.ok, put.error);
  assert.equal(put.inputs['sign:firm'], 'ABC & Associates');
  assert.equal(put.inputs['bad key with spaces'], undefined);
  assert.equal(put.inputs['empty:thing'], undefined);
  const s = await call('GET', `/engagements/${engId}/statements`);
  const tp = s.notes.find((n) => n.lineId === 'trade_payables_others');
  assert.equal(tp.footnote, 'Creditors are unsecured and payable within 60 days.');
  assert.equal(tp.msme.provided, true);
  assert.equal(tp.msme.rows[0].amount, 120000);
  assert.equal(s.meta.auditor.firm, 'ABC & Associates'); assert.equal(s.meta.place, 'Faridabad'); assert.equal(s.meta.signedOn, '2026-09-01');
  assert.equal(s.text.policies, 'Basis: historical cost.'); assert.equal(s.policies, 'Basis: historical cost.');
  // removing a key
  await call('PUT', `/engagements/${engId}/text`, { inputs: { 'footnote:trade_payables_others': null } });
  const s2 = await call('GET', `/engagements/${engId}/statements`);
  assert.equal(s2.notes.find((n) => n.lineId === 'trade_payables_others').footnote, undefined);
});
await t('the PPE note carries the asset schedule; keyed depreciation that disagrees with the P&L is flagged', async () => {
  const s = await call('GET', `/engagements/${engId}/statements`);
  const ppe = s.notes.find((n) => n.lineId === 'ppe');
  assert.equal(ppe.kind, 'ppe');
  assert.equal(ppe.schedule.rows[0].ledger, 'Furniture');
  assert.equal(ppe.schedule.rows[0].opening, 300000);
  assert.equal(s.ppe.totals.closing, 300000);
  await call('PUT', `/engagements/${engId}/text`, { inputs: { 'ppe:Furniture:dep': '30000', 'ppe:Furniture:personal': '10' } });
  const s2 = await call('GET', `/engagements/${engId}/statements`);
  const sched = s2.notes.find((n) => n.lineId === 'ppe').schedule;
  assert.equal(sched.rows[0].depreciation, 30000);
  assert.equal(sched.rows[0].personalUse, 3000);
  assert.ok(s2.checks.some((c) => c.id === 'PPE-DEP'), 'the books charge no depreciation, the schedule shows 30,000');
  await call('PUT', `/engagements/${engId}/text`, { inputs: { 'ppe:Furniture:dep': '', 'ppe:Furniture:personal': '' } });
});
await t('a starting text for the policies names the firm’s constitution and the framework', async () => {
  const d = await call('GET', `/engagements/${engId}/policies/default`);
  assert.match(d.text, /ICAI Guidance Note/);
  assert.match(d.text, /Partners’ capital/);
  assert.match(d.text, /CONFIRM/);
});

console.log('\n── next year: carry forward ──');
let eng2;
await t('clients group their engagements; the next year finds last year', async () => {
  const j = await call('POST', '/engagements', { clientName: 'M/s Kumar Traders', pan: 'AAAFK1234A', constitution: 'partnership', fyStart: '2026-04-01', fyEnd: '2027-03-31' });
  eng2 = j.id;
  const clients = await call('GET', '/clients');
  const kt = clients.clients.find((c) => c.name === 'M/s Kumar Traders');
  assert.equal(kt.engagements.length, 2);
  assert.equal(kt.engagements[0].fyEnd, '2027-03-31', 'newest first');
  const cf = await call('GET', `/engagements/${eng2}/carry-forward`);
  assert.equal(cf.candidate.id, engId);
  assert.ok(cf.candidate.owners === 2);
});
await t('carry-forward copies approved heads, captions and owners for ledgers still in the books, and never overwrites', async () => {
  // last year the preparer approved a head for the furniture and a caption for the rent
  await call('POST', `/engagements/${engId}/mappings`, { mappings: [{ ledgerKey: 'Furniture', lineId: 'ppe', approved: true }, { ledgerKey: 'Sales', lineId: 'revenue_operations', approved: true }] });
  await call('POST', `/engagements/${engId}/subgroups`, { subgroups: [{ ledgerKey: 'Rent - Shop', label: 'Rent' }] });
  const refused = await call('POST', `/engagements/${eng2}/carry-forward`, {});
  assert.equal(refused.ok, false, 'needs this year’s books first');
  const next = firm.filter((l) => l.name !== 'Furniture').map((l) => ({ ...l, prior: l.current }));   // the furniture was sold; last year's closing is this year's opening
  const bank = next.find((l) => l.name === 'HDFC Bank'); bank.current = bank.prior + 300000;            // the sale proceeds
  await call('POST', `/engagements/${eng2}/snapshots`, { source: 'tally', method: 'live', ledgers: next });
  await call('POST', `/engagements/${eng2}/mappings`, { mappings: [{ ledgerKey: 'Sales', lineId: 'other_income', approved: true }] });   // decided this year
  const cf = await call('POST', `/engagements/${eng2}/carry-forward`, {});
  assert.ok(cf.ok, cf.error);
  assert.equal(cf.carried.owners, 2);
  assert.equal(cf.skipped.alreadySet, 1, 'Sales was decided this year and is left alone');
  assert.ok(cf.skipped.notInBooks.includes('Furniture'));
  const s = await call('GET', `/engagements/${eng2}/statements`);
  assert.equal(s.trialBalance.find((r) => r.ledger === 'Sales').lineId, 'other_income');
  assert.equal(s.ownersAccounts.capital.owners.length, 2);
  const own = await call('GET', `/engagements/${eng2}/owners`);
  assert.deepEqual(own.owners.map((o) => o.ratio), [60, 40]);
  assert.ok(own.owners.every((o) => o.split == null), 'last year’s manual split is never carried');
});

console.log(`\n${pass} passed, ${fail} failed`);
srv.close();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
