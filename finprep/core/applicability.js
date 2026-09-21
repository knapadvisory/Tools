/* ============================================================================
 * applicability.js — versioned, effective-date-aware legal applicability engine
 *
 * Spec §12. The engine is deterministic and independently testable. It does NOT
 * ship any threshold: every seeded rule is `unverified`, carries no numbers, and
 * therefore returns **Unable to determine** until a qualified person records the
 * authority, provision, effective dates and operands against it.
 *
 * This is deliberate. A wrong CARO or tax-audit threshold is a professional
 * liability, and no primary MCA/CBDT source could be verified from here. The
 * engine makes the gap explicit instead of guessing.
 *
 * Conclusions are only ever: Applicable | Not applicable | Unable to determine.
 * ==========================================================================*/

export const CONCLUSION = {
  APPLICABLE: 'Applicable',
  NOT_APPLICABLE: 'Not applicable',
  UNKNOWN: 'Unable to determine',
};

/* ---------- rule definitions (structure only — no thresholds asserted) --- */
const F = (key, label, type = 'number', help = '') => ({ key, label, type, help });

export const RULE_DEFS = [
  {
    domain: 'framework', key: 'schedule_iii_division',
    title: 'Schedule III division and reporting framework (AS or Ind AS)',
    requiredFacts: [
      F('listed', 'Are the company’s securities listed, or in the process of listing?', 'boolean'),
      F('netWorth', 'Net worth as at the relevant date', 'number'),
      F('isNbfc', 'Is the company an NBFC?', 'boolean'),
      F('holdingOrSubsidiaryOfIndAsCo', 'Is it a holding, subsidiary, associate or JV of a company applying Ind AS?', 'boolean'),
      F('voluntaryIndAs', 'Has Ind AS been voluntarily adopted in an earlier year?', 'boolean'),
    ],
    operands: ['netWorthThreshold'],
    conditions: [
      { id: 'listed', label: 'Listed or in the process of listing', needs: ['listed'] },
      { id: 'networth', label: 'Net worth at or above the notified threshold', needs: ['netWorth'], usesOperand: 'netWorthThreshold' },
      { id: 'group', label: 'Holding / subsidiary / associate / JV of an Ind AS company', needs: ['holdingOrSubsidiaryOfIndAsCo'] },
    ],
    note: 'Companies Act small-company status, AS SMC status and MSME classification are separate tests and must not be conflated.',
  },
  {
    domain: 'caro', key: 'caro_applicability',
    title: 'Applicability of the Companies (Auditor’s Report) Order',
    requiredFacts: [
      F('entityType', 'Entity type (banking / insurance / section 8 / OPC / other)', 'string'),
      F('isSmallCompany', 'Does the company meet the Companies Act definition of a small company?', 'boolean'),
      F('isPrivate', 'Is it a private limited company?', 'boolean'),
      F('paidUpCapitalPlusReserves', 'Paid-up capital plus reserves and surplus at the balance sheet date', 'number'),
      F('totalBorrowingsPeak', 'Highest borrowings from banks or financial institutions at ANY point in the year', 'number',
        'Peak, not the year-end balance — the exemption test is not decided on closing figures alone.'),
      F('totalRevenue', 'Total revenue as disclosed in the statement of profit and loss', 'number'),
      F('isHoldingOrSubsidiaryOfPublic', 'Is it a holding or subsidiary of a public company?', 'boolean'),
    ],
    operands: ['capitalReserveLimit', 'borrowingLimit', 'revenueLimit'],
    conditions: [
      { id: 'excluded', label: 'Entity is of an excluded class', needs: ['entityType'] },
      { id: 'private_exemption', label: 'Private company meeting every exemption condition',
        needs: ['isPrivate', 'paidUpCapitalPlusReserves', 'totalBorrowingsPeak', 'totalRevenue', 'isHoldingOrSubsidiaryOfPublic'],
        usesOperand: 'capitalReserveLimit' },
    ],
    note: 'Where CARO applies, a clause-wise evidence workspace is required. The tool must not assert clean findings on its own.',
  },
  {
    domain: 'msme', key: 'msme_disclosure',
    title: 'MSME — supplier classification, financial-statement disclosure and delayed-payment interest',
    requiredFacts: [
      F('suppliersWithUdyam', 'Suppliers with Udyam registration evidence on file', 'list'),
      F('acceptanceDates', 'Date of acceptance or deemed acceptance per invoice', 'list'),
      F('agreedCreditTerms', 'Agreed credit terms per supplier, where written', 'list'),
      F('paymentDates', 'Actual payment dates per invoice', 'list'),
      F('disputedInvoices', 'Invoices under dispute', 'list'),
    ],
    operands: ['maxCreditPeriodDays', 'interestMultipleOfBankRate'],
    conditions: [
      { id: 'has_msme_suppliers', label: 'Any supplier is an eligible micro or small enterprise', needs: ['suppliersWithUdyam'] },
      { id: 'delay', label: 'Payment made beyond the permitted period', needs: ['acceptanceDates', 'paymentDates'], usesOperand: 'maxCreditPeriodDays' },
    ],
    note: 'Missing Udyam evidence means UNKNOWN status, never automatic exemption. Financial-statement disclosure, the MCA MSME return and section 43B(h) are three separate regimes and must be assessed separately.',
  },
  {
    domain: 'tax_audit', key: 'tax_audit_applicability',
    title: 'Applicability of audit under the Income-tax Act',
    requiredFacts: [
      F('natureOfActivity', 'Business or profession', 'string'),
      F('turnover', 'Turnover or gross receipts for the previous year', 'number'),
      F('cashReceipts', 'Aggregate of amounts received in cash during the year', 'number',
        'The statutory population, not merely cash sales.'),
      F('cashPayments', 'Aggregate of amounts paid in cash during the year', 'number',
        'The statutory population, not merely cash expenses.'),
      F('auditedUnderOtherLaw', 'Are the accounts audited under any other law?', 'boolean',
        'Decides the Form 3CA route rather than 3CB.'),
    ],
    operands: ['turnoverLimit', 'enhancedTurnoverLimit', 'cashConditionPercent'],
    conditions: [
      { id: 'turnover', label: 'Turnover or gross receipts exceed the limit', needs: ['turnover'], usesOperand: 'turnoverLimit' },
      { id: 'cash_receipts', label: 'Cash receipts within the permitted proportion', needs: ['cashReceipts', 'turnover'], usesOperand: 'cashConditionPercent' },
      { id: 'cash_payments', label: 'Cash payments within the permitted proportion', needs: ['cashPayments'], usesOperand: 'cashConditionPercent' },
    ],
    note: 'The two cash conditions are tested independently — one may pass while the other fails. Presumptive regimes for individuals, HUFs and firms do not apply to a company by default.',
  },
  {
    domain: 'ifc', key: 'ifc_reporting',
    title: 'Auditor reporting on internal financial controls with reference to the financial statements',
    requiredFacts: [
      F('isPrivate', 'Is it a private limited company?', 'boolean'),
      F('isOnePersonCompany', 'Is it a one-person company?', 'boolean'),
      F('isSmallCompany', 'Does it meet the small-company definition?', 'boolean'),
      F('turnover', 'Turnover for the year', 'number'),
      F('borrowingsFromBanks', 'Borrowings from banks or financial institutions at any time in the year', 'number'),
      F('filingDefaults', 'Any default in filing financial statements or annual returns?', 'boolean'),
    ],
    operands: ['turnoverLimit', 'borrowingLimit'],
    conditions: [
      { id: 'private_exemption', label: 'Private company meeting every exemption condition',
        needs: ['isPrivate', 'turnover', 'borrowingsFromBanks', 'filingDefaults'], usesOperand: 'turnoverLimit' },
    ],
    note: 'Exemption from auditor REPORTING does not mean internal financial controls need not exist or be considered during the audit.',
  },
];

