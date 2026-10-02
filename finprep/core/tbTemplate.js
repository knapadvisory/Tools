/* ============================================================================
 * tbTemplate.js — the Excel trial-balance template, and reading one back
 *
 * For books that cannot be reached through the connector — a client's Tally
 * on a remote desktop, a different accounting package, a trial balance that
 * arrived as a spreadsheet — the preparer fills one sheet and uploads it.
 *
 * The template is deliberately plain: one row per ledger, debit and credit in
 * separate columns, opening and closing, optional gross movements (so the
 * owners' capital accounts can show introduced and drawings apart), and an
 * optional head. Columns are found by their HEADING, not their position, so a
 * sheet with the columns reordered or extra columns added still reads.
 *
 * Reading is strict where being lenient would hide an error:
 *  - a ledger name and a group are required on every row;
 *  - a name may appear once (case and spacing aside) — a duplicate would
 *    silently double a balance on re-import;
 *  - a row may carry a debit OR a credit closing balance, not both;
 *  - total closing debits must equal total closing credits (the books
 *    balance, or the sheet is wrong) — the same for the opening columns;
 *  - a head, if given, must be one the chart knows, by id or by caption.
 * Anything else is a warning the preparer sees before the snapshot is sealed.
 * ==========================================================================*/

import { toPaise, toRupees, format } from './money.js';

/** The columns, in template order. `key` is what the parser produces. */
export const COLUMNS = [
  { key: 'name',     head: 'Ledger name',            required: true,  width: 36, hint: 'Exactly as in the books. Each name once.' },
  { key: 'group',    head: 'Group (parent)',          required: true,  width: 26, hint: 'The ledger’s immediate group, e.g. Sundry Creditors, Indirect Expenses.' },
  { key: 'primary',  head: 'Primary group',           required: false, width: 22, hint: 'The top-level Tally group, if the parent is a sub-group. Blank = same as the group.' },
  { key: 'openDr',   head: 'Opening Dr',              required: false, width: 15, num: true, hint: 'Balance at the start of the year, debit side.' },
  { key: 'openCr',   head: 'Opening Cr',              required: false, width: 15, num: true, hint: 'Balance at the start of the year, credit side.' },
  { key: 'movDr',    head: 'Debits in the year',      required: false, width: 16, num: true, hint: 'Optional. Gross debits posted in the year — shows drawings apart from capital introduced.' },
  { key: 'movCr',    head: 'Credits in the year',     required: false, width: 16, num: true, hint: 'Optional. Gross credits posted in the year.' },
  { key: 'closeDr',  head: 'Closing Dr',              required: true,  width: 15, num: true, hint: 'Balance at the year end, debit side. Required (may be 0).' },
  { key: 'closeCr',  head: 'Closing Cr',              required: true,  width: 15, num: true, hint: 'Balance at the year end, credit side. Required (may be 0).' },
  { key: 'head',     head: 'Statement head',          required: false, width: 34, hint: 'Optional. Pick from the Heads sheet; the tool proposes one when blank.' },
  { key: 'gstin',    head: 'GSTIN',                   required: false, width: 18, hint: 'Optional. A party’s GSTIN sharpens the grouping.' },
];
const COL_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

