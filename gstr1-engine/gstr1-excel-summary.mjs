#!/usr/bin/env node
// GSTR-1 PDF/JSON → Excel summary — standalone, single file, zero dependencies.
// ---------------------------------------------------------------------------
// Runs entirely on this computer. The files never leave this machine — nothing
// is sent to any server or cloud.
//
// WHAT IT DOES
//   Reads FORM GSTR-1 files downloaded from the GST portal — the PDF and/or
//   the JSON (Returns → GSTR-1 → Download → JSON) — and builds an
//   "As Per GSTR1" summary table, one row per month:
//
//     Month | B2B | B2C | Export | IGST | CGST | SGST
//
//   JSON files additionally get SECTION-WISE bill sheets covering all the
//   uploaded months — B2B Bills, B2B Credit-Debit Notes, Export Bills, B2C —
//   with party GSTIN and name, monthly subtotals and a grand total.
//   Party names are looked up on the GST portal (search taxpayer) from this
//   computer and cached in gstr1-party-names.json next to this file.
//
//   Amendments (9A/9C/10 — b2ba, cdnra, b2csa, expa, ...) are handled by
//   looking up the ORIGINAL document in the other uploaded months and taking
//   the differential (amended − original), exactly like the portal does.
//   Every amendment is listed on a separate "Amendments" sheet; originals not
//   uploaded (e.g. prior-year documents) are flagged and left out of the
//   summary with a warning — upload the original month's JSON to include them.
//
//   GSTR-3B PDFs can be dropped in too:
//   - "GSTR-1 vs 3B" sheet — one row per month: yellow GSTR-3B block
//     (3.1(a) B2B+B2C and 3.1(b) Export separately, with taxes), orange
//     GSTR-1 block, then Difference (3B − 1) with mismatches in red.
//     This is the summary sheet — the GSTR-1 figures live in its orange
//     block, so there is no separate "As Per GSTR1" sheet.
//   - "RCM Reco (3B)" sheet — reverse-charge liability declared in 3.1(d)
//     against RCM ITC availed in Table 4A(2)+4A(3), with the difference.
//
//   Party names (LEGAL and TRADE name — they often differ) are fetched
//   automatically: first from the GST portal Search Taxpayer service
//   (https://services.gst.gov.in/services/searchtp), then — for a fully
//   automatic, CompuGST-style direct fetch — through a free GSTIN API key
//   (gstincheck.co.in or appyflow.in) saved once in the browser UI
//   (stored in gstr1-config.json). All names are cached forever in
//   gstr1-party-names.json; you can also type names there or in the UI.
//
//   AUTOMATION: double-click gstr1-auto-report.bat (or run with --auto).
//   Everything in the "GST Files" folder next to this script is processed
//   and GSTR-Report.xlsx is written there and opened — no browser needed.
//
//   MULTIPLE GSTINs: files of different clients can be mixed in one run.
//   Returns are grouped by the GSTIN inside each file and every GSTIN gets
//   its own complete report (browser download becomes a zip, CLI/auto mode
//   writes GSTR-Report-<GSTIN>.xlsx per client). Amendments only match
//   originals within the same GSTIN.
//
//   The taxable values are netted the way an accountant expects:
//     B2B    = 4A + 4B + 9A amendments (B2B) + 9B CDNR + 9C CDNRA
//     B2C    = 5 (B2CL) + 7 (B2CS) + 10 amendments + CDNUR/CDNURA (B2CL part)
//     Export = 6A + 9A export amendments + CDNUR/CDNURA (EXPWP/EXPWOP part)
//     IGST / CGST / SGST = "Total Liability" row of the return
//
//   A second "Workings" sheet shows every component figure per month so the
//   summary can be verified against the return.
//
// HOW TO USE — browser (easiest)
//   1. Install Node.js from https://nodejs.org (LTS) — one time.
//   2. Run:  node gstr1-excel-summary.mjs
//   3. Open http://localhost:8788 — drop the files, click "Download Excel".
//
// HOW TO USE — command line
//   node gstr1-excel-summary.mjs April.pdf May_GSTR1.json -o Summary.xlsx
//   (prints the table and writes the Excel file; default GSTR1-Summary.xlsx)
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';

const PORT = 8788;

/* ======================================================================== *
 *  Part 1 — minimal PDF text extractor
 *  Tailored to GST-portal PDFs (FlateDecode streams, Identity-H CID fonts
 *  with ToUnicode CMaps). Tracks the graphics/text matrices so the giant
 *  diagonal watermark can be dropped by its effective font size.
 * ======================================================================== */

function pdfObjects(buf) {
  const s = buf.toString('latin1');
  const objs = new Map(); // num -> { dict, streamRaw }
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = +m[1];
    const start = re.lastIndex;
    const end = s.indexOf('endobj', start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const si = body.search(/stream(\r\n|\n|\r)/);
    let dict = body;
    let streamRaw = null;
    if (si >= 0) {
      dict = body.slice(0, si);
      let ds = start + si + 6;
      if (s[ds] === '\r') ds++;
      if (s[ds] === '\n') ds++;
      let de = s.indexOf('endstream', ds);
      if (de < 0) de = end;
      let realEnd = de;
      while (realEnd > ds && (s[realEnd - 1] === '\n' || s[realEnd - 1] === '\r')) realEnd--;
      streamRaw = buf.subarray(ds, realEnd);
    }
    objs.set(num, { dict, streamRaw });
    re.lastIndex = end + 6;
  }
  return { objs, all: s };
}

function inflateStream(obj) {
  if (!obj || !obj.streamRaw) return null;
  if (!/\/FlateDecode/.test(obj.dict)) return Buffer.from(obj.streamRaw);
  try {
    return zlib.inflateSync(obj.streamRaw);
  } catch {
    // trailing garbage before endstream — retry with progressively trimmed tail
    for (let cut = 1; cut <= 4; cut++) {
      try { return zlib.inflateSync(obj.streamRaw.subarray(0, obj.streamRaw.length - cut)); } catch { /* keep trying */ }
    }
    return null;
  }
}

// Extract the raw value token following /Key in a dictionary string.
function dictValue(dict, key) {
  const idx = dict.search(new RegExp('/' + key + '(?![A-Za-z0-9])'));
  if (idx < 0) return null;
  let i = idx + key.length + 1;
  while (i < dict.length && /\s/.test(dict[i])) i++;
  if (dict.startsWith('<<', i)) {
    let depth = 0, j = i;
    while (j < dict.length) {
      if (dict.startsWith('<<', j)) { depth++; j += 2; continue; }
      if (dict.startsWith('>>', j)) { depth--; j += 2; if (!depth) break; continue; }
      j++;
    }
    return dict.slice(i, j);
  }
  if (dict[i] === '[') {
    const j = dict.indexOf(']', i);
    return dict.slice(i, j + 1);
  }
  const m = dict.slice(i).match(/^(\d+\s+\d+\s+R|\/?[^\s/<>\[\]]+)/);
  return m ? m[1] : null;
}

function refNum(tok) {
  const m = typeof tok === 'string' && tok.match(/^(\d+)\s+\d+\s+R$/);
  return m ? +m[1] : null;
}

// CID widths from a descendant font's /W array: [c [w w ...] cFirst cLast w ...]
function parseWidths(wTok) {
  const widths = new Map();
  if (!wTok) return widths;
  const toks = wTok.match(/[\[\]]|-?[\d.]+/g) || [];
  let i = 0;
  const next = () => toks[i++];
  if (next() !== '[') return widths;
  while (i < toks.length) {
    const t = next();
    if (t === ']' || t == null) break;
    const first = +t;
    const t2 = next();
    if (t2 === '[') {
      let c = first, w;
      while ((w = next()) !== ']' && w != null) widths.set(c++, +w);
    } else {
      const last = +t2, w = +next();
      for (let c = first; c <= last; c++) widths.set(c, w);
    }
  }
  return widths;
}

// ToUnicode CMap -> Map(cid -> string)
function parseCMap(text) {
  const map = new Map();
  const hexToStr = (h) => {
    h = h.replace(/\s+/g, '');
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  };
  for (const sec of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of sec[1].matchAll(/<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g)) {
      map.set(parseInt(p[1].replace(/\s+/g, ''), 16), hexToStr(p[2]));
    }
  }
  for (const sec of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = sec[1];
    const entry = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(<[0-9A-Fa-f\s]+>|\[[\s\S]*?\])/g;
    let e;
    while ((e = entry.exec(body))) {
      const lo = parseInt(e[1].replace(/\s+/g, ''), 16);
      const hi = parseInt(e[2].replace(/\s+/g, ''), 16);
      const dst = e[3];
      if (dst[0] === '[') {
        const items = [...dst.matchAll(/<([0-9A-Fa-f\s]+)>/g)].map((x) => hexToStr(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      } else {
        const base = dst.slice(1, -1).replace(/\s+/g, '');
        const start = parseInt(base, 16);
        for (let c = lo; c <= hi; c++) map.set(c, hexToStr((start + (c - lo)).toString(16).padStart(4, '0')));
      }
    }
  }
  return map;
}

// 2D affine matrices as [a,b,c,d,e,f]; row-vector convention: apply A then B.
const M_ID = [1, 0, 0, 1, 0, 0];
function mmul(A, B) {
  return [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4],
    A[4] * B[1] + A[5] * B[3] + B[5],
  ];
}

function* contentTokens(src) {
  let i = 0;
  const n = src.length;
  const delim = /[\s/<>\[\]()%]/;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '%') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '(') {
      let depth = 1, out = '';
      i++;
      while (i < n && depth > 0) {
        const c = src[i];
        if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (!depth) { i++; break; } }
        out += c;
        i++;
      }
      yield { t: 'hex', v: null, raw: out };
      continue;
    }
    if (ch === '<') {
      if (src[i + 1] === '<') {
        let depth = 0;
        while (i < n) {
          if (src.startsWith('<<', i)) { depth++; i += 2; continue; }
          if (src.startsWith('>>', i)) { depth--; i += 2; if (!depth) break; continue; }
          i++;
        }
        continue; // inline dicts are irrelevant for text
      }
      const j = src.indexOf('>', i);
      yield { t: 'hex', v: src.slice(i + 1, j).replace(/\s+/g, '') };
      i = j + 1;
      continue;
    }
    if (ch === '[') { yield { t: 'arrOpen' }; i++; continue; }
    if (ch === ']') { yield { t: 'arrClose' }; i++; continue; }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && !delim.test(src[j])) j++;
      yield { t: 'name', v: src.slice(i + 1, j) };
      i = j;
      continue;
    }
    if (/[-+.\d]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[.\d\-+Ee]/.test(src[j])) j++;
      yield { t: 'num', v: parseFloat(src.slice(i, j)) };
      i = j;
      continue;
    }
    let j = i;
    while (j < n && /[A-Za-z'"*0-9]/.test(src[j])) j++;
    if (j === i) { i++; continue; }
    yield { t: 'op', v: src.slice(i, j) };
    i = j;
  }
}

// Run the content stream, returning text runs [{x, y, size, text}].
function runContent(content, fonts) {
  const runs = [];
  let ctm = M_ID;
  const gsStack = [];
  let tm = M_ID, tlm = M_ID, leading = 0;
  let font = null, fontSize = 0;
  const stack = [];
  let arr = null;

  const showText = (items) => {
    let text = '';
    let advance = 0; // in 1/1000 em units
    for (const it of items) {
      if (typeof it === 'number') { advance -= it; continue; } // TJ kern adjustment
      if (typeof it !== 'object') continue;
      if (it.v != null) {
        for (let i = 0; i + 4 <= it.v.length; i += 4) {
          const cid = parseInt(it.v.slice(i, i + 4), 16);
          text += font && font.cmap.has(cid) ? font.cmap.get(cid) : '';
          advance += font ? (font.widths.get(cid) ?? font.dw) : 500;
        }
      } else if (it.raw != null) {
        text += it.raw; // literal string (non-CID) — rare in these PDFs
        advance += it.raw.length * 500;
      }
    }
    if (!text) return;
    const trm = mmul(tm, ctm);
    const scale = Math.sqrt(Math.abs(trm[0] * trm[3] - trm[1] * trm[2])) || 1;
    const width = (advance / 1000) * fontSize;
    runs.push({
      x: trm[4],
      y: trm[5],
      endX: width * trm[0] + trm[4],
      size: fontSize * scale,
      text,
    });
  };

  for (const tok of contentTokens(content)) {
    if (tok.t === 'arrOpen') { arr = []; continue; }
    if (tok.t === 'arrClose') { stack.push(arr); arr = null; continue; }
    if (arr) { if (tok.t !== 'op') arr.push(tok.t === 'num' ? tok.v : tok); continue; }
    if (tok.t !== 'op') { stack.push(tok.t === 'num' ? tok.v : tok); continue; }

    const op = tok.v;
    const a = stack;
    switch (op) {
      case 'q': gsStack.push(ctm); break;
      case 'Q': ctm = gsStack.pop() ?? M_ID; break;
      case 'cm': ctm = mmul(a.slice(-6), ctm); break;
      case 'BT': tm = tlm = M_ID; break;
      case 'Tf': {
        const sz = a[a.length - 1];
        const nameTok = a[a.length - 2];
        fontSize = typeof sz === 'number' ? sz : 0;
        font = nameTok && nameTok.t === 'name' ? fonts.get(nameTok.v) ?? null : null;
        break;
      }
      case 'Td': case 'TD': {
        const ty = a[a.length - 1], tx = a[a.length - 2];
        if (op === 'TD') leading = -ty;
        tlm = mmul([1, 0, 0, 1, tx, ty], tlm);
        tm = tlm;
        break;
      }
      case 'Tm': tm = tlm = a.slice(-6); break;
      case 'TL': leading = a[a.length - 1]; break;
      case 'T*': tlm = mmul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; break;
      case 'Tj': showText([a[a.length - 1]]); break;
      case "'": tlm = mmul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; showText([a[a.length - 1]]); break;
      case '"': tlm = mmul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm; showText([a[a.length - 1]]); break;
      case 'TJ': {
        const items = a[a.length - 1];
        if (Array.isArray(items)) showText(items);
        break;
      }
    }
    stack.length = 0;
  }
  return runs;
}