export const ruleDef = (domain, key) => RULE_DEFS.find((r) => r.domain === domain && r.key === key) || null;

/* ---------- evaluation --------------------------------------------------- */
const missing = (need, facts) => need.filter((k) => facts[k] === undefined || facts[k] === null || facts[k] === '');

/**
 * Evaluate one rule.
 * @param def   rule definition from RULE_DEFS
 * @param stored the stored rule row: { status, authority, provision, url,
 *               effective_from, effective_to, operands (JSON), reviewed_by }
 * @param facts  the engagement's facts
 * @param asOf   ISO date the conclusion is being drawn for
 */
export function evaluate(def, stored, facts = {}, asOf = null) {
  const base = {
    domain: def.domain, key: def.key, title: def.title,
    factsUsed: {}, missingFacts: [], conditions: [], note: def.note || null,
    ruleStatus: (stored && stored.status) || 'unverified',
    authority: stored ? stored.authority || null : null,
    provision: stored ? stored.provision || null : null,
    effectiveFrom: stored ? stored.effective_from || null : null,
  };

  if (!stored || stored.status !== 'verified') {
    return { ...base, conclusion: CONCLUSION.UNKNOWN, requiresProfessionalValidation: true,
      reason: 'The rule has not been verified against a primary source, so no threshold is applied. Record the authority, provision, effective dates and operands, and have them reviewed, before relying on a conclusion.',
      missingFacts: def.requiredFacts.map((f) => f.key).filter((k) => facts[k] === undefined) };
  }

  if (asOf && stored.effective_from && asOf < stored.effective_from) {
    return { ...base, conclusion: CONCLUSION.UNKNOWN,
      reason: `The verified rule takes effect from ${stored.effective_from}, which is after the reporting date ${asOf}. The rule for that earlier period has not been recorded.` };
  }
  if (asOf && stored.effective_to && asOf > stored.effective_to) {
    return { ...base, conclusion: CONCLUSION.UNKNOWN,
      reason: `The verified rule ceased to have effect on ${stored.effective_to}; the successor rule has not been recorded.` };
  }

  const operands = (() => { try { return JSON.parse(stored.operands || '{}'); } catch { return {}; } })();
  const allNeeded = [...new Set(def.conditions.flatMap((c) => c.needs))];
  const miss = missing(allNeeded, facts);
  for (const k of allNeeded) if (!miss.includes(k)) base.factsUsed[k] = facts[k];

  for (const c of def.conditions) {
    const cMiss = missing(c.needs, facts);
    const operandName = c.usesOperand;
    const operandValue = operandName ? operands[operandName] : undefined;
    if (cMiss.length || (operandName && operandValue === undefined)) {
      base.conditions.push({ id: c.id, label: c.label, result: CONCLUSION.UNKNOWN,
        detail: cMiss.length ? `missing: ${cMiss.join(', ')}` : `operand "${operandName}" not recorded on the verified rule` });
    } else {
      base.conditions.push({ id: c.id, label: c.label, result: 'evaluated',
        detail: `facts ${c.needs.join(', ')} against ${operandName || 'no operand'}` });
    }
  }

  if (miss.length || base.conditions.some((c) => c.result === CONCLUSION.UNKNOWN)) {
    return { ...base, conclusion: CONCLUSION.UNKNOWN, missingFacts: miss,
      reason: 'One or more conditions could not be evaluated. The missing facts or operands are listed; supply them to obtain a conclusion.' };
  }

  // A verified rule with every fact and operand present still needs its
  // comparison logic recorded against the specific provision. Until a reviewer
  // records that logic, the engine will not invent it.
  return { ...base, conclusion: CONCLUSION.UNKNOWN,
    reason: 'All facts and operands are present, but the comparison logic for this provision has not been recorded and reviewed. A conclusion will not be produced from assumed logic.',
    requiresProfessionalValidation: true };
}

/** Evaluate every rule for an engagement. */
export function assessAll(storedRules, facts, asOf) {
  const byKey = new Map((storedRules || []).map((r) => [r.domain + '::' + r.rule_key, r]));
  return RULE_DEFS.map((def) => evaluate(def, byKey.get(def.domain + '::' + def.key), facts, asOf));
}

/** The facts an engagement must gather, deduplicated across rules. */
export function requiredFacts() {
  const seen = new Map();
  for (const def of RULE_DEFS) {
    for (const f of def.requiredFacts) {
      const cur = seen.get(f.key) || { ...f, usedBy: [] };
      cur.usedBy.push(def.domain);
      seen.set(f.key, cur);
    }
  }
  return [...seen.values()];
}
