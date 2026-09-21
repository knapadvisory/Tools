/* ============================================================================
 * schedule3.js — the chart of statement lines
 *
 * Spec §6: "Use stable note IDs independent of displayed note numbers."
 * Note NUMBERS are assigned at presentation time from the lines actually used;
 * nothing in the engine depends on a number. This replaces the previous fixed
 * 1..29 map, which both hardcoded numbering and omitted mandatory heads.
 *
 * Heads added here that the previous map lacked entirely (audit findings H2/H3/C4):
 *   share_application_money, share_warrants, cwip, intangibles,
 *   intangibles_under_dev, purchases_stock_in_trade, current_maturities_ltd,
 *   trade_payables_msme/others, advances_from_customers, advances_to_suppliers,
 *   bank_other_balances, current_tax, deferred_tax, tax_earlier_years,
 *   exceptional_items, extraordinary_items, prior_period_items.
 * ==========================================================================*/

/** Section → which statement it belongs to and its normal balance side. */
export const SECTIONS = {
  EQUITY: { statement: 'BS', side: 'Cr', group: 'equity' },
  NCL: { statement: 'BS', side: 'Cr', group: 'liabilities' },
  CL: { statement: 'BS', side: 'Cr', group: 'liabilities' },
  NCA: { statement: 'BS', side: 'Dr', group: 'assets' },
  CA: { statement: 'BS', side: 'Dr', group: 'assets' },
  INCOME: { statement: 'PL', side: 'Cr', group: 'income' },
  EXPENSE: { statement: 'PL', side: 'Dr', group: 'expense' },
  TAX: { statement: 'PL', side: 'Dr', group: 'tax' },
  OCI: { statement: 'PL', side: 'Cr', group: 'oci' },
  /** Never presented on a face. Must always be visible and must block release. */
  UNCLASSIFIED: { statement: 'NONE', side: 'Dr', group: 'unclassified' },
};

const L = (id, caption, section, opts = {}) => ({
  id, caption, section,
  division: opts.division || 'BOTH',      // BOTH | AS | INDAS
  indasCaption: opts.indasCaption || null,
  note: opts.note !== false,              // does it carry a numbered note?
  order: opts.order ?? 0,
  /** sub-classifications Schedule III requires inside the note */
  requires: opts.requires || [],
});

