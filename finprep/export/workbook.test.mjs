/* ============================================================================
 * workbook.test.mjs — acceptance tests for the formula-linked Excel export.
 *
 * Run: node finprep/export/workbook.test.mjs
 *
 * The payload is not hand-written: it is produced by running the real engine
 * over a small, balanced, two-period trial balance, then converting integer
 * paise to rupees at the export boundary — exactly what the application does.
 *
 * The trial balance deliberately contains DUPLICATE LEDGER NAMES, twice over:
 *   · two "Axis Bank" ledgers that land in DIFFERENT heads (a balance and an
 *     overdraft), so each note line must reference its own row;
 *   · two "Sundry Creditors A" ledgers in the SAME head, which the note
 *     aggregates into one line and which must therefore reference BOTH rows.
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { build } from '../core/engine.js';
import { buildCashFlow } from '../core/cashflow.js';
import { presentationModel } from '../core/notes.js';
import { toRupees } from '../core/money.js';
import { presentationValue, captionFor } from '../core/schedule3.js';
import { buildWorkbook } from './workbook.js';

/* ---- ExcelJS: a UMD browser build, so copy it to .cjs and require it ---- */
const src = '/home/user/Tools/gstr2b/exceljs.js';
const tmp = path.join(os.tmpdir(), 'finprep-exceljs-test.cjs');
fs.copyFileSync(src, tmp);
const ExcelJS = createRequire(import.meta.url)(tmp);

/* ------------------------------------------------------------ test harness */
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.005, `${what}: ${a} vs ${b}`);

/* ---------------------------------------------------- the trial balance ---- */
const L = (name, pathArr, cur, pri, extra = {}) => ({
  name, group: pathArr[0], primary: pathArr[pathArr.length - 1], groupPath: pathArr,
  current: cur, prior: pri, ...extra,
});

const ledgers = [
  L('Share Capital', ['Capital Account'], -1000000, -1000000),
  L('Profit & Loss A/c', ['Reserves & Surplus'], -200000, -200000),
  L('Plant & Machinery', ['Fixed Assets'], 1500000, 1600000),
  L('HDFC Bank', ['Bank Accounts'], 560000, 400000),
  L('Axis Bank', ['Bank Accounts'], 150000, 100000),          // a balance  -> cash
  L('Axis Bank', ['Bank Accounts'], -150000, -100000),        // an overdraft -> short-term borrowings
  L('Sundry Creditors A', ['Sundry Creditors'], -300000, -300000),
  L('Sundry Creditors A', ['Sundry Creditors'], -120000, -120000),  // same name, same head
  L('XYZ Ltd', ['Sundry Debtors'], 120000, 120000),
  L('Sales', ['Sales Accounts'], -1000000, -900000, { isRevenue: true }),
  L('Salary', ['Indirect Expenses'], 300000, 300000, { isRevenue: true }),
  L('Depreciation', ['Indirect Expenses'], 140000, 100000, { isRevenue: true }),
];
const journals = [{
  id: 'J1', approved: true, period: 'current', narration: 'Provision for current tax',
  entries: [{ lineId: 'current_tax', amount: 160000 }, { lineId: 'st_provisions', amount: -160000 }],
}];

const r = build({ ledgers, journals, division: 'AS' });
const cf = buildCashFlow(r);
const pm = presentationModel(r);

/* ---------------------------------------------- engine result -> payload --- */
const R = (paise) => toRupees(paise || 0);
const mapRow = (x) => ({ lineId: x.lineId || null, caption: x.caption, note: x.note ?? null,
                         current: R(x.current), prior: R(x.prior) });
const mapSection = (s) => ({ key: s.key, title: s.title, rows: s.rows.map(mapRow),
                             total: { current: R(s.total.current), prior: R(s.total.prior) } });
const mapAmtList = (xs) => (xs || []).map((x) => ({ label: x.label, amount: R(x.amount) }));

const meta = {
  entity: 'Meridian Components Private Limited',
  cin: 'U29100MH2016PTC284512',
  division: 'AS',
  currentLabel: '31 March 2026',
  priorLabel: '31 March 2025',
  status: 'Draft',
  snapshotId: 'SNP-2026-0007',
  takenAt: '2026-05-14T09:20:00+05:30',
  scaleLabel: 'Amounts in ₹',
  auditor: { firm: 'Rao & Iyer', frn: '104512W', partner: 'S. Rao', membership: '210447' },
  directors: [{ name: 'A. Nadkarni', din: '01234567' }, { name: 'P. Shah', din: '07654321' }],
  place: 'Mumbai',
  signedOn: '2026-05-28',
};

