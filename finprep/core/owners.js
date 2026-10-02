/* ============================================================================
 * owners.js — the owners' capital accounts of a non-corporate entity
 *
 * A proprietor, the partners of a firm or an LLP, the karta of an HUF: their
 * capital is not a balance to be presented, it is a STATEMENT to be prepared —
 *
 *     Opening balance
 *     Add: capital introduced
 *     Add: interest on capital            (when credited to the account)
 *     Add: remuneration                   (when credited to the account)
 *     Add: share of profit for the year   (by the profit-sharing ratio)
 *     Less: drawings
 *     Closing balance
 *
 * owner by owner, with every column adding across to the figure on the face of
 * the balance sheet. This module prepares that statement from the trial
 * balance the engine has already classified, and reports what it could not
 * determine rather than guessing.
 *
 * Three things only the books can say, and how each is handled:
 *  - Capital introduced vs drawings: taken from the GROSS credit and debit
 *    movements on the capital ledgers when the source supplied them (the Tally
 *    connector does, from the vouchers). Without them the net movement is
 *    presented on one side and the account says so (OWN-GROSS).
 *  - Whether remuneration and interest were credited to the capital account or
 *    paid out directly: inferred from the gross credits — if the account was
 *    credited with at least that much, the appropriation passed through it —
 *    and the inference is reported (OWN-CREDITED). It is never silent.
 *  - The share of profit: allocated by the ratios with the largest-remainder
 *    method, so the parts add back exactly to the profit for the year. A
 *    manual split is honoured when it adds to that profit, and refused with a
 *    CRITICAL check when it does not. A partner with a nil ratio never
 *    receives a rounding paisa — the residual goes only to those who share.
 * ==========================================================================*/

import { add, sub, neg, allocate, toPaise, format } from './money.js';
import { norm } from './classify.js';

export const ACCOUNT_LINES = { capital: 'owners_capital', current: 'partners_current' };
export const OWNER_LEDGER_KINDS = ['capital', 'current', 'drawings', 'remuneration', 'interest'];
/** which statement line a ledger of each kind sits on */
const KIND_LINE = { capital: 'owners_capital', current: 'partners_current', drawings: 'owners_capital',
                    remuneration: 'partners_remuneration', interest: 'interest_on_capital' };

const SEV = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', REVIEW: 'REVIEW', INFO: 'INFO' };

/** Owners as stored (ratios, PAN, ledger names per kind) → a clean shape. */
export function normaliseOwners(raw) {
  return (raw || []).map((o, i) => {
    const ledgers = {};
    for (const k of OWNER_LEDGER_KINDS) {
      const v = (o.ledgers && o.ledgers[k]) || [];
      ledgers[k] = (Array.isArray(v) ? v : [v]).map((x) => String(x || '').trim()).filter(Boolean);
    }
    const ratio = Number(o.ratio);
    return {
      id: o.id || `own${i + 1}`,
      name: String(o.name || '').trim() || `Owner ${i + 1}`,
      role: o.role || '',
      pan: o.pan || '',
      ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 0,
      ledgers,
      split: (o.split == null || o.split === '') ? null : toPaise(o.split),
    };
  });
}

const STOP = new Set(['and', 'of', 'the', 'shri', 'smt', 'mr', 'mrs', 'ms', 'dr', 'ca', 'sh', 'm', 's', 'capital', 'account', 'a', 'c', 'partner', 'partners', 'drawing', 'drawings', 'current', 'remuneration', 'salary', 'interest']);
/** the tokens of an owner's name that can identify a ledger as theirs */
function nameTokens(name) {
  return norm(name).trim().split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
}

/**
 * Give unassigned ledgers to the owner they belong to.
 *  - One owner: every ledger on the owners' lines is theirs.
 *  - Several: a ledger goes to the owner whose name it carries ("Ramesh
 *    Capital A/c", "Drawings - Ramesh", "Remuneration to Ramesh"), provided
 *    exactly one owner matches. Anything ambiguous is left for the preparer.
 * Returns a NEW owners array and the assignments it made, with their basis.
 */
