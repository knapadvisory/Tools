/* ============================================================================
 * pdf.js — the financial statements as a PDF, from the same payload as Excel
 *
 * Balance sheet, statement of profit and loss, the owners' capital accounts
 * (non-corporate entities), then the notes, each note headed with both period
 * dates. A4 portrait, Helvetica, amounts in rupees to two decimals with Indian
 * grouping, negatives in brackets. A DRAFT watermark on every page while a
 * critical exception stands. The signatories sign at the foot of each face:
 * the auditor on the left, the board or the owners on the right.
 *
 * pdf-lib's standard fonts are WinAnsi, which has no rupee sign — amounts are
 * headed "Amount (Rs.)" rather than risk a missing glyph — and no Devanagari;
 * a name the font cannot draw falls back character by character to "?", so
 * the statement is still produced and the odd glyph is visible, never silent.
 *
 * API:  buildPdf(PDFLib, payload) -> Promise<Uint8Array>
 *       PDFLib is injected (window.PDFLib in the browser, the UMD build in Node).
 * ==========================================================================*/

const A4 = [595.28, 841.89];
const M = { left: 48, right: 48, top: 54, bottom: 56 };
const INK = { title: [0.10, 0.17, 0.27], text: [0.08, 0.10, 0.12], muted: [0.36, 0.42, 0.50], rule: [0.73, 0.76, 0.81], red: [0.69, 0, 0.13], band: [0.94, 0.95, 0.97] };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (isNum(v) ? Math.round(v * 100) / 100 : 0);
const txt = (v) => (v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);

