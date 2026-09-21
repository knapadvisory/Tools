/* ============================================================================
 * disclosures.js — the Schedule III (Companies Act, 2013) disclosure register
 *
 * Source: Schedule III to the Companies Act, 2013 as reproduced in the supplied
 * text — Division I (Companies (Accounting Standards) Rules, 2006) and
 * Division II (Companies (Indian Accounting Standards) Rules, 2015), including
 * Part I (Balance Sheet), Part II (Statement of Profit and Loss) and the
 * general instructions for consolidated financial statements.
 *
 * SCOPE WARNING — the source text is the PRE-2021-amendment Schedule III.
 * It therefore contains NO requirement for: title deeds of immovable property
 * not held in the name of the company, CWIP / intangible-under-development
 * ageing schedules, trade receivable / trade payable ageing schedules,
 * revaluation by a registered valuer, promoter shareholding, loans or advances
 * to promoters / directors / KMP in the 2021 tabular form, benami property,
 * borrowings vs. quarterly returns filed with banks, wilful defaulter,
 * relationship with struck-off companies, registration / satisfaction of
 * charges, compliance with the number of layers of companies, the eleven
 * analytical ratios, scheme of arrangement, utilisation of borrowed funds and
 * share premium, undisclosed income, or crypto currency / virtual currency.
 * Nothing of that kind is recorded here, because it is not in the document.
 * CSR expenditure IS in the document and IS recorded.
 *
 * Pure data. No I/O, no side effects.
 * Line ids are the stable ids defined in ./schedule3.js. A lineId of '' means
 * the requirement does not belong to any single statement line.
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * General instructions — rounding, comparatives, the current/non-current
 * tests, the operating cycle, and the trade receivable / trade payable
 * definitions.
 * ------------------------------------------------------------------------*/
