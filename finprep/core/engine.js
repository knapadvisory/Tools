/* ============================================================================
 * engine.js — Original TB → approved journals → Adjusted TB → lines → statements
 *
 * Spec §6 data flow, implemented deterministically in integer paise.
 * Every figure is Dr-positive internally; presentation sign is applied only at
 * the reporting layer so nothing is ever shown negative merely because of the
 * bookkeeping side.
 *
 * Closes audit findings:
 *  C2  Tax is no longer a display-only box. Tax lines come from ledgers or from
 *      an approved adjusting journal, they reduce PAT, and reserves roll forward
 *      on PAT — not PBT. A tax provision keyed without a journal cannot silently
 *      overstate reserves, because there is no such input any more.
 *  C3  Each period is classified from its OWN balance.
 *  C4  Abnormal-side balances move to their alternative head (no netting).
 *  C5  Depreciation classifies straight to the P&L; PPE is never a staging area.
 *  C6  No plug figures anywhere; residuals are reported as failures.
 *  H1  Unclassified stays visible, is reported gross (Dr and Cr), and blocks release.
 *  H7  Every period's balance-sheet difference is checked, not just the current one.
 * ==========================================================================*/

import { toPaise, add, sub, neg, format } from './money.js';
import { line, sectionOf, sideOf, linesFor, captionFor, assignNoteNumbers, SECTIONS, constitutionOf } from './schedule3.js';
import { classifyLedger, lineForBalance } from './classify.js';
import { subGroupOf } from './subgroup.js';
import { ownersAccounts, normaliseOwners, autoAssign } from './owners.js';

const SEV = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', REVIEW: 'REVIEW', INFO: 'INFO' };

/* ---------- normalisation ---------------------------------------------- */
/**
 * Accept the existing connector shape ({name, group, primary, groupPath,
 * current, prior}) as well as an explicit {balances:{...}} form. Amounts arrive
 * in rupees (float) and are converted once, here, to integer paise.
 */
export function normaliseLedgers(raw, periods = ['current', 'prior']) {
  return raw.map((l, i) => {
    const balances = {};
    for (const p of periods) {
      const v = l.balances ? l.balances[p] : l[p];
      balances[p] = toPaise(v == null ? 0 : v);
    }
    // Gross debit and credit movements for the current period, when the
    // source supplied them (the connector sums them from the vouchers). The
    // owners' capital accounts need both sides; a net balance cannot say how
    // much was introduced and how much drawn.
    const dr = l.mov ? l.mov.dr : l.drTotal, cr = l.mov ? l.mov.cr : l.crTotal;
    const mov = (dr != null || cr != null) ? { dr: Math.abs(toPaise(dr || 0)), cr: Math.abs(toPaise(cr || 0)) } : null;
    return {
      id: l.id || l.ledgerId || `L${i}:${l.name}`,   // stable-ish; real id comes from Tally when available
      name: l.name,
      group: l.group || '',
      primary: l.primary || '',
      groupPath: l.groupPath || [],
      gstin: l.gstin || '',
      isRevenue: !!l.isRevenue,
      balances,
      mov,
    };
  });
}

/* ---------- journals ---------------------------------------------------- */
/**
 * A journal must balance in paise. Entries may target a ledger (ledgerId) or a
 * statement line directly (lineId) — spec §6 forbids forcing non-ledger facts
 * into artificial TB entries, but an approved reclassification or provision is
 * a legitimate line-level posting.
 */
export function validateJournal(j) {
  const errs = [];
  if (!j || !Array.isArray(j.entries) || !j.entries.length) errs.push('journal has no entries');
  if (!j.narration) errs.push('journal has no rationale');
  let net = 0;
  for (const e of j.entries || []) {
    if (!e.ledgerId && !e.lineId) errs.push('entry targets neither a ledger nor a line');
    net = add(net, toPaise(e.amount == null ? 0 : e.amount));
  }
  if (net !== 0) errs.push(`journal does not balance (out by ${format(net)})`);
  return { ok: errs.length === 0, errors: errs };
}