export const LINES = [
  // ---------------- EQUITY ----------------
  L('share_capital', 'Share capital', 'EQUITY', { order: 100,
    indasCaption: 'Equity share capital',
    requires: ['authorised/issued/subscribed split', 'reconciliation of shares outstanding',
               'rights attached', 'shares held by holding company', 'shareholders >5%',
               'promoter shareholding with % change', 'shares issued in preceding 5 years'] }),
  L('reserves_surplus', 'Reserves and surplus', 'EQUITY', { order: 110,
    indasCaption: 'Other equity',
    requires: ['movement per reserve (opening, additions, utilisations, closing)'] }),
  L('share_warrants', 'Money received against share warrants', 'EQUITY', { order: 120 }),
  L('share_application_money', 'Share application money pending allotment', 'EQUITY', { order: 130 }),

  // ---------------- NON-CURRENT LIABILITIES ----------------
  L('lt_borrowings', 'Long-term borrowings', 'NCL', { order: 200,
    indasCaption: 'Borrowings',
    requires: ['secured / unsecured', 'nature of security', 'terms of repayment',
               'rate of interest', 'default in repayment of principal or interest',
               'loans guaranteed by directors'] }),
  L('lease_liabilities_nc', 'Lease liabilities', 'NCL', { division: 'INDAS', order: 205 }),
  L('deferred_tax_liability', 'Deferred tax liabilities (net)', 'NCL', { order: 210 }),
  L('other_lt_liabilities', 'Other long-term liabilities', 'NCL', { order: 220 }),
  L('lt_provisions', 'Long-term provisions', 'NCL', { order: 230 }),

  // ---------------- CURRENT LIABILITIES ----------------
  L('st_borrowings', 'Short-term borrowings', 'CL', { order: 300,
    indasCaption: 'Borrowings',
    requires: ['secured / unsecured', 'nature of security', 'default in repayment'] }),
  L('current_maturities_ltd', 'Current maturities of long-term debt', 'CL', { order: 305 }),
  L('lease_liabilities_c', 'Lease liabilities', 'CL', { division: 'INDAS', order: 308 }),
  L('trade_payables_msme', 'Trade payables — micro and small enterprises', 'CL', { order: 310,
    requires: ['MSMED s.22 disclosure', 'principal and interest outstanding', 'ageing schedule'] }),
  L('trade_payables_others', 'Trade payables — other than micro and small enterprises', 'CL', { order: 315,
    requires: ['ageing schedule (< 1y, 1-2y, 2-3y, > 3y; disputed separately)'] }),
  L('advances_from_customers', 'Advances from customers', 'CL', { order: 320 }),
  L('statutory_dues', 'Statutory dues payable', 'CL', { order: 325 }),
  L('other_current_liabilities', 'Other current liabilities', 'CL', { order: 330 }),
  L('st_provisions', 'Short-term provisions', 'CL', { order: 340 }),

  // ---------------- NON-CURRENT ASSETS ----------------
  L('ppe', 'Property, plant and equipment', 'NCA', { order: 400,
    requires: ['gross block / additions / disposals / depreciation / net block reconciliation',
               'title deeds not held in the name of the company', 'revaluation by registered valuer'] }),
  L('cwip', 'Capital work-in-progress', 'NCA', { order: 405,
    requires: ['CWIP ageing schedule', 'projects overdue or exceeding cost'] }),
  L('intangibles', 'Other intangible assets', 'NCA', { order: 410,
    requires: ['gross block / amortisation / net block reconciliation'] }),
  L('intangibles_under_dev', 'Intangible assets under development', 'NCA', { order: 415,
    requires: ['ageing schedule', 'projects overdue or exceeding cost'] }),
  L('nc_investments', 'Non-current investments', 'NCA', { order: 420,
    requires: ['quoted / unquoted', 'aggregate market value', 'provision for diminution'] }),
  L('deferred_tax_asset', 'Deferred tax assets (net)', 'NCA', { order: 430 }),
  L('lt_loans_advances', 'Long-term loans and advances', 'NCA', { order: 440,
    requires: ['loans to promoters, directors, KMP and related parties'] }),
  L('other_nc_assets', 'Other non-current assets', 'NCA', { order: 450 }),

  // ---------------- CURRENT ASSETS ----------------
  L('current_investments', 'Current investments', 'CA', { order: 500 }),
  L('inventories', 'Inventories', 'CA', { order: 510,
    requires: ['mode of valuation', 'class-wise break-up', 'goods in transit'] }),
  L('trade_receivables', 'Trade receivables', 'CA', { order: 520,
    requires: ['ageing schedule (< 6m, 6m-1y, 1-2y, 2-3y, > 3y)',
               'undisputed / disputed × considered good / doubtful',
               'allowance for doubtful debts', 'debts due from directors or officers'] }),
  L('cash_and_equivalents', 'Cash and cash equivalents', 'CA', { order: 530 }),
  L('bank_other_balances', 'Bank balances other than cash and cash equivalents', 'CA', { order: 535,
    requires: ['deposits with maturity > 3 months', 'margin money / restricted balances'] }),
  L('st_loans_advances', 'Short-term loans and advances', 'CA', { order: 540,
    requires: ['loans to promoters, directors, KMP and related parties'] }),
  L('advances_to_suppliers', 'Advances to suppliers', 'CA', { order: 545 }),
  L('other_current_assets', 'Other current assets', 'CA', { order: 550 }),

  // ---------------- INCOME ----------------
  L('revenue_operations', 'Revenue from operations', 'INCOME', { order: 600,
    requires: ['sale of products / services / other operating revenues'] }),
  L('other_income', 'Other income', 'INCOME', { order: 610,
    requires: ['interest income', 'dividend income', 'net gain on sale of investments', 'other non-operating income'] }),

  // ---------------- EXPENSES ----------------
  L('cost_materials_consumed', 'Cost of materials consumed', 'EXPENSE', { order: 700 }),
  L('purchases_stock_in_trade', 'Purchases of stock-in-trade', 'EXPENSE', { order: 710 }),
  L('changes_in_inventories', 'Changes in inventories of finished goods, work-in-progress and stock-in-trade', 'EXPENSE', { order: 720 }),
  L('employee_benefits', 'Employee benefits expense', 'EXPENSE', { order: 730,
    requires: ['salaries and wages', 'contribution to provident and other funds', 'staff welfare'] }),
  L('finance_costs', 'Finance costs', 'EXPENSE', { order: 740,
    requires: ['interest expense', 'other borrowing costs', 'exchange difference regarded as interest'] }),
  L('depreciation_amortisation', 'Depreciation and amortisation expense', 'EXPENSE', { order: 750 }),
  L('other_expenses', 'Other expenses', 'EXPENSE', { order: 760,
    requires: ['payment to auditors', 'CSR expenditure', 'items exceeding 1% of revenue or ₹10 lakh'] }),

  // ---------------- BELOW THE LINE ----------------
  L('exceptional_items', 'Exceptional items', 'EXPENSE', { order: 800, note: false }),
  L('extraordinary_items', 'Extraordinary items', 'EXPENSE', { division: 'AS', order: 810, note: false }),
  L('prior_period_items', 'Prior period items', 'EXPENSE', { division: 'AS', order: 820, note: false }),

  // ---------------- TAX ----------------
  L('current_tax', 'Current tax', 'TAX', { order: 900 }),
  L('deferred_tax', 'Deferred tax', 'TAX', { order: 910 }),
  L('tax_earlier_years', 'Tax relating to earlier years', 'TAX', { order: 920 }),

  // ---------------- OCI (Ind AS) ----------------
  L('oci_not_reclassified', 'Items that will not be reclassified to profit or loss', 'OCI', { division: 'INDAS', order: 950 }),
  L('oci_reclassified', 'Items that will be reclassified to profit or loss', 'OCI', { division: 'INDAS', order: 960 }),

  // ---------------- CONTROL ----------------
  L('unclassified', 'Unclassified — requires a Schedule III head', 'UNCLASSIFIED', { order: 9999 }),
];

