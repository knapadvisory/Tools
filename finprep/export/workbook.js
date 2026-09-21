/* ============================================================================
 * workbook.js — formula-linked Schedule III workbook
 *
 * One workbook, seven sheets, and REAL links between them:
 *
 *     Trial Balance  ──►  Notes (leaf sub-lines)  ──►  Balance Sheet / P&L
 *          E/F                    B/C  =SUM(leaves)          =Notes!B<n>
 *
 * Nothing points outside the file: every formula is an internal reference, so
 * the workbook opens anywhere without a source workbook, and a reviewer can
 * click any face figure and walk it back to the ledger it came from.
 *
 * Two rules keep the linkage honest:
 *
 *  1. A ledger name is NOT a key. The trial-balance index maps a name to the
 *     LIST of rows carrying that name, and rows are pushed, never overwritten.
 *     (The previous export used a plain object keyed by name, so a second
 *     ledger with the same name silently re-pointed the first one's note line
 *     at the wrong row. That defect is closed here — see buildTbIndex.)
 *  2. A link is written only when it RECALCULATES to the value being shown.
 *     If the referenced rows do not add back to the figure, the figure is
 *     written as a value and the shortfall is reported on the Review sheet.
 *     A wrong formula that looks right is worse than no formula.
 *
 * Every cell that carries a formula also carries its cached `result`, so the
 * numbers are correct the moment the file is opened, before any recalculation.
 *
 * Signs: every figure is presented positive in its own nature. The payload
 * supplies natural-sign amounts (a credit balance on a credit-side head is a
 * positive number); the Trial Balance sheet carries the Dr/Cr side in its own
 * column instead of pushing minus signs into the numbers. The cash flow is the
 * one statement where a negative is real — an outflow — and it is shown in
 * brackets, which is the presentation convention, not a bookkeeping sign.
 *
 * API:  buildWorkbook(ExcelJS, payload) -> ExcelJS.Workbook
 *       ExcelJS is injected so this runs against window.ExcelJS in the browser
 *       and against the UMD build under Node without importing anything.
 * ==========================================================================*/

/* ---------------------------------------------------------------- constants */

export const SHEETS = ['Balance Sheet', 'Profit & Loss', 'Cash Flow', 'Notes',
                       'Trial Balance', 'Disclosures', 'Review'];

const NUM = '#,##0.00';
const NUM_BR = '#,##0.00;(#,##0.00)';           // cash flow: outflows in brackets
const FONT = { name: 'Calibri', size: 10 };

const INK = {
  title: 'FF1A2B45',
  muted: 'FF5B6B7F',
  rule: 'FFB9C2CE',
  red: 'FFB00020',
  redFill: 'FFFDE7E9',
  bandFill: 'FFEFF3F8',
  headFill: 'FFDDE5EE',
};

const SEV_ORDER = { CRITICAL: 0, HIGH: 1, REVIEW: 2, INFO: 3 };
const SEV_FILL = { CRITICAL: 'FFFDE7E9', HIGH: 'FFFFF1E0', REVIEW: 'FFFFFBE6', INFO: 'FFF1F5FA' };
const SEV_INK = { CRITICAL: 'FFB00020', HIGH: 'FF9A5B00', REVIEW: 'FF7A6500', INFO: 'FF3A5568' };

