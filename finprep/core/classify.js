/* ============================================================================
 * classify.js — ledger → Schedule III line
 *
 * Rewritten to close audit findings:
 *  C1/M3  substring collisions ("indirect incomes" matched "direct income",
 *         "unsecured loans" matched "secured loan"). Matching is now on whole
 *         words, so a phrase only matches at word boundaries.
 *  C3     a ledger was classified once from the CURRENT-year sign and that head
 *         was used for BOTH columns. A rule now carries an `altLine` for the
 *         abnormal side and the engine resolves it per period.
 *  C4     control accounts were never split by sign, netting advances against
 *         trade balances contrary to Schedule III. `altLine` handles this.
 *  C5     depreciation reached PPE and had to be pulled back out by a fragile
 *         second test. It now classifies straight to the P&L line.
 *  M2     bank charges and interest on late statutory payments were finance
 *         costs; they are other expenses.
 *  H4     TDS/advance-tax names are tested BEFORE the Duties & Taxes group rule.
 *
 * A rule never invents a head: anything without a defensible match returns
 * `unclassified`, which the engine keeps visible and which blocks release.
 * ==========================================================================*/

import { hasLine, sideOf } from './schedule3.js';

/* ---------- whole-word matching ---------------------------------------- */
const singular = (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/**
 * Normalise to ' word word ' form with naive singularisation, for word-boundary
 * tests. "and"/"&" are dropped so Tally's "Duties & Taxes" and a written
 * "Duties and Taxes" normalise identically.
 */
export function norm(s) {
  const t = String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!t) return ' ';
  const words = t.split(/\s+/).filter((w) => w !== 'and').map(singular);
  return words.length ? ' ' + words.join(' ') + ' ' : ' ';
}
const phrase = (p) => norm(p).trim();
/** true only when `p` appears as a whole word/phrase inside normalised `hay`. */
export const hasWord = (hay, p) => hay.includes(' ' + phrase(p) + ' ');
export const anyWord = (hay, list) => list.some((p) => hasWord(hay, p));

const R = (line, conf, reason, opts = {}) => ({
  line, confidence: conf, reason,
  altLine: opts.alt || null,
  review: opts.review || false,
  needs: opts.needs || [],           // information the head cannot be completed without
});

/* ---------- rule table -------------------------------------------------- */
/*
 * Each rule: { when(ctx) -> boolean, then: R(...) }
 * ctx = { name, path, gn, isPL, gstin, hasGstin }
 *   name = normalised ledger name, path = normalised group chain,
 *   gn   = path + name (so a rule can look at either)
 */