export function autoAssign(owners, ledgers) {
  const out = owners.map((o) => ({ ...o, ledgers: Object.fromEntries(OWNER_LEDGER_KINDS.map((k) => [k, o.ledgers[k].slice()])) }));
  const assigned = new Set(out.flatMap((o) => OWNER_LEDGER_KINDS.flatMap((k) => o.ledgers[k])));
  const made = [];
  const kindOf = (l) => {
    const line = l.perPeriod ? l.perPeriod[Object.keys(l.perPeriod)[0]].lineId : l.lineId;
    const n = norm(l.name);
    if (line === 'owners_capital') return / drawing /.test(n) ? 'drawings' : 'capital';
    if (line === 'partners_current') return 'current';
    if (line === 'partners_remuneration') return 'remuneration';
    if (line === 'interest_on_capital') return 'interest';
    return null;
  };
  for (const l of ledgers) {
    if (assigned.has(l.name)) continue;
    const kind = kindOf(l);
    if (!kind) continue;
    let who = null, basis = '';
    if (out.length === 1) { who = out[0]; basis = 'the only owner'; }
    else {
      const n = norm(l.name);
      const hits = out.filter((o) => nameTokens(o.name).some((tk) => n.includes(' ' + tk + ' ')));
      if (hits.length === 1) { who = hits[0]; basis = `the ledger name carries “${who.name}”`; }
    }
    if (!who) continue;
    who.ledgers[kind].push(l.name);
    assigned.add(l.name);
    made.push({ ledger: l.name, owner: who.name, ownerId: who.id, kind, basis });
  }
  return { owners: out, assignments: made };
}

const ROWS = [
  ['opening', 'Opening balance'],
  ['introduced', 'Add: capital introduced during the year'],
  ['interest', 'Add: interest on capital'],
  ['remuneration', 'Add: remuneration'],
  ['share', 'Add: share of profit / (loss) for the year'],
  ['drawings', 'Less: drawings'],
  ['closing', 'Closing balance'],
];

/**
 * Prepare the capital (and, where used, current) accounts.
 *
 * @param ctx {
 *   ledgers      the engine's ledger records: {name, balances{current,prior}, mov{dr,cr}|null, perPeriod}
 *   adjusted     Map<ledgerId, balances> after approved journals
 *   pat          profit after tax for the current period, paise (Dr-negative = profit positive)
 *   owners       normalised owners
 *   profitTo     'capital' | 'current'
 *   faceCapital  the face figure for owners_capital (closing incl. profit), paise presented
 *   faceCurrent  the face figure for partners_current
 *   constitution
 * }
 */