const trialBalance = r.ledgers.map((l) => {
  const cl = l.perPeriod.current.lineId, plId = l.perPeriod.prior.lineId;
  const bal = l.perPeriod.current.amount || l.perPeriod.prior.amount;
  return {
    ledger: l.name, group: l.group, primary: l.primary,
    drcr: bal >= 0 ? 'Dr' : 'Cr',
    current: R(presentationValue(cl, l.perPeriod.current.amount)),
    prior: R(presentationValue(plId, l.perPeriod.prior.amount)),
    lineId: cl, lineCaption: captionFor(cl, r.division), note: r.noteNumbers.get(cl) || null,
  };
});

const notes = pm.notes.map((n) => {
  const out = {
    number: n.number, lineId: n.lineId, caption: n.caption,
    current: R(n.current), prior: R(n.prior),
    subLines: n.subLines.map((s) => ({ name: s.name, current: R(s.current), prior: R(s.prior), reason: s.reason,
      members: (s.members || []).map((m) => ({ name: m.name, current: R(m.current), prior: R(m.prior) })) })),
    requires: n.requires,
  };
  // Reserves close on the year's result, which is not a ledger balance: the note
  // must carry it, otherwise the note total is the opening balance and the face
  // figure would not be the note total. (The export refuses to link a face
  // figure to a note total that is not equal to it — this is what feeds it.)
  if (n.lineId === 'reserves_surplus') {
    out.subLines.push({ name: 'Profit for the year', current: R(r.pl.current.pat), prior: R(r.pl.prior.pat),
                        reason: 'transferred from the statement of profit and loss' });
    out.current = R(r.bs.current.reserves);
    out.prior = R(r.bs.prior.reserves);
  }
  return out;
});

const basePayload = {
  meta,
  trialBalance,
  balanceSheet: {
    equityAndLiabilities: pm.balanceSheet.equityAndLiabilities.map(mapSection),
    assets: pm.balanceSheet.assets.map(mapSection),
    totalEquityAndLiabilities: { current: R(pm.balanceSheet.totalEquityAndLiabilities.current),
                                 prior: R(pm.balanceSheet.totalEquityAndLiabilities.prior) },
    totalAssets: { current: R(pm.balanceSheet.totalAssets.current),
                   prior: R(pm.balanceSheet.totalAssets.prior) },
    difference: { current: R(pm.balanceSheet.difference.current), prior: R(pm.balanceSheet.difference.prior) },
  },
  profitAndLoss: {
    income: pm.profitAndLoss.income.map(mapRow),
    totalIncome: mapRow(pm.profitAndLoss.totalIncome),
    expenses: pm.profitAndLoss.expenses.map(mapRow),
    totalExpenses: mapRow(pm.profitAndLoss.totalExpenses),
    pbtBefore: pm.profitAndLoss.pbtBefore ? mapRow(pm.profitAndLoss.pbtBefore) : null,
    exceptional: pm.profitAndLoss.exceptional ? mapRow(pm.profitAndLoss.exceptional) : null,
    pbt: mapRow(pm.profitAndLoss.pbt),
    taxRows: pm.profitAndLoss.taxRows.map(mapRow),
    pat: mapRow(pm.profitAndLoss.pat),
  },
  notes,
  cashFlow: {
    operating: {
      pbt: R(cf.operating.pbt),
      adjustments: mapAmtList(cf.operating.adjustments),
      operatingProfitBeforeWC: R(cf.operating.operatingProfitBeforeWC),
      workingCapital: mapAmtList(cf.operating.workingCapital),
      cashGenerated: R(cf.operating.cashGenerated),
      taxPaid: R(cf.operating.taxPaid),
      net: R(cf.operating.net),
    },
    investing: { items: mapAmtList(cf.investing.items), net: R(cf.investing.net) },
    financing: { items: mapAmtList(cf.financing.items), net: R(cf.financing.net) },
    netChange: R(cf.netChange), openingCash: R(cf.openingCash),
    closingCashComputed: R(cf.closingCashComputed), closingCashPerBS: R(cf.closingCashPerBS),
    unreconciled: R(cf.unreconciled), reconciled: cf.reconciled,
    assumptions: cf.assumptions, notes: cf.notes,
  },
  checks: [...r.checks, ...cf.checks].map((c) => ({
    id: c.id, severity: c.severity, message: c.message,
    amount: c.amount == null ? null : R(c.amount),
  })),
  disclosures: pm.disclosures,
};

const clone = (o) => JSON.parse(JSON.stringify(o));

