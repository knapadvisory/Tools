/* ============================================================================
 * subgroup.js — what a note line is, between the head and the ledger
 *
 * Tally already holds the answer. A ledger is booked as
 *
 *      Grouping  ▸  Sub-grouping  ▸  Ledger
 *      Other Current Liabilities ▸ Reimbursement Payable ▸ Neeraj
 *
 * The Grouping decides the Schedule III head; the SUB-GROUPING is the note
 * line; the ledger is the detail behind it. So the note shows
 * "Reimbursement Payable" as one figure, with Neeraj's ledger underneath it.
 * A ledger that sits directly under a Tally group has no sub-grouping and is
 * shown on its own line, exactly as it is named.
 *
 * Tally's own groups (Sundry Creditors, Bank Accounts, Duties & Taxes …) are
 * never sub-groupings: they are the grouping. Only a group the company created
 * itself can be one, which is what makes this reliable — it reads the chart of
 * accounts rather than guessing from wording.
 *
 * Resolution order for one ledger, highest first:
 *   1. a caption the preparer set by hand;
 *   2. the sub-grouping in Tally;
 *   3. a proposal from wording, for books with no sub-groups at all;
 *   4. the ledger's own name.
 * Every line records WHICH of these it came from, so a figure is never merged
 * without the note saying on what authority.
 * ==========================================================================*/

import { linesFor } from './schedule3.js';

const STOP = new Set(['a', 'an', 'the', 'and', 'of', 'for', 'to', 'ac', 'a c', 'account', 'accounts']);

/** tokens, lower-cased, with punctuation and Tally's "A/c" suffix removed */
export function tokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\ba\s*\/\s*c\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
}
const titleCase = (s) => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));

/* -------------------------------------------------- Tally's own groups ---- */
/**
 * The groups Tally ships with — the 15 primary groups and the 13 reserved
 * sub-groups. A ledger's parent being one of these means the company did NOT
 * sub-group it, so it belongs on the note under its own name.
 */
const DEFAULT_GROUPS = [
  // primary
  'primary', 'branch divisions', 'capital account', 'current assets', 'current liabilities',
  'direct expenses', 'direct incomes', 'fixed assets', 'indirect expenses', 'indirect incomes',
  'investments', 'loans liability', 'misc expenses asset', 'purchase accounts', 'sales accounts',
  'suspense', 'suspense a c',
  // reserved sub-groups
  'bank accounts', 'bank od', 'bank occ', 'bank od a c', 'bank occ a c', 'cash in hand',
  'deposits asset', 'duties taxes', 'loans advances asset', 'provisions', 'reserves surplus',
  'secured loans', 'stock in hand', 'sundry creditors', 'sundry debtors', 'unsecured loans',
  // wording Tally and its users vary on, all still the grouping, never a sub-group
  'current liability', 'current asset', 'direct income', 'indirect income', 'direct expense',
  'indirect expense', 'misc expenses', 'miscellaneous expenses asset', 'loans',
];
const groupKey = (s) => tokens(s).join(' ');
export const TALLY_DEFAULT_GROUPS = new Set(DEFAULT_GROUPS.map(groupKey));

/**
 * A group that NAMES a Schedule III head is the grouping, whoever created it.
 * "Other Current Liabilities" and "Short Term Provisions" do not ship with
 * Tally, but a company that creates them is stating the head, not a note line.
 */
const HEAD_NAMES = new Set([
  ...linesFor('AS').map((l) => groupKey(l.caption)),
  ...linesFor('INDAS').map((l) => groupKey(l.caption)),
  ...linesFor('INDAS').map((l) => groupKey(l.indasCaption || '')),
  ...['other current liabilities', 'other current liability', 'other current assets',
      'other non current assets', 'other non current liabilities', 'other long term liabilities',
      'short term provisions', 'long term provisions', 'short term borrowings',
      'long term borrowings', 'short term loans advances', 'long term loans advances',
      'trade payables', 'trade payable', 'trade receivables', 'trade receivable',
      'cash cash equivalents', 'cash bank balances', 'fixed assets', 'tangible assets',
      'intangible assets', 'capital work in progress', 'current investments',
      'non current investments', 'share capital', 'other income', 'other expenses',
      'revenue from operations', 'employee benefits expense', 'finance costs',
      'depreciation amortisation expense', 'statutory dues', 'statutory dues payable',
     ].map(groupKey),
].filter(Boolean));