export function ownersAccounts(ctx) {
  const checks = [];
  const owners = ctx.owners || [];
  const ledgers = ctx.ledgers || [];
  const byName = new Map(ledgers.map((l) => [l.name, l]));
  const bal = (l, p) => {
    const a = ctx.adjusted && ctx.adjusted.get(l.id);
    return a ? (a[p] || 0) : (l.balances[p] || 0);
  };
  const lineOf = (l) => (l.perPeriod && l.perPeriod.current ? l.perPeriod.current.lineId : null);
  const onLine = (lineId) => ledgers.filter((l) => lineOf(l) === lineId);
  const pat = ctx.pat || 0;
  const profitTo = ctx.profitTo === 'current' ? 'current' : 'capital';

  // ---- share of profit ------------------------------------------------
  const ratios = owners.map((o) => o.ratio);
  const anyRatio = ratios.some((x) => x > 0);
  let share = owners.map(() => 0);
  let shareBasis = 'by profit-sharing ratio';
  const splits = owners.map((o) => o.split);
  const manual = owners.length && splits.every((s) => s != null);
  if (owners.length) {
    if (manual) {
      const sum = add(...splits);
      if (sum === pat) { share = splits.slice(); shareBasis = 'manual split recorded by the preparer'; }
      else {
        checks.push({ id: 'OWN-SPLIT', severity: SEV.CRITICAL, amount: sub(sum, pat),
          message: `The manual profit split adds to ${format(sum)} but the profit for the year is ${format(pat)}. The split is ignored and the ratios are used until it is corrected.` });
        share = anyRatio ? allocate(pat, ratios) : owners.map(() => 0);
      }
    } else if (anyRatio) {
      share = allocate(pat, ratios);
    } else if (owners.length === 1) {
      share = [pat]; shareBasis = 'sole owner';
    } else if (pat !== 0) {
      checks.push({ id: 'OWN-RATIO', severity: SEV.CRITICAL, amount: pat,
        message: `The profit for the year (${format(pat)}) cannot be allocated: no partner has a profit-sharing ratio. Record the ratios from the partnership deed, or a manual split.` });
    }
  } else if (ctx.constitution && ctx.constitution !== 'company') {
    checks.push({ id: 'OWN-NONE', severity: SEV.HIGH,
      message: 'No owner or partner is recorded for this engagement, so the capital account note cannot be prepared owner by owner. The year’s profit is shown against the capital account in total.' });
  }

  // ---- one schedule per account ------------------------------------------
  const schedule = (kind) => {
    const lineId = ACCOUNT_LINES[kind];
    const used = onLine(lineId);
    if (!used.length && !(kind === profitTo && pat !== 0) && !owners.some((o) => o.ledgers[kind].length)) return null;
    const ownerLedgers = (o) => {
      const names = kind === 'capital' ? o.ledgers.capital.concat(o.ledgers.drawings) : o.ledgers.current;
      return names.map((n) => byName.get(n)).filter(Boolean);
    };
    const claimed = new Set();
    const cols = owners.map((o, i) => {
      const ls = ownerLedgers(o);
      ls.forEach((l) => claimed.add(l.name));
      const opening = neg(add(...ls.map((l) => bal(l, 'prior'))));          // Cr positive
      const closingLedger = neg(add(...ls.map((l) => bal(l, 'current'))));
      const net = sub(closingLedger, opening);
      const hasGross = ls.length > 0 && ls.every((l) => l.mov);
      const grossCr = hasGross ? add(...ls.map((l) => l.mov.cr)) : null;
      const grossDr = hasGross ? add(...ls.map((l) => l.mov.dr)) : null;
      // appropriations charged in the P&L that belong to this owner
      const remun = add(...o.ledgers.remuneration.map((n) => byName.get(n)).filter(Boolean).map((l) => bal(l, 'current')));
      const intr = add(...o.ledgers.interest.map((n) => byName.get(n)).filter(Boolean).map((l) => bal(l, 'current')));
      const approp = add(remun, intr);
      let credited = false;
      if (kind === profitTo && approp > 0) {
        credited = hasGross ? grossCr >= approp : net >= approp;
      }
      const introduced = hasGross ? sub(grossCr, credited ? approp : 0)
        : Math.max(0, sub(net, credited ? approp : 0));
      const drawings = hasGross ? grossDr : Math.max(0, neg(sub(net, credited ? approp : 0)));
      const sh = kind === profitTo ? share[i] : 0;
      const closing = add(opening, introduced, credited ? intr : 0, credited ? remun : 0, sh, neg(drawings));
      return { ownerId: o.id, name: o.name, ratio: o.ratio, hasGross, credited, approp,
        rows: { opening, introduced, interest: credited ? intr : 0, remuneration: credited ? remun : 0, share: sh, drawings, closing } };
    });
    // ledgers on this line nobody claimed
    const stray = used.filter((l) => !claimed.has(l.name));
    const strayOpening = neg(add(...stray.map((l) => bal(l, 'prior'))));
    const strayClosing = neg(add(...stray.map((l) => bal(l, 'current'))));
    const strayNet = sub(strayClosing, strayOpening);
    // Whatever share of profit no owner received (no owners recorded, no
    // ratios, a split that did not add up) sits here, so the statement always
    // adds across to the face and the check that explains it is never hidden.
    const strayShare = kind === profitTo ? sub(pat, add(...share)) : 0;
    const unallocated = { names: stray.map((l) => l.name),
      rows: { opening: strayOpening, introduced: Math.max(0, strayNet), interest: 0, remuneration: 0,
              share: strayShare, drawings: Math.max(0, -strayNet),
              closing: add(strayClosing, strayShare) } };
    const rows = ROWS.map(([key, caption]) => {
      const byOwner = {};
      for (const c of cols) byOwner[c.ownerId] = c.rows[key];
      const total = add(...cols.map((c) => c.rows[key]), unallocated.rows[key]);
      return { key, caption, byOwner, unallocated: unallocated.rows[key], total };
    });
    return { kind, lineId, profitTo: kind === profitTo, shareBasis,
      owners: cols.map((c) => ({ id: c.ownerId, name: c.name, ratio: c.ratio, hasGross: c.hasGross, credited: c.credited })),
      unallocated: unallocated.names, rows };
  };

  const capital = schedule('capital');
  const current = schedule('current');

  // ---- what the books could not say, said out loud -----------------------
  for (const s of [capital, current]) {
    if (!s) continue;
    const label = s.kind === 'capital' ? 'capital' : 'current';
    if (s.unallocated.length) {
      const row = s.rows.find((r) => r.key === 'closing');
      checks.push({ id: `OWN-UNALLOC-${label}`, severity: owners.length ? SEV.REVIEW : SEV.INFO, amount: row.unallocated,
        message: `${s.unallocated.length} ledger(s) on the ${label} account are not assigned to any owner: ${s.unallocated.slice(0, 6).join('; ')}${s.unallocated.length > 6 ? '…' : ''}. They are shown in an "unallocated" column until assigned.` });
    }
    const noGross = s.owners.filter((o) => !o.hasGross);
    if (noGross.length && owners.length) {
      checks.push({ id: `OWN-GROSS-${label}`, severity: SEV.REVIEW,
        message: `Gross debits and credits on the ${label} account were not supplied for ${noGross.map((o) => o.name).join(', ')}, so capital introduced and drawings are shown NET on one side. Read the books through the connector, or supply movement columns in the Excel template, to show both.` });
    }
    const cred = s.owners.filter((o) => o.credited);
    if (cred.length) {
      checks.push({ id: `OWN-CREDITED-${label}`, severity: SEV.INFO,
        message: `Remuneration and interest for ${cred.map((o) => o.name).join(', ')} are shown as credited to the ${label} account because the account received at least that much in credits during the year. Confirm against the partners' ledgers.` });
    }
  }
  // Profit appropriated by journal in the books AND allocated here would be
  // counted twice. A movement on the P&L / reserves ledger is the signature.
  const movedReserves = onLine('reserves_surplus').filter((l) => bal(l, 'current') !== bal(l, 'prior'));
  if (movedReserves.length && pat !== 0) {
    checks.push({ id: 'OWN-APPROP', severity: SEV.REVIEW, amount: add(...movedReserves.map((l) => sub(bal(l, 'current'), bal(l, 'prior')))),
      message: `The reserves / profit and loss ledger moved during the year (${movedReserves.map((l) => l.name).join(', ')}). If the books already transfer the year's profit to the owners by journal, the share of profit allocated here would count it twice — post a reversing adjustment or confirm the movement is something else.` });
  }
  // the schedule must add across to the face
  const tie = (s, face) => {
    if (!s) return;
    const row = s.rows.find((r) => r.key === 'closing');
    if (row.total !== face) {
      checks.push({ id: `OWN-TIE-${s.kind}`, severity: SEV.CRITICAL, amount: sub(row.total, face),
        message: `The ${s.kind} account closes at ${format(row.total)} owner by owner but the balance sheet shows ${format(face)}.` });
    }
  };
  tie(capital, ctx.faceCapital || 0);
  tie(current, ctx.faceCurrent || 0);

  return { capital, current, checks, profitTo, shareBasis, pat };
}

export { KIND_LINE };
