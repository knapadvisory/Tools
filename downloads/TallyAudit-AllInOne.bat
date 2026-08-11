@echo off
title Tally Statutory Audit Assistant
rem  ALL-IN-ONE launcher: the complete audit tool is embedded below the
rem  ::===PAYLOAD=== marker. Double-click me; I unpack tally-audit.mjs
rem  next to myself and start it. Safe to re-run - it re-unpacks each time.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   Install the LTS version from  https://nodejs.org  then run this again.
  echo.
  pause
  exit /b 1
)

echo   Unpacking the audit tool...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=Get-Content -LiteralPath '%~f0' -Encoding UTF8; $i=[array]::IndexOf($c,'::===PAYLOAD==='); if($i -lt 0){exit 1}; $c[($i+1)..($c.Length-1)] | Set-Content -LiteralPath 'tally-audit.mjs' -Encoding UTF8"
if not exist "tally-audit.mjs" goto exfail
for %%A in ("tally-audit.mjs") do if %%~zA LSS 50000 goto exfail

echo.
echo   Starting the Tally Statutory Audit Assistant...
echo   1. Keep Tally Prime OPEN with your company loaded.
echo   2. Your browser will open http://localhost:8789 automatically.
echo   3. CLOSE THIS WINDOW to stop the tool when you are done.
echo.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8789"
node tally-audit.mjs
pause
exit /b

:exfail
echo.
echo   Could not unpack tally-audit.mjs here. Either this folder does not
echo   allow creating files, or PowerShell is blocked on this computer.
echo   Copy this launcher to a local folder like C:\TallyAudit and try again.
echo.
pause
exit /b 1

::===PAYLOAD===
// Tally Statutory Audit Assistant — standalone, single file, zero dependencies.
// ---------------------------------------------------------------------------
// Connects to Tally Prime on this computer, reads EVERY ledger, group and
// voucher of the selected company for the audit period, and runs a statutory-
// audit test battery a Chartered Accountant would run on the books:
//
//   • Books integrity — duplicate/missing voucher numbers, cancelled and
//     optional vouchers, missing narrations, Sunday/holiday entries,
//     suspense-account usage, master-vs-computed balance mismatches.
//   • Trial balance — out-of-balance TB, wrong-side balances, P&L ledgers
//     carrying opening balances, dormant balances (SA 510 openings).
//   • Cash & bank — day-wise NEGATIVE CASH detection, cash payments above
//     ₹10,000 (Sec 40A(3)), cash receipts ≥ ₹2,00,000 (Sec 269ST), loans
//     accepted/repaid in cash ≥ ₹20,000 (Sec 269SS/269T), bank ledgers with
//     credit balances (OD/CC classification).
//   • Revenue & receivables — sales booked through Journal, duplicate invoice
//     numbers, gaps in the sales sequence, debtors with credit balances,
//     year-end sales clustering (cut-off risk), missing GSTINs.
//   • Purchases & payables — purchases via Journal, duplicate supplier bill
//     references, creditors with debit balances, MSME > 45-day ageing
//     (Sec 43B(h)), Schedule III ageing buckets from bill-wise data.
//   • Statutory dues — TDS/GST/PF/ESI ledger balances, wrong-side balances
//     under Duties & Taxes (CARO 3(vii) groundwork).
//   • SA 240 journal testing — round-sum entries, year-end journal
//     clustering, same-ledger-both-sides vouchers, Benford first-digit test.
//   • Companies Act — director/related-party ledgers (Sec 185/186/188,
//     AS 18/Ind AS 24), borrowings without interest, loans given without
//     interest income (Sec 186(7)), depreciation not booked.
//   • Analytics — auto materiality per ICAI benchmarks, key ratios, monthly
//     revenue/expense trend, biggest ledger movements.
//   • SA 530 sampling — key items above performance materiality plus a
//     random sample for vouching, exportable to CSV.
//   • A 10-phase statutory-audit checklist (appointment → AGM filing) with
//     the automated steps auto-ticked and the manual ones tracked on screen.
//   • A management-letter draft (audit observations) built from findings.
//
// Findings are graded High / Medium / Low / Info with the statute or
// Standard on Auditing reference on every check. Everything runs locally —
// the books never leave this machine.
//
// ONE-TIME SETUP
//   1. Install Node.js from https://nodejs.org (LTS).
//   2. In Tally Prime: F1 (Help) → Settings → Connectivity → Client/Server
//      configuration → "TallyPrime acts as" = Both, Port = 9000.
//      Keep the company open.
//   3. Run:  node tally-audit.mjs   then open http://localhost:8789
//
// Settings, checklist ticks and the last run summary are kept in
// tally-audit-data.json next to this file. Delete it to start fresh.
// ---------------------------------------------------------------------------

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.2';
const PORT = Number(process.env.PORT || 8789);
const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tally-audit-data.json');

// ------------------------------ local state ---------------------------------
const DEFAULT_STATE = {
  settings: {
    tallyUrl: 'http://localhost:9000',
    company: '', // only needed when more than one company is open in Tally
    fyFrom: '', // yyyy-mm-dd; blank = auto (last completed Indian FY)
    fyTo: '',
    // Materiality (ICAI Implementation Guide on Materiality benchmarks).
    materialityMode: 'auto', // auto = highest of the three benchmarks below
    materialityValue: 0, // used when materialityMode = 'manual'
    pctTurnover: 1, // % of turnover
    pctPBT: 5, // % of profit before tax
    pctAssets: 1, // % of total assets
    perfPct: 75, // performance materiality as % of overall
    trivialPct: 5, // clearly-trivial threshold as % of overall
    // Statutory thresholds (editable — law changes, the tool shouldn't).
    cashPaymentLimit: 10000, // Sec 40A(3)
    cashReceiptLimit: 200000, // Sec 269ST
    cashLoanLimit: 20000, // Sec 269SS / 269T
    msmeDays: 45, // Sec 15 MSMED / 43B(h)
    // Test tuning.
    narrationMin: 10000, // journals/payments above this need a narration
    roundUnit: 10000, // "round-sum" means a multiple of this…
    roundMin: 100000, // …at or above this amount
    yearEndDays: 7, // window treated as "year-end" for clustering tests
    dormantMin: 10000, // dormant-ledger balance worth reporting
    weeklyOff: 'sun', // sun | sat-sun | none
    holidays: '', // extra non-working dates, comma separated yyyy-mm-dd
    rptKeywords: 'director, relative, huf, holding, subsidiary, associate, sister concern, promoter, partner, proprietor',
    rptNames: '', // exact ledger names management declared as related parties
    msmeNames: '', // ledger names confirmed as MSME suppliers (else every old creditor is flagged "verify")
  },
  checklist: {}, // "company|fyFrom" -> { itemId: true }
  lastRun: null, // trimmed summary of the last audit run (for reload)
};

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      settings: { ...DEFAULT_STATE.settings, ...(raw.settings || {}) },
      checklist: raw.checklist || {},
      lastRun: raw.lastRun || null,
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}
let state = loadState();
function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 1));
}

// ------------------------------- helpers ------------------------------------
const r2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const norm = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
/** Word-boundary-safe "does the name contain this word" — 'TDS Payable' hits
 *  ' tds ', a supplier called 'Latds Traders' does not. */
const hasWord = (name, word) =>
  ` ${String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `.includes(` ${String(word).toLowerCase().trim()} `);
function decodeXml(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}
const escXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const escHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i'));
  return m ? decodeXml(m[1].trim()) : '';
};
/** Tally amount → number, keeping Tally's sign convention (credit +, debit −)
 *  and understanding "1,00,000.00 Dr" style values. */
function tallyAmt(v) {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const m = s.match(/(-?[\d,]+(?:\.\d+)?)\s*(dr|cr)?\.?\s*$/i);
  if (!m) return 0;
  let n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  if (m[2]) n = /^dr$/i.test(m[2]) ? -Math.abs(n) : Math.abs(n);
  return n;
}
/** Balance in DEBIT-POSITIVE terms (assets +, liabilities −) from a raw
 *  Tally balance string. */