// Assemble filtered runs into reading-order text lines.
function assembleText(runs) {
  const usable = runs.filter((r) => r.size < 50 && r.text.trim() !== '');
  usable.sort((p, q) => q.y - p.y || p.x - q.x);
  const lines = [];
  for (const r of usable) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - r.y) < 2.5) last.runs.push(r);
    else lines.push({ y: r.y, runs: [r] });
  }
  return lines
    .map((L) => {
      const rs = L.runs.sort((p, q) => p.x - q.x);
      let s = '';
      for (let i = 0; i < rs.length; i++) {
        if (i > 0) {
          // real gap between runs -> word/cell boundary; tiny gap -> same word
          const gap = rs[i].x - rs[i - 1].endX;
          if (gap > 0.2 * Math.max(rs[i].size, 1)) s += ' ';
        }
        s += rs[i].text;
      }
      return s.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean)
    .join('\n');
}

function extractPdfText(buf) {
  const { objs, all } = pdfObjects(buf);
  const rootMatches = [...all.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  if (!rootMatches.length) throw new Error('Not a valid PDF (no document root found)');
  const catalog = objs.get(+rootMatches[rootMatches.length - 1][1]);
  const pagesRef = refNum(dictValue(catalog.dict, 'Pages'));

  const pageNums = [];
  const walk = (num) => {
    const o = objs.get(num);
    if (!o) return;
    const type = dictValue(o.dict, 'Type');
    if (type === 'Pages' || /\/Kids/.test(o.dict)) {
      const kids = dictValue(o.dict, 'Kids') || '';
      for (const k of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(+k[1]);
    } else {
      pageNums.push(num);
    }
  };
  walk(pagesRef);
  if (!pageNums.length) throw new Error('PDF has no pages');

  const fontCache = new Map(); // font obj num -> cmap
  const loadFonts = (resTok) => {
    let resDict = resTok;
    const rn = refNum(resTok);
    if (rn != null) resDict = objs.get(rn)?.dict ?? '';
    const fontTok = dictValue(resDict || '', 'Font');
    let fontDict = fontTok;
    const fn = refNum(fontTok);
    if (fn != null) fontDict = objs.get(fn)?.dict ?? '';
    const fonts = new Map();
    if (!fontDict) return fonts;
    for (const m of fontDict.matchAll(/\/(\w+)\s+(\d+)\s+\d+\s+R/g)) {
      const fname = m[1], fnum = +m[2];
      if (!fontCache.has(fnum)) {
        const fobj = objs.get(fnum);
        let cmap = new Map();
        let widths = new Map();
        let dw = 500;
        if (fobj) {
          const tuRef = refNum(dictValue(fobj.dict, 'ToUnicode'));
          if (tuRef != null) {
            const tu = inflateStream(objs.get(tuRef));
            if (tu) cmap = parseCMap(tu.toString('latin1'));
          }
          const descTok = dictValue(fobj.dict, 'DescendantFonts');
          const descRef = descTok && (descTok.match(/(\d+)\s+\d+\s+R/) || [])[1];
          if (descRef != null) {
            const desc = objs.get(+descRef);
            if (desc) {
              widths = parseWidths(dictValue(desc.dict, 'W'));
              const dwTok = dictValue(desc.dict, 'DW');
              if (dwTok && !isNaN(+dwTok)) dw = +dwTok;
              else dw = 1000;
            }
          }
        }
        fontCache.set(fnum, { cmap, widths, dw });
      }
      fonts.set(fname, fontCache.get(fnum));
    }
    return fonts;
  };

  const pages = [];
  for (const pnum of pageNums) {
    const page = objs.get(pnum);
    const fonts = loadFonts(dictValue(page.dict, 'Resources'));
    const contTok = dictValue(page.dict, 'Contents') || '';
    let content = '';
    for (const c of contTok.matchAll(/(\d+)\s+\d+\s+R/g)) {
      const data = inflateStream(objs.get(+c[1]));
      if (data) content += data.toString('latin1') + '\n';
    }
    pages.push(assembleText(runContent(content, fonts)));
  }
  return pages.join('\n');
}

/* ======================================================================== *
 *  Part 2 — GSTR-1 figures
 * ======================================================================== */

const NUM = '(-?\\d[\\d,]*\\.\\d+)';
const D = '[-\\u2013\\u2014]'; // hyphen / en dash / em dash

const SECTION_HEADERS = [
  ['s4A', `4A ${D} Taxable outward supplies made to registered persons \\(other`],
  ['s4B', `4B ${D} Taxable outward supplies made to registered persons attracting`],
  ['s5', `5 ${D} Taxable outward inter-state supplies`],
  ['s6A', `6A ${D} Exports`],
  ['s6B', `6B ${D} Supplies made to SEZ`],
  ['s6C', `6C ${D} Deemed Exports`],
  ['s7', `7\\s?${D} Taxable supplies \\(Net of debit and credit notes\\) to unregistered`],
  ['s8', `8 ${D} Nil rated, exempted`],
  ['s9A_b2b', `9A ${D} Amendment to taxable outward supplies made to registered person[\\s\\S]{0,120}?B2B Regular`],
  ['s9A_b2bRC', `9A ${D} Amendment to taxable outward supplies made to registered person[\\s\\S]{0,120}?B2B Reverse charge`],
  ['s9A_b2cl', `9A ${D} Amendment to Inter-State supplies`],
  ['s9A_exp', `9A ${D} Amendment to Export supplies`],
  ['s9A_sez', `9A ${D} Amendment to supplies made to SEZ`],
  ['s9A_de', `9A ${D} Amendment to Deemed Exports`],
  ['s9B_cdnr', `9B ${D} Credit/Debit Notes \\(Registered\\)`],
  ['s9B_cdnur', `9B ${D} Credit/Debit Notes \\(Unregistered\\)`],
  ['s9C_cdnra', `9C ${D} Amended Credit/Debit Notes \\(Registered\\)`],
  ['s9C_cdnura', `9C ${D} Amended Credit/Debit Notes \\(Unregistered\\)`],
  ['s10', `10 ${D} Amendment to taxable outward supplies made to unregistered person`],
  ['s11a', `11A\\(1\\), 11A\\(2\\) ${D} Advances received`],
  ['s11b', `11B\\(1\\), 11B\\(2\\) ${D} Advance amount received`],
  ['s12', `12 ${D} HSN-wise summary`],
  ['s13', `13 ${D} Documents issued`],
  ['s14', `14 ${D} Supplies made through E-Commerce`],
  ['sLiab', `Total Liability \\(Outward supplies other than Reverse charge\\)`],
];

function sliceSections(text) {
  const found = [];
  for (const [key, pat] of SECTION_HEADERS) {
    const m = text.match(new RegExp(pat));
    if (m) found.push({ key, start: m.index, end: m.index + m[0].length });
  }
  found.sort((a, b) => a.start - b.start);
  const out = {};
  for (let i = 0; i < found.length; i++) {
    const next = found[i + 1] ? found[i + 1].start : text.length;
    out[found[i].key] = text.slice(found[i].end, next);
  }
  return out;
}

const num = (s) => (s == null ? 0 : parseFloat(String(s).replace(/,/g, '')));
const r2 = (v) => Math.round(v * 100) / 100;

function grab(section, pattern, count) {
  if (!section) return null;
  const m = section.match(new RegExp(pattern));
  if (!m) return null;
  const vals = [];
  for (let i = 1; i <= count; i++) vals.push(num(m[i]));
  return vals;
}

const N5 = `${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}\\s+${NUM}`;
const N3 = `${NUM}\\s+${NUM}\\s+${NUM}`;

function parseGstr1FromText(text, fileName) {
  if (!/FORM GSTR-1/.test(text)) throw new Error(`${fileName}: does not look like a FORM GSTR-1 or GSTR-3B PDF`);
  const S = sliceSections(text);
  const warnings = [];

  const meta = {
    gstin: (text.match(/GSTIN\s+([0-9A-Z]{15})/) || [])[1] || '',
    legalName: (text.match(/Legal name of the registered person\s+([^\n]+)/) || [])[1] || '',
    fy: (text.match(/Financial year\s+(\d{4}-\d{2})/) || [])[1] || '',
    period: (text.match(/Tax period\s+([A-Za-z]+)/) || [])[1] || '',
    arn: (text.match(/\(c\) ARN\s+([A-Z0-9]+)/) || [])[1] || '',
    arnDate: (text.match(/\(d\) ARN date\s+([\d/]+)/) || [])[1] || '',
  };

  const totalRow = (sec, docType, n) => grab(sec, `Total\\s+\\d+\\s+${docType}\\s+` + (n === 5 ? N5 : N3), n);
  const netDiff = (sec, n) => grab(sec, `Net differential amount \\(Amended ${D} Original\\)(?:\\s*${D}\\s*Total)?\\s+` + (n === 5 ? N5 : N3), n);

  const c = {}; // components: each [value, igst, cgst, sgst, cess] or [value, igst, cess]
  c.t4A = totalRow(S.s4A, 'Invoice', 5);
  c.t4B = totalRow(S.s4B, 'Invoice', 5);
  c.t5 = totalRow(S.s5, 'Invoice', 3);
  c.t6A = totalRow(S.s6A, 'Invoice', 3);
  c.t6B = totalRow(S.s6B, 'Invoice', 3);
  c.t6C = totalRow(S.s6C, 'Invoice', 5);
  c.t7 = totalRow(S.s7, 'Net Value', 5);
  c.a9A_b2b = netDiff(S.s9A_b2b, 5);
  c.a9A_b2bRC = netDiff(S.s9A_b2bRC, 5);
  c.a9A_b2cl = netDiff(S.s9A_b2cl, 3);
  c.a9A_exp = netDiff(S.s9A_exp, 3);
  c.cdnr = grab(S.s9B_cdnr, `Total ${D} Net off debit/credit notes \\(Debit notes ${D} Credit notes\\)\\s+\\d+\\s+Note\\s+` + N5, 5);
  c.cdnur = grab(S.s9B_cdnur, `Total ${D} Net off debit/credit notes \\(Debit notes ${D} Credit notes\\)\\s+\\d+\\s+Note\\s+` + N3, 3);
  c.cdnur_b2cl = grab(S.s9B_cdnur, `${D} B2CL\\s+\\d+\\s+Note\\s+${NUM}`, 1);
  c.cdnur_expwp = grab(S.s9B_cdnur, `${D} EXPWP\\s+\\d+\\s+Note\\s+${NUM}`, 1);
  c.cdnur_expwop = grab(S.s9B_cdnur, `${D} EXPWOP\\s+\\d+\\s+Note\\s+${NUM}`, 1);
  c.cdnra = grab(S.s9C_cdnra, `Net Differential amount \\(Net Amended Debit notes ${D} Net\\s+` + N5, 5);
  c.cdnura = grab(S.s9C_cdnura, `Net Differential amount \\(Net Amended Debit notes ${D} Net\\s+` + N3, 3);
  c.cdnura_b2cl = grab(S.s9C_cdnura, `${D} B2CL\\s+\\d+\\s+Note\\s+${NUM}`, 1);
  c.cdnura_expwp = grab(S.s9C_cdnura, `${D} EXPWP\\s+\\d+\\s+Note\\s+${NUM}`, 1);
  c.cdnura_expwop = grab(S.s9C_cdnura, `${D} EXPWOP\\s+\\d+\\s+Note\\s+${NUM}`, 1);
  c.a10 = netDiff(S.s10, 5);
  c.liab = grab(S.sLiab, '^\\s*' + N5, 5);

  for (const key of ['t4A', 't5', 't6A', 't7', 'liab']) {
    if (!c[key]) warnings.push(`${fileName}: could not read section "${key}" — figures may be incomplete`);
  }
  const v = (x) => (x ? x[0] : 0);

  const b2b = r2(v(c.t4A) + v(c.t4B) + v(c.a9A_b2b) + v(c.a9A_b2bRC) + v(c.cdnr) + v(c.cdnra));
  const b2c = r2(v(c.t5) + v(c.t7) + v(c.a10) + v(c.a9A_b2cl) + v(c.cdnur_b2cl) + v(c.cdnura_b2cl));
  const exp = r2(v(c.t6A) + v(c.a9A_exp) + v(c.cdnur_expwp) + v(c.cdnur_expwop) + v(c.cdnura_expwp) + v(c.cdnura_expwop));
  const [liabVal, igst, cgst, sgst, cess] = c.liab || [0, 0, 0, 0, 0];

  const accounted = r2(b2b + b2c + exp);
  if (Math.abs(accounted - liabVal) > 0.02) {
    warnings.push(
      `${meta.period} ${meta.fy}: B2B+B2C+Export (${fmtIN(accounted)}) differs from Total Liability value ` +
      `(${fmtIN(liabVal)}) — the return likely has SEZ/Deemed-Export/advance amounts outside these three columns. See Workings sheet.`
    );
  }
  if (cess) warnings.push(`${meta.period} ${meta.fy}: return has Cess of ${fmtIN(cess)} (not shown in summary columns).`);

  return { meta, components: c, summary: { b2b, b2c, export: exp, igst, cgst, sgst, cess, liabVal }, warnings, fileName };
}

/* ---- GSTR-1 JSON (portal download): bill-wise details + same summary ---- */

const zeroT = () => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
const addT = (a, t, sign = 1) => {
  a.txval += sign * t.txval; a.iamt += sign * t.iamt; a.camt += sign * t.camt;
  a.samt += sign * t.samt; a.csamt += sign * t.csamt;
};
const itemTotals = (itms) => {
  const t = { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0, rates: new Set() };
  for (const it of itms || []) {
    const d = it.itm_det || it; // export/advance items have no itm_det wrapper
    t.txval += d.txval ?? d.ad_amt ?? 0;
    t.iamt += d.iamt || 0; t.camt += d.camt || 0; t.samt += d.samt || 0; t.csamt += d.csamt || 0;
    if (d.rt != null) t.rates.add(d.rt);
  }
  return t;
};

function parseGstr1Json(buf, fileName) {
  let j;
  try {
    j = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error(`${fileName}: not a valid JSON file`);
  }
  if (!j.gstin || !j.fp) throw new Error(`${fileName}: does not look like a GSTR-1 JSON (missing gstin/fp)`);

  const mm = +String(j.fp).slice(0, 2);
  const yyyy = +String(j.fp).slice(2);
  const fyStart = mm >= 4 ? yyyy : yyyy - 1;
  const meta = {
    gstin: j.gstin,
    legalName: '',
    fy: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`,
    period: MONTHS[mm - 1] || String(j.fp),
    arn: '',
    arnDate: j.fil_dt || '',
  };
  const warnings = [];
  const bills = [];

  const acc = {
    b2b: zeroT(), b2bRC: zeroT(), b2cl: zeroT(), b2cs: zeroT(), exp: zeroT(),
    cdnr: zeroT(), cdnurB2CL: zeroT(), cdnurExp: zeroT(), at: zeroT(), txpd: zeroT(),
  };
  const addAcc = addT;
  const pushBill = (section, t, sign, extra) => {
    bills.push({
      section,
      ctin: extra.ctin || '', num: extra.num || '', date: extra.date || '',
      pos: extra.pos || '', type: extra.type || '',
      rate: [...t.rates].join(', '),
      txval: r2(sign * t.txval), igst: r2(sign * t.iamt), cgst: r2(sign * t.camt),
      sgst: r2(sign * t.samt), cess: r2(sign * t.csamt), val: r2(sign * (extra.val || 0)),
    });
  };

  for (const party of j.b2b || []) {
    for (const inv of party.inv || []) {
      const t = itemTotals(inv.itms);
      const rc = inv.rchrg === 'Y';
      addAcc(rc ? acc.b2bRC : acc.b2b, t);
      pushBill('B2B', t, 1, {
        ctin: party.ctin, num: inv.inum, date: inv.idt, pos: inv.pos,
        type: (inv.inv_typ || 'R') + (rc ? ' / RCM' : ''), val: inv.val,
      });
    }
  }
  for (const grp of j.b2cl || []) {
    for (const inv of grp.inv || []) {
      const t = itemTotals(inv.itms);
      addAcc(acc.b2cl, t);
      pushBill('B2CL', t, 1, { num: inv.inum, date: inv.idt, pos: grp.pos, type: 'B2C Large', val: inv.val });
    }
  }
  for (const e of j.b2cs || []) {
    const t = { txval: e.txval || 0, iamt: e.iamt || 0, camt: e.camt || 0, samt: e.samt || 0, csamt: e.csamt || 0, rates: new Set(e.rt != null ? [e.rt] : []) };
    addAcc(acc.b2cs, t);
    pushBill('B2CS', t, 1, {
      num: '(consolidated)', pos: e.pos, type: e.sply_ty || e.typ || '',
      val: t.txval + t.iamt + t.camt + t.samt + t.csamt,
    });
  }
  for (const grp of j.exp || []) {
    for (const inv of grp.inv || []) {
      const t = itemTotals(inv.itms);
      addAcc(acc.exp, t);
      pushBill('Export', t, 1, { num: inv.inum, date: inv.idt, type: grp.exp_typ, val: inv.val });
    }
  }
  for (const party of j.cdnr || []) {
    for (const nt of party.nt || []) {
      const t = itemTotals(nt.itms);
      const sign = nt.ntty === 'D' ? 1 : -1;
      addAcc(acc.cdnr, t, sign);
      pushBill('CDNR', t, sign, {
        ctin: party.ctin, num: nt.nt_num, date: nt.nt_dt, pos: nt.pos,
        type: nt.ntty === 'D' ? 'Debit Note' : 'Credit Note', val: nt.val,
      });
    }
  }
  for (const nt of j.cdnur || []) {
    const t = itemTotals(nt.itms);
    const sign = nt.ntty === 'D' ? 1 : -1;
    addAcc(/^EXP/.test(nt.typ || '') ? acc.cdnurExp : acc.cdnurB2CL, t, sign);
    pushBill('CDNUR', t, sign, {
      num: nt.nt_num, date: nt.nt_dt, pos: nt.pos,
      type: (nt.ntty === 'D' ? 'Debit Note' : 'Credit Note') + ' / ' + (nt.typ || ''), val: nt.val,
    });
  }
  for (const [key, label, target] of [['at', 'Advances (11A)', acc.at], ['txpd', 'Advances adjusted (11B)', acc.txpd]]) {
    for (const e of j[key] || []) {
      const t = itemTotals(e.itms);
      addAcc(target, t);
      pushBill(label, t, 1, { num: '(consolidated)', pos: e.pos, type: e.sply_ty || '', val: t.txval });
    }
  }

  const amendRaw = {
    b2ba: j.b2ba || [], b2cla: j.b2cla || [], b2csa: j.b2csa || [],
    expa: j.expa || [], cdnra: j.cdnra || [], cdnura: j.cdnura || [],
  };
  for (const k of ['ata', 'txpda']) {
    if ((j[k] || []).length) warnings.push(`${meta.period} ${meta.fy}: advance-amendment table "${k}" present — not supported, its effect is NOT included.`);
  }
  const nilTotal = (j.nil?.inv || []).reduce((s, x) => s + (x.expt_amt || 0) + (x.nil_amt || 0) + (x.ngsup_amt || 0), 0);
  if (nilTotal) warnings.push(`${meta.period} ${meta.fy}: nil-rated/exempt/non-GST supplies of ${fmtIN(nilTotal)} reported (Table 8) — not part of the summary columns.`);
  if (acc.b2bRC.iamt || acc.b2bRC.camt || acc.b2bRC.samt) {
    warnings.push(`${meta.period} ${meta.fy}: reverse-charge B2B tax excluded from IGST/CGST/SGST (payable by the recipient).`);
  }

  const F = (a) => [r2(a.txval), r2(a.iamt), r2(a.camt), r2(a.samt), r2(a.csamt)];
  const components = {
    t4A: F(acc.b2b), t4B: F(acc.b2bRC), t5: F(acc.b2cl), t6A: F(acc.exp), t7: F(acc.b2cs),
    cdnr: F(acc.cdnr),
    cdnur_b2cl: [r2(acc.cdnurB2CL.txval)], cdnur_expwp: [0], cdnur_expwop: [r2(acc.cdnurExp.txval)],
  };

  const b2b = r2(acc.b2b.txval + acc.b2bRC.txval + acc.cdnr.txval);
  const b2c = r2(acc.b2cl.txval + acc.b2cs.txval + acc.cdnurB2CL.txval);
  const exp = r2(acc.exp.txval + acc.cdnurExp.txval);
  const tax = (k) =>
    r2(acc.b2b[k] + acc.b2cl[k] + acc.b2cs[k] + acc.exp[k] + acc.cdnr[k] +
       acc.cdnurB2CL[k] + acc.cdnurExp[k] + acc.at[k] - acc.txpd[k]);
  const summary = {
    b2b, b2c, export: exp,
    igst: tax('iamt'), cgst: tax('camt'), sgst: tax('samt'), cess: tax('csamt'),
    liabVal: r2(b2b + b2c + exp + acc.at.txval - acc.txpd.txval),
  };
  return { meta, components, summary, warnings, fileName, bills, amendRaw, amendments: [] };
}

/* ---- GSTR-3B PDF: outward supplies (Table 3.1) for the difference sheet ---- */

// Last `count` amount cells on the line that starts at `labelRe` ("-" cells = 0).
function lineNums(text, labelRe, count) {
  const m = text.match(labelRe);
  if (!m) return null;
  const nl = text.indexOf('\n', m.index + m[0].length);
  const line = text.slice(m.index, nl < 0 ? text.length : nl);
  const toks = line.match(/-?\d[\d,]*\.\d+|(?<=\s)-(?=\s|$)/g) || [];
  if (toks.length < count) return null;
  return toks.slice(-count).map((t) => (t === '-' ? 0 : num(t)));
}

function parseGstr3b(text, fileName) {
  const meta = {
    gstin: (text.match(/GSTIN of the supplier\s+([0-9A-Z]{15})/) || [])[1] || '',
    legalName: (text.match(/Legal name of the registered person\s+([^\n]+)/) || [])[1] || '',
    fy: (text.match(/Year\s+(\d{4}-\d{2})/) || [])[1] || '',
    period: (text.match(/Period\s+([A-Za-z]+)/) || [])[1] || '',
    arn: (text.match(/2\(c\)\.? ARN\s+([A-Z0-9]+)/) || [])[1] || '',
    arnDate: (text.match(/2\(d\)\.? Date of ARN\s+([\d/]+)/) || [])[1] || '',
  };
  const warnings = [];
  const r31 = {
    a: lineNums(text, /\(a\)\s*Outward taxable supplies\s*\(other than zero rated/, 5),
    b: lineNums(text, /\(b\)\s*Outward taxable supplies\s*\(zero rated\)/, 5),
    c: lineNums(text, /\(c\s*\)\s*Other outward supplies\s*\(nil rated, exempted\)/, 5),
    d: lineNums(text, /\(d\)\s*Inward supplies\s*\(liable to reverse charge\)/, 5),
    e: lineNums(text, /\(e\)\s*Non-GST outward supplies/, 5),
  };
  if (!r31.a || !r31.b) throw new Error(`${fileName}: could not read Table 3.1 of the GSTR-3B PDF`);
  for (const k of ['c', 'd', 'e']) r31[k] = r31[k] || [0, 0, 0, 0, 0];
  if (r31.c[0] || r31.e[0]) {
    warnings.push(`${meta.period} ${meta.fy} (3B): nil-rated/exempt/non-GST outward supplies of ${fmtIN(r31.c[0] + r31.e[0])} in 3.1(c)/(e) — not part of the comparison.`);
  }
  const s911 = lineNums(text, /\(i\)\s*Taxable supplies on which electronic commerce operator pays tax/, 5);
  if (s911 && s911[0]) warnings.push(`${meta.period} ${meta.fy} (3B): supplies u/s 9(5) in Table 3.1.1 of ${fmtIN(s911[0])} — not part of the comparison.`);

  // Table 4A — ITC on reverse-charge inward supplies: (2) import of services,
  // (3) other inward supplies liable to reverse charge  [IGST CGST SGST Cess]
  const itcRcm = {
    imp: lineNums(text, /\(2\)\s*Import of services/, 4) || [0, 0, 0, 0],
    inw: lineNums(text, /\(3\)\s*Inward supplies liable to reverse charge \(other than/, 4) || [0, 0, 0, 0],
  };

  const summary3b = {
    value: r2(r31.a[0] + r31.b[0]),
    igst: r2(r31.a[1] + r31.b[1]),
    cgst: r2(r31.a[2] + r31.b[2]),
    sgst: r2(r31.a[3] + r31.b[3]),
    cess: r2(r31.a[4] + r31.b[4]),
  };
  return { kind: 'gstr3b', meta, r31, itcRcm, summary3b, warnings, fileName };
}

// Dispatch on content: GSTR-1 JSON, GSTR-1 PDF or GSTR-3B PDF.
function parseAny(buf, fileName) {
  const head = buf.subarray(0, 64).toString('latin1').trimStart();
  if (/\.json$/i.test(fileName) || head.startsWith('{')) return parseGstr1Json(buf, fileName);
  const text = extractPdfText(buf);
  if (/Form GSTR-3B/i.test(text)) return parseGstr3b(text, fileName);
  return parseGstr1FromText(text, fileName);
}

function dupWarnings(results) {
  const seen = new Map();
  const out = [];
  for (const r of results) {
    const key = (r.kind === 'gstr3b' ? '3B ' : '') + monthLabel(r.meta);
    if (seen.has(key)) out.push(`${key} appears twice (${seen.get(key)} and ${r.fileName}) — the summary has a row for each, check they agree.`);
    else seen.set(key, r.fileName);
  }
  return out;
}

/* ---- amendments (9A/9C/10): differential = amended − original document ----
   The JSON only carries the amended values; the original is looked up in the
   other uploaded months (the way the portal computes "Net differential").
   Originals not found (prior-year / month not uploaded) are listed separately
   and NOT folded into the summary. */
function applyAmendments(results) {
  const g1 = results.filter((r) => r.kind !== 'gstr3b' && r.amendRaw).sort((a, b) => sortKey(a.meta) - sortKey(b.meta));
  if (!g1.length) return;

  const idx = { b2b: new Map(), b2cl: new Map(), exp: new Map(), cdnr: new Map(), cdnur: new Map(), b2cs: new Map() };
  for (const r of g1) {
    const label = monthLabel(r.meta);
    const mk = sortKey(r.meta);
    for (const b of r.bills) {
      const rec = { txval: b.txval, iamt: b.igst, camt: b.cgst, samt: b.sgst, csamt: b.cess, month: label };
      if (b.section === 'B2B') idx.b2b.set(`${b.ctin}|${b.num}`, rec);
      else if (b.section === 'B2CL') idx.b2cl.set(b.num, rec);
      else if (b.section === 'Export') idx.exp.set(b.num, rec);
      else if (b.section === 'CDNR') idx.cdnr.set(`${b.ctin}|${b.num}`, rec);
      else if (b.section === 'CDNUR') idx.cdnur.set(b.num, rec);
      else if (b.section === 'B2CS') idx.b2cs.set(`${mk}|${b.pos}|${b.rate}`, rec);
    }
  }

  for (const r of g1) {
    const label = monthLabel(r.meta);
    const raw = r.amendRaw;
    const src = {
      b2ba: zeroT(), cdnra: zeroT(), b2cla: zeroT(), b2csa: zeroT(),
      expa: zeroT(), cdnuraB2CL: zeroT(), cdnuraExp: zeroT(),
    };
    r.amendments = r.amendments || [];

    const record = (table, key, map, amdT, sign, bucket, info) => {
      const amended = {
        txval: r2(sign * amdT.txval), iamt: r2(sign * amdT.iamt), camt: r2(sign * amdT.camt),
        samt: r2(sign * amdT.samt), csamt: r2(sign * amdT.csamt),
      };
      const orig = key != null ? map.get(key) : null;
      const rec = {
        month: label, table, ctin: info.ctin || '', num: info.num || '', date: info.date || '',
        origNum: info.origNum || info.num || '', origMonth: orig ? orig.month : '',
        origTxval: orig ? orig.txval : null, amdTxval: amended.txval,
        d: null, applied: false,
      };
      if (orig) {
        rec.d = {
          txval: r2(amended.txval - orig.txval), iamt: r2(amended.iamt - orig.iamt),
          camt: r2(amended.camt - orig.camt), samt: r2(amended.samt - orig.samt),
          csamt: r2(amended.csamt - orig.csamt),
        };
        rec.applied = true;
        addT(bucket, rec.d);
        map.set(key, { ...amended, month: label });
      } else {
        rec.origMonth = info.origDate ? `not uploaded (orig. dt ${info.origDate})` : 'not uploaded';
        r.warnings.push(
          `${label}: ${table} amendment of ${rec.origNum}${info.ctin ? ' (' + info.ctin + ')' : ''} — original document not in the uploaded months (prior year / missing month). Its effect is NOT included; upload the original month's JSON too.`
        );
      }
      r.amendments.push(rec);
    };

    for (const party of raw.b2ba) for (const inv of party.inv || []) {
      record('B2BA', `${party.ctin}|${inv.oinum || inv.inum}`, idx.b2b, itemTotals(inv.itms), 1, src.b2ba,
        { ctin: party.ctin, num: inv.inum, date: inv.idt, origNum: inv.oinum || inv.inum, origDate: inv.oidt });
    }
    for (const grp of raw.b2cla) for (const inv of grp.inv || []) {
      record('B2CLA', inv.oinum || inv.inum, idx.b2cl, itemTotals(inv.itms), 1, src.b2cla,
        { num: inv.inum, date: inv.idt, origNum: inv.oinum || inv.inum, origDate: inv.oidt });
    }
    for (const grp of raw.expa) for (const inv of grp.inv || []) {
      record('EXPA', inv.oinum || inv.inum, idx.exp, itemTotals(inv.itms), 1, src.expa,
        { num: inv.inum, date: inv.idt, origNum: inv.oinum || inv.inum, origDate: inv.oidt });
    }
    for (const party of raw.cdnra) for (const nt of party.nt || []) {
      record('CDNRA', `${party.ctin}|${nt.ont_num || nt.nt_num}`, idx.cdnr, itemTotals(nt.itms), nt.ntty === 'D' ? 1 : -1, src.cdnra,
        { ctin: party.ctin, num: nt.nt_num, date: nt.nt_dt, origNum: nt.ont_num || nt.nt_num, origDate: nt.ont_dt || nt.nt_dt });
    }
    for (const nt of raw.cdnura) {
      record('CDNURA', nt.ont_num || nt.nt_num, idx.cdnur, itemTotals(nt.itms), nt.ntty === 'D' ? 1 : -1,
        /^EXP/.test(nt.typ || '') ? src.cdnuraExp : src.cdnuraB2CL,
        { num: nt.nt_num, date: nt.nt_dt, origNum: nt.ont_num || nt.nt_num, origDate: nt.ont_dt || nt.nt_dt });
    }
    for (const e of raw.b2csa) {
      const om = String(e.omon ?? '');
      let key = null;
      if (om.length >= 6) key = `${sortKeyMY(+om.slice(0, 2), +om.slice(-4))}|${e.pos}|${e.rt}`;
      else if (om) {
        const fyStart = parseInt(r.meta.fy, 10);
        key = `${sortKeyMY(+om, +om >= 4 ? fyStart : fyStart + 1)}|${e.pos}|${e.rt}`;
      }
      record('B2CSA', key, idx.b2cs,
        { txval: e.txval || 0, iamt: e.iamt || 0, camt: e.camt || 0, samt: e.samt || 0, csamt: e.csamt || 0 },
        1, src.b2csa, { num: '(consolidated)', origNum: `POS ${e.pos} @ ${e.rt}%`, origDate: om });
    }

    const tot = zeroT();
    for (const a of Object.values(src)) addT(tot, a);
    if (tot.txval || tot.iamt || tot.camt || tot.samt || tot.csamt) {
      const F = (a) => [r2(a.txval), r2(a.iamt), r2(a.camt), r2(a.samt), r2(a.csamt)];
      r.summary.b2b = r2(r.summary.b2b + src.b2ba.txval + src.cdnra.txval);
      r.summary.b2c = r2(r.summary.b2c + src.b2cla.txval + src.b2csa.txval + src.cdnuraB2CL.txval);
      r.summary.export = r2(r.summary.export + src.expa.txval + src.cdnuraExp.txval);
      r.summary.igst = r2(r.summary.igst + tot.iamt);
      r.summary.cgst = r2(r.summary.cgst + tot.camt);
      r.summary.sgst = r2(r.summary.sgst + tot.samt);
      r.summary.cess = r2(r.summary.cess + tot.csamt);
      r.summary.liabVal = r2(r.summary.liabVal + tot.txval);
      r.components.a9A_b2b = F(src.b2ba);
      r.components.cdnra = F(src.cdnra);
      r.components.a9A_b2cl = F(src.b2cla);
      r.components.a10 = F(src.b2csa);
      r.components.a9A_exp = F(src.expa);
      r.components.cdnura_b2cl = [r2(src.cdnuraB2CL.txval)];
      r.components.cdnura_expwop = [r2(src.cdnuraExp.txval)];
    }
  }
}

