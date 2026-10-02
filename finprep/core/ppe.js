/* ============================================================================
 * ppe.js — the property, plant and equipment schedule
 *
 * For every asset ledger the books hold: the balance it opened with, what was
 * added, what went out, the depreciation charged, and what it closes at —
 *
 *     Opening WDV + Additions − Deductions − Depreciation = Closing WDV
 *
 * The books give the opening and closing balances and, when the source
 * supplies gross movements, the debits (additions) and credits (deductions
 * and depreciation together — Tally books depreciation as a credit to the
 * asset). Depreciation itself comes from the P&L: the depreciation ledger
 * named for the asset ("Depreciation on Furniture" for "Furniture"), the whole
 * depreciation charge when there is one asset ledger, or the figure the
 * preparer keys in per asset. Deductions are what is left of the credits once
 * depreciation is taken out; without gross movements the net movement is split
 * the only way it can be and the schedule says so.
 *
 * The schedule is checked against the statement of profit and loss: the
 * depreciation it shows must add to the charge on the face (PPE-DEP). A
 * personal-use share of an asset's depreciation, if the preparer records one,
 * is shown as a disallowance line for the tax computation (s.38(2)).
 * ==========================================================================*/

import { add, sub, neg, toPaise, mulRate, format } from './money.js';
import { norm } from './classify.js';

const SEV = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', REVIEW: 'REVIEW', INFO: 'INFO' };
export const SCHEDULE_LINES = { ppe: 'ppe', intangibles: 'intangibles' };
const STOP = new Set(['a', 'c', 'account', 'asset', 'assets', 'on', 'of', 'the', 'and', 'depreciation', 'dep', 'amortisation', 'amortization', 'block', 'new', 'old']);
const tokens = (s) => norm(s).trim().split(' ').filter((w) => w.length >= 3 && !STOP.has(w));

/**
 * @param r       the engine result
 * @param inputs  { 'ppe:<ledger name>:dep': rupees, 'ppe:<ledger name>:personal': percent, 'ppe:method': text }
 * @param lineId  'ppe' | 'intangibles'
 */