const drBal = (v) => r2(-tallyAmt(v));
const inr = (n) => {
  const a = Math.abs(r2(n));
  const s = '₹' + a.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return n < 0 ? '−' + s : s;
};
const MONTH_NO = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Any Tally date form → UTC Date: 20250401, 2025-04-01, 1-Apr-2025, 01/04/2025. */
function anyDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})[A-Za-z]*-(\d{2,4})$/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    const mo = MONTH_NO[m[2].toLowerCase()];
    if (mo) return new Date(Date.UTC(y, mo - 1, +m[1]));
  }
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (m) return new Date(Date.UTC(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1]));
  return null;
}
const toTallyDate = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const iso = (d) => (d ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : '');
const disp = (d) => (d ? `${pad(d.getUTCDate())}-${MONTH_NAMES[d.getUTCMonth()]}-${d.getUTCFullYear()}` : '');
const isoToDate = (s) => anyDate(s);
const dayDiff = (a, b) => Math.round((b - a) / 86400000);
/** Last COMPLETED Indian financial year as of today. */
function defaultFY() {
  const now = new Date();
  const y = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return { from: `${y - 1}-04-01`, to: `${y}-03-31` };
}
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
/** GSTIN mod-36 check-digit validation (the 15th character). */
function gstinValid(g) {
  const s = String(g || '').toUpperCase().trim();
  if (!GSTIN_RE.test(s)) return false;
  const val = (c) => (c <= '9' ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55);
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = val(s[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  const check = (36 - (sum % 36)) % 36;
  return s[14] === (check < 10 ? String(check) : String.fromCharCode(55 + check));
}

// --------------------------- talking to Tally --------------------------------
async function askTally(body, timeoutMs = 300000) {
  const res = await fetch(state.settings.tallyUrl, {
    method: 'POST', body, headers: { 'content-type': 'text/xml' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Stream the reply so the on-screen byte counter moves WHILE Tally is
  // still sending — a multi-minute export no longer looks frozen.
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return res.text();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    progress.bytes += value.length;
  }
  return Buffer.concat(chunks).toString('utf8');
}
/** One retry with double the window — Tally often stalls on the first big
 *  export of a session while it warms its caches, then answers quickly. */
async function askTallyRetry(body, timeoutMs, label) {
  try { return await askTally(body, timeoutMs); }
  catch (e) {
    const s = String((e && e.name) || '') + ' ' + String((e && e.message) || '');
    if (!/timeout|abort/i.test(s)) throw e;
    progress.phase = label + ' — Tally is slow, retrying with a longer wait…';
    return askTally(body, timeoutMs * 2);
  }
}
function svCompany() {
  const c = (state.settings.company || '').trim();
  return c ? '<SVCURRENTCOMPANY>' + escXml(c) + '</SVCURRENTCOMPANY>' : '';
}
function svPeriod(from, to) {
  return `<SVFROMDATE>${toTallyDate(from)}</SVFROMDATE><SVTODATE>${toTallyDate(to)}</SVTODATE>`;
}
/** TDL collection request over master/voucher objects. */
function collectionRequest(id, type, methods, { from, to, fetch: fetches, company = true } = {}) {
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
    `<ID>${id}</ID></HEADER><BODY><DESC><STATICVARIABLES>` +
    '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
    (from && to ? svPeriod(from, to) : '') + (company ? svCompany() : '') +
    '</STATICVARIABLES><TDL><TDLMESSAGE>' +
    `<COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE>` +
    (methods || []).map((m) => `<NATIVEMETHOD>${m}</NATIVEMETHOD>`).join('') +
    (fetches || []).map((f) => `<FETCH>${f}</FETCH>`).join('') +
    '</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
}
function reportRequest(reportName, from, to) {
  return '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC>' +
    `<REPORTNAME>${reportName}</REPORTNAME><STATICVARIABLES>` +
    svPeriod(from, to) + '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' + svCompany() +
    '</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>';
}

// ------------------------------- parsers -------------------------------------
/** Object blocks of a collection reply: <LEDGER NAME="X">…</LEDGER> etc. */
function objBlocks(xml, objTag) {
  const re = new RegExp(`<${objTag}\\b([^>]*)>([\\s\\S]*?)</${objTag}>`, 'gi');
  const out = [];
  for (const m of xml.matchAll(re)) {
    const nameAttr = (m[1].match(/NAME="([^"]*)"/i) || [])[1];
    out.push({ name: nameAttr ? decodeXml(nameAttr) : '', body: m[2] });
  }
  return out;
}
function parseCompanies(xml) {
  return objBlocks(xml, 'COMPANY').map((b) => ({
    name: b.name || tag(b.body, 'NAME'),
    startingFrom: iso(anyDate(tag(b.body, 'STARTINGFROM'))),
  })).filter((c) => c.name);
}
function parseGroups(xml) {
  const out = new Map(); // norm(name) -> group
  for (const b of objBlocks(xml, 'GROUP')) {
    const name = b.name || tag(b.body, 'NAME');
    if (!name) continue;
    out.set(norm(name), {
      name,
      parent: tag(b.body, 'PARENT'),
      isRevenue: /yes/i.test(tag(b.body, 'ISREVENUE')),
      isDeemedPositive: /yes/i.test(tag(b.body, 'ISDEEMEDPOSITIVE')),
    });
  }
  return out;
}
function parseLedgers(xml) {
  const out = [];
  for (const b of objBlocks(xml, 'LEDGER')) {
    const name = b.name || tag(b.body, 'NAME');
    if (!name) continue;
    out.push({
      name,
      parent: tag(b.body, 'PARENT'),
      opening: drBal(tag(b.body, 'OPENINGBALANCE')),
      closing: drBal(tag(b.body, 'CLOSINGBALANCE')),
      gstin: (tag(b.body, 'PARTYGSTIN').toUpperCase().match(/[0-9A-Z]{15}/) || [''])[0],
      billwise: /yes/i.test(tag(b.body, 'ISBILLWISEON')),
    });
  }
  return out;
}
/** Voucher blocks → parsed vouchers. Cancelled/optional vouchers are KEPT and
 *  flagged — an audit reads them, a posting tool skips them. */
function parseVoucherXml(xml, seen = new Set()) {
  const out = [];
  let duplicates = 0;
  for (const m of xml.matchAll(/<VOUCHER\b[^>]*>([\s\S]*?)<\/VOUCHER>/gi)) {
    const block = m[1];
    const entries = [];
    for (const em of block.matchAll(/<(?:ALL)?LEDGERENTRIES\.LIST>([\s\S]*?)<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi)) {
      const e = em[1];
      const ledger = tag(e, 'LEDGERNAME');
      if (!ledger) continue;
      const raw = tallyAmt(tag(e, 'AMOUNT'));
      const deemed = tag(e, 'ISDEEMEDPOSITIVE');
      const isDr = deemed ? /yes/i.test(deemed) : raw < 0;
      const amt = Math.abs(raw);
      const bills = [...e.matchAll(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/gi)]
        .map((bm) => tag(bm[1], 'NAME')).filter(Boolean);
      entries.push({ ledger, dr: isDr ? amt : 0, cr: isDr ? 0 : amt, bills });
    }
    const date = anyDate(tag(block, 'DATE'));
    if (!date) continue;
    const v = {
      date,
      type: tag(block, 'VOUCHERTYPENAME'),
      number: tag(block, 'VOUCHERNUMBER'),
      reference: tag(block, 'REFERENCE'),
      narration: tag(block, 'NARRATION'),
      party: tag(block, 'PARTYLEDGERNAME') || tag(block, 'PARTYNAME'),
      guid: tag(block, 'GUID'),
      cancelled: /yes/i.test(tag(block, 'ISCANCELLED')),
      optional: /yes/i.test(tag(block, 'ISOPTIONAL')),
      alterId: Number(tag(block, 'ALTERID')) || 0,
      entries,
    };
    v.amount = r2(Math.max(v.entries.reduce((s, e) => s + e.dr, 0), v.entries.reduce((s, e) => s + e.cr, 0)));
    // Dedupe on GUID (content signature as fallback) — some Tally setups
    // return the same vouchers for every monthly chunk.
    const key = v.guid || `${v.type}|${v.number}|${iso(v.date)}|${norm(v.party)}|${v.entries.map((e) => e.dr - e.cr).join(',')}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    out.push(v);
  }
  return { vouchers: out, duplicates };
}
/** Bills Receivable / Bills Payable report → pending bills with age. The
 *  export lays BILLFIXED / BILLCL / BILLDUE out as SIBLING tags, so each
 *  BILLFIXED block is paired with whatever follows it up to the next one. */
function parseBills(xml) {
  const out = [];
  const parts = xml.split(/<BILLFIXED>/i).slice(1);
  for (const part of parts) {
    const [fixed, rest = ''] = part.split(/<\/BILLFIXED>/i);
    const date = anyDate(tag('<x>' + fixed + '</x>', 'BILLDATE'));
    const ref = tag('<x>' + fixed + '</x>', 'BILLREF') || tag('<x>' + fixed + '</x>', 'NAME');
    const party = tag('<x>' + fixed + '</x>', 'BILLPARTY');
    const head = rest.split(/<BILLFIXED>/i)[0];
    const cl = tallyAmt(tag('<x>' + head + '</x>', 'BILLCL'));
    const due = anyDate(tag('<x>' + head + '</x>', 'BILLDUE'));
    if (!date || !cl) continue;
    out.push({ date, ref, party, pending: Math.abs(cl), due });
  }
  return out;
}

// --------------------------- reading a company -------------------------------
const progress = {
  active: false, phase: '', step: 0, monthsDone: 0, monthsTotal: 0,
  vouchers: 0, bytes: 0, error: '', startedAt: 0,
};

/** Month-by-month voucher read (big books produce huge XML; chunking keeps
 *  each Tally export fast and each string small). */
async function readVouchers(from, to) {
  const seen = new Set();
  const all = [];
  let monthsTotal = 0;
  for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); d <= to;
       d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) monthsTotal++;
  progress.monthsTotal = monthsTotal;
  progress.monthsDone = 0;
  for (
    let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    d <= to;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  ) {
    const mFrom = d < from ? from : d;
    const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const mTo = mEnd > to ? to : mEnd;
    const xml = await askTallyRetry(collectionRequest('AuditVouchers', 'Voucher', [], {
      from: mFrom, to: mTo,
      fetch: ['DATE', 'GUID', 'VOUCHERTYPENAME', 'VOUCHERNUMBER', 'REFERENCE', 'NARRATION',
        'PARTYLEDGERNAME', 'ISCANCELLED', 'ISOPTIONAL', 'ALTERID', 'ALLLEDGERENTRIES.LIST'],
    }), 600000, 'Reading vouchers');
    const err = xml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i);
    if (err) throw new Error('Tally: ' + decodeXml(err[1].trim()));
    const r = parseVoucherXml(xml, seen);
    // Collections on some setups ignore the period — keep only in-range.
    for (const v of r.vouchers) if (v.date >= from && v.date <= to) all.push(v);
    progress.monthsDone++;
    progress.vouchers = all.length;
  }
  all.sort((a, b) => a.date - b.date || String(a.number).localeCompare(String(b.number)));
  return all;
}

// ------------------------- classification helpers ----------------------------
/** Voucher-type family from its (possibly custom) name. */
function vfamily(typeName) {
  const t = norm(typeName);
  if (t.includes('order') || t.includes('deliverynote') || t.includes('goodsreceipt') ||
      t.includes('stockjournal') || t.includes('physicalstock') || t.includes('memo') ||
      t.includes('reversing')) return 'other';
  if (t.includes('creditnote')) return 'creditnote';
  if (t.includes('debitnote')) return 'debitnote';
  if (t.includes('sales') || t.includes('sale')) return 'sales';
  if (t.includes('purchase')) return 'purchase';
  if (t.includes('receipt')) return 'receipt';
  if (t.includes('payment')) return 'payment';
  if (t.includes('contra')) return 'contra';
  return 'journal';
}
/** Tally's reserved primary groups: balance-sheet/P&L side and debit/credit
 *  nature — the fallback when a company's group masters don't say. */
const PRIMARY_GROUPS = {
  capitalaccount: { pl: 0, dr: 0 }, reservesandsurplus: { pl: 0, dr: 0 },
  loansliability: { pl: 0, dr: 0 }, securedloans: { pl: 0, dr: 0 }, unsecuredloans: { pl: 0, dr: 0 },
  bankodac: { pl: 0, dr: 0 }, bankoccac: { pl: 0, dr: 0 },
  currentliabilities: { pl: 0, dr: 0 }, sundrycreditors: { pl: 0, dr: 0 },
  dutiesandtaxes: { pl: 0, dr: 0 }, provisions: { pl: 0, dr: 0 },
  fixedassets: { pl: 0, dr: 1 }, investments: { pl: 0, dr: 1 },
  currentassets: { pl: 0, dr: 1 }, sundrydebtors: { pl: 0, dr: 1 },
  cashinhand: { pl: 0, dr: 1 }, bankaccounts: { pl: 0, dr: 1 },
  stockinhand: { pl: 0, dr: 1 }, depositsasset: { pl: 0, dr: 1 },
  loansandadvancesasset: { pl: 0, dr: 1 }, miscexpensesasset: { pl: 0, dr: 1 },
  suspenseac: { pl: 0, dr: 1 }, branchdivisions: { pl: 0, dr: 1 },
  salesaccounts: { pl: 1, dr: 0 }, directincomes: { pl: 1, dr: 0 }, indirectincomes: { pl: 1, dr: 0 },
  incomedirect: { pl: 1, dr: 0 }, incomeindirect: { pl: 1, dr: 0 },
  purchaseaccounts: { pl: 1, dr: 1 }, directexpenses: { pl: 1, dr: 1 }, indirectexpenses: { pl: 1, dr: 1 },
  expensesdirect: { pl: 1, dr: 1 }, expensesindirect: { pl: 1, dr: 1 },
};
const CAT_OF_GROUP = {
  cashinhand: 'cash', bankaccounts: 'bank', bankodac: 'bankod', bankoccac: 'bankod',
  sundrydebtors: 'debtor', sundrycreditors: 'creditor', dutiesandtaxes: 'duties',
  loansliability: 'loanLiab', securedloans: 'loanLiab', unsecuredloans: 'loanLiab',
  loansandadvancesasset: 'loanAsset', depositsasset: 'loanAsset',
  fixedassets: 'fixedAsset', stockinhand: 'stock', investments: 'investment',
  capitalaccount: 'capital', reservesandsurplus: 'capital', provisions: 'provision',
  currentassets: 'currentAsset', currentliabilities: 'currentLiab',
  salesaccounts: 'sales', purchaseaccounts: 'purchase',
  directexpenses: 'directExp', indirectexpenses: 'indirectExp',
  expensesdirect: 'directExp', expensesindirect: 'indirectExp',
};

// ------------------------------ audit context --------------------------------
function buildContext({ company, from, to, groups, ledgers, vouchers, billsRecv, billsPay, cfg }) {
  const ledByNorm = new Map(ledgers.map((l) => [norm(l.name), l]));
  const natCache = new Map();
  /** Ledger nature: BS/P&L side, debit/credit nature, group chain, category flags. */
  function nat(ledgerName) {
    const key = norm(ledgerName);
    if (natCache.has(key)) return natCache.get(key);
    const led = ledByNorm.get(key);
    const chain = [];
    let g = led ? led.parent : '';
    let pl = null, dr = null;
    for (let hop = 0; g && hop < 20; hop++) {
      chain.push(g);
      const gr = groups.get(norm(g));
      const prim = PRIMARY_GROUPS[norm(g)];
      if (prim) { if (pl === null) pl = !!prim.pl; if (dr === null) dr = !!prim.dr; }
      if (gr) {
        if (pl === null && gr.isRevenue !== undefined) pl = gr.isRevenue;
        if (dr === null && gr.isDeemedPositive !== undefined) dr = gr.isDeemedPositive;
        g = gr.parent && norm(gr.parent) !== norm(gr.name) ? gr.parent : '';
      } else g = '';
    }
    // Tally's reserved "Profit & Loss A/c" ledger sits at Primary with no group.
    if (!chain.length && key === 'profitandlossac') { pl = false; dr = false; }
    const cat = {};
    for (const c of chain) { const t = CAT_OF_GROUP[norm(c)]; if (t) cat[t] = true; }
    if (chain.some((c) => norm(c).includes('suspense')) || key.includes('suspense')) cat.suspense = true;
    const n = { pl: !!pl, dr: !!dr, chain, cat, known: !!led };
    natCache.set(key, n);
    return n;
  }
  // Period postings per ledger, from LIVE vouchers only (cancelled and
  // optional vouchers have no accounting effect).
  const live = vouchers.filter((v) => !v.cancelled && !v.optional && vfamily(v.type) !== 'other');
  const post = new Map();
  for (const v of live) {
    const mKey = `${v.date.getUTCFullYear()}-${pad(v.date.getUTCMonth() + 1)}`;
    for (const e of v.entries) {
      const k = norm(e.ledger);
      let p = post.get(k);
      if (!p) { p = { dr: 0, cr: 0, n: 0, months: new Set() }; post.set(k, p); }
      p.dr = r2(p.dr + e.dr); p.cr = r2(p.cr + e.cr); p.n++; p.months.add(mKey);
    }
  }
  const postOf = (name) => post.get(norm(name)) || { dr: 0, cr: 0, n: 0, months: new Set() };
  // P&L figures from period postings (net), sign conventions:
  // income positive = credit net, expense positive = debit net.
  let turnover = 0, income = 0, expenses = 0, interestExp = 0, interestInc = 0, depreciation = 0, purchasesTotal = 0;
  for (const l of ledgers) {
    const n = nat(l.name);
    if (!n.pl) continue;
    const p = postOf(l.name);
    const drNet = r2(p.dr - p.cr);
    if (n.dr) {
      expenses = r2(expenses + drNet);
      if (hasWord(l.name, 'interest')) interestExp = r2(interestExp + Math.max(drNet, 0));
      if (hasWord(l.name, 'depreciation') || hasWord(l.name, 'amortisation') || hasWord(l.name, 'amortization'))
        depreciation = r2(depreciation + Math.max(drNet, 0));
      if (n.cat.purchase) purchasesTotal = r2(purchasesTotal + drNet);
    } else {
      income = r2(income - drNet);
      if (n.cat.sales) turnover = r2(turnover - drNet);
      if (hasWord(l.name, 'interest')) interestInc = r2(interestInc + Math.max(-drNet, 0));
    }
  }
  if (!turnover) turnover = income;
  const pbt = r2(income - expenses);
  let assets = 0;
  for (const l of ledgers) { const n = nat(l.name); if (!n.pl && l.closing > 0) assets = r2(assets + l.closing); }
  // Materiality — ICAI benchmarks, highest of the three (or manual override).
  const bench = {
    turnover: r2((turnover * cfg.pctTurnover) / 100),
    pbt: r2((Math.abs(pbt) * cfg.pctPBT) / 100),
    assets: r2((assets * cfg.pctAssets) / 100),
  };
  let om = cfg.materialityMode === 'manual' && cfg.materialityValue > 0
    ? cfg.materialityValue
    : Math.max(bench.turnover, bench.pbt, bench.assets, 25000);
  const M = {
    om: r2(om), pm: r2((om * cfg.perfPct) / 100), trivial: r2((om * cfg.trivialPct) / 100),
    basis: cfg.materialityMode === 'manual' ? 'manual' :
      om === bench.turnover ? `${cfg.pctTurnover}% of turnover` :
      om === bench.pbt ? `${cfg.pctPBT}% of PBT` :
      om === bench.assets ? `${cfg.pctAssets}% of total assets` : 'floor',
    bench,
  };
  // Non-working days.
  const holidaySet = new Set(String(cfg.holidays || '').split(',').map((s) => s.trim()).filter(Boolean));
  const isOffDay = (d) => {
    const wd = d.getUTCDay();
    if (cfg.weeklyOff === 'sun' && wd === 0) return true;
    if (cfg.weeklyOff === 'sat-sun' && (wd === 0 || wd === 6)) return true;
    return holidaySet.has(iso(d));
  };
  return {
    company, from, to, cfg, groups, ledgers, ledByNorm, vouchers, live,
    nat, post, postOf, billsRecv, billsPay, M, isOffDay,
    totals: { turnover, income, expenses, pbt, interestExp, interestInc, depreciation, purchasesTotal, assets },
  };
}

// ------------------------------ check battery --------------------------------
// Every check: id, title, area, phase (of the statutory-audit programme),
// ref (statute / SA), base severity, recommendation for the management
// letter, and run(ctx) → { rows, summary?, severity? }.
const vRef = (v) => `${v.type} #${v.number || '—'}`;
const CHECKS = [
  // ---------- Books & audit trail (Phase 5 · Sec 128 · Rule 11(g)) ----------
  {
    id: 'dup-vch-no', area: 'Books & audit trail', phase: 5,
    title: 'Duplicate voucher numbers', ref: 'Sec 128, Companies Act · Rule 11(g) hygiene', severity: 'medium',
    rec: 'Investigate each duplicate; renumber or cancel the incorrect voucher and switch the voucher type to automatic numbering.',
    run(ctx) {
      const seen = new Map(); const rows = [];
      for (const v of ctx.live) {
        if (!v.number) continue;
        const k = `${norm(v.type)}|${String(v.number).trim().toUpperCase()}`;
        if (seen.has(k)) {
          const first = seen.get(k);
          rows.push({ 'Voucher type': v.type, 'Number': v.number, 'Date 1': disp(first.date), 'Date 2': disp(v.date), 'Amount 2': v.amount });
        } else seen.set(k, v);
      }
      return { rows, summary: rows.length ? `${rows.length} duplicate number(s) across voucher types.` : '' };
    },
  },
  {
    id: 'seq-gaps', area: 'Books & audit trail', phase: 5,
    title: 'Gaps in voucher number sequences', ref: 'Completeness assertion · GST rule 46(b) for invoices', severity: 'medium',
    rec: 'Obtain reasons for every missing number (deleted / cancelled / spoiled). Deleted vouchers should not exist where the audit trail applies.',
    run(ctx) {
      const byType = new Map();
      for (const v of ctx.live) {
        if (!v.number) continue;
        if (!byType.has(v.type)) byType.set(v.type, []);
        byType.get(v.type).push(v.number);
      }
      const rows = [];
      for (const [type, nums] of byType) {
        const parsed = nums.map((s) => {
          const m = String(s).match(/(\d+)(?!.*\d)/);
          return m ? Number(m[1]) : null;
        }).filter((n) => n !== null);
        if (parsed.length < 10 || parsed.length < nums.length * 0.8) continue; // not a numeric series
        const uniq = [...new Set(parsed)].sort((a, b) => a - b);
        let missing = 0; const ranges = [];
        for (let i = 1; i < uniq.length; i++) {
          const gap = uniq[i] - uniq[i - 1] - 1;
          if (gap > 0 && gap <= 500) { missing += gap; ranges.push(gap === 1 ? String(uniq[i - 1] + 1) : `${uniq[i - 1] + 1}–${uniq[i] - 1}`); }
        }
        if (missing) rows.push({ 'Voucher type': type, 'Missing count': missing, 'Missing numbers': ranges.slice(0, 25).join(', ') + (ranges.length > 25 ? ' …' : '') });
      }
      return { rows };
    },
  },
  {
    id: 'cancelled', area: 'Books & audit trail', phase: 5,
    title: 'Cancelled vouchers', ref: 'SA 230 · audit-trail review', severity: 'low',
    rec: 'Review reasons for cancellations, particularly around period-end; confirm none was a booked-and-reversed transaction.',
    run(ctx) {
      const rows = ctx.vouchers.filter((v) => v.cancelled)
        .map((v) => ({ Date: disp(v.date), Voucher: vRef(v), Party: v.party || '—' }));
      return { rows, severity: rows.length > 25 ? 'medium' : 'low', summary: rows.length ? `${rows.length} cancelled voucher(s) in the period.` : '' };
    },
  },
  {
    id: 'optional', area: 'Books & audit trail', phase: 5,
    title: 'Optional vouchers still pending', ref: 'Optional vouchers form no part of the accounts', severity: 'medium',
    rec: 'Regularise or delete every optional voucher before finalisation — they silently drop out of the financial statements.',
    run(ctx) {
      const rows = ctx.vouchers.filter((v) => v.optional)
        .map((v) => ({ Date: disp(v.date), Voucher: vRef(v), Party: v.party || '—', Amount: v.amount }));
      return { rows };
    },
  },
  {
    id: 'no-narration', area: 'Books & audit trail', phase: 5,
    title: 'Large vouchers without narration', ref: 'SA 230 documentation · Sec 128', severity: 'low',
    rec: 'Insist on meaningful narrations for journals and payments; they are the first audit evidence for every entry.',
    run(ctx) {
      const rows = [];
      for (const v of ctx.live) {
        const f = vfamily(v.type);
        if (f !== 'journal' && f !== 'payment' && f !== 'receipt') continue;
        if (v.amount >= ctx.cfg.narrationMin && !String(v.narration || '').trim())
          rows.push({ Date: disp(v.date), Voucher: vRef(v), Party: v.party || '—', Amount: v.amount });
      }
      rows.sort((a, b) => b.Amount - a.Amount);
      return { rows };
    },
  },
  {
    id: 'holiday-entries', area: 'Books & audit trail', phase: 5,
    title: 'Entries dated on weekly-off days / holidays', ref: 'SA 240 — journal-entry characteristics', severity: 'low',
    rec: 'Understand why entries carry non-working dates; backdating into holidays is a classic manipulation marker.',
    run(ctx) {
      if (ctx.cfg.weeklyOff === 'none' && !ctx.cfg.holidays) return { rows: [], na: true };
      const rows = ctx.live.filter((v) => ctx.isOffDay(v.date) && v.amount >= ctx.M.trivial)
        .map((v) => ({ Date: disp(v.date), Day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][v.date.getUTCDay()], Voucher: vRef(v), Party: v.party || '—', Amount: v.amount }));
      rows.sort((a, b) => b.Amount - a.Amount);
      return { rows: rows.slice(0, 200), count: rows.length };
    },
  },
  {
    id: 'suspense', area: 'Books & audit trail', phase: 5,
    title: 'Suspense-account balances / usage', ref: 'Schedule III — no unexplained balances', severity: 'high',
    rec: 'Every suspense balance must be identified and reclassified before finalisation; a suspense balance in signed accounts invites qualification.',
    run(ctx) {
      const rows = [];
      for (const l of ctx.ledgers) {
        const n = ctx.nat(l.name);
        if (!n.cat.suspense) continue;
        const p = ctx.postOf(l.name);
        if (Math.abs(l.closing) > 1 || p.n)
          rows.push({ Ledger: l.name, 'Entries in year': p.n, 'Closing balance': l.closing });
      }
      return { rows, severity: rows.some((r) => Math.abs(r['Closing balance']) > 1) ? 'high' : 'medium' };
    },
  },
  {
    id: 'balance-mismatch', area: 'Books & audit trail', phase: 5,
    title: 'Master closing ≠ opening + period movement', ref: 'Data integrity — books vs masters', severity: 'high',
    rec: 'A ledger whose master balance disagrees with its posted movement points to out-of-period entries, split-company data or damaged data. Re-verify with Tally’s own reports before relying on the books.',
    run(ctx) {
      const rows = [];
      let checked = 0;
      for (const l of ctx.ledgers) {
        const p = ctx.postOf(l.name);
        checked++;
        const computed = r2(l.opening + p.dr - p.cr);
        const diff = r2(computed - l.closing);
        if (Math.abs(diff) > 1)
          rows.push({ Ledger: l.name, Opening: l.opening, 'Period Dr': p.dr, 'Period Cr': p.cr, 'Computed closing': computed, 'Master closing': l.closing, Difference: diff });
      }
      rows.sort((a, b) => Math.abs(b.Difference) - Math.abs(a.Difference));
      if (rows.length > checked * 0.3 && checked > 20)
        return { rows: rows.slice(0, 20), count: rows.length, severity: 'medium', summary: `Widespread mismatch (${rows.length} of ${checked} ledgers) — the company’s books period likely differs from the audit period, or vouchers exist outside it. Verify the period before reading individual differences.` };
      return { rows };
    },
  },
  // ---------- Trial balance & openings (Phase 5 · SA 510 · Phase 8) ----------
  {
    id: 'tb-balance', area: 'Trial balance & openings', phase: 8,
    title: 'Trial balance does not balance', ref: 'Double entry — Sec 128(1)', severity: 'high',
    rec: 'Locate the one-sided or corrupted entry; the books cannot be signed while the TB is out of balance.',
    run(ctx) {
      const sum = r2(ctx.ledgers.reduce((s, l) => s + l.closing, 0));
      return Math.abs(sum) > 1
        ? { rows: [{ 'Σ all closing balances (Dr +, Cr −)': sum, 'Should be': 0 }] }
        : { rows: [] };
    },
  },
  {
    id: 'opening-balance', area: 'Trial balance & openings', phase: 5,
    title: 'Opening balances do not balance', ref: 'SA 510 — Initial engagements', severity: 'high',
    rec: 'Agree every opening balance to the signed previous-year financial statements; correct the difference through the ledger it belongs to, never through suspense.',
    run(ctx) {
      const sum = r2(ctx.ledgers.reduce((s, l) => s + l.opening, 0));
      return Math.abs(sum) > 1
        ? { rows: [{ 'Σ opening balances (Dr +, Cr −)': sum, 'Should be': 0 }] }
        : { rows: [] };
    },
  },
  {
    id: 'pl-opening', area: 'Trial balance & openings', phase: 5,
    title: 'P&L ledgers carrying opening balances', ref: 'SA 510 — income/expense must start the year at nil', severity: 'medium',
    rec: 'Transfer the balance to the correct balance-sheet head or to opening reserves; a P&L ledger with an opening balance doubles-counts last year’s figures.',
    run(ctx) {
      const rows = ctx.ledgers.filter((l) => ctx.nat(l.name).pl && Math.abs(l.opening) > 1)
        .map((l) => ({ Ledger: l.name, Group: l.parent, 'Opening balance': l.opening }));
      return { rows };
    },
  },
  {
    id: 'wrong-side', area: 'Trial balance & openings', phase: 8,
    title: 'Balances on the wrong side', ref: 'Schedule III presentation', severity: 'medium',
    rec: 'Reclassify or investigate each: an asset with a credit balance (or vice versa) is either a misposting or needs regrouping in the financial statements.',
    run(ctx) {
      const rows = [];
      for (const l of ctx.ledgers) {
        const n = ctx.nat(l.name);
        if (n.cat.debtor || n.cat.creditor || n.cat.bank || n.cat.bankod || n.cat.duties || n.cat.suspense || n.cat.cash) continue;
        if (norm(l.name) === 'profitandlossac') continue;
        if (Math.abs(l.closing) <= Math.max(1, ctx.M.trivial / 10)) continue;
        if (!n.pl && n.dr && l.closing < 0) rows.push({ Ledger: l.name, Group: l.parent, Nature: 'Asset side', 'Closing balance': l.closing, Issue: 'Credit balance on an asset-nature ledger' });
        else if (!n.pl && !n.dr && l.closing > 0) rows.push({ Ledger: l.name, Group: l.parent, Nature: 'Liability side', 'Closing balance': l.closing, Issue: 'Debit balance on a liability-nature ledger' });
        else if (n.pl && n.dr && l.closing < 0) rows.push({ Ledger: l.name, Group: l.parent, Nature: 'Expense', 'Closing balance': l.closing, Issue: 'Net credit on an expense ledger' });
        else if (n.pl && !n.dr && l.closing > 0) rows.push({ Ledger: l.name, Group: l.parent, Nature: 'Income', 'Closing balance': l.closing, Issue: 'Net debit on an income ledger' });
      }
      rows.sort((a, b) => Math.abs(b['Closing balance']) - Math.abs(a['Closing balance']));
      return { rows };
    },
  },
  {
    id: 'debtor-credit', area: 'Revenue & receivables', phase: 6,
    title: 'Debtors with credit balances', ref: 'Schedule III — disclose as advances from customers, not netted', severity: 'medium',
    rec: 'Gross up: show credit balances of debtors under "Other current liabilities / advances from customers". Verify they are genuine advances, not unadjusted receipts.',
    run(ctx) {
      const rows = ctx.ledgers.filter((l) => ctx.nat(l.name).cat.debtor && l.closing < -1)
        .map((l) => ({ Customer: l.name, 'Credit balance': l.closing }));
      rows.sort((a, b) => a['Credit balance'] - b['Credit balance']);
      return { rows };
    },
  },
  {
    id: 'creditor-debit', area: 'Purchases & payables', phase: 6,
    title: 'Creditors with debit balances', ref: 'Schedule III — disclose as advances to suppliers, not netted', severity: 'medium',
    rec: 'Gross up under "Other current assets / advances to suppliers"; confirm recoverability or adjustment against subsequent bills.',
    run(ctx) {
      const rows = ctx.ledgers.filter((l) => ctx.nat(l.name).cat.creditor && l.closing > 1)
        .map((l) => ({ Supplier: l.name, 'Debit balance': l.closing }));
      rows.sort((a, b) => b['Debit balance'] - a['Debit balance']);
      return { rows };
    },
  },
  {
    id: 'bank-credit', area: 'Cash & bank', phase: 6,
    title: 'Bank ledgers with credit balances', ref: 'Schedule III — book overdraft / OD classification', severity: 'medium',
    rec: 'Verify against the bank statement and BRS: a credit book balance is either an OD/CC (show under borrowings) or cheques issued beyond balance (book overdraft — current liability).',
    run(ctx) {
      const rows = ctx.ledgers.filter((l) => { const n = ctx.nat(l.name); return n.cat.bank && !n.cat.bankod && l.closing < -1; })
        .map((l) => ({ 'Bank ledger': l.name, 'Credit balance': l.closing }));
      return { rows };
    },
  },
  {
    id: 'dormant', area: 'Trial balance & openings', phase: 6,
    title: 'Dormant ledgers still carrying balances', ref: 'SA 500 — existence & valuation of stale balances', severity: 'low',
    rec: 'Circularise confirmations for stale party balances; assess recoverability (ECL) of old debit balances and whether old credits are write-back candidates (or unclaimed liabilities).',
    run(ctx) {
      const rows = ctx.ledgers.filter((l) => {
        const n = ctx.nat(l.name);
        if (n.pl || norm(l.name) === 'profitandlossac') return false;
        return ctx.postOf(l.name).n === 0 && Math.abs(l.closing) >= ctx.cfg.dormantMin;
      }).map((l) => ({ Ledger: l.name, Group: l.parent, 'Closing balance': l.closing }));
      rows.sort((a, b) => Math.abs(b['Closing balance']) - Math.abs(a['Closing balance']));
      return { rows: rows.slice(0, 300), count: rows.length };
    },
  },
  // --------------------------- Cash & bank (Phase 6) --------------------------
  {
    id: 'negative-cash', area: 'Cash & bank', phase: 6,
    title: 'Cash book goes negative during the year', ref: 'Impossible balance — books not reliable · CARO 3(xi) fraud indicator', severity: 'high',
    rec: 'Cash in hand can never be negative: entries are missing, backdated or fabricated. Reconstruct the cash book for the affected dates before relying on it.',
    run(ctx) {
      const rows = [];
      const cashLeds = ctx.ledgers.filter((l) => ctx.nat(l.name).cat.cash);
      for (const led of cashLeds) {
        const daily = new Map();
        for (const v of ctx.live) for (const e of v.entries) {
          if (norm(e.ledger) !== norm(led.name)) continue;
          const k = iso(v.date);
          daily.set(k, r2((daily.get(k) || 0) + e.dr - e.cr));
        }
        let bal = led.opening, minBal = led.opening, minDate = '', firstNeg = '', negDays = 0;
        for (const k of [...daily.keys()].sort()) {
          bal = r2(bal + daily.get(k));
          if (bal < -1) { negDays++; if (!firstNeg) firstNeg = k; }
          if (bal < minBal) { minBal = bal; minDate = k; }
        }
        if (negDays) rows.push({ 'Cash ledger': led.name, 'First negative on': disp(isoToDate(firstNeg)), 'Days negative': negDays, 'Lowest balance': minBal, On: disp(isoToDate(minDate)) });
      }
      return { rows };
    },
  },
  {
    id: 'cash-40a3', area: 'Cash & bank', phase: 6,
    title: `Cash payments above the Sec 40A(3) limit`, ref: 'Sec 40A(3) IT Act — expense disallowance · Rule 6DD exceptions', severity: 'high',
    rec: 'Aggregate payments to one payee in one day above ₹10,000 in cash are disallowable. Compile payee-wise workings and test Rule 6DD exceptions; report the disallowance in the tax audit.',
    run(ctx) {
      // The 40A(3) limit applies to the AGGREGATE paid to one payee in one
      // day, so sub-limit vouchers are collected too and summed per day.
      const perDay = new Map();
      for (const v of ctx.live) {
        const f = vfamily(v.type);
        if (f === 'contra' || f === 'sales' || f === 'receipt') continue;
        let cashCr = 0, bankDr = 0, otherDr = [];
        for (const e of v.entries) {
          const n = ctx.nat(e.ledger);
          if (n.cat.cash) cashCr = r2(cashCr + e.cr);
          else if ((n.cat.bank || n.cat.bankod) && e.dr) bankDr = r2(bankDr + e.dr);
          else if (e.dr) otherDr.push(e.ledger);
        }
        if (!cashCr) continue;
        if (bankDr >= cashCr - 1 && !otherDr.length) continue; // cash deposited into bank
        const payee = v.party || otherDr[0] || '—';
        const k = `${iso(v.date)}|${norm(payee)}`;
        let a = perDay.get(k);
        if (!a) { a = { date: v.date, payee, total: 0, vchs: [], narr: v.narration || '' }; perDay.set(k, a); }
        a.total = r2(a.total + cashCr); a.vchs.push(vRef(v));
      }
      const rows = [...perDay.values()].filter((a) => a.total > ctx.cfg.cashPaymentLimit)
        .map((a) => ({ Date: disp(a.date), Payee: a.payee, 'Cash paid in the day': a.total,
          'Voucher(s)': a.vchs.slice(0, 5).join(', ') + (a.vchs.length > 5 ? ` +${a.vchs.length - 5} more` : ''),
          Narration: a.narr.slice(0, 60) }));
      rows.sort((a, b) => b['Cash paid in the day'] - a['Cash paid in the day']);
      return { rows };
    },
  },
  {
    id: 'cash-269st', area: 'Cash & bank', phase: 6,
    title: 'Cash receipts at/above ₹2,00,000 (Sec 269ST)', ref: 'Sec 269ST IT Act — penalty u/s 271DA equals the amount received', severity: 'high',
    rec: 'Receipt of ₹2 lakh or more in cash from a person in a day / per transaction / per event attracts 100% penalty. Examine each occurrence and the aggregation across the year.',
    run(ctx) {
      const rows = []; const agg = new Map();
      for (const v of ctx.live) {
        const f = vfamily(v.type);
        if (f === 'contra' || f === 'payment') continue;
        let cashDr = 0, bankCr = 0;
        for (const e of v.entries) {
          const n = ctx.nat(e.ledger);
          if (n.cat.cash) cashDr = r2(cashDr + e.dr);
          else if ((n.cat.bank || n.cat.bankod) && e.cr) bankCr = r2(bankCr + e.cr);
        }
        if (!cashDr) continue;
        if (bankCr >= cashDr - 1) continue; // cash withdrawn from bank
        const payer = v.party || '—';
        const k = `${iso(v.date)}|${norm(payer)}`;
        agg.set(k, { total: r2(((agg.get(k) || {}).total || 0) + cashDr), payer, date: v.date, vch: vRef(v) });
      }
      for (const a of agg.values())
        if (a.total >= ctx.cfg.cashReceiptLimit)
          rows.push({ Date: disp(a.date), Payer: a.payer, 'Cash received in the day': a.total });
      rows.sort((a, b) => b['Cash received in the day'] - a['Cash received in the day']);
      return { rows };
    },
  },
  {
    id: 'cash-loans', area: 'Cash & bank', phase: 6,
    title: 'Loans accepted / repaid in cash ≥ ₹20,000', ref: 'Sec 269SS & 269T IT Act — penalty u/s 271D/271E equals the amount', severity: 'high',
    rec: 'Loans or deposits of ₹20,000 or more must move only through account-payee banking channels. Document each instance for the tax audit (clauses 31(a)–(c) of Form 3CD).',
    run(ctx) {
      const rows = [];
      for (const v of ctx.live) {
        let cash = 0, loanDr = 0, loanCr = 0, loanLed = '';
        for (const e of v.entries) {
          const n = ctx.nat(e.ledger);
          if (n.cat.cash) cash = r2(cash + e.dr + e.cr);
          if (n.cat.loanLiab) { loanDr = r2(loanDr + e.dr); loanCr = r2(loanCr + e.cr); loanLed = e.ledger; }
        }
        if (!cash || (!loanDr && !loanCr)) continue;
        const amt = Math.min(cash, Math.max(loanDr, loanCr));
        if (amt >= ctx.cfg.cashLoanLimit)
          rows.push({ Date: disp(v.date), Voucher: vRef(v), 'Loan ledger': loanLed, Direction: loanCr > loanDr ? 'Accepted (269SS)' : 'Repaid (269T)', 'Amount in cash': amt });
      }
      return { rows };
    },
  },
  // ---------------------- Revenue & receivables (Phase 6) ---------------------
  {
    id: 'sales-via-journal', area: 'Revenue & receivables', phase: 6,
    title: 'Revenue credited through Journal vouchers', ref: 'SA 240 — revenue recognition is a presumed fraud risk', severity: 'medium',
    rec: 'Every journal credit to a sales/income ledger needs individual vouching — journals bypass the invoice controls and the GST sales register.',
    run(ctx) {
      const rows = [];
      for (const v of ctx.live) {
        if (vfamily(v.type) !== 'journal') continue;
        for (const e of v.entries) {
          const n = ctx.nat(e.ledger);
          if (n.pl && !n.dr && e.cr >= ctx.M.trivial)
            rows.push({ Date: disp(v.date), Voucher: vRef(v), 'Income ledger credited': e.ledger, Amount: e.cr, Narration: (v.narration || '').slice(0, 60) });
        }
      }
      rows.sort((a, b) => b.Amount - a.Amount);
      return { rows: rows.slice(0, 300), count: rows.length };
    },
  },
  {
    id: 'sales-cutoff', area: 'Revenue & receivables', phase: 6,
    title: 'Year-end sales clustering (cut-off risk)', ref: 'AS 9 / Ind AS 115 · SA 240', severity: 'medium',
    rec: 'Vouch the flagged year-end invoices to delivery evidence (e-way bills, LRs, customer acknowledgements) and test post-year-end credit notes for reversal of these sales.',
    run(ctx) {
      const days = ctx.cfg.yearEndDays;
      const cut = new Date(ctx.to.getTime() - (days - 1) * 86400000);
      const sales = ctx.live.filter((v) => vfamily(v.type) === 'sales');
      if (!sales.length) return { rows: [], na: true };
      const total = sales.reduce((s, v) => s + v.amount, 0);
      const weeks = Math.max(1, dayDiff(ctx.from, ctx.to) / 7);
      const lastWin = sales.filter((v) => v.date >= cut);
      const winVal = lastWin.reduce((s, v) => s + v.amount, 0);
      const avgWeek = total / weeks;
      const ratio = avgWeek ? winVal / (avgWeek * (days / 7)) : 0;
      if (ratio < 2 || winVal < ctx.M.pm) return { rows: [], summary: `Last ${days} days: ${inr(winVal)} vs weekly average ${inr(avgWeek)} — no unusual clustering.` };
      const rows = lastWin.sort((a, b) => b.amount - a.amount).slice(0, 25)
        .map((v) => ({ Date: disp(v.date), Voucher: vRef(v), Customer: v.party || '—', Amount: v.amount }));
      return { rows, summary: `Sales in the last ${days} days are ${ratio.toFixed(1)}× the weekly run-rate (${inr(winVal)} vs avg ${inr(avgWeek)}/week).` };
    },
  },
  {
    id: 'yearend-creditnotes', area: 'Revenue & receivables', phase: 6,
    title: 'Credit notes around the year-end', ref: 'Cut-off / channel-stuffing reversal indicator', severity: 'medium',
    rec: 'Match year-end credit notes to their original invoices; a sale raised near closing and reversed after it belongs to neither year’s revenue.',
    run(ctx) {
      const cut = new Date(ctx.to.getTime() - (ctx.cfg.yearEndDays - 1) * 86400000);
      const rows = ctx.live.filter((v) => vfamily(v.type) === 'creditnote' && v.date >= cut && v.amount >= ctx.M.trivial)
        .map((v) => ({ Date: disp(v.date), Voucher: vRef(v), Customer: v.party || '—', Amount: v.amount }));
      return { rows };
    },
  },
  {
    id: 'gstin-quality', area: 'Revenue & receivables', phase: 6,
    title: 'Missing / invalid GSTINs on party masters', ref: 'GST reconciliation & e-invoice risk', severity: 'medium',
    rec: 'Fix invalid GSTINs (checksum failures) immediately; obtain GSTINs (or B2C confirmation) for every party with material turnover so books tie to GSTR-1/2B.',
    run(ctx) {
      const rows = [];
      for (const l of ctx.ledgers) {
        const n = ctx.nat(l.name);
        if (!n.cat.debtor && !n.cat.creditor) continue;
        const p = ctx.postOf(l.name);
        const vol = Math.max(p.dr, p.cr);
        if (l.gstin && !gstinValid(l.gstin))
          rows.push({ Party: l.name, GSTIN: l.gstin, Issue: 'Fails checksum — typo in the master', 'Year volume': vol });
        else if (!l.gstin && vol >= 250000)
          rows.push({ Party: l.name, GSTIN: '—', Issue: 'No GSTIN on a material party (verify if B2C/unregistered)', 'Year volume': vol });
      }
      rows.sort((a, b) => b['Year volume'] - a['Year volume']);
      return { rows: rows.slice(0, 300), count: rows.length, severity: rows.some((r) => r.Issue.startsWith('Fails')) ? 'medium' : 'low' };
    },
  },
  // ---------------------- Purchases & payables (Phase 6) ----------------------
  {
    id: 'purchase-via-journal', area: 'Purchases & payables', phase: 6,
    title: 'Purchases / expenses booked through Journal', ref: 'Control bypass — GRN and invoice matching skipped', severity: 'medium',
    rec: 'Vouch journal-booked purchases to invoices and receipts of goods/services; recurring journal purchases mean the purchase module (and its controls) is being bypassed.',
    run(ctx) {
      const rows = [];
      for (const v of ctx.live) {
        if (vfamily(v.type) !== 'journal') continue;
        for (const e of v.entries) {
          const n = ctx.nat(e.ledger);
          if (n.pl && n.dr && n.cat.purchase && e.dr >= ctx.M.trivial)
            rows.push({ Date: disp(v.date), Voucher: vRef(v), 'Purchase ledger debited': e.ledger, Amount: e.dr });
        }
      }
      rows.sort((a, b) => b.Amount - a.Amount);
      return { rows: rows.slice(0, 300), count: rows.length };
    },
  },
  {
    id: 'dup-supplier-ref', area: 'Purchases & payables', phase: 6,
    title: 'Same supplier bill reference booked twice', ref: 'Occurrence assertion — double-booking / duplicate payment risk', severity: 'high',
    rec: 'Confirm with the supplier ledger and payments whether the bill is booked twice; recover or adjust any duplicate payment.',
    run(ctx) {
      const seen = new Map(); const rows = [];
      for (const v of ctx.live) {
        const f = vfamily(v.type);
        if (f !== 'purchase' && f !== 'debitnote') continue;
        const ref = String(v.reference || '').trim().toUpperCase();
        if (!ref || !v.party) continue;
        const k = `${norm(v.party)}|${ref}`;
        if (seen.has(k)) {
          const first = seen.get(k);
          rows.push({ Supplier: v.party, Reference: v.reference, 'First booked': `${disp(first.date)} (${vRef(first)})`, 'Booked again': `${disp(v.date)} (${vRef(v)})`, Amount: v.amount });
        } else seen.set(k, v);
      }
      return { rows };
    },
  },
  {
    id: 'msme-ageing', area: 'Purchases & payables', phase: 6,
    title: 'Creditors outstanding beyond 45 days (MSME risk)', ref: 'Sec 15 MSMED Act · Sec 43B(h) IT Act · Schedule III MSME disclosure', severity: 'medium',
    rec: 'Obtain Udyam registrations from every supplier. Dues to micro/small suppliers beyond 45 days: interest u/s 16 MSMED accrues (never deductible) and the principal is disallowable u/s 43B(h) if unpaid at year-end.',
    run(ctx) {
      if (!ctx.billsPay.length) return { rows: [], na: true, summary: 'Bill-wise payables could not be read from Tally — run the check manually from the creditors ageing.' };
      const msme = new Set(String(ctx.cfg.msmeNames || '').split(',').map((s) => norm(s)).filter(Boolean));
      const rows = [];
      for (const b of ctx.billsPay) {
        const age = dayDiff(b.date, ctx.to);
        if (age <= ctx.cfg.msmeDays) continue;
        rows.push({ Supplier: b.party || '—', 'Bill ref': b.ref, 'Bill date': disp(b.date), 'Age (days)': age, Pending: b.pending, MSME: msme.has(norm(b.party)) ? 'Confirmed MSME' : 'Verify status' });
      }
      rows.sort((a, b) => b.Pending - a.Pending);
      const conf = rows.filter((r) => r.MSME === 'Confirmed MSME');
      return { rows: rows.slice(0, 400), count: rows.length, severity: conf.length ? 'high' : 'medium' };
    },
  },
  {
    id: 'ageing-sch3', area: 'Purchases & payables', phase: 8,
    title: 'Schedule III ageing of receivables & payables', ref: 'Schedule III (Div I & II) ageing disclosures', severity: 'info',
    rec: 'Carry these buckets into the Schedule III ageing notes; investigate the > 3-year buckets for write-off / write-back and ECL.',
    run(ctx) {
      if (!ctx.billsRecv.length && !ctx.billsPay.length) return { rows: [], na: true };
      const bucket = (age) => age <= 182 ? '< 6 months' : age <= 365 ? '6 months – 1 year' : age <= 730 ? '1 – 2 years' : age <= 1095 ? '2 – 3 years' : '> 3 years';
      const sum = { Receivables: {}, Payables: {} };
      for (const b of ctx.billsRecv) { const k = bucket(dayDiff(b.date, ctx.to)); sum.Receivables[k] = r2((sum.Receivables[k] || 0) + b.pending); }
      for (const b of ctx.billsPay) { const k = bucket(dayDiff(b.date, ctx.to)); sum.Payables[k] = r2((sum.Payables[k] || 0) + b.pending); }
      const order = ['< 6 months', '6 months – 1 year', '1 – 2 years', '2 – 3 years', '> 3 years'];
      const rows = order.map((k) => ({ Bucket: k, Receivables: sum.Receivables[k] || 0, Payables: sum.Payables[k] || 0 }))
        .filter((r) => r.Receivables || r.Payables);
      return { rows, severity: 'info' };
    },
  },
  // ------------------------- Statutory dues (Phase 6) -------------------------
  {
    id: 'tds-balances', area: 'Statutory dues', phase: 6,
    title: 'TDS / TCS ledger positions', ref: 'Sec 200/201 IT Act · CARO 3(vii) · Form 26AS/TRACES reconciliation', severity: 'medium',
    rec: 'Reconcile every TDS payable balance with challans and returns (24Q/26Q); interest u/s 201(1A) runs monthly. A debit balance under Duties & Taxes is a misposting or an unadjusted excess.',
    run(ctx) {
      const rows = [];
      for (const l of ctx.ledgers) {
        const isTds = hasWord(l.name, 'tds') || hasWord(l.name, 'tcs');
        if (!isTds) continue;
        const n = ctx.nat(l.name);
        if (Math.abs(l.closing) <= 1) continue;
        if (l.closing < 0) rows.push({ Ledger: l.name, Position: 'Payable at year-end', Balance: l.closing, Action: 'Verify deposit by due date (7th of next month; 30 Apr for March)' });
        else if (n.cat.duties) rows.push({ Ledger: l.name, Position: 'DEBIT balance under Duties & Taxes', Balance: l.closing, Action: 'Misposting or excess deposit — investigate' });
        else rows.push({ Ledger: l.name, Position: 'TDS receivable', Balance: l.closing, Action: 'Tie to Form 26AS credits' });
      }
      return { rows };
    },
  },
  {
    id: 'gst-balances', area: 'Statutory dues', phase: 6,
    title: 'GST ledger positions', ref: 'CGST Act Sec 39/49 · books-vs-GSTR-1/3B/2B reconciliation', severity: 'medium',
    rec: 'Reconcile output, ITC and cash-ledger balances with the GST portal (GSTR-1, 3B, 2B, electronic ledgers). Wrong-side balances signal unadjusted set-offs or mispostings.',
    run(ctx) {
      const gstWord = (nm) => ['gst', 'igst', 'cgst', 'sgst', 'utgst', 'cess'].some((w) => hasWord(nm, w));
      const rows = []; let net = 0; let any = false;
      for (const l of ctx.ledgers) {
        if (!gstWord(l.name)) continue;
        const n = ctx.nat(l.name);
        if (!n.cat.duties && !hasWord(l.name, 'input') && !hasWord(l.name, 'output')) continue;
        any = true; net = r2(net + l.closing);
        if (Math.abs(l.closing) <= 1) continue;
        const isOutput = hasWord(l.name, 'output') || hasWord(l.name, 'payable');
        const isInput = hasWord(l.name, 'input') || hasWord(l.name, 'itc') || hasWord(l.name, 'receivable') || hasWord(l.name, 'credit');
        if (isOutput && l.closing > 1) rows.push({ Ledger: l.name, Balance: l.closing, Issue: 'Output ledger with DEBIT balance — set-off not passed or misposting' });
        else if (isInput && l.closing < -1) rows.push({ Ledger: l.name, Balance: l.closing, Issue: 'Input/ITC ledger with CREDIT balance — reversal exceeded credit?' });
      }
      if (!any) return { rows: [], na: true };
      return { rows, summary: `Net GST position in books: ${net < 0 ? inr(-net) + ' payable' : inr(net) + ' recoverable'} — reconcile with the portal.` };
    },
  },
  {
    id: 'pf-esi', area: 'Statutory dues', phase: 6,
    title: 'PF / ESI / PT balances at year-end', ref: 'Sec 36(1)(va) & 43B IT Act · CARO 3(vii)', severity: 'medium',
    rec: 'Employee-contribution dues deposited after the statutory due date are permanently disallowable u/s 36(1)(va) (Checkmate Services, SC). Verify month-wise challans, not just the year-end balance.',
    run(ctx) {
      const words = ['pf', 'epf', 'provident', 'esi', 'esic', 'professional tax', 'ptax', 'pt payable', 'gratuity', 'bonus payable', 'labour welfare'];
      const rows = [];
      for (const l of ctx.ledgers) {
        if (!words.some((w) => hasWord(l.name, w))) continue;
        const n = ctx.nat(l.name);
        if (n.pl) continue;
        if (Math.abs(l.closing) <= 1) continue;
        rows.push({ Ledger: l.name, 'Closing balance': l.closing, Note: l.closing < 0 ? 'Payable — verify deposit dates month-wise' : 'Debit balance — verify nature' });
      }
      return { rows };
    },
  },
  {
    id: 'duties-wrongside', area: 'Statutory dues', phase: 6,
    title: 'Other Duties & Taxes ledgers on the wrong side', ref: 'CARO 3(vii) groundwork', severity: 'medium',
    rec: 'Explain every debit balance under Duties & Taxes — normally an excess payment, an unadjusted credit, or a misposting.',
    run(ctx) {
      const skip = (nm) => ['tds', 'tcs', 'gst', 'igst', 'cgst', 'sgst', 'utgst', 'cess', 'pf', 'epf', 'provident', 'esi', 'esic'].some((w) => hasWord(nm, w));
      const rows = ctx.ledgers.filter((l) => ctx.nat(l.name).cat.duties && !skip(l.name) && l.closing > 1)
        .map((l) => ({ Ledger: l.name, 'Debit balance': l.closing }));
      return { rows };
    },
  },
  // ----------------------- Journal testing · SA 240 ---------------------------
  {
    id: 'round-journals', area: 'Journal testing (SA 240)', phase: 6,
    title: 'Round-sum journal / payment entries', ref: 'SA 240 — characteristics of manipulated entries', severity: 'medium',
    rec: 'Vouch each large round-sum entry to underlying evidence; round amounts with thin narrations are the classic profile of adjustment entries.',
    run(ctx) {
      const rows = [];
      for (const v of ctx.live) {
        const f = vfamily(v.type);
        if (f !== 'journal' && f !== 'payment' && f !== 'receipt') continue;
        if (v.amount >= ctx.cfg.roundMin && v.amount % ctx.cfg.roundUnit === 0)
          rows.push({ Date: disp(v.date), Voucher: vRef(v), Party: v.party || '—', Amount: v.amount, Narration: (v.narration || '').slice(0, 60) });
      }
      rows.sort((a, b) => b.Amount - a.Amount);
      return { rows: rows.slice(0, 300), count: rows.length };
    },
  },
  {
    id: 'yearend-journals', area: 'Journal testing (SA 240)', phase: 6,
    title: 'Journal entries clustered at the year-end', ref: 'SA 240 (R) — mandatory testing of period-end journal entries', severity: 'medium',
    rec: 'Test every material year-end journal individually — provisioning, cut-off corrections and window-dressing all land in this window.',
    run(ctx) {
      const days = ctx.cfg.yearEndDays;
      const cut = new Date(ctx.to.getTime() - (days - 1) * 86400000);
      const jl = ctx.live.filter((v) => vfamily(v.type) === 'journal');
      if (!jl.length) return { rows: [], na: true };
      const inWin = jl.filter((v) => v.date >= cut);
      const weeks = Math.max(1, dayDiff(ctx.from, ctx.to) / 7);
      const avgCount = jl.length / weeks * (days / 7);
      const rows = inWin.filter((v) => v.amount >= ctx.M.trivial).sort((a, b) => b.amount - a.amount).slice(0, 50)
        .map((v) => ({ Date: disp(v.date), Voucher: vRef(v), Amount: v.amount, Narration: (v.narration || '').slice(0, 70) }));
      const flag = inWin.length > Math.max(5, avgCount * 2);
      return {
        rows: flag || rows.length ? rows : [], count: inWin.length,
        severity: flag ? 'medium' : 'low',
        summary: `${inWin.length} journal(s) in the last ${days} days vs ${avgCount.toFixed(1)} expected at the year’s run-rate.`,
      };
    },
  },
  {
    id: 'self-contra', area: 'Journal testing (SA 240)', phase: 6,
    title: 'Same ledger on both sides of one voucher', ref: 'SA 240 — self-cancelling / balance-dressing entries', severity: 'low',
    rec: 'Understand the purpose of entries that debit and credit the same ledger — they change nothing except turnover figures and audit trails.',
    run(ctx) {
      const rows = [];
      for (const v of ctx.live) {
        const sides = new Map();
        for (const e of v.entries) {
          const k = norm(e.ledger);
          const s = sides.get(k) || { dr: 0, cr: 0, name: e.ledger };
          s.dr += e.dr; s.cr += e.cr; sides.set(k, s);
        }
        for (const s of sides.values())
          if (s.dr > 0 && s.cr > 0 && Math.min(s.dr, s.cr) >= ctx.M.trivial)
            rows.push({ Date: disp(v.date), Voucher: vRef(v), Ledger: s.name, 'Dr in voucher': r2(s.dr), 'Cr in voucher': r2(s.cr) });
      }
      return { rows: rows.slice(0, 200), count: rows.length };
    },
  },
  {
    id: 'benford', area: 'Journal testing (SA 240)', phase: 4,
    title: 'Benford first-digit test on voucher amounts', ref: 'SA 240 / forensic analytics (Nigrini MAD thresholds)', severity: 'info',
    rec: 'A non-conforming digit profile is not proof of manipulation — drill into the over-represented digits (often fabricated or threshold-skirting amounts).',
    run(ctx) {
      const amts = ctx.live.map((v) => v.amount).filter((a) => a >= 10);
      if (amts.length < 300) return { rows: [], na: true, summary: `Only ${amts.length} vouchers ≥ ₹10 — too few for a meaningful Benford test (need ~300).` };
      const obs = Array(10).fill(0);
      for (const a of amts) obs[String(Math.floor(a)).replace(/[^1-9]/g, '')[0] || '1']++;
      const rows = []; let mad = 0;
      for (let d = 1; d <= 9; d++) {
        const exp = Math.log10(1 + 1 / d);
        const act = obs[d] / amts.length;
        mad += Math.abs(act - exp);
        rows.push({ Digit: d, 'Expected %': r2(exp * 100), 'Actual %': r2(act * 100), 'Excess %': r2((act - exp) * 100), Count: obs[d] });
      }
      mad /= 9;
      const verdict = mad < 0.006 ? 'close conformity' : mad < 0.012 ? 'acceptable conformity' : mad < 0.015 ? 'marginal conformity' : 'NON-CONFORMITY';
      return { rows, severity: mad >= 0.015 ? 'medium' : 'info', summary: `MAD ${(mad * 100).toFixed(2)}% over ${amts.length} vouchers — ${verdict}.`, flag: mad >= 0.015 };
    },
  },
  {
    id: 'big-vouchers', area: 'Journal testing (SA 240)', phase: 6,
    title: 'Largest vouchers of the year (vouching sample)', ref: 'SA 530 key-item selection', severity: 'info',
    rec: 'Vouch each key item to complete external evidence; these alone usually cover a large share of the population value.',
    run(ctx) {
      const rows = [...ctx.live].sort((a, b) => b.amount - a.amount).slice(0, 20)
        .map((v) => ({ Date: disp(v.date), Voucher: vRef(v), Party: v.party || '—', Amount: v.amount, Narration: (v.narration || '').slice(0, 60) }));
      return { rows, severity: 'info' };
    },
  },
  // ------------------ Companies Act & related parties -------------------------
  {
    id: 'rpt-ledgers', area: 'Companies Act & related parties', phase: 6,
    title: 'Ledgers that look like related parties', ref: 'Sec 185/186/188 Companies Act · AS 18 / Ind AS 24 · CARO 3(xiii)', severity: 'medium',
    rec: 'Complete the related-party matrix: Sec 184 declarations, Sec 177/188 approvals, arm’s-length documentation, and AS 18/Ind AS 24 disclosure for every flagged relationship.',
    run(ctx) {
      const words = String(ctx.cfg.rptKeywords || '').split(',').map((s) => s.trim()).filter(Boolean);
      const names = new Set(String(ctx.cfg.rptNames || '').split(',').map((s) => norm(s)).filter(Boolean));
      const rows = [];
      for (const l of ctx.ledgers) {
        const hit = names.has(norm(l.name)) ? 'named by management' : words.find((w) => hasWord(l.name, w));
        if (!hit) continue;
        const p = ctx.postOf(l.name);
        if (!p.n && Math.abs(l.closing) < 1) continue;
        rows.push({ Ledger: l.name, Group: l.parent, 'Matched on': hit, 'Dr in year': p.dr, 'Cr in year': p.cr, 'Closing balance': l.closing });
      }
      rows.sort((a, b) => Math.abs(b['Closing balance']) - Math.abs(a['Closing balance']));
      return { rows };
    },
  },
  {
    id: 'borrow-no-interest', area: 'Companies Act & related parties', phase: 6,
    title: 'Borrowings carried without interest cost', ref: 'Completeness of finance cost · deemed income risk', severity: 'medium',
    rec: 'Either interest is unprovided (understated expense — provide it) or the loan is genuinely interest-free (document it, and check deemed-dividend / Sec 2(22)(e) angles for director companies).',
    run(ctx) {
      const rows = [];
      for (const l of ctx.ledgers) {
        const n = ctx.nat(l.name);
        if (!n.cat.loanLiab) continue;
        const avg = (Math.min(l.opening, 0) + Math.min(l.closing, 0)) / -2;
        if (avg < Math.max(ctx.M.trivial * 4, 100000)) continue;
        rows.push({ 'Loan ledger': l.name, 'Average balance (Cr)': r2(avg) });
      }
      if (!rows.length) return { rows: [] };
      if (ctx.totals.interestExp > 0)
        return { rows: [], summary: `Borrowings exist and interest of ${inr(ctx.totals.interestExp)} is booked — test the rate ledger-wise instead.` };
      return { rows, summary: 'Borrowing balances exist but NO interest expense is booked anywhere in the year.' };
    },
  },
  {
    id: 'loans-no-interest-income', area: 'Companies Act & related parties', phase: 6,
    title: 'Loans / advances given without interest income', ref: 'Sec 186(7) Companies Act — minimum interest · CARO 3(iii)', severity: 'medium',
    rec: 'A company lending below the prescribed government-security yield breaches Sec 186(7). Document the nature of each advance (trade advance vs loan) and charge/provide interest where it is a loan.',
    run(ctx) {
      const skip = (nm) => ['prepaid', 'advance tax', 'tds', 'tcs', 'gst', 'deposit', 'security'].some((w) => hasWord(nm, w));
      const rows = [];
      for (const l of ctx.ledgers) {
        const n = ctx.nat(l.name);
        if (!n.cat.loanAsset || skip(l.name)) continue;
        if (l.closing < Math.max(ctx.M.trivial * 4, 100000)) continue;
        rows.push({ 'Ledger': l.name, 'Closing balance (Dr)': l.closing });
      }
      if (!rows.length) return { rows: [] };
      if (ctx.totals.interestInc > 0)
        return { rows: [], summary: `Loans/advances exist and interest income of ${inr(ctx.totals.interestInc)} is booked — test adequacy ledger-wise.` };
      return { rows, summary: 'Material loans/advances are outstanding but NO interest income is booked in the year.' };
    },
  },
  {
    id: 'no-depreciation', area: 'Companies Act & related parties', phase: 6,
    title: 'Fixed assets carried but no depreciation booked', ref: 'Schedule II Companies Act · AS 10/Ind AS 16', severity: 'high',
    rec: 'Depreciation is not optional under the Companies Act. Compute Schedule II depreciation asset-wise and record it before finalisation.',
    run(ctx) {
      const fa = r2(ctx.ledgers.filter((l) => { const n = ctx.nat(l.name); return n.cat.fixedAsset && !hasWord(l.name, 'depreciation'); })
        .reduce((s, l) => s + Math.max(l.closing, 0), 0));
      if (fa < ctx.M.trivial) return { rows: [] };
      if (ctx.totals.depreciation > 0) return { rows: [], summary: `Fixed assets ${inr(fa)}; depreciation booked ${inr(ctx.totals.depreciation)} (~${r2((ctx.totals.depreciation / fa) * 100)}% of gross block) — test the Schedule II working.` };
      return { rows: [{ 'Gross fixed assets in books': fa, 'Depreciation booked': 0 }] };
    },
  },
  // -------------------------------- Payroll -----------------------------------
  {
    id: 'salary-months', area: 'Payroll', phase: 6,
    title: 'Salary / recurring months missing', ref: 'Completeness of expenses · cut-off', severity: 'medium',
    rec: 'A payroll ledger that skips months means unbooked cost or timing errors — reconcile with the salary register and provide for the missing months.',
    run(ctx) {
      const words = ['salary', 'salaries', 'wages', 'remuneration', 'rent', 'electricity'];
      const months = [];
      for (let d = new Date(Date.UTC(ctx.from.getUTCFullYear(), ctx.from.getUTCMonth(), 1)); d <= ctx.to;
           d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))
        months.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
      if (months.length < 6) return { rows: [], na: true };
      const rows = [];
      for (const l of ctx.ledgers) {
        const n = ctx.nat(l.name);
        if (!n.pl || !n.dr) continue;
        if (!words.some((w) => hasWord(l.name, w))) continue;
        const p = ctx.postOf(l.name);
        if (p.months.size < months.length * 0.6 || p.months.size >= months.length) continue;
        const missing = months.filter((m) => !p.months.has(m));
        if (missing.length)
          rows.push({ Ledger: l.name, 'Months posted': p.months.size, 'Missing months': missing.map((m) => `${MONTH_NAMES[+m.slice(5) - 1]}-${m.slice(2, 4)}`).join(', ') });
      }
      return { rows };
    },
  },
  {
    id: 'salary-cash', area: 'Payroll', phase: 6,
    title: 'Salary / wages paid in cash', ref: 'Sec 40A(3) · PF/ESI traceability', severity: 'medium',
    rec: 'Move payroll to bank transfers; cash salary above ₹10,000 per person per day is disallowable and breaks the PF/ESI audit trail.',
    run(ctx) {
      const rows = [];
      for (const v of ctx.live) {
        let sal = 0, cashCr = 0, led = '';
        for (const e of v.entries) {
          if (['salary', 'salaries', 'wages'].some((w) => hasWord(e.ledger, w)) && e.dr) { sal = r2(sal + e.dr); led = e.ledger; }
          if (ctx.nat(e.ledger).cat.cash) cashCr = r2(cashCr + e.cr);
        }
        if (sal && cashCr && Math.min(sal, cashCr) >= ctx.cfg.cashPaymentLimit)
          rows.push({ Date: disp(v.date), Voucher: vRef(v), 'Salary ledger': led, 'Paid in cash': Math.min(sal, cashCr) });
      }
      return { rows };
    },
  },
  // ----------------------------- Analytics (Phase 4) --------------------------
  {
    id: 'expense-spikes', area: 'Analytics & ratios', phase: 4,
    title: 'Expense ledgers with abnormal monthly spikes', ref: 'SA 520 — analytical procedures', severity: 'low',
    rec: 'Vouch the spike month; one-off bunching often hides capital items, related-party charges or provisions parked as expenses.',
    run(ctx) {
      const rows = [];
      const monthly = new Map(); // ledger -> Map(month -> dr net)
      for (const v of ctx.live) {
        const mKey = `${v.date.getUTCFullYear()}-${pad(v.date.getUTCMonth() + 1)}`;
        for (const e of v.entries) {
          const n = ctx.nat(e.ledger);
          if (!n.pl || !n.dr) continue;
          let m = monthly.get(norm(e.ledger));
          if (!m) { m = { name: e.ledger, months: new Map() }; monthly.set(norm(e.ledger), m); }
          m.months.set(mKey, r2((m.months.get(mKey) || 0) + e.dr - e.cr));
        }
      }
      for (const m of monthly.values()) {
        const vals = [...m.months.values()].filter((x) => x > 0).sort((a, b) => a - b);
        if (vals.length < 6) continue;
        const median = vals[Math.floor(vals.length / 2)];
        const max = vals[vals.length - 1];
        if (median > 0 && max >= median * 3 && max - median >= ctx.M.trivial) {
          const spikeMonth = [...m.months.entries()].find(([, v2]) => v2 === max)?.[0] || '';
          rows.push({ Ledger: m.name, 'Spike month': spikeMonth ? `${MONTH_NAMES[+spikeMonth.slice(5) - 1]}-${spikeMonth.slice(2, 4)}` : '—', 'Spike amount': max, 'Median month': median });
        }
      }
      rows.sort((a, b) => b['Spike amount'] - a['Spike amount']);
      return { rows: rows.slice(0, 100), count: rows.length };
    },
  },
  {
    id: 'top-movements', area: 'Analytics & ratios', phase: 4,
    title: 'Largest balance movements of the year', ref: 'SA 520 — preliminary analytical review', severity: 'info',
    rec: 'Corroborate the story behind each big movement — these set the audit’s risk map.',
    run(ctx) {
      const rows = ctx.ledgers
        .filter((l) => !ctx.nat(l.name).pl)
        .map((l) => ({ Ledger: l.name, Group: l.parent, Opening: l.opening, Closing: l.closing, Movement: r2(l.closing - l.opening) }))
        .sort((a, b) => Math.abs(b.Movement) - Math.abs(a.Movement)).slice(0, 15);
      return { rows: rows.filter((r) => Math.abs(r.Movement) > 1), severity: 'info' };
    },
  },
];

// ------------------------------ ratios & trend -------------------------------
function buildAnalytics(ctx) {
  const t = ctx.totals;
  const sumCat = (pred) => r2(ctx.ledgers.reduce((s, l) => pred(ctx.nat(l.name), l) ? s + l.closing : s, 0));
  const debtors = sumCat((n) => n.cat.debtor);
  const creditors = -sumCat((n) => n.cat.creditor);
  const stockOpen = r2(ctx.ledgers.filter((l) => ctx.nat(l.name).cat.stock).reduce((s, l) => s + l.opening, 0));
  const stockClose = sumCat((n) => n.cat.stock);
  const currentAssets = sumCat((n) => n.cat.currentAsset);
  const currentLiabs = -sumCat((n) => n.cat.currentLiab);
  const borrowings = -sumCat((n) => n.cat.loanLiab);
  const equity = -sumCat((n, l) => n.cat.capital || norm(l.name) === 'profitandlossac');
  const cogs = r2(stockOpen + t.purchasesTotal - stockClose);
  const gp = r2(t.turnover - cogs);
  const ratios = [];
  const push = (name, val, note) => ratios.push({ Ratio: name, Value: val, Note: note });
  if (t.turnover) {
    push('Gross profit %', `${r2((gp / t.turnover) * 100)}%`, `GP ${inr(gp)} on turnover ${inr(t.turnover)} (COGS ≈ opening stock + purchases − closing stock)`);
    push('Net profit %', `${r2((t.pbt / t.turnover) * 100)}%`, `PBT ${inr(t.pbt)}`);
    if (debtors > 0) push('Debtor days', Math.round((debtors / t.turnover) * 365), `Closing debtors ${inr(debtors)}`);
  }
  if (t.purchasesTotal > 0 && creditors > 0) push('Creditor days', Math.round((creditors / t.purchasesTotal) * 365), `Closing creditors ${inr(creditors)}`);
  if (currentLiabs > 0) push('Current ratio', r2(currentAssets / currentLiabs), `${inr(currentAssets)} / ${inr(currentLiabs)}`);
  if (equity > 0) push('Debt : equity', r2(borrowings / equity), `Borrowings ${inr(borrowings)} / equity ${inr(equity)} (incl. P&L)`);
  if (t.interestExp > 0) push('Interest cover', r2((t.pbt + t.interestExp) / t.interestExp), `EBIT ≈ PBT + interest`);
  // Monthly trend.
  const months = new Map();
  for (const v of ctx.live) {
    const k = `${v.date.getUTCFullYear()}-${pad(v.date.getUTCMonth() + 1)}`;
    let m = months.get(k);
    if (!m) { m = { sales: 0, purchases: 0, expenses: 0, journals: 0 }; months.set(k, m); }
    const f = vfamily(v.type);
    if (f === 'journal') m.journals++;
    for (const e of v.entries) {
      const n = ctx.nat(e.ledger);
      if (n.pl && !n.dr) m.sales = r2(m.sales + e.cr - e.dr);
      else if (n.pl && n.dr && n.cat.purchase) m.purchases = r2(m.purchases + e.dr - e.cr);
      else if (n.pl && n.dr) m.expenses = r2(m.expenses + e.dr - e.cr);
    }
  }
  const trend = [...months.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, m]) => ({ month: `${MONTH_NAMES[+k.slice(5) - 1]}-${k.slice(2, 4)}`, ...m }));
  return {
    ratios, trend,
    figures: {
      turnover: t.turnover, income: t.income, expenses: t.expenses, pbt: t.pbt,
      debtors, creditors, stockClose, currentAssets, currentLiabs, borrowings, equity, assets: t.assets,
    },
  };
}

// --------------------------- SA 530 sampling ---------------------------------
function buildSampling(ctx) {
  const pop = ctx.live.filter((v) => v.amount > 0);
  const totalValue = r2(pop.reduce((s, v) => s + v.amount, 0));
  const key = pop.filter((v) => v.amount >= ctx.M.pm);
  const rest = pop.filter((v) => v.amount < ctx.M.pm).sort((a, b) => a.date - b.date);
  const restValue = r2(rest.reduce((s, v) => s + v.amount, 0));
  const interval = Math.max(ctx.M.pm, restValue / 25 || 1);
  const picks = [];
  let cum = 0, next = Math.random() * interval;
  for (const v of rest) {
    cum += v.amount;
    if (cum >= next) { picks.push(v); next += interval; if (picks.length >= 50) break; }
  }
  const row = (v, basis) => ({ Date: disp(v.date), Voucher: vRef(v), Party: v.party || '—', Amount: v.amount, Basis: basis });
  return {
    populationCount: pop.length, populationValue: totalValue,
    keyCount: key.length, keyValue: r2(key.reduce((s, v) => s + v.amount, 0)),
    interval: r2(interval),
    rows: [...key.sort((a, b) => b.amount - a.amount).map((v) => row(v, `Key item ≥ PM ${inr(ctx.M.pm)}`)),
           ...picks.map((v) => row(v, 'Monetary-unit sample'))],
  };
}

// ------------------------------ engine ---------------------------------------
const SEV_RANK = { high: 0, medium: 1, low: 2, info: 3 };
function runChecks(ctx) {
  const out = [];
  for (const c of CHECKS) {
    let r;
    try { r = c.run(ctx) || {}; } catch (e) { r = { rows: [], error: String((e && e.message) || e) }; }
    const rows = (r.rows || []).slice(0, 500);
    const count = r.count ?? (r.rows || []).length;
    const issue = !r.na && (rows.length > 0 || r.flag);
    out.push({
      id: c.id, title: c.title, area: c.area, phase: c.phase, ref: c.ref, rec: c.rec,
      severity: r.severity || c.severity,
      status: r.error ? 'error' : r.na ? 'na' : issue ? 'issue' : 'ok',
      count, rows, summary: r.summary || r.error || '',
    });
  }
  out.sort((a, b) => (a.status === 'issue' ? 0 : 1) - (b.status === 'issue' ? 0 : 1) ||
    SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.area.localeCompare(b.area));
  return out;
}

// -------------------- 10-phase statutory-audit checklist ---------------------
// The full programme (appointment → post-AGM filings). Items with `auto` are
// wired to engine checks and show their live status; the rest are tracked by
// hand on screen and saved per company + FY.
const CHECKLIST = [
  { phase: 1, title: 'Audit acceptance & appointment', items: [
    { id: 'p1-1', text: 'Obtain CIN, PAN, MOA/AOA, nature of business, shareholding pattern, group companies, previous year’s audited FS' },
    { id: 'p1-2', text: 'Verify auditor eligibility & independence — Sec 141 disqualifications, ceiling on audits, no prohibited Sec 144 services, rotation applicability' },
    { id: 'p1-3', text: 'Communicate with the previous auditor (NOC / professional courtesy per ICAI Code)' },
    { id: 'p1-4', text: 'Give written consent & eligibility certificate; collect board/shareholder resolution, appointment letter, Form ADT-1 with challan' },
    { id: 'p1-5', text: 'Issue and obtain signed engagement letter under SA 210' },
  ] },
  { phase: 2, title: 'Audit applicability', items: [
    { id: 'p2-1', text: 'Determine reporting framework — AS or Ind AS, Schedule III division, SFS/CFS, cash-flow requirement, small-company/OPC/dormant exemptions' },
    { id: 'p2-2', text: 'Check applicability: CARO 2020, Internal Financial Controls reporting, audit-trail (Rule 11(g)) reporting' },
    { id: 'p2-3', text: 'Check applicability: branch audit, tax audit (44AB), cost audit, internal audit (Sec 138), CSR (Sec 135), secretarial audit, Form 3CEB / transfer pricing' },
  ] },
  { phase: 3, title: 'Audit requirement list', items: [
    { id: 'p3-1', text: 'Send the records request: final TB, general ledger, PY signed FS, bank statements & BRS, sales/purchase/expense/journal registers' },
    { id: 'p3-2', text: 'Request: fixed-asset register, inventory records & physical-verification report, debtors/creditors ageing, loans & investments detail' },
    { id: 'p3-3', text: 'Request: statutory reconciliations and GST/TDS/PF/ESI/income-tax returns; board & general-meeting minutes; major agreements' },
    { id: 'p3-4', text: 'Request: related-party list & transactions, litigation/contingent liabilities, ROC forms filed, MSME supplier declarations, subsequent events, audit-trail/system reports' },
  ] },
  { phase: 4, title: 'Planning', items: [
    { id: 'p4-1', text: 'Understand the business — revenue model, products, major customers/suppliers, software, controls, related parties, regulation, unusual transactions' },
    { id: 'p4-2', text: 'Preliminary analytical review — YoY comparison, GP/NP ratios, unusual ledger movements, negative balances, round-sum and year-end entries', auto: ['top-movements', 'expense-spikes', 'benford', 'round-journals'] },
    { id: 'p4-3', text: 'Document audit strategy, plan and materiality (this tool computes ICAI-benchmark materiality on the Overview panel)' },
    { id: 'p4-4', text: 'Identify significant risks & fraud risks (SA 315/SA 240); build the audit programme' },
    { id: 'p4-5', text: 'Fix sampling methodology (SA 530 — the Sampling tab gives key items + a monetary-unit sample), team allocation, timeline' },
  ] },
  { phase: 5, title: 'Opening balances, controls & audit trail', items: [
    { id: 'p5-1', text: 'Agree opening balances to PY signed FS (SA 510); first-year: review predecessor’s report and prior qualifications', auto: ['opening-balance', 'pl-opening'] },
    { id: 'p5-2', text: 'Walk through sales-collection, purchase-payment, inventory, payroll, fixed-asset, banking, journal-entry and compliance cycles' },
    { id: 'p5-3', text: 'Test design & operating effectiveness of key controls' },
    { id: 'p5-4', text: 'Audit trail (Rule 11(g)): feature enabled ALL year, edit logs available, no tampering, backups preserved — verify inside Tally (F11 security / TallyVault / Edit Log)', auto: ['cancelled', 'optional', 'dup-vch-no', 'seq-gaps', 'balance-mismatch'] },
  ] },
  { phase: 6, title: 'Substantive audit of the financial statements', items: [
    { id: 'p6-1', text: 'Cash & bank — physical cash count, bank confirmations, BRS testing, FDs, stale cheques, liens', auto: ['negative-cash', 'cash-40a3', 'cash-269st', 'cash-loans', 'bank-credit', 'round-journals'] },
    { id: 'p6-2', text: 'PPE — additions/deletions vouching, capitalisation dates, Schedule II depreciation, title deeds, CWIP, impairment', auto: ['no-depreciation'] },
    { id: 'p6-3', text: 'Inventory — physical verification, valuation & cost formula (AS 2/Ind AS 2), obsolete stock, purchase & sales cut-off' },
    { id: 'p6-4', text: 'Revenue & receivables — recognition, GST reco, cut-off, credit notes, confirmations, subsequent collections, ECL/bad-debt provision, ageing', auto: ['sales-via-journal', 'sales-cutoff', 'yearend-creditnotes', 'debtor-credit', 'gstin-quality', 'dormant'] },
    { id: 'p6-5', text: 'Purchases & creditors — invoice/GRN matching, cut-off, confirmations, unrecorded liabilities, MSME classification, ageing & interest', auto: ['purchase-via-journal', 'dup-supplier-ref', 'creditor-debit', 'msme-ageing'] },
    { id: 'p6-6', text: 'Loans, advances & investments — agreements, approvals, interest, recoverability, Sec 185/186 compliance, confirmations', auto: ['loans-no-interest-income'] },
    { id: 'p6-7', text: 'Borrowings — agreements, lender confirmations, interest & covenants, ROC charge registration, current/non-current split', auto: ['borrow-no-interest'] },
    { id: 'p6-8', text: 'Payroll — employee master, payroll-to-bank reco, TDS/PF/ESI/gratuity/bonus/leave provisions, director & KMP remuneration approvals', auto: ['salary-months', 'salary-cash'] },
    { id: 'p6-9', text: 'Statutory dues — GST/TDS recos with returns and 26AS, PF/ESI, professional tax, income-tax liability, interest & penalties', auto: ['tds-balances', 'gst-balances', 'pf-esi', 'duties-wrongside'] },
    { id: 'p6-10', text: 'Share capital & reserves — share register, PAS-3 allotments, transfers, premium, beneficial ownership, MCA master-data reconciliation' },
    { id: 'p6-11', text: 'Related parties — complete list, Sec 184 declarations, Sec 177/188 approvals, arm’s-length evidence, AS 18/Ind AS 24 disclosure', auto: ['rpt-ledgers'] },
    { id: 'p6-12', text: 'Provisions & contingencies — litigation, tax disputes, employee benefits, warranties, guarantees, onerous contracts (AS 29/Ind AS 37)' },
    { id: 'p6-13', text: 'Current & deferred tax — computation, advance tax & TDS credits, DTA/DTL, disallowances, brought-forward losses' },
  ] },
  { phase: 7, title: 'Companies Act & CARO 2020', items: [
    { id: 'p7-1', text: 'Companies Act review — loans to directors (185), loans & investments (186), RPTs (188), deposits (73–76), managerial remuneration (197), CSR (135), dividend, registers & approvals', auto: ['rpt-ledgers', 'cash-loans'] },
    { id: 'p7-2', text: 'CARO 2020 clause-wise checklist — PPE & title deeds, inventory & working-capital statements, loans/guarantees, deposits, statutory dues, unrecorded income, wilful default, fraud, RPTs, internal audit, cash losses, resignation of auditors, liability-meeting ability, CSR', auto: ['tds-balances', 'gst-balances', 'msme-ageing', 'negative-cash'] },
  ] },
  { phase: 8, title: 'Financial-statement review', items: [
    { id: 'p8-1', text: 'Prepare/review Schedule III statements — balance sheet, P&L, cash flow, SOCE, notes, accounting policies', auto: ['tb-balance', 'wrong-side'] },
    { id: 'p8-2', text: 'Schedule III disclosures — receivable/payable ageing, CWIP ageing, promoter shareholding, ratios with variance reasons, undisclosed income, benami, struck-off companies, crypto, borrowings against current assets, intermediary funding', auto: ['ageing-sch3'] },
    { id: 'p8-3', text: 'Cross-reference every FS figure to the trial balance and working papers', auto: ['balance-mismatch'] },
  ] },
  { phase: 9, title: 'Completion', items: [
    { id: 'p9-1', text: 'Summarise audit differences — corrected & uncorrected misstatements, disclosure and control deficiencies (SA 450)' },
    { id: 'p9-2', text: 'Discuss with management; pass agreed adjustment entries; obtain the revised trial balance' },
    { id: 'p9-3', text: 'Final analytical procedures, going-concern assessment (SA 570), subsequent events (SA 560), fraud conclusion, RPT completeness' },
    { id: 'p9-4', text: 'Obtain signed balance confirmations, legal-case confirmations, subsequent-events declaration, management representation letter (SA 580), board-approved FS' },
    { id: 'p9-5', text: 'Engagement-partner review completed; all review notes cleared' },
  ] },
  { phase: 10, title: 'Report & closure', items: [
    { id: 'p10-1', text: 'Draft the auditor’s report — opinion, basis, going concern, KAM, other information, Sec 143(3), Rule 11 (incl. audit trail), CARO annexure, IFC annexure' },
    { id: 'p10-2', text: 'Report date not earlier than FS approval date; generate UDIN (within the ICAI time limit) with membership no., FRN, place & date' },
    { id: 'p10-3', text: 'Deliver the final set — signed FS, audit report, annexures, MRL, management letter, adjustment-entry sheet' },
    { id: 'p10-4', text: 'Assemble and LOCK the audit file within 60 days (SQC 1 / SA 230)' },
    { id: 'p10-5', text: 'Track post-audit compliance — AGM adoption, AOC-4/XBRL, MGT-7/7A, resolutions, implementation of adjustments' },
  ] },
];

// ------------------------------ audit run ------------------------------------
let RESULT = null; // full result of the last run (memory only — big)

async function runAudit(fromIso, toIso) {
  const from = isoToDate(fromIso), to = isoToDate(toIso);
  if (!from || !to || from > to) throw new Error('Bad period');
  progress.active = true; progress.error = ''; progress.vouchers = 0;
  progress.startedAt = Date.now();
  progress.bytes = 0; progress.step = 0; progress.monthsDone = 0; progress.monthsTotal = 0;
  try {
    progress.step = 1;
    progress.phase = 'Reading group masters…';
    const groupsXml = await askTallyRetry(collectionRequest('AuditGroups', 'Group',
      ['Name', 'Parent', 'IsRevenue', 'IsDeemedPositive']), 300000, 'Reading group masters');
    const groups = parseGroups(groupsXml);
    progress.step = 2;
    progress.phase = 'Reading ledger masters… (large books can take several minutes here)';
    const ledgersXml = await askTallyRetry(collectionRequest('AuditLedgers', 'Ledger',
      ['Name', 'Parent', 'OpeningBalance', 'ClosingBalance', 'PartyGSTIN', 'IsBillwiseOn'], { from, to }), 600000, 'Reading ledger masters');
    const ledgers = parseLedgers(ledgersXml);
    if (!ledgers.length) {
      const err = ledgersXml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i);
      throw new Error(err ? 'Tally: ' + decodeXml(err[1].trim())
        : 'No ledgers received — is the right company open in Tally (and the name in Settings exact)?');
    }
    progress.step = 3;
    progress.phase = 'Reading vouchers…';
    const vouchers = await readVouchers(from, to);
    progress.step = 4;
    progress.phase = 'Reading bill-wise outstandings…';
    let billsRecv = [], billsPay = [];
    try { billsRecv = parseBills(await askTally(reportRequest('Bills Receivable', from, to), 300000)); } catch { /* optional */ }
    try { billsPay = parseBills(await askTally(reportRequest('Bills Payable', from, to), 300000)); } catch { /* optional */ }
    progress.step = 5;
    progress.phase = 'Running audit checks…';
    const cfg = state.settings;
    const ctx = buildContext({ company: cfg.company || '(open company)', from, to, groups, ledgers, vouchers, billsRecv, billsPay, cfg });
    const findings = runChecks(ctx);
    const analytics = buildAnalytics(ctx);
    const sampling = buildSampling(ctx);
    const tb = ledgers.map((l) => {
      const p = ctx.postOf(l.name);
      return { Ledger: l.name, Group: l.parent, Opening: l.opening, Debit: p.dr, Credit: p.cr, Closing: l.closing };
    }).sort((a, b) => a.Group.localeCompare(b.Group) || a.Ledger.localeCompare(b.Ledger));
    const counts = {
      vouchers: vouchers.length, live: ctx.live.length,
      cancelled: vouchers.filter((v) => v.cancelled).length,
      optional: vouchers.filter((v) => v.optional).length,
      ledgers: ledgers.length, groups: groups.size,
      billsRecv: billsRecv.length, billsPay: billsPay.length,
      issues: findings.filter((f) => f.status === 'issue' && f.severity !== 'info').length,
      high: findings.filter((f) => f.status === 'issue' && f.severity === 'high').length,
      medium: findings.filter((f) => f.status === 'issue' && f.severity === 'medium').length,
      low: findings.filter((f) => f.status === 'issue' && f.severity === 'low').length,
    };
    RESULT = {
      company: cfg.company || '(open company)', from: fromIso, to: toIso,
      generatedAt: new Date().toISOString(), version: VERSION,
      counts, materiality: ctx.M, totals: ctx.totals, findings, analytics, sampling, tb,
    };
    // Persist a trimmed copy so a restart still shows the last run.
    state.lastRun = { ...RESULT, tb: [], findings: findings.map((f) => ({ ...f, rows: f.rows.slice(0, 50) })) };
    saveState();
    progress.phase = 'done';
  } catch (e) {
    const msg = String((e && e.message) || e);
    const where = progress.phase && progress.phase !== 'error'
      ? progress.phase.replace(/….*$/, '').replace(/ — .*$/, '') : '';
    progress.error = (where ? where + ': ' : '') + msg +
      (/timeout|abort/i.test(msg)
        ? ' — Tally answers big exports slowly. Leave Tally idle on the Gateway of Tally screen (not inside any report) and press Run audit again; the second run is usually much faster.'
        : '');
    progress.phase = 'error';
  } finally {
    progress.active = false;
  }
}

// ------------------------------ CSV helpers ----------------------------------
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
}

