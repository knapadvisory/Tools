/* ============================================================================
 * subgroup.js — aggregate ledgers of the same nature into one note line
 *
 * A note must read as a statement, not as a copy of the ledger list. Three
 * ledgers called "Yeeun Choi Salary Payable", "Yeeun Cho Salary Payable" and
 * "Welmin Manar Salary Payable" belong on ONE line — "Salary payable" — with
 * the individual ledgers still traceable underneath.
 *
 * Two ways a sub-group is decided, in order:
 *   1. A keyword the tool recognises (salary payable, audit fee, rent payable…).
 *   2. The longest run of trailing words shared by two or more ledgers in the
 *      same head, so party-specific prefixes fall away on their own. This needs
 *      no dictionary and copes with wording the tool has never seen.
 * A ledger that matches neither keeps its own name, so nothing is ever merged
 * merely because it had nowhere else to go.
 *
 * Merging is SUPPRESSED where the counterparty is itself the disclosure. Three
 * employees' salary ledgers are one liability; "HDFC Bank" and "Axis Bank" are
 * two bank balances and must never collapse onto a line called "Bank".
 *
 * The preparer can override any of it; the override is what the note uses.
 * ==========================================================================*/

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

/**
 * Nature keywords. The VALUE is the caption the note will show. These exist so
 * that ledgers worded differently ("Salary Payable" vs "Payable - Salaries")
 * still land together, and so a single ledger of a known nature gets a proper
 * caption instead of a person's name.
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

/**
 * Heads on which the identity of the other party IS the disclosure, so ledgers
 * are never merged automatically. Who the bank is, who the lender is and which
 * asset block a figure sits in are all part of what the note has to say.
 * A caption the preparer sets by hand still applies — this suppresses guessing,
 * not the preparer.
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
 * balance is. A run made only of these would produce a caption such as "Ltd"
 * or "Bank", which names nobody and discloses nothing.
 */
const GENERIC_RUN = new Set([
  'bank', 'ltd', 'limited', 'pvt', 'pvt ltd', 'private', 'private limited',
  'llp', 'inc', 'co', 'company', 'corporation', 'corp',
  'enterprise', 'enterprises', 'traders', 'trading', 'sons', 'brothers',
  'industries', 'services', 'solutions', 'technologies', 'associates',
  'india', 'bros', 'agencies', 'stores', 'group',
]);

function natureOf(name) {
  const t = tokens(name);
  const has = (w) => t.includes(w);
  let best = null, bestLen = 0;
  for (const [words, caption] of NATURE) {
    if (words.every(has) && words.length > bestLen) { best = caption; bestLen = words.length; }
  }
  return best;
}

/** trailing token runs of length 1..maxLen, longest first */
function tailRuns(t, maxLen = 4) {
  const out = [];
  for (let n = Math.min(maxLen, t.length); n >= 1; n--) out.push(t.slice(t.length - n).join(' '));
  return out;
}

/**
 * Decide a sub-group for every ledger inside ONE head.
 * @param names   ledger names in that head
 * @param overrides  { [ledgerName]: 'caption' } — always wins
 * @param lineId  the Schedule III head, so identity heads can be left alone
 * @returns Map<ledgerName, {label, basis}>
 */
export function deriveSubGroups(names, overrides = {}, lineId = null) {
  const out = new Map();
  const undecided = [];
  const identityHead = IDENTITY_HEADS.has(lineId);

  for (const name of names) {
    if (overrides[name]) { out.set(name, { label: overrides[name], basis: 'set by the preparer' }); continue; }
    if (identityHead) { out.set(name, { label: name, basis: 'kept on its own line — the party is part of the disclosure' }); continue; }
    const nat = natureOf(name);
    if (nat) out.set(name, { label: nat, basis: 'recognised nature' });
    else undecided.push(name);
  }

  // Shared trailing wording, longest run first. A run must be shared by at
  // least two ledgers, otherwise merging would be guesswork.
  const counts = new Map();
  for (const name of undecided) {
    for (const run of tailRuns(tokens(name))) counts.set(run, (counts.get(run) || 0) + 1);
  }
  for (const name of undecided) {
    const run = tailRuns(tokens(name))
      .find((r) => (counts.get(r) || 0) >= 2 && r.length > 2 && !GENERIC_RUN.has(r));
    out.set(name, run
      ? { label: titleCase(run), basis: `shared wording in ${counts.get(run)} ledgers` }
      : { label: name, basis: 'kept on its own line' });
  }
  return out;
}

/**
 * Apply sub-grouping across every head.
 * @param byLineNames  Map<lineId, string[]>  ledger names per head
 * @returns Map<lineId, Map<ledgerName, {label, basis}>>
 */
export function deriveAll(byLineNames, overrides = {}) {
  const res = new Map();
  for (const [lineId, names] of byLineNames) res.set(lineId, deriveSubGroups(names, overrides, lineId));
  return res;
}