/**
 * Is this name a GROUPING — a group Tally ships with, or one that names a
 * Schedule III head — rather than a sub-grouping the company created?
 */
export function isGroupingName(name) {
  const k = groupKey(name);
  return !k || TALLY_DEFAULT_GROUPS.has(k) || HEAD_NAMES.has(k);
}

/** @deprecated kept for callers that only asked about Tally's built-in groups */
export const isDefaultGroup = isGroupingName;

/**
 * The sub-grouping a ledger is booked under, or null when it has none.
 *
 * `groupPath` runs from the ledger's immediate parent up to the primary group.
 * Where the company nested its own groups, the note takes the OUTERMOST of
 * them — the one nearest the Schedule III head — so the note stays a summary
 * and the detail stays underneath it.
 */
export function subGroupOf(ledger) {
  let chain = (ledger && ledger.groupPath && ledger.groupPath.length)
    ? ledger.groupPath.slice()
    : [ledger && ledger.group, ledger && ledger.primary];
  chain = chain.filter((x) => x && !/^primary$/i.test(String(x)));
  if (!chain.length) return null;
  // Guard against a connector that hands the chain the other way round: the end
  // holding Tally's own groups is the primary end, and that is where we count from.
  if (isGroupingName(chain[0]) && !isGroupingName(chain[chain.length - 1])) chain.reverse();

  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isGroupingName(chain[i])) return String(chain[i]).trim();
  }
  return null;
}

/* ------------------------------- a proposal, for books with no sub-groups -- */
/**
 * Nature keywords, used ONLY where Tally offers no sub-grouping at all. The
 * VALUE is the caption proposed. These exist so that books kept as a flat list
 * of ledgers still read as a note; the preparer sees the proposal in the
 * grouping review and can reject it.
 */
export const NATURE = [
  [['salary', 'payable'], 'Salary payable'],
  [['salaries', 'payable'], 'Salary payable'],
  [['wages', 'payable'], 'Wages payable'],
  [['bonus', 'payable'], 'Bonus payable'],
  [['reimbursement'], 'Reimbursements payable'],
  [['audit', 'fee'], 'Audit fee payable'],
  [['professional', 'fee'], 'Professional fees payable'],
  [['rent', 'payable'], 'Rent payable'],
  [['electricity', 'payable'], 'Electricity payable'],
  [['telephone', 'payable'], 'Telephone payable'],
  [['tds', 'payable'], 'TDS payable'],
  [['tcs', 'payable'], 'TCS payable'],
  [['gst', 'payable'], 'GST payable'],
  [['pf', 'payable'], 'Provident fund payable'],
  [['provident', 'fund'], 'Provident fund payable'],
  [['esi', 'payable'], 'ESI payable'],
  [['professional', 'tax'], 'Professional tax payable'],
  [['gratuity'], 'Gratuity'],
  [['security', 'deposit'], 'Security deposits'],
  [['advance', 'salary'], 'Advance to employees'],
  [['salary', 'advance'], 'Advance to employees'],
  [['imprest'], 'Imprest with employees'],
  [['expenses', 'payable'], 'Expenses payable'],
  [['outstanding', 'expenses'], 'Expenses payable'],
  [['accrued'], 'Accrued expenses'],
  [['prepaid'], 'Prepaid expenses'],
];

function natureOf(name) {
  const t = tokens(name);
  const has = (w) => t.includes(w);
  let best = null, bestLen = 0;
  for (const [words, caption] of NATURE) {
    if (words.every(has) && words.length > bestLen) { best = caption; bestLen = words.length; }
  }
  return best;
}

/**
 * Heads on which the identity of the other party IS the disclosure, so a
 * proposal is never made. Who the bank is, who the lender is and which asset
 * block a figure sits in are all part of what the note has to say. A real
 * sub-grouping in Tally, or a caption the preparer sets, still applies.
 */
export const IDENTITY_HEADS = new Set([
  'share_capital', 'reserves_surplus', 'share_warrants', 'share_application_money',
  'lt_borrowings', 'st_borrowings', 'current_maturities_ltd',
  'trade_payables_msme', 'trade_payables_others', 'trade_receivables',
  'cash_and_equivalents', 'bank_other_balances',
  'nc_investments', 'current_investments',
  'ppe', 'cwip', 'intangibles', 'intangibles_under_dev',
  'deferred_tax_asset', 'deferred_tax_liability',
]);