/* --------------------------------------------------- workbook inspection --- */
const textOf = (cell) => {
  const v = cell && cell.value;
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.richText === 'object') return (v.richText || []).map((x) => x.text).join('');
  return '';
};
const formulaOf = (cell) => (cell && cell.value && typeof cell.value === 'object' && cell.value.formula) || null;
/**
 * The cached result. ExcelJS's `value` getter omits a falsy result, but the
 * model keeps it and the writer emits it, so read `cell.result` for a formula.
 */
const resultOf = (cell) => {
  if (!cell) return null;
  if (formulaOf(cell) != null) return cell.result == null ? null : cell.result;
  return typeof cell.value === 'number' ? cell.value : null;
};

function eachCell(ws, fn) {
  ws.eachRow({ includeEmpty: false }, (row, rn) =>
    row.eachCell({ includeEmpty: false }, (cell, cn) => fn(cell, rn, cn)));
}
function allText(ws) {
  const out = [];
  eachCell(ws, (c) => { const s = textOf(c); if (s) out.push(s); });
  return out.join('\n');
}
/** Trial-balance data rows: identified by the mandated Dr/Cr column. */
function tbRows(ws) {
  const out = [];
  eachCell(ws, (cell, rn, cn) => {
    if (cn !== 4) return;
    const s = textOf(cell);
    if (s !== 'Dr' && s !== 'Cr') return;
    out.push({
      row: rn, ledger: textOf(ws.getRow(rn).getCell(1)), drcr: s,
      current: resultOf(ws.getRow(rn).getCell(5)), prior: resultOf(ws.getRow(rn).getCell(6)),
      usedIn: textOf(ws.getRow(rn).getCell(7)),
    });
  });
  return out;
}
/** Notes leaves and totals, tagged with the note they sit under. */
function noteRows(ws) {
  const leaves = [], totals = new Map();
  let cur = null;
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    const a = textOf(row.getCell(1));
    const m = /^(\d+)\.\s\s(.+)$/.exec(a);
    if (m) { cur = { number: Number(m[1]), caption: m[2] }; return; }
    if (!cur) return;
    if (a.trim() === 'Total') { totals.set(cur.number, { row: rn, caption: cur.caption }); return; }
    if (/^ {4}\S/.test(a)) leaves.push({ row: rn, note: cur.number, caption: cur.caption, name: a.trim() });
  });
  return { leaves, totals };
}

/* ================================ tests ================================== */
console.log('\n── engine fixture ──');
t('the fixture trial balance is balanced and both balance sheets tie', () => {
  assert.equal(r.tbSum.current, 0);
  assert.equal(r.tbSum.prior, 0);
  assert.equal(r.bs.current.difference, 0);
  assert.equal(r.bs.prior.difference, 0);
});
t('the fixture really does contain duplicate ledger names', () => {
  assert.equal(ledgers.filter((l) => l.name === 'Axis Bank').length, 2);
  assert.equal(ledgers.filter((l) => l.name === 'Sundry Creditors A').length, 2);
  const axis = r.ledgers.filter((l) => l.name === 'Axis Bank').map((l) => l.perPeriod.current.lineId);
  assert.deepEqual(axis.sort(), ['cash_and_equivalents', 'st_borrowings']);
});

const wb = buildWorkbook(ExcelJS, basePayload);
const BS = wb.getWorksheet('Balance Sheet');
const PL = wb.getWorksheet('Profit & Loss');
const CF = wb.getWorksheet('Cash Flow');
const NT = wb.getWorksheet('Notes');
const TB = wb.getWorksheet('Trial Balance');
const DS = wb.getWorksheet('Disclosures');
const RV = wb.getWorksheet('Review');

console.log('\n── sheets ──');
t('every sheet exists, in the required order', () => {
  assert.deepEqual(wb.worksheets.map((w) => w.name),
    ['Balance Sheet', 'Profit & Loss', 'Cash Flow', 'Notes', 'Trial Balance', 'Disclosures', 'Review']);
});
t('every sheet carries entity, CIN, its period label, the scale and the status', () => {
  for (const ws of wb.worksheets) {
    const s = allText(ws);
    assert.ok(s.includes(meta.entity), `${ws.name}: entity missing`);
    assert.ok(s.includes(meta.cin), `${ws.name}: CIN missing`);
    assert.ok(s.includes(meta.currentLabel), `${ws.name}: period label missing`);
    assert.ok(s.includes(meta.scaleLabel), `${ws.name}: scale label missing`);
    assert.ok(/Status: Draft/.test(s), `${ws.name}: status missing`);
  }
});
t('every sheet freezes its header rows and is set up for A4 portrait, fit to width', () => {
  for (const ws of wb.worksheets) {
    assert.ok(ws.views && ws.views[0] && ws.views[0].state === 'frozen' && ws.views[0].ySplit > 0, ws.name);
    assert.equal(ws.pageSetup.orientation, 'portrait', ws.name);
    assert.equal(ws.pageSetup.paperSize, 9, ws.name);
    assert.equal(ws.pageSetup.fitToWidth, 1, ws.name);
  }
});
t('the signature block is on the face statements only', () => {
  assert.ok(/Chartered Accountants/.test(allText(BS)));
  assert.ok(/For and on behalf of the Board of Directors/.test(allText(BS)));
  assert.ok(/Membership no\. 210447/.test(allText(PL)));
  assert.ok(/DIN 01234567/.test(allText(PL)));
  for (const ws of [RV, DS, CF, NT, TB]) {
    assert.ok(!/Chartered Accountants/.test(allText(ws)), `${ws.name} must not be signed`);
    assert.ok(!/on behalf of the Board/.test(allText(ws)), `${ws.name} must not be signed`);
  }
});