const RULES = [
  // ===== unambiguous P&L items, whatever group they sit under =============
  { when: (c) => anyWord(c.gn, ['depreciation', 'amortisation', 'amortization', 'depreciation and amortisation']),
    then: () => R('depreciation_amortisation', 'high', 'Depreciation / amortisation charge') },

  // ===== taxes (name-specific, must precede the Duties & Taxes group rule) =
  { when: (c) => anyWord(c.gn, ['deferred tax']),
    then: (c) => (c.isPL
      ? R('deferred_tax', 'high', 'Deferred tax charge / (credit)')
      : R('deferred_tax_liability', 'high', 'Deferred tax balance', { alt: 'deferred_tax_asset' })) },
  { when: (c) => anyWord(c.gn, ['tds receivable', 'tcs receivable', 'advance tax', 'advance income tax', 'income tax refund']),
    then: () => R('other_current_assets', 'high', 'Taxes recoverable — advance tax / TDS receivable',
      { needs: ['offset against provision for tax where the right of set-off exists'] }) },
  { when: (c) => anyWord(c.gn, ['provision for tax', 'provision for income tax', 'provision for taxation']),
    then: () => R('st_provisions', 'high', 'Provision for tax') },
  { when: (c) => c.isPL && anyWord(c.gn, ['income tax', 'current tax', 'tax expense']),
    then: () => R('current_tax', 'high', 'Current tax expense') },

  // ===== revenue / other income ==========================================
  // NOTE: 'indirect income' is tested first AND matching is word-bounded, so
  // "Indirect Incomes" can no longer satisfy the "direct income" test.
  { when: (c) => anyWord(c.path, ['indirect income']) ||
                 anyWord(c.name, ['interest received', 'interest income', 'rent received', 'rental income',
                                  'discount received', 'commission received', 'dividend received',
                                  'profit on sale of asset', 'profit on sale of fixed asset',
                                  'insurance claim', 'foreign exchange gain', 'misc income', 'miscellaneous income']),
    then: () => R('other_income', 'high', 'Non-operating / other income') },
  { when: (c) => anyWord(c.path, ['sales account', 'direct income', 'sale account']),
    then: () => R('revenue_operations', 'high', 'Under Sales / Direct Income') },

  // ===== purchases & inventory movement ==================================
  { when: (c) => anyWord(c.gn, ['purchase of traded good', 'traded good', 'stock in trade', 'trading purchase']),
    then: () => R('purchases_stock_in_trade', 'high', 'Purchases of stock-in-trade') },
  { when: (c) => anyWord(c.path, ['purchase account']),
    then: () => R('cost_materials_consumed', 'medium', 'Under Purchase Accounts',
      { review: true, needs: ['confirm materials consumed vs purchases of stock-in-trade (trading)'] }) },
  { when: (c) => c.isPL && anyWord(c.gn, ['change in inventory', 'change in stock', 'increase decrease in stock']),
    then: () => R('changes_in_inventories', 'high', 'Changes in inventories') },

  // ===== employee benefits ===============================================
  { when: (c) => c.isPL && anyWord(c.gn, ['salary', 'wage', 'bonus', 'staff', 'employee', 'provident fund', 'pf',
                                          'gratuity', 'esi', 'leave encashment', 'remuneration', 'stipend',
                                          'payroll', 'director sitting fee', 'staff welfare']),
    then: () => R('employee_benefits', 'high', 'Employee benefits') },

  // ===== finance costs (M2: bank charges / penal interest are NOT finance costs)
  { when: (c) => c.isPL && anyWord(c.gn, ['bank charge', 'bank commission', 'cheque return charge', 'processing fee',
                                          'locker rent', 'demat charge']),
    then: () => R('other_expenses', 'high', 'Bank charges — not a borrowing cost') },
  { when: (c) => c.isPL && (anyWord(c.gn, ['interest on tds', 'interest on gst', 'interest on income tax',
                                           'interest on late payment', 'penalty', 'late fee'])),
    then: () => R('other_expenses', 'high', 'Interest/penalty on statutory dues — not a finance cost') },
  { when: (c) => c.isPL && anyWord(c.gn, ['interest', 'finance cost', 'borrowing cost', 'interest expense',
                                          'interest paid', 'interest on loan']),
    then: () => R('finance_costs', 'high', 'Finance costs') },

  // ===== equity ==========================================================
  { when: (c) => anyWord(c.gn, ['share application money', 'application money pending allotment']),
    then: () => R('share_application_money', 'high', 'Share application money pending allotment') },
  { when: (c) => anyWord(c.gn, ['share warrant', 'money received against share warrant']),
    then: () => R('share_warrants', 'high', 'Money received against share warrants') },
  { when: (c) => anyWord(c.path, ['reserve and surplus', 'reserve surplus']) ||
                 anyWord(c.gn, ['reserve', 'surplus', 'retained earning', 'securities premium',
                                'general reserve', 'profit and loss account', 'p l account']),
    then: () => R('reserves_surplus', 'high', 'Reserves and surplus') },
  { when: (c) => anyWord(c.path, ['capital account']),
    then: () => R('share_capital', 'high', 'Under Capital Account',
      { review: true, needs: ['confirm paid-up capital; proprietor/partner capital is not share capital'] }) },

  // ===== borrowings ======================================================
  { when: (c) => anyWord(c.path, ['bank od', 'bank occ', 'cash credit', 'bank o d']) ||
                 anyWord(c.gn, ['overdraft', 'cash credit', 'packing credit', 'working capital loan', 'occ']),
    then: () => R('st_borrowings', 'high', 'Bank OD / CC — repayable on demand') },
  { when: (c) => anyWord(c.path, ['secured loan']),
    then: () => R('lt_borrowings', 'high', 'Secured loan',
      { needs: ['nature of security', 'terms of repayment', 'current maturity within 12 months'] }) },
  { when: (c) => anyWord(c.path, ['unsecured loan']),
    then: () => R('lt_borrowings', 'high', 'Unsecured loan',
      { needs: ['terms of repayment', 'related-party / director loan flag', 'current maturity within 12 months'] }) },
  { when: (c) => anyWord(c.path, ['loan liability', 'loan liabilitie']),
    then: () => R('lt_borrowings', 'medium', 'Under Loans (Liability)',
      { review: true, needs: ['secured / unsecured', 'current maturity within 12 months'] }) },

  // ===== statutory dues ==================================================
  { when: (c) => anyWord(c.path, ['duty tax', 'duties and taxe', 'duty and taxe']) ||
                 anyWord(c.gn, ['gst payable', 'tds payable', 'tcs payable', 'pf payable', 'esi payable',
                                'professional tax', 'output cgst', 'output sgst', 'output igst']),
    then: () => R('statutory_dues', 'high', 'Statutory dues', { alt: 'other_current_assets' }) },
  { when: (c) => anyWord(c.gn, ['input gst', 'input tax', 'input cgst', 'input sgst', 'input igst',
                                'gst receivable', 'electronic cash ledger', 'electronic credit ledger']),
    then: () => R('other_current_assets', 'high', 'Input tax / GST balances',
      { needs: ['assess whether the GST cash ledger meets the cash-equivalent criteria'] }) },

  // ===== provisions ======================================================
  { when: (c) => anyWord(c.path, ['provision']) || anyWord(c.name, ['provision for']),
    then: () => R('st_provisions', 'medium', 'Provisions',
      { alt: 'other_current_assets', review: true,
        needs: ['split long-term vs short-term', 'a debit balance in a provision needs investigation'] }) },

  // ===== trade balances — split by sign (C4) =============================
  { when: (c) => anyWord(c.path, ['sundry creditor', 'trade payable']) ||
                 anyWord(c.gn, ['creditor for good', 'payable for good']),
    then: () => R('trade_payables_others', 'high', 'Under Sundry Creditors',
      { alt: 'advances_to_suppliers',
        needs: ['MSME vs others split (Udyam evidence)', 'ageing by invoice date'] }) },
  { when: (c) => anyWord(c.path, ['sundry debtor', 'trade receivable']) ||
                 anyWord(c.gn, ['receivable from customer']),
    then: () => R('trade_receivables', 'high', 'Under Sundry Debtors',
      { alt: 'advances_from_customers', needs: ['ageing by invoice date', 'disputed / doubtful split'] }) },

  // ===== cash & bank =====================================================
  { when: (c) => anyWord(c.gn, ['fixed deposit', 'term deposit', 'margin money', 'fdr', 'deposit with bank']),
    then: () => R('bank_other_balances', 'high', 'Deposits with banks',
      { needs: ['original maturity ≤ 3 months qualifies as a cash equivalent'] }) },
  { when: (c) => anyWord(c.path, ['bank account']),
    // a credit balance in a bank account is an overdraft, not negative cash (M5)
    then: () => R('cash_and_equivalents', 'high', 'Bank account', { alt: 'st_borrowings' }) },
  { when: (c) => anyWord(c.path, ['cash in hand']) || anyWord(c.gn, ['petty cash', 'cash in hand']),
    then: () => R('cash_and_equivalents', 'high', 'Cash in hand') },

  // ===== fixed assets (before inventories: "capital work in progress" must
  //       not be caught by the "work in progress" stock rule) ==============
  { when: (c) => anyWord(c.gn, ['capital work in progress', 'cwip', 'capital wip']),
    then: () => R('cwip', 'high', 'Capital work-in-progress', { needs: ['ageing and completion schedule'] }) },
  { when: (c) => anyWord(c.gn, ['intangible asset under development']),
    then: () => R('intangibles_under_dev', 'high', 'Intangible assets under development') },
  { when: (c) => anyWord(c.gn, ['goodwill', 'software', 'trademark', 'patent', 'copyright',
                                'licence fee', 'license fee', 'intangible']),
    then: () => R('intangibles', 'high', 'Intangible asset') },
  { when: (c) => anyWord(c.path, ['fixed asset']),
    then: () => R('ppe', 'high', 'Under Fixed Assets',
      { needs: ['gross block / accumulated depreciation reconciliation', 'title deeds'] }) },

  // ===== inventories =====================================================
  { when: (c) => anyWord(c.path, ['stock in hand']) ||
                 anyWord(c.gn, ['closing stock', 'inventory', 'raw material', 'finished good',
                                'work in progress', 'store and spare', 'consumable']),
    then: () => R('inventories', 'high', 'Inventories', { needs: ['mode of valuation'] }) },

  // ===== investments =====================================================
  { when: (c) => anyWord(c.path, ['investment']),
    then: (c) => (anyWord(c.gn, ['current', 'short term', 'liquid'])
      ? R('current_investments', 'medium', 'Investment — marked current', { review: true })
      : R('nc_investments', 'medium', 'Investment',
          { review: true, needs: ['current vs non-current by intent', 'quoted / unquoted', 'market value'] })) },

  // ===== loans & advances (asset) ========================================
  { when: (c) => anyWord(c.path, ['loan and advance asset', 'loan advance asset']),
    then: () => R('st_loans_advances', 'medium', 'Under Loans & Advances (Asset)',
      { review: true, needs: ['current vs non-current by expected realisation',
                              'loans to promoters / directors / KMP / related parties'] }) },
  { when: (c) => anyWord(c.gn, ['security deposit', 'rent deposit', 'electricity deposit', 'tender deposit']),
    then: () => R('lt_loans_advances', 'medium', 'Deposits given', { review: true }) },
  { when: (c) => anyWord(c.gn, ['prepaid', 'prepaid expense']),
    then: () => R('other_current_assets', 'high', 'Prepaid expenses') },
  { when: (c) => anyWord(c.gn, ['advance to supplier', 'advance to vendor', 'advance for purchase']),
    then: () => R('advances_to_suppliers', 'high', 'Advances to suppliers') },
  { when: (c) => anyWord(c.gn, ['advance from customer', 'customer advance', 'advance received']),
    then: () => R('advances_from_customers', 'high', 'Advances from customers') },

  // ===== GSTIN-registered party, settled by side =========================
  { when: (c) => c.hasGstin,
    then: () => R('trade_receivables', 'medium', 'GSTIN-registered party — resolved by balance side',
      { alt: 'trade_payables_others', review: true }) },

  // ===== generic parents: assign but always flag for review ==============
  { when: (c) => anyWord(c.path, ['current liabilitie', 'current liability']),
    then: () => R('other_current_liabilities', 'low', 'Under Current Liabilities — confirm the head', { review: true }) },
  { when: (c) => anyWord(c.path, ['current asset']),
    then: () => R('other_current_assets', 'low', 'Under Current Assets — confirm the head', { review: true }) },
  { when: (c) => c.isPL,
    then: () => R('other_expenses', 'low', 'Revenue-nature expense — confirm the head', { review: true }) },
];