/**
 * Trailing words that say what KIND of entity a party is, never what the
 * balance is. A caption made only of these would name nobody.
 */
const GENERIC_RUN = new Set([
  'bank', 'ltd', 'limited', 'pvt', 'pvt ltd', 'private', 'private limited',
  'llp', 'inc', 'co', 'company', 'corporation', 'corp',
  'enterprise', 'enterprises', 'traders', 'trading', 'sons', 'brothers',
  'industries', 'services', 'solutions', 'technologies', 'associates',
  'india', 'bros', 'agencies', 'stores', 'group',
]);

/** trailing token runs of length 1..maxLen, longest first */
function tailRuns(t, maxLen = 4) {
  const out = [];
  for (let n = Math.min(maxLen, t.length); n >= 1; n--) out.push(t.slice(t.length - n).join(' '));
  return out;
}

/* ------------------------------------------------------------ resolution -- */
/**
 * Decide the note line for every ledger inside ONE Schedule III head.
 *
 * @param entries    [{name, subGroup}] — subGroup as Tally holds it, or null
 * @param overrides  { [ledgerName]: 'caption' } — always wins
 * @param lineId     the head, so proposals are withheld on identity heads
 * @returns Map<ledgerName, {label, basis, source}>
 *          source is 'preparer' | 'tally' | 'proposed' | 'ledger'
 */
export function deriveSubGroups(entries, overrides = {}, lineId = null) {
  const list = (entries || []).map((e) => (typeof e === 'string' ? { name: e, subGroup: null } : e));
  const out = new Map();
  const undecided = [];

  for (const e of list) {
    const name = e.name;
    if (overrides[name]) {
      out.set(name, { label: overrides[name], basis: 'caption set by the preparer', source: 'preparer' });
    } else if (e.subGroup) {
      out.set(name, { label: String(e.subGroup).trim(),
        basis: `sub-grouped in Tally under “${String(e.subGroup).trim()}”`, source: 'tally' });
    } else {
      undecided.push(name);
    }
  }

  // No sub-grouping in Tally. Propose a caption only where the wording is
  // unmistakable, and never where the counterparty is the disclosure.
  if (IDENTITY_HEADS.has(lineId)) {
    for (const name of undecided) {
      out.set(name, { label: name, basis: 'not sub-grouped — the party is part of the disclosure', source: 'ledger' });
    }
    return out;
  }

  const stillUndecided = [];
  for (const name of undecided) {
    const nat = natureOf(name);
    if (nat) out.set(name, { label: nat, basis: 'proposed from the ledger’s wording — not sub-grouped in Tally', source: 'proposed' });
    else stillUndecided.push(name);
  }

  // The longest run of trailing words shared by two or more ledgers, so
  // party-specific prefixes fall away without a dictionary.
  const counts = new Map();
  for (const name of stillUndecided) {
    for (const run of tailRuns(tokens(name))) counts.set(run, (counts.get(run) || 0) + 1);
  }
  for (const name of stillUndecided) {
    const run = tailRuns(tokens(name))
      .find((r) => (counts.get(r) || 0) >= 2 && r.length > 2 && !GENERIC_RUN.has(r));
    out.set(name, run
      ? { label: titleCase(run), basis: `proposed from wording shared by ${counts.get(run)} ledgers — not sub-grouped in Tally`, source: 'proposed' }
      : { label: name, basis: 'not sub-grouped — shown on its own line', source: 'ledger' });
  }

  // A proposal exists only to MERGE. One that ends up covering a single ledger
  // has merged nothing, so it would be renaming the ledger for no reason — the
  // ledger goes back to being shown directly, under its own name.
  const perLabel = new Map();
  for (const [, g] of out) if (g.source === 'proposed') perLabel.set(g.label, (perLabel.get(g.label) || 0) + 1);
  for (const [name, g] of out) {
    if (g.source === 'proposed' && perLabel.get(g.label) === 1) {
      out.set(name, { label: name, basis: 'not sub-grouped — shown on its own line', source: 'ledger' });
    }
  }
  return out;
}

/**
 * Apply sub-grouping across every head.
 * @param byLine  Map<lineId, [{name, subGroup}]>
 */
export function deriveAll(byLine, overrides = {}) {
  const res = new Map();
  for (const [lineId, entries] of byLine) res.set(lineId, deriveSubGroups(entries, overrides, lineId));
  return res;
}