console.log('\n── trial balance sheet ──');
const rows = tbRows(TB);
t('the trial balance carries the mandated columns', () => {
  const head = TB.getRow(6);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((c) => textOf(head.getCell(c))),
    ['Ledger', 'Tally group', 'Primary group', 'Dr/Cr', '31 March 2026', '31 March 2025', 'Used in note']);
});
t('debits and credits are totalled separately and agree', () => {
  const dr = findRow(TB, 'Total — debits'), cr = findRow(TB, 'Total — credits');
  assert.ok(dr && cr, 'both control totals must be present');
  assert.ok(/^SUMIF\(D\d+:D\d+,"Dr",E\d+:E\d+\)$/.test(formulaOf(TB.getRow(dr).getCell(5))));
  near(resultOf(TB.getRow(dr).getCell(5)), resultOf(TB.getRow(cr).getCell(5)), 'current debits vs credits');
  near(resultOf(TB.getRow(dr).getCell(6)), resultOf(TB.getRow(cr).getCell(6)), 'prior debits vs credits');
});
t('every ledger has its own row and nothing prints negative for its side', () => {
  assert.equal(rows.length, trialBalance.length);
  for (const row of rows) {
    assert.ok(row.current >= 0 && row.prior >= 0,
      `${row.ledger} printed negative (${row.current}/${row.prior}) — a side is not a minus sign`);
    assert.ok(row.drcr === 'Dr' || row.drcr === 'Cr');
  }
});

console.log('\n── notes → trial balance linkage ──');
const { leaves, totals } = noteRows(NT);
const axisRows = rows.filter((x) => x.ledger === 'Axis Bank');
const axisCash = axisRows.find((x) => /Cash and cash equivalents/.test(x.usedIn));
const axisOd = axisRows.find((x) => /borrowings/i.test(x.usedIn));

