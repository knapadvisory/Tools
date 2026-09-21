/* ============================================================================
 * notes.js — presentation model for the faces and the numbered notes
 *
 * Turns an engine result into exactly what a statement page or a workbook needs,
 * so the screen and the export are driven by ONE model and cannot disagree
 * (spec §15: "Use a shared calculation model so screen previews and exports
 * agree").
 *
 * Every note line carries the ledgers behind it, so statement → note → ledger
 * is traceable without a second pass over the engine.
 * ==========================================================================*/

import { add, neg } from './money.js';
import { linesFor, captionFor, sectionOf, sideOf, line as lineDef } from './schedule3.js';

/** Aggregate a line's ledger contributions per period into note sub-lines. */
function subLines(r, lineId, periods) {
  const recs = r.trace.get(lineId) || [];
  const byName = new Map();
  for (const t of recs) {
    const k = t.name || 'Adjusting journal';
    const row = byName.get(k) || { name: k, amounts: {}, reason: t.reason };
    row.amounts[t.period] = add(row.amounts[t.period] || 0, t.amount);
    byName.set(k, row);
  }
  const flip = sideOf(lineId) === 'Cr';
  return [...byName.values()]
    .map((row) => {
      const out = { name: row.name, reason: row.reason };
      for (const p of periods) out[p] = flip ? neg(row.amounts[p] || 0) : (row.amounts[p] || 0);
      return out;
    })
    .filter((row) => periods.some((p) => row[p] !== 0))
    .sort((a, b) => Math.abs(b[periods[0]]) - Math.abs(a[periods[0]]));
}

/** The numbered notes, in Schedule III order, for the heads actually used. */
export function buildNotes(r) {
  const { periods, division } = r;
  const out = [];
  for (const def of linesFor(division)) {
    if (!def.note) continue;
    const n = r.noteNumbers.get(def.id);
    if (!n) continue;
    const note = {
      number: n, lineId: def.id, caption: captionFor(def.id, division),
      section: def.section, subLines: subLines(r, def.id, periods),
      requires: def.requires || [],
    };
    for (const p of periods) note[p] = r.presented(def.id, p);
    out.push(note);
  }
  return out;
}

const SECTION_TITLES = {
  EQUITY: 'Shareholders’ funds', NCL: 'Non-current liabilities', CL: 'Current liabilities',
  NCA: 'Non-current assets', CA: 'Current assets',
};
const INDAS_TITLES = { EQUITY: 'Equity', NCL: 'Non-current liabilities', CL: 'Current liabilities',
  NCA: 'Non-current assets', CA: 'Current assets' };

/** Balance-sheet face: sections, their lines (with note refs) and totals. */
export function balanceSheetFace(r) {
  const { periods, division } = r;
  const titles = division === 'INDAS' ? INDAS_TITLES : SECTION_TITLES;
  const section = (sec) => {
    const rows = linesFor(division)
      .filter((l) => l.section === sec)
      .map((l) => {
        const row = { lineId: l.id, caption: captionFor(l.id, division), note: r.noteNumbers.get(l.id) || null };
        for (const p of periods) row[p] = r.presented(l.id, p);
        return row;
      })
      .filter((row) => periods.some((p) => row[p] !== 0));
    // reserves carry the year's result, which is not in the ledger balance
    if (sec === 'EQUITY') {
      const res = rows.find((x) => x.lineId === 'reserves_surplus');
      if (res) for (const p of periods) res[p] = r.bs[p].reserves;
      else {
        const row = { lineId: 'reserves_surplus', caption: captionFor('reserves_surplus', division), note: r.noteNumbers.get('reserves_surplus') || null };
        let any = false;
        for (const p of periods) { row[p] = r.bs[p].reserves; if (row[p] !== 0) any = true; }
        if (any) rows.push(row);
      }
    }
    const total = {};
    for (const p of periods) total[p] = add(...rows.map((x) => x[p]));
    return { key: sec, title: titles[sec], rows, total };
  };

  const eq = section('EQUITY'), ncl = section('NCL'), cl = section('CL');
  const nca = section('NCA'), ca = section('CA');
  const tEL = {}, tA = {}, diff = {};
  for (const p of periods) {
    tEL[p] = add(eq.total[p], ncl.total[p], cl.total[p]);
    tA[p] = add(nca.total[p], ca.total[p]);
    diff[p] = r.bs[p].difference;
  }
  return {
    equityAndLiabilities: [eq, ncl, cl], assets: [nca, ca],
    totalEquityAndLiabilities: tEL, totalAssets: tA, difference: diff,
    unclassified: r.unclassified,
  };
}