/* ---- party names: GST portal Search Taxpayer (services/searchtp) + cache ----
   The cache file (gstr1-party-names.json next to this script) is also a
   manual mapping — names typed there, or in the browser UI, are kept forever. */

const GST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function nameCacheFile() {
  return path.join(path.dirname(process.argv[1] || '.'), 'gstr1-party-names.json');
}
function configFile() {
  return path.join(path.dirname(process.argv[1] || '.'), 'gstr1-config.json');
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')) || {}; } catch { return {}; }
}
function saveConfig(cfg) {
  try { fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 1)); } catch { /* read-only folder */ }
}
// Cache values are { legal, trade } — legal name and trade name often differ.
// Old-format caches (plain strings) are read as the legal name.
const hasName = (v) => !!(v && (v.legal || v.trade));
function loadNameCache() {
  const names = new Map();
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(nameCacheFile(), 'utf8')))) {
      if (typeof v === 'string' && v) names.set(k, { legal: v, trade: '' });
      else if (v && typeof v === 'object' && (v.legal || v.trade)) names.set(k, { legal: v.legal || '', trade: v.trade || '' });
    }
  } catch { /* no cache yet */ }
  return names;
}
function saveNameCache(names) {
  try {
    fs.writeFileSync(nameCacheFile(), JSON.stringify(Object.fromEntries([...names].sort()), null, 1));
  } catch { /* read-only folder — cache skipped */ }
}

