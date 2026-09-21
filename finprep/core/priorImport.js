/* ============================================================================
 * priorImport.js — read last year's signed financial statements
 *
 * Extracts the entity, auditor and signatory particulars, the shareholding, and
 * the prior-year figures, so the comparative column ties to the SIGNED accounts
 * rather than to Tally's prior column.
 *
 * Runs in the browser, where the file already is: Excel through ExcelJS and PDF
 * through PDF.js. Nothing is applied automatically — everything comes back with
 * its source and confidence for the preparer to confirm or correct (spec §4:
 * "For each extracted field show value, source, confidence and review status").
 *
 * Figures are matched on the CAPTION, not on last year's note numbers. Note
 * numbering differs between firms — many number note 1 as the accounting
 * policies — and matching on a number silently shifts every head by one.
 * ==========================================================================*/

import { LINES, linesFor } from './schedule3.js';

/* ---------- cell helpers (ExcelJS) -------------------------------------- */
export function cellText(cell) {
  if (!cell) return null;
  let v = cell.value;
  if (v && typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('').trim() || null;
    if (v.formula !== undefined) return (v.result != null && typeof v.result !== 'number') ? String(v.result).trim() : null;
    if (v.text != null) v = v.text;
    else if (v.result != null) v = v.result;
    else return null;
  }
  if (typeof v === 'number' || v == null) return null;
  const s = String(v).trim();
  return s || null;
}
export function cellNum(cell) {
  if (!cell) return null;
  let v = cell.value;
  if (v && typeof v === 'object') {
    if (typeof v.result === 'number') return v.result;
    if (v.result != null && typeof v.result !== 'object') v = v.result;
    else if (v.text != null) v = v.text;
    else return null;
  }
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = v.trim();
    const neg = /^\(.*\)$/.test(t) || /-\s*$/.test(t);
    const s = t.replace(/(?:₹|₹|\bRs\.?\b|\bINR\b)/gi, '').replace(/[(),\s]/g, '').replace(/-\s*$/, '');
    if (s === '' || s === '-') return null;
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return neg ? -Math.abs(n) : n;
  }
  return null;
}

/* ---------- caption → line id ------------------------------------------- */
/**
 * Captions are compared word by word with plurals folded away, because signed
 * statements vary the number freely — "Employee benefit expenses" against our
 * "Employee benefits expense" is the same line, and an exact match misses it.
 */
const singular = (w) => (/(ss|us|is)$/.test(w) ? w : w.replace(/ies$/, 'y').replace(/s$/, ''));
const norm = (s) => ' ' + String(s == null ? '' : s).toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  .split(' ').map(singular).join(' ') + ' ';