/* ---------- the build --------------------------------------------------- */
export function build({ ledgers, journals = [], periods = ['current', 'prior'], division = 'AS',
                        constitution = 'company', owners = [], profitTo = 'capital',
                        overrides = {}, priorOverrides = null }) {
  const leds = normaliseLedgers(ledgers, periods);
  const checks = [];
  // A non-corporate constitution reports in the ICAI format whatever was asked.
  const nce = division === 'NCE' || !constitutionOf(constitution).isCorporate;
  if (nce) division = 'NCE';

  // ---- 1. Original trial balance -------------------------------------
  const originalTB = leds.map((l) => ({ ledgerId: l.id, name: l.name, balances: { ...l.balances } }));
  const tbSum = {};
  for (const p of periods) tbSum[p] = add(...leds.map((l) => l.balances[p]));

  // ---- 2. Approved journals → adjusted trial balance ------------------
  const approved = journals.filter((j) => j.approved);
  const rejected = journals.filter((j) => !j.approved);
  const ledgerAdj = new Map();   // ledgerId -> {period: paise}
  const lineAdj = new Map();     // lineId   -> {period: paise}
  for (const j of approved) {
    const v = validateJournal(j);
    if (!v.ok) {
      checks.push({ id: `JRN-${j.id}`, severity: SEV.CRITICAL, message: `Approved journal ${j.id} is invalid: ${v.errors.join('; ')}` });
      continue;
    }
    const p = j.period || periods[0];
    for (const e of j.entries) {
      const amt = toPaise(e.amount == null ? 0 : e.amount);
      const bag = e.ledgerId ? ledgerAdj : lineAdj;
      const key = e.ledgerId || e.lineId;
      const cur = bag.get(key) || {};
      cur[p] = add(cur[p] || 0, amt);
      bag.set(key, cur);
    }
  }
  const adjustedTB = originalTB.map((r) => {
    const adj = ledgerAdj.get(r.ledgerId) || {};
    const balances = {};
    for (const p of periods) balances[p] = add(r.balances[p], adj[p] || 0);
    return { ...r, balances, adjusted: !!ledgerAdj.get(r.ledgerId) };
  });
  // A posting to a ledger that is not in these books (dropped in a re-import)
  // would vanish silently and leave the entry unbalanced in effect.
  const knownIds = new Set(leds.map((l) => l.id));
  for (const [ledgerId, per] of ledgerAdj) {
    if (knownIds.has(ledgerId)) continue;
    const amt = add(...periods.map((p) => per[p] || 0));
    checks.push({ id: `JRN-LEDGER-${String(ledgerId).replace(/^missing:/, '')}`, severity: SEV.CRITICAL, amount: amt,
      message: `An approved adjustment posts ${format(amt)} to "${String(ledgerId).replace(/^missing:/, '')}", which is not in the trial balance any more. Edit the entry to a ledger that exists, or withdraw it.` });
  }

  // ---- 3. Classify, per period (C3) and per side (C4) -----------------
  const byLine = new Map();   // lineId -> {period: paise}
  const trace = new Map();    // lineId -> [{ledgerId,name,period,amount,reason}]
  const ledgerInfo = [];
  const bump = (lineId, p, amt) => {
    const cur = byLine.get(lineId) || {};
    cur[p] = add(cur[p] || 0, amt);
    byLine.set(lineId, cur);
  };
  const push = (lineId, rec) => {
    const arr = trace.get(lineId) || [];
    arr.push(rec); trace.set(lineId, arr);
  };

  for (const l of leds) {
    const ov = overrides[l.id] || overrides[l.name];
    const rule = ov ? { line: ov, altLine: null, confidence: 'high', reason: 'manual override', review: false, needs: [] }
                    : classifyLedger(l, { nce });
    const perPeriod = {};
    for (const p of periods) {
      const bal = adjustedTB.find((r) => r.ledgerId === l.id).balances[p];
      const { line: lineId, flipped } = lineForBalance(rule, bal);
      perPeriod[p] = { lineId, flipped, amount: bal };
      bump(lineId, p, bal);
      if (bal !== 0) push(lineId, { ledgerId: l.id, name: l.name, period: p, amount: bal,
        reason: rule.reason, subGroup: subGroupOf(l) });
    }
    // a head that changes between periods is a regrouping and must be disclosed
    const distinct = new Set(periods.map((p) => perPeriod[p].lineId));
    if (distinct.size > 1) {
      checks.push({ id: `RCL-${l.id}`, severity: SEV.REVIEW,
        message: `"${l.name}" falls under different heads across periods (${[...distinct].join(' / ')}) because its balance changed side. Schedule III requires the comparative regrouping to be disclosed.` });
    }
    if (rule.review) {
      checks.push({ id: `MAP-${l.id}`, severity: SEV.REVIEW,
        message: `"${l.name}" → ${captionFor(perPeriod[periods[0]].lineId, division, constitution)} (${rule.confidence} confidence: ${rule.reason})` });
    }
    ledgerInfo.push({ ...l, rule, perPeriod });
  }

  // line-level postings from approved journals (provisions, reclassifications
  // and other facts that legitimately have no ledger of their own)
  for (const [lineId, per] of lineAdj) {
    if (!line(lineId)) {
      checks.push({ id: `JRN-LINE-${lineId}`, severity: SEV.CRITICAL,
        message: `An approved journal posts to "${lineId}", which is not a Schedule III head.` });
      continue;
    }
    for (const p of periods) {
      const amt = per[p] || 0;
      if (!amt) continue;
      bump(lineId, p, amt);
      push(lineId, { ledgerId: null, name: 'Approved adjusting journal', period: p, amount: amt, reason: 'journal' });
    }
  }

  // ---- 3b. Comparatives from last year's SIGNED accounts ---------------
  // Values arrive in PRESENTED terms (positive in the line's own nature) and
  // REPLACE the Tally-derived comparative, so the prior column ties to the
  // signed statements. If that makes the prior balance sheet stop tying, the
  // check below reports it rather than hiding it.
  const priorSet = new Set();
  if (priorOverrides && typeof priorOverrides === 'object') {
    const pp = periods[1];
    for (const [lineId, rupees] of Object.entries(priorOverrides)) {
      if (!line(lineId)) {
        checks.push({ id: `PRI-${lineId}`, severity: SEV.HIGH,
          message: `Imported comparative for "${lineId}" ignored — it is not a Schedule III head.` });
        continue;
      }
      const presentedPaise = toPaise(rupees);
      const dr = sideOf(lineId) === 'Cr' ? neg(presentedPaise) : presentedPaise;
      const cur = byLine.get(lineId) || {};
      cur[pp] = dr;
      byLine.set(lineId, cur);
      priorSet.add(lineId);
    }
    if (priorSet.size) {
      const PL_SECTIONS = ['INCOME', 'EXPENSE', 'TAX', 'OCI'];
      const onPL = [...priorSet].filter((id) => PL_SECTIONS.includes(sectionOf(id)));
      checks.push({ id: 'PRI-APPLIED', severity: SEV.INFO,
        message: `${priorSet.size} comparative figure(s) taken from last year's signed financial statements `
          + `rather than from Tally — ${priorSet.size - onPL.length} on the balance sheet, ${onPL.length} on the statement of profit and loss.` });
      // Comparatives that stop at the balance sheet are the signature of a
      // failed read of last year's P&L, and the P&L then quietly keeps Tally's
      // prior column. Say so rather than letting the export look complete.
      if (!onPL.length) {
        checks.push({ id: 'PRI-NO-PL', severity: SEV.HIGH,
          message: 'No comparative was imported for the statement of profit and loss, so its prior-year column is still whatever Tally holds '
            + 'and will read as nil for a company whose last year is not in these books. Re-run the prior-year import and check the '
            + '"from the statement of profit and loss" count, or key the comparatives in.' });
      }
    }
  }

  // ---- 4. Statements ---------------------------------------------------
  const lineVal = (id, p) => (byLine.get(id) || {})[p] || 0;
  const sectionTotal = (section, p) =>
    add(...linesFor(division).filter((l) => l.section === section).map((l) => lineVal(l.id, p)));
  /** presented = positive in the line's own nature */
  const pres = (id, p) => (sideOf(id) === 'Cr' ? neg(lineVal(id, p)) : lineVal(id, p));
  const presSection = (section, p) =>
    (SECTIONS[section].side === 'Cr' ? neg(sectionTotal(section, p)) : sectionTotal(section, p));

  const pl = {};
  for (const p of periods) {
    const income = presSection('INCOME', p);                      // positive
    const expenseLines = linesFor(division).filter((l) => l.section === 'EXPENSE' &&
      !['exceptional_items', 'extraordinary_items', 'prior_period_items'].includes(l.id));
    const expenses = add(...expenseLines.map((l) => lineVal(l.id, p)));  // Dr-positive
    const pbtBeforeExceptional = sub(income, expenses);
    const exceptional = lineVal('exceptional_items', p);
    const pbt = sub(pbtBeforeExceptional, exceptional);
    const taxCurrent = lineVal('current_tax', p);
    const taxDeferred = lineVal('deferred_tax', p);
    const taxEarlier = lineVal('tax_earlier_years', p);
    const taxTotal = add(taxCurrent, taxDeferred, taxEarlier);
    const pat = sub(pbt, taxTotal);                               // C2: PAT, not PBT
    pl[p] = { income, expenses, pbtBeforeExceptional, exceptional, pbt,
              tax: { current: taxCurrent, deferred: taxDeferred, earlier: taxEarlier, total: taxTotal }, pat };
  }

  const bs = {};
  const profitAccount = profitTo === 'current' ? 'partners_current' : 'owners_capital';
  for (const p of periods) {
    // reserves close on PAT (C2). Reserve ledgers carry the opening accumulated
    // balance; the year's result is added here, after tax.
    const reservesOpening = pres('reserves_surplus', p);
    // An imported comparative for reserves is last year's CLOSING figure, so the
    // year's profit is already inside it and must not be added again.
    const isPriorImported = (id) => p === periods[1] && priorSet.has(id);
    let reserves, equity, ownersCapital = 0, partnersCurrent = 0;
    if (nce) {
      // A non-corporate entity's profit belongs to its owners: it closes into
      // the capital (or current) accounts by the profit-sharing ratio, and the
      // reserves carry only what the books hold in them. Only the CURRENT
      // year's profit is added: the comparative capital figure is last year's
      // closing balance, which already has last year's profit inside it (the
      // books appropriate it before the year opens), so the comparative P&L is
      // a comparative only — see the prior-period check below.
      reserves = reservesOpening;
      const ownersLedger = pres('owners_capital', p);
      const currentLedger = pres('partners_current', p);
      const addProfit = p === periods[0];
      ownersCapital = add(ownersLedger, (addProfit && profitAccount === 'owners_capital') ? pl[p].pat : 0);
      partnersCurrent = add(currentLedger, (addProfit && profitAccount === 'partners_current') ? pl[p].pat : 0);
      equity = add(ownersCapital, partnersCurrent, reserves);
    } else {
      reserves = isPriorImported('reserves_surplus') ? reservesOpening : add(reservesOpening, pl[p].pat);
      equity = add(pres('share_capital', p), reserves,
                   pres('share_warrants', p), pres('share_application_money', p));
    }
    const ncl = presSection('NCL', p);
    const cl = presSection('CL', p);
    const nca = presSection('NCA', p);
    const ca = presSection('CA', p);
    const eqLiab = add(equity, ncl, cl);
    const assets = add(nca, ca);
    bs[p] = { reservesOpening, reserves, equity, ownersCapital, partnersCurrent, ncl, cl, nca, ca, eqLiab, assets,
              difference: sub(assets, eqLiab) };
  }

  // ---- 5. Integrity checks — no plugs, nothing hidden ------------------
  const unclDr = {}, unclCr = {};
  for (const p of periods) {
    const recs = (trace.get('unclassified') || []).filter((r) => r.period === p);
    unclDr[p] = add(...recs.filter((r) => r.amount > 0).map((r) => r.amount));
    unclCr[p] = add(...recs.filter((r) => r.amount < 0).map((r) => r.amount));
    const net = lineVal('unclassified', p);

    // For a non-corporate entity the comparative column holds last year's
    // closing balance sheet (profit already in the capital) beside last year's
    // P&L as a comparative, so the two halves of that column do not sum to nil
    // together. The balance sheet half must still tie on its own.
    let tbCheck = tbSum[p];
    if (nce && p !== periods[0]) {
      const PL = ['INCOME', 'EXPENSE', 'TAX', 'OCI'];
      tbCheck = add(...leds.map((l) => (PL.includes(sectionOf(ledgerInfo.find((x) => x.id === l.id).perPeriod[p].lineId)) ? 0
        : adjustedTB.find((r) => r.ledgerId === l.id).balances[p])));
    }
    if (tbCheck !== 0) {
      checks.push({ id: `TB-${p}`, severity: SEV.CRITICAL, amount: tbCheck,
        message: `Trial balance for "${p}" does not sum to nil — out by ${format(tbCheck)}. The source books do not balance; this is not a presentation issue.` });
    }
    if (net !== 0 || unclDr[p] !== 0 || unclCr[p] !== 0) {
      checks.push({ id: `UNCL-${p}`, severity: SEV.CRITICAL, amount: net,
        message: `Unclassified ledgers in "${p}": Dr ${format(unclDr[p])}, Cr ${format(neg(unclCr[p]))} (net ${format(net)}). These are excluded from the face and must be assigned before release.` });
    }
    if (bs[p].difference !== 0) {
      checks.push({ id: `BS-${p}`, severity: SEV.CRITICAL, amount: bs[p].difference,
        message: `Balance sheet for "${p}" does not tie — assets less equity and liabilities is ${format(bs[p].difference)}. Difference = trial-balance imbalance ${format(tbSum[p])} less unclassified ${format(net)}.` });
    }
  }
  if (rejected.length) {
    checks.push({ id: 'JRN-PENDING', severity: SEV.HIGH,
      message: `${rejected.length} journal(s) are recorded but not approved; they are excluded from the adjusted trial balance.` });
  }

  // ---- 5b. The owners' capital accounts of a non-corporate entity -------
  let ownersResult = null, ownersUsed = owners;
  if (nce) {
    const normalised = normaliseOwners(owners);
    const auto = autoAssign(normalised, ledgerInfo);
    ownersUsed = auto.owners;
    const adjusted = new Map(adjustedTB.map((r) => [r.ledgerId, r.balances]));
    ownersResult = ownersAccounts({
      ledgers: ledgerInfo, adjusted, pat: pl[periods[0]].pat, owners: ownersUsed, profitTo,
      faceCapital: bs[periods[0]].ownersCapital, faceCurrent: bs[periods[0]].partnersCurrent, constitution,
    });
    ownersResult.assignments = auto.assignments;
    checks.push(...ownersResult.checks);
    // the profit account must exist on the face even when no ledger sits on it
    if (pl[periods[0]].pat !== 0) {
      const cur = byLine.get(profitAccount) || {};
      if (!cur[periods[0]]) { cur[periods[0]] = 0; byLine.set(profitAccount, cur); }
    }
  }

  // information each used head still needs before it can be called complete
  const used = new Set([...byLine.keys()].filter((id) => periods.some((p) => lineVal(id, p) !== 0)));
  if (nce && pl[periods[0]].pat !== 0) used.add(profitAccount);
  const noteNumbers = assignNoteNumbers(used, division);
  const disclosureGaps = [];
  for (const id of used) {
    const def = line(id);
    if (def && def.requires && def.requires.length) {
      disclosureGaps.push({ lineId: id, caption: captionFor(id, division, constitution), note: noteNumbers.get(id) || null, requires: def.requires });
    }
  }

  const releasable = !checks.some((c) => c.severity === SEV.CRITICAL);

  return {
    division, periods, constitution, nce, profitTo,
    originalTB, adjustedTB, journals: { approved, rejected },
    ledgers: ledgerInfo,
    byLine, trace, noteNumbers, used,
    tbSum, unclassified: { dr: unclDr, cr: unclCr },
    pl, bs, checks, disclosureGaps, releasable,
    owners: ownersResult, ownersUsed,
    priorOverridesApplied: [...priorSet],
    /** helpers for the presentation layer */
    value: lineVal, presented: pres, caption: (id) => captionFor(id, division, constitution),
  };
}

export { SEV };