const GSTIN_RX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/** Build the matching context for a ledger. */
function context(led) {
  const chain = (led.groupPath && led.groupPath.length ? led.groupPath.slice() : [led.group, led.primary])
    .filter((x) => x && !/^primary$/i.test(String(x)));
  const path = norm(chain.join(' '));
  const name = norm(led.name);
  const isPL = !!led.isRevenue || anyWord(path, ['sales account', 'purchase account', 'direct income',
    'indirect income', 'direct expense', 'indirect expense', 'income direct', 'income indirect',
    'expense direct', 'expense indirect']);
  return {
    name, path, gn: (path + name.slice(1)), isPL,
    hasGstin: !!(led.gstin && GSTIN_RX.test(String(led.gstin).toUpperCase())),
  };
}

/**
 * Classify a ledger into a RULE (not yet a final line — the side matters).
 * Returns { line, altLine, confidence, reason, review, needs }.
 */
export function classifyLedger(led) {
  const c = context(led);
  for (const rule of RULES) {
    let ok = false;
    try { ok = rule.when(c); } catch { ok = false; }
    if (!ok) continue;
    const res = rule.then(c);
    if (res && hasLine(res.line)) return res;
  }
  return R('unclassified', 'none', 'No Schedule III head matched — assign manually', { review: true });
}

/**
 * Resolve the rule to an actual line for ONE period's balance.
 * `drPositive` is that period's closing balance in natural Dr-positive paise.
 * When the balance sits on the side opposite to the head's normal side and the
 * rule offers an `altLine`, the alternative is used — this is what stops
 * advances being netted against trade balances (audit C4).
 */
export function lineForBalance(rule, drPositive) {
  if (!rule) return { line: 'unclassified', flipped: false };
  if (!rule.altLine || drPositive === 0) return { line: rule.line, flipped: false };
  const normalSide = sideOf(rule.line);
  const onDr = drPositive > 0;
  const abnormal = (normalSide === 'Dr' && !onDr) || (normalSide === 'Cr' && onDr);
  return abnormal ? { line: rule.altLine, flipped: true } : { line: rule.line, flipped: false };
}