// -------------------------- management-letter draft --------------------------
function letterHtml(result) {
  const sev = { high: 'High', medium: 'Medium', low: 'Low', info: 'For information' };
  const issues = result.findings.filter((f) => f.status === 'issue' && f.severity !== 'info');
  const section = (s) => issues.filter((f) => f.severity === s).map((f, i) => `
    <div class="obs">
      <h4>${i + 1}. ${escHtml(f.title)} <span class="tag">${escHtml(f.area)}</span></h4>
      <p class="ref">Reference: ${escHtml(f.ref)} · ${f.count} instance(s) noted${f.summary ? ' · ' + escHtml(f.summary) : ''}</p>
      <p><b>Recommendation:</b> ${escHtml(f.rec)}</p>
    </div>`).join('');
  const block = (s, label) => {
    const h = section(s);
    return h ? `<h3>${label} observations</h3>${h}` : '';
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Management letter — ${escHtml(result.company)}</title>
<style>
 body{font:14px/1.55 Georgia,serif;color:#1a1a1a;max-width:820px;margin:2rem auto;padding:0 1rem}
 h1{font-size:22px;margin-bottom:0} h2{font-size:16px;color:#555;font-weight:normal;margin-top:4px}
 h3{margin-top:28px;border-bottom:1px solid #999;padding-bottom:4px}
 h4{margin:18px 0 4px} .ref{color:#555;font-size:12.5px;margin:2px 0}
 .tag{font-size:11px;background:#eee;border-radius:3px;padding:1px 6px;font-family:sans-serif;vertical-align:middle}
 .note{background:#f6f6f6;border-left:3px solid #bbb;padding:8px 12px;font-size:12.5px}
 @media print{.noprint{display:none}}
</style></head><body>
<p class="noprint" style="text-align:right"><button onclick="print()">Print / save as PDF</button></p>
<h1>Management letter — audit observations (draft)</h1>
<h2>${escHtml(result.company)} · FY ${escHtml(result.from)} to ${escHtml(result.to)} · generated ${escHtml(result.generatedAt.slice(0, 10))}</h2>
<p>To the Board of Directors,</p>
<p>In the course of our statutory audit for the year, the following matters came to attention from an automated
examination of the books of account (every ledger and voucher of the period). They are graded by importance.
This letter is a draft for discussion with management; it does not modify our audit opinion, and inclusion here
is subject to verification of the underlying records.</p>
<p class="note">Basis: ${result.counts.vouchers.toLocaleString('en-IN')} vouchers and ${result.counts.ledgers.toLocaleString('en-IN')} ledgers examined ·
overall materiality ${inr(result.materiality.om)} (${escHtml(result.materiality.basis)}) ·
performance materiality ${inr(result.materiality.pm)}.</p>
${block('high', 'High-importance')}
${block('medium', 'Medium-importance')}
${block('low', 'Low-importance')}
${issues.length ? '' : '<p><b>No reportable observations arose from the automated examination.</b></p>'}
<p style="margin-top:36px">For <i>(Firm name)</i><br>Chartered Accountants<br>FRN: ______</p>
<p><i>(Partner name)</i>, Partner · M. No. ______ · UDIN: ______<br>Place: ______ · Date: ______</p>
</body></html>`;
}

// ------------------------------- self test -----------------------------------
function selfTest() {
  const L = (name, parent, open, close, extra = '') =>
    `<LEDGER NAME="${name}"><NAME>${name}</NAME><PARENT>${parent}</PARENT>` +
    `<OPENINGBALANCE>${open}</OPENINGBALANCE><CLOSINGBALANCE>${close}</CLOSINGBALANCE>${extra}</LEDGER>`;
  // Tally sign convention: credit +, debit −.
  const ledgersXml = [
    L('Cash', 'Cash-in-Hand', '-5000', '-5000'),
    L('HDFC Bank', 'Bank Accounts', '-200000', '150000'),
    L('Sales A/c', 'Sales Accounts', '0', '400000'),
    L('Purchase A/c', 'Purchase Accounts', '0', '-250000'),
    L('Debtor A', 'Sundry Debtors', '-100000', '40000'),
    L('Creditor B', 'Sundry Creditors', '80000', '-30000'),
    L('TDS Payable', 'Duties & Taxes', '0', '25000'),
    L('GST Output', 'Duties & Taxes', '0', '-12000'),
    L('Suspense A/c', 'Suspense A/c', '0', '-7000'),
    L('Director Loan', 'Unsecured Loans', '300000', '350000'),
    L('Loan to XYZ Associates', 'Loans & Advances (Asset)', '-500000', '-500000'),
    L('Salary', 'Indirect Expenses', '0', '-120000'),
    L('Rent', 'Indirect Expenses', '-15000', '-60000'),
    L('Plant & Machinery', 'Fixed Assets', '-800000', '-800000'),
  ].join('');
  const E = (ledger, amt, extra = '') =>
    `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${ledger}</LEDGERNAME>` +
    `<ISDEEMEDPOSITIVE>${amt < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amt}</AMOUNT>${extra}</ALLLEDGERENTRIES.LIST>`;
  const V = (date, type, num, body, extra = '') =>
    `<VOUCHER VCHTYPE="${type}"><DATE>${date}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>` +
    `<VOUCHERNUMBER>${num}</VOUCHERNUMBER><GUID>st-${type}-${num}-${date}</GUID>${extra}${body}</VOUCHER>`;
  const vouchersXml = [
    // Cash payment ₹15,000 (40A(3)) — also drives cash negative (opening 5,000).
    V('20250410', 'Payment', '1', E('Rent', -15000) + E('Cash', 15000), '<NARRATION>Office rent in cash</NARRATION>'),
    // Cash receipt ₹2,50,000 from one party in a day (269ST).
    V('20250510', 'Receipt', '1', E('Cash', -250000) + E('Debtor A', 250000), '<PARTYLEDGERNAME>Debtor A</PARTYLEDGERNAME><NARRATION>Cash received</NARRATION>'),
    // Loan accepted in cash ₹50,000 (269SS).
    V('20250601', 'Receipt', '2', E('Cash', -50000) + E('Director Loan', 50000), '<PARTYLEDGERNAME>Director Loan</PARTYLEDGERNAME><NARRATION>Loan from director</NARRATION>'),
    // Journal ≥ threshold without narration + round sum.
    V('20250715', 'Journal', '1', E('Salary', -100000) + E('Creditor B', 100000)),
    // Duplicate voucher number (Journal #1 again).
    V('20250801', 'Journal', '1', E('Rent', -20000) + E('Creditor B', 20000), '<NARRATION>Rent provision</NARRATION>'),
    // Revenue credited via journal.
    V('20250901', 'Journal', '3', E('Debtor A', -20000) + E('Sales A/c', 20000), '<NARRATION>Sales booked by JV</NARRATION>'),
    // Self-contra: same ledger both sides.
    V('20251001', 'Journal', '4', E('Debtor A', -50000) + E('Debtor A', 50000), '<NARRATION>Regrouping</NARRATION>'),
    // Purchase booked twice with the same supplier reference.
    V('20251101', 'Purchase', '10', E('Purchase A/c', -100000) + E('Creditor B', 100000), '<PARTYLEDGERNAME>Creditor B</PARTYLEDGERNAME><REFERENCE>BILL-77</REFERENCE><NARRATION>Goods</NARRATION>'),
    V('20251115', 'Purchase', '11', E('Purchase A/c', -100000) + E('Creditor B', 100000), '<PARTYLEDGERNAME>Creditor B</PARTYLEDGERNAME><REFERENCE>BILL-77</REFERENCE><NARRATION>Goods again</NARRATION>'),
    // Salary paid in cash ₹12,000.
    V('20251205', 'Payment', '2', E('Salary', -12000) + E('Cash', 12000), '<NARRATION>Wages in cash</NARRATION>'),
    // Sales series 1…10 plus 12 — number 11 is missing (sequence-gap check).
    ...[1, 2, 3, 4, 5, 6, 7, 8, 10, 12].map((n, i) =>
      V(`202504${pad(2 + i)}`, 'Sales', String(n), E('Sales A/c', 30000) + E('Debtor A', -30000), '<PARTYLEDGERNAME>Debtor A</PARTYLEDGERNAME>')),
    V('20260330', 'Sales', '9', E('Sales A/c', 350000) + E('Debtor A', -350000), '<PARTYLEDGERNAME>Debtor A</PARTYLEDGERNAME><NARRATION>Year-end invoice</NARRATION>'),
    // A cancelled voucher.
    V('20260210', 'Payment', '9', E('Rent', -5000) + E('Cash', 5000), '<ISCANCELLED>Yes</ISCANCELLED>'),
  ].join('');
  const groups = parseGroups(''); // rely on the built-in primary-group table
  const ledgers = parseLedgers(ledgersXml);
  const { vouchers } = parseVoucherXml(vouchersXml);
  const from = isoToDate('2025-04-01'), to = isoToDate('2026-03-31');
  const cfg = { ...DEFAULT_STATE.settings };
  const ctx = buildContext({ company: 'Self test', from, to, groups, ledgers, vouchers, billsRecv: [], billsPay: [], cfg });
  const findings = runChecks(ctx);
  const got = new Map(findings.map((f) => [f.id, f]));
  const expectIssue = ['negative-cash', 'cash-40a3', 'cash-269st', 'cash-loans', 'no-narration',
    'dup-vch-no', 'sales-via-journal', 'self-contra', 'dup-supplier-ref', 'salary-cash',
    'suspense', 'tds-balances', 'gst-balances', 'debtor-credit', 'creditor-debit',
    'pl-opening', 'no-depreciation', 'cancelled', 'seq-gaps', 'round-journals'];
  let pass = 0, fail = 0;
  for (const id of expectIssue) {
    const f = got.get(id);
    const ok = f && f.status === 'issue';
    console.log(`  ${ok ? '✅' : '❌'} ${id}${f ? ` (${f.count} row(s))` : ' — MISSING'}`);
    ok ? pass++ : fail++;
  }
  // Checks that must NOT fire on this data.
  for (const id of ['borrow-no-interest']) {
    const f = got.get(id);
    const ok = f && f.status !== 'error';
    console.log(`  ${ok ? '✅' : '❌'} ${id} ran without error (status: ${f ? f.status : 'missing'})`);
    ok ? pass++ : fail++;
  }
  const anyError = findings.filter((f) => f.status === 'error');
  for (const f of anyError) { console.log(`  ❌ check ${f.id} errored: ${f.summary}`); fail++; }
  const analytics = buildAnalytics(ctx);
  const sampling = buildSampling(ctx);
  console.log(`  ℹ materiality ${inr(ctx.M.om)} (${ctx.M.basis}) · turnover ${inr(ctx.totals.turnover)} · PBT ${inr(ctx.totals.pbt)}`);
  console.log(`  ℹ ratios: ${analytics.ratios.length}, trend months: ${analytics.trend.length}, sample size: ${sampling.rows.length}`);
  console.log(fail ? `SELF-TEST FAILED — ${fail} problem(s), ${pass} ok` : `SELF-TEST PASSED — ${pass} assertion(s)`);
  process.exit(fail ? 1 : 0);
}

// -------------------------------- server -------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const key = `${norm(state.settings.company)}|${state.settings.fyFrom || defaultFY().from}`;
      json(res, 200, {
        ok: true, version: VERSION, settings: state.settings, defaultFY: defaultFY(),
        checklist: CHECKLIST, ticks: state.checklist[key] || {}, hasResult: !!(RESULT || state.lastRun),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = JSON.parse(await readBody(req) || '{}');
      for (const k of Object.keys(DEFAULT_STATE.settings))
        if (k in body) state.settings[k] = typeof DEFAULT_STATE.settings[k] === 'number' ? Number(body[k]) || 0 : String(body[k]);
      saveState();
      json(res, 200, { ok: true, settings: state.settings });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/companies') {
      try {
        const xml = await askTally(collectionRequest('AuditCompanies', 'Company', ['Name', 'StartingFrom'], { company: false }), 15000);
        json(res, 200, { ok: true, companies: parseCompanies(xml) });
      } catch (e) {
        json(res, 200, { ok: false, error: 'Tally not reachable at ' + state.settings.tallyUrl + ' — ' + String((e && e.message) || e) });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (progress.active) { json(res, 200, { ok: false, error: 'A run is already in progress' }); return; }
      const body = JSON.parse(await readBody(req) || '{}');
      const fy = defaultFY();
      const fromIso = body.from || state.settings.fyFrom || fy.from;
      const toIso = body.to || state.settings.fyTo || fy.to;
      state.settings.fyFrom = fromIso; state.settings.fyTo = toIso; saveState();
      runAudit(fromIso, toIso); // async — browser polls /api/progress
      json(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/progress') { json(res, 200, progress); return; }
    if (req.method === 'GET' && url.pathname === '/api/result') {
      const r = RESULT || state.lastRun;
      json(res, 200, r ? { ok: true, result: r, trimmed: !RESULT } : { ok: false, error: 'No run yet' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/checklist') {
      const body = JSON.parse(await readBody(req) || '{}');
      const key = `${norm(state.settings.company)}|${state.settings.fyFrom || defaultFY().from}`;
      if (!state.checklist[key]) state.checklist[key] = {};
      if (body.done) state.checklist[key][body.id] = true; else delete state.checklist[key][body.id];
      saveState();
      json(res, 200, { ok: true, ticks: state.checklist[key] });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/export/')) {
      const r = RESULT || state.lastRun;
      if (!r) { json(res, 404, { ok: false, error: 'No run yet' }); return; }
      const send = (name, text, type = 'text/csv') => {
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="${name}"` });
        res.end('\uFEFF' + text); // BOM so Excel opens UTF-8 (₹) correctly
      };
      const what = url.pathname.slice('/api/export/'.length);
      if (what === 'findings.csv') {
        send('audit-findings.csv', toCsv(r.findings.map((f) => ({
          Severity: f.severity, Status: f.status, Area: f.area, Check: f.title,
          Instances: f.count, Reference: f.ref, Summary: f.summary, Recommendation: f.rec,
        }))));
      } else if (what === 'check.csv') {
        const f = r.findings.find((x) => x.id === url.searchParams.get('id'));
        if (!f) { json(res, 404, { ok: false, error: 'No such check' }); return; }
        send(`audit-${f.id}.csv`, toCsv(f.rows));
      } else if (what === 'sampling.csv') {
        send('audit-sampling.csv', toCsv(r.sampling.rows));
      } else if (what === 'tb.csv') {
        send('trial-balance.csv', toCsv(RESULT ? RESULT.tb : []));
      } else if (what === 'letter.html') {
        send('management-letter.html', letterHtml(r), 'text/html');
      } else json(res, 404, { ok: false, error: 'Unknown export' });
      return;
    }
    json(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

if (process.argv.includes('--selftest')) {
  selfTest();
} else {
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is in use — is the tool already running? (set PORT=8790 to use another port)`);
      process.exit(1);
    }
    throw e;
  });
  server.listen(PORT, () => {
    console.log('');
    console.log('  Tally Statutory Audit Assistant v' + VERSION);
    console.log('  ───────────────────────────────────────────');
    console.log('  Open   http://localhost:' + PORT);
    console.log('  Tally  ' + state.settings.tallyUrl + ' (keep the company open)');
    console.log('  Data stays on this computer: ' + DATA_FILE);
    console.log('');
  });
}

// --------------------------------- the page ----------------------------------
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Tally Statutory Audit Assistant</title>
<style>
  :root{--ink:#1c2430;--mut:#5b6572;--line:#dfe3e8;--bg:#f4f6f8;--card:#fff;
    --hi:#c62828;--md:#ef6c00;--lo:#b58900;--in:#607d8b;--ok:#2e7d32;--acc:#1a56db}
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.5 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg)}
  header{background:#10233f;color:#fff;padding:10px 18px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;font-weight:600}
  header .sub{font-size:12px;opacity:.75}
  .dot{width:9px;height:9px;border-radius:50%;background:#9aa4af;display:inline-block;margin-right:5px}
  .dot.on{background:#4caf50}.dot.off{background:#e53935}
  main{max-width:1180px;margin:14px auto;padding:0 14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:14px}
  .grid{display:grid;gap:10px}
  .setup{grid-template-columns:2fr 2fr 1fr 1fr auto;align-items:end}
  label{display:block;font-size:11.5px;color:var(--mut);margin-bottom:3px}
  input,select{width:100%;padding:7px 8px;border:1px solid var(--line);border-radius:5px;font:inherit;background:#fff}
  button{padding:8px 16px;border:0;border-radius:5px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
  button.sec{background:#e8ecf1;color:var(--ink);font-weight:500}
  button:disabled{opacity:.55;cursor:default}
  .muted{color:var(--mut);font-size:12.5px}
  .err{background:#fdecea;border:1px solid #f5c6c1;color:#9c1f14;padding:8px 12px;border-radius:6px;margin-top:10px;display:none}
  .prog{display:none;margin-top:10px;font-size:13px}
  .steps{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:7px}
  .stp{font-size:11.5px;padding:2px 10px;border-radius:10px;background:#eef1f5;color:var(--mut);border:1px solid var(--line)}
  .stp.done{background:#e6f4ea;color:var(--ok);border-color:#bfe3c6}
  .stp.cur{background:#e8effc;color:var(--acc);border-color:#bcd0f5;animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.5}}
  .pmeta{float:right;color:var(--mut);font-variant-numeric:tabular-nums}
  .bar{height:8px;background:#e5e9ee;border-radius:4px;overflow:hidden;margin-top:6px}
  .bar i{display:block;height:100%;width:0%;transition:width .5s;border-radius:4px;
    background:repeating-linear-gradient(45deg,var(--acc) 0 10px,#4a76e0 10px 20px);
    background-size:28px 28px;animation:slide 1s linear infinite}
  @keyframes slide{to{background-position:28px 0}}
  .kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px}
  .kpi b{display:block;font-size:20px;margin-top:2px}
  .kpi.hi b{color:var(--hi)}.kpi.md b{color:var(--md)}.kpi.lo b{color:var(--lo)}
  nav.tabs{display:flex;gap:4px;margin:16px 0 10px;flex-wrap:wrap}
  nav.tabs button{background:#e8ecf1;color:var(--ink);font-weight:500;border-radius:6px 6px 0 0}
  nav.tabs button.on{background:var(--card);border:1px solid var(--line);border-bottom-color:var(--card);font-weight:600}
  .chip{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.4px;padding:2px 8px;border-radius:10px;color:#fff;vertical-align:middle}
  .chip.high{background:var(--hi)}.chip.medium{background:var(--md)}.chip.low{background:var(--lo)}
  .chip.info{background:var(--in)}.chip.ok{background:var(--ok)}.chip.na{background:#9aa4af}.chip.error{background:#6a1b9a}
  details.f{border:1px solid var(--line);border-radius:7px;margin-bottom:8px;background:var(--card)}
  details.f>summary{padding:10px 14px;cursor:pointer;display:flex;gap:10px;align-items:center;list-style:none;flex-wrap:wrap}
  details.f>summary::-webkit-details-marker{display:none}
  details.f .body{padding:2px 14px 12px;border-top:1px solid var(--line)}
  .cnt{margin-left:auto;font-size:12px;color:var(--mut);white-space:nowrap}
  table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px}
  th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}
  th{background:#f0f3f6;font-weight:600;white-space:nowrap}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .tblwrap{overflow-x:auto}
  .ref{font-size:11.5px;color:var(--mut)}
  .rec{background:#f6f8fa;border-left:3px solid var(--acc);padding:6px 10px;font-size:12.5px;margin:8px 0}
  .filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
  .filters input,.filters select{width:auto}
  .phase{border:1px solid var(--line);border-radius:7px;background:var(--card);margin-bottom:10px}
  .phase>h3{margin:0;padding:9px 14px;font-size:13.5px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}
  .phase .items{padding:6px 14px 10px}
  .item{display:flex;gap:9px;padding:6px 0;border-bottom:1px dashed #eceff2;align-items:flex-start}
  .item:last-child{border-bottom:0}
  .item input{width:15px;height:15px;margin-top:2px;flex:none}
  .item .t{flex:1}
  .auto{font-size:11px;margin-top:2px}
  .pill{display:inline-block;font-size:10.5px;border-radius:9px;padding:1px 8px;margin:1px 4px 1px 0;border:1px solid var(--line);cursor:pointer}
  .pill.issue{border-color:var(--md);color:var(--md)}
  .pill.issue.high{border-color:var(--hi);color:var(--hi)}
  .pill.okp{border-color:var(--ok);color:var(--ok)}
  .mat td{border:0;padding:2px 14px 2px 0}
  .neg{color:var(--hi)}
  svg text{font:10px sans-serif;fill:var(--mut)}
  footer{margin:22px 0;text-align:center;color:var(--mut);font-size:12px}
  @media (max-width:820px){.setup{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<header>
  <h1>🧾 Tally Statutory Audit Assistant</h1>
  <span class="sub">every ledger · every voucher · graded findings</span>
  <span style="margin-left:auto"><span class="dot" id="tdot"></span><span id="tstat" class="sub">checking Tally…</span></span>
</header>
<main>
  <div class="card">
    <div class="grid setup">
      <div><label>Tally URL</label><input id="tallyUrl" placeholder="http://localhost:9000"></div>
      <div><label>Company (leave blank = the open company)</label>
        <div style="display:flex;gap:6px"><select id="company"><option value="">(the open company)</option></select>
        <button class="sec" id="refreshCo" title="Re-read companies from Tally">↻</button></div></div>
      <div><label>From</label><input type="date" id="from"></div>
      <div><label>To</label><input type="date" id="to"></div>
      <div><button id="run">Run audit</button></div>
    </div>
    <div class="prog" id="prog">
      <div class="steps" id="psteps"></div>
      <div><span id="ptext"></span><span class="pmeta" id="pmeta"></span></div>
      <div class="bar"><i id="pbar"></i></div>
    </div>
    <div class="err" id="perr"></div>
    <details style="margin-top:10px"><summary class="muted">Audit settings — materiality, thresholds, related-party keywords, MSME names</summary>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(190px,1fr));margin-top:10px" id="setgrid">
        <div><label>Materiality</label><select id="materialityMode"><option value="auto">Auto (ICAI benchmarks)</option><option value="manual">Manual</option></select></div>
        <div><label>Manual materiality ₹</label><input type="number" id="materialityValue"></div>
        <div><label>% of turnover</label><input type="number" id="pctTurnover" step="0.1"></div>
        <div><label>% of PBT</label><input type="number" id="pctPBT" step="0.1"></div>
        <div><label>% of total assets</label><input type="number" id="pctAssets" step="0.1"></div>
        <div><label>Performance materiality %</label><input type="number" id="perfPct"></div>
        <div><label>Cash payment limit (40A(3)) ₹</label><input type="number" id="cashPaymentLimit"></div>
        <div><label>Cash receipt limit (269ST) ₹</label><input type="number" id="cashReceiptLimit"></div>
        <div><label>Cash loan limit (269SS/T) ₹</label><input type="number" id="cashLoanLimit"></div>
        <div><label>MSME days</label><input type="number" id="msmeDays"></div>
        <div><label>Narration needed above ₹</label><input type="number" id="narrationMin"></div>
        <div><label>Round-sum multiple ₹</label><input type="number" id="roundUnit"></div>
        <div><label>Round-sum minimum ₹</label><input type="number" id="roundMin"></div>
        <div><label>Year-end window (days)</label><input type="number" id="yearEndDays"></div>
        <div><label>Dormant balance above ₹</label><input type="number" id="dormantMin"></div>
        <div><label>Weekly off</label><select id="weeklyOff"><option value="sun">Sunday</option><option value="sat-sun">Sat + Sun</option><option value="none">None</option></select></div>
        <div style="grid-column:1/-1"><label>Extra holidays (yyyy-mm-dd, comma separated)</label><input id="holidays"></div>
        <div style="grid-column:1/-1"><label>Related-party keywords (comma separated)</label><input id="rptKeywords"></div>
        <div style="grid-column:1/-1"><label>Related-party ledger names declared by management</label><input id="rptNames"></div>
        <div style="grid-column:1/-1"><label>Confirmed MSME supplier ledger names</label><input id="msmeNames"></div>
      </div>
      <div style="margin-top:10px"><button class="sec" id="saveSet">Save settings</button> <span class="muted" id="savedMsg"></span></div>
    </details>
  </div>

  <div id="overview" style="display:none">
    <div class="grid kpis" id="kpis"></div>
    <div class="card" id="matcard" style="margin-top:14px"></div>
  </div>

  <nav class="tabs" id="tabs" style="display:none">
    <button data-t="findings" class="on">Findings</button>
    <button data-t="analytics">Analytics</button>
    <button data-t="tb">Trial balance</button>
    <button data-t="sampling">Sampling</button>
    <button data-t="checklist">Audit checklist</button>
    <button data-t="report">Report</button>
  </nav>
  <div id="tab-findings" class="tab"></div>
  <div id="tab-analytics" class="tab" style="display:none"></div>
  <div id="tab-tb" class="tab" style="display:none"></div>
  <div id="tab-sampling" class="tab" style="display:none"></div>
  <div id="tab-checklist" class="tab" style="display:none"></div>
  <div id="tab-report" class="tab" style="display:none"></div>
  <footer>Runs entirely on this computer — the books never leave it. Findings are audit LEADS for professional judgement, not conclusions.</footer>
</main>
<script>
'use strict';
var STATE = null, RESULT = null, TICKS = {};
function $(id){ return document.getElementById(id); }
function h(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(v){
  if (typeof v === 'number') {
    var s = Math.abs(v).toLocaleString('en-IN', {maximumFractionDigits:2});
    return v < 0 ? '\\u2212' + s : s;
  }
  return h(v);
}
function isNum(v){ return typeof v === 'number'; }
function api(path, body){
  var opt = body ? {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)} : {};
  return fetch(path, opt).then(function(r){ return r.json(); });
}
var SEVL = {high:'High', medium:'Medium', low:'Low', info:'Info', ok:'Clean', na:'N/A', error:'Error'};
function chip(sev){ return '<span class="chip ' + sev + '">' + SEVL[sev] + '</span>'; }

// ------------------------------- boot ---------------------------------------
function init(){
  api('/api/state').then(function(st){
    STATE = st; TICKS = st.ticks || {};
    var s = st.settings;
    var ids = ['tallyUrl','materialityMode','materialityValue','pctTurnover','pctPBT','pctAssets','perfPct',
      'cashPaymentLimit','cashReceiptLimit','cashLoanLimit','msmeDays','narrationMin','roundUnit','roundMin',
      'yearEndDays','dormantMin','weeklyOff','holidays','rptKeywords','rptNames','msmeNames'];
    ids.forEach(function(k){ if ($(k)) $(k).value = s[k]; });
    $('from').value = s.fyFrom || st.defaultFY.from;
    $('to').value = s.fyTo || st.defaultFY.to;
    loadCompanies();
    renderChecklist();
    if (st.hasResult) loadResult();
    // If a run is already going (page refreshed mid-audit), pick it back up.
    api('/api/progress').then(function(p){
      if (p.active) { $('run').disabled = true; $('prog').style.display = 'block'; poll(); }
    });
  });
}
function loadCompanies(){
  $('tstat').textContent = 'checking Tally\\u2026';
  api('/api/companies').then(function(r){
    var sel = $('company'), keep = STATE.settings.company || '';
    sel.innerHTML = '<option value="">(the open company)</option>';
    if (r.ok) {
      $('tdot').className = 'dot on'; $('tstat').textContent = 'Tally connected \\u00b7 ' + r.companies.length + ' company(ies) open';
      r.companies.forEach(function(c){
        var o = document.createElement('option'); o.value = c.name; o.textContent = c.name; sel.appendChild(o);
      });
    } else {
      $('tdot').className = 'dot off'; $('tstat').textContent = 'Tally not reachable';
    }
    if (keep) { sel.value = keep; if (sel.value !== keep) { var o2 = document.createElement('option'); o2.value = keep; o2.textContent = keep; sel.appendChild(o2); sel.value = keep; } }
  });
}
$('refreshCo').onclick = loadCompanies;
$('saveSet').onclick = function(){ saveSettings().then(function(){ $('savedMsg').textContent = 'Saved \\u2713'; setTimeout(function(){ $('savedMsg').textContent=''; }, 1500); }); };
function saveSettings(){
  var body = { company: $('company').value, fyFrom: $('from').value, fyTo: $('to').value };
  ['tallyUrl','materialityMode','materialityValue','pctTurnover','pctPBT','pctAssets','perfPct',
   'cashPaymentLimit','cashReceiptLimit','cashLoanLimit','msmeDays','narrationMin','roundUnit','roundMin',
   'yearEndDays','dormantMin','weeklyOff','holidays','rptKeywords','rptNames','msmeNames'].forEach(function(k){ body[k] = $(k).value; });
  return api('/api/settings', body).then(function(r){ STATE.settings = r.settings; });
}

// ------------------------------- run ----------------------------------------
$('run').onclick = function(){
  saveSettings().then(function(){
    return api('/api/run', {from: $('from').value, to: $('to').value});
  }).then(function(r){
    if (!r.ok) { showErr(r.error); return; }
    $('run').disabled = true; $('perr').style.display = 'none';
    $('prog').style.display = 'block';
    poll();
  });
};
function showErr(t){ $('perr').textContent = t; $('perr').style.display = 'block'; $('prog').style.display = 'none'; $('run').disabled = false; }
var STEP_NAMES = ['Group masters', 'Ledger masters', 'Vouchers', 'Bill-wise dues', 'Audit checks'];
function drawProgress(p){
  var out = '', i, n, cls, done;
  for (i = 0; i < STEP_NAMES.length; i++) {
    n = i + 1;
    done = p.phase === 'done' || n < p.step;
    cls = 'stp' + (done ? ' done' : n === p.step ? ' cur' : '');
    out += '<span class="' + cls + '">' + (done ? '\\u2713 ' : '') + n + '. ' + STEP_NAMES[i] + '</span>';
  }
  $('psteps').innerHTML = out;
  var pct = 2;
  if (p.step === 1) pct = 5;
  else if (p.step === 2) pct = 14;
  else if (p.step === 3) pct = 30 + (p.monthsTotal ? Math.round(56 * p.monthsDone / p.monthsTotal) : 0);
  else if (p.step === 4) pct = 89;
  else if (p.step === 5) pct = 95;
  if (p.phase === 'done') pct = 100;
  $('pbar').style.width = pct + '%';
  $('ptext').textContent = p.phase +
    (p.step === 3 && p.monthsTotal ? ' \\u2014 month ' + p.monthsDone + '/' + p.monthsTotal : '');
  var meta = [];
  if (p.vouchers) meta.push(p.vouchers.toLocaleString('en-IN') + ' vouchers');
  if (p.bytes) meta.push((p.bytes < 1048576 ? Math.round(p.bytes / 1024) + ' KB' : (p.bytes / 1048576).toFixed(1) + ' MB') + ' from Tally');
  if (p.startedAt) {
    var s = Math.max(0, Math.round((Date.now() - p.startedAt) / 1000));
    meta.push(Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) + ' elapsed');
  }
  $('pmeta').textContent = meta.join(' \\u00b7 ');
}
function poll(){
  api('/api/progress').then(function(p){
    if (p.phase === 'error') { showErr(p.error || 'Run failed'); return; }
    drawProgress(p);
    if (p.phase === 'done') { $('run').disabled = false; $('prog').style.display = 'none'; loadResult(); return; }
    if (!p.active && p.phase !== 'done') { showErr(p.error || 'Run stopped'); return; }
    setTimeout(poll, 600);
  });
}
function loadResult(){
  api('/api/result').then(function(r){
    if (!r.ok) return;
    RESULT = r.result; RESULT._trimmed = r.trimmed;
    renderAll();
  });
}

// ------------------------------ render --------------------------------------
function renderAll(){
  $('overview').style.display = 'block';
  $('tabs').style.display = 'flex';
  renderOverview(); renderFindings(); renderAnalytics(); renderTB(); renderSampling(); renderChecklist(); renderReport();
}
document.querySelectorAll('nav.tabs button').forEach(function(b){
  b.onclick = function(){
    document.querySelectorAll('nav.tabs button').forEach(function(x){ x.className = ''; });
    b.className = 'on';
    document.querySelectorAll('.tab').forEach(function(t){ t.style.display = 'none'; });
    $('tab-' + b.dataset.t).style.display = 'block';
  };
});
function kpi(label, val, cls){ return '<div class="kpi ' + (cls||'') + '"><span class="muted">' + label + '</span><b>' + val + '</b></div>'; }
function renderOverview(){
  var c = RESULT.counts, m = RESULT.materiality, t = RESULT.totals;
  $('kpis').innerHTML =
    kpi('Vouchers examined', c.vouchers.toLocaleString('en-IN')) +
    kpi('Ledgers', c.ledgers.toLocaleString('en-IN')) +
    kpi('High findings', c.high, 'hi') +
    kpi('Medium findings', c.medium, 'md') +
    kpi('Low findings', c.low, 'lo') +
    kpi('Cancelled / optional', c.cancelled + ' / ' + c.optional);
  $('matcard').innerHTML =
    '<b>' + h(RESULT.company) + '</b> \\u00b7 ' + h(RESULT.from) + ' \\u2192 ' + h(RESULT.to) +
    ' \\u00b7 generated ' + h(RESULT.generatedAt.replace('T',' ').slice(0,16)) +
    (RESULT._trimmed ? ' <span class="chip na">restored — detail rows trimmed, re-run for full drill-down</span>' : '') +
    '<table class="mat" style="margin-top:8px"><tr>' +
    '<td>Overall materiality<br><b>\\u20b9' + fmt(m.om) + '</b> <span class="muted">(' + h(m.basis) + ')</span></td>' +
    '<td>Performance materiality<br><b>\\u20b9' + fmt(m.pm) + '</b></td>' +
    '<td>Clearly trivial<br><b>\\u20b9' + fmt(m.trivial) + '</b></td>' +
    '<td>Turnover<br><b>\\u20b9' + fmt(t.turnover) + '</b></td>' +
    '<td>PBT (per books)<br><b class="' + (t.pbt < 0 ? 'neg' : '') + '">\\u20b9' + fmt(t.pbt) + '</b></td>' +
    '<td>Gross assets<br><b>\\u20b9' + fmt(t.assets) + '</b></td>' +
    '</tr></table>';
}
function rowsTable(rows){
  if (!rows || !rows.length) return '';
  var cols = []; rows.forEach(function(r){ Object.keys(r).forEach(function(k){ if (cols.indexOf(k) < 0) cols.push(k); }); });
  var out = '<div class="tblwrap"><table><tr>';
  cols.forEach(function(c){ out += '<th class="' + (rows.some(function(r){ return isNum(r[c]); }) ? 'num' : '') + '">' + h(c) + '</th>'; });
  out += '</tr>';
  rows.forEach(function(r){
    out += '<tr>';
    cols.forEach(function(c){
      var v = r[c];
      out += '<td class="' + (isNum(v) ? 'num' : '') + (isNum(v) && v < 0 ? ' neg' : '') + '">' + (v === undefined ? '' : fmt(v)) + '</td>';
    });
    out += '</tr>';
  });
  return out + '</table></div>';
}
function renderFindings(){
  var f = RESULT.findings;
  var areas = []; f.forEach(function(x){ if (areas.indexOf(x.area) < 0) areas.push(x.area); });
  var el = $('tab-findings');
  var html = '<div class="filters">' +
    '<select id="fSev"><option value="">All severities</option><option>high</option><option>medium</option><option>low</option><option>info</option></select>' +
    '<select id="fArea"><option value="">All areas</option>' + areas.map(function(a){ return '<option>' + h(a) + '</option>'; }).join('') + '</select>' +
    '<input id="fText" placeholder="search checks…" style="min-width:180px">' +
    '<label style="display:flex;align-items:center;gap:5px;margin:0"><input type="checkbox" id="fClean" style="width:14px;height:14px"> show passed checks</label>' +
    '<a class="muted" href="/api/export/findings.csv">\\u2b07 findings.csv</a>' +
    '</div><div id="flist"></div>';
  el.innerHTML = html;
  ['fSev','fArea','fText','fClean'].forEach(function(id){ $(id).oninput = drawFindings; });
  drawFindings();
}
function drawFindings(){
  var f = RESULT.findings, sev = $('fSev').value, area = $('fArea').value,
      q = $('fText').value.toLowerCase(), clean = $('fClean').checked;
  var out = '';
  f.forEach(function(x){
    if (!clean && x.status !== 'issue' && x.status !== 'error') return;
    if (sev && x.severity !== sev) return;
    if (area && x.area !== area) return;
    if (q && (x.title + ' ' + x.area + ' ' + x.ref).toLowerCase().indexOf(q) < 0) return;
    var st = x.status === 'issue' ? x.severity : x.status;
    out += '<details class="f" id="chk-' + x.id + '"' + (x.status === 'issue' && x.severity === 'high' ? ' open' : '') + '>' +
      '<summary>' + chip(st) + '<b>' + h(x.title) + '</b>' +
      '<span class="muted">' + h(x.area) + ' \\u00b7 Phase ' + x.phase + '</span>' +
      '<span class="cnt">' + (x.status === 'issue' ? x.count.toLocaleString('en-IN') + ' instance(s)' : SEVL[x.status] || x.status) + '</span></summary>' +
      '<div class="body"><div class="ref">' + h(x.ref) + '</div>' +
      (x.summary ? '<p style="margin:6px 0">' + h(x.summary) + '</p>' : '') +
      (x.rows.length ? rowsTable(x.rows) +
        (x.count > x.rows.length ? '<p class="muted">showing ' + x.rows.length + ' of ' + x.count.toLocaleString('en-IN') + ' \\u2014 full list in the CSV</p>' : '') +
        '<p><a href="/api/export/check.csv?id=' + x.id + '">\\u2b07 download rows (CSV)</a></p>' : '') +
      '<div class="rec"><b>Action:</b> ' + h(x.rec) + '</div>' +
      '</div></details>';
  });
  $('flist').innerHTML = out || '<p class="muted">Nothing matches the filter' + (clean ? '' : ' \\u2014 tick \\u201cshow passed checks\\u201d to see the clean ones') + '.</p>';
}
function renderAnalytics(){
  var a = RESULT.analytics, el = $('tab-analytics');
  var html = '<div class="card"><h3 style="margin:4px 0 8px">Key ratios</h3>' +
    rowsTable(a.ratios) + '<p class="muted">Computed purely from the books read out of Tally \\u2014 recompute after audit adjustments.</p></div>';
  if (a.trend.length) {
    var W = 900, H = 190, P = 30, n = a.trend.length;
    var max = 1; a.trend.forEach(function(m){ max = Math.max(max, m.sales, m.expenses + m.purchases); });
    var bw = (W - P * 2) / n;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + (H + 30) + '" style="width:100%;max-width:960px">';
    a.trend.forEach(function(m, i){
      var x = P + i * bw;
      var hs = Math.round((H - 10) * m.sales / max), he = Math.round((H - 10) * (m.expenses + m.purchases) / max);
      svg += '<rect x="' + (x + bw*0.12) + '" y="' + (H - hs) + '" width="' + bw*0.3 + '" height="' + hs + '" fill="#1a56db" rx="2"><title>Sales ' + m.month + ': ' + fmt(m.sales) + '</title></rect>';
      svg += '<rect x="' + (x + bw*0.5) + '" y="' + (H - he) + '" width="' + bw*0.3 + '" height="' + he + '" fill="#ef6c00" rx="2"><title>Purchases+expenses ' + m.month + ': ' + fmt(m.purchases + m.expenses) + '</title></rect>';
      svg += '<text x="' + (x + bw/2) + '" y="' + (H + 14) + '" text-anchor="middle">' + m.month + '</text>';
    });
    svg += '</svg>';
    html += '<div class="card"><h3 style="margin:4px 0 2px">Monthly trend</h3>' +
      '<p class="muted"><span style="color:#1a56db">\\u25a0</span> sales &nbsp; <span style="color:#ef6c00">\\u25a0</span> purchases + expenses</p>' + svg + '</div>';
  }
  el.innerHTML = html;
}
function renderTB(){
  var el = $('tab-tb');
  if (!RESULT.tb || !RESULT.tb.length) {
    el.innerHTML = '<div class="card"><p class="muted">Trial balance detail is kept only in memory \\u2014 re-run the audit to load it.</p></div>';
    return;
  }
  el.innerHTML = '<div class="card"><div class="filters"><input id="tbq" placeholder="filter ledgers / groups…" style="min-width:240px">' +
    '<a class="muted" href="/api/export/tb.csv">\\u2b07 trial-balance.csv</a></div><div id="tblist"></div></div>';
  $('tbq').oninput = drawTB;
  drawTB();
}
function drawTB(){
  var q = $('tbq').value.toLowerCase();
  var rows = RESULT.tb.filter(function(r){ return !q || (r.Ledger + ' ' + r.Group).toLowerCase().indexOf(q) >= 0; });
  var tot = {Opening:0, Debit:0, Credit:0, Closing:0};
  rows.forEach(function(r){ tot.Opening += r.Opening; tot.Debit += r.Debit; tot.Credit += r.Credit; tot.Closing += r.Closing; });
  var shown = rows.slice(0, 1500);
  var trs = shown.map(function(r){
    return '<tr><td>' + h(r.Ledger) + '</td><td>' + h(r.Group) + '</td>' +
      ['Opening','Debit','Credit','Closing'].map(function(k){ return '<td class="num' + (r[k] < 0 ? ' neg' : '') + '">' + fmt(r[k]) + '</td>'; }).join('') + '</tr>';
  }).join('');
  $('tblist').innerHTML = '<p class="muted">' + rows.length.toLocaleString('en-IN') + ' ledger(s)' +
    (shown.length < rows.length ? ' \\u2014 showing first ' + shown.length + ', refine the filter or use the CSV' : '') +
    ' \\u00b7 balances are Dr-positive / Cr-negative for the audit period</p>' +
    '<div class="tblwrap"><table><tr><th>Ledger</th><th>Group</th><th class="num">Opening</th><th class="num">Debit</th><th class="num">Credit</th><th class="num">Closing</th></tr>' +
    trs + '<tr style="font-weight:700;background:#f0f3f6"><td colspan="2">Totals (filtered)</td>' +
    ['Opening','Debit','Credit','Closing'].map(function(k){ return '<td class="num">' + fmt(Math.round(tot[k]*100)/100) + '</td>'; }).join('') + '</tr></table></div>';
}
function renderSampling(){
  var s = RESULT.sampling, el = $('tab-sampling');
  el.innerHTML = '<div class="card"><h3 style="margin:4px 0 8px">SA 530 vouching sample</h3>' +
    '<p class="muted">Population ' + s.populationCount.toLocaleString('en-IN') + ' vouchers worth \\u20b9' + fmt(s.populationValue) +
    ' \\u00b7 ' + s.keyCount + ' key item(s) \\u2265 performance materiality (\\u20b9' + fmt(RESULT.materiality.pm) + ') worth \\u20b9' + fmt(s.keyValue) +
    ' \\u00b7 monetary-unit sampling interval \\u20b9' + fmt(s.interval) + '</p>' +
    rowsTable(s.rows) +
    '<p><a href="/api/export/sampling.csv">\\u2b07 sampling.csv</a> \\u2014 vouch each item to complete external evidence and note results against it.</p></div>';
}
function renderChecklist(){
  var el = $('tab-checklist');
  if (!STATE) return;
  var fmap = {};
  if (RESULT) RESULT.findings.forEach(function(f){ fmap[f.id] = f; });
  var html = '<p class="muted">The statutory-audit programme, phase by phase. \\u2699 items are tested automatically by this tool \\u2014 click a pill to jump to the finding. Ticks save per company + FY.</p>';
  STATE.checklist.forEach(function(ph){
    var done = ph.items.filter(function(it){ return TICKS[it.id]; }).length;
    html += '<div class="phase"><h3>Phase ' + ph.phase + ' \\u00b7 ' + h(ph.title) +
      '<span class="cnt">' + done + '/' + ph.items.length + ' done</span></h3><div class="items">';
    ph.items.forEach(function(it){
      var autos = '';
      (it.auto || []).forEach(function(id){
        var f = fmap[id];
        if (!f) { autos += '<span class="pill">\\u2699 ' + id + '</span>'; return; }
        if (f.status === 'issue' && f.severity !== 'info')
          autos += '<span class="pill issue ' + f.severity + '" onclick="jumpCheck(\\'' + id + '\\')">\\u26a0 ' + h(f.title) + ' (' + f.count + ')</span>';
        else
          autos += '<span class="pill okp" onclick="jumpCheck(\\'' + id + '\\')">\\u2713 ' + h(f.title) + '</span>';
      });
      html += '<div class="item"><input type="checkbox" data-cl="' + it.id + '"' + (TICKS[it.id] ? ' checked' : '') + '>' +
        '<div class="t">' + h(it.text) + (autos ? '<div class="auto">' + autos + '</div>' : '') + '</div></div>';
    });
    html += '</div></div>';
  });
  el.innerHTML = html;
  el.querySelectorAll('input[data-cl]').forEach(function(cb){
    cb.onchange = function(){
      api('/api/checklist', {id: cb.dataset.cl, done: cb.checked}).then(function(r){ TICKS = r.ticks; renderChecklist(); });
    };
  });
}
function jumpCheck(id){
  document.querySelector('nav.tabs button[data-t=findings]').click();
  $('fClean').checked = true; drawFindings();
  var d = $('chk-' + id);
  if (d) { d.open = true; d.scrollIntoView({behavior:'smooth', block:'center'}); }
}
function renderReport(){
  var c = RESULT.counts, el = $('tab-report');
  var his = RESULT.findings.filter(function(f){ return f.status === 'issue' && f.severity === 'high'; });
  el.innerHTML = '<div class="card"><h3 style="margin:4px 0 8px">Deliverables</h3>' +
    '<p><a href="/api/export/letter.html" target="_blank"><b>\\ud83d\\udcc4 Management letter (draft)</b></a> \\u2014 printable audit-observations letter built from the findings.</p>' +
    '<p><a href="/api/export/findings.csv">\\u2b07 All findings (CSV)</a> \\u00b7 <a href="/api/export/sampling.csv">\\u2b07 Vouching sample (CSV)</a> \\u00b7 <a href="/api/export/tb.csv">\\u2b07 Trial balance (CSV)</a></p>' +
    '<h3>Summary</h3><p>' + c.issues + ' finding(s) need attention: <b class="neg">' + c.high + ' high</b>, ' + c.medium + ' medium, ' + c.low + ' low. ' +
    (his.length ? 'Deal with the high items first:' : 'No high-severity items \\u2014 clear the medium list next.') + '</p>' +
    (his.length ? '<ul>' + his.map(function(f){ return '<li><b>' + h(f.title) + '</b> \\u2014 ' + f.count + ' instance(s) \\u00b7 ' + h(f.ref) + '</li>'; }).join('') + '</ul>' : '') +
    '<p class="muted">Remember: these are automated leads from the books alone. Physical verification, external confirmations, legal files and management explanations remain manual audit work \\u2014 track them on the Audit checklist tab.</p></div>';
}
init();
</script>
</body>
</html>`;