// Browser-like cookies for services.gst.gov.in (visit the searchtp page first)
async function gstSessionCookies() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch('https://services.gst.gov.in/services/searchtp', {
      signal: ctl.signal,
      headers: {
        'user-agent': GST_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
      },
    });
    clearTimeout(timer);
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    return setCookies.map((c) => c.split(';')[0]).join('; ');
  } catch {
    return '';
  }
}

/* Captcha-assisted Search Taxpayer — the portal's own pre-login flow, done
   from inside the tool: captcha image is shown in the UI, the user types it,
   and the portal returns the legal + trade name for that GSTIN. */
const captchaSessions = new Map(); // token -> { cookie, at }
function mergeCookies(base, setCookies) {
  const jar = new Map();
  for (const part of (base || '').split('; ').filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const sc of setCookies || []) {
    const kv = sc.split(';')[0];
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}
function pruneCaptchaSessions() {
  const now = Date.now();
  for (const [t, s] of captchaSessions) if (now - s.at > 5 * 60 * 1000) captchaSessions.delete(t);
}
async function newCaptcha() {
  pruneCaptchaSessions();
  const base = await gstSessionCookies();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  const res = await fetch('https://services.gst.gov.in/services/captcha?rnd=' + Math.random(), {
    signal: ctl.signal,
    headers: {
      'user-agent': GST_UA,
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin',
      referer: 'https://services.gst.gov.in/services/searchtp',
      ...(base ? { cookie: base } : {}),
    },
  });
  clearTimeout(timer);
  if (!res.ok) throw new Error('GST portal did not return a captcha (HTTP ' + res.status + ')');
  const cookie = mergeCookies(base, res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get('content-type') || '';
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
  const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
  if (!/^image\//i.test(ctype) && !isPng && !isJpg) {
    throw new Error('the GST portal blocked the automated captcha (anti-bot protection)');
  }
  const token = (globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  captchaSessions.set(token, { cookie, at: Date.now() });
  const ct = res.headers.get('content-type') || 'image/png';
  return { token, image: `data:${ct};base64,${buf.toString('base64')}` };
}
async function captchaSearch(token, gstin, captcha) {
  const sess = captchaSessions.get(token);
  if (!sess) throw new Error('captcha expired — load a fresh one');
  captchaSessions.delete(token);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  const res = await fetch('https://services.gst.gov.in/services/api/search/taxpayerDetails', {
    method: 'POST',
    signal: ctl.signal,
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      accept: 'application/json, text/plain, */*',
      'user-agent': GST_UA,
      referer: 'https://services.gst.gov.in/services/searchtp',
      cookie: sess.cookie,
    },
    body: JSON.stringify({ gstin, captcha }),
  });
  clearTimeout(timer);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON reply */ }
  if (data && (data.errorCode || data.errorMsg)) {
    throw new Error(data.errorMsg || (data.errorCode === 'SWEB_9000' ? 'wrong captcha — try again' : 'portal error ' + data.errorCode));
  }
  if (!res.ok) throw new Error('portal replied HTTP ' + res.status);
  const nm = findGstNames(data);
  if (!nm) throw new Error('portal reply had no name (wrong captcha?) — try again');
  const names = loadNameCache();
  names.set(gstin, { legal: nm.legal || '', trade: nm.trade || '' });
  saveNameCache(names);
  return { gstin, ...nm };
}

// Pull both names out of any API response shape: lgnm = legal, tradeNam = trade.
const findGstNames = (o) => {
  const out = { legal: '', trade: '' };
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (!out.legal && typeof x.lgnm === 'string' && x.lgnm) out.legal = x.lgnm;
    if (!out.trade && typeof x.tradeNam === 'string' && x.tradeNam) out.trade = x.tradeNam;
    if (!out.trade && typeof x.tradeName === 'string' && x.tradeName) out.trade = x.tradeName;
    if (out.legal && out.trade) return;
    for (const v of Object.values(x)) walk(v);
  };
  walk(o);
  return out.legal || out.trade ? out : null;
};

// Look up the given GSTINs: cache first, then the Search Taxpayer API.
// Returns { names: Map, unresolved: [gstin...] } and persists new finds.
async function lookupGstins(gstins) {
  const names = loadNameCache();
  const missing = gstins.filter((g) => !hasName(names.get(g)));
  const apiKeyEarly = (loadConfig().gstin_api_key || '').trim();
  if (missing.length && typeof fetch === 'function' && !apiKeyEarly) {
    // No GSP key configured — try the portal's anonymous API (often blocked).
    const cookie = await gstSessionCookies();
    const APIS = [
      (g) => ({ url: `https://services.gst.gov.in/services/api/search/taxpayerDetails?gstin=${g}`, method: 'GET' }),
      (g) => ({ url: `https://services.gst.gov.in/services/api/search/tp?gstin=${g}`, method: 'GET' }),
      (g) => ({ url: 'https://services.gst.gov.in/services/api/search/taxpayerDetails', method: 'POST', body: JSON.stringify({ gstin: g }) }),
    ];
    let api = null;
    let failures = 0;
    for (const g of missing) {
      if (!api && failures >= 3) break; // portal unreachable/blocked — stop trying
      let got = null;
      for (const t of api ? [api] : APIS) {
        try {
          const { url, method, body } = t(g);
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 8000);
          const res = await fetch(url, {
            method,
            body,
            signal: ctl.signal,
            headers: {
              accept: 'application/json, text/plain, */*',
              'user-agent': GST_UA,
              referer: 'https://services.gst.gov.in/services/searchtp',
              ...(body ? { 'content-type': 'application/json' } : {}),
              ...(cookie ? { cookie } : {}),
            },
          });
          clearTimeout(timer);
          if (!res.ok) continue;
          const n = findGstNames(await res.json());
          if (n) { got = n; api = t; break; }
        } catch { /* try next endpoint */ }
      }
      if (got) names.set(g, got);
      else failures++;
      await new Promise((r) => setTimeout(r, 250)); // be gentle to the portal
    }
    saveNameCache(names);
  }

  // GSP route: a GSTIN-verification API key (free tier is enough — names are
  // cached forever). Same direct fetch packages like CompuGST use. When a key
  // is configured it is used directly, skipping the flaky anonymous portal.
  const still = gstins.filter((g) => !hasName(names.get(g)));
  if (apiKeyEarly && still.length && typeof fetch === 'function') {
    const KEYED = [
      (g) => `https://sheet.gstincheck.co.in/check/${encodeURIComponent(apiKeyEarly)}/${g}`,
      (g) => `https://appyflow.in/api/verifyGST?key_secret=${encodeURIComponent(apiKeyEarly)}&gstNo=${g}`,
    ];
    let kapi = null;
    let kfail = 0;
    for (const g of still) {
      if (!kapi && kfail >= 3) break;
      let got = null;
      for (const t of kapi ? [kapi] : KEYED) {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 10000);
          const res = await fetch(t(g), { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': GST_UA } });
          clearTimeout(timer);
          if (!res.ok) continue;
          const n = findGstNames(await res.json());
          if (n) { got = n; kapi = t; break; }
        } catch { /* try next provider */ }
      }
      if (got) names.set(g, got);
      else kfail++;
      await new Promise((r) => setTimeout(r, 200));
    }
    saveNameCache(names);
  }
  return { names, unresolved: gstins.filter((g) => !hasName(names.get(g))) };
}