export function ppeSchedule(r, inputs = {}, lineId = 'ppe') {
  const period = r.periods[0], prior = r.periods[1];
  const checks = [], notes = [];
  const adjusted = new Map(r.adjustedTB.map((x) => [x.ledgerId, x.balances]));
  const bal = (l, p) => (adjusted.get(l.id) || l.balances)[p] || 0;
  const assets = r.ledgers.filter((l) => l.perPeriod[period].lineId === lineId || l.perPeriod[prior].lineId === lineId);
  if (!assets.length) return null;
  const depLedgers = r.ledgers.filter((l) => l.perPeriod[period].lineId === 'depreciation_amortisation');
  const depTotal = r.value('depreciation_amortisation', period);          // Dr +
  const claimedDep = new Set();

  const rows = assets.map((l) => {
    const opening = bal(l, prior), closing = bal(l, period);
    const hasGross = !!l.mov;
    const key = (k) => inputs[`ppe:${l.name}:${k}`];
    let dep = null, depBasis = '';
    if (key('dep') != null && key('dep') !== '') { dep = toPaise(key('dep')); depBasis = 'keyed by the preparer'; }
    else {
      // the depreciation ledger that names this asset
      const mine = tokens(l.name);
      const hit = depLedgers.find((d) => !claimedDep.has(d.name) && mine.length && mine.every((tk) => norm(d.name).includes(' ' + tk + ' ')));
      if (hit) { claimedDep.add(hit.name); dep = bal(hit, period); depBasis = `from the ledger “${hit.name}”`; }
      else if (assets.length === 1 && lineId === 'ppe') { dep = depTotal; depBasis = 'the whole depreciation charge — one asset ledger'; }
      else { dep = 0; depBasis = assets.length > 1 ? 'not matched to a depreciation ledger — key it in' : 'none'; }
    }
    let additions, deductions, splitBasis;
    if (hasGross) {
      additions = l.mov.dr;
      deductions = Math.max(0, sub(l.mov.cr, dep));
      splitBasis = 'gross movements from the books';
      // the arithmetic must close; a shortfall means the depreciation figure is not what the books credited
      const computed = add(opening, additions, neg(deductions), neg(dep));
      if (computed !== closing) {
        checks.push({ id: `PPE-MOVE-${l.name}`, severity: SEV.REVIEW, amount: sub(closing, computed),
          message: `“${l.name}”: opening ${format(opening)} + additions ${format(additions)} − deductions ${format(deductions)} − depreciation ${format(dep)} is ${format(computed)}, not the closing ${format(closing)}. The depreciation credited in the books differs from the figure used — check the depreciation ledger or key the amount.` });
      }
    } else {
      const net = add(sub(closing, opening), dep);                    // movement before depreciation
      additions = Math.max(0, net); deductions = Math.max(0, neg(net));
      splitBasis = 'net movement — gross debits and credits were not supplied';
    }
    const pct = Number(key('personal'));
    const personal = Number.isFinite(pct) && pct > 0 ? mulRate(dep, Math.min(pct, 100) / 100) : 0;
    if (closing < 0) checks.push({ id: `PPE-NEG-${l.name}`, severity: SEV.HIGH, amount: closing, message: `“${l.name}” closes with a credit balance of ${format(neg(closing))} — an asset cannot. Check for depreciation posted twice or a disposal booked against the wrong ledger.` });
    return { ledger: l.name, group: l.group, opening, additions, deductions, depreciation: dep, closing, hasGross, depBasis, splitBasis,
      personalPct: Number.isFinite(pct) && pct > 0 ? pct : 0, personalUse: personal };
  });

  const total = (k) => add(...rows.map((x) => x[k]));
  const totals = { opening: total('opening'), additions: total('additions'), deductions: total('deductions'), depreciation: total('depreciation'), closing: total('closing'), personalUse: total('personalUse') };
  const unmatched = rows.filter((x) => /not matched/.test(x.depBasis)).length;
  if (lineId === 'ppe' && totals.depreciation !== depTotal) {
    checks.push({ id: 'PPE-DEP', severity: SEV.REVIEW, amount: sub(totals.depreciation, depTotal),
      message: `The PPE schedule shows depreciation of ${format(totals.depreciation)} but the statement of profit and loss charges ${format(depTotal)}. ${unmatched ? `${unmatched} asset ledger(s) could not be matched to a depreciation ledger — key their depreciation in the note.` : 'Key the depreciation per asset so the schedule agrees with the charge.'}` });
  }
  if (rows.some((x) => !x.hasGross)) notes.push('Additions and deductions are shown net for assets whose gross movements were not supplied.');
  if (totals.personalUse) notes.push(`Depreciation of ${format(totals.personalUse)} relates to personal use and is to be disallowed in the tax computation (s.38(2)).`);
  const method = inputs['ppe:method'];
  if (method) notes.push(`Depreciation method: ${method}.`);
  return { lineId, rows, totals, checks, notes, method: method || '' };
}

/** MSMED s.22 disclosure under trade payables, from the preparer's figures. */
export const MSME_FIELDS = [
  ['principal', 'Principal amount remaining unpaid to micro and small enterprises at the year end'],
  ['interest', 'Interest due thereon remaining unpaid at the year end'],
  ['interest_paid', 'Interest paid under s.16 of the MSMED Act during the year, with the payments made beyond the appointed day'],
  ['interest_due', 'Interest due and payable for the period of delay, without the interest under the Act'],
  ['interest_accrued', 'Interest accrued and remaining unpaid at the year end'],
  ['further_interest', 'Further interest remaining due and payable in succeeding years until actually paid'],
];
export function msmeDisclosure(inputs = {}) {
  const rows = MSME_FIELDS.map(([k, label]) => ({ key: k, label, amount: inputs[`msme:${k}`] == null || inputs[`msme:${k}`] === '' ? null : toPaise(inputs[`msme:${k}`]) }));
  const any = rows.some((x) => x.amount != null);
  return { rows, provided: any };
}