/** 12,34,567.89 — negatives in brackets, nil as "-" */
export function inr(v) {
  const n = num(v);
  if (n === 0) return '-';
  const a = Math.abs(n).toFixed(2);
  const [ip, dp] = a.split('.');
  const last3 = ip.slice(-3), rest = ip.slice(0, -3);
  const grouped = (rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + last3;
  const s = grouped + '.' + dp;
  return n < 0 ? `(${s})` : s;
}

/** Characters WinAnsi cannot show become "?" rather than throwing. */
function safe(font, s) {
  let out = '';
  for (const ch of txt(s)) {
    try { font.encodeText(ch); out += ch; } catch { out += '?'; }
  }
  return out;
}

export async function buildPdf(PDFLib, payload) {
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  const p = payload || {};
  const meta = Object.assign({ entity: '', division: 'AS', currentLabel: '', priorLabel: '', scaleLabel: 'Amounts in Rs.', status: 'Draft' }, p.meta || {});
  const criticals = arr(p.checks).filter((c) => c.severity === 'CRITICAL');
  const doc = await PDFDocument.create();
  doc.setTitle(`${meta.entity} — financial statements ${meta.currentLabel}`);
  doc.setCreator('KNAP finprep');
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const FB = await doc.embedFont(StandardFonts.HelveticaBold);
  const FI = await doc.embedFont(StandardFonts.HelveticaOblique);
  const color = (c) => rgb(c[0], c[1], c[2]);
  const framework = meta.framework || (meta.division === 'NCE' ? 'ICAI Guidance Note on Financial Statements of Non-Corporate Entities'
    : meta.division === 'INDAS' ? 'Schedule III, Division II - Indian Accounting Standards' : 'Schedule III, Division I - Accounting Standards');
  const identity = [meta.cin ? `CIN: ${meta.cin}` : (meta.pan ? `PAN: ${meta.pan}` : ''), meta.division === 'NCE' ? meta.constitutionLabel : '', framework].filter(Boolean).join('   |   ');
  const scale = txt(meta.scaleLabel).replace(/₹/g, 'Rs.');

  /* ---- a page with a running head, a foot and the draft mark ---- */
  const pages = [];
  let pg = null, y = 0, section = '';
  const W = A4[0], H = A4[1];
  const text = (s, x, yy, size, font = F, c = INK.text, opts = {}) => {
    const str = safe(font, s);
    let x0 = x;
    if (opts.right) x0 = x - font.widthOfTextAtSize(str, size);
    if (opts.center) x0 = x - font.widthOfTextAtSize(str, size) / 2;
    pg.drawText(str, { x: x0, y: yy, size, font, color: color(c) });
    return font.widthOfTextAtSize(str, size);
  };
  const rule = (x1, x2, yy, c = INK.rule, w = 0.6) => pg.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness: w, color: color(c) });
  const newPage = (title) => {
    pg = doc.addPage(A4); pages.push(pg);
    section = title || section;
    // running head
    text(meta.entity || 'Entity', M.left, H - 30, 9, FB, INK.title);
    text(section, W - M.right, H - 30, 9, F, INK.muted, { right: true });
    rule(M.left, W - M.right, H - 36);
    y = H - M.top - 6;
    if (criticals.length) {
      pg.drawText('DRAFT - NOT FOR ISSUE', { x: 110, y: 330, size: 54, font: FB, color: color([0.86, 0.80, 0.80]), rotate: degrees(35), opacity: 0.35 });
    }
  };
  const need = (h) => { if (y - h < M.bottom) newPage(); };
  const masthead = (title, sub) => {
    text(meta.entity || 'Entity', M.left, y, 15, FB, INK.title); y -= 14;
    text(identity, M.left, y, 8, F, INK.muted); y -= 16;
    text(title, M.left, y, 12, FB, INK.title); y -= 13;
    text(`${scale}     Status: ${meta.status}${sub ? '     ' + sub : ''}`, M.left, y, 8, FI, INK.muted); y -= 16;
  };
  /* ---- a two-period table: caption | note | current | prior ---- */
  const COLS = { note: 348, cur: 450, pri: 547 };
  const heads2 = (c1, c2) => {
    need(26);
    pg.drawRectangle({ x: M.left, y: y - 5, width: W - M.left - M.right, height: 16, color: color(INK.band) });
    text('Particulars', M.left + 4, y, 8.5, FB, INK.title);
    text('Note', COLS.note, y, 8.5, FB, INK.title, { right: true });
    text(c1, COLS.cur, y, 8.5, FB, INK.title, { right: true });
    text(c2, COLS.pri, y, 8.5, FB, INK.title, { right: true });
    y -= 18;
  };
  const row2 = (caption, note, cur, pri, o = {}) => {
    need(14);
    const font = o.bold ? FB : F;
    if (o.top) rule(M.left, W - M.right, y + 10, INK.rule);
    text((o.indent ? '    ' : '') + caption, M.left + 4, y, o.size || 9, font, o.color || INK.text);
    if (note != null && note !== '') text(String(note), COLS.note, y, 8.5, F, INK.muted, { right: true });
    if (cur !== undefined) text(inr(cur), COLS.cur, y, o.size || 9, font, o.color || INK.text, { right: true });
    if (pri !== undefined) text(inr(pri), COLS.pri, y, o.size || 9, font, o.color || INK.text, { right: true });
    if (o.double) { rule(COLS.cur - 90, W - M.right, y - 3, INK.title, 0.6); rule(COLS.cur - 90, W - M.right, y - 5, INK.title, 0.6); }
    y -= o.gap || 13;
  };
  const band = (label) => { need(18); text(label, M.left, y, 9.5, FB, INK.title); y -= 15; };
  const note8 = (s, c = INK.muted) => { need(12); text(s, M.left + 4, y, 7.5, FI, c); y -= 11; };

  /* ---- signatures ---- */
  const signatures = () => {
    need(110);
    y -= 10;
    const a = meta.auditor || {};
    const nce = meta.division === 'NCE';
    const owners = arr(meta.owners);
    const signers = nce
      ? (owners.length ? owners.map((o) => ({ name: o.name, role: o.role || meta.ownerRole || 'Partner', id: o.pan ? `PAN ${o.pan}` : '' }))
                       : [{ name: '', role: meta.ownerRole || 'Partner', id: '' }, { name: '', role: meta.ownerRole || 'Partner', id: '' }])
      : (arr(meta.directors).length ? arr(meta.directors) : [{ name: '', din: '' }, { name: '', din: '' }]).map((d) => ({ name: d.name, role: 'Director', id: `DIN ${d.din || '__________'}` }));
    const xL = M.left, xR = 310;
    text(`For ${a.firm || '________________________'}`, xL, y, 9, FB); text(nce ? `For ${meta.entity}` : 'For and on behalf of the Board of Directors', xR, y, 9, FB); y -= 12;
    text('Chartered Accountants', xL, y, 8.5); text(nce ? txt(meta.constitutionLabel) : txt(meta.entity), xR, y, 8.5); y -= 11;
    text(`Firm registration no. ${a.frn || '____________'}`, xL, y, 8, F, INK.muted); y -= 30;
    text(a.partner || '________________________', xL, y, 8.5);
    const rows = []; for (let i = 0; i < signers.length; i += 2) rows.push(signers.slice(i, i + 2));
    let yy = y;
    for (const pair of rows) {
      pair.forEach((s, j) => { text(s.name || '________________________', xR + j * 130, yy, 8.5); text(s.role, xR + j * 130, yy - 10, 7.5, F, INK.muted); if (s.id) text(s.id, xR + j * 130, yy - 19, 7.5, F, INK.muted); });
      yy -= 32;
    }
    y -= 10; text('Partner', xL, y, 7.5, F, INK.muted); y -= 9; text(`Membership no. ${a.membership || '__________'}`, xL, y, 7.5, F, INK.muted);
    y = Math.min(y, yy) - 14;
    text(`Place: ${meta.place || '____________'}`, xL, y, 8.5); text(`Place: ${meta.place || '____________'}`, xR, y, 8.5); y -= 11;
    text(`Date: ${meta.signedOn || meta.date || '____________'}`, xL, y, 8.5); text(`Date: ${meta.signedOn || meta.date || '____________'}`, xR, y, 8.5); y -= 14;
  };

  /* ================= Balance sheet ================= */
  const bs = p.balanceSheet || {};
  newPage('Balance sheet');
  if (criticals.length) { pg.drawRectangle({ x: M.left, y: y - 4, width: W - M.left - M.right, height: 16, color: color(INK.red) }); text(`DRAFT - NOT FOR ISSUE: ${criticals.length} unresolved critical exception(s)`, W / 2, y, 9, FB, [1, 1, 1], { center: true }); y -= 22; }
  masthead(`Balance sheet as at ${meta.currentLabel}`);
  heads2(`As at ${meta.currentLabel}`, `As at ${meta.priorLabel}`);
  const sectionBlock = (sec) => {
    const tot = sec.total || {};
    if (!arr(sec.rows).length && num(tot.current) === 0 && num(tot.prior) === 0) return;
    row2(sec.title, '', undefined, undefined, { bold: true, size: 9 });
    for (const r of arr(sec.rows)) row2(r.caption, r.note, r.current, r.prior, { indent: true });
    row2(`Total - ${txt(sec.title).toLowerCase()}`, '', tot.current, tot.prior, { bold: true, top: true, indent: true, gap: 16 });
  };
  band('EQUITY AND LIABILITIES');
  arr(bs.equityAndLiabilities).forEach(sectionBlock);
  const tEL = bs.totalEquityAndLiabilities || {};
  row2('TOTAL - EQUITY AND LIABILITIES', '', tEL.current, tEL.prior, { bold: true, top: true, double: true, gap: 20 });
  band('ASSETS');
  arr(bs.assets).forEach(sectionBlock);
  const tA = bs.totalAssets || {};
  row2('TOTAL - ASSETS', '', tA.current, tA.prior, { bold: true, top: true, double: true, gap: 18 });
  const diff = bs.difference || {};
  if (num(diff.current) !== 0 || num(diff.prior) !== 0) {
    row2('Difference - total assets less total equity and liabilities (must be nil)', '', diff.current, diff.prior, { bold: true, color: INK.red });
    note8('The balance sheet does not tie. The difference is stated, not absorbed into any head.', INK.red);
  }
  note8('The accompanying notes form an integral part of these financial statements.');
  signatures();

  /* ================= Profit and loss ================= */
  const pl = p.profitAndLoss || {};
  newPage('Statement of profit and loss');
  masthead(`Statement of profit and loss for the year ended ${meta.currentLabel}`);
  heads2(`Year ended ${meta.currentLabel}`, `Year ended ${meta.priorLabel}`);
  band('INCOME');
  arr(pl.income).forEach((r) => row2(r.caption, r.note, r.current, r.prior, { indent: true }));
  row2('Total income', '', (pl.totalIncome || {}).current, (pl.totalIncome || {}).prior, { bold: true, top: true, gap: 16 });
  band('EXPENSES');
  arr(pl.expenses).forEach((r) => row2(r.caption, r.note, r.current, r.prior, { indent: true }));
  row2('Total expenses', '', (pl.totalExpenses || {}).current, (pl.totalExpenses || {}).prior, { bold: true, top: true, gap: 16 });
  if (pl.pbtBefore && pl.exceptional) {
    row2(pl.pbtBefore.caption, '', pl.pbtBefore.current, pl.pbtBefore.prior, { bold: true });
    row2(pl.exceptional.caption, pl.exceptional.note, pl.exceptional.current, pl.exceptional.prior, { indent: true });
  }
  row2('Profit before tax', '', (pl.pbt || {}).current, (pl.pbt || {}).prior, { bold: true, top: true });
  if (arr(pl.taxRows).length) { row2('Tax expense', '', undefined, undefined, { bold: true, size: 8.5 }); arr(pl.taxRows).forEach((r) => row2(r.caption, r.note, r.current, r.prior, { indent: true })); }
  row2((pl.pat && pl.pat.caption) || 'Profit for the year', '', (pl.pat || {}).current, (pl.pat || {}).prior, { bold: true, top: true, double: true, gap: 18 });
  note8('The accompanying notes form an integral part of these financial statements.');
  signatures();

  /* ================= Owners' accounts (non-corporate) ================= */
  const oa = p.ownersAccounts;
  if (oa && (oa.capital || oa.current)) {
    const label = txt(meta.ownersLabel) || 'Owners';
    newPage(`${label}' accounts`);
    masthead(`${label}' accounts for the year ended ${meta.currentLabel}`);
    for (const key of ['capital', 'current']) {
      const s = oa[key]; if (!s) continue;
      const owners = arr(s.owners), hasUn = arr(s.unallocated).length > 0;
      const colsN = owners.length + (hasUn ? 1 : 0) + 1;
      const x0 = 190, width = (W - M.right - x0) / colsN;
      need(40);
      pg.drawRectangle({ x: M.left, y: y - 5, width: W - M.left - M.right, height: 26, color: color(INK.band) });
      text(key === 'capital' ? `${label}' capital accounts` : `${label}' current accounts`, M.left + 4, y + 4, 8.5, FB, INK.title);
      const colX = (i) => x0 + width * (i + 1) - 4;
      owners.forEach((o, i) => { text(o.name, colX(i), y + 6, 7.5, FB, INK.title, { right: true }); if (o.ratio) text(`ratio ${o.ratio}`, colX(i), y - 3, 6.5, F, INK.muted, { right: true }); });
      if (hasUn) { text('Unallocated', colX(owners.length), y + 6, 7.5, FB, INK.title, { right: true }); text(`${s.unallocated.length} ledger(s)`, colX(owners.length), y - 3, 6.5, F, INK.muted, { right: true }); }
      text('Total', colX(colsN - 1), y + 6, 7.5, FB, INK.title, { right: true });
      y -= 28;
      for (const r of arr(s.rows)) {
        const bold = r.key === 'opening' || r.key === 'closing';
        need(13);
        if (r.key === 'closing') rule(x0, W - M.right, y + 10);
        text((bold ? '' : '    ') + r.caption, M.left + 4, y, 8.5, bold ? FB : F);
        owners.forEach((o, i) => text(inr((r.byOwner || {})[o.id] || 0), colX(i), y, 8.5, bold ? FB : F, INK.text, { right: true }));
        if (hasUn) text(inr(r.unallocated || 0), colX(owners.length), y, 8.5, bold ? FB : F, INK.text, { right: true });
        text(inr(r.total || 0), colX(colsN - 1), y, 8.5, bold ? FB : F, INK.text, { right: true });
        y -= 12;
      }
      y -= 4;
      if (s.profitTo) note8(`Share of profit ${txt(s.shareBasis || 'by profit-sharing ratio')}; the parts add back exactly to the profit for the year.`);
      const noGross = owners.filter((o) => !o.hasGross).map((o) => o.name);
      if (noGross.length) note8(`Capital introduced and drawings are shown net for ${noGross.join(', ')} - gross movements were not supplied.`);
      const cred = owners.filter((o) => o.credited).map((o) => o.name);
      if (cred.length) note8(`Remuneration and interest for ${cred.join(', ')} are shown as credited to the account (the account received at least that much in credits).`);
      if (hasUn) note8(`Unallocated: ${s.unallocated.join('; ')}.`);
      y -= 10;
    }
  }

  /* ================= PPE schedule ================= */
  const ppe = p.ppe;
  if (ppe && arr(ppe.rows).length) {
    newPage('Property, plant and equipment');
    masthead(`Property, plant and equipment - schedule for the year ended ${meta.currentLabel}`);
    const cols = [152, 222, 292, 362, 437, 547];      // right edges: opening, additions, deductions, depreciation, closing, personal
    need(30);
    pg.drawRectangle({ x: M.left, y: y - 5, width: W - M.left - M.right, height: 26, color: color(INK.band) });
    text('Asset', M.left + 4, y + 4, 7.5, FB, INK.title);
    [['Opening', meta.priorLabel], ['Additions', ''], ['Deductions', ''], ['Depreciation', ''], ['Closing', meta.currentLabel], ['Personal-use', 'depreciation']].forEach(([a, b], i) => {
      text(a, cols[i], y + 6, 7, FB, INK.title, { right: true }); if (b) text(b, cols[i], y - 3, 6, F, INK.muted, { right: true });
    });
    y -= 28;
    const line = (label, vals, o = {}) => {
      need(12);
      if (o.top) rule(M.left, W - M.right, y + 9);
      text(label, M.left + 4, y, 7.5, o.bold ? FB : F);
      vals.forEach((v, i) => text(inr(v), cols[i], y, 7.5, o.bold ? FB : F, INK.text, { right: true }));
      y -= 11;
    };
    for (const x of arr(ppe.rows)) line(x.ledger, [x.opening, x.additions, x.deductions, x.depreciation, x.closing, x.personalUse]);
    const t = ppe.totals || {};
    line('Total', [t.opening, t.additions, t.deductions, t.depreciation, t.closing, t.personalUse], { bold: true, top: true });
    y -= 4;
    for (const x of arr(ppe.rows)) note8(`${x.ledger}: depreciation ${x.depBasis}; ${x.splitBasis}.`);
    for (const nte of arr(ppe.notes)) note8(nte);
    for (const c of arr(ppe.checks)) note8(`${c.severity}: ${c.message}`, INK.red);
  }

  /* ================= Notes ================= */
  newPage('Notes to the financial statements');
  masthead(`Notes forming part of the financial statements for the year ended ${meta.currentLabel}`);
  const policies = txt(p.policies || (p.text && p.text.policies) || '').trim();
  if (policies) {
    band('Significant accounting policies');
    for (const para of policies.split(/\n+/)) {
      for (const line of wrap(F, para, 8.5, W - M.left - M.right - 8)) { need(12); text(line, M.left + 4, y, 8.5); y -= 11; }
      y -= 4;
    }
    y -= 6;
  }
  for (const n of arr(p.notes)) {
    need(60);
    pg.drawRectangle({ x: M.left, y: y - 5, width: W - M.left - M.right, height: 16, color: color(INK.band) });
    text(`${n.number}.  ${n.caption}`, M.left + 4, y, 9, FB, INK.title);
    text(meta.currentLabel, COLS.cur, y, 8, FB, INK.title, { right: true });
    text(meta.priorLabel, COLS.pri, y, 8, FB, INK.title, { right: true });
    y -= 18;
    for (const s of arr(n.subLines)) {
      row2(s.name, '', s.current, s.prior, { indent: true, gap: 12 });
      if (arr(s.members).length > 1) {
        for (const line of wrap(FI, s.members.map((m) => m.name).join('; '), 7, W - M.left - M.right - 30)) { need(10); text(line, M.left + 26, y, 7, FI, INK.muted); y -= 9; }
        y -= 2;
      }
    }
    row2('Total', '', n.current, n.prior, { bold: true, top: true, indent: true, gap: 14 });
    if (n.kind === 'owners' && n.schedule) note8(`The owner-wise statement of this account is on the page "${txt(meta.ownersLabel) || 'Owners'}' accounts".`);
    if (n.kind === 'ppe' && n.schedule) note8('The asset-wise schedule is on the page "Property, plant and equipment".');
    if (n.msme && n.msme.provided) {
      need(14); text('Dues to micro and small enterprises (MSMED Act, s.22):', M.left + 4, y, 8, FB); y -= 11;
      for (const x of arr(n.msme.rows)) {
        if (x.amount == null) continue;
        const lines = wrap(F, x.label, 7.5, COLS.cur - 120 - M.left);
        lines.forEach((line, i) => { need(10); text(line, M.left + 12, y, 7.5); if (i === 0) text(inr(x.amount), COLS.cur, y, 7.5, F, INK.text, { right: true }); y -= 9; });
      }
      y -= 3;
    }
    const fn = txt(n.footnote || '').trim();
    if (fn) { for (const line of wrap(FI, fn, 7.5, W - M.left - M.right - 8)) { need(11); text(line, M.left + 4, y, 7.5, FI, INK.muted); y -= 10; } }
    y -= 8;
  }
  if (!arr(p.notes).length) note8('No notes.');

  /* ---- page numbers ---- */
  pages.forEach((page, i) => {
    page.drawText(`Page ${i + 1} of ${pages.length}`, { x: W - M.right - 60, y: 28, size: 7.5, font: F, color: color(INK.muted) });
    page.drawText(safe(F, `${meta.entity} - ${meta.currentLabel}`), { x: M.left, y: 28, size: 7.5, font: F, color: color(INK.muted) });
  });
  return doc.save();
}

/** Greedy word wrap for a font and size. */
export function wrap(font, s, size, maxWidth) {
  const words = txt(s).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  const w = (t) => { try { return font.widthOfTextAtSize(t, size); } catch { return t.length * size * 0.5; } };
  for (const word of words) {
    const t = cur ? cur + ' ' + word : word;
    if (w(t) <= maxWidth || !cur) cur = t; else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

export default buildPdf;