t('duplicate ledger names occupy their own rows and are both indexed', () => {
  assert.equal(axisRows.length, 2);
  assert.ok(axisCash && axisOd, 'both Axis Bank rows must be classified');
  assert.notEqual(axisCash.row, axisOd.row);
});
t('each "Axis Bank" note line points at ITS OWN trial-balance row', () => {
  const cashLeaf = leaves.find((l) => l.name === 'Axis Bank' && /Cash and cash equivalents/i.test(l.caption));
  const odLeaf = leaves.find((l) => l.name === 'Axis Bank' && /borrowings/i.test(l.caption));
  assert.ok(cashLeaf && odLeaf, 'both Axis Bank note lines must exist');

  const fCash = formulaOf(NT.getRow(cashLeaf.row).getCell(2));
  const fOd = formulaOf(NT.getRow(odLeaf.row).getCell(2));
  assert.equal(fCash, `'Trial Balance'!E${axisCash.row}`, 'cash note line points at the wrong row');
  assert.equal(fOd, `'Trial Balance'!E${axisOd.row}`, 'overdraft note line points at the wrong row');
  assert.notEqual(fCash, fOd, 'a duplicate name must not overwrite the first row in the index');

  // and the prior column too
  assert.equal(formulaOf(NT.getRow(cashLeaf.row).getCell(3)), `'Trial Balance'!F${axisCash.row}`);
  assert.equal(formulaOf(NT.getRow(odLeaf.row).getCell(3)), `'Trial Balance'!F${axisOd.row}`);

  // the cached values are each row's own value, not the other's
  near(resultOf(NT.getRow(cashLeaf.row).getCell(2)), axisCash.current, 'cash leaf');
  near(resultOf(NT.getRow(odLeaf.row).getCell(2)), axisOd.current, 'overdraft leaf');
  assert.notEqual(axisCash.current, null);
});
t('two ledgers of one name in ONE head are summed, not silently dropped', () => {
  const credRows = rows.filter((x) => x.ledger === 'Sundry Creditors A');
  assert.equal(credRows.length, 2);
  const leaf = leaves.find((l) => l.name === 'Sundry Creditors A');
  assert.ok(leaf, 'the note line must exist');
  const f = formulaOf(NT.getRow(leaf.row).getCell(2));
  assert.equal(f, `SUM('Trial Balance'!E${credRows[0].row},'Trial Balance'!E${credRows[1].row})`);
  near(resultOf(NT.getRow(leaf.row).getCell(2)), credRows[0].current + credRows[1].current, 'summed leaf');
});
t('every linked note leaf references a real trial-balance row carrying its figure', () => {
  const byRow = new Map(rows.map((x) => [x.row, x]));
  let linked = 0;
  for (const leaf of leaves) {
    const f = formulaOf(NT.getRow(leaf.row).getCell(2));
    if (!f) continue;
    linked++;
    const refs = [...f.matchAll(/'Trial Balance'!E(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(refs.length, `${leaf.name}: a linked leaf must reference the trial balance`);
    const total = refs.reduce((s, n) => { assert.ok(byRow.has(n), `row ${n} is not a ledger row`); return s + byRow.get(n).current; }, 0);
    near(total, resultOf(NT.getRow(leaf.row).getCell(2)), `${leaf.name} recalculates`);
  }
  assert.ok(linked >= 6, `expected most leaves to be linked, got ${linked}`);
});
t('each note total is a SUM over its own leaf rows and caches the payload figure', () => {
  for (const note of basePayload.notes) {
    const tot = totals.get(note.number);
    assert.ok(tot, `note ${note.number} has no total row`);
    const f = formulaOf(NT.getRow(tot.row).getCell(2));
    assert.ok(/^SUM\(B\d+:B\d+\)$/.test(f), `note ${note.number} total is not a SUM: ${f}`);
    const [, a, b] = /^SUM\(B(\d+):B(\d+)\)$/.exec(f);
    assert.equal(Number(a), tot.row - note.subLines.length);
    assert.equal(Number(b), tot.row - 1);
    near(resultOf(NT.getRow(tot.row).getCell(2)), note.current, `note ${note.number} current`);
    near(resultOf(NT.getRow(tot.row).getCell(3)), note.prior, `note ${note.number} prior`);
  }
});

console.log('\n── face → notes linkage ──');
t('balance sheet face amounts link to their note totals', () => {
  let linked = 0;
  BS.eachRow({ includeEmpty: false }, (row, rn) => {
    const noteNo = row.getCell(2).value;
    if (typeof noteNo !== 'number') return;
    const f = formulaOf(BS.getRow(rn).getCell(3));
    if (!f) return;
    linked++;
    const m = /^Notes!B(\d+)$/.exec(f);
    assert.ok(m, `face formula is not a note link: ${f}`);
    const target = totals.get(noteNo);
    assert.ok(target, `note ${noteNo} has no total row`);
    assert.equal(Number(m[1]), target.row, `note ${noteNo} face link points at the wrong row`);
    near(resultOf(BS.getRow(rn).getCell(3)), resultOf(NT.getRow(target.row).getCell(2)), `note ${noteNo}`);
    assert.equal(formulaOf(BS.getRow(rn).getCell(4)), `Notes!C${target.row}`);
  });
  assert.ok(linked >= 6, `expected the face to be linked, got ${linked} links`);
});
t('a specific face line — share capital — resolves through the note to the ledger', () => {
  let found = null;
  BS.eachRow({ includeEmpty: false }, (row, rn) => {
    if (textOf(row.getCell(1)).trim() === 'Share capital') found = rn;
  });
  assert.ok(found, 'share capital is not on the face');
  const f = formulaOf(BS.getRow(found).getCell(3));
  const noteRow = Number(/^Notes!B(\d+)$/.exec(f)[1]);
  const leafRow = noteRow - 1;
  const leafF = formulaOf(NT.getRow(leafRow).getCell(2));
  const tbRow = Number(/'Trial Balance'!E(\d+)/.exec(leafF)[1]);
  assert.equal(textOf(TB.getRow(tbRow).getCell(1)), 'Share Capital');
  near(resultOf(BS.getRow(found).getCell(3)), 1000000, 'share capital');
});
t('profit & loss face amounts link to their note totals', () => {
  let linked = 0;
  PL.eachRow({ includeEmpty: false }, (row, rn) => {
    const noteNo = row.getCell(2).value;
    if (typeof noteNo !== 'number') return;
    const f = formulaOf(PL.getRow(rn).getCell(3));
    if (!f) return;
    linked++;
    const target = totals.get(noteNo);
    assert.equal(f, `Notes!B${target.row}`);
  });
  assert.ok(linked >= 3, `expected the P&L face to be linked, got ${linked}`);
});

console.log('\n── totals and cached results ──');
function findRow(ws, text) {
  let at = null;
  ws.eachRow({ includeEmpty: false }, (row, rn) => { if (textOf(row.getCell(1)).trim() === text) at = rn; });
  return at;
}
t('section totals are SUM() over their face rows and cache the payload figure', () => {
  let seen = 0;
  for (const sec of [...basePayload.balanceSheet.equityAndLiabilities, ...basePayload.balanceSheet.assets]) {
    const rn = findRow(BS, `Total — ${sec.title.toLowerCase()}`);
    if (!sec.rows.length && !sec.total.current && !sec.total.prior) {
      assert.equal(rn, null, `${sec.title} is nil and empty — it must not be presented`);
      continue;
    }
    assert.ok(rn, `no total row for ${sec.title}`);
    seen++;
    const f = formulaOf(BS.getRow(rn).getCell(3));
    assert.ok(/^SUM\(C\d+:C\d+\)$/.test(f), `${sec.title}: ${f}`);
    near(resultOf(BS.getRow(rn).getCell(3)), sec.total.current, `${sec.title} current`);
    near(resultOf(BS.getRow(rn).getCell(4)), sec.total.prior, `${sec.title} prior`);
  }
  assert.ok(seen >= 4, `expected the live sections to be totalled, got ${seen}`);
});
t('a formula whose figure is nil still carries a cached nil, not a blank', () => {
  const prov = basePayload.notes.find((n) => n.lineId === 'st_provisions');
  assert.ok(prov && prov.prior === 0, 'the fixture should have a nil prior-year provision');
  const tot = totals.get(prov.number);
  const cell = NT.getRow(tot.row).getCell(3);
  assert.ok(formulaOf(cell), 'it must still be a formula');
  assert.equal(cell.result, 0, 'the cached result must be 0, not undefined');
});
t('total equity and liabilities equals total assets, both as SUM() and as cached values', () => {
  const el = findRow(BS, 'TOTAL — EQUITY AND LIABILITIES');
  const as = findRow(BS, 'TOTAL — ASSETS');
  assert.ok(/^SUM\(C\d+(,C\d+)+\)$/.test(formulaOf(BS.getRow(el).getCell(3))));
  assert.ok(/^SUM\(C\d+(,C\d+)+\)$/.test(formulaOf(BS.getRow(as).getCell(3))));
  near(resultOf(BS.getRow(el).getCell(3)), basePayload.balanceSheet.totalEquityAndLiabilities.current, 'total E&L');
  near(resultOf(BS.getRow(as).getCell(3)), basePayload.balanceSheet.totalAssets.current, 'total assets');
  near(resultOf(BS.getRow(el).getCell(3)), resultOf(BS.getRow(as).getCell(3)), 'the balance sheet ties');
});
t('the profit & loss totals cache the payload figures', () => {
  const ti = findRow(PL, 'Total income'), te = findRow(PL, 'Total expenses');
  const pbt = findRow(PL, 'Profit before tax'), pat = findRow(PL, 'Profit for the year');
  near(resultOf(PL.getRow(ti).getCell(3)), basePayload.profitAndLoss.totalIncome.current, 'total income');
  near(resultOf(PL.getRow(te).getCell(3)), basePayload.profitAndLoss.totalExpenses.current, 'total expenses');
  near(resultOf(PL.getRow(pbt).getCell(3)), basePayload.profitAndLoss.pbt.current, 'PBT');
  near(resultOf(PL.getRow(pat).getCell(3)), basePayload.profitAndLoss.pat.current, 'PAT');
  assert.ok(/^C\d+-C\d+$/.test(formulaOf(PL.getRow(pbt).getCell(3))), 'PBT must be computed, not typed');
  assert.ok(/^C\d+-SUM\(C\d+(,C\d+)*\)$/.test(formulaOf(PL.getRow(pat).getCell(3))), 'PAT must be PBT less tax');
});
t('the reserves note carries the year\'s result, so the face figure IS the note total', () => {
  const rn = findRow(BS, 'Reserves and surplus');
  assert.ok(rn, 'reserves are not on the face');
  const m = /^Notes!B(\d+)$/.exec(formulaOf(BS.getRow(rn).getCell(3)));
  assert.ok(m, 'reserves must still link to its note');
  near(resultOf(BS.getRow(rn).getCell(3)), toRupees(r.bs.current.reserves), 'closing reserves');
});

console.log('\n── no external references ──');
t('no cell anywhere contains an external reference', () => {
  for (const ws of wb.worksheets) {
    eachCell(ws, (cell, rn, cn) => {
      const f = formulaOf(cell);
      if (!f) return;
      assert.ok(!f.includes('['), `${ws.name}!${cn}:${rn} has an external reference: ${f}`);
      // and it may only address sheets inside this workbook
      for (const m of f.matchAll(/'?([A-Za-z][A-Za-z &]*)'?!/g)) {
        assert.ok(wb.worksheets.some((x) => x.name === m[1].trim()),
          `${ws.name}: formula refers to an unknown sheet "${m[1]}"`);
      }
    });
  }
});

console.log('\n── cash flow ──');
t('the cash flow shows the full indirect working and its reconciliation', () => {
  const s = allText(CF);
  for (const needle of ['Profit before tax', 'Adjustments for:',
    'Operating profit before working capital changes', 'Cash generated from operations',
    'Direct taxes paid', 'Cash flow from investing activities', 'Cash flow from financing activities',
    'Net increase / (decrease) in cash and cash equivalents   (A+B+C)',
    'Cash and cash equivalents at the beginning of the year']) {
    assert.ok(s.includes(needle), `cash flow is missing "${needle}"`);
  }
  const nc = findRow(CF, 'Net increase / (decrease) in cash and cash equivalents   (A+B+C)');
  assert.ok(/^SUM\(B\d+,B\d+,B\d+\)$/.test(formulaOf(CF.getRow(nc).getCell(2))));
  near(resultOf(CF.getRow(nc).getCell(2)), basePayload.cashFlow.netChange, 'net change');
});
t('closing cash per the balance sheet is taken FROM the balance sheet', () => {
  const rn = findRow(CF, 'Cash and cash equivalents at the end of the year (per the balance sheet)');
  const f = formulaOf(CF.getRow(rn).getCell(2));
  assert.ok(/^'Balance Sheet'!C\d+$/.test(f), `expected a balance-sheet link, got ${f}`);
  const bsRow = Number(/C(\d+)/.exec(f)[1]);
  assert.ok(/Cash and cash equivalents/.test(textOf(BS.getRow(bsRow).getCell(1))));
});
t('an unreconciled difference is shown in red, never absorbed', () => {
  const broken = clone(basePayload);
  broken.cashFlow.unreconciled = 4250;
  broken.cashFlow.reconciled = false;
  const w2 = buildWorkbook(ExcelJS, broken);
  const cf2 = w2.getWorksheet('Cash Flow');
  const rn = findRow(cf2, 'Unreconciled difference — must be nil');
  assert.ok(rn, 'the unreconciled line must be shown');
  near(resultOf(cf2.getRow(rn).getCell(2)), 4250, 'unreconciled');
  assert.equal(cf2.getRow(rn).getCell(2).font.color.argb, 'FFB00020');
  assert.ok(/^B\d+-B\d+$/.test(formulaOf(cf2.getRow(rn).getCell(2))), 'it must be a real difference');
});
t('every assumption is printed and marked as requiring evidence', () => {
  const s = allText(CF);
  assert.ok(basePayload.cashFlow.assumptions.length > 0, 'the fixture should raise assumptions');
  for (const a of basePayload.cashFlow.assumptions) {
    assert.ok(s.includes(`[${a.id}]`), `assumption ${a.id} is missing`);
  }
  // count column A only: the text is merged across A:B, and ExcelJS reports a
  // merged value from every cell in the merge
  let marks = 0;
  CF.eachRow({ includeEmpty: false }, (row) => {
    if (/ASSUMPTION — EVIDENCE REQUIRED/.test(textOf(row.getCell(1)))) marks++;
  });
  assert.equal(marks, basePayload.cashFlow.assumptions.length);
});

console.log('\n── the difference row on the balance sheet ──');
t('no difference row when the balance sheet ties', () => {
  assert.equal(basePayload.balanceSheet.difference.current, 0);
  assert.ok(!/Difference — total assets/.test(allText(BS)));
});
t('a difference is shown immediately after total assets, in red, as a real subtraction', () => {
  const off = clone(basePayload);
  off.balanceSheet.difference = { current: 1234.5, prior: 0 };
  const w2 = buildWorkbook(ExcelJS, off);
  const bs2 = w2.getWorksheet('Balance Sheet');
  const totalRow = findRow(bs2, 'TOTAL — ASSETS');
  const diffRow = totalRow + 1;
  assert.ok(/^Difference — total assets less total equity and liabilities/.test(textOf(bs2.getRow(diffRow).getCell(1))));
  assert.equal(bs2.getRow(diffRow).getCell(1).font.color.argb, 'FFB00020');
  near(resultOf(bs2.getRow(diffRow).getCell(3)), 1234.5, 'difference');
  assert.ok(/^C\d+-C\d+$/.test(formulaOf(bs2.getRow(diffRow).getCell(3))));
  assert.ok(/must be nil/.test(textOf(bs2.getRow(diffRow).getCell(1))));
});

console.log('\n── review sheet and the draft banner ──');
const CRIT = { id: 'TEST-CRIT', severity: 'CRITICAL', message: 'A critical exception for the banner test.', amount: 9999.5 };
t('every check reaches the Review sheet, CRITICAL first', () => {
  const withCrit = clone(basePayload);
  withCrit.checks = [
    { id: 'I1', severity: 'INFO', message: 'informational', amount: null },
    { id: 'R1', severity: 'REVIEW', message: 'a review point', amount: null },
    CRIT,
    { id: 'H1', severity: 'HIGH', message: 'a high exception', amount: null },
  ];
  const rv = buildWorkbook(ExcelJS, withCrit).getWorksheet('Review');
  const sevs = [];
  rv.eachRow({ includeEmpty: false }, (row) => {
    const s = textOf(row.getCell(1));
    if (['CRITICAL', 'HIGH', 'REVIEW', 'INFO'].includes(s)) sevs.push(s);
  });
  assert.deepEqual(sevs, ['CRITICAL', 'HIGH', 'REVIEW', 'INFO']);
  const s = allText(rv);
  for (const id of ['TEST-CRIT', 'H1', 'R1', 'I1']) assert.ok(s.includes(id), `${id} is missing`);
  assert.ok(/NOT FOR ISSUE/.test(s));
});
t('the DRAFT banner appears on the Balance Sheet when a CRITICAL check exists', () => {
  const withCrit = clone(basePayload);
  withCrit.checks = [CRIT, { id: 'X', severity: 'CRITICAL', message: 'another', amount: null }];
  const bs2 = buildWorkbook(ExcelJS, withCrit).getWorksheet('Balance Sheet');
  assert.equal(textOf(bs2.getRow(1).getCell(1)),
    'DRAFT — NOT FOR ISSUE: 2 unresolved critical exception(s)');
  assert.equal(bs2.getRow(1).getCell(1).fill.fgColor.argb, 'FFB00020');
  // the statement itself still starts below the banner
  assert.ok(/Balance sheet as at 31 March 2026/.test(allText(bs2)));
});
t('the banner is absent when there is no critical check', () => {
  const clean = clone(basePayload);
  clean.checks = basePayload.checks.filter((c) => c.severity !== 'CRITICAL');
  const bs2 = buildWorkbook(ExcelJS, clean).getWorksheet('Balance Sheet');
  assert.ok(!/NOT FOR ISSUE/.test(allText(bs2)));
  assert.equal(textOf(bs2.getRow(1).getCell(1)), meta.entity);
  const rv2 = buildWorkbook(ExcelJS, clean).getWorksheet('Review');
  assert.ok(/No critical exception outstanding/.test(allText(rv2)));
});

console.log('\n── disclosures ──');
t('the disclosure register carries requirement, status and evidence', () => {
  const head = DS.getRow(6);
  assert.deepEqual([1, 2, 3, 4, 5].map((c) => textOf(head.getCell(c))),
    ['Note', 'Head', 'Information Schedule III requires', 'Status', 'Evidence']);
  const s = allText(DS);
  assert.ok(basePayload.disclosures.length > 0, 'the fixture should raise disclosure gaps');
  assert.ok(s.includes(basePayload.disclosures[0].requirement));
  assert.ok(s.includes('Required — data missing'));
});

console.log('\n── formatting ──');
t('amounts use #,##0.00 and totals are bold with a rule above', () => {
  const rn = findRow(BS, 'TOTAL — ASSETS');
  const cell = BS.getRow(rn).getCell(3);
  assert.equal(cell.numFmt, '#,##0.00');
  assert.equal(cell.font.bold, true);
  assert.ok(cell.border && cell.border.top && cell.border.bottom.style === 'double');
  const leaf = NT.getRow(leaves[0].row).getCell(2);
  assert.equal(leaf.numFmt, '#,##0.00');
});
t('columns are given sensible widths on every sheet', () => {
  for (const ws of wb.worksheets) {
    assert.ok(ws.getColumn(1).width >= 8, `${ws.name} column A is too narrow`);
  }
});

console.log('\n── file output ──');
let buffer = null;
try { buffer = await wb.xlsx.writeBuffer(); } catch (e) { buffer = { error: e.message }; }
t('the workbook serialises to a real .xlsx buffer', () => {
  assert.ok(buffer && buffer.length > 5000, 'writeBuffer failed: ' + (buffer && buffer.error));
  assert.equal(Buffer.from(buffer.slice(0, 2)).toString('latin1'), 'PK');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