/* ---- free, no-signup name source: the portal's own GSTR-1/2B Excel ----
   The filed-return Excel downloaded from the GST portal (post-login) has a
   "Receiver Name" column next to each GSTIN. Drop that .xlsx into the tool
   and the names are imported into the cache — no API, no captcha. */

function unzipRead(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a valid Excel file');
  const count = buf.readUInt16LE(e + 10);
  let off = buf.readUInt32LE(e + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lnl = buf.readUInt16LE(lho + 26);
    const lel = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnl + lel;
    entries.set(name, { method, raw: buf.subarray(dataStart, dataStart + csize) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const en = entries.get(name);
    if (!en) return null;
    return en.method === 8 ? zlib.inflateRawSync(en.raw) : Buffer.from(en.raw);
  };
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function xlsxSheetRows(xml, shared) {
  const colIndex = (ref) => {
    let n = 0;
    for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c([^>]*)\/>|<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1] || cm[2] || '';
      const inner = cm[3] || '';
      const ref = (attrs.match(/r="([A-Z]+)\d+"/) || [])[1];
      const col = ref ? colIndex(ref) : row.length;
      const t = (attrs.match(/t="(\w+)"/) || [])[1];
      let val;
      if (t === 's') val = shared[+((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] ?? -1)] ?? '';
      else if (t === 'inlineStr') val = (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '';
      else val = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
      row[col] = unxml(String(val));
    }
    rows.push(row);
  }
  return rows;
}

// GSTIN -> party name pairs from any GST-portal Excel (GSTR-1 filed, GSTR-2B, ...)
function extractNamesFromXlsx(buf) {
  const read = unzipRead(buf);
  const shared = [];
  const ss = read('xl/sharedStrings.xml');
  if (ss) {
    for (const si of ss.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join(''));
    }
  }
  const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z0-9]{2}$/;
  const pairs = new Map();
  for (let i = 1; i <= 50; i++) {
    const x = read(`xl/worksheets/sheet${i}.xml`);
    if (!x) break;
    const rows = xlsxSheetRows(x.toString('utf8'), shared);
    let gcol = -1;
    let ncol = -1;
    for (const row of rows) {
      const gi = row.findIndex((c) => typeof c === 'string' && /GSTIN\s*\/?\s*UIN|GSTIN of/i.test(c));
      const ni = row.findIndex((c) => typeof c === 'string' && /Receiver Name|Party Name|Name of (the )?Recipient|Trade\/Legal name/i.test(c));
      if (gi >= 0 && ni >= 0) { gcol = gi; ncol = ni; continue; }
      if (gcol < 0) continue;
      const g = String(row[gcol] || '').trim().toUpperCase();
      const n = String(row[ncol] || '').trim();
      if (GSTIN_RE.test(g) && n && !pairs.has(g)) pairs.set(g, n);
    }
  }
  return pairs;
}

// Merge Excel-sourced names into the permanent cache; returns how many were new.
function importNamesFromXlsx(buf) {
  const pairs = extractNamesFromXlsx(buf);
  if (!pairs.size) return 0;
  const names = loadNameCache();
  let added = 0;
  for (const [g, n] of pairs) {
    if (!hasName(names.get(g))) {
      names.set(g, { legal: n, trade: '' });
      added++;
    }
  }
  if (added) saveNameCache(names);
  return added;
}

const isXlsxFile = (name, buf) => /\.xlsx$/i.test(name) || (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && !/\.(json|pdf)$/i.test(name));

function collectGstins(results) {
  const wanted = new Set();
  for (const r of results) {
    if (r.kind === 'gstr3b') continue;
    for (const b of r.bills || []) if (b.ctin) wanted.add(b.ctin);
    for (const a of r.amendments || []) if (a.ctin) wanted.add(a.ctin);
  }
  return [...wanted].sort();
}

async function fetchPartyNames(results) {
  const { names } = await lookupGstins(collectGstins(results));
  for (const r of results) {
    if (r.kind !== 'gstr3b' && r.meta.gstin && r.meta.legalName && !hasName(names.get(r.meta.gstin))) {
      names.set(r.meta.gstin, { legal: r.meta.legalName, trade: '' });
    }
  }
  return names;
}

// Month-wise pairing of GSTR-1 and GSTR-3B results for the difference view.
function buildComparison(results) {
  const byLabel = new Map();
  const slot = (meta) => {
    const label = monthLabel(meta);
    if (!byLabel.has(label)) byLabel.set(label, { label, key: sortKey(meta) });
    return byLabel.get(label);
  };
  for (const r of results) {
    const s = slot(r.meta);
    if (r.kind === 'gstr3b') s.g3b = s.g3b || r;
    else s.g1 = s.g1 || r;
  }
  return [...byLabel.values()]
    .filter((s) => s.g1 || s.g3b)
    .sort((a, b) => a.key - b.key);
}

const g1Totals = (r) => ({
  value: r.summary.liabVal, igst: r.summary.igst, cgst: r.summary.cgst,
  sgst: r.summary.sgst, cess: r.summary.cess,
});

function comparisonWarnings(cmp) {
  const haveG1 = cmp.some((s) => s.g1);
  const haveG3 = cmp.some((s) => s.g3b);
  const out = [];
  for (const s of cmp) {
    if (!s.g1 && haveG1) out.push(`${s.label}: GSTR-3B uploaded but no GSTR-1 — difference not computed.`);
    if (!s.g3b && haveG3) out.push(`${s.label}: GSTR-1 uploaded but no GSTR-3B — difference not computed.`);
  }
  return out;
}

/* ---- month ordering / labels ---- */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(meta) {
  const mi = MONTHS.indexOf(meta.period);
  const fyStart = parseInt(meta.fy, 10);
  if (mi < 0 || !fyStart) return `${meta.period} ${meta.fy}`.trim();
  const year = mi >= 3 ? fyStart : fyStart + 1; // Apr-Dec -> FY start year, Jan-Mar -> +1
  return `${MONTHS[mi].slice(0, 3)}-${year}`;
}
function sortKey(meta) {
  const mi = MONTHS.indexOf(meta.period);
  const fyStart = parseInt(meta.fy, 10) || 0;
  const fiscalMonth = mi < 0 ? 0 : (mi + 9) % 12; // April = 0 ... March = 11
  return fyStart * 100 + fiscalMonth;
}
// Same key from a 1-based calendar month + calendar year (for amendment "omon" refs)
function sortKeyMY(month1, calYear) {
  const fyStart = month1 >= 4 ? calYear : calYear - 1;
  return fyStart * 100 + ((month1 + 8) % 12);
}

function fmtIN(n) {
  const neg = n < 0;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  let s = int.length > 3 ? int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + int.slice(-3) : int;
  return (neg ? '-' : '') + s + '.' + dec;
}

/* ======================================================================== *
 *  Part 3 — XLSX writer (no dependencies: a stored zip of OOXML parts)
 * ======================================================================== */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let x = n;
    for (let k = 0; k < 8; k++) x = x & 1 ? 0xedb88320 ^ (x >>> 1) : x >>> 1;
    t[n] = x >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i) => {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
};

