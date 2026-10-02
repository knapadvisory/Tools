/* ============================================================================
 * policies.js — a starting text for the significant accounting policies
 *
 * A template to edit, never a statement of fact about the client: it names the
 * basis most such entities actually follow and leaves the choices that differ
 * (depreciation method, inventory formula, revenue timing) as plain sentences
 * the preparer must confirm or change. Returned as text; the preparer owns it.
 * ==========================================================================*/

export function defaultPolicies({ constitution = 'company', division = 'AS', entity = '' } = {}) {
  const who = entity || 'the entity';
  const nce = division === 'NCE';
  const basis = nce
    ? `Basis of preparation: The financial statements of ${who} are prepared under the historical cost convention on the accrual basis of accounting, in accordance with the Accounting Standards issued by the Institute of Chartered Accountants of India to the extent applicable to a non-corporate entity, and are presented in the format recommended by the ICAI Guidance Note on Financial Statements of Non-Corporate Entities.`
    : division === 'INDAS'
      ? `Basis of preparation: The financial statements are prepared in accordance with the Indian Accounting Standards (Ind AS) notified under section 133 of the Companies Act, 2013, on the historical cost basis except for items measured at fair value, and are presented in the format of Division II of Schedule III.`
      : `Basis of preparation: The financial statements are prepared under the historical cost convention on the accrual basis of accounting, in accordance with the Accounting Standards specified under section 133 of the Companies Act, 2013, read with the Companies (Accounting Standards) Rules, 2021, and are presented in the format of Division I of Schedule III.`;
  const owners = constitution === 'partnership' || constitution === 'llp'
    ? `\n\nPartners’ capital: Interest on capital and remuneration to partners are charged in the statement of profit and loss as authorised by the partnership deed and within the limits of section 40(b) of the Income-tax Act, 1961. The profit for the year is divided among the partners in their profit-sharing ratio and credited to their capital accounts.`
    : constitution === 'proprietorship'
      ? `\n\nProprietor’s capital: Drawings are debited and the profit for the year credited to the proprietor’s capital account. Income-tax is the proprietor’s personal liability and is not charged in these financial statements.`
      : '';
  return `${basis}

Use of estimates: The preparation of financial statements requires estimates and assumptions that affect the reported amounts of assets, liabilities, income and expenses. Differences between actual results and estimates are recognised in the period in which the results are known.

Property, plant and equipment: Stated at cost less accumulated depreciation. Cost includes purchase price, duties and taxes not recoverable, and expenses directly attributable to bringing the asset to its working condition. Depreciation is provided on the written-down-value method at the rates and in the manner prescribed under the Income-tax Act, 1961 [CONFIRM: or straight-line over the useful lives in Schedule II].

Inventories: Valued at the lower of cost and net realisable value. Cost is determined on the first-in-first-out basis [CONFIRM: or weighted average] and includes all costs of purchase and other costs incurred in bringing the inventories to their present location and condition.

Revenue recognition: Revenue from the sale of goods is recognised when the significant risks and rewards of ownership pass to the buyer, which generally coincides with delivery. Revenue from services is recognised as the services are rendered. Interest income is recognised on a time-proportion basis.

Taxes on income: Current tax is provided at the amount expected to be paid to the tax authorities under the Income-tax Act, 1961. Deferred tax, where recognised, reflects the timing differences between taxable income and accounting income at the enacted rates.

Provisions and contingencies: A provision is recognised when there is a present obligation as a result of a past event and it is probable that an outflow of resources will be required to settle it. Contingent liabilities are disclosed and not provided for.${owners}`;
}