/** Extra wordings commonly seen on signed statements, beyond our own captions. */
const CAPTION_ALIASES = {
  share_capital: ['share capital', 'equity share capital', 'paid up capital'],
  reserves_surplus: ['reserves and surplus', 'reserves surplus', 'other equity'],
  share_warrants: ['money received against share warrants'],
  share_application_money: ['share application money pending allotment'],
  lt_borrowings: ['long term borrowings', 'long-term borrowings'],
  deferred_tax_liability: ['deferred tax liabilities net', 'deferred tax liability net',
    'deferred tax liabilities', 'deferred tax liability'],
  other_lt_liabilities: ['other long term liabilities', 'other long-term liabilities'],
  lt_provisions: ['long term provisions', 'long-term provisions'],
  st_borrowings: ['short term borrowings', 'short-term borrowings'],
  trade_payables_msme: ['total outstanding dues of micro enterprises and small enterprises',
    'dues of micro enterprises and small enterprises', 'micro and small enterprises'],
  trade_payables_others: ['total outstanding dues of creditors other than micro enterprises and small enterprises',
    'trade payables', 'other than micro enterprises and small enterprises'],
  other_current_liabilities: ['other current liabilities'],
  st_provisions: ['short term provisions', 'short-term provisions'],
  ppe: ['property plant and equipment', 'tangible assets', 'fixed assets',
    'property plant and equipment and intangible assets'],
  cwip: ['capital work in progress', 'capital work-in-progress'],
  intangibles: ['intangible assets', 'other intangible assets'],
  intangibles_under_dev: ['intangible assets under development'],
  nc_investments: ['non current investments', 'non-current investments'],
  deferred_tax_asset: ['deferred tax assets net', 'deferred tax asset net',
    'deferred tax assets', 'deferred tax asset'],
  lt_loans_advances: ['long term loans and advances', 'long-term loans and advances'],
  other_nc_assets: ['other non current assets', 'other non-current assets'],
  current_investments: ['current investments'],
  inventories: ['inventories', 'inventory'],
  trade_receivables: ['trade receivables', 'sundry debtors'],
  cash_and_equivalents: ['cash and cash equivalents', 'cash and bank balances'],
  bank_other_balances: ['other bank balances', 'bank balances other than cash and cash equivalents'],
  st_loans_advances: ['short term loans and advances', 'short-term loans and advances'],
  other_current_assets: ['other current assets'],
  revenue_operations: ['revenue from operations', 'revenue from operation', 'turnover'],
  other_income: ['other income'],
  cost_materials_consumed: ['cost of materials consumed', 'cost of material consumed'],
  purchases_stock_in_trade: ['purchases of stock in trade', 'purchase of traded goods', 'purchases of stock-in-trade'],
  changes_in_inventories: ['changes in inventories of finished goods work in progress and stock in trade',
    'changes in inventories', 'change in inventories'],
  employee_benefits: ['employee benefits expense', 'employee benefit expense'],
  finance_costs: ['finance costs', 'finance cost'],
  depreciation_amortisation: ['depreciation and amortization expense', 'depreciation and amortisation expense',
    'depreciation and amortization', 'depreciation'],
  other_expenses: ['other expenses'],
  current_tax: ['current tax'],
  deferred_tax: ['deferred tax charge credit', 'deferred tax'],
  tax_earlier_years: ['tax expense credit pertaining to earlier years', 'taxes for earlier years'],
  exceptional_items: ['exceptional items'],
};

/** Longest-match caption lookup, so "Other income" never beats "Other expenses". */
export function lineFromCaption(text, division = 'AS') {
  const s = norm(text);
  if (s.trim().length < 3) return null;
  let best = null, bestLen = 0;
  const consider = (id, phrase) => {
    const p = norm(phrase).trim();
    if (!p || p.length <= bestLen) return;
    if (s.includes(' ' + p + ' ')) { best = id; bestLen = p.length; }
  };
  for (const l of linesFor(division)) {
    consider(l.id, l.caption);
    if (l.indasCaption) consider(l.id, l.indasCaption);
  }
  for (const [id, list] of Object.entries(CAPTION_ALIASES)) for (const p of list) consider(id, p);
  return best;
}