// cell: {v: number|string, s: styleIndex}
function sheetXml(rows, { colWidths = [], merges = [] } = {}) {
  const cols = colWidths.length
    ? '<cols>' + colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
    : '';
  const body = rows
    .map((cells, r) => {
      const cs = cells
        .map((cell, ci) => {
          if (cell == null) return '';
          const ref = `${colName(ci)}${r + 1}`;
          const s = cell.s ? ` s="${cell.s}"` : '';
          if (cell.v == null || cell.v === '') return `<c r="${ref}"${s}/>`;
          if (typeof cell.v === 'number') return `<c r="${ref}"${s}><v>${cell.v}</v></c>`;
          return `<c r="${ref}"${s} t="inlineStr"><is><t>${xesc(cell.v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cs}</row>`;
    })
    .join('');
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">` + merges.map((m) => `<mergeCell ref="${m}"/>`).join('') + '</mergeCells>'
    : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    cols + `<sheetData>${body}</sheetData>` + mergeXml + '</worksheet>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="[&gt;=10000000]##\\,##\\,##\\,##0.00;[&gt;=100000]##\\,##\\,##0.00;#,##0.00"/></numFmts>' +
  '<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FFC00000"/><name val="Calibri"/></font></fonts>' +
  '<fills count="5">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC000"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right>' +
  '<top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="8">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  // 1: merged title — bold 12, orange, centred, bordered
  '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
  // 2: column header — bold, orange, centred, bordered
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
  // 3: month cell — centred, bordered
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>' +
  // 4: amount — Indian format, bordered
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>' +
  // 5: workings header — bold, grey, wrapped, bordered
  '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  // 6: text cell — bordered
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
  // 7: bold amount — Indian format, bordered
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +
  // 8: red bold amount — for non-zero differences
  '<xf numFmtId="164" fontId="3" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>' +
  // 9: yellow header — GSTR-3B block
  '<xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

function buildXlsx(results, names = new Map()) {
  const sorted = [...results].filter((r) => r.kind !== 'gstr3b').sort((a, b) => sortKey(a.meta) - sortKey(b.meta));
  const cmp = buildComparison(results);

  // The GSTR-1 monthly figures appear in the comparison sheet's orange block;
  // no separate "As Per GSTR1" sheet is produced.

  // Sheet 2 — workings: every component figure per month
  const W = [
    ['Month', (r) => monthLabel(r.meta), 'text'],
    ['GSTIN', (r) => r.meta.gstin, 'text'],
    ['Legal name', (r) => r.meta.legalName, 'text'],
    ['ARN', (r) => r.meta.arn, 'text'],
    ['ARN date', (r) => r.meta.arnDate, 'text'],
    ['4A B2B Regular', (r) => val(r, 't4A')],
    ['4B B2B Reverse charge', (r) => val(r, 't4B')],
    ['9A B2B amendments (net)', (r) => val(r, 'a9A_b2b') + val(r, 'a9A_b2bRC')],
    ['9B CDNR (net)', (r) => val(r, 'cdnr')],
    ['9C CDNRA (net)', (r) => val(r, 'cdnra')],
    ['B2B (net)', (r) => r.summary.b2b, 'bold'],
    ['5 B2CL (Large)', (r) => val(r, 't5')],
    ['7 B2CS (Others)', (r) => val(r, 't7')],
    ['10 B2C amendments (net)', (r) => val(r, 'a10')],
    ['9A B2CL amendments (net)', (r) => val(r, 'a9A_b2cl')],
    ['CDNUR/CDNURA - B2CL', (r) => val(r, 'cdnur_b2cl') + val(r, 'cdnura_b2cl')],
    ['B2C (net)', (r) => r.summary.b2c, 'bold'],
    ['6A Exports', (r) => val(r, 't6A')],
    ['9A Export amendments (net)', (r) => val(r, 'a9A_exp')],
    ['CDNUR/CDNURA - Exports', (r) => val(r, 'cdnur_expwp') + val(r, 'cdnur_expwop') + val(r, 'cdnura_expwp') + val(r, 'cdnura_expwop')],
    ['Export (net)', (r) => r.summary.export, 'bold'],
    ['6B SEZ supplies', (r) => val(r, 't6B')],
    ['6C Deemed exports', (r) => val(r, 't6C')],
    ['Total Liability value', (r) => r.summary.liabVal, 'bold'],
    ['IGST', (r) => r.summary.igst, 'bold'],
    ['CGST', (r) => r.summary.cgst, 'bold'],
    ['SGST', (r) => r.summary.sgst, 'bold'],
    ['Cess', (r) => r.summary.cess],
    ['Source file', (r) => r.fileName, 'text'],
  ];
  function val(r, key) {
    return r.components[key] ? r.components[key][0] : 0;
  }
  const s2rows = W.map(([label, fn, kind]) => [
    { v: label, s: 5 },
    ...sorted.map((r) => {
      const v = fn(r);
      if (kind === 'text') return { v, s: 6 };
      return { v: r2(v), s: kind === 'bold' ? 7 : 4 };
    }),
  ]);
  const sheet2 = sheetXml(s2rows, { colWidths: [26, ...sorted.map(() => 16)] });

  const sheets = [];

  // GSTR-1 vs GSTR-3B difference sheet — one row per month:
  // yellow 3B block (3.1a | 3.1b export | taxes), orange GSTR-1 block, then Difference 3B − 1
  if (cmp.length) {
    const rows = [
      [
        { v: 'Month', s: 5 },
        { v: 'As Per GSTR3B', s: 9 }, { s: 9 }, { s: 9 }, { s: 9 }, { s: 9 },
        { v: 'As Per GSTR1', s: 1 }, { s: 1 }, { s: 1 }, { s: 1 }, { s: 1 }, { s: 1 },
        { v: 'Difference 3B - 1', s: 5 }, { s: 5 }, { s: 5 }, { s: 5 },
      ],
      [
        { s: 5 },
        ...['B2B + B2C', 'Export', 'IGST', 'CGST', 'SGST'].map((h) => ({ v: h, s: 9 })),
        ...['B2B', 'B2C', 'Export', 'IGST', 'CGST', 'SGST'].map((h) => ({ v: h, s: 2 })),
        ...['Taxable Value', 'IGST', 'CGST', 'SGST'].map((h) => ({ v: h, s: 5 })),
      ],
    ];
    const dCell = (d) => ({ v: d, s: Math.abs(d) <= 0.05 ? 7 : 8 });
    for (const s of cmp) {
      const g1 = s.g1 ? s.g1.summary : null;
      const g3 = s.g3b || null;
      const row = [{ v: s.label, s: 3 }];
      if (g3) {
        row.push(
          { v: r2(g3.r31.a[0]), s: 4 }, { v: r2(g3.r31.b[0]), s: 4 },
          { v: g3.summary3b.igst, s: 4 }, { v: g3.summary3b.cgst, s: 4 }, { v: g3.summary3b.sgst, s: 4 },
        );
      } else {
        row.push({ v: 'not uploaded', s: 3 }, { s: 3 }, { s: 3 }, { s: 3 }, { s: 3 });
      }
      if (g1) {
        row.push(
          { v: g1.b2b, s: 4 }, { v: g1.b2c, s: 4 }, { v: g1.export, s: 4 },
          { v: g1.igst, s: 4 }, { v: g1.cgst, s: 4 }, { v: g1.sgst, s: 4 },
        );
      } else {
        row.push({ v: 'not uploaded', s: 3 }, { s: 3 }, { s: 3 }, { s: 3 }, { s: 3 }, { s: 3 });
      }
      if (g1 && g3) {
        row.push(
          dCell(r2(g3.summary3b.value - (g1.b2b + g1.b2c + g1.export))),
          dCell(r2(g3.summary3b.igst - g1.igst)),
          dCell(r2(g3.summary3b.cgst - g1.cgst)),
          dCell(r2(g3.summary3b.sgst - g1.sgst)),
        );
      } else {
        row.push({ s: 3 }, { s: 3 }, { s: 3 }, { s: 3 });
      }
      rows.push(row);
    }
    sheets.push({
      name: 'GSTR-1 vs 3B',
      xml: sheetXml(rows, {
        colWidths: [11, 14, 12, 12, 12, 12, 14, 14, 12, 12, 12, 12, 14, 11, 11, 11],
        merges: ['A1:A2', 'B1:F1', 'G1:L1', 'M1:P1'],
      }),
    });
  }

  // RCM reconciliation from GSTR-3B — liability declared in 3.1(d) vs ITC
  // availed on reverse charge in Table 4A(2) import of services + 4A(3)
  const g3bAll = [...results].filter((r) => r.kind === 'gstr3b').sort((a, b) => sortKey(a.meta) - sortKey(b.meta));
  if (g3bAll.some((r) => r.r31.d.some((x) => x) || r.itcRcm.imp.some((x) => x) || r.itcRcm.inw.some((x) => x))) {
    const rows = [
      [
        { v: 'Month', s: 5 },
        { v: 'RCM Liability — 3.1(d)', s: 9 }, { s: 9 }, { s: 9 }, { s: 9 }, { s: 9 },
        { v: 'RCM ITC availed — 4A(2)+4A(3)', s: 1 }, { s: 1 }, { s: 1 }, { s: 1 },
        { v: 'Difference ITC - Liability', s: 5 }, { s: 5 }, { s: 5 }, { s: 5 },
      ],
      [
        { s: 5 },
        ...['Taxable Value', 'IGST', 'CGST', 'SGST', 'Cess'].map((h) => ({ v: h, s: 9 })),
        ...['IGST', 'CGST', 'SGST', 'Cess'].map((h) => ({ v: h, s: 2 })),
        ...['IGST', 'CGST', 'SGST', 'Cess'].map((h) => ({ v: h, s: 5 })),
      ],
    ];
    const tot = { d: [0, 0, 0, 0, 0], itc: [0, 0, 0, 0], diff: [0, 0, 0, 0] };
    const dCell = (d) => ({ v: r2(d), s: Math.abs(d) <= 0.05 ? 7 : 8 });
    for (const r of g3bAll) {
      const d = r.r31.d;
      const itc = [0, 1, 2, 3].map((i) => r2(r.itcRcm.imp[i] + r.itcRcm.inw[i]));
      const diff = [0, 1, 2, 3].map((i) => r2(itc[i] - d[i + 1]));
      d.forEach((x, i) => { tot.d[i] += x; });
      itc.forEach((x, i) => { tot.itc[i] += x; });
      diff.forEach((x, i) => { tot.diff[i] += x; });
      rows.push([
        { v: monthLabel(r.meta), s: 3 },
        ...d.map((x) => ({ v: r2(x), s: 4 })),
        ...itc.map((x) => ({ v: x, s: 4 })),
        ...diff.map((x) => dCell(x)),
      ]);
    }
    rows.push([
      { v: 'Total', s: 5 },
      ...tot.d.map((x) => ({ v: r2(x), s: 7 })),
      ...tot.itc.map((x) => ({ v: r2(x), s: 7 })),
      ...tot.diff.map((x) => dCell(x)),
    ]);
    sheets.push({
      name: 'RCM Reco (3B)',
      xml: sheetXml(rows, {
        colWidths: [11, 14, 12, 12, 12, 10, 12, 12, 12, 10, 12, 12, 12, 10],
        merges: ['A1:A2', 'B1:F1', 'G1:J1', 'K1:N1'],
      }),
    });
  }

  sheets.push({ name: 'Workings', xml: sheet2 });

  // Section-wise sheets across the whole year: all months' bills of one
  // section per sheet, with a subtotal per month and a grand total.
  const SECTION_SHEETS = [
    { name: 'B2B Bills', sections: ['B2B'], gstin: true },
    { name: 'B2B Credit-Debit Notes', sections: ['CDNR'], gstin: true },
    { name: 'Export Bills', sections: ['Export'], gstin: false },
    { name: 'B2C Large (B2CL)', sections: ['B2CL'], gstin: false },
    { name: 'B2C Others (B2CS)', sections: ['B2CS'], gstin: false },
    { name: 'CDNUR Notes', sections: ['CDNUR'], gstin: false },
    { name: 'Advances', sections: ['Advances (11A)', 'Advances adjusted (11B)'], gstin: false },
  ];
  const NUMK = ['txval', 'igst', 'cgst', 'sgst', 'cess', 'val'];
  for (const def of SECTION_SHEETS) {
    const perMonth = sorted
      .map((r) => ({ label: monthLabel(r.meta), group: (r.bills || []).filter((b) => def.sections.includes(b.section)) }))
      .filter((m) => m.group.length);
    if (!perMonth.length) continue;
    const lead = def.gstin
      ? ['Month', 'Party GSTIN', 'Legal Name', 'Trade Name', 'Invoice/Note No', 'Date', 'POS', 'Type', 'Rate %']
      : ['Month', 'Invoice/Note No', 'Date', 'POS', 'Type', 'Rate %'];
    const leadN = lead.length;
    const rows = [[...lead, 'Taxable Value', 'IGST', 'CGST', 'SGST', 'Cess', 'Invoice Value'].map((h) => ({ v: h, s: 2 }))];
    const grand = Object.fromEntries(NUMK.map((k) => [k, 0]));
    for (const m of perMonth) {
      for (const b of m.group) {
        for (const k of NUMK) { grand[k] += b[k]; }
        const nm = names.get(b.ctin) || {};
        const cells = def.gstin
          ? [{ v: m.label, s: 3 }, { v: b.ctin, s: 6 }, { v: nm.legal || '', s: 6 }, { v: nm.trade || '', s: 6 },
             { v: b.num, s: 6 }, { v: b.date, s: 3 }, { v: b.pos, s: 3 }, { v: b.type, s: 6 }, { v: b.rate, s: 3 }]
          : [{ v: m.label, s: 3 }, { v: b.num, s: 6 }, { v: b.date, s: 3 }, { v: b.pos, s: 3 }, { v: b.type, s: 6 }, { v: b.rate, s: 3 }];
        rows.push([...cells, ...NUMK.map((k) => ({ v: b[k], s: 4 }))]);
      }
    }
    rows.push([
      { v: 'Grand Total', s: 5 }, ...Array.from({ length: leadN - 1 }, () => ({ s: 5 })),
      ...NUMK.map((k) => ({ v: r2(grand[k]), s: 7 })),
    ]);
    const widths = def.gstin
      ? [11, 18, 28, 24, 18, 12, 6, 14, 8, 14, 12, 12, 12, 10, 14]
      : [11, 18, 12, 6, 14, 8, 14, 12, 12, 12, 10, 14];
    sheets.push({ name: def.name, xml: sheetXml(rows, { colWidths: widths }) });
  }

  // Amendments sheet — every amended document listed separately with its
  // original month/value and the differential effect applied to the summary.
  const amendAll = sorted.flatMap((r) => r.amendments || []);
  if (amendAll.length) {
    const rows = [[
      ...['Month', 'Table', 'Party GSTIN', 'Legal Name', 'Trade Name', 'Doc No', 'Date', 'Amends', 'Original Month',
        'Original Taxable', 'Amended Taxable', 'Effect Taxable', 'Effect IGST', 'Effect CGST', 'Effect SGST', 'Status']
        .map((h) => ({ v: h, s: 2 })),
    ]];
    const tot = zeroT();
    for (const a of amendAll) {
      if (a.d) addT(tot, a.d);
      const nm = names.get(a.ctin) || {};
      rows.push([
        { v: a.month, s: 3 }, { v: a.table, s: 3 }, { v: a.ctin, s: 6 }, { v: nm.legal || '', s: 6 }, { v: nm.trade || '', s: 6 },
        { v: a.num, s: 6 }, { v: a.date, s: 3 }, { v: a.origNum, s: 6 }, { v: a.origMonth, s: 3 },
        a.origTxval == null ? { s: 6 } : { v: a.origTxval, s: 4 },
        { v: a.amdTxval, s: 4 },
        ...(a.d
          ? [{ v: a.d.txval, s: 4 }, { v: a.d.iamt, s: 4 }, { v: a.d.camt, s: 4 }, { v: a.d.samt, s: 4 }]
          : [{ s: 6 }, { s: 6 }, { s: 6 }, { s: 6 }]),
        { v: a.applied ? 'Applied in summary' : 'NOT applied — original not uploaded (prior year?)', s: a.applied ? 6 : 8 },
      ]);
    }
    rows.push([
      { v: 'Total effect applied', s: 5 }, ...Array.from({ length: 10 }, () => ({ s: 5 })),
      { v: r2(tot.txval), s: 7 }, { v: r2(tot.iamt), s: 7 }, { v: r2(tot.camt), s: 7 }, { v: r2(tot.samt), s: 7 },
      { s: 5 },
    ]);
    sheets.push({
      name: 'Amendments',
      xml: sheetXml(rows, { colWidths: [11, 9, 18, 26, 22, 16, 12, 16, 15, 14, 14, 14, 12, 12, 12, 34] }),
    });
  }

  const wb =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    sheets.map((s, i) => `<sheet name="${xesc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';
  const wbRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  return zipStore([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRels],
    ['xl/workbook.xml', wb],
    ['xl/_rels/workbook.xml.rels', wbRels],
    ['xl/styles.xml', STYLES_XML],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml]),
  ]);
}

/* ======================================================================== *
 *  Part 4 — CLI
 * ======================================================================== */

// Group parsed results by the return's own GSTIN — files of different
// clients can be mixed in one upload and each gets its own report.
// Amendments are matched to originals only within the same GSTIN.
function groupResults(results) {
  const m = new Map();
  for (const r of results) {
    const g = r.meta.gstin || 'UNKNOWN-GSTIN';
    if (!m.has(g)) m.set(g, []);
    m.get(g).push(r);
  }
  const groups = [];
  for (const [gstin, rs] of m) {
    rs.sort((a, b) => sortKey(a.meta) - sortKey(b.meta));
    applyAmendments(rs);
    groups.push({
      gstin,
      results: rs,
      legalName: (rs.find((r) => r.meta.legalName) || { meta: {} }).meta.legalName || '',
    });
  }
  groups.sort((a, b) => a.gstin.localeCompare(b.gstin));
  return groups;
}

async function runCli(args) {
  const files = [];
  let out = 'GSTR1-Summary.xlsx';
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--out') out = args[++i];
    else if (args[i] === '--json') json = true;
    else files.push(args[i]);
  }
  const results = [];
  for (const f of files) {
    try {
      const buf = fs.readFileSync(f);
      if (isXlsxFile(f, buf)) {
        console.error(`Names: imported ${importNamesFromXlsx(buf)} new party name(s) from ${path.basename(f)}`);
        continue;
      }
      results.push(parseAny(buf, path.basename(f)));
    } catch (e) {
      console.error(`ERROR ${f}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (!results.length) {
    console.error('No GSTR-1 / GSTR-3B files could be read.');
    process.exit(1);
  }
  const groups = groupResults(results);
  const names = await fetchPartyNames(results);
  const ctins = new Set(collectGstins(results));
  const unnamed = [...ctins].filter((g) => !hasName(names.get(g))).length;
  if (unnamed) console.error(`NOTE: could not fetch party names for ${unnamed} GSTIN(s) — set a free API key (browser UI → Party names) or type them once in gstr1-party-names.json.`);

  if (json) {
    console.log(JSON.stringify(groups.map((grp) => ({
      gstin: grp.gstin,
      legalName: grp.legalName,
      gstr1: grp.results.filter((r) => r.kind !== 'gstr3b').map((r) => ({ month: monthLabel(r.meta), ...r.summary })),
      gstr3b: grp.results.filter((r) => r.kind === 'gstr3b').map((r) => ({ month: monthLabel(r.meta), ...r.summary3b })),
    })), null, 2));
  }

  const printTable = (title, cols, rows) => {
    if (!rows.length) return;
    const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
    const line = (r) => r.map((v, i) => v.padStart(widths[i])).join('  ');
    console.log('\n' + title + '\n');
    console.log(line(cols));
    console.log(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const r of rows) console.log(line(r));
  };

  const written = [];
  for (const grp of groups) {
    const rs = grp.results;
    const g1 = rs.filter((r) => r.kind !== 'gstr3b');
    const cmp = buildComparison(rs);
    const warnings = [...rs.flatMap((r) => r.warnings), ...dupWarnings(rs), ...comparisonWarnings(cmp)];

    if (!json) {
      const who = `${grp.legalName || 'GSTIN'} ${grp.gstin}`.trim();
      if (groups.length > 1) console.log(`\n================ ${who} ================`);
      printTable(`As Per GSTR1  (${who})`, ['Month', 'B2B', 'B2C', 'Export', 'IGST', 'CGST', 'SGST'],
        g1.map((r) => [
          monthLabel(r.meta),
          fmtIN(r.summary.b2b), fmtIN(r.summary.b2c), fmtIN(r.summary.export),
          fmtIN(r.summary.igst), fmtIN(r.summary.cgst), fmtIN(r.summary.sgst),
        ]));
      printTable('GSTR-1 vs GSTR-3B  (difference = 3B − GSTR-1)',
        ['Month', '3B Value', 'GSTR-1 Value', 'Diff Value', 'Diff IGST', 'Diff CGST', 'Diff SGST'],
        cmp.filter((s) => s.g1 && s.g3b).map((s) => {
          const a = g1Totals(s.g1), b = s.g3b.summary3b;
          return [s.label, fmtIN(b.value), fmtIN(a.value),
            fmtIN(r2(b.value - a.value)), fmtIN(r2(b.igst - a.igst)), fmtIN(r2(b.cgst - a.cgst)), fmtIN(r2(b.sgst - a.sgst))];
        }));
      console.log('');
      const amendCount = g1.reduce((n, r) => n + (r.amendments || []).length, 0);
      if (amendCount) console.log(`Amendments found: ${amendCount} (see Amendments sheet)`);
    }

    const file = groups.length > 1 ? out.replace(/\.xlsx$/i, '') + `-${grp.gstin}.xlsx` : out;
    try {
      fs.writeFileSync(file, buildXlsx(rs, names));
    } catch (e) {
      console.error(`ERROR: could not write ${file} — ${e.code === 'EBUSY' || e.code === 'EPERM' ? 'close the file in Excel and run again.' : e.message}`);
      process.exit(1);
    }
    console.error(`Excel written: ${file}`);
    for (const w of warnings) console.error('NOTE: ' + w);
    written.push(file);
  }
  return written;
}

function openFile(p) {
  try {
    const child = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', p], { detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [p], { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* opening is best-effort */ });
    child.unref();
  } catch { /* opening is best-effort */ }
}

// Automation mode: process everything in the "GST Files" folder next to this
// script and open the resulting Excel — no browser, no clicking.
async function runAuto() {
  const dir = path.join(path.dirname(process.argv[1] || '.'), 'GST Files');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created the folder:\n  ${dir}\n\nPut the GST portal downloads in it — GSTR-1 JSON/PDF and GSTR-3B PDF,\nany months, any mix — then run this again. The report will be built and\nopened automatically.`);
    return;
  }
  const files = fs.readdirSync(dir)
    .filter((f) => /\.(pdf|json|xlsx)$/i.test(f) && !/^gstr1-(party-names|config)\.json$/i.test(f) && !/^GSTR-Report/i.test(f))
    .map((f) => path.join(dir, f));
  if (!files.length) {
    console.log(`No PDF/JSON files found in:\n  ${dir}\nPut the GST portal downloads there and run this again.`);
    return;
  }
  console.log(`Processing ${files.length} file(s) from ${dir} ...\n`);
  const out = path.join(dir, 'GSTR-Report.xlsx');
  const written = await runCli([...files, '-o', out]);
  for (const f of written || []) {
    console.log(`Opening ${path.basename(f)} ...`);
    openFile(f);
  }
}

/* ======================================================================== *
 *  Part 5 — local web UI
 * ======================================================================== */

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GSTR-1 → Excel summary</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; background: #f4f6f8; color: #1a2330; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 24px 16px 60px; }
  h1 { font-size: 22px; margin: 8px 0 4px; }
  .sub { color: #5b6a7c; font-size: 14px; margin-bottom: 20px; }
  .drop { border: 2px dashed #b8c4d0; border-radius: 12px; background: #fff; padding: 36px 20px; text-align: center; cursor: pointer; transition: border-color .15s, background .15s; }
  .drop.on { border-color: #e8901a; background: #fff8ec; }
  .drop b { color: #e8901a; }
  .files { margin: 14px 0 0; padding: 0; list-style: none; font-size: 14px; }
  .files li { background: #fff; border: 1px solid #e2e8ee; border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
  .files li .rm { color: #c0392b; cursor: pointer; border: none; background: none; font-size: 15px; }
  .btns { margin: 18px 0; display: flex; gap: 10px; flex-wrap: wrap; }
  button.primary { background: #e8901a; color: #fff; border: none; border-radius: 8px; padding: 10px 22px; font-size: 15px; font-weight: 600; cursor: pointer; }
  button.primary:disabled { background: #cfd8e0; cursor: default; }
  button.ghost { background: #fff; color: #1a2330; border: 1px solid #b8c4d0; border-radius: 8px; padding: 10px 18px; font-size: 15px; cursor: pointer; }
  table { border-collapse: collapse; background: #fff; font-size: 14px; width: 100%; }
  th, td { border: 1px solid #9aa7b4; padding: 6px 10px; text-align: right; white-space: nowrap; }
  th { background: #f6a821; font-weight: 700; text-align: center; }
  td:first-child { text-align: center; }
  .tablewrap { overflow-x: auto; margin-top: 8px; }
  .warn { background: #fff4e0; border: 1px solid #f0c36c; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-top: 14px; }
  .err { background: #fdecea; border: 1px solid #e6a19a; border-radius: 8px; padding: 10px 14px; font-size: 13px; margin-top: 14px; }
  .names { background: #fff; border: 1px solid #e2e8ee; border-radius: 10px; padding: 14px 16px; margin-top: 16px; }
  .names h2 { font-size: 16px; margin: 0 0 6px; }
  .names .row { display: flex; gap: 8px; align-items: center; margin: 5px 0; }
  .names .row code { font-size: 13px; min-width: 150px; }
  .names input[type=text] { flex: 1; padding: 6px 9px; border: 1px solid #b8c4d0; border-radius: 6px; font-size: 14px; }
  .names a { color: #e8901a; font-size: 13px; white-space: nowrap; }
  .names .ok { color: #1e7d32; font-size: 13px; }
  .privacy { font-size: 12px; color: #7d8b9a; margin-top: 30px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>GSTR-1 → Excel summary</h1>
  <div class="sub">Drop the monthly <b>GSTR-1 files</b> (GST portal download — PDF and/or JSON) and get the
  “As Per GSTR1” table — B2B / B2C / Export / IGST / CGST / SGST, one row per month — as an Excel file.<br>
  <b>JSON files also give section-wise bill sheets for the year</b> — B2B bills, B2B credit/debit notes,
  exports, B2C — with party GSTIN &amp; name, monthly subtotals, and a separate Amendments sheet whose
  effect is included in the summary.<br>
  <b>GSTR-3B PDFs</b> can be dropped too — you get a GSTR-1 vs GSTR-3B difference sheet
  (3B B2B+B2C and Export separately) and an RCM sheet from Table 3.1(d).</div>

  <div class="drop" id="drop">Drag &amp; drop GSTR-1 / GSTR-3B files here, or <b>click to choose</b><br><span style="font-size:13px;color:#7d8b9a">Tip: also drop the portal\u2019s filed-GSTR-1 <b>Excel</b> \u2014 party names are imported from it, free, no API needed</span>
    <input type="file" id="pick" accept=".pdf,.json,.xlsx" multiple hidden>
  </div>
  <ul class="files" id="list"></ul>

  <div class="btns">
    <button class="primary" id="go" disabled>Download Excel</button>
    <button class="ghost" id="clear">Clear</button>
  </div>

  <div id="out"></div>
  <div id="names"></div>

  <div class="privacy">Everything runs locally on this computer — the PDFs are parsed by the
  script you started and are never uploaded anywhere. Party-name lookups go directly from this
  computer to the GST portal (services.gst.gov.in) and are cached in gstr1-party-names.json.</div>
</div>
<script>
const files = [];
const drop = document.getElementById('drop');
const pick = document.getElementById('pick');
const list = document.getElementById('list');
const go = document.getElementById('go');
const out = document.getElementById('out');

drop.onclick = () => pick.click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('on'); };
drop.ondragleave = () => drop.classList.remove('on');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('on'); addFiles(e.dataTransfer.files); };
pick.onchange = () => addFiles(pick.files);
document.getElementById('clear').onclick = () => { files.length = 0; render(); out.innerHTML = ''; };

function addFiles(fl) {
  for (const f of fl) {
    if (!/\\.(pdf|json|xlsx)$/i.test(f.name)) continue;
    if (files.some(x => x.name === f.name && x.size === f.size)) continue;
    files.push(f);
  }
  render();
  if (files.length) preview();
}
function render() {
  list.innerHTML = '';
  files.forEach((f, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span>' + f.name + '</span>';
    const rm = document.createElement('button');
    rm.className = 'rm'; rm.textContent = '✕';
    rm.onclick = () => { files.splice(i, 1); render(); files.length ? preview() : out.innerHTML = ''; };
    li.appendChild(rm);
    list.appendChild(li);
  });
  go.disabled = !files.length;
}
async function payload() {
  const arr = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    arr.push({ name: f.name, dataB64: btoa(bin) });
  }
  return JSON.stringify({ files: arr });
}
async function preview() {
  out.innerHTML = '<div class="sub">Reading…</div>';
  try {
    const res = await fetch('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await payload() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'parse failed');
    let html = '';
    const groups = data.groups || [];
    if (groups.length > 1) {
      html += '<div class="sub">' + groups.length + ' GSTINs found \\u2014 each gets its own Excel file (downloaded together as a zip).</div>';
    }
    for (const grp of groups) {
      if (groups.length > 1) {
        html += '<h2 style="font-size:17px;margin:18px 0 6px">' + (grp.legalName ? grp.legalName + ' \\u2014 ' : '') + grp.gstin + '</h2>';
      }
      if (grp.rows.length) {
        html += '<div class="tablewrap"><table><tr><th></th><th colspan="6">As Per GSTR1</th></tr>' +
          '<tr><th>Month</th><th>B2B</th><th>B2C</th><th>Export</th><th>IGST</th><th>CGST</th><th>SGST</th></tr>';
        for (const r of grp.rows) {
          html += '<tr><td>' + r.month + '</td>' + [r.b2b, r.b2c, r.export, r.igst, r.cgst, r.sgst]
            .map(v => '<td>' + v + '</td>').join('') + '</tr>';
        }
        html += '</table></div>';
      }
      if ((grp.cmp || []).length) {
        html += '<div class="tablewrap" style="margin-top:14px"><table>' +
          '<tr><th></th><th colspan="6">GSTR-1 vs GSTR-3B (difference = 3B \\u2212 GSTR-1)</th></tr>' +
          '<tr><th>Month</th><th>3B Value</th><th>GSTR-1 Value</th><th>Diff Value</th><th>Diff IGST</th><th>Diff CGST</th><th>Diff SGST</th></tr>';
        for (const c of grp.cmp) {
          const style = c.mismatch ? ' style="color:#c00000;font-weight:600"' : '';
          html += '<tr><td>' + c.month + '</td>' + [c.g3b, c.g1, c.dv, c.di, c.dc, c.ds]
            .map(v => '<td' + style + '>' + v + '</td>').join('') + '</tr>';
        }
        html += '</table></div>';
      }
      const nBills = grp.rows.reduce((n, r) => n + (r.bills || 0), 0);
      const nAmend = grp.rows.reduce((n, r) => n + (r.amendments || 0), 0);
      if (nBills) {
        html += '<div class="sub" style="margin-top:8px">Excel will contain section-wise bill sheets (B2B, credit notes, exports, B2C) covering ' +
          nBills + ' documents' + (nAmend ? ' and an Amendments sheet (' + nAmend + ' amended documents)' : '') + '.</div>';
      }
      for (const w of grp.warnings || []) html += '<div class="warn">' + w + '</div>';
    }
    for (const n of data.notes || []) html += '<div class="warn" style="background:#eaf7ea;border-color:#9fd49f">' + n + '</div>';
    for (const e of data.errors || []) html += '<div class="err">' + e + '</div>';
    out.innerHTML = html;
    partyGstins = data.gstins || [];
    partyNames = data.names || {};
    hasApiKey = !!data.hasApiKey;
    renderNames();
  } catch (e) {
    out.innerHTML = '<div class="err">' + e.message + '</div>';
  }
}

let partyGstins = [], partyNames = {}, hasApiKey = false;
const namesDiv = document.getElementById('names');
function renderNames(msg) {
  if (!partyGstins.length) { namesDiv.innerHTML = ''; return; }
  const missing = partyGstins.filter(g => !partyNames[g]);
  let html = '<div class="names"><h2>Party names</h2>' +
    '<div class="sub">' + (partyGstins.length - missing.length) + ' of ' + partyGstins.length +
    ' GSTINs have names' + (missing.length ? ' \\u2014 click Fetch to get the rest automatically.' : '.') + '</div>';
  if (msg) html += '<div class="ok">' + msg + '</div>';
  if (missing.length) {
    html += '<div class="btns" style="margin:10px 0"><button class="primary" id="capStart">Fetch from GST portal (type captcha)</button>' +
      '<button class="ghost" id="fetchNames">Try without captcha</button>' +
      '<button class="ghost" id="saveNames">Save typed names</button></div>';
    html += '<div class="row"><code>API key' + (hasApiKey ? ' \\u2713' : '') + '</code>' +
      '<input type="text" id="apiKey" placeholder="' + (hasApiKey ? 'key saved \\u2014 paste a new one to replace' : 'free GSTIN API key \\u2014 makes fetching fully automatic') + '">' +
      '<a href="https://gstincheck.co.in" target="_blank" rel="noopener">get free key \\u2197</a></div>' +
      '<div class="sub" style="margin:2px 0 10px">One-time setup: sign up free at gstincheck.co.in (or appyflow.in), paste the key, press Save. ' +
      'After that every new GSTIN\\u2019s name is fetched automatically \\u2014 the same direct fetch GST softwares use. Names are cached forever.</div>';
    for (const g of missing) {
      html += '<div class="row"><code>' + g + '</code>' +
        '<input type="text" data-gstin="' + g + '" placeholder="party name (only if automatic fetch fails)">' +
        '<a href="https://services.gst.gov.in/services/searchtp" target="_blank" rel="noopener">search on portal \\u2197</a></div>';
    }
  }
  html += '</div>';
  namesDiv.innerHTML = html;
  const fetchBtn = document.getElementById('fetchNames');
  if (fetchBtn) fetchBtn.onclick = fetchNames;
  const saveBtn = document.getElementById('saveNames');
  if (saveBtn) saveBtn.onclick = saveNames;
  const capBtn = document.getElementById('capStart');
  if (capBtn) capBtn.onclick = capStart;
}

/* Captcha wizard: for each unnamed GSTIN the portal's captcha is shown,
   you type it, and the legal + trade name arrive and are saved. */
let capQueue = [], capData = null, capMsg = '';
async function capStart() { capMsg = ''; capQueue = partyGstins.filter(g => !partyNames[g]); await capNext(); }
async function capNext(sameGstin) {
  const g = sameGstin || capQueue[0];
  if (!g) { capData = null; renderNames('Portal fetching finished.'); return; }
  namesDiv.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    const res = await fetch('/api/captcha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'captcha failed');
    capData = { gstin: g, token: d.token, image: d.image };
    renderCap();
  } catch (e) {
    capData = null;
    renderNames('Could not load a captcha: ' + e.message + '. ' +
      'Best fix: get a free API key (link above), paste it in the API key box, press Save, then click \\u201CTry without captcha\\u201D \\u2014 names will come automatically. Or type names manually below.');
  }
}
function renderCap() {
  const done = partyGstins.filter(g => partyNames[g]).length;
  let html = '<div class="names"><h2>Party names \\u2014 fetching from GST portal</h2>' +
    '<div class="sub">' + done + ' of ' + partyGstins.length + ' done \\u00b7 now fetching <b>' + capData.gstin + '</b>' +
    ' \\u2014 type the captcha exactly as shown and press Enter.</div>' +
    (capMsg ? '<div class="ok">' + capMsg + '</div>' : '') +
    '<div class="row"><img src="' + capData.image + '" alt="captcha" style="height:44px;border:1px solid #b8c4d0;border-radius:6px">' +
    '<input type="text" id="capIn" placeholder="captcha" autocomplete="off" style="max-width:140px">' +
    '<button class="primary" id="capOk">OK</button>' +
    '<button class="ghost" id="capNew">New image</button>' +
    '<button class="ghost" id="capSkip">Skip</button>' +
    '<button class="ghost" id="capStop">Stop</button></div></div>';
  namesDiv.innerHTML = html;
  const inp = document.getElementById('capIn');
  inp.focus();
  inp.onkeydown = e => { if (e.key === 'Enter') capSubmit(); };
  document.getElementById('capOk').onclick = capSubmit;
  document.getElementById('capNew').onclick = () => { capMsg = ''; capNext(capData.gstin); };
  document.getElementById('capSkip').onclick = () => { capQueue = capQueue.filter(x => x !== capData.gstin); capMsg = ''; capNext(); };
  document.getElementById('capStop').onclick = () => { capData = null; capMsg = ''; renderNames(); };
}
async function capSubmit() {
  const code = document.getElementById('capIn').value.trim();
  if (!code) return;
  document.getElementById('capOk').disabled = true;
  try {
    const res = await fetch('/api/names/captcha-search', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: capData.token, gstin: capData.gstin, captcha: code }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'search failed');
    partyNames[capData.gstin] = { legal: d.legal || '', trade: d.trade || '' };
    capQueue = capQueue.filter(x => x !== capData.gstin);
    capMsg = '\\u2713 ' + capData.gstin + ': ' + (d.legal || d.trade);
    await capNext();
  } catch (e) {
    capMsg = capData.gstin + ': ' + e.message;
    await capNext(capData.gstin);
  }
}
async function saveKeyIfTyped() {
  const keyInput = document.getElementById('apiKey');
  const key = keyInput ? keyInput.value.trim() : '';
  if (!key) return false;
  await fetch('/api/names/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names: {}, apiKey: key }) });
  hasApiKey = true;
  return true;
}
async function fetchNames() {
  const btn = document.getElementById('fetchNames');
  btn.disabled = true; btn.textContent = 'Fetching\\u2026';
  try {
    await saveKeyIfTyped();
    const res = await fetch('/api/names/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gstins: partyGstins }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'lookup failed');
    Object.assign(partyNames, data.names || {});
    const still = (data.unresolved || []).length;
    renderNames(still ? 'Automatic lookup done \\u2014 ' + still + ' GSTIN(s) still unnamed. ' +
      (hasApiKey ? 'Type those below and press Save.' : 'Paste a free API key above (one-time) and press Fetch again, or type them below and press Save.') :
      'All names fetched and saved.');
  } catch (e) {
    renderNames('Lookup failed: ' + e.message + ' \\u2014 type the names below and press Save.');
  }
}
async function saveNames() {
  const keySaved = await saveKeyIfTyped();
  const typed = {};
  namesDiv.querySelectorAll('input[data-gstin]').forEach(i => { if (i.value.trim()) typed[i.dataset.gstin] = i.value.trim(); });
  if (!Object.keys(typed).length) { if (keySaved) renderNames('API key saved \\u2014 press \\u201CFetch names automatically\\u201D.'); return; }
  const res = await fetch('/api/names/save', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names: typed }) });
  if (res.ok) {
    Object.assign(partyNames, typed);
    renderNames(Object.keys(typed).length + ' name(s) saved' + (keySaved ? ' and API key stored' : '') + ' \\u2014 used in every future Excel.');
  }
}
go.onclick = async () => {
  go.disabled = true; go.textContent = 'Building…';
  try {
    const res = await fetch('/api/xlsx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: await payload() });
    if (!res.ok) throw new Error((await res.json()).error || 'failed');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const fname = (cd.match(/filename="([^"]+)"/) || [])[1] || 'GSTR1-Summary.xlsx';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    out.insertAdjacentHTML('beforeend', '<div class="err">' + e.message + '</div>');
  }
  go.disabled = false; go.textContent = 'Download Excel';
};
</script>
</body>
</html>`;

function parsePayload(body) {
  const { files } = JSON.parse(body);
  if (!Array.isArray(files) || !files.length) throw new Error('no files');
  const results = [];
  const errors = [];
  const notes = [];
  for (const f of files) {
    const buf = Buffer.from(f.dataB64, 'base64');
    try {
      if (isXlsxFile(f.name, buf)) {
        const added = importNamesFromXlsx(buf);
        notes.push(`${f.name}: imported ${added} new party name(s) from the Excel.`);
        continue;
      }
      results.push(parseAny(buf, f.name));
    } catch (e) {
      errors.push(`${f.name}: ${e.message}`);
    }
  }
  const groups = groupResults(results);
  return { results, groups, errors, notes };
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    if (req.method === 'POST' && (req.url === '/api/captcha' || req.url === '/api/names/captcha-search')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const result = req.url === '/api/captcha'
            ? await newCaptcha()
            : await captchaSearch(body.token, body.gstin, String(body.captcha || '').trim());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (req.method === 'POST' && (req.url === '/api/names/lookup' || req.url === '/api/names/save')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (req.url === '/api/names/save') {
            const names = loadNameCache();
            for (const [g, n] of Object.entries(body.names || {})) {
              const prev = names.get(g) || { legal: '', trade: '' };
              if (typeof n === 'string' && n.trim()) names.set(g, { ...prev, legal: n.trim() });
              else if (n && typeof n === 'object' && (n.legal || n.trade)) {
                names.set(g, { legal: (n.legal || prev.legal || '').trim(), trade: (n.trade || prev.trade || '').trim() });
              }
            }
            saveNameCache(names);
            if (typeof body.apiKey === 'string') {
              const cfg = loadConfig();
              cfg.gstin_api_key = body.apiKey.trim();
              saveConfig(cfg);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, saved: Object.keys(body.names || {}).length }));
          } else {
            const gstins = Array.isArray(body.gstins) ? body.gstins : [];
            const { names, unresolved } = await lookupGstins(gstins);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              names: Object.fromEntries(gstins.filter((g) => hasName(names.get(g))).map((g) => [g, names.get(g)])),
              unresolved,
            }));
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    if (req.method === 'POST' && (req.url === '/api/parse' || req.url === '/api/xlsx')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        try {
          const { results, groups, errors, notes } = parsePayload(Buffer.concat(chunks).toString('utf8'));
          if (req.url === '/api/parse') {
            const groupData = groups.map((grp) => {
              const rs = grp.results;
              const rows = rs.filter((r) => r.kind !== 'gstr3b').map((r) => ({
                month: monthLabel(r.meta),
                b2b: fmtIN(r.summary.b2b), b2c: fmtIN(r.summary.b2c), export: fmtIN(r.summary.export),
                igst: fmtIN(r.summary.igst), cgst: fmtIN(r.summary.cgst), sgst: fmtIN(r.summary.sgst),
                bills: r.bills ? r.bills.length : 0,
                amendments: r.amendments ? r.amendments.length : 0,
              }));
              const cmpData = buildComparison(rs);
              const cmp = cmpData.filter((s) => s.g1 && s.g3b).map((s) => {
                const a = g1Totals(s.g1), b = s.g3b.summary3b;
                return {
                  month: s.label, g3b: fmtIN(b.value), g1: fmtIN(a.value),
                  dv: fmtIN(r2(b.value - a.value)), di: fmtIN(r2(b.igst - a.igst)),
                  dc: fmtIN(r2(b.cgst - a.cgst)), ds: fmtIN(r2(b.sgst - a.sgst)),
                  mismatch: ['value', 'igst', 'cgst', 'sgst', 'cess'].some((k) => Math.abs(r2(b[k] - a[k])) > 0.05),
                };
              });
              return {
                gstin: grp.gstin, legalName: grp.legalName, rows, cmp,
                warnings: [...rs.flatMap((r) => r.warnings), ...dupWarnings(rs), ...comparisonWarnings(cmpData)],
              };
            });
            const gstins = collectGstins(results);
            const cached = loadNameCache();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              groups: groupData,
              gstins,
              names: Object.fromEntries(gstins.filter((g) => hasName(cached.get(g))).map((g) => [g, cached.get(g)])),
              hasApiKey: !!(loadConfig().gstin_api_key || '').trim(),
              errors,
              notes,
            }));
          } else {
            if (!results.length) throw new Error(errors.join('; ') || 'no readable GSTR-1 / GSTR-3B files');
            const names = await fetchPartyNames(results);
            if (groups.length === 1) {
              res.writeHead(200, {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': 'attachment; filename="GSTR1-Summary.xlsx"',
              });
              res.end(buildXlsx(groups[0].results, names));
            } else {
              // several GSTINs — one workbook per GSTIN, delivered as a zip
              const zip = zipStore(groups.map((grp) => [`GSTR-Report-${grp.gstin}.xlsx`, buildXlsx(grp.results, names)]));
              res.writeHead(200, {
                'Content-Type': 'application/zip',
                'Content-Disposition': 'attachment; filename="GSTR-Reports.zip"',
              });
              res.end(zip);
            }
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`\nThe tool is ALREADY running in another window.\nJust open  http://localhost:${PORT}  in your browser (opening it for you now).\nYou can close this window.`);
      openFile(`http://localhost:${PORT}`);
      return;
    }
    console.error(`\nCould not start: ${e.message}\nPlease send a photo of this window to get it fixed.`);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nGSTR-1 → Excel summary is RUNNING.\nKeep this window open while you use the tool.\n\nYour browser should open by itself; if not, open  http://localhost:${PORT}`);
    openFile(`http://localhost:${PORT}`);
  });
}

const argv = process.argv.slice(2);
if (argv.some((a) => /\.(pdf|json|xlsx)$/i.test(a))) await runCli(argv);
else if (argv.includes('--auto')) await runAuto();
else if (argv.includes('--serve') || argv.length === 0) startServer();
else {
  console.log('Usage:\n  node gstr1-excel-summary.mjs                 # browser UI at http://localhost:' + PORT +
    '\n  node gstr1-excel-summary.mjs --auto          # process everything in the "GST Files" folder and open the Excel' +
    '\n  node gstr1-excel-summary.mjs GSTR1.json GSTR3B.pdf -o out.xlsx   # command line\n  Options: --json (print JSON), -o/--out FILE');
}