/** Statement of profit and loss face, in Schedule III order. */
export function profitAndLossFace(r) {
  const { periods, division } = r;
  const row = (caption, pick, lineId) => {
    const o = { caption, lineId: lineId || null, note: lineId ? (r.noteNumbers.get(lineId) || null) : null };
    for (const p of periods) o[p] = pick(p);
    return o;
  };
  const incomeLines = linesFor(division).filter((l) => l.section === 'INCOME');
  const expenseLines = linesFor(division).filter((l) => l.section === 'EXPENSE' &&
    !['exceptional_items', 'extraordinary_items', 'prior_period_items'].includes(l.id));

  const income = incomeLines.map((l) => row(captionFor(l.id, division), (p) => r.presented(l.id, p), l.id))
    .filter((x) => periods.some((p) => x[p] !== 0));
  const expenses = expenseLines.map((l) => row(captionFor(l.id, division), (p) => r.presented(l.id, p), l.id))
    .filter((x) => periods.some((p) => x[p] !== 0));

  const totalIncome = row('Total income', (p) => r.pl[p].income);
  const totalExpenses = row('Total expenses', (p) => r.pl[p].expenses);
  const pbtBefore = row('Profit before exceptional items and tax', (p) => r.pl[p].pbtBeforeExceptional);
  const exceptional = row('Exceptional items', (p) => r.presented('exceptional_items', p), 'exceptional_items');
  const pbt = row('Profit before tax', (p) => r.pl[p].pbt);
  const taxRows = [
    row('Current tax', (p) => r.pl[p].tax.current, 'current_tax'),
    row('Deferred tax', (p) => r.pl[p].tax.deferred, 'deferred_tax'),
    row('Tax relating to earlier years', (p) => r.pl[p].tax.earlier, 'tax_earlier_years'),
  ].filter((x) => periods.some((p) => x[p] !== 0));
  const pat = row('Profit for the year', (p) => r.pl[p].pat);

  const hasExceptional = periods.some((p) => exceptional[p] !== 0);
  return { income, totalIncome, expenses, totalExpenses,
           pbtBefore: hasExceptional ? pbtBefore : null,
           exceptional: hasExceptional ? exceptional : null,
           pbt, taxRows, pat };
}

/**
 * Heads in use whose Schedule III disclosures are not yet evidenced.
 * Status vocabulary per spec §8 — nothing is ever asserted as "Nil" on its own.
 */
export function disclosureRegister(r, answers = {}) {
  const reg = [];
  for (const g of r.disclosureGaps) {
    for (const req of g.requires) {
      const key = `${g.lineId}::${req}`;
      const a = answers[key];
      reg.push({
        key, lineId: g.lineId, note: g.note, caption: g.caption, requirement: req,
        status: a ? a.status : 'Required — data missing',
        evidence: a ? a.evidence || null : null,
      });
    }
  }
  return reg;
}

export function presentationModel(r, opts = {}) {
  return {
    division: r.division, periods: r.periods,
    balanceSheet: balanceSheetFace(r),
    profitAndLoss: profitAndLossFace(r),
    notes: buildNotes(r),
    disclosures: disclosureRegister(r, opts.answers),
    checks: r.checks,
    releasable: r.releasable,
  };
}
