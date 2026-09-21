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
import { byLine as disclosuresForLine } from './disclosures.js';
import { deriveSubGroups } from './subgroup.js';

/**
 * Aggregate a line's ledger contributions into note sub-lines.
 *
 * The trial balance is read as Tally holds it — Grouping ▸ Sub-grouping ▸
 * Ledger. The grouping decides the head; the note shows the SUB-GROUPING as
 * one figure, with the ledgers behind it kept in `members` so it stays
 * traceable. A ledger with no sub-grouping is shown on its own line.
 */
function subLines(r, lineId, periods, subOverrides = {}) {
  const recs = r.trace.get(lineId) || [];
  // per-ledger totals first
  const byName = new Map();
  for (const t of recs) {
    const k = t.name || 'Adjusting journal';
    const row = byName.get(k) || { name: k, amounts: {}, reason: t.reason, subGroup: t.subGroup || null };
    if (!row.subGroup && t.subGroup) row.subGroup = t.subGroup;
    row.amounts[t.period] = add(row.amounts[t.period] || 0, t.amount);
    byName.set(k, row);
  }
  const flip = sideOf(lineId) === 'Cr';
  const sub = deriveSubGroups(
    [...byName.values()].map((x) => ({ name: x.name, subGroup: x.subGroup })), subOverrides, lineId);

  // then collapse onto the sub-grouping
  const groups = new Map();
  for (const [name, row] of byName) {
    const g = sub.get(name) || { label: name, basis: 'shown on its own line', source: 'ledger' };
    const cur = groups.get(g.label)
      || { name: g.label, basis: g.basis, source: g.source, members: [], amounts: {} };
    const member = { name, reason: row.reason, subGroup: row.subGroup || null };
    for (const p of periods) {
      const v = flip ? neg(row.amounts[p] || 0) : (row.amounts[p] || 0);
      member[p] = v;
      cur.amounts[p] = add(cur.amounts[p] || 0, v);
    }
    cur.members.push(member);
    groups.set(g.label, cur);
  }

  return [...groups.values()]
    .map((g) => {
      const out = { name: g.name, reason: g.basis, source: g.source, members: g.members };
      for (const p of periods) out[p] = g.amounts[p] || 0;
      return out;
    })
    .filter((row) => periods.some((p) => row[p] !== 0))
    .sort((a, b) => Math.abs(b[periods[0]]) - Math.abs(a[periods[0]]));
}

/** The numbered notes, in Schedule III order, for the heads actually used. */
export function buildNotes(r, subOverrides = {}) {
  const { periods, division } = r;
  const out = [];
  for (const def of linesFor(division)) {
    if (!def.note) continue;
    const n = r.noteNumbers.get(def.id);
    if (!n) continue;
    const note = {
      number: n, lineId: def.id, caption: captionFor(def.id, division),
      section: def.section, subLines: subLines(r, def.id, periods, subOverrides),
      requires: def.requires || [],
    };
    for (const p of periods) note[p] = r.presented(def.id, p);

    // Reserves: the ledger balance is the OPENING accumulated figure; the face
    // shows opening + profit for the year. The note must show that movement and
    // total to the same closing figure, or the note and the face disagree.
    if (def.id === 'reserves_surplus') {
      const profit = { name: 'Add: Profit for the year', reason: 'statement of profit and loss' };
      let any = false;
      for (const p of periods) { profit[p] = r.pl[p].pat; if (profit[p] !== 0) any = true; }
      if (any) note.subLines = note.subLines.concat([profit]);
      for (const p of periods) note[p] = r.bs[p].reserves;
    }
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
/** The post-2021 additions, which the supplied Schedule III text predates. */
const AMD_2021 = /ageing|title deed|revaluation by|registered valuer|promoter|overdue|exceeding cost|loans? to promoters|quarterly returns|struck.off|wilful|benami|crypto|undisclosed income|layers of companies|scheme of arrangement|utilisation of borrowed/i;
const isAmendment2021 = (req) => AMD_2021.test(req);

export function disclosureRegister(r, answers = {}) {
  const reg = [];
  const seen = new Set();
  const push = (lineId, note, caption, requirement, source, citation, kind) => {
    const key = `${lineId}::${requirement}`;
    if (seen.has(key)) return;
    seen.add(key);
    const a = answers[key];
    reg.push({
      key, lineId, note, caption, requirement, source, citation, kind,
      status: a ? a.status : 'Required — data missing',
      evidence: a ? a.evidence || null : null,
    });
  };

  for (const g of r.disclosureGaps) {
    // 1. Requirements extracted from the Schedule III text supplied to the tool,
    //    each carrying its own clause citation.
    for (const d of disclosuresForLine(g.lineId)) {
      if (d.division !== 'BOTH' && d.division !== (r.division === 'INDAS' ? 'II' : 'I')) continue;
      push(g.lineId, g.note, g.caption, d.requirement, 'Schedule III (text supplied)', d.citation, d.kind);
    }
    // 2. The 2021-amendment requirements. They are real and due, but they are
    //    NOT in the Schedule III text supplied to this tool, so they carry no
    //    citation and are marked accordingly. Anything already covered by a
    //    cited entry above is dropped rather than repeated.
    for (const req of g.requires.filter(isAmendment2021)) {
      push(g.lineId, g.note, g.caption, req,
        'Companies (Accounts) amendment 2021 — NOT verified here',
        'Verify against MCA notification G.S.R. 207(E) dated 24 March 2021; the Schedule III text supplied to this tool predates it.',
        'unverified-source');
    }
  }
  return reg;
}

/** Split of where the register's requirements came from, for the UI to show. */
export function disclosureSources(reg) {
  const verified = reg.filter((d) => d.kind !== 'unverified-source').length;
  return { verified, unverified: reg.length - verified, total: reg.length };
}

export function presentationModel(r, opts = {}) {
  return {
    division: r.division, periods: r.periods,
    balanceSheet: balanceSheetFace(r),
    profitAndLoss: profitAndLossFace(r),
    notes: buildNotes(r, opts.subOverrides || {}),
    disclosures: disclosureRegister(r, opts.answers),
    disclosureSources: disclosureSources(disclosureRegister(r, opts.answers)),
    checks: r.checks,
    releasable: r.releasable,
  };
}
