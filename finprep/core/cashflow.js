/* ============================================================================
 * cashflow.js — AS 3 / Ind AS 7 indirect-method cash flow statement
 *
 * The previous implementation derived operating cash as
 *     operating = netCash − financing − investing
 * which is a plug: it always tied, so it could never be wrong on its face and
 * could never be audited. Spec §6/§9 forbid that.
 *
 * Here operating is built BOTTOM-UP from profit before tax, and the statement
 * is then RECONCILED against the movement in cash per the balance sheet. Any
 * residual is reported as an unreconciled difference — it is never absorbed
 * into an activity.
 *
 * What a two-period trial balance cannot tell you (gross additions vs disposals,
 * borrowings drawn vs repaid, actual taxes paid) is taken from supporting
 * schedules when supplied, and otherwise presented as a NET movement with an
 * explicit assumption recorded against it. Assumptions are returned, not hidden.
 * ==========================================================================*/

import { add, sub, neg, toPaise, format } from './money.js';
import { sectionOf, sideOf } from './schedule3.js';

const ASSET_SECTIONS = new Set(['NCA', 'CA']);

/** Ledger names inside a head that belong to investing rather than operating. */
const INVESTING_INCOME = ['interest', 'dividend'];

export function buildCashFlow(r, opts = {}) {
  const { period = 'current', prior = 'prior', schedules = {} } = opts;
  const assumptions = [];
  const notes = [];

  const presented = (id, p) => r.presented(id, p);
  /** movement in a head, positive = increased, in its own nature */
  const delta = (id) => sub(presented(id, period), presented(id, prior));
  /** cash effect of a balance-sheet movement: assets consume cash, liabilities release it */
  const cashEffect = (id) => (ASSET_SECTIONS.has(sectionOf(id)) ? neg(delta(id)) : delta(id));

  /** Split a P&L head using its ledger trace, e.g. interest income out of other income. */
  function splitByName(lineId, needles, p) {
    const recs = (r.trace.get(lineId) || []).filter((t) => t.period === p);
    let hit = 0, rest = 0;
    for (const t of recs) {
      const n = String(t.name || '').toLowerCase();
      (needles.some((k) => n.includes(k)) ? (hit += t.amount) : (rest += t.amount));
    }
    // both returned Dr-positive; caller decides sign
    return { matched: hit, other: rest, hadTrace: recs.length > 0 };
  }

  /* ---------------- OPERATING ------------------------------------------ */
  const pbt = r.pl[period].pbt;                              // profit positive
  const depreciation = r.value('depreciation_amortisation', period);   // Dr +
  const financeCosts = r.value('finance_costs', period);              // Dr +

  // interest / dividend income sits inside other income and belongs to investing
  const oi = splitByName('other_income', INVESTING_INCOME, period);
  const investmentIncome = neg(oi.matched);                  // credit → positive income
  if (!oi.hadTrace && r.value('other_income', period) !== 0) {
    assumptions.push({ id: 'CF-OI', text: 'Other income could not be split into investment income; it is treated as operating.' });
  }

  const operatingAdjustments = [
    { label: 'Depreciation and amortisation', amount: depreciation },
    { label: 'Finance costs', amount: financeCosts },
    { label: 'Interest and dividend income', amount: neg(investmentIncome) },
  ];
  const operatingProfitBeforeWC = add(pbt, ...operatingAdjustments.map((a) => a.amount));

  const WC_ASSETS = ['trade_receivables', 'inventories', 'st_loans_advances',
    'advances_to_suppliers', 'other_current_assets'];
  const WC_LIABS = ['trade_payables_msme', 'trade_payables_others', 'advances_from_customers',
    'statutory_dues', 'other_current_liabilities'];

  const workingCapital = [];
  for (const id of WC_ASSETS) {
    const v = cashEffect(id);
    if (v !== 0) workingCapital.push({ label: `Movement in ${r.caption(id)}`, amount: v });
  }
  for (const id of WC_LIABS) {
    const v = cashEffect(id);
    if (v !== 0) workingCapital.push({ label: `Movement in ${r.caption(id)}`, amount: v });
  }
  const cashGenerated = add(operatingProfitBeforeWC, ...workingCapital.map((w) => w.amount));

  // Taxes paid: opening provision + charge − closing provision, unless evidenced.
  let taxPaid;
  if (schedules.taxPaid != null) {
    taxPaid = toPaise(schedules.taxPaid);
  } else {
    const provOpen = presented('st_provisions', prior);
    const provClose = presented('st_provisions', period);
    const charge = r.pl[period].tax.current;
    taxPaid = add(provOpen, charge, neg(provClose));
    assumptions.push({ id: 'CF-TAX',
      text: `Direct taxes paid (${format(taxPaid)}) is derived as opening provision + current tax charge − closing provision. Short-term provisions may include non-tax provisions; supply the tax payment schedule to replace this.` });
  }
  const netOperating = sub(cashGenerated, taxPaid);

  /* ---------------- INVESTING ------------------------------------------ */
  const investing = [];
  const fa = schedules.fixedAssets || null;
  const profitOnSale = toPaise(schedules.profitOnSaleOfAssets || 0);
  const lossOnSale = toPaise(schedules.lossOnSaleOfAssets || 0);
  if (fa && fa.additions != null) {
    investing.push({ label: 'Purchase of property, plant and equipment', amount: neg(toPaise(fa.additions)) });
    if (fa.disposalProceeds != null) investing.push({ label: 'Proceeds from sale of property, plant and equipment', amount: toPaise(fa.disposalProceeds) });
  } else {
    // net capex = −(Δ net block + depreciation) + profit on sale − loss on sale
    const blockIds = ['ppe', 'cwip', 'intangibles', 'intangibles_under_dev'];
    const dBlock = add(...blockIds.map((id) => delta(id)));
    const net = add(neg(add(dBlock, depreciation)), profitOnSale, neg(lossOnSale));
    if (net !== 0) investing.push({ label: 'Net (purchase)/sale of property, plant and equipment', amount: net });
    assumptions.push({ id: 'CF-FA',
      text: 'Capital expenditure is shown net, derived from the movement in the net block plus depreciation. AS 3 requires gross additions and disposal proceeds separately — link the fixed-asset register to replace this.' });
  }
  for (const id of ['nc_investments', 'current_investments', 'lt_loans_advances']) {
    const v = cashEffect(id);
    if (v !== 0) investing.push({ label: `Net movement in ${r.caption(id)}`, amount: v });
  }
  if (investmentIncome !== 0) investing.push({ label: 'Interest and dividend received', amount: investmentIncome });
  const netInvesting = add(...investing.map((i) => i.amount));

  /* ---------------- FINANCING ------------------------------------------ */
  const financing = [];
  for (const id of ['share_capital', 'share_warrants', 'share_application_money']) {
    const v = cashEffect(id);
    if (v !== 0) financing.push({ label: `Proceeds from ${r.caption(id)}`, amount: v });
  }
  const bor = schedules.borrowings || null;
  if (bor && (bor.drawn != null || bor.repaid != null)) {
    if (bor.drawn != null) financing.push({ label: 'Proceeds from borrowings', amount: toPaise(bor.drawn) });
    if (bor.repaid != null) financing.push({ label: 'Repayment of borrowings', amount: neg(toPaise(bor.repaid)) });
  } else {
    const v = add(...['lt_borrowings', 'st_borrowings', 'current_maturities_ltd'].map((id) => cashEffect(id)));
    if (v !== 0) financing.push({ label: 'Net increase/(decrease) in borrowings', amount: v });
    assumptions.push({ id: 'CF-BOR',
      text: 'Borrowings are shown net. AS 3 requires proceeds and repayments gross unless the turnover is quick and maturities short — supply the borrowing schedule to replace this.' });
  }
  const interestPaid = schedules.interestPaid != null ? toPaise(schedules.interestPaid) : financeCosts;
  if (schedules.interestPaid == null && financeCosts !== 0) {
    assumptions.push({ id: 'CF-INT', text: 'Interest paid is taken as the finance cost charged; it is not adjusted for interest accrued but not due.' });
  }
  if (interestPaid !== 0) financing.push({ label: 'Finance costs paid', amount: neg(interestPaid) });
  if (schedules.dividendPaid) financing.push({ label: 'Dividend paid', amount: neg(toPaise(schedules.dividendPaid)) });
  const netFinancing = add(...financing.map((f) => f.amount));

  /* ---------------- RECONCILIATION — no plug --------------------------- */
  const netChange = add(netOperating, netInvesting, netFinancing);
  const openingCash = presented('cash_and_equivalents', prior);
  const closingCashPerBS = presented('cash_and_equivalents', period);
  const closingCashComputed = add(openingCash, netChange);
  const unreconciled = sub(closingCashPerBS, closingCashComputed);

  const checks = [];
  if (unreconciled !== 0) {
    checks.push({ id: 'CF-RECON', severity: 'CRITICAL', amount: unreconciled,
      message: `Cash flow does not reconcile: closing cash per the balance sheet is ${format(closingCashPerBS)} but the statement computes ${format(closingCashComputed)}, a difference of ${format(unreconciled)}. This difference is shown, not absorbed into operating activities.` });
  }
  const bankOther = delta('bank_other_balances');
  if (bankOther !== 0) {
    notes.push('Bank balances other than cash and cash equivalents moved during the year; confirm which deposits meet the cash-equivalent criteria (AS 3 para 6).');
  }
  if (r.value('st_borrowings', period) !== 0) {
    notes.push('Where bank overdrafts are repayable on demand and form an integral part of cash management, assess whether they should be included in cash and cash equivalents.');
  }

  return {
    period, method: 'indirect',
    operating: { pbt, adjustments: operatingAdjustments, operatingProfitBeforeWC,
                 workingCapital, cashGenerated, taxPaid, net: netOperating },
    investing: { items: investing, net: netInvesting },
    financing: { items: financing, net: netFinancing },
    netChange, openingCash, closingCashComputed, closingCashPerBS, unreconciled,
    reconciled: unreconciled === 0,
    assumptions, notes, checks,
  };
}