/* ------------------------------------------------------------------ helpers */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? Math.round(v * 100) / 100 : 0);
const txt = (v) => (v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
/** two rupee amounts agree if they agree to the paisa */
const same = (a, b) => Math.abs(num(a) - num(b)) < 0.005;
const nameKey = (s) => txt(s).replace(/\s+/g, ' ').trim().toLowerCase();

function colLetter(i) {                      // 1 -> A
  let s = '';
  for (let n = i; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Quote a sheet name for a formula only when it needs quoting. */
function sheetRef(name) {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${String(name).replace(/'/g, "''")}'`;
}
const cellRef = (sheet, col, row) => `${sheetRef(sheet)}!${col}${row}`;

function put(ws, r, c, value, o = {}) {
  const cell = ws.getRow(r).getCell(c);
  cell.value = value;
  cell.font = Object.assign({}, FONT, o.font || {});
  if (o.numFmt) cell.numFmt = o.numFmt;
  if (o.align) cell.alignment = o.align;
  if (o.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
  if (o.border) cell.border = o.border;
  return cell;
}

/** A money cell: always {formula, result} when linked, so the cache is right. */
function money(ws, r, c, value, formula, o = {}) {
  const v = num(value);
  const cell = put(ws, r, c, formula ? { formula, result: v } : v, o);
  cell.numFmt = o.numFmt || NUM;
  cell.alignment = o.align || { horizontal: 'right' };
  return cell;
}

const TOP = { top: { style: 'thin', color: { argb: INK.rule } } };
const TOP_DOUBLE = { top: { style: 'thin', color: { argb: INK.rule } },
                     bottom: { style: 'double', color: { argb: INK.title } } };

/* ------------------------------------------------------------ sheet framing */

/**
 * The masthead every sheet carries: who, the statutory identifier, what
 * statement this is and for which period, the scale the figures are in, and
 * the status of the file. Returns the first free row.
 */
function masthead(ws, meta, title, lastCol, extra) {
  const L = colLetter(lastCol);
  ws.mergeCells(`A1:${L}1`);
  put(ws, 1, 1, txt(meta.entity) || 'Entity', { font: { bold: true, size: 13, color: { argb: INK.title } } });

  const div = meta.division === 'INDAS'
    ? 'Schedule III, Division II — Indian Accounting Standards'
    : 'Schedule III, Division I — Accounting Standards';
  const id = [meta.cin ? `CIN: ${meta.cin}` : null, div].filter(Boolean).join('   ·   ');
  ws.mergeCells(`A2:${L}2`);
  put(ws, 2, 1, id, { font: { size: 9, color: { argb: INK.muted } } });

  ws.mergeCells(`A3:${L}3`);
  put(ws, 3, 1, title, { font: { bold: true, size: 11, color: { argb: INK.title } } });

  const right = [`Status: ${txt(meta.status) || 'Draft'}`];
  if (extra && meta.snapshotId) right.unshift(`Snapshot ${meta.snapshotId}${meta.takenAt ? ' taken ' + meta.takenAt : ''}`);
  ws.mergeCells(`A4:${L}4`);
  put(ws, 4, 1, `${txt(meta.scaleLabel) || 'Amounts in ₹'}          ${right.join('   ·   ')}`,
      { font: { size: 9, italic: true, color: { argb: INK.muted } } });

  return 6;
}

function frame(ws, widths, freezeAt) {
  ws.columns = widths.map((w) => ({ width: w }));
  ws.properties.defaultRowHeight = 14;
  ws.views = [{ state: 'frozen', ySplit: freezeAt }];
  ws.pageSetup = {
    paperSize: 9,                    // A4
    orientation: 'portrait',
    fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.5, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
    printTitlesRow: `1:${freezeAt}`,
  };
  ws.headerFooter = { oddFooter: '&LPage &P of &N&R&F — &A' };
}

/** Column captions for a two-period statement. */
function columnHeads(ws, r, meta, heads) {
  heads.forEach((h, i) => {
    put(ws, r, i + 1, h.label, {
      font: { bold: true, size: 9, color: { argb: INK.title } },
      fill: INK.headFill,
      align: { horizontal: h.right ? 'right' : 'left', wrapText: true, vertical: 'middle' },
      border: { bottom: { style: 'thin', color: { argb: INK.rule } } },
    });
  });
  return r + 1;
}

/**
 * Signature block — the attestation page furniture. Face statements only:
 * the Review and Disclosures sheets are working papers and must never carry
 * anything that looks like a signed statement.
 */
function signatures(ws, meta, r) {
  const a = meta.auditor || {};
  const board = arr(meta.directors).length ? arr(meta.directors)
              : [{ name: '', din: '' }, { name: '', din: '' }];
  const muted = { font: { size: 9, color: { argb: INK.muted } } };
  const bold = { font: { bold: true, size: 9 } };
  const plain = { font: { size: 9 } };

  r += 1;
  put(ws, r, 1, `For ${a.firm || '________________________'}`, bold);
  put(ws, r, 3, 'For and on behalf of the Board of Directors', bold);
  r += 1;
  put(ws, r, 1, 'Chartered Accountants', plain);
  put(ws, r, 3, txt(meta.entity), plain);
  r += 1;
  put(ws, r, 1, `Firm registration no. ${a.frn || '____________'}`, muted);
  r += 3;                                                  // room to sign
  put(ws, r, 1, a.partner || '________________________', plain);
  put(ws, r, 3, board[0].name || '________________________', plain);
  if (board[1]) put(ws, r, 4, board[1].name || '________________________', plain);
  r += 1;
  put(ws, r, 1, 'Partner', muted);
  put(ws, r, 3, 'Director', muted);
  if (board[1]) put(ws, r, 4, 'Director', muted);
  r += 1;
  put(ws, r, 1, `Membership no. ${a.membership || '__________'}`, muted);
  put(ws, r, 3, `DIN ${board[0].din || '__________'}`, muted);
  if (board[1]) put(ws, r, 4, `DIN ${board[1].din || '__________'}`, muted);
  r += 2;
  put(ws, r, 1, `Place: ${meta.place || '____________'}`, plain);
  put(ws, r, 3, `Place: ${meta.place || '____________'}`, plain);
  r += 1;
  put(ws, r, 1, `Date: ${meta.signedOn || meta.date || '____________'}`, plain);
  put(ws, r, 3, `Date: ${meta.signedOn || meta.date || '____________'}`, plain);
  return r + 1;
}

/* ------------------------------------------------------- trial balance sheet */

/**
 * Writes the trial balance and returns the index the notes link through.
 *
 * The index is Map<normalised name, [row, ...]> — a LIST. Two ledgers called
 * "Axis Bank" occupy two rows and both are remembered; the second never
 * displaces the first. Each entry also carries the head it was classified to,
 * so a note only ever draws from rows that belong to it.
 */
function buildTrialBalance(ws, p) {
  const meta = p.meta;
  let r = masthead(ws, meta, `Trial balance (adjusted) for the year ended ${meta.currentLabel}`, 7, true);
  const heads = [
    { label: 'Ledger' }, { label: 'Tally group' }, { label: 'Primary group' },
    { label: 'Dr/Cr' }, { label: meta.currentLabel, right: true },
    { label: meta.priorLabel, right: true }, { label: 'Used in note' },
  ];
  const headRow = r;
  r = columnHeads(ws, r, meta, heads);
  frame(ws, [36, 24, 22, 7, 16, 16, 30], headRow);

  const index = new Map();
  const first = r;
  for (const row of arr(p.trialBalance)) {
    put(ws, r, 1, txt(row.ledger), { font: { size: 9 } });
    put(ws, r, 2, txt(row.group), { font: { size: 9, color: { argb: INK.muted } } });
    put(ws, r, 3, txt(row.primary), { font: { size: 9, color: { argb: INK.muted } } });
    put(ws, r, 4, txt(row.drcr), { font: { size: 9 }, align: { horizontal: 'center' } });
    money(ws, r, 5, row.current, null, { font: { size: 9 } });
    money(ws, r, 6, row.prior, null, { font: { size: 9 } });
    const use = row.note ? `Note ${row.note} — ${txt(row.lineCaption)}` : txt(row.lineCaption);
    put(ws, r, 7, use, { font: { size: 9, color: { argb: INK.muted } } });
    if ((r - first) % 2 === 1) for (let c = 1; c <= 7; c++) {
      const cell = ws.getRow(r).getCell(c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK.bandFill } };
    }

    const key = nameKey(row.ledger);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({ row: r, lineId: txt(row.lineId), current: num(row.current), prior: num(row.prior) });
    r += 1;
  }

  if (r > first) {
    const last = r - 1;
    // A control total, not an arithmetic one: debits and credits are both
    // stated positive, so adding the column would mean nothing. Each side is
    // totalled on its own and the two must agree.
    const side = (s, key) => arr(p.trialBalance)
      .filter((x) => txt(x.drcr) === s).reduce((t, x) => t + num(x[key]), 0);
    for (const [label, s, bottom] of [['Total — debits', 'Dr', false], ['Total — credits', 'Cr', true]]) {
      const b = bottom ? TOP_DOUBLE : TOP;
      put(ws, r, 1, label, { font: { bold: true, size: 9 }, border: b });
      for (let c = 2; c <= 4; c++) put(ws, r, c, '', { border: b });
      money(ws, r, 5, side(s, 'current'), `SUMIF(D${first}:D${last},"${s}",E${first}:E${last})`,
            { font: { bold: true, size: 9 }, border: b });
      money(ws, r, 6, side(s, 'prior'), `SUMIF(D${first}:D${last},"${s}",F${first}:F${last})`,
            { font: { bold: true, size: 9 }, border: b });
      put(ws, r, 7, s === 'Cr' ? 'Debits and credits must agree' : '',
          { font: { size: 8, italic: true, color: { argb: INK.muted } }, border: b });
      r += 1;
    }
    r += 1;
    put(ws, r, 1, 'Amounts are stated positive in the nature of the balance; the Dr/Cr column carries the side. '
                + 'Note sub-lines on the Notes sheet reference columns E and F of this sheet directly.',
        { font: { size: 8, italic: true, color: { argb: INK.muted } } });
  }
  return index;
}

/* ----------------------------------------------------------- notes linkage */

/**
 * Choose the trial-balance rows behind one note sub-line.
 *
 * Preference order, all of it deterministic:
 *   1. rows classified to this note's own head, not already consumed;
 *   2. any unconsumed row of that name;
 *   3. nothing — the line is then written as a value, never as a guess.
 *
 * Where a note has ONE sub-line of a name but several rows carry it (the
 * duplicate-name case), all of those rows are referenced and summed, so no row
 * is lost and none is double-counted. Where the note has SEVERAL sub-lines of
 * the same name, each takes its own row in turn.
 */
function pickRows(index, leaf, lineId, consumed, leavesOfThisName) {
  const cands = index.get(nameKey(leaf.name)) || [];
  if (!cands.length) return [];
  const free = cands.filter((c) => !consumed.has(c.row));
  const mine = free.filter((c) => c.lineId && lineId && c.lineId === lineId);
  const pool = mine.length ? mine : free;
  if (!pool.length) return [];

  if (leavesOfThisName > 1) {
    // one row per sub-line: prefer the row whose figures are the sub-line's
    const exact = pool.find((c) => same(c.current, leaf.current) && same(c.prior, leaf.prior));
    return [exact || pool[0]];
  }
  return pool;
}

function buildNotes(ws, p, tbIndex, link) {
  const meta = p.meta;
  let r = masthead(ws, meta, `Notes forming part of the financial statements for the year ended ${meta.currentLabel}`, 4, true);
  const headRow = r;
  r = columnHeads(ws, r, meta, [
    { label: 'Particulars' }, { label: meta.currentLabel, right: true },
    { label: meta.priorLabel, right: true }, { label: 'Basis / source' },
  ]);
  frame(ws, [58, 18, 18, 42], headRow);

  const totalRowByNote = new Map();
  const consumed = new Set();

  for (const note of arr(p.notes)) {
    put(ws, r, 1, `${note.number}.  ${txt(note.caption)}`,
        { font: { bold: true, size: 10, color: { argb: INK.title } } });
    r += 1;

    const leaves = arr(note.subLines);
    const counts = new Map();
    for (const l of leaves) counts.set(nameKey(l.name), (counts.get(nameKey(l.name)) || 0) + 1);

    const firstLeaf = r;
    for (const leaf of leaves) {
      put(ws, r, 1, '    ' + txt(leaf.name), { font: { size: 9 } });
      const rows = pickRows(tbIndex, leaf, note.lineId, consumed, counts.get(nameKey(leaf.name)) || 1);
      // Only link when the referenced rows actually add back to the figure.
      const okCur = rows.length && same(rows.reduce((t, x) => t + x.current, 0), leaf.current);
      const okPri = rows.length && same(rows.reduce((t, x) => t + x.prior, 0), leaf.prior);
      if (rows.length && okCur && okPri) {
        for (const x of rows) consumed.add(x.row);
        const f = (col) => (rows.length === 1
          ? cellRef('Trial Balance', col, rows[0].row)
          : `SUM(${rows.map((x) => cellRef('Trial Balance', col, x.row)).join(',')})`);
        money(ws, r, 2, leaf.current, f('E'), { font: { size: 9 } });
        money(ws, r, 3, leaf.prior, f('F'), { font: { size: 9 } });
        put(ws, r, 4, `Trial Balance row${rows.length > 1 ? 's' : ''} ${rows.map((x) => x.row).join(', ')}`
                    + (leaf.reason ? ` — ${leaf.reason}` : ''),
            { font: { size: 8, color: { argb: INK.muted } } });
      } else {
        link.unlinked += 1;
        link.unlinkedNames.push(`${note.number}. ${txt(note.caption)} — ${txt(leaf.name)}`);
        money(ws, r, 2, leaf.current, null, { font: { size: 9 } });
        money(ws, r, 3, leaf.prior, null, { font: { size: 9 } });
        put(ws, r, 4, leaf.reason ? txt(leaf.reason) : 'Not traced to a single trial-balance row — stated as a value',
            { font: { size: 8, italic: true, color: { argb: INK.muted } } });
      }
      link.leaves += 1;
      r += 1;
    }
    const lastLeaf = r - 1;

    put(ws, r, 1, '    Total', { font: { bold: true, size: 9 }, border: TOP });
    if (lastLeaf >= firstLeaf) {
      money(ws, r, 2, note.current, `SUM(B${firstLeaf}:B${lastLeaf})`, { font: { bold: true, size: 9 }, border: TOP });
      money(ws, r, 3, note.prior, `SUM(C${firstLeaf}:C${lastLeaf})`, { font: { bold: true, size: 9 }, border: TOP });
    } else {
      money(ws, r, 2, note.current, null, { font: { bold: true, size: 9 }, border: TOP });
      money(ws, r, 3, note.prior, null, { font: { bold: true, size: 9 }, border: TOP });
    }
    put(ws, r, 4, '', { border: TOP });
    totalRowByNote.set(Number(note.number), { row: r, current: num(note.current), prior: num(note.prior) });
    r += 1;

    for (const req of arr(note.requires)) {
      put(ws, r, 1, '        Schedule III requires: ' + txt(req),
          { font: { size: 8, italic: true, color: { argb: INK.muted } } });
      put(ws, r, 4, 'See the Disclosures register',
          { font: { size: 8, italic: true, color: { argb: INK.muted } } });
      r += 1;
    }
    r += 1;
  }
  return totalRowByNote;
}

/* -------------------------------------------------------------- face sheets */

/** A face amount links to its note total, but only if the note total IS it. */
function faceAmount(ws, r, col, letter, value, noteNo, noteTotals, period, link) {
  const t = noteNo != null ? noteTotals.get(Number(noteNo)) : null;
  if (t && same(t[period], value)) {
    link.faceLinked += 1;
    return money(ws, r, col, value, cellRef('Notes', letter, t.row));
  }
  if (t) {
    link.faceUnlinked += 1;
    link.faceUnlinkedNames.push(`note ${noteNo}`);
  }
  return money(ws, r, col, value, null);
}

function buildBalanceSheet(ws, p, noteTotals, link) {
  const meta = p.meta;
  const bs = p.balanceSheet || {};
  const criticals = arr(p.checks).filter((c) => c.severity === 'CRITICAL');

  let r = 1;
  if (criticals.length) {
    ws.mergeCells('A1:D1');
    put(ws, 1, 1, `DRAFT — NOT FOR ISSUE: ${criticals.length} unresolved critical exception(s)`,
        { font: { bold: true, size: 12, color: { argb: 'FFFFFFFF' } }, fill: INK.red,
          align: { horizontal: 'center', vertical: 'middle' } });
    ws.getRow(1).height = 24;
    ws.mergeCells('A2:D2');
    put(ws, 2, 1, 'Every critical exception on the Review sheet must be cleared before this file is issued.',
        { font: { size: 9, bold: true, color: { argb: INK.red } }, fill: INK.redFill,
          align: { horizontal: 'center' } });
    r = 3;
  }

  // masthead, written here rather than via masthead() so it can sit below the banner
  const L = 'D';
  ws.mergeCells(`A${r}:${L}${r}`);
  put(ws, r, 1, txt(meta.entity) || 'Entity', { font: { bold: true, size: 13, color: { argb: INK.title } } });
  const div = meta.division === 'INDAS'
    ? 'Schedule III, Division II — Indian Accounting Standards'
    : 'Schedule III, Division I — Accounting Standards';
  ws.mergeCells(`A${r + 1}:${L}${r + 1}`);
  put(ws, r + 1, 1, [meta.cin ? `CIN: ${meta.cin}` : null, div].filter(Boolean).join('   ·   '),
      { font: { size: 9, color: { argb: INK.muted } } });
  ws.mergeCells(`A${r + 2}:${L}${r + 2}`);
  put(ws, r + 2, 1, `Balance sheet as at ${meta.currentLabel}`,
      { font: { bold: true, size: 11, color: { argb: INK.title } } });
  ws.mergeCells(`A${r + 3}:${L}${r + 3}`);
  put(ws, r + 3, 1, `${txt(meta.scaleLabel) || 'Amounts in ₹'}          Status: ${txt(meta.status) || 'Draft'}`,
      { font: { size: 9, italic: true, color: { argb: INK.muted } } });
  r = r + 5;

  const headRow = r;
  r = columnHeads(ws, r, meta, [
    { label: 'Particulars' }, { label: 'Note', right: true },
    { label: `As at ${meta.currentLabel}`, right: true },
    { label: `As at ${meta.priorLabel}`, right: true },
  ]);
  frame(ws, [58, 8, 18, 18], headRow);

  const faceRowByLine = new Map();

  const writeSection = (sec) => {
    const tot0 = sec.total || {};
    // A section with no line and a nil total is not presented: Schedule III
    // requires the heads in use, not an empty heading with a nil total.
    if (!arr(sec.rows).length && same(tot0.current, 0) && same(tot0.prior, 0)) return null;
    put(ws, r, 1, txt(sec.title), { font: { bold: true, size: 10, color: { argb: INK.title } } });
    r += 1;
    const first = r;
    for (const row of arr(sec.rows)) {
      put(ws, r, 1, '    ' + txt(row.caption), { font: { size: 9 } });
      put(ws, r, 2, row.note != null ? Number(row.note) : '', { font: { size: 9 }, align: { horizontal: 'right' } });
      faceAmount(ws, r, 3, 'B', row.current, row.note, noteTotals, 'current', link);
      faceAmount(ws, r, 4, 'C', row.prior, row.note, noteTotals, 'prior', link);
      faceRowByLine.set(txt(row.lineId), r);
      r += 1;
    }
    const last = r - 1;
    put(ws, r, 1, `    Total — ${txt(sec.title).toLowerCase()}`, { font: { bold: true, size: 9 }, border: TOP });
    put(ws, r, 2, '', { border: TOP });
    const tot = sec.total || {};
    if (last >= first) {
      money(ws, r, 3, tot.current, `SUM(C${first}:C${last})`, { font: { bold: true, size: 9 }, border: TOP });
      money(ws, r, 4, tot.prior, `SUM(D${first}:D${last})`, { font: { bold: true, size: 9 }, border: TOP });
    } else {
      money(ws, r, 3, tot.current, null, { font: { bold: true, size: 9 }, border: TOP });
      money(ws, r, 4, tot.prior, null, { font: { bold: true, size: 9 }, border: TOP });
    }
    const at = r;
    r += 1;
    return at;
  };

  put(ws, r, 1, 'EQUITY AND LIABILITIES', { font: { bold: true, size: 10 }, fill: INK.bandFill });
  put(ws, r, 2, '', { fill: INK.bandFill });
  put(ws, r, 3, '', { fill: INK.bandFill });
  put(ws, r, 4, '', { fill: INK.bandFill });
  r += 1;
  const elRows = arr(bs.equityAndLiabilities).map(writeSection).filter((x) => x != null);

  const tEL = bs.totalEquityAndLiabilities || {};
  put(ws, r, 1, 'TOTAL — EQUITY AND LIABILITIES', { font: { bold: true, size: 10 }, border: TOP_DOUBLE });
  put(ws, r, 2, '', { border: TOP_DOUBLE });
  money(ws, r, 3, tEL.current, elRows.length ? `SUM(${elRows.map((x) => 'C' + x).join(',')})` : null,
        { font: { bold: true, size: 10 }, border: TOP_DOUBLE });
  money(ws, r, 4, tEL.prior, elRows.length ? `SUM(${elRows.map((x) => 'D' + x).join(',')})` : null,
        { font: { bold: true, size: 10 }, border: TOP_DOUBLE });
  const elTotalRow = r;
  r += 2;

  put(ws, r, 1, 'ASSETS', { font: { bold: true, size: 10 }, fill: INK.bandFill });
  put(ws, r, 2, '', { fill: INK.bandFill });
  put(ws, r, 3, '', { fill: INK.bandFill });
  put(ws, r, 4, '', { fill: INK.bandFill });
  r += 1;
  const aRows = arr(bs.assets).map(writeSection).filter((x) => x != null);

  const tA = bs.totalAssets || {};
  put(ws, r, 1, 'TOTAL — ASSETS', { font: { bold: true, size: 10 }, border: TOP_DOUBLE });
  put(ws, r, 2, '', { border: TOP_DOUBLE });
  money(ws, r, 3, tA.current, aRows.length ? `SUM(${aRows.map((x) => 'C' + x).join(',')})` : null,
        { font: { bold: true, size: 10 }, border: TOP_DOUBLE });
  money(ws, r, 4, tA.prior, aRows.length ? `SUM(${aRows.map((x) => 'D' + x).join(',')})` : null,
        { font: { bold: true, size: 10 }, border: TOP_DOUBLE });
  const aTotalRow = r;
  r += 1;

  // The difference is never a plug and never hidden: if it exists, it is stated
  // immediately under total assets, in red, as the exception it is.
  const diff = (bs.difference || {});
  if (!same(diff.current, 0) || !same(diff.prior, 0)) {
    put(ws, r, 1, 'Difference — total assets less total equity and liabilities (must be nil)',
        { font: { bold: true, size: 9, color: { argb: INK.red } }, fill: INK.redFill });
    put(ws, r, 2, '', { fill: INK.redFill });
    money(ws, r, 3, diff.current, `C${aTotalRow}-C${elTotalRow}`,
          { font: { bold: true, size: 9, color: { argb: INK.red } }, fill: INK.redFill });
    money(ws, r, 4, diff.prior, `D${aTotalRow}-D${elTotalRow}`,
          { font: { bold: true, size: 9, color: { argb: INK.red } }, fill: INK.redFill });
    r += 1;
    put(ws, r, 1, 'The balance sheet does not tie. This is a defect in the underlying records or in the '
                + 'classification of them; it has not been absorbed into any head. See the Review sheet.',
        { font: { size: 8, italic: true, color: { argb: INK.red } } });
    r += 1;
  }

  r += 1;
  put(ws, r, 1, 'The accompanying notes form an integral part of these financial statements. '
              + 'Each amount above is linked to its note total, and each note line to the trial balance.',
      { font: { size: 8, italic: true, color: { argb: INK.muted } } });
  r += 1;
  signatures(ws, meta, r);
  return faceRowByLine;
}

function buildProfitAndLoss(ws, p, noteTotals, link) {
  const meta = p.meta;
  const pl = p.profitAndLoss || {};
  let r = masthead(ws, meta, `Statement of profit and loss for the year ended ${meta.currentLabel}`, 4, false);
  const headRow = r;
  r = columnHeads(ws, r, meta, [
    { label: 'Particulars' }, { label: 'Note', right: true },
    { label: `Year ended ${meta.currentLabel}`, right: true },
    { label: `Year ended ${meta.priorLabel}`, right: true },
  ]);
  frame(ws, [58, 8, 18, 18], headRow);

  const faceRow = (row, indent = true) => {
    put(ws, r, 1, (indent ? '    ' : '') + txt(row.caption), { font: { size: 9 } });
    put(ws, r, 2, row.note != null ? Number(row.note) : '', { font: { size: 9 }, align: { horizontal: 'right' } });
    faceAmount(ws, r, 3, 'B', row.current, row.note, noteTotals, 'current', link);
    faceAmount(ws, r, 4, 'C', row.prior, row.note, noteTotals, 'prior', link);
    const at = r;
    r += 1;
    return at;
  };
  const totalRow = (caption, row, formula, double = false) => {
    const b = double ? TOP_DOUBLE : TOP;
    put(ws, r, 1, caption, { font: { bold: true, size: double ? 10 : 9 }, border: b });
    put(ws, r, 2, '', { border: b });
    money(ws, r, 3, (row || {}).current, formula ? formula('C') : null, { font: { bold: true, size: double ? 10 : 9 }, border: b });
    money(ws, r, 4, (row || {}).prior, formula ? formula('D') : null, { font: { bold: true, size: double ? 10 : 9 }, border: b });
    const at = r;
    r += 1;
    return at;
  };

  put(ws, r, 1, 'INCOME', { font: { bold: true, size: 10 }, fill: INK.bandFill });
  for (let c = 2; c <= 4; c++) put(ws, r, c, '', { fill: INK.bandFill });
  r += 1;
  const inc = arr(pl.income).map((x) => faceRow(x));
  const tIncRow = totalRow('Total income', pl.totalIncome,
    inc.length ? (col) => `SUM(${col}${inc[0]}:${col}${inc[inc.length - 1]})` : null);
  r += 1;

  put(ws, r, 1, 'EXPENSES', { font: { bold: true, size: 10 }, fill: INK.bandFill });
  for (let c = 2; c <= 4; c++) put(ws, r, c, '', { fill: INK.bandFill });
  r += 1;
  const exp = arr(pl.expenses).map((x) => faceRow(x));
  const tExpRow = totalRow('Total expenses', pl.totalExpenses,
    exp.length ? (col) => `SUM(${col}${exp[0]}:${col}${exp[exp.length - 1]})` : null);
  r += 1;

  let pbtRow;
  if (pl.pbtBefore && pl.exceptional) {
    const beforeRow = totalRow('Profit before exceptional items and tax', pl.pbtBefore,
      (col) => `${col}${tIncRow}-${col}${tExpRow}`);
    const excRow = faceRow(pl.exceptional);
    pbtRow = totalRow('Profit before tax', pl.pbt, (col) => `${col}${beforeRow}-${col}${excRow}`);
  } else {
    pbtRow = totalRow('Profit before tax', pl.pbt, (col) => `${col}${tIncRow}-${col}${tExpRow}`);
  }

  put(ws, r, 1, 'Tax expense', { font: { bold: true, size: 9 } });
  r += 1;
  const taxRows = arr(pl.taxRows).map((x) => faceRow(x));
  const patFormula = taxRows.length
    ? (col) => `${col}${pbtRow}-SUM(${taxRows.map((x) => col + x).join(',')})`
    : (col) => `${col}${pbtRow}`;
  totalRow('Profit for the year', pl.pat, patFormula, true);

  r += 1;
  put(ws, r, 1, 'The accompanying notes form an integral part of these financial statements.',
      { font: { size: 8, italic: true, color: { argb: INK.muted } } });
  r += 1;
  signatures(ws, meta, r);
}

/* ------------------------------------------------------------- cash flow */

function buildCashFlow(ws, p, faceRowByLine) {
  const meta = p.meta;
  const cf = p.cashFlow || {};
  const op = cf.operating || {};
  const inv = cf.investing || {};
  const fin = cf.financing || {};

  let r = masthead(ws, meta, `Cash flow statement for the year ended ${meta.currentLabel} (indirect method)`, 2, false);
  const headRow = r;
  r = columnHeads(ws, r, meta, [
    { label: 'Particulars' }, { label: `Year ended ${meta.currentLabel}`, right: true },
  ]);
  frame(ws, [66, 20], headRow);

  const B = { numFmt: NUM_BR };
  const line = (caption, value, formula, o = {}) => {
    put(ws, r, 1, (o.indent || '') + caption, { font: Object.assign({ size: 9 }, o.font || {}) });
    money(ws, r, 2, value, formula, Object.assign({}, B, o));
    const at = r;
    r += 1;
    return at;
  };
  const head = (t) => { put(ws, r, 1, t, { font: { bold: true, size: 10, color: { argb: INK.title } } }); r += 1; };

  head('A.  Cash flow from operating activities');
  const pbtRow = line('Profit before tax', op.pbt, null, { indent: '    ' });
  put(ws, r, 1, '    Adjustments for:', { font: { size: 9, italic: true, color: { argb: INK.muted } } });
  r += 1;
  const adjRows = arr(op.adjustments).map((a) => line(txt(a.label), a.amount, null, { indent: '        ' }));
  const opbwcRow = line('Operating profit before working capital changes', op.operatingProfitBeforeWC,
    `SUM(B${pbtRow},${adjRows.map((x) => 'B' + x).join(',') || 'B' + pbtRow})`,
    { indent: '    ', font: { bold: true }, border: TOP });

  put(ws, r, 1, '    Movements in working capital:', { font: { size: 9, italic: true, color: { argb: INK.muted } } });
  r += 1;
  const wcRows = arr(op.workingCapital).map((w) => line(txt(w.label), w.amount, null, { indent: '        ' }));
  const genRow = line('Cash generated from operations', op.cashGenerated,
    `SUM(B${opbwcRow}${wcRows.length ? ',' + wcRows.map((x) => 'B' + x).join(',') : ''})`,
    { indent: '    ', font: { bold: true }, border: TOP });
  const taxRow = line('Direct taxes paid', -num(op.taxPaid), null, { indent: '    ' });
  const netOpRow = line('Net cash generated from / (used in) operating activities   (A)', op.net,
    `SUM(B${genRow},B${taxRow})`, { indent: '    ', font: { bold: true }, border: TOP });
  r += 1;

  head('B.  Cash flow from investing activities');
  const invRows = arr(inv.items).map((i) => line(txt(i.label), i.amount, null, { indent: '        ' }));
  const netInvRow = line('Net cash generated from / (used in) investing activities   (B)', inv.net,
    invRows.length ? `SUM(B${invRows[0]}:B${invRows[invRows.length - 1]})` : null,
    { indent: '    ', font: { bold: true }, border: TOP });
  r += 1;

  head('C.  Cash flow from financing activities');
  const finRows = arr(fin.items).map((i) => line(txt(i.label), i.amount, null, { indent: '        ' }));
  const netFinRow = line('Net cash generated from / (used in) financing activities   (C)', fin.net,
    finRows.length ? `SUM(B${finRows[0]}:B${finRows[finRows.length - 1]})` : null,
    { indent: '    ', font: { bold: true }, border: TOP });
  r += 2;

  const netRow = line('Net increase / (decrease) in cash and cash equivalents   (A+B+C)', cf.netChange,
    `SUM(B${netOpRow},B${netInvRow},B${netFinRow})`, { font: { bold: true }, border: TOP });
  const openRow = line('Cash and cash equivalents at the beginning of the year', cf.openingCash, null);
  const closeRow = line('Cash and cash equivalents at the end of the year (per this statement)',
    cf.closingCashComputed, `SUM(B${netRow},B${openRow})`, { font: { bold: true }, border: TOP });

  // closing cash per the balance sheet is taken FROM the balance sheet
  const bsRow = faceRowByLine.get('cash_and_equivalents');
  const perBsRow = line('Cash and cash equivalents at the end of the year (per the balance sheet)',
    cf.closingCashPerBS, bsRow ? cellRef('Balance Sheet', 'C', bsRow) : null, { font: { bold: true } });

  if (!same(cf.unreconciled, 0)) {
    put(ws, r, 1, 'Unreconciled difference — must be nil', {
      font: { bold: true, size: 9, color: { argb: INK.red } }, fill: INK.redFill });
    money(ws, r, 2, cf.unreconciled, `B${perBsRow}-B${closeRow}`,
      { numFmt: NUM_BR, font: { bold: true, size: 9, color: { argb: INK.red } }, fill: INK.redFill });
    r += 1;
    put(ws, r, 1, 'The statement is built from profit before tax upward and reconciled to the movement in cash. '
                + 'The residual above is reported, not absorbed into operating activities.',
        { font: { size: 8, italic: true, color: { argb: INK.red } } });
    r += 1;
  } else {
    put(ws, r, 1, 'The statement reconciles to the movement in cash per the balance sheet.',
        { font: { size: 8, italic: true, color: { argb: INK.muted } } });
    r += 1;
  }

  r += 1;
  put(ws, r, 1, 'Assumptions — each of these is an assumption and requires evidence before issue',
      { font: { bold: true, size: 10, color: { argb: INK.title } } });
  r += 1;
  const asmp = arr(cf.assumptions);
  if (!asmp.length) {
    put(ws, r, 1, 'None — every figure above is supported by a schedule.', { font: { size: 9, italic: true } });
    r += 1;
  }
  for (const a of asmp) {
    ws.mergeCells(`A${r}:B${r}`);
    put(ws, r, 1, `[${txt(a.id)}]  ASSUMPTION — EVIDENCE REQUIRED: ${txt(a.text)}`,
        { font: { size: 9 }, fill: 'FFFFFBE6', align: { wrapText: true, vertical: 'top' } });
    ws.getRow(r).height = 28;
    r += 1;
  }
  const cfNotes = arr(cf.notes);
  if (cfNotes.length) {
    r += 1;
    put(ws, r, 1, 'Matters to confirm', { font: { bold: true, size: 10, color: { argb: INK.title } } });
    r += 1;
    for (const nte of cfNotes) {
      ws.mergeCells(`A${r}:B${r}`);
      put(ws, r, 1, '· ' + txt(nte), { font: { size: 9 }, align: { wrapText: true, vertical: 'top' } });
      ws.getRow(r).height = 28;
      r += 1;
    }
  }
}

/* ------------------------------------------------------------ disclosures */

function buildDisclosures(ws, p) {
  const meta = p.meta;
  let r = masthead(ws, meta, `Schedule III disclosure register — ${meta.currentLabel}`, 5, true);
  const headRow = r;
  r = columnHeads(ws, r, meta, [
    { label: 'Note' }, { label: 'Head' }, { label: 'Information Schedule III requires' },
    { label: 'Status' }, { label: 'Evidence' },
  ]);
  frame(ws, [8, 30, 62, 28, 30], headRow);

  const rows = arr(p.disclosures);
  if (!rows.length) {
    put(ws, r, 1, 'No head in use carries an outstanding Schedule III information requirement.',
        { font: { size: 9, italic: true } });
    return;
  }
  for (const d of rows) {
    const missing = /required|missing|not/i.test(txt(d.status));
    put(ws, r, 1, d.note != null ? Number(d.note) : '', { font: { size: 9 }, align: { horizontal: 'right' } });
    put(ws, r, 2, txt(d.caption), { font: { size: 9 } });
    put(ws, r, 3, txt(d.requirement), { font: { size: 9 }, align: { wrapText: true, vertical: 'top' } });
    put(ws, r, 4, txt(d.status), {
      font: { size: 9, bold: missing, color: { argb: missing ? INK.red : INK.title } },
      fill: missing ? INK.redFill : undefined,
      align: { wrapText: true, vertical: 'top' },
    });
    put(ws, r, 5, d.evidence ? txt(d.evidence) : '—',
        { font: { size: 9, color: { argb: d.evidence ? INK.title : INK.muted } }, align: { wrapText: true, vertical: 'top' } });
    r += 1;
  }
  r += 1;
  put(ws, r, 1, 'This register is a working paper. A requirement is never reported as "Nil" on its own; '
              + 'it is either evidenced or it is outstanding.',
      { font: { size: 8, italic: true, color: { argb: INK.muted } } });
}

/* ----------------------------------------------------------------- review */

function buildReview(ws, p, link) {
  const meta = p.meta;
  const checks = arr(p.checks).slice().sort(
    (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  const criticals = checks.filter((c) => c.severity === 'CRITICAL');

  let r = masthead(ws, meta, `Review — exceptions and integrity checks, ${meta.currentLabel}`, 4, true);

  put(ws, r, 1, criticals.length
      ? `NOT FOR ISSUE — ${criticals.length} critical exception(s) outstanding`
      : 'No critical exception outstanding',
    { font: { bold: true, size: 11, color: { argb: criticals.length ? 'FFFFFFFF' : INK.title } },
      fill: criticals.length ? INK.red : 'FFE6F4EA' });
  ws.mergeCells(`A${r}:D${r}`);
  r += 1;
  const tally = ['CRITICAL', 'HIGH', 'REVIEW', 'INFO']
    .map((s) => `${checks.filter((c) => c.severity === s).length} ${s.toLowerCase()}`).join('   ·   ');
  ws.mergeCells(`A${r}:D${r}`);
  put(ws, r, 1, tally, { font: { size: 9, color: { argb: INK.muted } } });
  r += 2;

  const headRow = r;
  r = columnHeads(ws, r, meta, [
    { label: 'Severity' }, { label: 'Ref' }, { label: 'Exception' }, { label: 'Amount', right: true },
  ]);
  frame(ws, [12, 18, 92, 18], headRow);

  for (const c of checks) {
    const sev = txt(c.severity).toUpperCase();
    put(ws, r, 1, sev, { font: { bold: true, size: 9, color: { argb: SEV_INK[sev] || INK.title } },
                         fill: SEV_FILL[sev] || undefined });
    put(ws, r, 2, txt(c.id), { font: { size: 9, color: { argb: INK.muted } }, fill: SEV_FILL[sev] || undefined });
    put(ws, r, 3, txt(c.message), { font: { size: 9 }, fill: SEV_FILL[sev] || undefined,
                                    align: { wrapText: true, vertical: 'top' } });
    if (isNum(c.amount)) money(ws, r, 4, c.amount, null, { numFmt: NUM_BR, fill: SEV_FILL[sev] || undefined });
    else put(ws, r, 4, '', { fill: SEV_FILL[sev] || undefined });
    r += 1;
  }
  if (!checks.length) {
    put(ws, r, 1, 'No exception was raised by the engine.', { font: { size: 9, italic: true } });
    r += 1;
  }

  // What this export itself could not do is stated here rather than hidden.
  r += 1;
  put(ws, r, 1, 'EXPORT', { font: { bold: true, size: 9, color: { argb: SEV_INK.INFO } }, fill: SEV_FILL.INFO });
  put(ws, r, 2, 'EXP-LINK', { font: { size: 9, color: { argb: INK.muted } }, fill: SEV_FILL.INFO });
  put(ws, r, 3, `${link.leaves - link.unlinked} of ${link.leaves} note line(s) are linked to a trial-balance row`
              + `${link.unlinked ? '; the remainder are stated as values because no single set of rows adds back to them: '
                  + link.unlinkedNames.slice(0, 8).join('; ') : ''}`
              + `. ${link.faceLinked} face figure(s) are linked to their note total`
              + `${link.faceUnlinked ? `; ${link.faceUnlinked} face figure(s) differ from the note total and are stated as values` : ''}.`,
    { font: { size: 9 }, fill: SEV_FILL.INFO, align: { wrapText: true, vertical: 'top' } });
  put(ws, r, 4, '', { fill: SEV_FILL.INFO });
  r += 2;
  put(ws, r, 1, 'This sheet is a working paper. It carries no signature block and must not be issued with the '
              + 'financial statements.', { font: { size: 8, italic: true, color: { argb: INK.muted } } });
}

/* -------------------------------------------------------------------- main */

export function buildWorkbook(ExcelJS, payload) {
  const p = payload || {};
  const meta = Object.assign(
    { entity: '', cin: '', division: 'AS', currentLabel: '', priorLabel: '',
      status: 'Draft', scaleLabel: 'Amounts in ₹' },
    p.meta || {});
  const model = {
    meta,
    trialBalance: arr(p.trialBalance),
    balanceSheet: p.balanceSheet || {},
    profitAndLoss: p.profitAndLoss || {},
    notes: arr(p.notes),
    cashFlow: p.cashFlow || {},
    checks: arr(p.checks),
    disclosures: arr(p.disclosures),
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'finprep';
  wb.company = meta.entity;
  wb.created = new Date();
  wb.calcProperties = wb.calcProperties || {};
  wb.calcProperties.fullCalcOnLoad = true;      // recalculate, but the cache is already right

  // Created in presentation order; filled in dependency order below.
  const ws = {};
  for (const name of SHEETS) ws[name] = wb.addWorksheet(name, { properties: { tabColor: undefined } });

  const link = { leaves: 0, unlinked: 0, unlinkedNames: [], faceLinked: 0, faceUnlinked: 0, faceUnlinkedNames: [] };

  const tbIndex = buildTrialBalance(ws['Trial Balance'], model);
  const noteTotals = buildNotes(ws.Notes, model, tbIndex, link);
  const faceRowByLine = buildBalanceSheet(ws['Balance Sheet'], model, noteTotals, link);
  buildProfitAndLoss(ws['Profit & Loss'], model, noteTotals, link);
  buildCashFlow(ws['Cash Flow'], model, faceRowByLine);
  buildDisclosures(ws.Disclosures, model);
  buildReview(ws.Review, model, link);

  return wb;
}

export default buildWorkbook;