/* ---------- entity / signatory particulars ------------------------------ */
const CIN_RX = /\b([LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b/i;

export function extractParticulars(cells) {
  const joined = cells.map((c) => c.v).join('\n');
  const out = { fields: [], shareholders: [] };
  const add = (key, label, value, source, confidence = 'high') => {
    if (value == null || value === '') return;
    out.fields.push({ key, label, value: String(value).trim(), source, confidence, status: 'unconfirmed' });
  };

  const cin = joined.match(CIN_RX);
  if (cin) add('cin', 'CIN', cin[1].toUpperCase(), 'pattern match in the document');

  const frn = joined.match(/(?:Firm\s*)?Registration\s*(?:No|Number)\.?\s*:?\s*([0-9]{5,6}[A-Za-z]?)/i);
  if (frn) add('auditorFrn', 'Auditor firm registration number', frn[1].toUpperCase(), 'near "Registration No."');

  const mrn = joined.match(/(?:Membership|M\.?\s*No|Mem\.?\s*No|MRN)\.?\s*:?\s*([0-9]{5,6})/i);
  if (mrn) add('auditorMrn', 'Auditor membership number', mrn[1], 'near "Membership No."');

  // "For <firm name>" immediately above "Chartered Accountants", in the SAME
  // column. The board's "For and on behalf of the Board of Directors of" sits
  // alongside it and must never be mistaken for the auditor.
  const isBoard = (t) => /on behalf of|board of directors/i.test(t);
  const ca = cells.find((c) => /^chartered accountants$/i.test(c.v.trim()));
  if (ca) {
    const above = cells
      .filter((c) => c.sheet === ca.sheet && c.c === ca.c && c.r < ca.r && c.r >= ca.r - 3)
      .sort((a, b) => b.r - a.r)
      .find((c) => /^for\s+.{2,}/i.test(c.v) && c.v.length < 80 && !isBoard(c.v));
    if (above) add('auditorFirm', 'Auditor firm', above.v.replace(/^for\s+/i, '').trim(),
      'line above "Chartered Accountants"');
  }
  // The entity the board signs for: the line under "For and on behalf of ..."
  const boardLine = cells.find((c) => isBoard(c.v));
  if (boardLine) {
    const under = cells.find((c) => c.sheet === boardLine.sheet && c.c === boardLine.c && c.r === boardLine.r + 1);
    if (under && under.v.length < 90 && !isBoard(under.v)) {
      add('legalName', 'Company legal name', under.v.trim(), 'line under "For and on behalf of the Board of Directors of"');
    }
  }

  /** the name printed directly above a role label, in the same column */
  const nameAbove = (role) => cells
    .filter((c) => c.v.trim().toLowerCase() === role)
    .map((L) => cells.find((c) => c.sheet === L.sheet && c.c === L.c && c.r === L.r - 1))
    .filter(Boolean).map((c) => c.v.trim())
    .filter((n) => n && n.length < 60 && !/^din|^membership|^place|^date/i.test(n));

  const partners = nameAbove('partner');
  if (partners[0]) add('auditorPartner', 'Signing partner', partners[0], 'name above "Partner"');

  const dirs = nameAbove('director');
  dirs.slice(0, 4).forEach((d, i) => add('director' + (i + 1), `Signing director ${i + 1}`, d, 'name above "Director"'));

  const dins = [...joined.matchAll(/DIN\s*:?\s*([0-9]{8})/gi)].map((m) => m[1]);
  dins.slice(0, 4).forEach((d, i) => add('din' + (i + 1), `DIN ${i + 1}`, d, 'near "DIN"'));

  // Company name: the most repeated short line that is not a heading
  const counts = new Map();
  for (const c of cells) {
    const t = c.v.trim();
    if (t.length < 5 || t.length > 90) continue;
    if (/balance sheet|profit and loss|cash flow|notes|schedule|particulars|chartered/i.test(t)) continue;
    if (/(private limited|pvt\.? ltd|limited|llp)\b/i.test(t)) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && !out.fields.some((f) => f.key === 'legalName')) add('legalName', 'Company legal name', top[0], `appears ${top[1]} times in the document`);

  // Shareholders holding more than 5%
  const shIdx = cells.findIndex((c) => /shareholders?\s+holding\s+more\s+than\s+5|holding\s+more\s+than\s+5\s*%/i.test(c.v));
  if (shIdx >= 0) {
    const anchor = cells[shIdx];
    const rows = new Map();
    for (const c of cells) {
      if (c.sheet !== anchor.sheet || c.r <= anchor.r || c.r > anchor.r + 14) continue;
      if (!rows.has(c.r)) rows.set(c.r, {});
      rows.get(c.r)[c.c] = c.v;
    }
    for (const [, cols] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      const name = cols[1] || cols[2];
      if (!name) continue;
      if (/name of|number of|% ?holding|particulars|^note\b/i.test(name)) continue;
      if (/promoter/i.test(name) && Object.keys(cols).length < 2) break;
      const nums = Object.values(cols).map((x) => Number(String(x).replace(/[, %]/g, ''))).filter(Number.isFinite);
      out.shareholders.push({ name: name.trim(), shares: nums[0] ?? null, percent: nums[1] ?? null });
      if (out.shareholders.length >= 12) break;
    }
  }
  return out;
}

/* ---------- figures ------------------------------------------------------ */
/** Find the header row of a face/note sheet and the amount columns. */
/**
 * Is this heading a period column? Templates vary: "As at 31 March 2025",
 * "For the year ended", or just the date. A bare year counts, because plenty
 * of sets put the words in a merged banner above and only the date in the
 * column itself.
 */
const isPeriodHeader = (t) =>
  /as at|year ended|period ended|for the year|for the period/i.test(t) || /\b(19|20)\d{2}\b/.test(t);

/** The period columns on one row, ignoring a merged banner repeated across it. */
function periodColumnsOn(ws, r, minCol) {
  const row = ws.getRow(r);
  const texts = [];
  row.eachCell({ includeEmpty: false }, (c, cn) => texts.push([cn, (cellText(c) || '').trim()]));
  const distinct = new Set(texts.map(([, t]) => t).filter(Boolean));
  if (distinct.size <= 1) return [];                       // a merged title spanning the row
  return texts.filter(([cn, t]) => t && cn > minCol && isPeriodHeader(t))
    .map(([cn, t]) => ({ c: cn, text: t.replace(/\s+/g, ' ').trim(), year: yearOf(t) }));
}

/**
 * The financial year a column heading refers to. "As at March 31, 2025" and
 * "FY 2024-25" both mean the year ended in 2025, so the LATER year in the
 * heading is the one that counts.
 */
export function yearOf(text) {
  const s = String(text == null ? '' : text);
  // "FY 2025-26" and "2025-26" mean the year ENDING in 2026, which the plain
  // four-digit scan would read as 2025.
  const span = s.match(/\b(19|20)(\d{2})\s*[-–—/]\s*(\d{2})\b/);
  if (span) {
    const start = Number(span[1] + span[2]);
    const end = Number(span[1] + span[3]) < start ? start + 1 : Number(span[1] + span[3]);
    return end;
  }
  const ys = s.match(/\b(?:19|20)\d{2}\b/g);
  return ys ? Math.max(...ys.map(Number)) : null;
}

/**
 * The units a sheet is stated in.
 *
 * "(All amounts in '000 unless otherwise stated)" means 87304.54 on the face
 * is ₹8,73,04,540. Importing that figure as rupees understates the comparative
 * a thousandfold, so the units are read, applied, and reported — never assumed.
 */
/**
 * Order matters: the longer figure-wordings are tested first, so "'000" is
 * read as thousands and never as hundreds with a stray zero. The scales match
 * the ones the tool itself presents in (money.js SCALES).
 */
export const UNIT_RULES = [
  [/\bin\s*(?:rs\.?\s*)?['’]?\s*000\s*(?:'s)?\b|\bin\s*thousands?\b|\bthousands?\s+(?:of\s+)?rupees\b|\brupees\s+in\s+thousands?\b/i, 1000, 'thousands'],
  [/\bin\s*(?:rs\.?\s*)?lakhs?\b|\bin\s*(?:rs\.?\s*)?lacs?\b|\brupees\s+in\s+lakhs?\b/i, 100000, 'lakhs'],
  [/\bin\s*(?:rs\.?\s*)?millions?\b|\brupees\s+in\s+millions?\b/i, 1000000, 'millions'],
  [/\bin\s*(?:rs\.?\s*)?crores?\b|\brupees\s+in\s+crores?\b/i, 10000000, 'crores'],
  [/\bin\s*(?:rs\.?\s*)?hundreds?\b|\brupees\s+in\s+hundreds?\b|\bin\s*(?:rs\.?\s*)?['’]\s*00\b(?!0)/i, 100, 'hundreds'],
];
export function unitsOf(ws, scanRows = 10) {
  for (let r = 1; r <= Math.min(scanRows, ws.rowCount || 0); r++) {
    let found = null;
    ws.getRow(r).eachCell({ includeEmpty: false }, (c) => {
      if (found) return;
      const t = cellText(c) || '';
      for (const [rx, factor, label] of UNIT_RULES) {
        if (rx.test(t)) { found = { factor, label, source: `${ws.name}!row ${r}: “${t.trim().slice(0, 64)}”` }; return; }
      }
    });
    if (found) return found;
  }
  return { factor: 1, label: 'rupees', source: null };
}

function findHeader(ws) {
  const max = Math.min(ws.rowCount || 40, 40);
  for (let r = 1; r <= max; r++) {
    const row = ws.getRow(r);
    let note = null, particulars = null;
    row.eachCell({ includeEmpty: false }, (c, cn) => {
      const t = cellText(c);
      if (!t) return;
      if (/particular/i.test(t) && particulars == null) particulars = cn;
      if (/^notes?$/i.test(t)) note = cn;
    });
    if (particulars == null) continue;

    // The period columns usually sit on the same row. Where the template puts
    // the wording above and the dates below, look either side before giving up.
    for (const rr of [r, r + 1, r - 1, r + 2, r - 2]) {
      if (rr < 1 || rr > (ws.rowCount || 0)) continue;
      const cols = periodColumnsOn(ws, rr, particulars);
      if (cols.length) return { r: Math.max(r, rr), note, particulars, cols,
        cy: cols[0].c, py: cols[1] ? cols[1].c : null };
    }
  }
  return null;
}

/**
 * The caption on a row, which is NOT simply the first non-empty cell.
 *
 * A statement of profit and loss numbers its sections in column 1 —
 * "I | Revenue from operations | 23" — so taking the first non-empty cell
 * reads the caption as "I" and the whole P&L imports as nothing. Serial
 * numbers, roman numerals, list letters and the note reference are skipped;
 * the first cell that is actually wording is the caption.
 */
const INDEX_CELL = /^\(?\s*(?:[ivxlcdm]+|[a-z]|\d{1,3})\s*[.)]?\s*$/i;
function labelOf(row, H) {
  const upto = Math.max(1, (H.cy || 2) - 1);
  let longest = '';
  for (let c = 1; c <= upto; c++) {
    if (H.note && c === H.note) continue;               // the note reference, not a caption
    const t = (cellText(row.getCell(c)) || '').trim();
    if (!t || INDEX_CELL.test(t)) continue;
    if (t.length > longest.length) longest = t;
    return t;
  }
  return longest;
}

/**
 * A cash flow statement holds MOVEMENTS, not balances. "Trade receivables" on
 * it is the change for the year, and importing that as a comparative would put
 * a movement where a balance belongs. Figures are never read from one.
 */
function isCashFlowSheet(ws) {
  if (/cash\s*flow|^cfs$/i.test(ws.name || '')) return true;
  for (let r = 1; r <= Math.min(6, ws.rowCount || 0); r++) {
    const row = ws.getRow(r);
    let hit = false;
    row.eachCell({ includeEmpty: false }, (c) => {
      if (/cash\s*flow\s*statement|statement of cash flows/i.test(cellText(c) || '')) hit = true;
    });
    if (hit) return true;
  }
  return false;
}

/**
 * Prior-year figures, keyed by OUR line id.
 *
 * WHICH COLUMN. A set of signed accounts for last year shows last year in its
 * current column; a working file for THIS year shows this year first and the
 * comparative beside it. Guessing "the first period column" is right for one
 * and silently wrong for the other, so the column is chosen by the year in its
 * heading: the one ending in `priorYear`. Where no heading carries a year, the
 * first column is used and the choice is reported so it can be corrected.
 *
 * WHAT SCALE. "(All amounts in '000 unless otherwise stated)" means 87304.54
 * on the face is ₹8,73,04,540. The units are read from the sheet and applied.
 *
 * @param opts.priorYear     the comparative year wanted, e.g. 2025
 * @param opts.columnByYear  { [sheetName]: year } — the preparer's own choice
 * @param opts.unitsFactor   overrides the units read from the sheet
 */
export function extractFigures(wb, division = 'AS', opts = {}) {
  const found = new Map();   // lineId -> {amount, source, caption}
  const unmatched = [];
  const take = (id, amount, source, caption) => {
    if (id == null || amount == null || !Number.isFinite(amount)) return;
    if (found.has(id)) return;                        // first (face) wins over notes
    found.set(id, { amount, source, caption });
  };

  const skipped = [];
  const columns = [];
  const unitsSeen = [];
  for (const ws of wb.worksheets) {
    if (isCashFlowSheet(ws)) { skipped.push({ sheet: ws.name, why: 'cash flow statement — holds movements, not balances' }); continue; }
    const H = findHeader(ws);
    if (!H) { skipped.push({ sheet: ws.name, why: 'no "Particulars" heading with a period column was found' }); continue; }

    // --- which period column ---------------------------------------------
    const wanted = (opts.columnByYear && opts.columnByYear[ws.name]) || opts.priorYear || null;
    let pick = wanted ? H.cols.find((c) => c.year === Number(wanted)) : null;
    let because = pick ? `heading names ${wanted}` : null;
    if (!pick) {
      // A working file holds sheets for other years too — a 2023-24 trial
      // balance, a prior fixed-asset register. Reading "the first period
      // column" off those would import a figure from the wrong year without
      // saying so, so the sheet is skipped and named instead.
      if (wanted) {
        const seen = H.cols.map((c) => c.text).join('”, “');
        skipped.push({ sheet: ws.name, why: `no column is headed ${wanted} — its period columns are “${seen}”` });
        continue;
      }
      pick = H.cols[0];
      because = 'the first period column was used';
    }
    columns.push({ sheet: ws.name, chosen: pick, because,
      all: H.cols.map((c) => ({ c: c.c, text: c.text, year: c.year })) });

    // --- what scale -------------------------------------------------------
    const u = unitsOf(ws);
    const factor = opts.unitsFactor != null ? Number(opts.unitsFactor) : u.factor;
    if (u.factor !== 1 || opts.unitsFactor != null) unitsSeen.push({ sheet: ws.name, ...u, applied: factor });

    const last = ws.rowCount || 0;
    for (let r = H.r + 1; r <= last; r++) {
      const row = ws.getRow(r);
      const label = labelOf(row, H);
      if (!label) continue;
      if (/^total\b/i.test(label)) continue;          // totals are derived, never imported
      const raw = cellNum(row.getCell(pick.c));
      if (raw == null) continue;
      const amount = raw * factor;
      const id = lineFromCaption(label, division);
      const src = `${ws.name}!row ${r}, column “${pick.text}”${factor !== 1 ? ` (${u.label} × ${factor.toLocaleString('en-IN')})` : ''}`;
      if (id) take(id, amount, src, label);
      else if (Math.abs(amount) > 0) unmatched.push({ sheet: ws.name, row: r, label, amount });
    }
  }
  return {
    figures: [...found.entries()].map(([lineId, v]) => ({ lineId, ...v })),
    unmatched: unmatched.slice(0, 40),
    skippedSheets: skipped,
    columns,
    units: unitsSeen,
  };
}

/* ---------- entry points ------------------------------------------------- */
/** Read an .xlsx. `ExcelJS` is injected so this stays environment-agnostic. */
export async function readWorkbook(ExcelJS, arrayBuffer, division = 'AS', opts = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(arrayBuffer);
  const cells = [];
  wb.worksheets.forEach((ws) => ws.eachRow((row, r) =>
    row.eachCell((c, cn) => { const v = cellText(c); if (v) cells.push({ sheet: ws.name, r, c: cn, v }); })));
  const particulars = extractParticulars(cells);
  const fig = extractFigures(wb, division, opts);
  return { kind: 'xlsx', ...particulars, ...fig };
}

/**
 * Read a PDF's text layer. Particulars only — figures are NOT taken from a PDF,
 * because column alignment cannot be recovered reliably from extracted text and
 * a mis-read comparative is worse than none.
 */
export async function readPdf(pdfjsLib, arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const cells = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // group items into rows by their y position so "name above role" still works
    const rows = new Map();
    for (const it of content.items) {
      const y = Math.round(it.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: Math.round(it.transform[4]), s: it.str });
    }
    const ys = [...rows.keys()].sort((a, b) => b - a);
    ys.forEach((y, idx) => {
      const items = rows.get(y).sort((a, b) => a.x - b.x);
      items.forEach((it, i) => { if (it.s.trim()) cells.push({ sheet: 'p' + p, r: idx + 1, c: i + 1, v: it.s.trim() }); });
    });
  }
  const particulars = extractParticulars(cells);
  return { kind: 'pdf', ...particulars, figures: [], unmatched: [],
    note: 'Figures are not read from a PDF — column alignment cannot be recovered reliably from extracted text. Upload the Excel, or key the comparatives.' };
}