/** Tally's primary groups, and whether a ledger under them is a P&L ledger. */
export const PRIMARY_GROUPS = [
  ['Capital Account', false], ['Reserves & Surplus', false], ['Loans (Liability)', false], ['Current Liabilities', false],
  ['Fixed Assets', false], ['Investments', false], ['Current Assets', false], ['Branch / Divisions', false],
  ['Misc. Expenses (Asset)', false], ['Suspense A/c', false],
  ['Sales Accounts', true], ['Purchase Accounts', true], ['Direct Incomes', true], ['Indirect Incomes', true],
  ['Direct Expenses', true], ['Indirect Expenses', true],
];
const REVENUE_PRIMARIES = new Set(PRIMARY_GROUPS.filter(([, pl]) => pl).map(([g]) => normKey(g)));
/** Tally sub-groups → their primary group, so a blank primary can be filled in. */
const SUBGROUP_PRIMARY = {
  'bank accounts': 'Current Assets', 'cash in hand': 'Current Assets', 'deposits asset': 'Current Assets',
  'loans advances asset': 'Current Assets', 'stock in hand': 'Current Assets', 'sundry debtors': 'Current Assets',
  'duties taxes': 'Current Liabilities', 'provisions': 'Current Liabilities', 'sundry creditors': 'Current Liabilities',
  'bank od': 'Loans (Liability)', 'bank occ': 'Loans (Liability)', 'secured loans': 'Loans (Liability)', 'unsecured loans': 'Loans (Liability)',
  'reserves surplus': 'Reserves & Surplus',
};

export function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\ba\s*\/\s*c\b/g, '').replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/* ---------------------------------------------------------------- build --- */
/**
 * Build the template workbook. `heads` = [{lineId, caption, sectionTitle}] for
 * the engagement's division, so the Heads sheet and the drop-down match the
 * chart the tool will group against.
 */