export const GENERAL_INSTRUCTIONS = [
  {
    id: 'gi_schedule_yields_to_act_and_as',
    text: 'Where compliance with the Act, including the Accounting Standards / Indian Accounting Standards applicable to the company, requires any change in treatment or disclosure — addition, amendment, substitution or deletion in a head or sub-head, or any change inter se in the financial statements — that change shall be made and the requirements of this Schedule stand modified accordingly.',
    citation: 'Schedule III Div I, General Instructions 1; Div II, General Instructions 2',
  },
  {
    id: 'gi_additional_not_substitutive',
    text: 'The disclosures specified in this Schedule are in addition to, and not in substitution of, the disclosures specified in the Accounting Standards / Indian Accounting Standards. Additional disclosures required by the standards go in the notes or an additional statement unless the standard requires them on the face. All other disclosures required by the Companies Act shall likewise be made in the notes in addition to this Schedule.',
    citation: 'Schedule III Div I, General Instructions 2; Div II, General Instructions 3',
  },
  {
    id: 'gi_notes_content',
    text: 'Notes shall contain information in addition to that presented in the financial statements and shall provide, where required, (a) narrative descriptions or disaggregations of items recognised in those statements and (b) information about items that do not qualify for recognition in those statements.',
    citation: 'Schedule III Div I, General Instructions 3(i); Div II, General Instructions 4(i)',
  },
  {
    id: 'gi_cross_reference_and_balance',
    text: 'Each item on the face of the Balance Sheet, the Statement of Changes in Equity (Div II) and the Statement of Profit and Loss shall be cross-referenced to any related information in the notes. A balance shall be maintained between excessive detail that does not assist users and loss of important information through too much aggregation.',
    citation: 'Schedule III Div I, General Instructions 3(ii); Div II, General Instructions 4(ii)',
  },
  {
    id: 'gi_rounding',
    text: 'Depending upon the turnover of the company the figures appearing in the financial statements may be rounded off: turnover less than one hundred crore rupees — to the nearest hundreds, thousands, lakhs or millions, or decimals thereof; turnover of one hundred crore rupees or more — to the nearest lakhs, millions or crores, or decimals thereof. See ROUNDING_RULE.',
    citation: 'Schedule III Div I, General Instructions 4(i); Div II, General Instructions 5',
  },
  {
    id: 'gi_rounding_uniform',
    text: 'Once a unit of measurement is used, it shall be used uniformly throughout the financial statements.',
    citation: 'Schedule III Div I, General Instructions 4(ii); Div II, General Instructions 5',
  },
  {
    id: 'gi_comparatives',
    text: 'Except in the case of the first financial statements laid before the company after its incorporation, the corresponding amounts (comparatives) for the immediately preceding reporting period shall be given for ALL items shown in the financial statements, including the notes.',
    citation: 'Schedule III Div I, General Instructions 5; Div II, General Instructions 6',
  },
  {
    id: 'gi_materiality',
    text: 'Financial statements shall disclose all material items, i.e. items that could, individually or collectively, influence the economic decisions that users make on the basis of the financial statements. Materiality depends on the size or the nature of the item, or a combination of both, judged in the particular circumstances.',
    citation: 'Schedule III Div II, General Instructions 7',
  },
  {
    id: 'gi_terms_per_standards',
    text: 'For the purpose of this Schedule the terms used herein shall have the meanings assigned to them in the applicable Accounting Standards / Indian Accounting Standards.',
    citation: 'Schedule III Div I, General Instructions 6; Div II, General Instructions 8',
  },
  {
    id: 'gi_other_statutory_disclosures',
    text: 'Where any Act or Regulation requires a specific disclosure in the standalone financial statements, that disclosure shall be made in addition to those required under this Schedule.',
    citation: 'Schedule III Div II, General Instructions 9',
  },
  {
    id: 'gi_minimum_requirements',
    text: 'This Schedule sets out the MINIMUM requirements for disclosure on the face of the Balance Sheet, the Statement of Changes in Equity (Div II), the Statement of Profit and Loss and the Notes. Line items, sub-line items and sub-totals shall be presented as an addition to or substitution on the face of the financial statements when relevant to an understanding of the company’s financial position or performance, or to cater to industry or sector-specific disclosure, or when required for compliance with amendments to the Companies Act or the standards.',
    citation: 'Schedule III Div I, Note following General Instructions 6; Div II, Note following General Instructions 9',
  },
  {
    id: 'gi_current_asset_test',
    text: 'An asset shall be classified as current when it satisfies ANY of: (a) it is expected to be realised in, or is intended for sale or consumption in, the normal operating cycle; (b) it is held primarily for the purpose of being traded; (c) it is expected to be realised within twelve months after the reporting date; or (d) it is cash or a cash equivalent unless restricted from being exchanged or used to settle a liability for at least twelve months after the reporting date. All other assets are non-current. See CURRENT_NONCURRENT_TESTS.asset.',
    citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 1; Div II, same 1',
  },
  {
    id: 'gi_operating_cycle',
    text: 'An operating cycle is the time between the acquisition of assets for processing and their realisation in cash or cash equivalents. Where the normal operating cycle cannot be identified, it is assumed to have a duration of twelve months.',
    citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 2; Div II, same 2',
  },
  {
    id: 'gi_current_liability_test',
    text: 'A liability shall be classified as current when it satisfies ANY of: (a) it is expected to be settled in the normal operating cycle; (b) it is held primarily for the purpose of being traded; (c) it is due to be settled within twelve months after the reporting date; or (d) the company does not have an unconditional right to defer settlement for at least twelve months after the reporting date. Terms of a liability that could, at the option of the counterparty, result in its settlement by the issue of equity instruments do not affect its classification. All other liabilities are non-current. See CURRENT_NONCURRENT_TESTS.liability.',
    citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 3; Div II, same 3',
  },
  {
    id: 'gi_trade_receivable_definition',
    text: 'A receivable shall be classified as a ‘trade receivable’ if it is in respect of the amount due on account of goods sold or services rendered in the normal course of business.',
    citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 4; Div II, same 4',
  },
  {
    id: 'gi_trade_payable_definition',
    text: 'A payable shall be classified as a ‘trade payable’ if it is in respect of the amount due on account of goods purchased or services received in the normal course of business.',
    citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 5; Div II, same 5',
  },
  {
    id: 'gi_long_term_debt_definition',
    text: '‘Long-term debt’ is a borrowing having a period of more than twelve months at the time of origination.',
    citation: 'Schedule III Div II, Note 6(F)(II), note following clause (h)',
  },
  {
    id: 'gi_opening_balance_sheet_on_restatement',
    text: 'When a company applies an accounting policy retrospectively, restates items, or reclassifies items in its financial statements, it shall attach a Balance Sheet as at the beginning of the earliest comparative period presented.',
    citation: 'Schedule III Div II, General Instructions for Preparation of Balance Sheet 7',
  },
  {
    id: 'gi_share_application_money_classification',
    text: 'Share application money pending allotment shall be classified into equity or liability in accordance with the relevant Indian Accounting Standards. The amount not refundable is shown under Equity; the amount refundable is shown separately under ‘Other financial liabilities’.',
    citation: 'Schedule III Div II, General Instructions for Preparation of Balance Sheet 8',
  },
  {
    id: 'gi_preference_shares_classification',
    text: 'Preference shares, including premium received on issue, shall be classified and presented as Equity or Liability per the relevant Ind AS, and the disclosure and presentation requirements of that class apply mutatis mutandis. Plain vanilla redeemable preference shares are presented under non-current liabilities as borrowings.',
    citation: 'Schedule III Div II, General Instructions for Preparation of Balance Sheet 9',
  },
  {
    id: 'gi_compound_financial_instruments',
    text: 'Compound financial instruments such as convertible debentures, where split into equity and liability components per the relevant Ind AS, shall be classified and presented under the relevant heads in Equity and in Liabilities.',
    citation: 'Schedule III Div II, General Instructions for Preparation of Balance Sheet 10',
  },
  {
    id: 'gi_regulatory_deferral_balances',
    text: 'Regulatory Deferral Account Balances shall be presented in the Balance Sheet, and changes in them in the Statement of Profit and Loss, in accordance with the relevant Indian Accounting Standards.',
    citation: 'Schedule III Div II, General Instructions for Preparation of Balance Sheet 11; Div II Part II, General Instructions 8',
  },
  {
    id: 'gi_pl_applies_to_income_and_expenditure_account',
    text: 'The provisions of Part II apply to the income and expenditure account referred to in sub-clause (ii) of clause (40) of section 2 in like manner as they apply to a statement of profit and loss.',
    citation: 'Schedule III Div I Part II, General Instructions 1; Div II Part II, General Instructions 1',
  },
  {
    id: 'gi_total_comprehensive_income',
    text: 'The Statement of Profit and Loss shall include (1) profit or loss for the period and (2) other comprehensive income for the period; the sum of the two is ‘Total Comprehensive Income’.',
    citation: 'Schedule III Div II Part II, General Instructions 2',
  },
  {
    id: 'gi_broad_heads_materiality',
    text: 'Broad heads shall be decided taking into account the concept of materiality and the presentation of a true and fair view of the financial statements.',
    citation: 'Schedule III Div I Part II, Note following General Instructions 5',
  },
];

