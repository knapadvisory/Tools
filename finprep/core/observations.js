/* ============================================================================
 * observations.js — what the tool noticed, for a human to verify
 *
 * These are NOT audit findings and NOT an opinion. Each observation says what
 * was detected, the basis on which it was detected, and what the preparer must
 * check. A detected risk is never presented as a proven misstatement, and
 * silence is never presented as assurance.
 *
 * Every observation carries `verify` — the action required before filing.
 * ==========================================================================*/

import { add, neg, format, toRupees } from './money.js';
import { line as lineDef, sectionOf } from './schedule3.js';

export const AREA = {
  INTEGRITY: 'Arithmetic and completeness',
  CLASSIFICATION: 'Classification and grouping',
  BALANCE: 'Balance sheet composition',
  RESULT: 'Profit and loss',
  CASH: 'Cash flow',
  EVIDENCE: 'Evidence and inputs',
  DISCLOSURE: 'Disclosures',
  COMPLIANCE: 'Statutory applicability',
};
/** How much it matters — not a materiality judgement, which only the auditor makes. */
export const WEIGHT = { BLOCKING: 'Blocking', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

const O = (id, area, weight, observation, basis, verify, extra = {}) =>
  ({ id, area, weight, observation, basis, verify, ...extra });

/**
 * @param r        engine result (paise)
 * @param cf       cash flow result, or null
 * @param ctx      { inputs: {counts, perKind}, disclosures: [], applicability: [] }
 */
export function observe(r, cf = null, ctx = {}) {
  const out = [];
  const P = r.periods[0], PR = r.periods[1];
  const v = (id, p = P) => r.value(id, p);
  const pres = (id, p = P) => r.presented(id, p);
  const rs = (x) => format(x);

  /* ---- 1. arithmetic and completeness -------------------------------- */
  for (const c of r.checks.filter((x) => x.severity === 'CRITICAL')) {
    out.push(O('OBS-INT-' + c.id, AREA.INTEGRITY, WEIGHT.BLOCKING, c.message,
      'Computed from the adjusted trial balance.',
      'Resolve before the statements are issued. This is arithmetic, not judgement — it cannot be accepted as a risk.'));
  }
  if (cf && !cf.reconciled) {
    out.push(O('OBS-CF-RECON', AREA.CASH, WEIGHT.BLOCKING,
      `The cash flow statement does not reconcile to the movement in cash: difference ${rs(cf.unreconciled)}.`,
      'Opening cash plus the three activities does not equal closing cash per the balance sheet.',
      'Identify the unexplained movement. The difference is shown rather than absorbed, so it will not disappear on its own.'));
  }

  /* ---- 2. classification --------------------------------------------- */
  const lowConf = r.ledgers.filter((l) => l.rule && (l.rule.confidence === 'low' || l.rule.confidence === 'none'));
  if (lowConf.length) {
    out.push(O('OBS-CLS-LOW', AREA.CLASSIFICATION, WEIGHT.HIGH,
      `${lowConf.length} ledger(s) were placed on a weak signal.`,
      'The classifier had no specific rule and fell back to a generic parent group: '
        + lowConf.slice(0, 6).map((l) => `"${l.name}"`).join(', ') + (lowConf.length > 6 ? ', …' : '') + '.',
      'Confirm each head in step 3. A wrong head does not unbalance the accounts, so nothing else will catch it.'));
  }
  const regrouped = r.checks.filter((c) => c.id.startsWith('RCL-'));
  if (regrouped.length) {
    out.push(O('OBS-CLS-RCL', AREA.CLASSIFICATION, WEIGHT.MEDIUM,
      `${regrouped.length} ledger(s) fall under a different head this year than last, because the balance changed side.`,
      'Per-period classification; the comparative was classified on its own balance.',
      'Schedule III requires the regrouping of comparatives to be disclosed. Add the note.'));
  }

  /* ---- 3. balance sheet composition ----------------------------------- */
  const negatives = [];
  for (const id of r.used) {
    if (sectionOf(id) === 'UNCLASSIFIED') continue;
    const def = lineDef(id); if (!def || !['BS'].includes(defStatement(def))) continue;
    if (pres(id) < 0) negatives.push({ id, amount: pres(id) });
  }
  for (const n of negatives) {
    out.push(O('OBS-BS-NEG-' + n.id, AREA.BALANCE, WEIGHT.HIGH,
      `"${r.caption(n.id)}" is negative at ${rs(n.amount)}.`,
      'The head carries a balance on the side opposite to its nature.',
      'A negative asset or liability is not an acceptable presentation. Identify the ledger and reclassify it.'));
  }
  if (v('ppe') !== 0 && v('depreciation_amortisation') === 0) {
    out.push(O('OBS-BS-NODEP', AREA.BALANCE, WEIGHT.HIGH,
      'Property, plant and equipment is carried but no depreciation has been charged for the year.',
      `PPE ${rs(pres('ppe'))}, depreciation nil.`,
      'Confirm the Schedule II charge has been posted. Depreciation is not optional where an asset is in use.'));
  }
  const cwipCur = pres('cwip'), cwipPri = pres('cwip', PR);
  if (cwipCur !== 0 && cwipCur === cwipPri) {
    out.push(O('OBS-BS-CWIP', AREA.BALANCE, WEIGHT.MEDIUM,
      `Capital work-in-progress is unchanged at ${rs(cwipCur)}.`,
      'No movement between the two periods.',
      'Schedule III requires a CWIP ageing schedule and separate disclosure of projects overdue or exceeding cost. Confirm the project is still live and not impaired.'));
  }
  if (pres('trade_receivables') !== 0 || pres('trade_payables_others') !== 0) {
    out.push(O('OBS-BS-AGEING', AREA.DISCLOSURE, WEIGHT.HIGH,
      'Trade receivable and payable ageing schedules are required and cannot be produced from a trial balance.',
      'Ageing needs invoice-level, bill-wise data with due dates.',
      'Pull bill-wise detail from Tally or prepare the ageing manually. Do not derive it from closing balances.'));
  }
  if (pres('trade_payables_msme') === 0 && pres('trade_payables_others') !== 0) {
    out.push(O('OBS-BS-MSME', AREA.DISCLOSURE, WEIGHT.HIGH,
      'The whole of trade payables is shown as "other than micro and small enterprises".',
      'No payable has been identified as an MSME due.',
      'Verify Udyam status supplier by supplier. Absence of evidence means UNKNOWN status — it does not mean there are no MSME dues, and the MSMED disclosure and section 43B(h) both turn on this.'));
  }

  /* ---- 4. profit and loss --------------------------------------------- */
  const pl = r.pl[P];
  if (pl.pbt > 0 && pl.tax.total === 0) {
    out.push(O('OBS-PL-NOTAX', AREA.RESULT, WEIGHT.HIGH,
      `A profit before tax of ${rs(pl.pbt)} is reported with no tax expense.`,
      'No ledger or approved journal carries current, deferred or earlier-year tax.',
      'Provide for tax by posting an adjusting journal, so the charge reaches the profit and loss AND the provision reaches the balance sheet. Keying a figure for display alone would overstate reserves.'));
  }
  if (pl.tax.deferred === 0 && (pres('deferred_tax_liability') !== 0 || pres('deferred_tax_asset') !== 0)) {
    out.push(O('OBS-PL-DT', AREA.RESULT, WEIGHT.MEDIUM,
      'A deferred tax balance is carried but no deferred tax charge or credit has been recognised for the year.',
      'Balance present, movement nil.',
      'Reconcile the opening and closing deferred tax and recognise the movement. Where a net deferred tax ASSET arises from unabsorbed depreciation or carried-forward losses, AS 22 requires virtual certainty supported by convincing evidence.'));
  }
  const rev = pres('revenue_operations'), oi = pres('other_income');
  if (rev !== 0 && oi !== 0 && oi > rev * 0.25) {
    out.push(O('OBS-PL-OI', AREA.RESULT, WEIGHT.MEDIUM,
      `Other income (${rs(oi)}) is large relative to revenue from operations (${rs(rev)}).`,
      'Ratio of the two heads.',
      'Confirm nothing operating has been classified as other income, or the reverse. Turnover drives tax-audit, CARO and MSME thresholds and several ratios.'));
  }

  /* ---- 5. evidence and inputs ----------------------------------------- */
  const counts = (ctx.inputs && ctx.inputs.counts) || {};
  const EV = [
    ['prior_financials', 'previous year signed financial statements', 'Comparatives are taken from Tally and have not been agreed to the signed accounts.'],
    ['gstr2b', 'GSTR-2B', 'Input tax credit has not been corroborated against the portal.'],
    ['gstr1_3b', 'GSTR-1 / GSTR-3B', 'Revenue in the accounts has not been reconciled to the returns.'],
    ['tds_conso', 'TDS consolidated statement', 'TDS deducted and deposited has not been tested.'],
  ];
  for (const [kind, label, consequence] of EV) {
    if (!counts[kind]) {
      out.push(O('OBS-EV-' + kind, AREA.EVIDENCE, WEIGHT.HIGH,
        `No ${label} has been provided.`, 'No file of this kind is attached to the engagement.',
        consequence + ' Upload it in step 2, or record why it is not available.'));
    }
  }
  const perKind = (ctx.inputs && ctx.inputs.perKind) || {};
  for (const [kind, cov] of Object.entries(perKind)) {
    if (cov.missing && cov.missing.length) {
      out.push(O('OBS-EV-GAP-' + kind, AREA.EVIDENCE, WEIGHT.HIGH,
        `${cov.label} is missing for ${cov.missing.length} month(s): ${cov.missing.join(', ')}.`,
        'Coverage computed from the period stated on each uploaded file.',
        'Obtain the missing periods. A month with no return on file is a GAP — it must not be assumed to be a nil return.'));
    }
    if (cov.filesWithoutPeriod) {
      out.push(O('OBS-EV-NOPER-' + kind, AREA.EVIDENCE, WEIGHT.MEDIUM,
        `${cov.filesWithoutPeriod} ${cov.label} file(s) have no period recorded.`,
        'Period was not stated on upload.',
        'Record the period each file covers, otherwise coverage cannot be assessed and duplicates cannot be detected.'));
    }
  }

  /* ---- 6. disclosures -------------------------------------------------- */
  const disc = ctx.disclosures || [];
  const pending = disc.filter((d) => /Required/i.test(d.status || ''));
  if (pending.length) {
    out.push(O('OBS-DISC', AREA.DISCLOSURE, WEIGHT.HIGH,
      `${pending.length} Schedule III disclosure(s) required by the heads in use have no data yet.`,
      'Derived from the heads actually carrying a balance.',
      'Complete each one, or mark it "Not applicable" with a reason, or "Nil confirmed" with evidence. An absent disclosure must never be left to read as nil.'));
  }

  /* ---- 7. applicability ------------------------------------------------ */
  const appl = ctx.applicability || [];
  const undetermined = appl.filter((a) => a.conclusion === 'Unable to determine');
  if (undetermined.length) {
    out.push(O('OBS-APPL', AREA.COMPLIANCE, WEIGHT.HIGH,
      `${undetermined.length} applicability assessment(s) could not be concluded: ${undetermined.map((a) => a.domain).join(', ')}.`,
      'The governing thresholds have not been recorded and verified against a primary source.',
      'Determine CARO, MSME, tax audit and internal financial controls applicability yourself against the effective law. The tool will not assert a threshold it cannot cite.'));
  }

  /* ---- 8. cash flow assumptions --------------------------------------- */
  if (cf) {
    for (const a of cf.assumptions || []) {
      out.push(O('OBS-CF-' + a.id, AREA.CASH, WEIGHT.MEDIUM,
        'The cash flow relies on an estimate that the trial balance cannot evidence.', a.text,
        'Supply the supporting schedule so the figure is evidenced rather than derived.'));
    }
  }

  const order = { [WEIGHT.BLOCKING]: 0, [WEIGHT.HIGH]: 1, [WEIGHT.MEDIUM]: 2, [WEIGHT.LOW]: 3 };
  out.sort((a, b) => order[a.weight] - order[b.weight]);
  return {
    observations: out,
    summary: {
      total: out.length,
      blocking: out.filter((o) => o.weight === WEIGHT.BLOCKING).length,
      high: out.filter((o) => o.weight === WEIGHT.HIGH).length,
      byArea: Object.values(AREA).map((a) => ({ area: a, count: out.filter((o) => o.area === a).length }))
        .filter((x) => x.count),
    },
    disclaimer: 'These are matters the tool noticed from the data available to it. They are not audit findings, not evidence, and not an opinion. Each must be verified by the preparer or auditor before the financial statements are filed. The absence of an observation is not assurance — the tool can only see what it was given.',
  };
}

function defStatement(def) {
  const s = sectionOf(def.id);
  return ['EQUITY', 'NCL', 'CL', 'NCA', 'CA'].includes(s) ? 'BS' : 'PL';
}