const BY_ID = new Map(LINES.map((l) => [l.id, l]));
export const line = (id) => BY_ID.get(id) || null;
export const hasLine = (id) => BY_ID.has(id);

/** Lines applicable to a reporting division ('AS' | 'INDAS'). */
export function linesFor(division) {
  return LINES.filter((l) => l.division === 'BOTH' || l.division === division)
    .sort((a, b) => a.order - b.order);
}

export function captionFor(id, division) {
  const l = line(id);
  if (!l) return id;
  return division === 'INDAS' && l.indasCaption ? l.indasCaption : l.caption;
}

export const sectionOf = (id) => (line(id) ? line(id).section : 'UNCLASSIFIED');
export const sideOf = (id) => SECTIONS[sectionOf(id)].side;
export const statementOf = (id) => SECTIONS[sectionOf(id)].statement;

/**
 * Presentation sign: the engine stores every balance in its NATURAL Dr/Cr sign
 * (Dr positive). A face presents each line as a positive number in its own
 * nature, so Cr-side lines are negated for display. Nothing is ever shown
 * negative merely because of the bookkeeping side.
 */
export function presentationValue(id, drPositivePaise) {
  return sideOf(id) === 'Cr' ? -drPositivePaise : drPositivePaise;
}

/** Assign display note numbers to the lines actually carrying a note. */
export function assignNoteNumbers(usedLineIds, division, startAt = 1) {
  const ordered = linesFor(division).filter((l) => l.note && usedLineIds.has(l.id));
  const map = new Map();
  let n = startAt;
  for (const l of ordered) map.set(l.id, n++);
  return map;
}