/* ---------------------------------------------------------------------------
 * The current / non-current tests, verbatim.
 * ------------------------------------------------------------------------*/
export const CURRENT_NONCURRENT_TESTS = {
  asset: [
    { id: 'ca_operating_cycle', test: 'it is expected to be realized in, or is intended for sale or consumption in, the company’s normal operating cycle', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 1(a)', division: 'BOTH' },
    { id: 'ca_held_for_trading', test: 'it is held primarily for the purpose of being traded', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 1(b)', division: 'BOTH' },
    { id: 'ca_twelve_months', test: 'it is expected to be realized within twelve months after the reporting date', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 1(c)', division: 'BOTH' },
    { id: 'ca_cash_unrestricted', test: 'it is cash or cash equivalent unless it is restricted from being exchanged or used to settle a liability for at least twelve months after the reporting date', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 1(d)', division: 'BOTH' },
    { id: 'ca_residual', test: 'All other assets shall be classified as non-current.', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 1 (closing words); Div II, same 1', division: 'BOTH' },
    { id: 'ca_operating_cycle_default', test: 'An operating cycle is the time between the acquisition of assets for processing and their realization in cash or cash equivalents. Where the normal operating cycle cannot be identified, it is assumed to have a duration of 12 months.', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 2; Div II, same 2', division: 'BOTH' },
  ],
  liability: [
    { id: 'cl_operating_cycle', test: 'it is expected to be settled in the company’s normal operating cycle', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 3(a)', division: 'BOTH' },
    { id: 'cl_held_for_trading', test: 'it is held primarily for the purpose of being traded', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 3(b)', division: 'BOTH' },
    { id: 'cl_twelve_months', test: 'it is due to be settled within twelve months after the reporting date', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 3(c)', division: 'BOTH' },
    { id: 'cl_no_unconditional_deferral', test: 'the company does not have an unconditional right to defer settlement of the liability for at least twelve months after the reporting date. Terms of a liability that could, at the option of the counterparty, result in its settlement by the issue of equity instruments do not affect its classification', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 3(d)', division: 'BOTH' },
    { id: 'cl_residual', test: 'All other liabilities shall be classified as non-current.', citation: 'Schedule III Div I, General Instructions for Preparation of Balance Sheet 3 (closing words); Div II, same 3', division: 'BOTH' },
  ],
};

/* ---------------------------------------------------------------------------
 * Rounding. `turnoverBelowCrore` / `turnoverAtLeastCrore` are in rupees crore.
 * ------------------------------------------------------------------------*/
export const ROUNDING_RULE = [
  {
    turnoverBelowCrore: 100,
    turnoverAtLeastCrore: null,
    permitted: ['hundreds', 'thousands', 'lakhs', 'millions'],
    decimalsThereofAllowed: true,
    citation: 'Schedule III Div I, General Instructions 4(i)(a); Div II, General Instructions 5(i)',
  },
  {
    turnoverBelowCrore: null,
    turnoverAtLeastCrore: 100,
    permitted: ['lakhs', 'millions', 'crores'],
    decimalsThereofAllowed: true,
    citation: 'Schedule III Div I, General Instructions 4(i)(b); Div II, General Instructions 5(ii)',
  },
];

/** Once chosen, the unit of measurement must be used uniformly throughout. */
export const ROUNDING_UNIFORMITY = {
  text: 'Once a unit of measurement is used, it should be used uniformly in the Financial Statements.',
  citation: 'Schedule III Div I, General Instructions 4(ii); Div II, General Instructions 5',
};

/** Every disclosure Schedule III requires, keyed to the line it belongs to. */
export const DISCLOSURES = [
  /* __DISCLOSURES__ */
];

/* __TAIL__ */