export function buildTemplate(ExcelJS, { heads = [], entity = '', fyEnd = '', framework = '' } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'finprep';
  const ws = wb.addWorksheet('Trial Balance', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.head, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE5EE' } };
  COLUMNS.forEach((c, i) => {
    const cell = ws.getRow(1).getCell(i + 1);
    cell.note = c.hint + (c.required ? ' Required.' : '');
    if (c.required) cell.font = { bold: true, color: { argb: 'FFB00020' } };
  });
  for (let r = 2; r <= 1000; r++) {
    for (const key of ['openDr', 'openCr', 'movDr', 'movCr', 'closeDr', 'closeCr']) {
      ws.getRow(r).getCell(COLUMNS.findIndex((c) => c.key === key) + 1).numFmt = '#,##0.00';
    }
  }
  // drop-downs: the head from the Heads sheet, the primary group from Tally's list
  const headsWs = wb.addWorksheet('Heads');
  headsWs.columns = [{ header: 'Statement head (type or pick this text)', width: 54 }, { header: 'Section', width: 32 }, { header: 'Id', width: 28 }];
  headsWs.getRow(1).font = { bold: true };
  heads.forEach((h, i) => { headsWs.getRow(i + 2).values = [h.caption, h.sectionTitle || h.section || '', h.lineId]; });
  const primWs = wb.addWorksheet('Groups');
  primWs.columns = [{ header: 'Tally primary group', width: 28 }, { header: 'Profit & loss?', width: 14 }];
  primWs.getRow(1).font = { bold: true };
  PRIMARY_GROUPS.forEach(([g, pl], i) => { primWs.getRow(i + 2).values = [g, pl ? 'Yes' : 'No']; });
  if (heads.length) {
    const headCol = COLUMNS.findIndex((c) => c.key === 'head') + 1;
    const primCol = COLUMNS.findIndex((c) => c.key === 'primary') + 1;
    for (let r = 2; r <= 1000; r++) {
      ws.getRow(r).getCell(headCol).dataValidation = { type: 'list', allowBlank: true, formulae: [`Heads!$A$2:$A$${heads.length + 1}`],
        showErrorMessage: true, errorTitle: 'Not a head', error: 'Pick a head from the Heads sheet, or leave blank.' };
      ws.getRow(r).getCell(primCol).dataValidation = { type: 'list', allowBlank: true, formulae: [`Groups!$A$2:$A$${PRIMARY_GROUPS.length + 1}`],
        showErrorMessage: false };
    }
  }
  const how = wb.addWorksheet('How to fill');
  how.columns = [{ width: 110 }];
  const lines = [
    `Trial balance template${entity ? ' — ' + entity : ''}${fyEnd ? ', year ended ' + fyEnd : ''}`,
    framework ? `Statements are prepared in the ${framework}.` : '',
    '',
    'One row per ledger on the sheet "Trial Balance". Fill the columns in bold red at least.',
    'Debits and credits go in separate columns; leave the other one blank or 0. Opening = the balance at the start of the year; Closing = at the year end.',
    '"Debits in the year" / "Credits in the year" are optional gross movements. For a partner’s capital ledger they let the capital account show capital introduced and drawings separately rather than one net figure.',
    'The Group is the ledger’s immediate parent in the books (Sundry Creditors, Indirect Expenses, Bank Accounts…). If that is a sub-group you created, put Tally’s top-level group in Primary group.',
    'The Statement head is optional — pick one from the Heads sheet to fix where a ledger goes; leave it blank and the tool proposes a head for you to confirm.',
    'Before upload: total Closing Dr must equal total Closing Cr. The tool refuses a sheet that does not balance, lists duplicate ledger names, and rejects a head it does not know.',
    'Re-uploading a corrected sheet replaces the previous trial balance for this engagement and shows what changed; the heads you approved and the adjustment entries you recorded are kept.',
    'Keep the heading row exactly as it is: columns are recognised by their heading, so you may reorder them or add your own columns to the right.',
  ];
  lines.forEach((l, i) => { how.getRow(i + 1).getCell(1).value = l; how.getRow(i + 1).getCell(1).alignment = { wrapText: true }; });
  how.getRow(1).font = { bold: true, size: 13 };
  return wb;
}

/* ---------------------------------------------------------------- parse --- */
/** Find each template column in a heading row, by heading text. */
export function mapColumns(headerRow) {
  const idx = {};
  const cells = (headerRow || []).map((v) => normKey(v));
  const ALIASES = {
    name: ['ledger name', 'ledger', 'particulars', 'account', 'account name'],
    group: ['group parent', 'group', 'parent', 'under', 'tally group'],
    primary: ['primary group', 'primary'],
    openDr: ['opening dr', 'opening debit', 'opening balance dr'],
    openCr: ['opening cr', 'opening credit', 'opening balance cr'],
    movDr: ['debits in the year', 'debit movement', 'debit', 'transactions debit', 'gross debit'],
    movCr: ['credits in the year', 'credit movement', 'credit', 'transactions credit', 'gross credit'],
    closeDr: ['closing dr', 'closing debit', 'closing balance dr'],
    closeCr: ['closing cr', 'closing credit', 'closing balance cr'],
    head: ['statement head', 'head', 'fs head', 'schedule iii head', 'mapping'],
    gstin: ['gstin', 'gst no', 'gst number'],
  };
  for (const [key, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const at = cells.indexOf(n);
      if (at >= 0 && !Object.values(idx).includes(at)) { idx[key] = at; break; }
    }
  }
  return idx;
}

const num = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'object' && v && 'result' in v) v = v.result;         // an ExcelJS formula cell
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v).trim();
  if (!s || s === '-') return 0;
  const n = Number(s.replace(/[,₹\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return n;
};
const str = (v) => (v == null ? '' : typeof v === 'object' && 'richText' in v ? v.richText.map((x) => x.text).join('')
  : typeof v === 'object' && 'result' in v ? String(v.result ?? '') : typeof v === 'object' && 'text' in v ? String(v.text) : String(v)).trim();

/**
 * Read the rows of a filled template.
 * @param rows   array of arrays of cell values, row 0 being the heading row
 *               (any leading blank rows / titles above the heading are skipped)
 * @param opts   { heads: [{lineId, caption}] } for head validation
 * @returns { ledgers, mappings, errors, warnings, totals, columns }
 */
export function parseTemplateRows(rows, opts = {}) {
  const errors = [], warnings = [];
  // find the heading row: the first row that maps the two required columns
  let headAt = -1, cols = {};
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const m = mapColumns(rows[i]);
    if (m.name != null && (m.closeDr != null || m.closeCr != null)) { headAt = i; cols = m; break; }
  }
  if (headAt < 0) {
    errors.push('The heading row was not found. The sheet needs at least the columns "Ledger name", "Group (parent)", "Closing Dr" and "Closing Cr" — download the template and fill that.');
    return { ledgers: [], mappings: [], errors, warnings, totals: null, columns: cols };
  }
  for (const key of ['group', 'closeDr', 'closeCr']) {
    if (cols[key] == null) errors.push(`The column "${COL_BY_KEY.get(key).head}" is missing.`);
  }
  if (errors.length) return { ledgers: [], mappings: [], errors, warnings, totals: null, columns: cols };

  const headById = new Map(), headByCaption = new Map();
  for (const h of (opts.heads || [])) { headById.set(String(h.lineId), h.lineId); headByCaption.set(normKey(h.caption), h.lineId); }

  const seen = new Map();
  const ledgers = [], mappings = [];
  const tot = { openDr: 0, openCr: 0, closeDr: 0, closeCr: 0 };
  const hasMov = cols.movDr != null || cols.movCr != null;
  let anyMov = false;
  const get = (row, key) => (cols[key] == null ? undefined : row[cols[key]]);

  for (let i = headAt + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const line = i + 1;
    const name = str(get(row, 'name'));
    const allBlank = COLUMNS.every((c) => { const v = get(row, c.key); return v == null || str(v) === ''; });
    if (allBlank) continue;
    if (!name) { errors.push(`Row ${line}: the ledger name is blank.`); continue; }
    if (/^total/i.test(name) && !str(get(row, 'group'))) { warnings.push(`Row ${line}: "${name}" looks like a total row and was skipped.`); continue; }
    const key = normKey(name);
    if (seen.has(key)) { errors.push(`Row ${line}: "${name}" is already on row ${seen.get(key)} — each ledger once.`); continue; }
    seen.set(key, line);
    const group = str(get(row, 'group'));
    if (!group) { errors.push(`Row ${line}: "${name}" has no group.`); continue; }
    if (/^\d+(\.\d+)?$/.test(group)) { errors.push(`Row ${line}: the group of "${name}" is a number (${group}) — it must be the group name.`); continue; }
    let primary = str(get(row, 'primary'));
    if (!primary) {
      const sub = SUBGROUP_PRIMARY[normKey(group)];
      primary = sub || (PRIMARY_GROUPS.some(([g]) => normKey(g) === normKey(group)) ? group : '');
    }
    const n = {};
    let badNum = false;
    for (const k of ['openDr', 'openCr', 'movDr', 'movCr', 'closeDr', 'closeCr']) {
      const v = num(get(row, k));
      if (Number.isNaN(v)) { errors.push(`Row ${line}: "${name}" — "${COL_BY_KEY.get(k).head}" is not a number (${str(get(row, k))}).`); badNum = true; }
      else if (v < 0) { errors.push(`Row ${line}: "${name}" — "${COL_BY_KEY.get(k).head}" is negative (${v}). Put the amount in the other column instead of using a minus sign.`); badNum = true; }
      n[k] = v;
    }
    if (badNum) continue;
    if (n.closeDr && n.closeCr) { errors.push(`Row ${line}: "${name}" has both a closing debit and a closing credit — a ledger has one balance.`); continue; }
    if (n.openDr && n.openCr) { errors.push(`Row ${line}: "${name}" has both an opening debit and an opening credit.`); continue; }
    const headText = str(get(row, 'head'));
    let lineId = null;
    if (headText) {
      lineId = headById.get(headText) || headByCaption.get(normKey(headText)) || null;
      if (!lineId) errors.push(`Row ${line}: "${name}" — the statement head "${headText}" is not one the tool knows. Pick it from the Heads sheet, or leave it blank.`);
    }
    const gstin = str(get(row, 'gstin')).toUpperCase();
    if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(gstin)) warnings.push(`Row ${line}: "${name}" — "${gstin}" is not a valid GSTIN; it was ignored.`);
    for (const k of Object.keys(tot)) tot[k] += n[k];
    const movGiven = hasMov && (n.movDr !== 0 || n.movCr !== 0);
    if (movGiven) anyMov = true;
    const current = toRupees(toPaise(n.closeDr) - toPaise(n.closeCr));
    const prior = toRupees(toPaise(n.openDr) - toPaise(n.openCr));
    // a movement that does not explain the change of balance is a sign of a wrong column
    if (movGiven && Math.abs((prior + n.movDr - n.movCr) - current) > 0.005) {
      warnings.push(`Row ${line}: "${name}" — opening ${format(toPaise(prior))} plus debits ${format(toPaise(n.movDr))} less credits ${format(toPaise(n.movCr))} is not the closing ${format(toPaise(current))}. The movements are kept but check them.`);
    }
    const isRevenue = REVENUE_PRIMARIES.has(normKey(primary)) || REVENUE_PRIMARIES.has(normKey(group));
    const groupPath = primary && normKey(primary) !== normKey(group) ? [group, primary] : [group];
    const led = { name, group, primary: primary || group, groupPath, gstin: /^[0-9]{2}[A-Z]{5}/.test(gstin) ? gstin : '', isRevenue, current, prior };
    if (movGiven) { led.drTotal = n.movDr; led.crTotal = n.movCr; }
    ledgers.push(led);
    if (lineId) mappings.push({ ledgerKey: name, lineId, approved: true, confidence: 'template', reason: 'head given in the uploaded trial balance' });
  }
  if (!ledgers.length && !errors.length) errors.push('No ledger rows were found under the heading row.');

  const dCloseP = toPaise(tot.closeDr) - toPaise(tot.closeCr);
  const dOpenP = toPaise(tot.openDr) - toPaise(tot.openCr);
  if (dCloseP !== 0) errors.push(`The closing balances do not balance: debits ${format(toPaise(tot.closeDr))}, credits ${format(toPaise(tot.closeCr))}, difference ${format(dCloseP)}. The books must balance before they can be imported.`);
  if (dOpenP !== 0) {
    if (tot.openDr === 0 && tot.openCr === 0) warnings.push('No opening balances were given, so the comparative column and the capital accounts’ opening will read as nil.');
    else errors.push(`The opening balances do not balance: debits ${format(toPaise(tot.openDr))}, credits ${format(toPaise(tot.openCr))}, difference ${format(dOpenP)}.`);
  }
  if (hasMov && !anyMov) warnings.push('The movement columns are present but empty — capital introduced and drawings will be shown net.');
  if (!hasMov) warnings.push('The sheet has no movement columns, so capital introduced and drawings will be shown as one net figure. The template has them if you need them.');

  return { ledgers, mappings, errors, warnings, columns: cols,
    totals: { openDr: tot.openDr, openCr: tot.openCr, closeDr: tot.closeDr, closeCr: tot.closeCr, rows: ledgers.length, withHead: mappings.length, withMovements: ledgers.filter((l) => l.drTotal != null).length } };
}

/** Read a workbook (ExcelJS instance already loaded) into rows and parse it. */
export async function readTemplate(ExcelJS, arrayBuffer, opts = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(arrayBuffer);
  // prefer the sheet called Trial Balance; else the first sheet whose heading maps
  const sheets = wb.worksheets.slice().sort((a, b) => (/trial/i.test(b.name) ? 1 : 0) - (/trial/i.test(a.name) ? 1 : 0));
  let best = null;
  for (const ws of sheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => { rows[n - 1] = row.values.slice(1); });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    const res = parseTemplateRows(rows, opts);
    res.sheet = ws.name;
    if (!best || (res.ledgers.length && !best.ledgers.length)) best = res;
    if (res.ledgers.length) break;
  }
  return best || { ledgers: [], mappings: [], errors: ['The workbook has no sheets.'], warnings: [], totals: null };
}
