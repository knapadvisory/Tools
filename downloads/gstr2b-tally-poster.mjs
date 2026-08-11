#!/usr/bin/env node
// GSTR-2B → Tally Prime poster — standalone, single file, zero dependencies.
// ---------------------------------------------------------------------------
// Runs entirely on the computer where Tally Prime is installed. Nothing goes
// to any server or cloud — the GSTR-2B file, ledger mappings and posting
// history never leave this machine.
//
// WHAT IT DOES
//   1. You upload the monthly GSTR-2B JSON (GST portal → Returns → GSTR-2B →
//      Download → JSON).
//   2. It lists every B2B invoice and credit/debit note for review.
//   3. You map each supplier's GSTIN to its Tally ledger name (once — saved).
//   4. Tick documents → "Post to Tally" imports them into the open company as
//      Purchase / Debit Note vouchers via Tally's XML gateway, with per-
//      voucher success/failure shown. Or download the XML and import manually.
//
// ONE-TIME SETUP
//   1. Install Node.js from https://nodejs.org (LTS).
//   2. In Tally Prime: F1 (Help) → Settings → Connectivity → Client/Server
//      configuration → "TallyPrime acts as" = Both, Port = 9000.
//      Keep the company open.
//   3. Run:  node gstr2b-tally-poster.mjs   then open http://localhost:8787
//
// Settings, supplier mappings and the posted-documents register are kept in
// gstr2b-tally-data.json next to this file (duplicate protection survives
// restarts). Delete that file to start fresh.
// ---------------------------------------------------------------------------

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const VERSION = '1.7';
const PORT = Number(process.env.PORT || 8787);
const DATA_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gstr2b-tally-data.json');

// ------------------------------ local state ---------------------------------
const DEFAULT_STATE = {
  settings: {
    tallyUrl: 'http://localhost:9000',
    company: '', // only needed when more than one company is open in Tally
    purchaseLedger: 'Purchase',
    igstLedger: 'Input IGST',
    cgstLedger: 'Input CGST',
    sgstLedger: 'Input SGST',
    cessLedger: '',
    roundOffLedger: '',
    billwise: true,
    tolerance: 5, // rupees of round-off allowed when matching
    rcmIgstLedger: 'RCM Payable IGST',
    rcmCgstLedger: 'RCM Payable CGST',
    rcmSgstLedger: 'RCM Payable SGST',
    // 🤖 self-worker: OFF by default — switch on in Settings if wanted.
    selfWorker: false,
    watchFolder: path.join(os.homedir(), 'Downloads'),
    ownGstin: '', // when set, the watcher ignores 2B files of other GSTINs
    companyGuard: true, // 🛡 block posting/reconcile when the open Tally company's GSTIN ≠ the loaded data's GSTIN
    freshStart: true, // clear loaded documents on every launch
  },
  mappings: {}, // gstin -> { ledger, autoCreate }
  posted: {}, // "gstin|type|docNo" -> { at, period, docNo, supplier, total }
  manualLog: [], // recent manually entered vouchers, newest first
  docs: {}, // key -> parsed GSTR-2B row (persists across restarts)
  fileGstin: '', // the GSTIN of the loaded 2B data (from upload / watcher)
  reco: null, // last reconciliation result + timestamp
  ingested: {}, // watched-file signature -> { at, file, period, added }
  epoch: 1, // bumped on every clear/fresh start — stale browser tabs holding
  // pre-clear documents are refused when they try to merge them back in
};

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      settings: { ...DEFAULT_STATE.settings, ...(raw.settings || {}) },
      mappings: raw.mappings || {},
      posted: raw.posted || {},
      manualLog: raw.manualLog || [],
      docs: raw.docs || {},
      fileGstin: raw.fileGstin || '',
      reco: raw.reco || null,
      ingested: raw.ingested || {},
      epoch: +raw.epoch || 1,
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}
let state = loadState();
function pruneCachedLocks() {
  // Register entries WITHOUT a remoteId are cached reconcile verdicts
  // ("found in Tally") — safe to drop: the live dup-guard re-checks Tally on
  // every post and the next reconcile re-locks whatever is really booked.
  // Entries WITH a remoteId are vouchers this tool actually posted — kept so
  // "Posted" history and 🗑 Delete from Tally keep working.
  let dropped = 0;
  for (const [k, v] of Object.entries(state.posted || {})) {
    if (!v || !v.remoteId) { delete state.posted[k]; dropped++; }
  }
  return dropped;
}
if (state.settings.freshStart !== false) {
  const had = Object.keys(state.docs || {}).length;
  state.docs = {};
  state.fileGstin = '';
  state.reco = null;
  state.ingested = {};
  state.epoch = (+state.epoch || 1) + 1;
  const dropped = pruneCachedLocks();
  saveState();
  if (had || dropped) console.log('  🧹 fresh start: cleared ' + had + ' document(s) and ' + dropped + ' cached in-Tally lock(s) (turn off under Settings if unwanted)');
}
function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 1));
}

// --------------------------- tally response parse ---------------------------
const normName = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

/** Light Day Book parse — just enough of each voucher to detect duplicates. */
function parseVouchers(xml) {
  const out = [];
  for (const block of xml.match(/<VOUCHER[\s>][\s\S]*?<\/VOUCHER>/gi) || []) {
    if (/<ISCANCELLED>\s*Yes/i.test(block)) continue;
    if (/<ISOPTIONAL>\s*Yes/i.test(block)) continue;
    const tag = (name) => {
      const m = block.match(new RegExp('<' + name + '[^>]*>([^<]*)</' + name + '>', 'i'));
      return m ? decodeXml(m[1].trim()) : '';
    };
    const party = tag('PARTYLEDGERNAME') || tag('PARTYNAME');
    let amount = 0;
    for (const e of block.match(/<(?:ALL)?LEDGERENTRIES\.LIST>[\s\S]*?<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi) || []) {
      const lm = e.match(/<LEDGERNAME[^>]*>([^<]*)<\/LEDGERNAME>/i);
      if (normName(lm ? decodeXml(lm[1].trim()) : '') !== normName(party)) continue;
      const am = e.match(/<AMOUNT[^>]*>([^<]*)<\/AMOUNT>/i);
      amount += Math.abs(Number(String(am ? am[1] : '').replace(/[₹,\s]/g, '')) || 0);
    }
    if (!amount) amount = Math.abs(Number(String(tag('AMOUNT')).replace(/[₹,\s]/g, '')) || 0);
    out.push({
      number: tag('VOUCHERNUMBER'),
      reference: tag('REFERENCE'),
      date: tag('DATE').replace(/-/g, ''),
      party,
      amount: Math.round(amount * 100) / 100,
      type: tag('VOUCHERTYPENAME'),
    });
  }
  return out;
}

function decodeXml(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}
const escXml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
/** SVCURRENTCOMPANY fragment when a company name is configured. */
function svCompany() {
  const c = (state.settings.company || '').trim();
  return c ? '<SVCURRENTCOMPANY>' + escXml(c) + '</SVCURRENTCOMPANY>' : '';
}

function parseTallyReply(text) {
  const created = Number((text.match(/<CREATED>(\d+)/i) || [])[1] || 0);
  const altered = Number((text.match(/<ALTERED>(\d+)/i) || [])[1] || 0);
  const deleted = Number((text.match(/<DELETED>(\d+)/i) || [])[1] || 0);
  const errors = [...text.matchAll(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/gi)].map((m) => decodeXml(m[1].trim()));
  return { created, altered, deleted, errors };
}

// ===================== RECONCILIATION ENGINE =====================
// Ported VERBATIM from gstr2b-tally-recon.mjs (the standalone recon
// tool) so both tools match documents identically. Only renames:
// parseVouchers -> parseReconVouchers (name clash with the posting
// guard's light parser), and SVCURRENTCOMPANY support added to the
// Tally requests for multi-company setups.
const r2 = (n) => Math.round(n * 100) / 100;
const norm = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
const normDoc = (s) => {
  const t = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return t.replace(/(^|[^0-9])0+(?=[0-9])/g, '$1');
};
const toNum = (v) => {
  const n = Number(String(v ?? '').replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const inr = (n) => '₹' + r2(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, '0');
const MONTH_NO = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function parseDocDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  m = s.match(/^(\d{4})[/\-.]?(\d{1,2})[/\-.]?(\d{1,2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return null;
}
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, 'i'));
  return m ? decodeXml(m[1].trim()) : '';
};
const tallyDateOf = (v) => {
  const m = String(v).match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
};
const toTallyDate = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/;
// Read EVERYTHING except Sales, Payments, Receipts, Contra (money movement /
// outward side) and inventory-only types with no accounting effect. Whatever
// custom voucher type a company invents ("JOBWORK EXPENSES", "FREIGHT",
// "IMPORT PURCHASE", …) is read under journal rules — kept only when it
// carries GST input tax or a clear supplier leg, so noise filters itself out.
function classify(typeName) {
  const t = norm(typeName);
  if (t.includes('order') || t.includes('deliverynote') || t.includes('goodsreceipt') ||
      t.includes('stockjournal') || t.includes('physicalstock') || t.includes('memo') ||
      t.includes('reversing')) return 'other';
  if (t.includes('creditnote')) return 'creditnote'; // sales return — not purchase-side
  if (t.includes('debitnote')) return 'debitnote';
  if (t.includes('sales') || t.includes('sale')) return 'sales';
  if (t.includes('purchase')) return 'purchase';
  if (t.includes('receipt')) return 'receipt';
  if (t.includes('payment')) return 'payment';
  if (t.includes('contra')) return 'contra';
  return 'journal';
}

/** Which GST head a ledger belongs to, from its name — word-boundary safe
 *  ("Input CGST 9%", "IGST-Input", "Central Tax") so a supplier like
 *  "SGS Technologies" is never mistaken for an SGST ledger. */
function taxHead(ledgerName) {
  // Normalise: lowercase, punctuation → space, and split letter/digit runs so
  // rate-glued names ("CGST18%", "Input SGST2.5", "IGST@28") still match.
  const w = ` ${String(ledgerName).toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')} `;
  if (w.includes(' igst ') || w.includes(' integrated tax ')) return 'igst';
  if (w.includes(' cgst ') || w.includes(' central tax ')) return 'cgst';
  if (w.includes(' sgst ') || w.includes(' utgst ') || w.includes(' state tax ') || w.includes(' state ut tax ')) return 'sgst';
  if (w.includes(' cess ')) return 'cess';
  return genericGst(w);
}

function genericGst(w) {
  // Combined ledgers without a head split: "GST Input", "Input GST 18%",
  // "GST Receivable", "GST ITC", or a bare "GST @ 18%". Requires a
  // qualifying word (or nothing but gst/numbers) so suppliers whose NAME
  // contains "GST" are never mistaken for tax ledgers.
  if (w.includes(' gst ')) {
    if (w.includes(' input ') || w.includes(' itc ') || w.includes(' receivable ') || w.includes(' credit ')) return 'gst';
    if (/^[\s0-9]*gst[\s0-9]*$/.test(w)) return 'gst';
  }
  return null;
}

/** TDS and round-off legs on a voucher — they change the party total but are
 *  not part of the taxable value, so they must be kept out of both. */
function specialLeg(ledgerName) {
  const w = ` ${String(ledgerName).toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  if (w.includes(' tds ') || w.includes(' tcs ')) return 'tds';
  if (w.includes(' round ') || w.includes(' rounding ')) return 'roundoff';
  // Non-GST pass-through components billed on the same voucher — not part of
  // the 2B taxable value (' reimb' also catches common misspellings).
  if (w.includes(' reimb') || w.includes(' recovered ') || w.includes(' recovery ')) return 'reimb';
  return null;
}
// Live progress for the long full-books read, polled by the browser.
const recoProgress = { active: false, phase: '', mode: '', monthsDone: 0, monthsTotal: 0, vouchers: 0 };

async function askTally(tallyUrl, body) {
  const res = await fetch(tallyUrl, {
    method: 'POST', body, headers: { 'content-type': 'text/xml' },
    signal: AbortSignal.timeout(300000), // 5 min per chunk — a hung Tally fails loudly instead of forever
  });
  return res.text();
}
/** Read vouchers month by month, parsing EACH chunk immediately and
 *  discarding its raw XML — big companies produce gigabytes of Tally XML
 *  across a multi-year window, far beyond what one string can hold.
 *  Monthly chunks also keep each Tally export fast. */
async function readTally(tallyUrl, from, to, mode, seen = new Map()) {
  const vouchers = [];
  const typeCounts = {};
  let duplicates = 0, totalBlocks = 0, totalBytes = 0, months = 0;
  let lineErr = '', dumpXml = '';
  console.log('  reading Tally (' + mode + ') …');
  // How many month-chunks will this read take? (for the progress bar)
  let monthsTotal = 0;
  for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); d <= to;
       d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) monthsTotal++;
  recoProgress.phase = 'reading';
  recoProgress.mode = mode;
  recoProgress.monthsDone = 0;
  recoProgress.monthsTotal = monthsTotal;
  for (
    let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    d <= to;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  ) {
    const mFrom = d < from ? from : d;
    const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const mTo = mEnd > to ? to : mEnd;
    const xml = await askTally(tallyUrl, mode === 'collection' ? voucherCollectionRequest(mFrom, mTo) : dayBookRequest(mFrom, mTo));
    months++;
    totalBytes += xml.length;
    const blocks = (xml.match(/<VOUCHER[\s>]/gi) || []).length;
    totalBlocks += blocks;
    for (const t of xml.match(/<VOUCHERTYPENAME>[^<]*/gi) || []) {
      const name = decodeXml(t.slice(17).trim());
      typeCounts[name] = (typeCounts[name] || 0) + 1;
    }
    if (!lineErr) lineErr = xml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i)?.[1]?.trim() ?? '';
    if (!dumpXml && blocks) dumpXml = xml.slice(0, 5_000_000);
    const r = parseReconVouchers(xml, seen);
    vouchers.push(...r.vouchers);
    duplicates += r.duplicates;
    recoProgress.monthsDone = months;
    recoProgress.vouchers = vouchers.length;
  }
  console.log('  ' + months + ' months, ' + vouchers.length + ' relevant vouchers');
  return { vouchers, duplicates, totalBlocks, totalBytes, typeCounts, lineErr, dumpXml };
}
function dayBookRequest(from, to) {
  return `<ENVELOPE>
 <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
 <BODY><EXPORTDATA><REQUESTDESC>
  <REPORTNAME>Day Book</REPORTNAME>
  <STATICVARIABLES>
   <SVFROMDATE>${toTallyDate(from)}</SVFROMDATE>
   <SVTODATE>${toTallyDate(to)}</SVTODATE>
   <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${svCompany()}
  </STATICVARIABLES>
 </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

// Primary read: a voucher COLLECTION. Unlike the interactive Day Book report
// (which some Tally setups export for whatever period the UI shows, ignoring
// SVFROMDATE/SVTODATE entirely), voucher collections honour the requested
// date range.
function voucherCollectionRequest(from, to) {
  return `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>ReconVouchers</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES>
   <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   <SVFROMDATE>${toTallyDate(from)}</SVFROMDATE>
   <SVTODATE>${toTallyDate(to)}</SVTODATE>${svCompany()}
  </STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="ReconVouchers" ISMODIFY="No">
    <TYPE>Voucher</TYPE>
    <FETCH>DATE</FETCH><FETCH>GUID</FETCH><FETCH>VOUCHERTYPENAME</FETCH><FETCH>VOUCHERNUMBER</FETCH>
    <FETCH>REFERENCE</FETCH><FETCH>NARRATION</FETCH><FETCH>PARTYLEDGERNAME</FETCH><FETCH>PARTYGSTIN</FETCH>
    <FETCH>CMPGSTIN</FETCH><FETCH>ISCANCELLED</FETCH><FETCH>ISOPTIONAL</FETCH>
    <FETCH>ALLLEDGERENTRIES.LIST</FETCH>
   </COLLECTION>
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;
}

const LEDGER_GSTIN_REQUEST = () => `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>LedgerGstins</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${svCompany()}</STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="LedgerGstins" ISMODIFY="No">
    <TYPE>Ledger</TYPE>
    <NATIVEMETHOD>Name</NATIVEMETHOD>
    <NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD>
   </COLLECTION>
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;
/** Pull purchase, debit-note and journal vouchers out of Tally's Day Book
 *  XML — with EVERY ledger entry (party, expense/asset, and the CGST/SGST/
 *  IGST/Cess input ledgers) plus bill-wise references. */
function parseReconVouchers(xml, seen = new Map()) {
  const out = [];
  let duplicates = 0;
  // Per-call (= per export chunk) occurrence counter for GUID-less blocks:
  // two genuinely DISTINCT vouchers with identical type/date/party/amounts in
  // one chunk get #1 and #2 and both survive, while chunk repeats and the
  // second export path re-emit the same signature sequence and still collide.
  const sigCount = new Map();
  const blocks = xml.match(/<VOUCHER[\s>][\s\S]*?<\/VOUCHER>/gi) || [];
  for (const block of blocks) {
    if (/(^|>)\s*Yes\s*<\/ISCANCELLED>/i.test(block.match(/<ISCANCELLED>[\s\S]*?<\/ISCANCELLED>/i)?.[0] ?? '')) continue;
    if (/<ISOPTIONAL>\s*Yes/i.test(block)) continue;
    const type = classify(tag(block, 'VOUCHERTYPENAME'));
    // 'creditnote' kept too: many books record SUPPLIER credit notes as a
    // Tally Credit Note voucher (with their own numbering) — they must be
    // matchable against 2B notes. Sales returns land in the same pool but
    // only ever match when supplier + number/values agree.
    if (type !== 'purchase' && type !== 'debitnote' && type !== 'journal' && type !== 'creditnote') continue;
    const entryBlocks = block.match(/<(?:ALL)?LEDGERENTRIES\.LIST>[\s\S]*?<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi) || [];
    const entries = [];
    for (const e of entryBlocks) {
      const name = tag(e, 'LEDGERNAME');
      if (!name) continue;
      const billRefs = (e.match(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/gi) || [])
        .map((a) => tag(a, 'NAME')).filter(Boolean);
      entries.push({ name, amount: Math.abs(toNum(tag(e, 'AMOUNT'))), head: taxHead(name), billRefs });
    }
    const v = {
      type,
      typeName: tag(block, 'VOUCHERTYPENAME'),
      number: tag(block, 'VOUCHERNUMBER'),
      reference: tag(block, 'REFERENCE'),
      narration: tag(block, 'NARRATION'),
      date: tallyDateOf(tag(block, 'DATE')),
      party: tag(block, 'PARTYLEDGERNAME') || tag(block, 'PARTYNAME'),
      partyGstin: (tag(block, 'PARTYGSTIN').match(GSTIN_RE) || [null])[0],
      // which of OUR registrations this voucher belongs to (multi-GSTIN books)
      cmpGstin: (tag(block, 'CMPGSTIN').match(GSTIN_RE) || [null])[0],
      entries,
      blockAmount: Math.abs(toNum(tag(block, 'AMOUNT'))),
    };
    // Dedupe on Tally's voucher GUID (falling back to a content signature) —
    // some Tally setups ignore the requested date range and return the same
    // vouchers for every monthly chunk, which would multiply every figure.
    // Duplicates MERGE field-wise into the first copy instead of being
    // dropped: the Day Book (read FIRST) carries the true on-screen voucher
    // number and narration, while the TDL collection recomputes automatic
    // numbers out of context (every journal can come back as "001(26-27)")
    // but is the only source of PARTYGSTIN/CMPGSTIN on many setups.
    let key = tag(block, 'GUID');
    if (!key) {
      const sig = `${v.typeName}|${tag(block, 'DATE')}|${norm(v.party)}|${v.entries.map((e) => e.amount).join(',')}`;
      const n = (sigCount.get(sig) ?? 0) + 1;
      sigCount.set(sig, n);
      key = sig + '#' + n;
    }
    const prev = seen.get(key);
    if (prev) {
      if (!prev.number && v.number) prev.number = v.number;
      if (!prev.reference && v.reference) prev.reference = v.reference;
      if (!prev.narration && v.narration) prev.narration = v.narration;
      if (!prev.partyGstin && v.partyGstin) prev.partyGstin = v.partyGstin;
      if (!prev.cmpGstin && v.cmpGstin) prev.cmpGstin = v.cmpGstin;
      duplicates++;
      continue;
    }
    seen.set(key, v);
    out.push(v);
  }
  return { vouchers: out, duplicates };
}
/** Turn raw vouchers into books-side rows with party, gross value, GST split
 *  and document references. Journals count only when they actually carry GST
 *  input tax (that's what makes them 2B-relevant — expense and capital-goods
 *  bookings); the supplier leg is found via bill allocations, then via a
 *  ledger that has a GSTIN in the masters, then the largest non-tax leg. */
function buildBooks(vouchers, ledgerGstins) {
  const purchases = [];
  const bookNotes = [];
  let journalsUsed = 0;
  let journalsSkipped = 0;
  const skippedLedgers = new Map(); // ledger name → how often seen in dropped journals
  for (const v of vouchers) {
    const taxes = { igst: 0, cgst: 0, sgst: 0, cess: 0, gst: 0 };
    let tds = 0, reimb = 0;
    for (const e of v.entries) if (e.head) taxes[e.head] = r2(taxes[e.head] + e.amount);
    const taxTotal = r2(taxes.igst + taxes.cgst + taxes.sgst + taxes.cess + taxes.gst);
    // Party candidates and the taxable sum both exclude TDS/round-off and
    // reimbursement legs — they change totals but are not part of the supply.
    // A leg that IS the party (by name, or a ledger with a GSTIN in the
    // masters) is never a component, even if its name says "reimbursement" —
    // suppliers can be named that way.
    const isPartyLeg = (name) => norm(name) === norm(v.party) || ledgerGstins.has(norm(name));
    const nonTax = v.entries.filter((e) => !e.head && (!specialLeg(e.name) || isPartyLeg(e.name)));
    for (const e of v.entries) {
      if (e.head || isPartyLeg(e.name)) continue;
      const sl = specialLeg(e.name);
      if (sl === 'tds') tds = r2(tds + e.amount);
      else if (sl === 'reimb') reimb = r2(reimb + e.amount);
    }

    // Find the supplier leg: the named party's entry, else the leg carrying
    // bill allocations, else a ledger known to have a GSTIN, else the largest
    // non-tax leg (in a GST purchase the party leg = expense + taxes, so it's
    // the biggest). Applies to purchases too — some exports name the party
    // slightly differently from its ledger entry.
    let partyEntry = v.party ? nonTax.find((e) => norm(e.name) === norm(v.party)) ?? null : null;
    if (!partyEntry) {
      partyEntry =
        nonTax.find((e) => e.billRefs.length) ??
        [...nonTax].filter((e) => ledgerGstins.has(norm(e.name))).sort((a, b) => b.amount - a.amount)[0] ??
        [...nonTax].sort((a, b) => b.amount - a.amount)[0] ??
        null;
    }
    // A journal is 2B-relevant when it carries GST input tax OR its party leg
    // is clearly a supplier (bill-wise reference, or a ledger with a GSTIN in
    // the masters) — many books put the GST in separate consolidated entries
    // and book each purchase journal gross, and those must still be matched.
    const strongParty = !!partyEntry && (partyEntry.billRefs.length > 0 || ledgerGstins.has(norm(partyEntry.name)) ||
      // A voucher-level Supplier Invoice No. (REFERENCE) together with a NAMED
      // party is supplier evidence too — customs-duty / clearing-agent style
      // bookings carry no GST legs but do carry the supplier's bill number.
      (!!v.reference && !!v.party && norm(partyEntry.name) === norm(v.party)));
    if (v.type === 'journal') {
      if (!partyEntry || (taxTotal <= 0 && !strongParty)) {
        journalsSkipped++;
        for (const e of v.entries) skippedLedgers.set(e.name, (skippedLedgers.get(e.name) ?? 0) + 1);
        continue;
      }
      journalsUsed++;
    }
    const party = partyEntry?.name || v.party;
    const amount = r2(partyEntry?.amount || v.blockAmount);
    if (!party || amount <= 0) continue;
    (v.type === 'debitnote' || v.type === 'creditnote' ? bookNotes : purchases).push({
      vtype: v.type === 'journal' ? (v.typeName || 'Journal') : v.type === 'debitnote' ? 'Debit note' : v.type === 'creditnote' ? 'Credit note' : 'Purchase',
      number: v.number,
      reference: v.reference,
      billRefs: partyEntry?.billRefs ?? [],
      date: v.date,
      party,
      partyGstin: v.partyGstin,
      // which of OUR registrations booked this voucher (multi-GSTIN company)
      cmpGstin: v.cmpGstin || null,
      amount,
      // Names of the expense/purchase legs — used to LEARN each supplier's
      // usual booking ledger (addition over the base engine).
      expenses: nonTax.filter((e) => e !== partyEntry).map((e) => e.name),
      narration: v.narration || '',
      taxable: r2(nonTax.filter((e) => e !== partyEntry).reduce((s, e) => s + e.amount, 0)),
      tds,
      reimb,
      ...taxes,
      tax: taxTotal,
    });
  }
  return { purchases, bookNotes, journalsUsed, journalsSkipped, skippedLedgers };
}

/** Ledger name → GSTIN, parsed leniently so any Tally version works. */
function parseLedgerGstins(xml) {
  const map = new Map();
  const blocks = xml.match(/<LEDGER[\s>][\s\S]*?<\/LEDGER>/gi) || [];
  for (const block of blocks) {
    const name = (block.match(/<LEDGER[^>]*\sNAME="([^"]*)"/i)?.[1] ?? tag(block, 'NAME')).trim();
    const gstin = block.match(GSTIN_RE)?.[0] ?? null;
    if (name && gstin) map.set(norm(decodeXml(name)), gstin);
  }
  return map;
}
// ------------------------------- reconciliation ------------------------------
function reconcile(docsIn, purchases, bookNotes, tolerance, memory = {}) {
  const exact = new Map(); const bySupplier = new Map();
  const add = (map, key, b) => { if (!map.has(key)) map.set(key, []); map.get(key).push(b); };
  purchases.forEach((b, i) => { b.id = i; });
  bookNotes.forEach((n, i) => { n.id = i; });
  for (const b of purchases) {
    const keys = [];
    if (b.gstin) keys.push(`g:${b.gstin}`);
    keys.push(`n:${norm(b.party)}`);
    for (const no of [b.reference, b.number, ...(b.billRefs ?? [])]) {
      if (!no) continue;
      for (const k of keys) add(exact, `${k}|${normDoc(no)}`, b);
    }
    for (const k of keys) add(bySupplier, k, b);
  }
  const noteExact = new Map(); const noteBySupplier = new Map();
  for (const n of bookNotes) {
    const keys = [];
    if (n.gstin) keys.push(`g:${n.gstin}`);
    keys.push(`n:${norm(n.party)}`);
    for (const no of [n.reference, n.number, ...(n.billRefs ?? [])]) {
      if (!no) continue;
      for (const k of keys) add(noteExact, `${k}|${normDoc(no)}`, n);
    }
    for (const k of keys) add(noteBySupplier, k, n);
  }

  const usedBills = new Set(); const usedNotes = new Set();
  const out = []; const pending = [];
  const docKeys = (d) => [`g:${d.gstin}`, `n:${norm(d.supplierName)}`];
  // Display name for a books-side row: supplier's invoice no. (reference),
  // else the bill-wise allocation name (journals), else Tally's voucher no.
  const billNo = (b) => b.reference || (b.billRefs ?? [])[0] || b.number || '(no number)';

  // Multi-GSTIN books (one company, several registrations): when BOTH sides
  // declare a registration, they must agree — a document reported to one
  // state's GSTIN can never be the voucher booked under another state's
  // registration. The restriction applies ONLY when the books really carry
  // MORE THAN ONE distinct registration tag: some Tally setups stamp every
  // voucher with the principal GSTIN (or none), and restricting on that
  // would wrongly block all matching and empty the books-only report.
  const cmpTagged = new Set([...purchases, ...bookNotes].map((b) => b.cmpGstin).filter(Boolean)).size > 1;
  const ownOk = (d, x) => !cmpTagged || !d.own || !x.cmpGstin || x.cmpGstin === d.own;
  // A NUMBER-evidence match found only in ANOTHER registration's vouchers is
  // a real booking error the user must fix — surface it loudly instead of
  // hiding the document as NOT BOOKED (which would invite a duplicate).
  const flagWrongReg = (rd, cmp) => {
    rd.wrongReg = cmp;
    rd.status = 'mismatch';
    rd.note = `🚩 BOOKED UNDER THE WRONG REGISTRATION: this document belongs to ${rd.own}, but the matching voucher (${rd.bookRef || 'see books'}) is booked under ${cmp}. Change the GST Registration on that voucher in Tally so the ITC lands in ${rd.own}'s GSTR-3B — do NOT post it again. ` + (rd.note || '');
  };

  // Gross value first, then the GST amount from the books' tax ledgers, then
  // the tax head (IGST vs CGST/SGST) — a wrong head is a real filing error
  // even when every rupee matches.
  const verdict = (rd, hit, label) => {
    const diff = r2(rd.docValue - hit.amount);
    const headSwapCheck = (note) => {
      // Head comparison is meaningless when the books use a combined GST ledger.
      if (hit.tax > 0 && rd.tax > 0 && (hit.gst || 0) <= tolerance && (hit.igst > tolerance) !== (rd.igst > tolerance)) {
        return { headSwap: true, note: note + ` ⚠ Wrong tax head: books show ${hit.igst > tolerance ? 'IGST' : 'CGST+SGST'} but 2B shows ${rd.igst > tolerance ? 'IGST' : 'CGST+SGST'} — correct the entry; IGST and CGST/SGST cannot be cross-claimed.` };
      }
      return { headSwap: false, note };
    };

    // 1. GST-first. When the voucher carries GST input lines, the reliable
    //    comparison is TAXABLE-to-taxable and TAX-to-tax — never the party
    //    total, which legitimately differs when TDS or round-off is deducted
    //    on the same voucher.
    if (hit.tax > 0 && rd.tax > 0) {
      if (Math.abs(hit.tax - rd.tax) > tolerance) {
        return { status: 'mismatch', diff, note: `${label} ${billNo(hit)}: GST in the books' tax ledgers ${inr(hit.tax)} vs ${inr(rd.tax)} in 2B — tax difference ${inr(Math.abs(r2(hit.tax - rd.tax)))}. Check the rate/head used in Tally.` };
      }
      // Books taxable (already net of NAMED reimbursement ledgers) exceeding
      // the 2B taxable is ambiguous: a non-GST component on the voucher — or
      // the SUPPLIER under-reporting taxable in their filing. Never assume:
      // send it to the probable/confirm list for a human decision.
      if ((hit.taxable || 0) > 0 && rd.taxableValue > 0) {
        const dT = r2(hit.taxable - rd.taxableValue);
        const tolT = Math.max(tolerance, r2(rd.taxableValue * 0.001));
        if (dT > tolT) {
          const seen = (memory.reimbSuppliers || {})[rd.gstin] || 0;
          return {
            status: 'probable', diff, bookReimb: hit.reimb || 0,
            note: `${label} ${billNo(hit)} (${hit.party}): GST matches but books taxable ${inr(hit.taxable)} vs ${inr(rd.taxableValue)} in 2B — the ${inr(dT)} difference is EITHER a non-GST/reimbursement component on the voucher OR the supplier under-reporting taxable in their filing (2B can be wrong). Verify against the physical invoice before accepting.${seen > 0 ? ` 🧠 This supplier showed the SAME pattern in ${seen} earlier reconciliation run${seen > 1 ? 's' : ''} — likely their regular billing style.` : ''}`,
          };
        }
        if (dT < -tolT) {
          return { status: 'mismatch', diff, note: `${label} ${billNo(hit)}: GST matches but the TAXABLE value differs — ${inr(hit.taxable)} in books vs ${inr(rd.taxableValue)} in 2B (books LOWER). Check freight/other charges or a short booking.` };
        }
      }
      let note = `Matched ${label.toLowerCase()} ${billNo(hit)} (${hit.party}) on taxable + GST.`;
      if (Math.abs(diff) > tolerance) {
        note += ` Total differs by ${inr(Math.abs(diff))} (books ${inr(hit.amount)} vs 2B ${inr(rd.docValue)})${(hit.tds || 0) > 0 ? ` — TDS ${inr(hit.tds)} deducted on the voucher` : ' — usually TDS/round-off deducted on the voucher'}; taxable and GST agree, so no action needed.`;
      }
      const h = headSwapCheck(note);
      return { status: 'matched', diff, note: h.note, headSwap: h.headSwap, bookReimb: hit.reimb || 0 };
    }

    // 2. No GST lines in the books entry — fall back to the party amount vs
    //    the 2B gross, then vs the 2B taxable (pre-GST bookings).
    const grossOk = Math.abs(diff) <= tolerance;
    const taxableOk = !grossOk && rd.taxableValue > 0 && Math.abs(rd.taxableValue - hit.amount) <= tolerance;
    // TDS netted off a GST-less entry: amount + TDS equals gross or taxable.
    const tdsGrossOk = !grossOk && !taxableOk && (hit.tds || 0) > 0 && Math.abs(rd.docValue - r2(hit.amount + hit.tds)) <= tolerance;
    const tdsTaxableOk = !grossOk && !taxableOk && !tdsGrossOk && (hit.tds || 0) > 0 && rd.taxableValue > 0 && Math.abs(rd.taxableValue - r2(hit.amount + hit.tds)) <= tolerance;
    if (!grossOk && !taxableOk && !tdsGrossOk && !tdsTaxableOk) {
      return { status: 'mismatch', diff, note: `${label} ${billNo(hit)} booked at ${inr(hit.amount)} in Tally vs ${inr(rd.docValue)} gross / ${inr(rd.taxableValue)} taxable in GSTR-2B — matches neither.` };
    }
    let note;
    if (grossOk) note = `Matched ${label.toLowerCase()} ${billNo(hit)} (${hit.party}).`;
    else if (taxableOk) note = `Matched ${label.toLowerCase()} ${billNo(hit)} (${hit.party}) on the TAXABLE value ${inr(hit.amount)} — the books carry the pre-GST amount (2B gross: ${inr(rd.docValue)}).`;
    else note = `Matched ${label.toLowerCase()} ${billNo(hit)} (${hit.party}) after adding back TDS ${inr(hit.tds)} deducted on the voucher (books ${inr(hit.amount)} + TDS = 2B ${tdsGrossOk ? 'gross' : 'taxable'}).`;
    return { status: 'matched', diff, note };
  };

  // Books-side breakdown attached to every matched/compared row, so the
  // report shows the same shape as the 2B: taxable, IGST/CGST/SGST, TDS.
  const bookFields = (hit) => ({
    bookRef: billNo(hit), bookParty: hit.party, bookDate: hit.date, bookAmount: hit.amount,
    bookTaxable: hit.taxable ?? 0, bookIgst: hit.igst ?? 0, bookCgst: hit.cgst ?? 0,
    bookSgst: hit.sgst ?? 0, bookGstComb: hit.gst ?? 0, bookTds: hit.tds ?? 0,
    bookReimb: hit.reimb ?? 0, bookTax: hit.tax ?? 0,
  });

  // When several book entries share the same supplier + number (duplicate
  // bookings, sister ledgers), take the one whose taxable/GST/gross agree
  // best with the 2B document — never just the first found.
  const pickBest = (rd, cands) => {
    let best = null, bestScore = -1;
    for (const c of cands) {
      const taxOk = c.tax > 0 && rd.tax > 0 && Math.abs(c.tax - rd.tax) <= tolerance;
      const taxableOk = (c.taxable || 0) > 0 && rd.taxableValue > 0 &&
        Math.abs(c.taxable - rd.taxableValue) <= Math.max(tolerance, r2(rd.taxableValue * 0.001));
      const grossOk = Math.abs(rd.docValue - c.amount) <= tolerance;
      const sc = (taxOk ? 4 : 0) + (taxableOk ? 2 : 0) + (grossOk ? 1 : 0);
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
    return best;
  };

  // Pass 1 — supplier fixed by GSTIN first, name second; then an exact
  // document-number match (voucher number, supplier reference, or bill-wise
  // allocation name).
  for (const d of docsIn) {
    const rd = { ...d, tax: r2(d.igst + d.cgst + d.sgst + d.cess), status: 'only2b', note: '' };
    const nd = normDoc(d.docNo);
    const isCn = d.docType === 'creditnote';
    const pairs = isCn ? [[noteExact, usedNotes]]
      : d.docType === 'debitnote' ? [[exact, usedBills], [noteExact, usedNotes]]
      : [[exact, usedBills]];
    let hit; let basis = ''; let hitUsed = null;
    outer: for (const [pool, used] of pairs) {
      for (const k of docKeys(d)) {
        const cands = (pool.get(`${k}|${nd}`) ?? []).filter((x) => !used.has(x.id) && ownOk(d, x));
        if (cands.length) { hit = pickBest(rd, cands); basis = k.startsWith('g:') ? 'gstin' : 'name'; hitUsed = used; break outer; }
      }
    }
    if (hit) {
      hitUsed.add(hit.id);
      const v = verdict(rd, hit, isCn ? 'Debit note' : hit.vtype || 'Purchase');
      Object.assign(rd, { ...bookFields(hit), ...v });
      if (basis === 'name') rd.note += ' Supplier matched by NAME only — link the GSTIN on the Tally ledger for certainty.';
      out.push(rd);
    } else pending.push(rd);
  }

  // Partial number: "826" booked in Tally vs "SI/826" filed by the supplier
  // (or a truncated reference). Same supplier, one normalised number contains
  // the other, minimum 3 characters.
  const findPartial = (rd, pool, used) => {
    const nd = normDoc(rd.docNo);
    if (nd.length < 3) return null;
    for (const k of docKeys(rd)) {
      for (const b of pool.get(k) ?? []) {
        if (used.has(b.id) || !ownOk(rd, b)) continue;
        for (const no of [b.reference, b.number, ...(b.billRefs ?? [])]) {
          if (!no) continue;
          const bn = normDoc(no);
          if (bn.length >= 3 && (bn.includes(nd) || nd.includes(bn))) {
            return { b, basis: k.startsWith('g:') ? 'gstin' : 'name' };
          }
        }
      }
    }
    return null;
  };

  // Pass 2 — the number didn't match exactly. Cascade within the same
  // supplier (GSTIN first, name fallback): partial invoice number, then
  // invoice value (date-closest wins), then taxable value, then GST amount
  // within ±5 days — each weaker than the last, and labelled as such.
  for (const rd of pending) {
    const isCn = rd.docType === 'creditnote';
    const pool = isCn ? noteBySupplier : bySupplier;
    const used = isCn ? usedNotes : usedBills;
    const label = (b) => (isCn ? 'Debit note' : b.vtype || 'Purchase');

    const partial = findPartial(rd, pool, used);
    if (partial) {
      used.add(partial.b.id);
      const v = verdict(rd, partial.b, label(partial.b));
      Object.assign(rd, { ...bookFields(partial.b), ...v });
      rd.note += ` (Invoice number matched PARTIALLY: books "${billNo(partial.b)}" vs 2B "${rd.docNo}"${partial.basis === 'name' ? '; supplier matched by name — add the GSTIN in Tally' : ''}.)`;
      out.push(rd);
      continue;
    }

    // Narration match (addition over the base engine): many books record the
    // supplier's bill number ONLY in the voucher narration. Same supplier,
    // the normalised 2B number (≥4 chars) appearing inside the narration is
    // strong evidence.
    const ndoc = normDoc(rd.docNo).toLowerCase();
    if (ndoc.length >= 3) {
      // ≥4 chars: substring of the normalised narration. Shorter numbers
      // ("374") need hard boundaries so they don't match inside amounts.
      // normDoc strips leading zeros from the 2B number but the regex runs on
      // the RAW narration — allow zero padding there ("0826" for doc "826")
      // without letting the boundary cross a non-zero digit.
      const bounded = ndoc.length < 4 ? new RegExp('(^|[^A-Za-z0-9])0*' + ndoc + '([^A-Za-z0-9]|$)', 'i') : null;
      const inNarr = (x) => x.narration &&
        (bounded ? bounded.test(x.narration) : norm(x.narration).includes(ndoc));
      let narrHit = null;
      for (const k of docKeys(rd)) {
        narrHit = (pool.get(k) ?? []).find((x) => !used.has(x.id) && ownOk(rd, x) && inNarr(x));
        if (narrHit) break;
      }
      if (narrHit) {
        used.add(narrHit.id);
        const v = verdict(rd, narrHit, label(narrHit));
        Object.assign(rd, { ...bookFields(narrHit), ...v });
        rd.note += ` (2B number "${rd.docNo}" found in the voucher NARRATION of ${billNo(narrHit)} — record it in the Supplier Invoice No. field for exact matching.)`;
        out.push(rd);
        continue;
      }
    }

    let best = null; let how = '';
    const t = rd.docDate?.getTime();
    // A value coincidence alone is NOT evidence. Probable requires the same
    // supplier (GSTIN, name fallback) AND the invoice DATE agreeing (±7
    // days) on top of the value/taxable/tax agreement.
    const nearDate = (x) => t != null && x.date && Math.abs(x.date.getTime() - t) <= 7 * 86400000;
    const dateClosest = (list) =>
      !list.length ? null : list.reduce((a, b) =>
        Math.abs((a.date?.getTime() ?? 8e15) - t) <= Math.abs((b.date?.getTime() ?? 8e15) - t) ? a : b);
    for (const k of docKeys(rd)) {
      const cands = (pool.get(k) ?? []).filter((x) => !used.has(x.id) && ownOk(rd, x) && nearDate(x));
      if (cands.length) {
        best = dateClosest(cands.filter((x) => Math.abs(x.amount - rd.docValue) <= tolerance));
        if (best) { how = 'value'; break; }
        // books party leg carrying the pre-GST amount
        best = dateClosest(cands.filter((x) => rd.taxableValue > 0 && Math.abs(x.amount - rd.taxableValue) <= tolerance));
        if (best) { how = 'valueTaxable'; break; }
        best = dateClosest(cands.filter((x) => (x.taxable || 0) > 0 && rd.taxableValue > 0 && Math.abs(x.taxable - rd.taxableValue) <= tolerance));
        if (best) { how = 'taxable'; break; }
        best = cands.find((x) => x.tax > 0 && rd.tax > 0 && Math.abs(x.tax - rd.tax) <= tolerance &&
          x.date && rd.docDate && Math.abs(x.date.getTime() - rd.docDate.getTime()) <= 5 * 86400000);
        if (best) { how = 'tax'; break; }
      }
      // Notes only (addition over the base engine): supplier credit/debit
      // notes are often booked under the books' own numbering and on a later
      // date — TAXABLE and TAX both agreeing is strong evidence, so allow it
      // within ±45 days when nothing closer matched. Must run even when NO
      // candidate sits within ±7 days at all — a note booked 30+ days late
      // has none, and that is exactly the case this branch exists for.
      if (isCn || rd.docType === 'debitnote') {
        const agrees = (x) => (x.taxable || 0) > 0 && rd.taxableValue > 0 &&
          Math.abs(x.taxable - rd.taxableValue) <= tolerance &&
          x.tax > 0 && rd.tax > 0 && Math.abs(x.tax - rd.tax) <= tolerance;
        const cands45 = (pool.get(k) ?? []).filter((x) => !used.has(x.id) && ownOk(rd, x) &&
          t != null && x.date && Math.abs(x.date.getTime() - t) <= 45 * 86400000);
        best = cands45.find(agrees);
        if (best) { how = 'noteTaxTaxable'; break; }
        // Reversals are often booked on the ORIGINAL invoice's date and
        // reference (months before the supplier reports the note) — when
        // TAXABLE and GST both agree to the rupee, pair regardless of date.
        best = dateClosest((pool.get(k) ?? []).filter((x) => !used.has(x.id) && ownOk(rd, x)).filter(agrees));
        if (best) { how = 'noteAnyDate'; break; }
      }
    }
    // Late-booked purchases (addition over the base engine): books entered
    // weeks after the invoice date miss the ±7-day window. Same supplier +
    // same value/taxable within ±45 days, date-closest wins — probable.
    if (!best && t != null) {
      for (const k of docKeys(rd)) {
        const cands45 = (pool.get(k) ?? []).filter((x) => !used.has(x.id) && ownOk(rd, x) &&
          x.date && Math.abs(x.date.getTime() - t) <= 45 * 86400000);
        if (!cands45.length) continue;
        best = dateClosest(cands45.filter((x) => Math.abs(x.amount - rd.docValue) <= tolerance));
        if (best) { how = 'value45'; break; }
        best = dateClosest(cands45.filter((x) => rd.taxableValue > 0 && Math.abs(x.amount - rd.taxableValue) <= tolerance));
        if (best) { how = 'value45'; break; }
        best = dateClosest(cands45.filter((x) => (x.taxable || 0) > 0 && rd.taxableValue > 0 && Math.abs(x.taxable - rd.taxableValue) <= tolerance));
        if (best) { how = 'taxable45'; break; }
      }
    }
    // 2B DEBIT NOTES may be booked as Tally "Debit Note" vouchers instead of
    // Purchase — probe the notes pool when the purchases pool found nothing.
    let dnUsed = null;
    if (!best && rd.docType === 'debitnote') {
      const p2 = findPartial(rd, noteBySupplier, usedNotes);
      if (p2) { best = p2.b; dnUsed = usedNotes; how = 'dnNote'; }
      if (!best) {
        for (const k of docKeys(rd)) {
          const cands = (noteBySupplier.get(k) ?? []).filter((x) => !usedNotes.has(x.id) && ownOk(rd, x));
          if (!cands.length) continue;
          const exactN = cands.filter((x) => [x.reference, x.number, ...(x.billRefs ?? [])].some((no) => no && normDoc(no) === normDoc(rd.docNo)));
          if (exactN.length) { best = pickBest(rd, exactN); dnUsed = usedNotes; how = 'dnNote'; break; }
          if (t != null) {
            const near = cands.filter((x) => x.date && Math.abs(x.date.getTime() - t) <= 45 * 86400000);
            best = dateClosest(near.filter((x) => Math.abs(x.amount - rd.docValue) <= tolerance)) ||
              dateClosest(near.filter((x) => rd.taxableValue > 0 && Math.abs(x.amount - rd.taxableValue) <= tolerance));
            if (best) { dnUsed = usedNotes; how = 'dnNote'; break; }
          }
        }
      }
    }
    // 2B CREDIT NOTES are often booked OUTSIDE a note voucher — an ITC
    // reversal passed as a JOURNAL. Probe journal-classified purchase-side
    // vouchers (never true Purchase vouchers): the note number on any of
    // their references, or TAXABLE + GST agreeing to the rupee.
    let cnUsed = null;
    if (!best && isCn) {
      const nd2 = normDoc(rd.docNo);
      for (const k of docKeys(rd)) {
        const jc = (bySupplier.get(k) ?? []).filter((x) => !usedBills.has(x.id) && ownOk(rd, x) && x.vtype !== 'Purchase');
        if (!jc.length) continue;
        best = jc.find((x) => [x.reference, x.number, ...(x.billRefs ?? [])].some((no) => {
          if (!no) return false;
          const bn = normDoc(no);
          return bn === nd2 || (bn.length >= 3 && nd2.length >= 3 && (bn.includes(nd2) || nd2.includes(bn)));
        }));
        if (!best) {
          best = jc.find((x) => (x.taxable || 0) > 0 && rd.taxableValue > 0 &&
            Math.abs(x.taxable - rd.taxableValue) <= tolerance &&
            x.tax > 0 && rd.tax > 0 && Math.abs(x.tax - rd.tax) <= tolerance);
        }
        if (best) { cnUsed = usedBills; how = 'cnJournal'; break; }
      }
    }
    if (best) {
      (cnUsed || dnUsed || used).add(best.id);
      const notes = {
        value: `${label(best)} ${billNo(best)} (${best.party}) has the same invoice value — the numbers differ (2B: ${rd.docNo}). Confirm, and record the supplier's invoice number in Tally.`,
        valueTaxable: `${label(best)} ${billNo(best)} (${best.party}) is booked at the TAXABLE value ${inr(best.amount)} (2B gross ${inr(rd.docValue)}) — the numbers differ (2B: ${rd.docNo}). Confirm, and record the supplier's invoice number in Tally.`,
        taxable: `${label(best)} ${billNo(best)} (${best.party}) has the same TAXABLE value (${inr(best.taxable)}) but the invoice value/number differ (2B: ${rd.docNo}) — check rounding, freight or other charges on one side.`,
        tax: `${label(best)} ${billNo(best)} (${best.party}) carries the same GST (${inr(best.tax)}) within ±5 days — weakest match; verify against the physical invoice.`,
        noteTaxTaxable: `${label(best)} ${billNo(best)} (${best.party}) matches on TAXABLE (${inr(best.taxable)}) + GST (${inr(best.tax)}) within 45 days — the note number differs (2B: ${rd.docNo}). Confirm and record the supplier's note number in Tally.`,
        noteAnyDate: `${label(best)} ${billNo(best)} (${best.party}) agrees EXACTLY on TAXABLE (${inr(best.taxable)}) + GST (${inr(best.tax)}) but is dated ${best.date ? best.date.toISOString().slice(0, 10).split('-').reverse().join('-') : '?'} — far from the 2B note date. Reversals are often booked under the original invoice's date/reference; confirm the pair and record the supplier's note number (2B: ${rd.docNo}) in Tally.`,
        value45: `${label(best)} ${billNo(best)} (${best.party}) has the same value within 45 days (booked late?) — the numbers differ (2B: ${rd.docNo}). Confirm, and record the supplier's invoice number in Tally.`,
        taxable45: `${label(best)} ${billNo(best)} (${best.party}) matches on the TAXABLE value within 45 days (booked late?) — confirm against the physical invoice.`,
        dnNote: `Tally Debit Note voucher ${billNo(best)} (${best.party}) corresponds to this 2B debit note — confirm the pair.`,
        cnJournal: `${best.vtype || 'Journal'} voucher ${best.number || billNo(best)}${best.number && billNo(best) !== best.number ? ` (ref ${billNo(best)})` : ''} (${best.party}) appears to be the ITC reversal for this credit note (matched on its number/references or exact TAXABLE + GST). It is booked through a ${best.vtype || 'Journal'}, not a Debit Note voucher — confirm the pair.`,
      };
      Object.assign(rd, {
        ...bookFields(best), status: 'probable',
        diff: r2(rd.docValue - best.amount), note: notes[how],
      });
    } else {
      rd.note = isCn
        ? 'Credit note reported by the supplier but not found in Tally — the ITC reduction must still be booked.'
        : 'In GSTR-2B but not in Tally — the purchase has not been recorded.';
    }
    out.push(rd);
  }

  // Pass 2½ — 🚩 wrong-registration bookings (multi-GSTIN books only). Runs
  // AFTER every same-registration pass has finished for ALL documents, so a
  // cross-registration probe can never steal a voucher that its own
  // registration's document still needs. Evidence bar: exact document number
  // in ANOTHER registration's vouchers PLUS an agreeing amount (gross,
  // taxable or GST) — the same physical invoice booked under the wrong
  // state. Number alone is NOT enough: Tally serial numbers collide.
  if (cmpTagged) {
    for (const rd of out) {
      if (rd.status !== 'only2b' || !rd.own || rd.amended === true) continue;
      const nd = normDoc(rd.docNo);
      if (!nd) continue;
      const isCn = rd.docType === 'creditnote';
      const pairs = isCn ? [[noteExact, usedNotes]]
        : rd.docType === 'debitnote' ? [[exact, usedBills], [noteExact, usedNotes]]
        : [[exact, usedBills]];
      let hit = null; let hitUsed = null;
      outer2: for (const [pool, used] of pairs) {
        for (const k of docKeys(rd)) {
          const cands = (pool.get(`${k}|${nd}`) ?? []).filter((x) => !used.has(x.id) && !ownOk(rd, x));
          if (!cands.length) continue;
          const best = pickBest(rd, cands);
          const agrees = Math.abs(best.amount - rd.docValue) <= tolerance ||
            (rd.taxableValue > 0 && Math.abs(best.amount - rd.taxableValue) <= tolerance) ||
            (rd.taxableValue > 0 && (best.taxable || 0) > 0 && Math.abs(best.taxable - rd.taxableValue) <= tolerance) ||
            (rd.tax > 0 && best.tax > 0 && Math.abs(best.tax - rd.tax) <= tolerance);
          if (agrees) { hit = best; hitUsed = used; break outer2; }
        }
      }
      if (hit) {
        hitUsed.add(hit.id);
        const v = verdict(rd, hit, isCn ? 'Debit note' : hit.vtype || 'Purchase');
        Object.assign(rd, { ...bookFields(hit), ...v });
        flagWrongReg(rd, hit.cmpGstin || 'another registration');
      }
    }
  }

  const months = new Set();
  for (const d of docsIn) if (/^\d{6}$/.test(d.retPeriod)) months.add(`${d.retPeriod.slice(2)}-${+d.retPeriod.slice(0, 2) - 1}`);
  // Late-reported invoices carry dates BEFORE their 2B month — their book
  // vouchers must stay eligible for supplier-level grouping too.
  for (const d of docsIn) if (d.docDate) months.add(`${d.docDate.getUTCFullYear()}-${d.docDate.getUTCMonth()}`);
  const inMonths = (d) => d && months.has(`${d.getUTCFullYear()}-${d.getUTCMonth()}`);

  // Pass 3 — consolidated bookings. Many books record several supplier
  // invoices as ONE entry (or split one invoice across entries), so 1:1
  // matching strands both sides. Per supplier, compare the total of the
  // still-unmatched 2B documents against the total of the still-unmatched
  // book entries in the period: totals that agree = reconciled at supplier
  // level; totals that differ go to a supplier-wise difference table.
  const supKey = (gstin, name) => (gstin ? `g:${gstin}` : `n:${norm(name)}`);
  const leftDocs = new Map();
  for (const rd of out) {
    // Amended (|A) rows revise a document that may sit in leftDocs under its
    // original key too — letting both into the supplier totals double-counts.
    if (rd.status !== 'only2b' || rd.amended === true) continue;
    // One group per supplier PER OWN REGISTRATION — a consolidated total of
    // one state's documents must only be compared with that state's vouchers.
    const k = supKey(rd.gstin, rd.supplierName) + '|' + (rd.own || '');
    if (!leftDocs.has(k)) leftDocs.set(k, []);
    leftDocs.get(k).push(rd);
  }
  const leftBills = new Map();
  for (const b of purchases) {
    if (usedBills.has(b.id) || !inMonths(b.date)) continue;
    for (const k of [b.gstin ? `g:${b.gstin}` : null, `n:${norm(b.party)}`]) {
      if (!k) continue;
      if (!leftBills.has(k)) leftBills.set(k, []);
      leftBills.get(k).push(b);
    }
  }
  const supplierGaps = [];
  for (const docsFor of leftDocs.values()) {
    const seenIds = new Set();
    const billsFor = [];
    for (const kk of [supKey(docsFor[0].gstin, docsFor[0].supplierName), `n:${norm(docsFor[0].supplierName)}`]) {
      for (const b of leftBills.get(kk) ?? []) {
        if (seenIds.has(b.id) || usedBills.has(b.id) || !ownOk(docsFor[0], b)) continue;
        seenIds.add(b.id);
        billsFor.push(b);
      }
    }
    if (!billsFor.length) continue;
    const sum2b = r2(docsFor.reduce((s, d) => s + (d.docType === 'creditnote' ? -d.docValue : d.docValue), 0));
    const sum2bTaxable = r2(docsFor.reduce((s, d) => s + (d.docType === 'creditnote' ? -d.taxableValue : d.taxableValue), 0));
    const sumBooks = r2(billsFor.reduce((s, b) => s + b.amount, 0));
    const sumBooksPlusTds = r2(billsFor.reduce((s, b) => s + b.amount + (b.tds || 0), 0));
    const diff = r2(sum2b - sumBooks);
    const tol2 = Math.max(tolerance, r2(Math.abs(sum2b) * 0.001));
    // books may carry gross, taxable, or TDS-netted amounts — accept any basis
    const grossMatch = Math.abs(diff) <= tol2 || Math.abs(sum2b - sumBooksPlusTds) <= tol2;
    const taxableMatch = !grossMatch && sum2bTaxable > 0 &&
      (Math.abs(sum2bTaxable - sumBooks) <= tol2 || Math.abs(sum2bTaxable - sumBooksPlusTds) <= tol2);
    if (grossMatch || taxableMatch) {
      for (const d of docsFor) {
        d.status = 'grouped';
        d.note = `Supplier-level match: ${docsFor.length} document${docsFor.length > 1 ? 's' : ''} in 2B (${taxableMatch ? `taxable total ${inr(sum2bTaxable)}` : `total ${inr(sum2b)}`}) ≈ ${billsFor.length} book entr${billsFor.length > 1 ? 'ies' : 'y'} total ${inr(sumBooks)}${taxableMatch ? ' — books carry pre-GST amounts' : ''} — booked consolidated; per-invoice mapping not possible, totals agree.`;
      }
      for (const b of billsFor) usedBills.add(b.id);
    } else {
      supplierGaps.push({
        supplier: docsFor[0].supplierName, gstin: docsFor[0].gstin, own: docsFor[0].own || null,
        count2b: docsFor.length, sum2b, sum2bTaxable, countBooks: billsFor.length, sumBooks, diff,
      });
    }
  }
  supplierGaps.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // Amended (|A) rows describe a portal REVISION of a document that is often
  // already matched under its ORIGINAL key — never report those as unrecorded
  // purchases; point at the original voucher instead. (Originals are matched
  // first — the caller sorts docsIn — so the amendment can never steal the
  // original's book voucher and flip the original to NOT BOOKED.)
  const outByKey = new Map(out.map((d) => [d.key, d]));
  for (const d of out) {
    if (d.amended !== true || d.status !== 'only2b') continue;
    const o = outByKey.get(`${d.gstin}|${d.docType}|${d.orig || d.docNo}`);
    if (o && o !== d && o.status !== 'only2b') {
      d.amendedOfMatched = true;
      d.note = `Portal REVISION of ${d.orig || d.docNo} — the original document is already ${o.status === 'matched' ? 'MATCHED' : o.status.toUpperCase()} in the books (${o.bookRef || 'see the original row'}). Compare the revised figures with that voucher and adjust it in Tally if they differ; do NOT post a new entry.`;
    }
  }

  // Books-only: purchases dated inside the uploaded period(s), unmatched.
  // Does this supplier appear anywhere in the uploaded 2B? Distinguishes
  // "number/value mismatch — look closer" from "supplier absent this month —
  // they probably file it in a later period's 2B".
  const docSupKeys = new Set(docsIn.flatMap((d) => [d.gstin ? `g:${d.gstin}` : '', `n:${norm(d.supplierName)}`].filter(Boolean)));
  // A leftover book entry whose supplier + bill number ALREADY matched another
  // book entry is very likely the same invoice booked twice (sister ledgers,
  // re-entry) — ITC claimed twice in the books. Number equality alone is NOT
  // enough: Tally voucher numbers ("118") collide with unrelated invoice
  // numbers, so a duplicate must also agree on amount (gross/taxable/TDS-
  // netted) or on the GST amount.
  const matchedDocVals = new Map();
  for (const d of out) {
    if (!d.bookRef) continue;
    for (const kk of [d.gstin ? `g:${d.gstin}` : null, `n:${norm(d.supplierName)}`]) {
      if (!kk) continue;
      const k = `${kk}|${normDoc(d.docNo)}`;
      if (!matchedDocVals.has(k)) matchedDocVals.set(k, []);
      matchedDocVals.get(k).push({ value: d.docValue, taxable: d.taxableValue, tax: d.tax });
    }
  }
  const dupAmtOk = (b, m) =>
    Math.abs(b.amount - m.value) <= tolerance ||
    (m.taxable > 0 && Math.abs(b.amount - m.taxable) <= tolerance) ||
    ((b.tds || 0) > 0 && Math.abs(b.amount + b.tds - m.value) <= tolerance) ||
    (b.tax > 0 && m.tax > 0 && Math.abs(b.tax - m.tax) <= tolerance);
  // Multi-GSTIN: a voucher booked under a registration whose 2B is NOT
  // loaded is neither "missing from 2B" nor part of this run's ITC — keep it
  // out of the books-only/duplicate/ITC views entirely.
  const loadedOwns = new Set(docsIn.map((d) => d.own).filter(Boolean));
  const ownLoaded = (b) => !cmpTagged || !b.cmpGstin || !loadedOwns.size || loadedOwns.has(b.cmpGstin);
  const booksLeft = purchases
    .filter((b) => !usedBills.has(b.id) && inMonths(b.date) && ownLoaded(b))
    .map((b) => ({
      id: b.id, billNo: billNo(b), billDate: b.date, amount: b.amount, tax: b.tax,
      igst: b.igst, cgst: b.cgst, sgst: b.sgst, cess: b.cess, gst: b.gst, tds: b.tds,
      vtype: b.vtype, supplierName: b.party, gstin: b.gstin, cmpGstin: b.cmpGstin || null,
      supplierIn2b: (b.gstin && docSupKeys.has(`g:${b.gstin}`)) || docSupKeys.has(`n:${norm(b.party)}`),
      possibleDuplicate: false,
    }))
    .sort((a, b) => b.amount - a.amount);
  // Kind 1: same supplier + number as a MATCHED 2B document, and the amounts
  // corroborate.
  for (const b of booksLeft) {
    const ms = [
      ...(b.gstin ? matchedDocVals.get(`g:${b.gstin}|${normDoc(b.billNo)}`) ?? [] : []),
      ...(matchedDocVals.get(`n:${norm(b.supplierName)}|${normDoc(b.billNo)}`) ?? []),
    ];
    if (ms.some((m) => dupAmtOk(b, m))) { b.possibleDuplicate = true; b.dupKind = 'matched'; }
  }
  // Kind 2: the same invoice entered TWICE where neither copy matched the 2B
  // (supplier hasn't filed yet) — same supplier + number among the leftovers,
  // and the two entries agree on amount or GST.
  const leftGroups = new Map();
  for (const b of booksLeft) {
    if (b.possibleDuplicate) continue;
    const nd = normDoc(b.billNo);
    if (nd.length < 2 || b.billNo === '(no number)') continue;
    const k = `${supKey(b.gstin, b.supplierName)}|${nd}`;
    if (!leftGroups.has(k)) leftGroups.set(k, []);
    leftGroups.get(k).push(b);
  }
  for (const group of leftGroups.values()) {
    if (group.length < 2) continue;
    for (const b of group) {
      const twin = group.some((o) => o !== b &&
        (Math.abs(o.amount - b.amount) <= tolerance || (o.tax > 0 && b.tax > 0 && Math.abs(o.tax - b.tax) <= tolerance)));
      if (twin) { b.possibleDuplicate = true; b.dupKind = 'internal'; }
    }
  }
  // Duplicates are a books-side problem (same invoice booked twice), not
  // "supplier didn't file" — report them separately from ITC-at-risk.
  const duplicates = booksLeft.filter((b) => b.possibleDuplicate);
  const booksOnly = booksLeft.filter((b) => !b.possibleDuplicate);

  const suppliersNoGstin = [...new Set(purchases.filter((b) => !b.gstin).map((b) => b.party))].sort();

  const sum = (rows) => r2(rows.reduce((s, d) => s + d.tax, 0));
  const eligible = out.filter((d) => d.itcAvailable);
  const elig = (st) => eligible.filter((d) => d.status === st && d.docType !== 'creditnote' && !d.amendedOfMatched);
  const creditNotes = eligible.filter((d) => d.docType === 'creditnote');
  const blocked = out.filter((d) => !d.itcAvailable);
  const claimableTax = r2(sum(eligible.filter((d) => d.docType !== 'creditnote')) - sum(creditNotes));
  const matchedTax = sum(elig('matched'));

  // ITC head-by-head: what the books' input CGST/SGST/IGST/Cess ledgers carry
  // for the period(s), against what GSTR-2B allows.
  // 'gst' is the combined-ledger bucket (books side only — the statement is
  // always head-split).
  const HEADS = ['igst', 'cgst', 'sgst', 'cess', 'gst'];
  const booksItc = { igst: 0, cgst: 0, sgst: 0, cess: 0, gst: 0 };
  for (const b of purchases) if (inMonths(b.date) && ownLoaded(b)) for (const h of HEADS) booksItc[h] = r2(booksItc[h] + (b[h] || 0));
  for (const n of bookNotes) if (inMonths(n.date) && ownLoaded(n)) for (const h of HEADS) booksItc[h] = r2(booksItc[h] - (n[h] || 0));
  const itc2b = { igst: 0, cgst: 0, sgst: 0, cess: 0, gst: 0 };
  for (const d of eligible) for (const h of HEADS) itc2b[h] = r2(itc2b[h] + (d.docType === 'creditnote' ? -(d[h] || 0) : (d[h] || 0)));
  const booksItcTotal = r2(HEADS.reduce((s, h) => s + booksItc[h], 0));
  const booksTaxKnown = purchases.some((b) => b.tax > 0) || bookNotes.some((n) => n.tax > 0);

  const groupedTax = sum(elig('grouped'));
  const summary = {
    docCount: out.length, claimableTax, matchedTax, groupedTax,
    groupedCount: out.filter((d) => d.status === 'grouped').length,
    mismatchTax: sum(elig('mismatch')), probableTax: sum(elig('probable')), only2bTax: sum(elig('only2b')),
    blockedTax: sum(blocked), blockedReasons: [...new Set(blocked.map((d) => d.reason).filter(Boolean))],
    creditNoteTax: sum(creditNotes),
    booksOnlyCount: booksOnly.length,
    booksOnlyValue: r2(booksOnly.reduce((s, b) => s + b.amount, 0)),
    booksOnlyTax: r2(booksOnly.reduce((s, b) => s + b.tax, 0)),
    duplicateBookings: duplicates.length,
    duplicatesItc: r2(duplicates.reduce((s, b) => s + b.tax, 0)),
    matchedPct: claimableTax > 0 ? Math.round(((matchedTax + groupedTax) / claimableTax) * 100) : out.length ? 100 : 0,
    booksItc, itc2b, booksItcTotal, booksTaxKnown,
    headSwaps: out.filter((d) => d.headSwap).length,
    wrongRegCount: out.filter((d) => d.wrongReg).length,
    wrongRegTax: sum(out.filter((d) => d.wrongReg)),
    supplierGaps,
  };
  return { docs: out, booksOnly, duplicates, suppliersNoGstin, summary, usedBillIds: usedBills, opinions: buildOpinions(out, booksOnly, suppliersNoGstin, summary) };
}
// --------------------------------- opinions ----------------------------------
function topSuppliers(rows, n = 3) {
  const count = new Map();
  for (const r of rows) count.set(r.supplierName, (count.get(r.supplierName) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name]) => name);
}

function buildOpinions(docs, booksOnly, suppliersNoGstin, s) {
  const ops = [];
  const bucket = (st) => docs.filter((d) => d.status === st);
  const clean = s.matchedPct >= 95 && !booksOnly.length && !bucket('only2b').length && !bucket('mismatch').length;

  const totalMatched = r2(s.matchedTax + s.groupedTax);
  if (clean) {
    ops.push({ tone: 'good', text: `Books and GSTR-2B agree: ${s.matchedPct}% of eligible ITC (${inr(totalMatched)}) is matched against Tally${s.groupedTax > 0 ? ' (including supplier-level matches for consolidated bookings)' : ''}. It is safe to claim ITC of ${inr(s.claimableTax)} for the selected period(s), subject to the payment-within-180-days and other Section 16 conditions.` });
  } else if (s.matchedPct >= 80) {
    ops.push({ tone: 'warn', text: `Largely reconciled: ${s.matchedPct}% of eligible ITC (${inr(totalMatched)} of ${inr(s.claimableTax)}) matches the books${s.groupedTax > 0 ? ' (incl. supplier-level matches)' : ''}. Resolve the differences below before filing GSTR-3B — claim only the matched portion until then.` });
  } else {
    ops.push({ tone: 'bad', text: `Only ${s.matchedPct}% of eligible ITC per GSTR-2B (${inr(totalMatched)} of ${inr(s.claimableTax)}) could be matched to the books. Do not claim the unmatched ITC yet — work through the differences below first.` });
  }

  if (s.groupedCount > 0) {
    ops.push({ tone: 'good', text: `${s.groupedCount} document${s.groupedCount > 1 ? 's' : ''} (ITC ${inr(s.groupedTax)}) matched at SUPPLIER level — the invoices are booked consolidated in Tally, and the supplier-wise totals agree with GSTR-2B. That is acceptable for claiming ITC; booking invoice-wise (with the supplier's invoice number) would make future reconciliation exact.` });
  }

  if (s.supplierGaps?.length) {
    const top = s.supplierGaps.slice(0, 3).map((g) => `${g.supplier} (2B ${inr(g.sum2b)} vs books ${inr(g.sumBooks)}, gap ${inr(g.diff)})`).join('; ');
    ops.push({ tone: 'bad', text: `${s.supplierGaps.length} supplier${s.supplierGaps.length > 1 ? 's' : ''} still ${s.supplierGaps.length > 1 ? 'have' : 'has'} unmatched totals after every pass — largest: ${top}${s.supplierGaps.length > 3 ? '; and more' : ''}. See the supplier-wise difference table: a positive gap means the supplier filed more than you booked (unrecorded purchases / their error); a negative gap means you booked more than they filed (ITC at risk).` });
  }

  const booksOnlyTop = topSuppliers(booksOnly);
  if (booksOnly.length) {
    ops.push({ tone: 'bad', text: `ITC at risk: ${booksOnly.length} purchase${booksOnly.length > 1 ? 's' : ''} worth ${inr(s.booksOnlyValue)}${s.booksOnlyTax > 0 ? ` (GST thereon ${inr(s.booksOnlyTax)})` : ''} ${booksOnly.length > 1 ? 'are' : 'is'} in the books but missing from GSTR-2B — the supplier${booksOnlyTop.length > 1 ? 's have' : ' has'} not filed ${booksOnly.length > 1 ? 'them' : 'it'}, so this ITC cannot be claimed (Section 16(2)(aa)). Follow up with ${booksOnlyTop.join(', ')}${booksOnly.length > booksOnlyTop.length ? ' and others' : ''}; if they filed late, the invoices should appear in a later period's 2B.` });
  }

  if (s.duplicateBookings > 0) {
    ops.push({ tone: 'bad', text: `${s.duplicateBookings} book entr${s.duplicateBookings > 1 ? 'ies look' : 'y looks'} like DUPLICATE booking${s.duplicateBookings > 1 ? 's' : ''} (ITC ${inr(s.duplicatesItc)}) — the same supplier + bill number appears again, either against an entry already matched to the 2B or entered more than once in Tally (often the same invoice under two ledgers, or entered twice). ITC may be claimed twice in the books; verify and reverse the extra entries. See the "Possible duplicate bookings" section for the reason on each row.` });
  }

  if (s.headSwaps > 0) {
    ops.push({ tone: 'bad', text: `${s.headSwaps} matched document${s.headSwaps > 1 ? 's are' : ' is'} booked under the WRONG tax head — IGST in one place, CGST+SGST in the other (see the remarks in the matched/mismatch tables). Correct these entries in Tally before filing: cross-head claims are recovered with interest in scrutiny.` });
  }

  if (s.wrongRegCount > 0) {
    ops.push({ tone: 'bad', text: `🚩 ${s.wrongRegCount} document${s.wrongRegCount > 1 ? 's' : ''} (GST ${inr(s.wrongRegTax)}) ${s.wrongRegCount > 1 ? 'are' : 'is'} booked under the WRONG REGISTRATION — the supplier billed one of your GSTINs but the voucher sits in another state's registration. ITC belongs to the registration on the invoice: change the GST Registration on those vouchers in Tally (see the 🚩 rows and the "Wrong Registration" Excel sheet) before filing either state's GSTR-3B.` });
  }

  if (s.booksTaxKnown) {
    const gap = r2(s.booksItcTotal - s.claimableTax);
    if (gap > 5) {
      ops.push({ tone: 'bad', text: `ITC as per the books' GST input ledgers is ${inr(s.booksItcTotal)}, which is ${inr(gap)} MORE than the eligible ITC per GSTR-2B (${inr(s.claimableTax)}) for the period(s). Claiming the books figure in GSTR-3B would create a 2B mismatch — claim per 2B and carry the balance until the missing suppliers file. Head-wise: IGST ${inr(s.booksItc.igst)} vs ${inr(s.itc2b.igst)}, CGST ${inr(s.booksItc.cgst)} vs ${inr(s.itc2b.cgst)}, SGST ${inr(s.booksItc.sgst)} vs ${inr(s.itc2b.sgst)}${s.booksItc.cess || s.itc2b.cess ? `, Cess ${inr(s.booksItc.cess)} vs ${inr(s.itc2b.cess)}` : ''}.` });
    } else if (gap < -5) {
      ops.push({ tone: 'warn', text: `The books' GST input ledgers carry ${inr(s.booksItcTotal)} of ITC — ${inr(Math.abs(gap))} LESS than what GSTR-2B allows (${inr(s.claimableTax)}). Some eligible ITC may not be booked (or a purchase was booked without splitting the GST to the input ledgers) — see the "in 2B, not in books" list.` });
    } else {
      ops.push({ tone: 'good', text: `ITC per the books' GST input ledgers (${inr(s.booksItcTotal)}) agrees with the eligible ITC per GSTR-2B (${inr(s.claimableTax)}) within tolerance.` });
    }
  } else if (docs.length) {
    ops.push({ tone: 'warn', text: `No CGST/SGST/IGST input ledgers could be identified on the vouchers read from Tally, so the GST-amount and tax-head checks were skipped (gross invoice values were still verified). If your GST ledgers are named unusually, rename them to include CGST/SGST/IGST or check the vouchers carry the tax split.` });
  }

  const only2b = bucket('only2b').filter((d) => d.docType !== 'creditnote' && d.itcAvailable && !d.amendedOfMatched);
  if (only2b.length) {
    ops.push({ tone: 'warn', text: `${only2b.length} document${only2b.length > 1 ? 's' : ''} with ITC of ${inr(s.only2bTax)} appear${only2b.length > 1 ? '' : 's'} in GSTR-2B but not in the books — likely unrecorded purchases, or entries booked under a different number/party. Record them in Tally before claiming this ITC; an invoice you never booked may also signal misuse of your GSTIN.` });
  }

  const cn2b = bucket('only2b').filter((d) => d.docType === 'creditnote' && !d.amendedOfMatched);
  if (cn2b.length) {
    ops.push({ tone: 'bad', text: `${cn2b.length} supplier credit note${cn2b.length > 1 ? 's' : ''} in GSTR-2B ${cn2b.length > 1 ? 'are' : 'is'} not reflected in the books. ITC must be reversed on these even if unbooked — record the corresponding debit note in Tally.` });
  }

  const mism = bucket('mismatch');
  if (mism.length) {
    ops.push({ tone: 'warn', text: `${mism.length} document${mism.length > 1 ? 's' : ''} matched by number but the values differ (ITC involved: ${inr(s.mismatchTax)}). Verify against the physical invoice: if the books are wrong, correct the entry in Tally; if the supplier filed wrongly, ask for an amendment — meanwhile claim ITC only on the lower of the two values.` });
  }

  const prob = bucket('probable');
  if (prob.length) {
    ops.push({ tone: 'warn', text: `${prob.length} probable match${prob.length > 1 ? 'es' : ''} found on supplier + value with different document numbers — usually the books carry Tally's voucher number instead of the supplier's invoice number. Confirm each pair and record the supplier's invoice number (Supplier Invoice No. field) so future months match automatically.` });
  }

  if (s.blockedTax > 0) {
    ops.push({ tone: 'bad', text: `The portal marks ${inr(s.blockedTax)} of ITC as NOT available${s.blockedReasons.length ? ` (reason: ${s.blockedReasons.join('; ')})` : ''} — typically POS in another state or time-barred. Do not claim it, whatever the books say.` });
  }

  if (s.creditNoteTax > 0) {
    ops.push({ tone: 'warn', text: `Supplier credit notes reduce eligible ITC by ${inr(s.creditNoteTax)} this period — the claimable figure above is already net of these.` });
  }

  if (suppliersNoGstin.length) {
    ops.push({ tone: 'warn', text: `${suppliersNoGstin.length} supplier ledger${suppliersNoGstin.length > 1 ? 's' : ''} in Tally (${suppliersNoGstin.slice(0, 3).join(', ')}${suppliersNoGstin.length > 3 ? '…' : ''}) ${suppliersNoGstin.length > 1 ? 'have' : 'has'} no GSTIN, so matching fell back to the ledger name. Fill in the GSTIN on those ledgers for reliable matching.` });
  }

  if (!docs.length) return [{ tone: 'warn', text: 'No GSTR-2B documents found in the input file(s).' }];
  return ops;
}

// ------------------------ server-side GSTR-2B parsing ------------------------
// Mirrors the browser parser so the self-worker can read files on its own.
function svDocTotals(doc) {
  const t = { txval: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  const first = (o, keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return toNum(o[k]); return 0; };
  for (const raw of doc.items || doc.itms || []) {
    const it = raw && raw.itm_det ? raw.itm_det : (raw || {});
    t.txval += first(it, ['txval', 'taxval', 'txblval']);
    t.igst += first(it, ['igst', 'iamt']);
    t.cgst += first(it, ['cgst', 'camt']);
    t.sgst += first(it, ['sgst', 'samt']);
    t.cess += first(it, ['cess', 'csamt', 'cs']);
  }
  if (t.igst + t.cgst + t.sgst + t.cess === 0) {
    t.igst = first(doc, ['igst', 'iamt']); t.cgst = first(doc, ['cgst', 'camt']);
    t.sgst = first(doc, ['sgst', 'samt']); t.cess = t.cess || first(doc, ['cess', 'csamt']);
  }
  if (!t.txval) t.txval = first(doc, ['txval', 'taxval', 'txblval']);
  for (const k of Object.keys(t)) t[k] = r2(t[k]);
  return t;
}
function svDocKey(d) { return d.gstin + '|' + d.type + '|' + d.no + (d.amended ? '|A' : ''); }
function parseGstr2bServer(text) {
  const root = JSON.parse(text);
  const data = root.data || root;
  const dd = data.docdata || data.docData;
  if (!dd) throw new Error('no GSTR-2B document data');
  const period = String(data.rtnprd || data.ret_period || '');
  const rows = [];
  const dt = (v) => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(v || '')); return m ? m[3] + '-' + m[2] + '-' + m[1] : null; };
  const push = (sup, doc, type, amended) => {
    const gstin = String(sup.ctin || '').toUpperCase();
    const no = String(doc.inum || doc.ntnum || doc.nt_num || '');
    const date = dt(doc.dt);
    if (!gstin || !no || !date) return;
    const t = svDocTotals(doc);
    const row = { period, type, gstin, name: String(sup.trdnm || gstin), no, date,
      val: r2(toNum(doc.val)), rcm: doc.rev === 'Y', itc: doc.itcavl !== 'N',
      txval: t.txval, igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: t.cess,
      // which of OUR registrations this 2B belongs to (multi-GSTIN books)
      own: String(data.gstin || '').toUpperCase() || undefined };
    if (amended) { row.amended = true; row.orig = String(doc.oinum || doc.ontnum || ''); }
    row.key = svDocKey(row);
    rows.push(row);
  };
  for (const sup of dd.b2b || []) for (const inv of sup.inv || []) push(sup, inv, 'invoice', false);
  for (const sup of dd.cdnr || []) for (const nt of sup.nt || []) push(sup, nt, nt.typ === 'C' ? 'creditnote' : 'debitnote', false);
  for (const sup of dd.b2ba || []) for (const inv of sup.inv || []) push(sup, inv, 'invoice', true);
  for (const sup of dd.cdnra || []) for (const nt of sup.nt || []) push(sup, nt, nt.typ === 'C' ? 'creditnote' : 'debitnote', true);
  return { gstin: String(data.gstin || ''), returnPeriod: period, rows };
}
let recoDirty = false;
// Fields that make a re-uploaded row a genuine CORRECTION of the stored copy
// (a re-downloaded 2B after the portal fixed figures, etc.) — the stored row
// is replaced so reconciliation stops working off stale numbers.
const DOC_FIELDS = ['period', 'type', 'gstin', 'name', 'no', 'date', 'val', 'rcm', 'itc', 'txval', 'igst', 'cgst', 'sgst', 'cess', 'amended', 'orig', 'own'];
function mergeDocs(rows) {
  let added = 0, updated = 0;
  state.docs = state.docs || {};
  for (const r of rows || []) {
    if (!r || !r.key) continue;
    const old = state.docs[r.key];
    if (!old) { state.docs[r.key] = r; added++; }
    else if (DOC_FIELDS.some((f) => String(old[f] ?? '') !== String(r[f] ?? ''))) {
      state.docs[r.key] = r;
      updated++;
    }
  }
  if (added || updated) { recoDirty = true; saveState(); }
  return { added, updated };
}

// -------------------------- server-side reconcile ----------------------------
let recoRunning = false;
async function runServerReco() {
  if (recoRunning) throw new Error('a reconciliation is already running');
  const rows = Object.values(state.docs || {});
  if (!rows.length) throw new Error('no GSTR-2B documents loaded yet');
  const guard = await companyGuard(true);
  if (!guard.ok) throw new Error(guard.reason);
  recoRunning = true;
  recoProgress.active = true;
  recoProgress.phase = 'starting';
  recoProgress.mode = '';
  recoProgress.monthsDone = 0;
  recoProgress.monthsTotal = 0;
  recoProgress.vouchers = 0;
  try {
    const docsIn = rows.map((d) => ({
      key: String(d.key), retPeriod: String(d.period || ''), gstin: String(d.gstin || '').toUpperCase(),
      supplierName: String(d.name || ''), docType: String(d.type || 'invoice'), docNo: String(d.no || ''),
      docDate: parseDocDate(d.date), docValue: r2(toNum(d.val)), taxableValue: r2(toNum(d.txval)),
      igst: r2(toNum(d.igst)), cgst: r2(toNum(d.cgst)), sgst: r2(toNum(d.sgst)), cess: r2(toNum(d.cess)),
      itcAvailable: d.itc !== false, reason: null,
      amended: d.amended === true, orig: d.orig ? String(d.orig) : null,
      own: String(d.own || '').toUpperCase() || null,
    }));
    // Originals FIRST: an amended (|A) row must never win the book voucher
    // away from its original and leave the original showing NOT BOOKED —
    // that would invite posting the same purchase twice.
    docsIn.sort((a, b) => (a.amended === true ? 1 : 0) - (b.amended === true ? 1 : 0));
    const periods = [...new Set(docsIn.map((d) => d.retPeriod).filter((p) => /^\d{6}$/.test(p)))]
      .sort((a, b) => (a.slice(2) + a.slice(0, 2)).localeCompare(b.slice(2) + b.slice(0, 2)));
    const first = periods[0];
    const last = periods[periods.length - 1] || first;
    let from, to;
    if (first) {
      const y = +first.slice(2), m = +first.slice(0, 2);
      from = new Date(Date.UTC((m >= 4 ? y : y - 1) - 1, 3, 1));
      const lastEnd = new Date(Date.UTC(+last.slice(2), +last.slice(0, 2), 0));
      to = new Date() > lastEnd ? new Date() : lastEnd;
    } else {
      const ds = docsIn.map((d) => d.docDate).filter(Boolean).sort((a, b) => a - b);
      from = new Date((ds[0] || new Date()).getTime() - 400 * 86400000);
      to = new Date();
    }
    // Read the books through BOTH export paths and merge (shared GUID dedupe
    // with field-wise merge): some Tally setups scope collections to the UI
    // period, others export the Day Book for the UI period regardless of the
    // requested dates — the union is complete either way. The Day Book runs
    // FIRST because it carries the true on-screen voucher numbers (the TDL
    // collection recomputes automatic numbers out of context); the collection
    // then adds anything the Day Book missed and backfills PARTYGSTIN /
    // CMPGSTIN on the duplicates.
    const seenV = new Map();
    const readA = await readTally(state.settings.tallyUrl, from, to, 'daybook', seenV);
    const readB = await readTally(state.settings.tallyUrl, from, to, 'collection', seenV);
    const read = {
      vouchers: readA.vouchers.concat(readB.vouchers),
      totalBlocks: readA.totalBlocks + readB.totalBlocks,
    };
    // A Company name that does not EXACTLY match the open company makes Tally
    // return empty exports — which would show every document as NOT BOOKED.
    // Catch it loudly instead.
    const cmpName = String(state.settings.company || '').trim();
    if (!read.vouchers.length && cmpName) {
      const saveCmp = state.settings.company;
      let probe = { vouchers: [] };
      try {
        state.settings.company = '';
        probe = await readTally(state.settings.tallyUrl, from, to, 'daybook', new Map());
      } finally {
        state.settings.company = saveCmp;
      }
      if (probe.vouchers.length) {
        throw new Error('🛑 The Company name under Settings ("' + cmpName + '") returned NO data from Tally — it must match the open company name EXACTLY (including "(from 1-Apr-25)" etc.). Fix or clear the Company field, then reconcile again.');
      }
    }
    const monthsWithData = [...new Set(read.vouchers.map((v) => v.date ? v.date.toISOString().slice(0, 7) : '').filter(Boolean))].sort();
    // Tally-period guard: many Tally setups export only the period selected
    // on screen (Alt+F2), whatever dates we request. If the books' months
    // don't overlap the 2B data's months at all, reconciling would mark
    // everything NOT BOOKED — refuse with the exact fix instead.
    const docMonths = new Set();
    for (const d of docsIn) if (d.docDate) docMonths.add(d.docDate.toISOString().slice(0, 7));
    for (const p of periods) docMonths.add(p.slice(2) + '-' + p.slice(0, 2));
    // ±1 month slack for the abort test — purchases booked a few weeks late
    // (June invoices entered in July) must not trip the hard guard.
    const slackMonths = new Set(docMonths);
    for (const m of docMonths) {
      const y = +m.slice(0, 4), mm = +m.slice(5, 7);
      slackMonths.add(new Date(Date.UTC(y, mm - 2, 1)).toISOString().slice(0, 7));
      slackMonths.add(new Date(Date.UTC(y, mm, 1)).toISOString().slice(0, 7));
    }
    let periodWarning = '';
    if (read.vouchers.length && docMonths.size) {
      const dm = [...docMonths].sort();
      const overlap = monthsWithData.filter((m) => slackMonths.has(m));
      if (!overlap.length) {
        throw new Error('🛑 TALLY PERIOD MISMATCH: Tally returned vouchers only for ' + monthsWithData[0] + ' → ' + monthsWithData[monthsWithData.length - 1] +
          ', but the loaded 2B data belongs to ' + dm[0] + ' → ' + dm[dm.length - 1] +
          '. Your Tally exports only the period selected on screen — press Alt+F2 in Tally, set the period to cover ' + dm[0] + ' → ' + dm[dm.length - 1] + ', then reconcile again.');
      }
      const missing = dm.filter((m) => monthsWithData.indexOf(m) < 0);
      if (missing.length) {
        periodWarning = '⚠ Tally showed NO vouchers for ' + missing.join(', ') + ' although your 2B data covers those months — if they are booked, widen the Tally period (Alt+F2) to include them and reconcile again.';
      }
    }
    recoProgress.phase = 'masters';
    let ledgerGstins = new Map();
    try { ledgerGstins = parseLedgerGstins(await askTally(state.settings.tallyUrl, LEDGER_GSTIN_REQUEST())); } catch { /* older Tally */ }
    recoProgress.phase = 'matching';
    const books = buildBooks(read.vouchers, ledgerGstins);
    for (const b of [...books.purchases, ...books.bookNotes]) {
      b.gstin = ((b.partyGstin || ledgerGstins.get(norm(b.party)) || '') + '').toUpperCase() || null;
    }
    // 🧠 Learn each supplier's usual purchase/expense ledger from their past
    // entries — the most frequent non-tax leg across their booked purchases.
    // A manually chosen ledger (purchaseLedgerManual) is never overwritten.
    const ledgerFreq = {};
    for (const b of books.purchases) {
      if (!b.gstin || !Array.isArray(b.expenses)) continue;
      for (const nm of b.expenses) {
        if (!nm) continue;
        (ledgerFreq[b.gstin] = ledgerFreq[b.gstin] || {})[nm] = (ledgerFreq[b.gstin][nm] || 0) + 1;
      }
    }
    let learned = 0;
    for (const [g, freq] of Object.entries(ledgerFreq)) {
      const m = state.mappings[g];
      if (!m || m.purchaseLedgerManual) continue;
      const best = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
      if (best && m.purchaseLedger !== best[0]) {
        m.purchaseLedger = best[0];
        m.purchaseLedgerLearned = true;
        learned++;
      }
    }
    if (learned) console.log('  🧠 learned the usual purchase ledger for ' + learned + ' supplier(s) from the books');
    const tolerance = toNum(state.settings.tolerance) || 5;
    const recon = reconcile(docsIn, books.purchases, books.bookNotes, tolerance, {});
    // Make "not booked" actionable: distinguish "supplier absent from the
    // books entirely" from "supplier IS in the books but this document did
    // not line up on number/value".
    const bySupAll = new Map();
    for (const b of [...books.purchases, ...books.bookNotes]) {
      for (const k of [b.gstin ? 'g:' + b.gstin : null, 'n:' + norm(b.party)]) {
        if (!k) continue;
        if (!bySupAll.has(k)) bySupAll.set(k, []);
        bySupAll.get(k).push(b);
      }
    }
    const fmtD = (dt) => (dt ? dt.toISOString().slice(0, 10).split('-').reverse().join('-') : '?');
    // WHY-not-booked diagnosis: when the books read contained NO vouchers at
    // all in a document's invoice month, a booking made in that month simply
    // was not exported — lead the note with the real cause (Tally's period /
    // company coverage) instead of "the purchase has not been recorded".
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthName = (m) => MONTHS[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4);
    if (monthsWithData.length) {
      // Only months BEFORE the first month read: the register starting later
      // than the invoice means the earlier books were not exported. Months
      // AFTER the last read month are normal — those purchases are simply
      // not booked yet (that is what posting is for).
      const loM = monthsWithData[0];
      for (const d of recon.docs) {
        if (d.status !== 'only2b' || d.amendedOfMatched) continue;
        const m = d.docDate ? d.docDate.toISOString().slice(0, 7) : '';
        if (m && m < loM) {
          d.readGap = m;
          d.note = '🛑 Tally exported NO vouchers dated ' + monthName(m) + ' at all (the books read covered ' + monthName(monthsWithData[0]) + ' → ' + monthName(monthsWithData[monthsWithData.length - 1]) + ') — if this document is booked in ' + monthName(m) + ', the tool could not see it. Press Alt+F2 in Tally and widen the period to include ' + monthName(m) + ' (and make sure the open company holds those months), then reconcile again. ' + d.note;
        }
      }
    }
    for (const d of recon.docs) {
      if (d.status !== 'only2b' || d.amendedOfMatched || d.readGap) continue;
      // Dedupe by OBJECT identity — purchases and bookNotes carry independent
      // id sequences (both start at 0), so a Map keyed by b.id would let a
      // note overwrite an unrelated purchase and hide the real closest entry.
      const cand = new Set();
      for (const k of [d.gstin ? 'g:' + d.gstin : null, 'n:' + norm(d.supplierName)]) {
        if (!k) continue;
        for (const b of bySupAll.get(k) || []) cand.add(b);
      }
      if (cand.size) {
        // Show the closest book entries so the difference is visible on face.
        const top = [...cand]
          .sort((a, b) => Math.abs(a.amount - d.docValue) - Math.abs(b.amount - d.docValue))
          .slice(0, 3)
          .map((b) => (b.reference || b.number || '(no no.)') + ' dt ' + fmtD(b.date) + ' ₹' + r2(b.amount).toLocaleString('en-IN'));
        d.note += ' (The books DO have ' + cand.size + ' entr' + (cand.size > 1 ? 'ies' : 'y') + ' for this supplier — closest: ' + top.join('; ') + '. Compare in the Excel: All Documents / Supplier Gaps.)';
      } else {
        d.note += ' (No entry for this supplier found anywhere in the books read.)';
      }
    }
    // Posted register follows Tally's truth: lock what is booked, release
    // register entries whose vouchers vanished (restored company etc.).
    let lockedNew = 0, staleReset = 0;
    for (const d of recon.docs) {
      if (d.status === 'matched' || d.status === 'grouped') {
        if (!state.posted[d.key]) { state.posted[d.key] = { at: new Date().toISOString(), via: 'found-in-tally' }; lockedNew++; }
      } else if (d.status === 'only2b' && state.posted[d.key] && !d.readGap) {
        delete state.posted[d.key];
        staleReset++;
      }
    }
    state.reco = {
      ok: true,
      at: new Date().toISOString(),
      tolerance, lockedNew, staleReset,
      readInfo: {
        from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10),
        vouchers: read.vouchers.length, monthsWithData, warning: periodWarning,
        journalsSkipped: books.journalsSkipped || 0,
        skippedLedgers: [...(books.skippedLedgers || new Map()).entries()]
          .sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]),
      },
      docs: recon.docs.map((d) => ({
        key: d.key, status: d.status, note: d.note || '', headSwap: !!d.headSwap,
        amendedOfMatched: !!d.amendedOfMatched, readGap: d.readGap || null, own: d.own || null,
        wrongReg: d.wrongReg || null,
        bookRef: d.bookRef || null, bookAmount: d.bookAmount ?? null, bookTax: d.bookTax ?? null,
        bookTaxable: d.bookTaxable ?? null, bookIgst: d.bookIgst ?? null, bookCgst: d.bookCgst ?? null,
        bookSgst: d.bookSgst ?? null, bookGstComb: d.bookGstComb ?? null, bookTds: d.bookTds ?? null,
        bookReimb: d.bookReimb ?? null, diff: d.diff ?? null, eligible: d.itcAvailable !== false,
      })),
      booksOnly: recon.booksOnly.map((b) => ({
        billNo: b.billNo, date: b.billDate ? b.billDate.toISOString().slice(0, 10) : null,
        vtype: b.vtype, party: b.supplierName, gstin: b.gstin, amount: b.amount, tax: b.tax,
        igst: b.igst || 0, cgst: b.cgst || 0, sgst: b.sgst || 0, gst: b.gst || 0, tds: b.tds || 0,
        supplierIn2b: !!b.supplierIn2b, cmpGstin: b.cmpGstin || null,
      })),
      duplicates: recon.duplicates.map((b) => ({
        billNo: b.billNo, party: b.supplierName, gstin: b.gstin || '', vtype: b.vtype || '',
        date: b.billDate ? b.billDate.toISOString().slice(0, 10) : '',
        amount: b.amount, igst: b.igst || 0, cgst: b.cgst || 0, sgst: b.sgst || 0,
        tds: b.tds || 0, tax: b.tax, kind: b.dupKind || '', cmpGstin: b.cmpGstin || null,
      })),
      opinions: recon.opinions,
      summary: {
        matchedPct: recon.summary.matchedPct, claimableTax: recon.summary.claimableTax,
        matchedTax: recon.summary.matchedTax, groupedTax: recon.summary.groupedTax,
        groupedCount: recon.summary.groupedCount, blockedTax: recon.summary.blockedTax,
        creditNoteTax: recon.summary.creditNoteTax, booksOnlyValue: recon.summary.booksOnlyValue,
        booksOnlyTax: recon.summary.booksOnlyTax, booksItc: recon.summary.booksItc,
        itc2b: recon.summary.itc2b, booksItcTotal: recon.summary.booksItcTotal,
        headSwaps: recon.summary.headSwaps, suppliersNoGstin: recon.suppliersNoGstin.length,
        wrongRegCount: recon.summary.wrongRegCount || 0, wrongRegTax: recon.summary.wrongRegTax || 0,
        supplierGaps: recon.summary.supplierGaps || [],
        byOwn: (() => {
          // Per-registration split (multi-GSTIN books) — each state files its
          // own GSTR-3B, so ITC must be readable per registration.
          const m = new Map();
          for (const d of recon.docs) {
            const g = d.own || '';
            if (!g) continue;
            if (!m.has(g)) m.set(g, { gstin: g, docs: 0, claimable: 0, matched: 0, notBooked: 0, mismatch: 0 });
            const o = m.get(g);
            o.docs++;
            const tax = r2((d.igst || 0) + (d.cgst || 0) + (d.sgst || 0) + (d.cess || 0));
            const sgn = d.docType === 'creditnote' ? -1 : 1;
            if (d.itcAvailable !== false) {
              o.claimable = r2(o.claimable + sgn * tax);
              if (d.status === 'matched' || d.status === 'grouped') o.matched = r2(o.matched + sgn * tax);
              else if (d.status === 'only2b' && !d.amendedOfMatched && d.docType !== 'creditnote') o.notBooked = r2(o.notBooked + tax);
            }
            if (d.status === 'mismatch') o.mismatch++;
            if (d.wrongReg) o.wrongReg = (o.wrongReg || 0) + 1;
          }
          return m.size > 1 ? [...m.values()].sort((a, b) => a.gstin.localeCompare(b.gstin)) : [];
        })(),
      },
    };
    recoDirty = false;
    saveState();
    return state.reco;
  } finally {
    recoRunning = false;
    recoProgress.active = false;
  }
}

// ------------------------------ 🛡 company guard ------------------------------
// Asks Tally which companies are OPEN (with their GSTINs, wherever the field
// appears in the company block — matched by GSTIN pattern so every Tally
// version works) and refuses to write or reconcile when the open company does
// not belong to the loaded 2B data.
const COMPANY_REQUEST = () =>
  '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
  '<ID>G2bCompanies</ID></HEADER><BODY><DESC><STATICVARIABLES>' +
  '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>' +
  '<TDL><TDLMESSAGE><COLLECTION NAME="G2bCompanies" ISMODIFY="No"><TYPE>Company</TYPE>' +
  '<NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>GSTRegistrationNumber</NATIVEMETHOD>' +
  '<NATIVEMETHOD>GSTRegistrations</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
function parseCompanies(xml) {
  const out = [];
  for (const m of xml.matchAll(/<COMPANY NAME="([^"]*)"[^>]*(?:\/>|>([\s\S]*?)<\/COMPANY>)/gi)) {
    const body = m[2] || '';
    const gstins = [...new Set((body.match(new RegExp(GSTIN_RE.source, 'g')) || []).map((g) => g.toUpperCase()))];
    out.push({ name: decodeXml(m[1]), gstins });
  }
  return out;
}
/** ALL of our registrations the loaded data belongs to (multi-GSTIN: one
 *  PAN, several state registrations). Settings accepts a comma-separated
 *  list; every loaded document also contributes its own registration. */
function expectedGstins() {
  const s = new Set();
  for (const g of String(state.settings.ownGstin || '').toUpperCase().split(/[\s,;]+/)) {
    if (GSTIN_RE.test(g)) s.add(g);
  }
  const f = String(state.fileGstin || '').trim().toUpperCase();
  if (f) s.add(f);
  for (const d of Object.values(state.docs || {})) {
    if (d && d.own) s.add(String(d.own).toUpperCase());
  }
  return [...s];
}
let cmpGuardCache = { at: 0, res: null };
async function companyGuard(force) {
  if (state.settings.companyGuard === false) return { ok: true, off: true };
  const now = Date.now();
  if (!force && cmpGuardCache.res && now - cmpGuardCache.at < 60000) return cmpGuardCache.res;
  let res = { ok: true };
  try {
    const companies = parseCompanies(await askTally(state.settings.tallyUrl, COMPANY_REQUEST()));
    res.companies = companies.map((c) => c.name + (c.gstins.length ? ' [' + c.gstins.join(', ') + ']' : ''));
    const wantName = String(state.settings.company || '').trim();
    let scope = companies;
    if (wantName && companies.length) {
      scope = companies.filter((c) => norm(c.name) === norm(wantName));
      if (!scope.length) {
        res = { ok: false, reason: '🛑 COMPANY GUARD: company "' + wantName + '" is NOT open in Tally. Open now: ' +
          companies.map((c) => c.name).join(', ') + '. Open the right company (or fix the name under Settings).' };
        cmpGuardCache = { at: now, res };
        return res;
      }
    }
    const exp = expectedGstins();
    if (exp.length && scope.length) {
      const gstins = [...new Set(scope.flatMap((c) => c.gstins))];
      const matched = exp.filter((g) => gstins.indexOf(g) >= 0);
      if (gstins.length && !matched.length) {
        res = { ok: false, reason: '🛑 COMPANY GUARD: the open Tally company (' + scope.map((c) => c.name).join(', ') +
          ' — GSTIN ' + gstins.join(', ') + ') does NOT belong to the loaded 2B data (GSTIN ' + exp.join(', ') +
          '). Nothing was written. Open the right company, or 🧹 Start fresh and load the right JSON.' };
      } else if (!gstins.length) {
        res.warn = 'Tally did not reveal the company GSTIN — set the exact Company name under Settings for full protection.';
      } else {
        res.match = matched.join(', ');
        res.company = scope.map((c) => c.name).join(', ');
        // Multi-GSTIN companies often expose only the principal registration —
        // matching ANY loaded registration is proof enough; just say so.
        if (matched.length < exp.length) {
          res.warn = 'Company verified via ' + matched.join(', ') + '; Tally did not list ' +
            exp.filter((g) => matched.indexOf(g) < 0).join(', ') + ' (normal for additional registrations of one company).';
        }
      }
    } else if (exp.length && !companies.length) {
      res.warn = 'Could not list the open companies — company guard limited on this Tally version.';
    }
  } catch (e) {
    res.warn = 'Company check unavailable: ' + String(e.message || e);
  }
  cmpGuardCache = { at: now, res };
  return res;
}

// ------------------------------ 🤖 self-worker --------------------------------
// Watches the configured folder for fresh GSTR-2B JSONs, reads them by itself,
// and reconciles automatically whenever there is new data (or every 6 hours),
// as long as Tally is open. Nothing to click — open the page and it is done.
function scanWatchFolder() {
  try {
    if (state.settings.selfWorker !== true) return;
    const dir = String(state.settings.watchFolder || '').trim();
    if (!dir || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!/gstr.?2b.*\.json$/i.test(f)) continue;
      let st;
      try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
      if (!st.isFile() || st.size > 30_000_000) continue;
      const sig = f + '|' + st.size + '|' + Math.round(st.mtimeMs);
      state.ingested = state.ingested || {};
      if (state.ingested[sig]) continue;
      try {
        const parsed = parseGstr2bServer(fs.readFileSync(path.join(dir, f), 'utf8'));
        // Comma-separated list supported — one PAN, several registrations.
        const ownList = String(state.settings.ownGstin || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
        if (ownList.length && parsed.gstin && ownList.indexOf(parsed.gstin.toUpperCase()) < 0) {
          state.ingested[sig] = { at: new Date().toISOString(), file: f, skipped: 'GSTIN ' + parsed.gstin + ' ≠ ' + ownList.join('/') };
          console.log('  🤖 skipped ' + f + ' — belongs to ' + parsed.gstin + ', not ' + ownList.join('/'));
          saveState();
          continue;
        }
        const m = mergeDocs(parsed.rows);
        if (parsed.gstin) state.fileGstin = String(parsed.gstin).toUpperCase();
        state.ingested[sig] = { at: new Date().toISOString(), file: f, period: parsed.returnPeriod, added: m.added + m.updated, count: parsed.rows.length };
        console.log('  🤖 auto-read ' + f + ' (' + parsed.returnPeriod + '): ' + m.added + ' new document(s)' + (m.updated ? ', ' + m.updated + ' updated' : ''));
      } catch (e) {
        state.ingested[sig] = { at: new Date().toISOString(), file: f, error: String(e.message || e) };
      }
      saveState();
    }
  } catch { /* folder unreadable — try again next tick */ }
}
async function autoRecoTick() {
  if (state.settings.selfWorker !== true || recoRunning || recoProgress.active) return;
  if (!Object.keys(state.docs || {}).length) return;
  const lastAt = state.reco && state.reco.at ? Date.parse(state.reco.at) : 0;
  if (!recoDirty && Date.now() - lastAt < 6 * 3600 * 1000) return;
  try {
    await fetch(state.settings.tallyUrl, { signal: AbortSignal.timeout(4000) });
  } catch { return; } // Tally closed — retry on a later tick
  console.log('  🤖 auto-reconcile starting (' + (recoDirty ? 'new data' : 'scheduled refresh') + ')…');
  try {
    await runServerReco();
    console.log('  🤖 auto-reconcile done: ' + (state.reco.summary ? state.reco.summary.matchedPct + '% matched' : 'ok'));
  } catch (e) {
    console.log('  🤖 auto-reconcile failed: ' + String(e.message || e));
  }
}
setInterval(scanWatchFolder, 20000);
setInterval(autoRecoTick, 60000);
setTimeout(scanWatchFolder, 3000);
setTimeout(autoRecoTick, 8000);

// --------------------------------- server -----------------------------------
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 30_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/data') {
      const ing = Object.values(state.ingested || {}).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      json(res, 200, {
        settings: state.settings,
        mappings: state.mappings,
        posted: state.posted,
        manualLog: state.manualLog,
        docs: Object.values(state.docs || {}),
        reco: state.reco,
        epoch: +state.epoch || 1,
        version: VERSION,
        autopilot: {
          on: state.settings.selfWorker === true,
          watchFolder: state.settings.watchFolder || '',
          dirty: recoDirty,
          lastRecoAt: state.reco ? state.reco.at : null,
          running: recoRunning || recoProgress.active,
          recent: ing.slice(0, 8),
        },
      });
      return;
    }

    // Merge-save settings and/or mappings from the UI.
    if (req.method === 'POST' && url.pathname === '/api/data') {
      const body = JSON.parse(await readBody(req));
      if (body.settings) state.settings = { ...state.settings, ...body.settings };
      if (body.mappings) state.mappings = { ...state.mappings, ...body.mappings };
      saveState();
      json(res, 200, { ok: true });
      return;
    }

    // Is Tally reachable?
    if (req.method === 'GET' && url.pathname === '/api/tally-check') {
      // While a reconcile is exporting the books, Tally's XML port is busy
      // and a status ping would time out — that is NOT "not reachable".
      if (recoRunning || recoProgress.active) {
        json(res, 200, { ok: true, busy: true, info: 'reconciling' });
        return;
      }
      try {
        const r = await fetch(state.settings.tallyUrl, { signal: AbortSignal.timeout(4000) });
        const t = await r.text();
        const guard = await companyGuard(true);
        json(res, 200, { ok: true, info: t.replace(/<[^>]+>/g, ' ').trim().slice(0, 120) || 'responding', guard });
      } catch (e) {
        json(res, 200, { ok: false, error: String(e.message || e) });
      }
      return;
    }

    // Ledger / voucher-type names straight from the open Tally company.
    // A TDL collection is used first (works on every TallyPrime; the
    // "List of Accounts" report export does not honour requests on some
    // setups), with the report export as fallback.
    if (req.method === 'GET' && (url.pathname === '/api/ledgers' || url.pathname === '/api/vouchertypes')) {
      const wantTypes = url.pathname === '/api/vouchertypes';
      const objType = wantTypes ? 'VoucherType' : 'Ledger';
      const collect =
        '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
        '<ID>G2bNames</ID></HEADER><BODY><DESC><STATICVARIABLES>' +
        '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' + svCompany() + '</STATICVARIABLES>' +
        '<TDL><TDLMESSAGE><COLLECTION NAME="G2bNames" ISMODIFY="No"><TYPE>' + objType + '</TYPE>' +
        '<NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
      const grabNames = (text) => {
        const names = new Set();
        const re = wantTypes ? /<VOUCHERTYPE NAME="([^"]*)"/gi : /<LEDGER NAME="([^"]*)"/gi;
        for (const m of text.matchAll(re)) if (m[1]) names.add(decodeXml(m[1]));
        return names;
      };
      try {
        const r = await fetch(state.settings.tallyUrl, {
          method: 'POST', body: collect, headers: { 'content-type': 'text/xml' }, signal: AbortSignal.timeout(20000),
        });
        let names = grabNames(await r.text());
        if (!names.size && !wantTypes) {
          const ask =
            '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA>' +
            '<REQUESTDESC><REPORTNAME>List of Accounts</REPORTNAME><STATICVARIABLES>' +
            '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><ACCOUNTTYPE>Ledgers</ACCOUNTTYPE>' +
            svCompany() + '</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>';
          const r2x = await fetch(state.settings.tallyUrl, {
            method: 'POST', body: ask, headers: { 'content-type': 'text/xml' }, signal: AbortSignal.timeout(20000),
          });
          names = grabNames(await r2x.text());
        }
        const list = [...names].sort((a, b) => a.localeCompare(b));
        json(res, 200, wantTypes ? { ok: true, types: list } : { ok: true, ledgers: list });
      } catch (e) {
        json(res, 200, { ok: false, error: String(e.message || e), ledgers: [], types: [] });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/reco-progress') {
      json(res, 200, recoProgress);
      return;
    }

    // Full three-pass reconciliation — SAME engine as the standalone
    // gstr2b-tally-recon tool. Reads the whole relevant books from Tally
    // (1 April of the FY before the earliest 2B period, through today).
    if (req.method === 'POST' && url.pathname === '/api/reconcile') {
      const body = JSON.parse(await readBody(req));
      // Merge the tab's documents ONLY when the tab saw the current epoch —
      // a tab open from before a Start-fresh / restart would otherwise
      // silently re-seed every cleared document here.
      if (Array.isArray(body.docs) && +body.epoch === (+state.epoch || 1)) mergeDocs(body.docs);
      try {
        if (recoRunning) {
          // The self-worker (or another tab) is already reconciling — attach
          // to that run and hand back its result instead of failing.
          const t0 = Date.now();
          while (recoRunning && Date.now() - t0 < 45 * 60000) await new Promise((r) => setTimeout(r, 1000));
          if (state.reco && state.reco.ok) { json(res, 200, state.reco); return; }
          json(res, 200, { ok: false, error: 'The running reconciliation did not finish — check that Tally stayed open and try again.' });
          return;
        }
        json(res, 200, await runServerReco());
      } catch (e) {
        json(res, 200, { ok: false, error: 'Could not reconcile — ' + String(e.message || e) });
      }
      return;
    }

    // Wipe loaded documents / results — the "Start fresh" button.
    if (req.method === 'POST' && url.pathname === '/api/clear') {
      state.docs = {};
      state.fileGstin = '';
      state.reco = null;
      state.ingested = {};
      state.epoch = (+state.epoch || 1) + 1;
      pruneCachedLocks();
      recoDirty = false;
      saveState();
      json(res, 200, { ok: true, epoch: state.epoch });
      return;
    }

    // Merge parsed GSTR-2B rows into the persistent store (browser uploads).
    if (req.method === 'POST' && url.pathname === '/api/docs') {
      const body = JSON.parse(await readBody(req));
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (body.gstin) { state.fileGstin = String(body.gstin).toUpperCase(); saveState(); }
      const m = mergeDocs(rows);
      json(res, 200, { ok: true, added: m.added, updated: m.updated, total: Object.keys(state.docs || {}).length });
      return;
    }

    // Pull existing vouchers from Tally for a date range so the UI can refuse
    // to pass entries that are already in the company (double-entry guard).
    if (req.method === 'POST' && url.pathname === '/api/tally-verify') {
      const body = JSON.parse(await readBody(req));
      const from = String(body.from || '').replace(/-/g, '');
      const to = String(body.to || '').replace(/-/g, '');
      if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
        json(res, 400, { error: 'bad date range' });
        return;
      }
      try {
        const ask =
          '<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA>' +
          '<REQUESTDESC><REPORTNAME>Day Book</REPORTNAME><STATICVARIABLES>' +
          '<SVFROMDATE>' + from + '</SVFROMDATE><SVTODATE>' + to + '</SVTODATE>' +
          '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
          svCompany() +
          '</STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>';
        const r = await fetch(state.settings.tallyUrl, {
          method: 'POST', body: ask, headers: { 'content-type': 'text/xml' }, signal: AbortSignal.timeout(60000),
        });
        const text = await r.text();
        json(res, 200, { ok: true, vouchers: parseVouchers(text) });
      } catch (e) {
        json(res, 200, { ok: false, error: String(e.message || e), vouchers: [] });
      }
      return;
    }

    // Keep a small history of manually entered vouchers.
    if (req.method === 'POST' && url.pathname === '/api/log') {
      const body = JSON.parse(await readBody(req));
      if (body.markDeleted) {
        for (const e of state.manualLog || []) if (e.remoteId === body.markDeleted) e.deleted = true;
        saveState();
        json(res, 200, { ok: true });
        return;
      }
      if (body.entry) {
        state.manualLog = state.manualLog || [];
        state.manualLog.unshift(body.entry);
        state.manualLog = state.manualLog.slice(0, 50);
        saveState();
      }
      json(res, 200, { ok: true });
      return;
    }

    // Forward one prepared XML envelope to Tally and interpret the reply.
    if (req.method === 'POST' && url.pathname === '/api/tally') {
      const body = JSON.parse(await readBody(req));
      try {
        const guard = await companyGuard(false);
        if (!guard.ok) { json(res, 200, { ok: false, error: guard.reason }); return; }
        const r = await fetch(state.settings.tallyUrl, {
          method: 'POST',
          body: String(body.xml || ''),
          headers: { 'content-type': 'text/xml' },
          signal: AbortSignal.timeout(30000),
        });
        const text = await r.text();
        const { created, altered, deleted, errors } = parseTallyReply(text);
        let ok = body.kind === 'delete'
          ? deleted > 0 && errors.length === 0
          : created + altered > 0 && errors.length === 0;
        let error = errors.join('; ').slice(0, 400);
        if (!ok && body.kind === 'master' && /already exists/i.test(error)) {
          ok = true;
          error = '';
        }
        if (!ok && !error && body.kind === 'delete') {
          error = 'Tally did not delete the voucher — it may already be deleted, or it was not created by this tool.';
        }
        if (!ok && !error) {
          // Show what Tally actually replied — makes "silent" failures debuggable.
          const said = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
          error = 'Tally gave no confirmation' + (said ? ' — it replied: "' + said + '"' : '') +
            '. Check: right company open in Tally, no dialog box waiting on screen' +
            (state.settings.company ? '' : ', and if several companies are open, set the company name in Settings');
        }
        json(res, 200, { ok, error });
      } catch (e) {
        json(res, 200, { ok: false, error: 'Tally not reachable at ' + state.settings.tallyUrl + ' — ' + String(e.message || e) });
      }
      return;
    }

    // Record documents as posted (duplicate protection across restarts).
    if (req.method === 'POST' && url.pathname === '/api/posted') {
      const body = JSON.parse(await readBody(req));
      for (const e of body.entries || []) {
        if (e && e.key) state.posted[e.key] = { at: new Date().toISOString(), ...e.meta };
      }
      saveState();
      json(res, 200, { ok: true, count: Object.keys(state.posted).length });
      return;
    }

    // Un-mark documents (e.g. XML downloaded but never imported).
    if (req.method === 'POST' && url.pathname === '/api/unposted') {
      const body = JSON.parse(await readBody(req));
      for (const k of body.keys || []) delete state.posted[k];
      saveState();
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

// --------------------------------- the UI -----------------------------------
// One page, no external assets. NOTE for maintainers: the in-browser script
// below deliberately avoids backticks and ${} (it lives inside this template
// literal) — use string concatenation only.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GSTR-2B → Tally poster v${VERSION}</title>
<style>
  :root { --bg:#f4f6f9; --card:#fff; --line:#e3e8ef; --text:#1c2733; --muted:#68788c;
          --brand:#155eef; --ok:#0e9f6e; --bad:#d92d20; --warn:#b54708; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width:1180px; margin:0 auto; padding:20px 16px 60px; }
  h1 { font-size:20px; margin:8px 0 2px; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 18px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:16px; }
  .card h2 { font-size:14.5px; margin:0 0 10px; }
  label { font-size:12px; color:var(--muted); display:block; margin-bottom:2px; }
  input[type=text] { width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:7px; font:inherit; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px 14px; }
  .btn { display:inline-block; padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:#fff;
         font:inherit; font-weight:600; cursor:pointer; }
  .btn:disabled { opacity:.45; cursor:default; }
  .btn.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
  .btn.danger { color:var(--bad); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { padding:7px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
  th { font-size:11.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  td.r,th.r { text-align:right; font-variant-numeric:tabular-nums; }
  .muted { color:var(--muted); font-size:12px; }
  .mono { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  .pill { display:inline-block; padding:2px 9px; border-radius:99px; font-size:11.5px; font-weight:600; }
  .pill.ok { background:#e6f6ef; color:var(--ok); } .pill.bad { background:#fdecea; color:var(--bad); }
  .pill.warn { background:#fdf3e7; color:var(--warn); } .pill.idle { background:#eef1f5; color:var(--muted); }
  .tag { display:inline-block; padding:1px 7px; border-radius:5px; font-size:10.5px; font-weight:700; letter-spacing:.02em; }
  .tag.inv { background:#e8f0fe; color:#155eef; } .tag.cn { background:#fdecea; color:#d92d20; }
  .tag.dn { background:#fdf3e7; color:#b54708; } .tag.amd { background:#f3e8fd; color:#7a2ea0; }
  .bar { position:sticky; top:0; z-index:5; background:var(--card); border:1px solid var(--line); border-radius:10px;
         padding:10px 14px; margin-bottom:16px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .flag { font-size:10.5px; font-weight:700; color:var(--warn); }
  .drop { border:2px dashed var(--line); border-radius:10px; padding:22px; text-align:center; color:var(--muted); }
  .drop.hot { border-color:var(--brand); color:var(--brand); }
  .phead { display:flex; justify-content:space-between; align-items:baseline; gap:10px; flex-wrap:wrap; margin:4px 0 8px; }
  .msg { font-size:13px; padding:7px 10px; border-radius:8px; margin:8px 0; }
  .msg.ok { background:#e6f6ef; color:var(--ok); } .msg.bad { background:#fdecea; color:var(--bad); }
  #tally-dot { width:9px; height:9px; border-radius:50%; display:inline-block; background:#c3ccd8; margin-right:5px; }
  #tally-dot.up { background:var(--ok); } #tally-dot.down { background:var(--bad); }
  details summary { cursor:pointer; font-weight:600; font-size:14.5px; }
  .tbl-scroll { overflow-x:auto; }
</style>
</head>
<body>
<div class="wrap">
  <h1>GSTR-2B → Tally poster <span class="muted" style="font-size:13px;font-weight:400">v${VERSION}</span></h1>
  <p class="sub">Everything runs on this computer only. Upload the portal's GSTR-2B JSON, review, tick, post to the open Tally company.
    <span style="white-space:nowrap"><span id="tally-dot"></span><span id="tally-status">checking Tally…</span></span></p>
  <div id="jarvis" class="muted" style="display:none;font-size:12px;margin:-12px 0 14px;line-height:1.7"></div>

  <div class="card"><details id="settings-box">
    <summary>Settings — Tally URL &amp; ledger names <span id="settings-hint" class="muted"></span></summary>
    <div class="grid" style="margin-top:12px">
      <div><label>Tally gateway URL</label><input type="text" id="s-tallyUrl"></div>
      <div><label>Company name (only if several companies are open in Tally)</label><input type="text" id="s-company" placeholder="exactly as shown in Tally"></div>
      <div><label>Purchase ledger *</label><input type="text" id="s-purchaseLedger" list="ledger-list"></div>
      <div><label>Input IGST ledger *</label><input type="text" id="s-igstLedger" list="ledger-list"></div>
      <div><label>Input CGST ledger *</label><input type="text" id="s-cgstLedger" list="ledger-list"></div>
      <div><label>Input SGST ledger *</label><input type="text" id="s-sgstLedger" list="ledger-list"></div>
      <div><label>Cess ledger (optional)</label><input type="text" id="s-cessLedger" list="ledger-list"></div>
      <div><label>Round-off ledger (optional)</label><input type="text" id="s-roundOffLedger" list="ledger-list"></div>
      <div><label>Matching tolerance ₹ (reconciliation)</label><input type="text" id="s-tolerance" placeholder="5"></div>
      <div><label>RCM payable IGST ledger</label><input type="text" id="s-rcmIgstLedger" list="ledger-list"></div>
      <div><label>RCM payable CGST ledger</label><input type="text" id="s-rcmCgstLedger" list="ledger-list"></div>
      <div><label>RCM payable SGST ledger</label><input type="text" id="s-rcmSgstLedger" list="ledger-list"></div>
      <div><label>🤖 Watch folder (auto-read new GSTR-2B JSONs from here)</label><input type="text" id="s-watchFolder"></div>
      <div><label>Your GSTIN(s) — comma-separate multiple registrations of one PAN</label><input type="text" id="s-ownGstin" placeholder="e.g. 09AMMPA3129Q1ZN, 27AMMPA3129Q1Z1"></div>
      <div style="align-self:end"><label style="display:inline"><input type="checkbox" id="s-selfWorker"> 🤖 Self-worker (auto-read + auto-reconcile) — off by default</label></div>
      <div style="align-self:end"><label style="display:inline"><input type="checkbox" id="s-freshStart"> 🧹 Start fresh on every launch (clear loaded documents)</label></div>
      <div style="align-self:end"><label style="display:inline"><input type="checkbox" id="s-companyGuard"> 🛡 Company guard — block posting when the open Tally company&apos;s GSTIN doesn&apos;t match the loaded data</label></div>
      <div style="align-self:end"><label style="display:inline"><input type="checkbox" id="s-billwise"> Bill-wise New Ref on supplier</label></div>
    </div>
    <p class="muted" style="margin:10px 0 6px">Ledger names must match the Tally company exactly, including capitals (Gateway → Chart of Accounts → Ledgers).</p>
    <button class="btn primary" onclick="saveSettings()">Save settings</button>
    <span id="settings-msg" class="muted"></span>
  </details></div>

  <div class="card"><details id="manual-box">
    <summary>Manual voucher entry — post any entry to Tally <span class="muted" id="ledger-count"></span></summary>
    <div class="grid" style="margin-top:12px">
      <div><label>Voucher type</label>
        <select id="m-type" onchange="typeChanged()" style="width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:7px;font:inherit">
          <option>Purchase</option><option>Payment</option><option>Receipt</option><option>Journal</option>
          <option>Contra</option><option>Sales</option><option>Debit Note</option><option>Credit Note</option>
          <option value="__custom">Custom…</option>
        </select>
        <input type="text" id="m-type-custom" placeholder="Voucher type name as in Tally" style="display:none;margin-top:6px">
      </div>
      <div><label>Date</label><input type="date" id="m-date" style="width:100%;padding:6px 9px;border:1px solid var(--line);border-radius:7px;font:inherit"></div>
      <div><label>Voucher no (optional — blank = Tally numbers it)</label><input type="text" id="m-no"></div>
      <div><label>Party ledger (pick from Tally list — used as the voucher party)</label><input type="text" id="m-party" list="ledger-list" placeholder="auto if left blank"></div>
      <div><label>Narration (optional)</label><input type="text" id="m-narr"></div>
    </div>
    <div class="tbl-scroll" style="margin-top:12px"><table id="m-lines"></table></div>
    <div style="margin-top:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn" onclick="addLine()">+ Add line</button>
      <span id="m-totals" class="muted"></span>
    </div>
    <div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn primary" id="m-post" onclick="postManual()">▶ Post voucher to Tally</button>
      <button class="btn" onclick="downloadManual()">⬇ XML</button>
      <button class="btn" onclick="loadLedgers(true)">↻ Refresh ledger list from Tally</button>
      <span id="m-msg"></span>
    </div>
    <div id="m-log" style="margin-top:10px"></div>
  </details></div>
  <datalist id="ledger-list"></datalist>

  <div class="card">
    <h2>Upload GSTR-2B JSON</h2>
    <div class="drop" id="drop">
      Drop one or MANY GSTR-2B .json files here at once, or
      <label style="display:inline;color:var(--brand);cursor:pointer;text-decoration:underline">browse<input type="file" id="file" accept=".json,application/json" multiple style="display:none"></label>
      (hold Ctrl to pick several). Documents accumulate below.
    </div>
    <div id="upload-msg"></div>
  </div>

  <div class="card" id="map-card" style="display:none"><details id="map-box">
    <summary style="cursor:pointer;font-weight:600;font-size:14.5px">Supplier → Tally ledger <span class="muted" id="map-count"></span></summary>
    <div class="tbl-scroll" style="margin-top:10px"><table id="map-table"></table></div>
  </details></div>

  <div class="bar" id="bar" style="display:none">
    <b><span id="sel-count">0</span> selected</b>
    <button class="btn primary" id="post-btn" onclick="postSelected()">▶ Post to Tally</button>
    <button class="btn" onclick="downloadXml()">⬇ Download XML instead</button>
    <button class="btn danger" onclick="unmarkSelected()" title="If a document shows Posted but was never actually imported into Tally">Un-mark posted</button>
    <button class="btn danger" onclick="deleteFromTally()" title="Deletes the selected vouchers OUT of Tally — only works for vouchers posted by this tool">🗑 Delete from Tally</button>
    <button class="btn" onclick="startFresh()" title="Clears every loaded document and reconciliation result — upload again to start over. Mappings, settings and the posted register are kept.">🧹 Start fresh</button>
    <button class="btn" id="reco-btn" onclick="runReco()" title="Compare every document below against what is actually booked in Tally">🔁 Reconcile with Tally</button>
    <button class="btn" id="reco-select" onclick="selectNotBooked()" style="display:none">☑ Select not booked</button>
    <input type="text" id="filter" list="party-list" placeholder="🔍 Filter — party / GSTIN / invoice no"
      oninput="setFilter(this.value)" style="min-width:250px;padding:7px 10px;border:1px solid var(--line);border-radius:7px;font:inherit">
    <span id="filter-count" class="muted"></span>
    <span id="bar-msg" class="muted"></span>
    <div id="bucket-chips" style="flex-basis:100%;display:flex;gap:6px;flex-wrap:wrap"></div>
  </div>
  <datalist id="party-list"></datalist>

  <div class="card card-pad" id="post-panel" style="display:none;margin-bottom:14px;padding:12px 16px"></div>

  <div class="card" id="reco-progress" style="display:none;padding:12px 16px;margin-bottom:14px">
    <div id="reco-ptext" style="font-size:12.5px;margin-bottom:7px"><b>Reconciling…</b> starting</div>
    <div style="height:10px;background:var(--line);border-radius:99px;overflow:hidden">
      <div id="reco-fill" style="height:100%;width:0%;background:var(--brand);transition:width .5s"></div>
    </div>
  </div>

  <p class="muted" id="legend" style="display:none;font-size:12px;margin:-4px 2px 12px;line-height:2">
    <span class="tag inv">INVOICE</span> supplier's bill → posts as a <b>Purchase</b> voucher &nbsp;·&nbsp;
    <span class="tag cn">CREDIT NOTE</span> supplier reduced your bill → posts as a <b>Debit Note</b> (payable goes down) &nbsp;·&nbsp;
    <span class="tag dn">DEBIT NOTE</span> supplier charged extra → posts as a <b>Purchase</b> &nbsp;·&nbsp;
    <span class="tag amd">AMENDED</span> revised on the portal — shown for review, never auto-posted (adjust the original entry in Tally) &nbsp;·&nbsp;
    <b>RCM</b> reverse charge &nbsp;·&nbsp; <b>ITC N/A</b> input credit not available
  </p>

  <div id="reco-summary"></div>
  <div id="rcm-card"></div>
  <div id="docs"></div>
</div>

<script>
'use strict';
// ------------------------------ shared state ------------------------------
var settings = {}, mappings = {}, postedReg = {};
var docs = [];        // flattened parsed rows (all uploads this session)
var ownGstin = '';    // the client's GSTIN as per the uploaded 2B file
var selected = {};    // key -> true
var live = {};        // key -> {status:'posting'|'ok'|'fail', error}

function key(d) { return d.gstin + '|' + d.type + '|' + d.no + (d.amended ? '|A' : ''); }
function normKey(s) { return String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, ''); }
function shiftDate(iso, days) {
  var d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
// Ask Tally for everything on its books in a window and index it for
// duplicate checks: number+party, number alone, and party+amount+date.
async function tallyIndex(fromIso, toIso) {
  var j = await fetch('/api/tally-verify', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ from: fromIso, to: toIso }) }).then(function (r) { return r.json(); });
  if (!j.ok) return { ok: false, error: j.error || 'Tally did not answer' };
  var numParty = {}, numAny = {}, pad = {};
  (j.vouchers || []).forEach(function (v) {
    var n = normKey(v.number), rf = normKey(v.reference), p = normKey(v.party);
    var a = (v.amount || 0).toFixed(2);
    if (n) { numAny[n] = true; if (p) numParty[n + '|' + p] = true; }
    if (rf) { numAny[rf] = true; if (p) numParty[rf + '|' + p] = true; }
    if (p) pad[p + '|' + a + '|' + v.date] = true;
  });
  return { ok: true, numParty: numParty, numAny: numAny, pad: pad, count: (j.vouchers || []).length };
}
// Taxable figure a voucher would use: normally the item-wise taxable value,
// but when a document carries no breakup at all, fall back to the invoice
// value (exempt/nil-rated purchase — books as purchase + party only).
function taxableOf(d) {
  if (r2(d.txval + d.igst + d.cgst + d.sgst + d.cess) > 0) return d.txval;
  return d.val;
}
// The party-side value this 2B document would post with (mirrors voucherXml).
function partyAmountOf(d) {
  // Reverse charge: the supplier is owed only the taxable value — the tax is
  // payable to the government (RCM liability journal), never to the party.
  if (d.rcm) return r2(taxableOf(d));
  var base = r2(taxableOf(d) + d.igst + d.cgst + d.sgst + (settings.cessLedger ? d.cess : 0));
  var diff = r2(d.val - base);
  if (settings.roundOffLedger && diff !== 0 && Math.abs(diff) <= 1) return d.val;
  return base;
}
function inr(n) { return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function escAttr(s) { return esc(s); }

// ------------------------------ boot ------------------------------
fetch('/api/data').then(function (r) { return r.json(); }).then(function (d) {
  // A stale cached page must never talk to a newer server — reload fresh.
  if (d.version && d.version !== '${VERSION}') { location.replace('/?v=' + encodeURIComponent(d.version)); return; }
  settings = d.settings; mappings = d.mappings; postedReg = d.posted;
  srvEpoch = d.epoch || 1;
  var ids = ['tallyUrl','company','purchaseLedger','igstLedger','cgstLedger','sgstLedger','cessLedger','roundOffLedger','tolerance','rcmIgstLedger','rcmCgstLedger','rcmSgstLedger','watchFolder','ownGstin'];
  ids.forEach(function (k) { document.getElementById('s-' + k).value = settings[k] || ''; });
  // Self-heal: a required ledger name that is blank (older data file / bad
  // save) blocks every post — restore the default and persist it.
  var healed = false;
  var REQ = { purchaseLedger: 'Purchase', igstLedger: 'Input IGST', cgstLedger: 'Input CGST', sgstLedger: 'Input SGST' };
  Object.keys(REQ).forEach(function (k) {
    if (!String(settings[k] || '').trim()) { settings[k] = REQ[k]; document.getElementById('s-' + k).value = REQ[k]; healed = true; }
  });
  if (healed) {
    fetch('/api/data', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ settings: settings }) });
    document.getElementById('settings-msg').textContent = '⚠ Some ledger names were blank and have been reset to defaults — check they match your Tally.';
    document.getElementById('settings-box').open = true;
  }
  document.getElementById('s-billwise').checked = !!settings.billwise;
  document.getElementById('s-selfWorker').checked = settings.selfWorker === true;
  document.getElementById('s-freshStart').checked = settings.freshStart !== false;
  document.getElementById('s-companyGuard').checked = settings.companyGuard !== false;
  document.getElementById('settings-hint').textContent = '(purchase: ' + (settings.purchaseLedger || '—') + ')';
  docs = d.docs || [];
  docs.forEach(function (r) { if (!r.key) r.key = key(r); });
  if (docs.length && docs[0].gstin) { /* own GSTIN unknown from rows; kept from uploads */ }
  manualLog = d.manualLog || [];
  renderManualLog();
  document.getElementById('m-date').value = new Date().toISOString().slice(0, 10);
  mlines = [blankLine(), blankLine()];
  renderLines();
  loadLedgers(false);
  loadVchTypes();
  checkTally();
  render();
  if (d.reco && d.reco.ok) {
    applyReco(d.reco);
    document.getElementById('bar-msg').textContent =
      'Showing the reconciliation from ' + new Date(d.reco.at).toLocaleString('en-IN') + ' — 🔁 Reconcile to refresh.';
  }
  updateJarvis(d.autopilot);
  if (d.autopilot && d.autopilot.running) ensureProgressWatcher();
  setInterval(autoPoll, 25000);
});

// ---------------------- 🤖 self-worker sync (browser) ----------------------
function updateJarvis(a) {
  var el = document.getElementById('jarvis');
  if (!a) { el.style.display = 'none'; return; }
  el.style.display = '';
  var t = '🤖 <b>Self-worker ' + (a.on ? 'ON' : 'off — switch on under Settings if wanted') + '</b>';
  if (a.on) t += ' — watching <span class="mono">' + esc(a.watchFolder || '—') + '</span> for new GSTR-2B files';
  t += ' · last reconcile: <b>' + (a.lastRecoAt ? new Date(a.lastRecoAt).toLocaleString('en-IN') : 'never') + '</b>';
  if (a.running) t += ' · <b style="color:var(--brand)">reconciling now…</b>';
  else if (a.dirty) t += ' · <b style="color:var(--warn)">new data waiting — will auto-reconcile when Tally is open</b>';
  var okFiles = (a.recent || []).filter(function (f) { return !f.error; });
  if (okFiles.length) t += ' · auto-read: ' + okFiles.slice(0, 3).map(function (f) { return esc(f.file); }).join(', ');
  el.innerHTML = t;
}
var lastRecoAt = null;
var srvEpoch = null; // server's clear-generation — guards stale tabs from re-seeding cleared docs
var polling = false;
var progWatch = null;
var progT0 = 0;
function paintProgress(p) {
  var secs = Math.round((Date.now() - progT0) / 1000);
  var pct = 2, txt = 'starting…';
  if (p.phase === 'reading' && p.monthsTotal) {
    pct = Math.max(2, Math.round((p.monthsDone / p.monthsTotal) * 90));
    txt = 'reading the Tally books (' + p.mode + '): month <b>' + p.monthsDone + ' of ' + p.monthsTotal + '</b> · ' +
      p.vouchers.toLocaleString('en-IN') + ' purchase-side vouchers found · ' + secs + 's';
  } else if (p.phase === 'masters') {
    pct = 92;
    txt = 'reading ledger masters (GSTINs)… · ' + secs + 's';
  } else if (p.phase === 'matching') {
    pct = 96;
    txt = 'matching every document (3 passes)… · ' + secs + 's';
  }
  document.getElementById('reco-fill').style.width = pct + '%';
  document.getElementById('reco-ptext').innerHTML = '<b>Reconciling…</b> ' + txt;
}
function ensureProgressWatcher() {
  if (progWatch) return;
  progT0 = Date.now();
  var prog = document.getElementById('reco-progress');
  prog.style.display = '';
  document.getElementById('reco-fill').style.width = '2%';
  document.getElementById('reco-ptext').innerHTML = '<b>Reconciling…</b> contacting Tally';
  progWatch = setInterval(function () {
    fetch('/api/reco-progress').then(function (r) { return r.json(); }).then(function (p) {
      if (!p.active) {
        clearInterval(progWatch);
        progWatch = null;
        prog.style.display = 'none';
        autoPoll();
        checkTally();
        return;
      }
      paintProgress(p);
    }).catch(function () {});
  }, 800);
}
async function autoPoll() {
  if (polling) return;
  polling = true;
  try {
    var d = await fetch('/api/data').then(function (r) { return r.json(); });
    updateJarvis(d.autopilot);
    if (d.autopilot && d.autopilot.running) ensureProgressWatcher();
    var docsChanged = (d.docs || []).length !== docs.length;
    // Server cleared / restarted since this tab loaded — take ITS documents
    // as the truth (never keep showing rows the server no longer has).
    if (d.epoch && d.epoch !== srvEpoch) { srvEpoch = d.epoch; docsChanged = true; }
    var recoChanged = d.reco && d.reco.ok && d.reco.at !== lastRecoAt;
    if (docsChanged) {
      docs = d.docs || [];
      docs.forEach(function (r) { if (!r.key) r.key = key(r); });
    }
    if (recoChanged || docsChanged) {
      postedReg = d.posted || {};
      mappings = d.mappings || mappings;
      manualLog = d.manualLog || manualLog;
      render();
      renderManualLog();
    }
    if (recoChanged) {
      applyReco(d.reco);
      document.getElementById('bar-msg').textContent = '🤖 Auto-reconciled at ' + new Date(d.reco.at).toLocaleTimeString('en-IN') + '.';
    }
  } catch (e) { /* server briefly busy */ }
  polling = false;
}
function applyReco(j) {
  lastRecoAt = j.at || null;
  reco = { byKey: {}, raw: j, booksOnly: j.booksOnly || [], duplicates: j.duplicates || [],
    opinions: j.opinions || [], summary: j.summary || {} };
  var c = { booked: 0, probable: 0, mismatch: 0, notbooked: 0 };
  (j.docs || []).forEach(function (r) {
    var st = r.status === 'matched' || r.status === 'grouped' ? 'booked'
      : r.status === 'probable' ? 'probable'
      : r.status === 'mismatch' ? 'mismatch' : 'notbooked';
    // A portal revision whose ORIGINAL is matched in the books is not "not
    // booked" — file it under the Amended chip with the pointer note.
    if (r.amendedOfMatched) st = 'amended';
    c[st] = (c[st] || 0) + 1;
    reco.byKey[r.key] = { st: st, note: r.note || '', gap: r.readGap || null, wrongReg: r.wrongReg || null, bookRef: r.bookRef, tallyAmt: r.bookAmount, headSwap: r.headSwap,
      bookAmount: r.bookAmount, bookTaxable: r.bookTaxable, bookIgst: r.bookIgst, bookCgst: r.bookCgst,
      bookSgst: r.bookSgst, bookGstComb: r.bookGstComb, bookTds: r.bookTds, bookTax: r.bookTax };
  });
  document.getElementById('reco-select').style.display = c.notbooked ? '' : 'none';
  renderRecoSummary(c);
  renderRcm();
  renderDocs();
  return c;
}

var tallyRetryT = null;
function checkTally() {
  fetch('/api/tally-check').then(function (r) { return r.json(); }).then(function (j) {
    var dot = document.getElementById('tally-dot');
    var stEl = document.getElementById('tally-status');
    var again = function (ms) { if (tallyRetryT) clearTimeout(tallyRetryT); tallyRetryT = setTimeout(checkTally, ms); };
    if (j.busy) {
      dot.className = 'up';
      stEl.innerHTML = 'Tally connected — <b>busy reading the books (reconciliation in progress)…</b>';
      again(15000);
      return;
    }
    if (!j.ok) {
      dot.className = 'down';
      stEl.innerHTML = 'Tally not reachable — open Tally Prime with the company loaded <span class="muted">(rechecking every 20s…)</span>';
      again(20000);
      return;
    }
    var g = j.guard || {};
    if (g.ok === false) {
      dot.className = 'down';
      stEl.innerHTML = '<b style="color:var(--bad)">' + esc(g.reason || 'Wrong company open in Tally') + '</b>';
    } else if (g.match) {
      dot.className = 'up';
      stEl.innerHTML = 'Tally connected — <b>' + esc(g.company || 'company') + '</b> · GSTIN matches the loaded data ✓';
    } else {
      dot.className = 'up';
      stEl.innerHTML = 'Tally connected' + (g.warn ? ' · <span style="color:var(--warn)">⚠ ' + esc(g.warn) + '</span>' : '');
    }
  });
}
setInterval(checkTally, 30000);

function saveSettings() {
  var ids = ['tallyUrl','company','purchaseLedger','igstLedger','cgstLedger','sgstLedger','cessLedger','roundOffLedger','tolerance','rcmIgstLedger','rcmCgstLedger','rcmSgstLedger','watchFolder','ownGstin'];
  var next = {};
  ids.forEach(function (k) { next[k] = document.getElementById('s-' + k).value.trim(); });
  next.billwise = document.getElementById('s-billwise').checked;
  next.selfWorker = document.getElementById('s-selfWorker').checked;
  next.freshStart = document.getElementById('s-freshStart').checked;
  next.companyGuard = document.getElementById('s-companyGuard').checked;
  if (!next.purchaseLedger || !next.igstLedger || !next.cgstLedger || !next.sgstLedger) {
    document.getElementById('settings-msg').textContent = '✖ NOT saved — Purchase, IGST, CGST and SGST ledger names are all required.';
    return;
  }
  ids.forEach(function (k) { settings[k] = next[k]; });
  settings.billwise = next.billwise;
  settings.selfWorker = next.selfWorker;
  settings.freshStart = next.freshStart;
  settings.companyGuard = next.companyGuard;
  fetch('/api/data', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ settings: settings }) })
    .then(function () {
      document.getElementById('settings-msg').textContent = '✓ saved';
      document.getElementById('settings-hint').textContent = '(purchase: ' + settings.purchaseLedger + ')';
      checkTally();
    });
}

// ------------------------------ GSTR-2B parsing ------------------------------
// Amounts can arrive as numbers or as "1,18,000.00" strings depending on how
// the file was produced — strip formatting before converting.
function num(v) { var n = Number(String(v === undefined || v === null ? '' : v).replace(/[₹,\\s]/g, '')); return isFinite(n) ? n : 0; }
function r2(n) { return Math.round(n * 100) / 100; }
function firstNum(o, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (o[keys[i]] !== undefined && o[keys[i]] !== null && o[keys[i]] !== '') return num(o[keys[i]]);
  }
  return 0;
}
// Item-wise totals, then document-level fallbacks: some 2B exports carry the
// taxes on the document itself (igst/iamt/...) rather than inside items.
function docTotals(doc) {
  var t = sumItems(doc.items || doc.itms);
  if (t.igst + t.cgst + t.sgst + t.cess === 0) {
    t.igst = firstNum(doc, ['igst', 'iamt']);
    t.cgst = firstNum(doc, ['cgst', 'camt']);
    t.sgst = firstNum(doc, ['sgst', 'samt']);
    t.cess = t.cess || firstNum(doc, ['cess', 'csamt']);
  }
  if (!t.txval) t.txval = firstNum(doc, ['txval', 'taxval', 'txblval']);
  Object.keys(t).forEach(function (k) { t[k] = r2(t[k]); });
  return t;
}
function sumItems(items) {
  var t = { txval:0, igst:0, cgst:0, sgst:0, cess:0 };
  (items || []).forEach(function (it) {
    // GSTR-2B uses txval/igst/cgst/sgst/cess directly on the item; some
    // exports nest them under itm_det and/or use 2A-style iamt/camt/samt.
    var d = it && it.itm_det ? it.itm_det : (it || {});
    t.txval += firstNum(d, ['txval', 'taxval', 'txblval']);
    t.igst += firstNum(d, ['igst', 'iamt']);
    t.cgst += firstNum(d, ['cgst', 'camt']);
    t.sgst += firstNum(d, ['sgst', 'samt']);
    t.cess += firstNum(d, ['cess', 'csamt', 'cs']);
  });
  Object.keys(t).forEach(function (k) { t[k] = r2(t[k]); });
  return t;
}
function periodLabel(p) {
  var m = /^(\\d{2})(\\d{4})$/.exec(p || '');
  if (!m) return p || '—';
  var mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[1] - 1];
  return (mo || m[1]) + ' ' + m[2];
}
function parse2b(text) {
  var root = JSON.parse(text);
  var data = root.data || root;
  var dd = data.docdata || data.docData;
  if (!dd) throw new Error('No GSTR-2B document data in this file (expected data.docdata).');
  var period = String(data.rtnprd || data.ret_period || '');
  var rows = [], skipped = [];
  (dd.b2b || []).forEach(function (sup) {
    var gstin = String(sup.ctin || '').toUpperCase();
    var name = String(sup.trdnm || gstin);
    (sup.inv || []).forEach(function (inv) {
      var dm = /^(\\d{2})-(\\d{2})-(\\d{4})$/.exec(String(inv.dt || ''));
      if (!gstin || !inv.inum || !dm) return;
      var t = docTotals(inv);
      rows.push({ period: period, type: 'invoice', gstin: gstin, name: name, no: String(inv.inum),
        date: dm[3] + '-' + dm[2] + '-' + dm[1], val: r2(num(inv.val)), rcm: inv.rev === 'Y', itc: inv.itcavl !== 'N',
        txval: t.txval, igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: t.cess });
    });
  });
  (dd.cdnr || []).forEach(function (sup) {
    var gstin = String(sup.ctin || '').toUpperCase();
    var name = String(sup.trdnm || gstin);
    (sup.nt || []).forEach(function (nt) {
      var dm = /^(\\d{2})-(\\d{2})-(\\d{4})$/.exec(String(nt.dt || ''));
      var no = String(nt.ntnum || nt.nt_num || '');
      if (!gstin || !no || !dm) return;
      var t = docTotals(nt);
      rows.push({ period: period, type: nt.typ === 'C' ? 'creditnote' : 'debitnote', gstin: gstin, name: name, no: no,
        date: dm[3] + '-' + dm[2] + '-' + dm[1], val: r2(num(nt.val)), rcm: nt.rev === 'Y', itc: nt.itcavl !== 'N',
        txval: t.txval, igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: t.cess });
    });
  });
  // Amended documents: shown so nothing is invisible, but never auto-posted —
  // a revision must be adjusted against the original entry in Tally.
  (dd.b2ba || []).forEach(function (sup) {
    var gstin = String(sup.ctin || '').toUpperCase();
    var name = String(sup.trdnm || gstin);
    (sup.inv || []).forEach(function (inv) {
      var dm = /^(\\d{2})-(\\d{2})-(\\d{4})$/.exec(String(inv.dt || ''));
      if (!gstin || !inv.inum || !dm) return;
      var t = docTotals(inv);
      rows.push({ period: period, type: 'invoice', gstin: gstin, name: name, no: String(inv.inum),
        date: dm[3] + '-' + dm[2] + '-' + dm[1], val: r2(num(inv.val)), rcm: inv.rev === 'Y', itc: inv.itcavl !== 'N',
        amended: true, orig: String(inv.oinum || ''),
        txval: t.txval, igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: t.cess });
    });
  });
  (dd.cdnra || []).forEach(function (sup) {
    var gstin = String(sup.ctin || '').toUpperCase();
    var name = String(sup.trdnm || gstin);
    (sup.nt || []).forEach(function (nt) {
      var dm = /^(\\d{2})-(\\d{2})-(\\d{4})$/.exec(String(nt.dt || ''));
      var no = String(nt.ntnum || nt.nt_num || '');
      if (!gstin || !no || !dm) return;
      var t = docTotals(nt);
      rows.push({ period: period, type: nt.typ === 'C' ? 'creditnote' : 'debitnote', gstin: gstin, name: name, no: no,
        date: dm[3] + '-' + dm[2] + '-' + dm[1], val: r2(num(nt.val)), rcm: nt.rev === 'Y', itc: nt.itcavl !== 'N',
        amended: true, orig: String(nt.ontnum || ''),
        txval: t.txval, igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: t.cess });
    });
  });
  var labels = { isd:'ISD credits', isda:'amended ISD credits', impg:'import of goods (IMPG)', impgsez:'imports from SEZ' };
  Object.keys(labels).forEach(function (k) { if (Array.isArray(dd[k]) && dd[k].length) skipped.push(labels[k]); });
  return { gstin: String(data.gstin || ''), period: period, rows: rows, skipped: skipped };
}

// ------------------------------ upload ------------------------------
var drop = document.getElementById('drop');
drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('hot'); });
drop.addEventListener('dragleave', function () { drop.classList.remove('hot'); });
drop.addEventListener('drop', function (e) {
  e.preventDefault(); drop.classList.remove('hot');
  if (e.dataTransfer.files.length) readFiles(e.dataTransfer.files);
});
document.getElementById('file').addEventListener('change', function (e) {
  if (e.target.files.length) readFiles(e.target.files);
  e.target.value = '';
});
function readOne(f) {
  return new Promise(function (resolve) {
    var rd = new FileReader();
    rd.onload = async function () {
      try {
        var p = parse2b(rd.result);
        if (p.gstin) ownGstin = p.gstin;
        // ALL rows go to the server — a row whose key already exists may
        // carry corrected figures (re-downloaded 2B), and only the server
        // can tell; locally the newer copy replaces the older one too.
        var at = {};
        docs.forEach(function (d, i) { at[key(d)] = i; });
        var freshN = 0;
        p.rows.forEach(function (d) {
          // which of OUR registrations this file belongs to (multi-GSTIN)
          if (p.gstin) d.own = p.gstin.toUpperCase();
          d.key = key(d);
          if (at[d.key] != null) { docs[at[d.key]] = d; }
          else { at[d.key] = docs.length; docs.push(d); freshN++; }
        });
        var srv = null;
        if (p.rows.length || p.gstin) {
          try {
            srv = await fetch('/api/docs', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ rows: p.rows, gstin: p.gstin || '' }) }).then(function (r) { return r.json(); });
          } catch (e) { /* server briefly busy — local copy is loaded */ }
        }
        var loaded = srv && srv.added != null ? srv.added : freshN;
        var updated = (srv && srv.updated) || 0;
        var already = Math.max(0, p.rows.length - loaded - updated);
        resolve('✓ ' + esc(f.name) + ' — ' + periodLabel(p.period) + ': ' + loaded + ' loaded' +
          (updated ? ', ' + updated + ' UPDATED (figures changed — reconcile again)' : '') +
          (already ? ', ' + already + ' already present' : '') +
          (p.skipped.length ? ' (not imported: ' + p.skipped.join(', ') + ')' : ''));
      } catch (err) {
        resolve('✖ ' + esc(f.name) + ' — ' + esc(err.message || 'could not read'));
      }
    };
    rd.onerror = function () { resolve('✖ ' + esc(f.name) + ' — read error'); };
    rd.readAsText(f);
  });
}
async function readFiles(fileList) {
  var files = [].slice.call(fileList);
  var box = document.getElementById('upload-msg');
  box.innerHTML = '<div class="msg ok">Reading ' + files.length + ' file(s)…</div>';
  var lines = [];
  for (var i = 0; i < files.length; i++) lines.push(await readOne(files[i]));
  box.innerHTML = '<div class="msg ok" style="line-height:1.8">' + lines.join('<br>') + '</div>';
  render();
}

// ------------------------------ mapping table ------------------------------
function renderMappings() {
  var gstins = {};
  docs.forEach(function (d) { if (!gstins[d.gstin]) gstins[d.gstin] = d.name; });
  var keys = Object.keys(gstins).sort();
  var card = document.getElementById('map-card');
  if (!keys.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  var newOnes = keys.filter(function (g) { return !mappings[g]; }).length;
  document.getElementById('map-count').textContent =
    '(' + keys.length + ' suppliers, saved for next time' + (newOnes ? ', ' + newOnes + ' NEW — open to map' : '') + ')';
  if (newOnes) document.getElementById('map-box').open = true;
  var h = '<tr><th>Supplier (from portal)</th><th>GSTIN</th><th style="width:26%">Party ledger in Tally</th><th style="width:24%">Purchase/expense ledger 🧠</th><th>Create in Tally?</th></tr>';
  keys.forEach(function (g) {
    var m = mappings[g] || { ledger: gstins[g], autoCreate: true };
    h += '<tr><td>' + esc(gstins[g]) + '</td><td class="mono">' + esc(g) + '</td>' +
      '<td><input type="text" list="ledger-list" value="' + escAttr(m.ledger || '') + '" data-g="' + escAttr(g) + '" onchange="setMap(this.dataset.g, this.value, null)"></td>' +
      '<td><input type="text" list="ledger-list" value="' + escAttr(m.purchaseLedger || '') + '" placeholder="' + escAttr(settings.purchaseLedger || 'default') + '" data-g="' + escAttr(g) + '" onchange="setMapPurchase(this.dataset.g, this.value)">' +
        (m.purchaseLedgerLearned && !m.purchaseLedgerManual ? '<div class="muted" style="font-size:11">🧠 learned from this party&apos;s past entries</div>' : '') + '</td>' +
      '<td><label><input type="checkbox"' + (m.autoCreate ? ' checked' : '') + ' data-g="' + escAttr(g) + '" onchange="setMap(this.dataset.g, null, this.checked)"> create if missing</label></td></tr>';
  });
  document.getElementById('map-table').innerHTML = h;
  // Persist defaults for newly seen suppliers so they survive a restart.
  var dirty = false;
  keys.forEach(function (g) { if (!mappings[g]) { mappings[g] = { ledger: gstins[g], autoCreate: true }; dirty = true; } });
  if (dirty) pushMappings();
}
function setMap(gstin, ledger, autoCreate) {
  var m = mappings[gstin] || { ledger: '', autoCreate: true };
  if (ledger !== null && ledger !== undefined) m.ledger = ledger.trim();
  if (autoCreate !== null && autoCreate !== undefined) m.autoCreate = autoCreate;
  mappings[gstin] = m;
  pushMappings();
  renderDocs();
}
function setMapPurchase(gstin, ledger) {
  var m = mappings[gstin] || { ledger: '', autoCreate: true };
  m.purchaseLedger = String(ledger || '').trim();
  m.purchaseLedgerManual = !!m.purchaseLedger; // a manual choice sticks; blank = back to auto-learn
  if (!m.purchaseLedger) { delete m.purchaseLedger; delete m.purchaseLedgerManual; delete m.purchaseLedgerLearned; }
  mappings[gstin] = m;
  pushMappings();
  renderDocs();
}
function pushMappings() {
  fetch('/api/data', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ mappings: mappings }) });
}

// ------------------------------ docs table ------------------------------
var filterText = '';
var bucketFilter = 'all';
var groupMode = 'month'; // 'month' | 'party'
var regFilter = ''; // multi-GSTIN: '' = all registrations, else one own GSTIN
function setGroupMode(m) { groupMode = m; renderDocs(); }
function setRegFilter(g) { regFilter = g; renderDocs(); }
function ownList() {
  var s = {};
  docs.forEach(function (d) { if (d.own) s[d.own] = 1; });
  return Object.keys(s).sort();
}
function toggleGroup(kind, val, on) {
  docs.forEach(function (d) {
    if (!matchesFilter(d)) return;
    if (kind === 'party' ? d.gstin !== val : d.period !== val) return;
    if (on) selected[key(d)] = true; else delete selected[key(d)];
  });
  renderDocs();
}
function setFilter(v) { filterText = v.trim().toLowerCase(); renderDocs(); }
function setBucket(b) { bucketFilter = b; renderDocs(); }
// Which review bucket a row belongs to — drives the chips and the filter.
function rowBucket(d) {
  var k = key(d);
  var st = statusOf(d);
  if (st.status === 'posted') return st.via === 'found-in-tally' ? 'booked' : 'posted';
  if (st.status === 'ok') return 'posted';
  if (st.status === 'dup') return 'booked';
  if (st.status === 'fail') return 'rejected';
  var rc = reco && reco.byKey[k];
  if (rc) return rc.st === 'booked' ? 'booked' : rc.st; // notbooked | probable | mismatch
  if (d.amended) return 'amended';
  return 'pending';
}
var BUCKETS = [
  ['all', 'All'], ['notbooked', 'Not booked'], ['probable', 'Probable'], ['mismatch', 'Mismatch'],
  ['booked', 'In Tally'], ['posted', 'Posted by me'], ['rejected', 'Rejected'], ['amended', 'Amended'], ['pending', 'Pending'],
];
function renderChips() {
  var host = document.getElementById('bucket-chips');
  if (!docs.length) { host.innerHTML = ''; return; }
  // Bucket counts respect the registration filter — one state at a time.
  if (regFilter && !docs.some(function (d) { return d.own === regFilter; })) regFilter = '';
  var inReg = docs.filter(function (d) { return !regFilter || d.own === regFilter; });
  var counts = { all: inReg.length };
  inReg.forEach(function (d) { var b = rowBucket(d); counts[b] = (counts[b] || 0) + 1; });
  if (bucketFilter !== 'all' && !counts[bucketFilter]) bucketFilter = 'all';
  var h = '';
  // 🏷 Registration chips (multi-GSTIN books): view one state at a time —
  // the whole page (lists, counts, select-all, posting) follows this filter.
  var owns = ownList();
  if (owns.length > 1) {
    h += '<span class="muted" style="align-self:center">registration:</span>' +
      '<button type="button" class="btn' + (regFilter === '' ? ' primary' : '') + '" style="padding:3px 11px;font-size:12px" onclick="setRegFilter(\\'\\')">All (' + docs.length + ')</button>';
    owns.forEach(function (g) {
      var n = 0;
      docs.forEach(function (d) { if (d.own === g) n++; });
      h += '<button type="button" class="btn' + (regFilter === g ? ' primary' : '') + '" style="padding:3px 11px;font-size:12px" data-g="' + escAttr(g) + '" onclick="setRegFilter(this.dataset.g)">' +
        esc(g) + ' (' + n + ')</button>';
    });
    h += '<span style="flex-basis:100%;height:0"></span>';
  }
  BUCKETS.forEach(function (bl) {
    var b = bl[0], label = bl[1];
    if (b !== 'all' && !counts[b]) return;
    var on = bucketFilter === b;
    h += '<button type="button" class="btn' + (on ? ' primary' : '') + '" style="padding:3px 11px;font-size:12px" onclick="setBucket(\\'' + b + '\\')">' +
      label + ' (' + (counts[b] || 0) + ')</button>';
  });
  h += '<span class="muted" style="margin-left:auto;align-self:center">view:</span>' +
    '<button type="button" class="btn' + (groupMode === 'month' ? ' primary' : '') + '" style="padding:3px 11px;font-size:12px" data-m="month" onclick="setGroupMode(this.dataset.m)">📅 Month-wise</button>' +
    '<button type="button" class="btn' + (groupMode === 'party' ? ' primary' : '') + '" style="padding:3px 11px;font-size:12px" data-m="party" onclick="setGroupMode(this.dataset.m)">👥 Party-wise</button>';
  host.innerHTML = h;
}
function matchesFilter(d) {
  // Registration filter first: viewing ONE registration must never surface
  // another registration's documents (not booked or otherwise).
  if (regFilter && d.own !== regFilter) return false;
  if (bucketFilter !== 'all' && rowBucket(d) !== bucketFilter) return false;
  if (!filterText) return true;
  return d.name.toLowerCase().indexOf(filterText) >= 0 ||
         d.gstin.toLowerCase().indexOf(filterText) >= 0 ||
         d.no.toLowerCase().indexOf(filterText) >= 0;
}
// Reads the head-wise pattern of a mismatch and says what probably happened.
function diagnoseMismatch(d, rc) {
  var tol = Math.max(Number(settings.tolerance) || 5, 1);
  var t2 = { tx: taxableOf(d), i: d.igst || 0, c: d.cgst || 0, s: d.sgst || 0 };
  var tb = { tx: Number(rc.bookTaxable) || 0, i: Number(rc.bookIgst) || 0, c: Number(rc.bookCgst) || 0,
    s: Number(rc.bookSgst) || 0, g: Number(rc.bookGstComb) || 0 };
  var tax2 = r2(t2.i + t2.c + t2.s);
  var taxb = r2(tb.i + tb.c + tb.s + tb.g);
  var near = function (a, b) { return Math.abs(a - b) <= tol; };
  if (rc.headSwap) {
    return '⚠ WRONG TAX HEAD — books show ' + (tb.i > tol ? 'IGST' : 'CGST+SGST') + ' but 2B shows ' +
      (t2.i > tol ? 'IGST' : 'CGST+SGST') + '. Correct the head in Tally; cross-head claims are recovered with interest in scrutiny.';
  }
  if (t2.i > tol && tb.i <= tol && near(r2(tb.c + tb.s), t2.i)) {
    return '⚠ WRONG HEAD — 2B charges IGST ' + inr(t2.i) + ' but the books split it into CGST+SGST. Re-book under IGST.';
  }
  if (t2.i <= tol && (t2.c > tol || t2.s > tol) && tb.c <= tol && tb.s <= tol && near(tb.i, tax2)) {
    return '⚠ WRONG HEAD — 2B splits CGST+SGST but the books booked the full tax as IGST. Re-book under CGST+SGST.';
  }
  if (taxb > tol && near(taxb, r2(2 * tax2))) {
    if (near(tb.c, r2(2 * t2.c)) && near(tb.s, r2(2 * t2.s))) {
      return '⚠ CGST and SGST each look booked TWICE — the books carry double the 2B tax. Check for a duplicate tax leg or the invoice entered twice.';
    }
    return '⚠ Books GST is about DOUBLE the 2B GST — a tax leg may be entered twice.';
  }
  if (tax2 > tol && near(taxb, r2(tax2 / 2))) {
    return '⚠ Only about HALF the tax is booked — one head (CGST or SGST) looks missing in Tally.';
  }
  if (t2.s > tol && tb.s <= tol && near(tb.c, r2(t2.c + t2.s))) {
    return '⚠ BOTH halves posted to CGST — the SGST amount is sitting in the CGST ledger. Move ' + inr(t2.s) + ' to SGST.';
  }
  if (t2.c > tol && tb.c <= tol && near(tb.s, r2(t2.c + t2.s))) {
    return '⚠ BOTH halves posted to SGST — the CGST amount is sitting in the SGST ledger. Move ' + inr(t2.c) + ' to CGST.';
  }
  if (tb.g > tol && tb.i <= tol && tb.c <= tol && tb.s <= tol && near(tb.g, tax2)) {
    return 'Books use ONE combined GST ledger and the total agrees — split it into CGST/SGST/IGST input ledgers for clean head-wise matching.';
  }
  if (near(t2.tx, tb.tx) && !near(tax2, taxb)) {
    return 'Taxable agrees — only the GST differs by ' + inr(Math.abs(r2(tax2 - taxb))) + '. Check the RATE used in Tally (or a short/extra tax leg).';
  }
  if (!near(t2.tx, tb.tx) && near(tax2, taxb)) {
    return 'GST agrees — only the TAXABLE differs by ' + inr(Math.abs(r2(t2.tx - tb.tx))) + '. Check freight/other charges or a non-GST component on one side.';
  }
  return 'Both taxable and tax differ — verify against the physical invoice.';
}
// Face-to-face 2B vs Books grid with per-head differences.
function compareHtml(d, rc, cols) {
  if (!rc || rc.bookAmount == null || rc.bookAmount === '') return '';
  var t2 = { tx: taxableOf(d), i: d.igst || 0, c: d.cgst || 0, s: d.sgst || 0 };
  var tb = { tx: Number(rc.bookTaxable) || 0, i: Number(rc.bookIgst) || 0, c: Number(rc.bookCgst) || 0,
    s: Number(rc.bookSgst) || 0, g: Number(rc.bookGstComb) || 0, tds: Number(rc.bookTds) || 0 };
  var row = function (label, a, b) {
    var diff = r2(a - b);
    var bad = Math.abs(diff) > 0.01;
    return '<tr><td>' + label + '</td><td class="r">' + inr(r2(a)) + '</td><td class="r">' + inr(r2(b)) + '</td>' +
      '<td class="r" style="' + (bad ? 'color:var(--bad);font-weight:700' : 'color:var(--ok)') + '">' + (bad ? inr(diff) : '0.00 ✓') + '</td></tr>';
  };
  var body = row('Taxable', t2.tx, tb.tx) + row('IGST', t2.i, tb.i) + row('CGST', t2.c, tb.c) + row('SGST', t2.s, tb.s);
  if (tb.g > 0.01) body += '<tr><td>GST (combined ledger)</td><td class="r">—</td><td class="r">' + inr(tb.g) + '</td><td class="r">—</td></tr>';
  if (tb.tds > 0.01) body += '<tr><td>TDS on voucher</td><td class="r">—</td><td class="r">' + inr(tb.tds) + '</td><td class="r">—</td></tr>';
  body += row('TAX TOTAL', r2(t2.i + t2.c + t2.s), r2(tb.i + tb.c + tb.s + tb.g));
  return '<tr><td></td><td colspan="' + (cols - 1) + '" style="background:#fffaf3;border-left:3px solid var(--warn);padding:8px 12px">' +
    '<table style="width:auto;min-width:420px;font-size:12px"><tr><th></th><th class="r">As per 2B ₹</th><th class="r">In books (' + esc(rc.bookRef || '—') + ') ₹</th><th class="r">Difference ₹</th></tr>' +
    body + '</table>' +
    '<div style="font-size:12.5px;margin-top:6px"><b>💡 ' + esc(diagnoseMismatch(d, rc)) + '</b></div>' +
    '</td></tr>';
}
function recoNote(rc) {
  if (!rc || !rc.note) return '';
  return '<div class="muted" style="font-size:11;max-width:280px">' + esc(rc.note) + '</div>';
}
function statusOf(d) {
  var k = key(d);
  if (live[k]) return live[k];
  if (postedReg[k]) return { status: 'posted', at: postedReg[k].at, via: postedReg[k].via };
  return { status: 'pending' };
}
function render() { renderMappings(); renderDocs(); renderRcm(); }
function renderDocs() {
  var host = document.getElementById('docs');
  document.getElementById('bar').style.display = docs.length ? '' : 'none';
  if (!docs.length) { host.innerHTML = ''; return; }
  var multiOwn = ownList().length > 1;

  // Party names into the filter's suggestion list.
  var names = {};
  docs.forEach(function (d) { names[d.name] = true; });
  document.getElementById('party-list').innerHTML =
    Object.keys(names).sort().map(function (n) { return '<option value="' + escAttr(n) + '"></option>'; }).join('');

  renderChips();
  var visible = docs.filter(matchesFilter);
  document.getElementById('filter-count').textContent =
    (filterText || bucketFilter !== 'all') ? 'showing ' + visible.length + ' of ' + docs.length : '';
  if (!visible.length) {
    host.innerHTML = '<div class="card"><p class="muted" style="margin:0">No documents match the filter.</p></div>';
    updateBar();
    return;
  }

  var typeTag = {
    invoice: '<span class="tag inv">INVOICE</span>',
    creditnote: '<span class="tag cn">CREDIT NOTE</span>',
    debitnote: '<span class="tag dn">DEBIT NOTE</span>',
  };
  var groups = [];
  if (groupMode === 'party') {
    var byG = {};
    visible.forEach(function (d) { (byG[d.gstin] = byG[d.gstin] || []).push(d); });
    Object.keys(byG).sort(function (a, b) { return byG[a][0].name.localeCompare(byG[b][0].name); }).forEach(function (g) {
      groups.push({ kind: 'party', val: g,
        label: esc(byG[g][0].name) + ' <span class="muted mono" style="font-weight:400;font-size:12px">' + esc(g) + '</span>',
        list: byG[g] });
    });
  } else {
    var byPeriod = {};
    visible.forEach(function (d) { (byPeriod[d.period] = byPeriod[d.period] || []).push(d); });
    Object.keys(byPeriod).sort(function (a, b) {
      return (b.slice(2) + b.slice(0, 2)).localeCompare(a.slice(2) + a.slice(0, 2));
    }).forEach(function (p) {
      groups.push({ kind: 'month', val: p, label: esc(periodLabel(p)), list: byPeriod[p] });
    });
  }
  var h = '';
  groups.forEach(function (grp) {
    var list = grp.list.slice().sort(function (a, b) { return a.name.localeCompare(b.name) || a.date.localeCompare(b.date); });
    var totTax = 0, totAll = 0;
    list.forEach(function (d) { totTax += taxableOf(d); totAll += taxableOf(d) + d.igst + d.cgst + d.sgst + d.cess; });
    var allOn = list.every(function (d) { return selected[key(d)]; });
    h += '<div class="card"><div class="phead"><h2 style="margin:0">' + grp.label + ' — ' + list.length + ' document(s)</h2>' +
      '<span class="muted">Taxable ₹' + inr(r2(totTax)) + ' · Total ₹' + inr(r2(totAll)) + '</span></div>' +
      '<div class="tbl-scroll"><table><tr>' +
      '<th><input type="checkbox"' + (allOn ? ' checked' : '') + ' data-k="' + grp.kind + '" data-v="' + escAttr(grp.val) + '" onchange="toggleGroup(this.dataset.k, this.dataset.v, this.checked)" title="select whole group"></th>' +
      (grp.kind === 'party' ? '' : '<th>Supplier</th>') +
      '<th>Document</th><th class="r">Taxable</th><th class="r">IGST</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">Total</th><th>Tally ledger</th><th>Status</th></tr>';
    list.forEach(function (d) {
      var k = key(d);
      var st = statusOf(d);
      var m = mappings[d.gstin];
      var total = r2(taxableOf(d) + d.igst + d.cgst + d.sgst + d.cess);
      var rc = reco && reco.byKey[k];
      var pill = st.status === 'posted' && st.via === 'found-in-tally'
          ? '<span class="pill ok" title="' + escAttr((rc && rc.note) || 'Found in the Tally books during reconciliation — will never be posted again from here') + '">In Tally ✓</span>'
        : st.status === 'posted' && rc && rc.st === 'booked' ? '<span class="pill ok" title="' + escAttr(rc.note || '') + '">Posted ✓ in Tally</span>'
        : st.status === 'posted' && rc && rc.st === 'mismatch' ? '<span class="pill warn" title="' + escAttr(rc.note || '') + '">Posted — but MISMATCH in books</span>' + recoNote(rc)
        : st.status === 'posted' || st.status === 'ok' ? '<span class="pill ok" title="Posted by this tool — reconcile to verify it against the books">Posted</span>'
        : st.status === 'dup' ? '<span class="pill warn" title="A matching voucher (same number+party, or same party, amount and date) is already in Tally — skipped">In Tally already</span>'
        : st.status === 'posting' ? '<span class="pill warn">Posting…</span>'
        : st.status === 'fail' ? '<span class="pill bad" title="' + escAttr(st.error || '') + '">Rejected</span>'
        : rc && rc.st === 'notbooked' && rc.gap ? '<span class="pill warn" title="' + escAttr(rc.note || '') + '">MONTH NOT READ — widen Tally period</span>' + recoNote(rc)
        : rc && rc.st === 'notbooked' ? '<span class="pill bad" title="' + escAttr(rc.note || '') + '">NOT BOOKED</span>' + recoNote(rc)
        : rc && rc.st === 'probable' ? '<span class="pill warn">PROBABLE</span>' + recoNote(rc)
        : rc && rc.st === 'mismatch' ? '<span class="pill warn">MISMATCH</span>' + recoNote(rc)
        : rc && rc.st === 'amended' ? '<span class="pill warn" title="' + escAttr(rc.note || '') + '">REVISED — original in books</span>' + recoNote(rc)
        : '<span class="pill idle">Pending</span>';
      if (st.status === 'fail' && st.error) pill += '<div class="muted" style="font-size:11;max-width:230px">' + esc(st.error) + '</div>';
      // Tags must be added BEFORE the pill is rendered into the row.
      if (rc && rc.wrongReg) pill += ' <span class="tag dn" title="' + escAttr(rc.note || '') + '">🚩 WRONG REGN — booked in ' + esc(rc.wrongReg) + '</span>';
      if (rc && rc.headSwap) pill += ' <span class="tag dn" title="IGST vs CGST/SGST heads differ between the books and 2B — see the comparison below">WRONG HEAD</span>';
      h += '<tr>' +
        '<td><input type="checkbox" data-k="' + escAttr(k) + '"' + (selected[k] ? ' checked' : '') + ' onchange="toggleOne(this)"></td>' +
        (grp.kind === 'party' ? '' : '<td>' + esc(d.name) + '<div class="muted mono">' + esc(d.gstin) + '</div></td>') +
        '<td>' + (typeTag[d.type] || esc(d.type)) + (d.amended ? ' <span class="tag amd" title="Revised on the portal — adjust the original entry in Tally manually; never auto-posted">AMENDED</span>' : '') +
          ' <b>' + esc(d.no) + '</b><div class="muted">' + esc(d.date) +
          (grp.kind === 'party' ? ' · <span title=\\'The GSTR-2B month this document was reported in (can differ from the invoice date when the supplier files late)\\'>2B: ' + esc(periodLabel(d.period)) + '</span>' : '') +
          (multiOwn && d.own ? ' · <span title=\\'Your registration this document was reported to\\'>for ' + esc(d.own) + '</span>' : '') +
          (d.amended && d.orig ? ' · amends ' + esc(d.orig) : '') +
          (d.rcm ? ' · <span class="flag">RCM</span>' : '') + (!d.itc ? ' · <span class="flag">ITC N/A</span>' : '') + '</div></td>' +
        '<td class="r">' + inr(taxableOf(d)) + '</td><td class="r">' + (d.igst ? inr(d.igst) : '—') + '</td>' +
        '<td class="r">' + (d.cgst ? inr(d.cgst) : '—') + '</td><td class="r">' + (d.sgst ? inr(d.sgst) : '—') + '</td>' +
        '<td class="r"><b>' + inr(total) + '</b></td>' +
        '<td>' + (m && m.ledger ? esc(m.ledger) : '<span style="color:var(--bad)">⚠ not mapped</span>') +
          (m && m.purchaseLedger ? '<div class="muted" style="font-size:11">🧠 ' + esc(m.purchaseLedger) + '</div>' : '') + '</td>' +
        '<td>' + pill + '</td></tr>';
      var showCompare = rc && (rc.st === 'mismatch' || rc.st === 'probable' || rc.headSwap ||
        (st.status === 'posted' && rc.st === 'mismatch'));
      if (showCompare) h += compareHtml(d, rc, grp.kind === 'party' ? 9 : 10);
    });
    h += '</table></div></div>';
  });
  host.innerHTML = h;
  updateBar();
}
function toggleOne(el) {
  var k = el.getAttribute('data-k');
  if (el.checked) selected[k] = true; else delete selected[k];
  updateBar();
}
function togglePeriod(p, on) {
  // Only the rows currently visible — with a party filter on, this selects
  // (or clears) just that party's documents for the month.
  docs.forEach(function (d) {
    if (d.period !== p || !matchesFilter(d)) return;
    if (on) selected[key(d)] = true; else delete selected[key(d)];
  });
  renderDocs();
}
function updateBar() {
  document.getElementById('sel-count').textContent = Object.keys(selected).length;
  renderPostPanel();
}
var lastPanelKey = '';
var activeOvr = null; // frozen panel values for the whole posting batch
function ovrNow() {
  return { vch: povr('pp-vch'), party: povr('pp-party'), purchase: povr('pp-purchase'),
    igst: povr('pp-igst'), cgst: povr('pp-cgst'), sgst: povr('pp-sgst') };
}
function povr(id) {
  var el = document.getElementById(id);
  return el && !el.disabled ? String(el.value || '').trim() : '';
}
// Batch posting panel: choose the exact ledgers + voucher type for the
// SELECTED documents. Blank fields fall back to the learned mapping /
// Settings defaults. Single-party choices persist to that party's mapping.
function renderPostPanel() {
  var host = document.getElementById('post-panel');
  var sel = docs.filter(function (d) { return selected[key(d)]; });
  if (!sel.length) { host.style.display = 'none'; lastPanelKey = ''; return; }
  var gstins = [...new Set(sel.map(function (d) { return d.gstin; }))].sort();
  var pk = gstins.join(',') + '|' + sel.length;
  host.style.display = '';
  if (pk === lastPanelKey) return; // keep the user's edits while ticking more rows
  lastPanelKey = pk;
  var single = gstins.length === 1;
  var m = single ? (mappings[gstins[0]] || {}) : {};
  var name = single ? (sel[0].name || gstins[0]) : gstins.length + ' parties';
  var fld = function (id, label, value, ph, dis) {
    return '<div><label style="font-size:11.5px;color:var(--muted);display:block;margin-bottom:2px">' + label + '</label>' +
      '<input type="text" id="' + id + '" list="ledger-list" value="' + escAttr(value || '') + '" placeholder="' + escAttr(ph || '') + '"' +
      (dis ? ' disabled' : '') + ' style="width:100%;padding:6px 9px;border:1px solid var(--line);border-radius:7px;font:inherit;font-size:12.5px"></div>';
  };
  var vchOpts = '<option value="">(default: Purchase · CN → Debit Note)</option>';
  ['Purchase'].concat(vchTypeList).filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (t) {
    vchOpts += '<option value="' + escAttr(t) + '">' + esc(t) + '</option>';
  });
  host.innerHTML =
    '<b style="font-size:13px">Posting ledgers for the ' + sel.length + ' selected document(s) — ' + esc(name) + '</b>' +
    '<span class="muted" style="font-size:11.5px"> · blank = learned mapping / Settings default' + (single ? ' · changes are saved to this party&apos;s mapping' : ' · party/purchase come from each party&apos;s own mapping') + '</span>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px 12px;margin-top:8px">' +
    fld('pp-party', 'Party ledger', single ? (m.ledger || '') : '', single ? '' : 'multiple parties — per mapping', !single) +
    fld('pp-purchase', 'Expense / purchase ledger', single ? (m.purchaseLedger || '') : '', settings.purchaseLedger + (single && m.purchaseLedgerLearned ? ' (🧠 learned)' : '')) +
    fld('pp-igst', 'IGST ledger', '', settings.igstLedger) +
    fld('pp-cgst', 'CGST ledger', '', settings.cgstLedger) +
    fld('pp-sgst', 'SGST ledger', '', settings.sgstLedger) +
    '<div><label style="font-size:11.5px;color:var(--muted);display:block;margin-bottom:2px">Voucher type</label>' +
    '<select id="pp-vch" style="width:100%;padding:6px 9px;border:1px solid var(--line);border-radius:7px;font:inherit;font-size:12.5px">' + vchOpts + '</select></div>' +
    '</div>';
}

// ------------------------------ Tally XML ------------------------------
var STATES = { '01':'Jammu & Kashmir','02':'Himachal Pradesh','03':'Punjab','04':'Chandigarh','05':'Uttarakhand',
  '06':'Haryana','07':'Delhi','08':'Rajasthan','09':'Uttar Pradesh','10':'Bihar','11':'Sikkim','12':'Arunachal Pradesh',
  '13':'Nagaland','14':'Manipur','15':'Mizoram','16':'Tripura','17':'Meghalaya','18':'Assam','19':'West Bengal',
  '20':'Jharkhand','21':'Odisha','22':'Chhattisgarh','23':'Madhya Pradesh','24':'Gujarat',
  '26':'Dadra & Nagar Haveli and Daman & Diu','27':'Maharashtra','29':'Karnataka','30':'Goa','31':'Lakshadweep',
  '32':'Kerala','33':'Tamil Nadu','34':'Puducherry','35':'Andaman & Nicobar Islands','36':'Telangana',
  '37':'Andhra Pradesh','38':'Ladakh','97':'Other Territory' };
function amt(n) { return n.toFixed(2); }
function tdate(iso) { return iso.replace(/-/g, ''); }
function lineXml(ledger, amount, billRef, billType) {
  var debit = amount < 0;
  var bills = billRef
    ? '<BILLALLOCATIONS.LIST><NAME>' + esc(billRef) + '</NAME><BILLTYPE>' + (billType || 'New Ref') + '</BILLTYPE><AMOUNT>' + amt(amount) + '</AMOUNT></BILLALLOCATIONS.LIST>'
    : '';
  return '<ALLLEDGERENTRIES.LIST><LEDGERNAME>' + esc(ledger) + '</LEDGERNAME>' +
    '<ISDEEMEDPOSITIVE>' + (debit ? 'Yes' : 'No') + '</ISDEEMEDPOSITIVE>' +
    '<AMOUNT>' + amt(amount) + '</AMOUNT>' + bills + '</ALLLEDGERENTRIES.LIST>';
}
function remoteIdOf(d) {
  return ('G2B-' + d.gstin + '-' + (d.type === 'creditnote' ? 'CN' : d.type === 'debitnote' ? 'DN' : 'INV') + '-' + normKey(d.no)).slice(0, 64);
}
// Tally's own "Internal Error / Record insertion failure in Database" — a
// Tally-side condition (dialog pops up IN Tally), not a rejection of the
// voucher's content.
function tallyInternalErr(s) { return /internal error|insertion failure|record insertion/i.test(String(s || '')); }
var TALLY_ERR_HELP = ' → This error comes from TALLY itself. Fix in Tally: 1) click OK on the error box there, 2) come back to the Gateway of Tally (close any open voucher/alteration screen) and try ONE entry again, 3) if it still fails: back up the data, then REWRITE it — at the Select Company screen press Ctrl+Alt+R and pick the company, 4) on Edit Log releases of TallyPrime, update Tally to the latest release.';
function vchTypeOf(d) { return d.type === 'creditnote' ? 'Debit Note' : 'Purchase'; }
function purchaseLedgerFor(d) {
  var m = mappings[d.gstin];
  return (m && m.purchaseLedger) || settings.purchaseLedger;
}
function voucherXml(d, ledger, rid) {
  rid = rid || remoteIdOf(d);
  var sign = d.type === 'creditnote' ? -1 : 1;   // supplier credit note reverses the purchase
  var O = activeOvr || ovrNow();
  var vch = d.type === 'creditnote' ? 'Debit Note' : (O.vch || 'Purchase');
  var tx = taxableOf(d);
  var purLedger = O.purchase || purchaseLedgerFor(d);
  var igstL = O.igst || settings.igstLedger;
  var cgstL = O.cgst || settings.cgstLedger;
  var sgstL = O.sgst || settings.sgstLedger;
  // RCM document: book Dr Purchase / Cr Party for the taxable value only.
  // The tax goes through the monthly RCM liability journal (RCM card below).
  if (d.rcm) {
    var rl = [lineXml(purLedger, -tx * sign, null),
      lineXml(ledger, tx * sign, settings.billwise && d.type === 'invoice' ? d.no : null)];
    var rdate = tdate(d.date);
    var rnarr = 'GSTR-2B ' + periodLabel(d.period) + ' | ' + d.name + ' ' + d.gstin + ' | RCM — tax via RCM liability journal';
    return '<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="' + escAttr(rid) + '" VCHTYPE="' + vch + '" ACTION="Create" OBJVIEW="Accounting Voucher View">' +
      '<DATE>' + rdate + '</DATE><EFFECTIVEDATE>' + rdate + '</EFFECTIVEDATE>' +
      '<VOUCHERTYPENAME>' + vch + '</VOUCHERTYPENAME><VOUCHERNUMBER>' + esc(d.no) + '</VOUCHERNUMBER>' +
      '<REFERENCE>' + esc(d.no) + '</REFERENCE><REFERENCEDATE>' + rdate + '</REFERENCEDATE>' +
      '<PARTYLEDGERNAME>' + esc(ledger) + '</PARTYLEDGERNAME><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>' +
      '<ISINVOICE>No</ISINVOICE><NARRATION>' + esc(rnarr) + '</NARRATION>' + rl.join('') + '</VOUCHER></TALLYMESSAGE>';
  }
  var lines = [lineXml(purLedger, -tx * sign, null)];
  if (d.igst > 0) lines.push(lineXml(igstL, -d.igst * sign, null));
  if (d.cgst > 0) lines.push(lineXml(cgstL, -d.cgst * sign, null));
  if (d.sgst > 0) lines.push(lineXml(sgstL, -d.sgst * sign, null));
  if (d.cess > 0 && settings.cessLedger) lines.push(lineXml(settings.cessLedger, -d.cess * sign, null));
  var party = r2(tx + d.igst + d.cgst + d.sgst + (settings.cessLedger ? d.cess : 0));
  var diff = r2(d.val - party);
  if (settings.roundOffLedger && diff !== 0 && Math.abs(diff) <= 1) {
    lines.push(lineXml(settings.roundOffLedger, -diff * sign, null));
    party = d.val;
  }
  lines.push(lineXml(ledger, party * sign, settings.billwise && d.type === 'invoice' ? d.no : null));
  var date = tdate(d.date);
  var narr = 'GSTR-2B ' + periodLabel(d.period) + ' | ' + d.name + ' ' + d.gstin +
    (d.rcm ? ' | RCM' : '') + (d.itc ? '' : ' | ITC not available');
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="' + escAttr(rid) + '" VCHTYPE="' + vch + '" ACTION="Create" OBJVIEW="Accounting Voucher View">' +
    '<DATE>' + date + '</DATE><EFFECTIVEDATE>' + date + '</EFFECTIVEDATE>' +
    '<VOUCHERTYPENAME>' + vch + '</VOUCHERTYPENAME><VOUCHERNUMBER>' + esc(d.no) + '</VOUCHERNUMBER>' +
    '<REFERENCE>' + esc(d.no) + '</REFERENCE><REFERENCEDATE>' + date + '</REFERENCEDATE>' +
    '<PARTYLEDGERNAME>' + esc(ledger) + '</PARTYLEDGERNAME><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>' +
    '<ISINVOICE>No</ISINVOICE><NARRATION>' + esc(narr) + '</NARRATION>' + lines.join('') + '</VOUCHER></TALLYMESSAGE>';
}
function ledgerXml(name, gstin) {
  var st = STATES[gstin.slice(0, 2)] || '';
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="' + escAttr(name) + '" ACTION="Create">' +
    '<NAME.LIST><NAME>' + esc(name) + '</NAME></NAME.LIST><PARENT>Sundry Creditors</PARENT>' +
    '<ISBILLWISEON>Yes</ISBILLWISEON><COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>' +
    (st ? '<LEDSTATENAME>' + esc(st) + '</LEDSTATENAME>' : '') +
    '<PARTYGSTIN>' + esc(gstin) + '</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE></LEDGER></TALLYMESSAGE>';
}
function envelope(messages, report) {
  var comp = (settings.company || '').trim();
  return '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>' +
    '<REQUESTDESC><REPORTNAME>' + report + '</REPORTNAME>' +
    (comp ? '<STATICVARIABLES><SVCURRENTCOMPANY>' + esc(comp) + '</SVCURRENTCOMPANY></STATICVARIABLES>' : '') +
    '</REQUESTDESC>' +
    '<REQUESTDATA>' + messages.join('') + '</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
}

// ------------------------------ actions ------------------------------
// ------------------------------ reconciliation ------------------------------
// Compare every loaded 2B document with what is actually booked in Tally:
//   booked    — found (number+party, or party+amount+date); auto-marked so it
//               can never be posted again
//   mismatch  — same number+party exists but the amount differs
//   notbooked — nothing similar in Tally; candidate for one-click posting
// Also surfaces the reverse: purchase-side vouchers in Tally that appear in
// no loaded GSTR-2B (supplier hasn't filed / wrong period / manual entry).
var reco = null; // { byKey, booksOnly, duplicates, opinions, summary }
async function runReco() {
  if (!docs.length) return;
  var btn = document.getElementById('reco-btn');
  btn.disabled = true;
  document.getElementById('bar-msg').textContent = 'Reconciling…';
  ensureProgressWatcher();
  var j;
  try {
    docs.forEach(function (d) { if (!d.key) d.key = key(d); });
    j = await fetch('/api/reconcile', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ docs: docs, epoch: srvEpoch }) }).then(function (r) { return r.json(); });
  } catch (e) { j = { ok: false, error: String((e && e.message) || e) }; }
  btn.disabled = false;
  if (!j.ok) {
    document.getElementById('bar-msg').textContent = 'Reconciliation failed — ' + (j.error || 'is Tally open?');
    return;
  }
  // The server already locked booked rows and released vanished ones — sync.
  try {
    var d2 = await fetch('/api/data').then(function (r) { return r.json(); });
    postedReg = d2.posted || {};
    mappings = d2.mappings || mappings;
    renderMappings();
    updateJarvis(d2.autopilot);
  } catch (e) { /* keep local copy */ }
  var c = applyReco(j);
  document.getElementById('bar-msg').textContent =
    'Reconciled: ' + c.booked + ' booked · ' + c.notbooked + ' not booked · ' + c.probable + ' probable · ' + c.mismatch + ' mismatch.' +
    (j.staleReset ? ' ⚠ ' + j.staleReset + ' row(s) marked Posted earlier are NO LONGER in Tally — reset to Not booked.' : '');
}
function renderRecoSummary(c) {
  var host = document.getElementById('reco-summary');
  var s = reco.summary || {};
  var h = '<div class="card card-pad" style="padding:14px 18px"><b>Reconciliation with Tally</b> — ' +
    '<span class="pill ok">' + c.booked + ' booked</span> ' +
    '<span class="pill bad">' + c.notbooked + ' not booked</span> ' +
    '<span class="pill warn">' + c.probable + ' probable</span> ' +
    '<span class="pill warn">' + c.mismatch + ' mismatch</span>' +
    ((reco.booksOnly || []).length ? ' <span class="pill warn" title="Open the section below — booked purchases the supplier has not filed (ITC at risk)">' + reco.booksOnly.length + ' in books, not in 2B</span>' : '') +
    (s.wrongRegCount ? ' <span class="pill bad" title="Booked under another state&#39;s registration — fix the GST Registration on those vouchers in Tally (see the 🚩 rows and the Wrong Registration Excel sheet)">🚩 ' + s.wrongRegCount + ' wrong registration</span>' : '') +
    (s.matchedPct != null ? ' <span class="muted">· ' + s.matchedPct + '% of eligible ITC matched</span>' : '') +
    '<span class="muted"> · tick the not-booked ones (☑ button above) and Post to Tally to book them.</span>' +
    '<div style="margin-top:12px"><button type="button" class="btn primary" style="padding:10px 22px;font-size:14.5px;font-weight:700;box-shadow:0 2px 8px rgba(21,94,239,.35)" onclick="downloadRecoExcel()">📊 Download Excel summary (working paper)</button>' +
    (ownList().length > 1 ? '<span class="muted" style="font-size:12px;margin-left:10px">the Excel follows the registration chip — pick one GSTIN for a per-registration report, or All for combined (every sheet also carries a Regn column)</span>' : '') +
    '</div>';
  if ((s.byOwn || []).length) {
    h += '<div style="font-size:12.5px;margin-top:10px"><b>Per registration:</b> ' +
      s.byOwn.map(function (o) {
        return '<span class="mono">' + esc(o.gstin) + '</span> — ITC ₹' + inr(r2(o.claimable)) +
          ', matched ₹' + inr(r2(o.matched)) +
          (o.notBooked ? ', <b style="color:var(--bad)">not booked ₹' + inr(r2(o.notBooked)) + '</b>' : '') +
          (o.mismatch ? ', ' + o.mismatch + ' mismatch' : '');
      }).join(' &nbsp;·&nbsp; ') +
      ' <span class="muted">(use the registration chips above to work one state at a time)</span></div>';
  }
  var ri = reco.raw && reco.raw.readInfo;
  if (ri) {
    h += '<div class="muted" style="font-size:12px;margin-top:8px">📖 Books read from Tally: ' + esc(ri.from) + ' → ' + esc(ri.to) +
      ' · ' + Number(ri.vouchers).toLocaleString('en-IN') + ' purchase-side voucher(s) across ' + (ri.monthsWithData || []).length + ' month(s)' +
      ((ri.monthsWithData || []).length ? ' (' + esc(ri.monthsWithData[0]) + ' → ' + esc(ri.monthsWithData[ri.monthsWithData.length - 1]) + ')' : '') +
      (Number(ri.vouchers) === 0 ? ' — <b style="color:var(--bad)">the books came back EMPTY: check the open company / Company name in Settings</b>' : '') +
      (ri.warning ? '<br><b style="color:var(--warn)">' + esc(ri.warning) + '</b>' : '') +
      (ri.journalsSkipped ? '<br><span style="color:var(--warn)">⚠ ' + ri.journalsSkipped + ' journal-type voucher(s) carried no GST split and no clear supplier leg, so they were not treated as purchases' +
        (ri.skippedLedgers && ri.skippedLedgers.length ? ' (mostly on: ' + ri.skippedLedgers.map(esc).join(', ') + ')' : '') +
        ' — if purchases or ITC reversals are booked that way, add the supplier GSTIN on the ledger or use bill-wise references so they can be matched.</span>' : '') + '</div>';
  }
  if ((reco.opinions || []).length) {
    h += '<details style="margin-top:10px" open><summary style="cursor:pointer;font-size:13px"><b>Opinion — what it means and what to do</b></summary>' +
      '<ul style="margin:8px 0 0 18px;padding:0;font-size:12.5px;line-height:1.6">';
    reco.opinions.forEach(function (o) {
      var col = o.tone === 'good' ? 'var(--ok)' : o.tone === 'bad' ? 'var(--bad)' : 'var(--warn)';
      h += '<li style="margin-bottom:6px"><span style="color:' + col + ';font-weight:700">' +
        (o.tone === 'good' ? '✔' : o.tone === 'bad' ? '✖' : '⚠') + '</span> ' + esc(o.text) + '</li>';
    });
    h += '</ul></details>';
  }
  if ((reco.booksOnly || []).length) {
    h += '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px"><b>In Tally but NOT in the loaded GSTR-2B (' + reco.booksOnly.length + ')</b> — ITC at risk until the supplier files</summary>' +
      '<div class="tbl-scroll"><table style="margin-top:8px"><tr><th>Party</th><th>Bill no</th><th>Type</th><th>Date</th><th class="r">Amount ₹</th><th class="r">GST ₹</th><th>Supplier in this 2B?</th></tr>';
    reco.booksOnly.slice(0, 100).forEach(function (b) {
      h += '<tr><td>' + esc(b.party) + (b.gstin ? '<div class="muted mono">' + esc(b.gstin) + '</div>' : '') +
        (b.cmpGstin ? '<div class="muted mono" style="font-size:10.5px">regn ' + esc(b.cmpGstin) + '</div>' : '') + '</td>' +
        '<td class="mono">' + esc(b.billNo) + '</td><td>' + esc(b.vtype || '') + '</td><td>' + esc(b.date || '—') + '</td>' +
        '<td class="r">' + inr(b.amount || 0) + '</td><td class="r">' + (b.tax ? inr(b.tax) : '—') + '</td>' +
        '<td>' + (b.supplierIn2b ? '<b>Yes</b> — check number/value against their filed docs' : 'No — likely files in a later 2B') + '</td></tr>';
    });
    h += '</table></div>' + (reco.booksOnly.length > 100 ? '<p class="muted">Showing first 100.</p>' : '') + '</details>';
  }
  if ((reco.duplicates || []).length) {
    h += '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:13px;color:var(--bad)"><b>Possible DUPLICATE bookings in Tally (' + reco.duplicates.length + ')</b> — same supplier + bill number twice</summary>' +
      '<div class="tbl-scroll"><table style="margin-top:8px"><tr><th>Party</th><th>Bill no</th><th class="r">Amount ₹</th><th class="r">GST ₹</th><th>Why flagged</th></tr>';
    reco.duplicates.forEach(function (b) {
      h += '<tr><td>' + esc(b.party) + '</td><td class="mono">' + esc(b.billNo) + '</td><td class="r">' + inr(b.amount || 0) + '</td>' +
        '<td class="r">' + (b.tax ? inr(b.tax) : '—') + '</td>' +
        '<td>' + (b.kind === 'internal' ? 'Entered more than once (none in 2B yet)' : 'Duplicates an entry already matched to the 2B') + '</td></tr>';
    });
    h += '</table></div></details>';
  }
  host.innerHTML = h + '</div>';
}

// Excel working paper — the same formatted SpreadsheetML workbook the recon
// tool's report produces: Summary & Opinion, All Documents (2B vs books side
// by side), Possible Duplicates, ITC at Risk, Supplier Gaps.
function downloadRecoExcel() {
  if (!reco || !reco.raw) return;
  var R = reco.raw;
  var S = R.summary || {};
  var XA = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var C = function (v, st, f) {
    var a = (st ? ' ss:StyleID="' + st + '"' : '') + (f ? ' ss:Formula="' + XA(f) + '"' : '');
    if ((v === '' || v == null) && !f) return '<Cell' + a + '/>';
    var isNum = typeof v === 'number' && isFinite(v);
    var val = isNum ? Math.round(v * 100) / 100 : XA(v);
    return '<Cell' + a + '><Data ss:Type="' + (isNum ? 'Number' : 'String') + '">' + val + '</Data></Cell>';
  };
  var ROW = function (cells) { return '<Row>' + cells.join('') + '</Row>'; };
  var EMPTY = '<Row/>';
  var n2 = function (v) { return v == null || v === '' ? '' : Number(v); };

  var docBy = {};
  docs.forEach(function (d) { docBy[key(d)] = d; });
  // 🏷 The workbook follows the registration chip: with a chip selected, every
  // document sheet contains ONLY that registration — one report per GSTIN.
  var xf = regFilter || '';
  var multiX = ownList().length > 1;
  var xDocs = (R.docs || []).filter(function (r) { return !xf || r.own === xf; });
  var xBook = function (b) { return !xf || !b.cmpGstin || b.cmpGstin === xf; };
  var periods = {};
  docs.forEach(function (d) { if (!xf || d.own === xf) periods[periodLabel(d.period)] = 1; });
  var sheets = [];

  // ---- Sheet 1: Summary & Opinion ----
  (function () {
    var rows = [];
    rows.push(ROW([C('GSTR-2B vs TALLY RECONCILIATION STATEMENT' + (xf ? ' — ' + xf : ''), 'sTitle')]));
    rows.push(ROW([C('Period', 'sLabel'), C(Object.keys(periods).join(', '))]));
    var ownsX = ownList();
    rows.push(ROW([C('GSTIN', 'sLabel'), C(xf || (ownsX.length > 1 ? ownsX.join(', ') : (ownGstin || '—')))]));
    rows.push(ROW([C('Generated', 'sLabel'), C(new Date().toLocaleString('en-IN'))]));
    if (xf) {
      rows.push(ROW([C('⚠ Filtered report: the document sheets contain ONLY registration ' + xf +
        '. The SUMMARY / ITC BY HEAD / Opinion blocks below cover ALL loaded registrations combined — see PER REGISTRATION for this GSTIN’s own totals.', 'sWarn')]));
    }
    rows.push(EMPTY);
    if ((S.byOwn || []).length) {
      rows.push(ROW([C('PER REGISTRATION', 'sSection'), C('Eligible ITC', 'sSection'), C('Matched', 'sSection'), C('Not booked', 'sSection')]));
      S.byOwn.forEach(function (o) {
        rows.push(ROW([C(o.gstin, 'sLabel'), C(n2(o.claimable), 'sMoney'), C(n2(o.matched), 'sMoney'),
          C(n2(o.notBooked), o.notBooked ? 'sMoneyBad' : 'sMoney')]));
      });
      rows.push(EMPTY);
    }
    rows.push(ROW([C('SUMMARY', 'sSection'), C('', 'sSection'), C('', 'sSection'), C('', 'sSection')]));
    rows.push(ROW([C('Reconciled % (by ITC value)', 'sLabel'), C(n2(S.matchedPct), 'sNum')]));
    rows.push(ROW([C('Eligible ITC per 2B (net of credit notes)', 'sLabel'), C(n2(S.claimableTax), 'sMoney')]));
    rows.push(ROW([C('ITC matched invoice-wise', 'sLabel'), C(n2(S.matchedTax), 'sMoney')]));
    rows.push(ROW([C('ITC matched at supplier level', 'sLabel'), C(n2(S.groupedTax), 'sMoney')]));
    rows.push(ROW([C('ITC blocked by portal', 'sLabel'), C(n2(S.blockedTax), 'sMoney')]));
    rows.push(ROW([C('Credit note reduction', 'sLabel'), C(n2(S.creditNoteTax), 'sMoney')]));
    rows.push(ROW([C('In books not in 2B - value', 'sLabel'), C(n2(S.booksOnlyValue), 'sMoney')]));
    rows.push(ROW([C('In books not in 2B - GST', 'sLabel'), C(n2(S.booksOnlyTax), 'sMoney')]));
    if (S.wrongRegCount) rows.push(ROW([C('Booked under WRONG registration (docs)', 'sLabel'), C(n2(S.wrongRegCount), 'sNum'), C(n2(S.wrongRegTax), 'sMoneyBad')]));
    rows.push(EMPTY);
    rows.push(ROW([C('ITC BY HEAD', 'sSection'), C('In books', 'sSection'), C('Per 2B (eligible)', 'sSection'), C('Difference', 'sSection')]));
    var heads = ['igst', 'cgst', 'sgst', 'cess', 'gst'];
    var bi = S.booksItc || {}, g2 = S.itc2b || {};
    var hn = 0;
    heads.forEach(function (h) {
      var b = bi[h] || 0, g = g2[h] || 0;
      if ((h === 'cess' || h === 'gst') && !b && !g) return;
      hn++;
      rows.push(ROW([C(h === 'gst' ? 'GST (combined ledger)' : h.toUpperCase(), 'sLabel'), C(b, 'sMoney'), C(g, 'sMoney'), C(Math.round((b - g) * 100) / 100, 'sMoney', '=RC[-2]-RC[-1]')]));
    });
    rows.push(ROW([C('TOTAL', 'sTotal'), C(n2(S.booksItcTotal), 'sTotalM', '=SUM(R[-' + hn + ']C:R[-1]C)'), C(n2(S.claimableTax), 'sTotalM', '=SUM(R[-' + hn + ']C:R[-1]C)'), C(Math.round(((S.booksItcTotal || 0) - (S.claimableTax || 0)) * 100) / 100, 'sTotalM', '=RC[-2]-RC[-1]')]));
    rows.push(EMPTY);
    rows.push(ROW([C('OPINION & RECOMMENDED ACTIONS', 'sSection'), C('', 'sSection'), C('', 'sSection'), C('', 'sSection')]));
    (reco.opinions || []).forEach(function (o) { rows.push(ROW([C((o.tone === 'good' ? '[OK] ' : o.tone === 'bad' ? '[!!] ' : '[?] ') + o.text, 'sWrap')])); });
    sheets.push(['Summary', '<Column ss:Width="260"/><Column ss:Width="110"/><Column ss:Width="110"/><Column ss:Width="110"/>', rows]);
  })();

  // ---- Sheet 2: All documents — SAME columns, diffs and live formulas as
  // the gstr2b-tally-recon report's Excel export ----
  (function () {
    var H = ['Regn (your GSTIN)', '2B Period', 'Status', 'Supplier', 'GSTIN', 'Doc type', 'Doc no', 'Date', '2B Value', '2B Taxable', '2B IGST', '2B CGST', '2B SGST', '2B Cess', '2B ITC total', 'Eligible', 'Books ref', 'Books amount', 'Books taxable', 'Books IGST', 'Books CGST', 'Books SGST', 'Books GST comb', 'Books TDS', 'Reimb/Non-GST', 'Diff Taxable', 'Diff IGST', 'Diff CGST', 'Diff SGST', 'Diff GST total', 'Remark'];
    var rows = [ROW(H.map(function (x) { return C(x, 'sHead'); }))];
    xDocs.forEach(function (r) {
      var d = docBy[r.key] || {};
      var itc = r2((d.igst || 0) + (d.cgst || 0) + (d.sgst || 0) + (d.cess || 0));
      var st = r.status === 'matched' || r.status === 'grouped' ? 'sOk' : r.status === 'only2b' || r.status === 'mismatch' ? 'sBad' : 'sWarn';
      var hasBook = r.bookRef != null && r.bookRef !== '' && r.bookAmount != null && r.bookAmount !== '';
      var hasHeads = hasBook && r.bookIgst != null && r.bookIgst !== '' && !(Number(r.bookGstComb) > 0);
      var tx2b = taxableOf(d) || 0;
      var diffTaxable = (Number(r.bookTaxable) || 0) > 0 && tx2b > 0 ? r2(tx2b - r.bookTaxable) : '';
      var diffIgst = hasHeads ? r2((d.igst || 0) - (r.bookIgst || 0)) : '';
      var diffCgst = hasHeads ? r2((d.cgst || 0) - (r.bookCgst || 0)) : '';
      var diffSgst = hasHeads ? r2((d.sgst || 0) - (r.bookSgst || 0)) : '';
      var diffGst = (Number(r.bookTax) || 0) > 0 ? r2(itc - r.bookTax) : '';
      rows.push(ROW([
        C(r.own || d.own || '', 'sMono'),
        C(periodLabel(d.period || '')), C(r.status, st), C(d.name || ''), C(d.gstin || '', 'sMono'),
        C(d.type || ''), C(d.no || '', 'sMono'), C(d.date || ''),
        C(d.val || 0, 'sMoney'), C(tx2b, 'sMoney'), C(d.igst || 0, 'sMoney'), C(d.cgst || 0, 'sMoney'),
        C(d.sgst || 0, 'sMoney'), C(d.cess || 0, 'sMoney'), C(itc, 'sMoney', '=SUM(RC[-4]:RC[-1])'),
        C(r.eligible === false ? 'No' : 'Yes'), C(r.bookRef || '', 'sMono'),
        C(n2(r.bookAmount), 'sMoney'), C(n2(r.bookTaxable), 'sMoney'), C(n2(r.bookIgst), 'sMoney'),
        C(n2(r.bookCgst), 'sMoney'), C(n2(r.bookSgst), 'sMoney'), C(n2(r.bookGstComb), 'sMoney'),
        C(n2(r.bookTds), 'sMoney'), C(n2(r.bookReimb), 'sMoney'),
        diffTaxable === '' ? C('') : C(diffTaxable, 'sMoney', '=RC[-16]-RC[-7]'),
        hasHeads ? C(diffIgst, 'sMoney', '=RC[-16]-RC[-7]') : C(''),
        hasHeads ? C(diffCgst, 'sMoney', '=RC[-16]-RC[-7]') : C(''),
        hasHeads ? C(diffSgst, 'sMoney', '=RC[-16]-RC[-7]') : C(''),
        diffGst === '' ? C('') : C(diffGst, 'sMoney', '=RC[-15]-(RC[-10]+RC[-9]+RC[-8]+RC[-7])'),
        C(r.note || '', 'sWrap'),
      ]));
    });
    var n = xDocs.length;
    if (n) {
      var sum = function () { return '=SUM(R[-' + n + ']C:R[-1]C)'; };
      var tot = [C('TOTALS', 'sTotal'), C('', 'sTotal'), C('', 'sTotal'), C('', 'sTotal'), C('', 'sTotal'), C('', 'sTotal'), C('', 'sTotal'), C('', 'sTotal')];
      for (var i1 = 7; i1 <= 13; i1++) tot.push(C(0, 'sTotalM', sum()));
      tot.push(C('', 'sTotal'), C('', 'sTotal'));
      for (var i2 = 16; i2 <= 28; i2++) tot.push(C(0, 'sTotalM', sum()));
      tot.push(C('', 'sTotal'));
      rows.push(ROW(tot));
    }
    sheets.push(['All Documents', '<Column ss:Width="120"/><Column ss:Width="62"/><Column ss:Width="62"/><Column ss:Width="170"/><Column ss:Width="120"/><Column ss:Width="70"/><Column ss:Width="110"/><Column ss:Width="72"/>' + '<Column ss:Width="85"/>'.repeat(6) + '<Column ss:Width="90"/><Column ss:Width="52"/><Column ss:Width="110"/>' + '<Column ss:Width="85"/>'.repeat(8) + '<Column ss:Width="85"/>'.repeat(5) + '<Column ss:Width="330"/>', rows]);
  })();

  // ---- Sheet 3: Possible duplicates ----
  (function () {
    var rows = [ROW(['Regn', 'Supplier', 'GSTIN', 'Bill no', 'Voucher type', 'Date', 'Amount', 'IGST', 'CGST', 'SGST', 'TDS', 'ITC booked', 'Why flagged'].map(function (x) { return C(x, 'sHead'); }))];
    (reco.duplicates || []).filter(xBook).forEach(function (b) {
      rows.push(ROW([C(b.cmpGstin || '', 'sMono'), C(b.party), C(b.gstin || '', 'sMono'), C(b.billNo, 'sMono'), C(b.vtype || ''), C(b.date || ''), C(b.amount || 0, 'sMoney'), C(b.igst || 0, 'sMoney'), C(b.cgst || 0, 'sMoney'), C(b.sgst || 0, 'sMoney'), C(b.tds || 0, 'sMoney'), C(b.tax || 0, 'sMoney'),
        C(b.kind === 'internal' ? 'Entered more than once in Tally (none in 2B yet)' : 'Already matched to the 2B document via another entry', 'sWrap')]));
    });
    sheets.push(['Possible Duplicates', '<Column ss:Width="120"/><Column ss:Width="170"/><Column ss:Width="120"/><Column ss:Width="110"/><Column ss:Width="100"/><Column ss:Width="72"/>' + '<Column ss:Width="90"/>'.repeat(6) + '<Column ss:Width="300"/>', rows]);
  })();

  // ---- Sheet 4: ITC at risk (in books, not in 2B) ----
  (function () {
    var rows = [ROW(['Regn', 'Supplier', 'GSTIN', 'Bill no', 'Voucher type', 'Date', 'Amount', 'IGST', 'CGST', 'SGST', 'GST comb', 'TDS', 'ITC total', 'Assessment'].map(function (x) { return C(x, 'sHead'); }))];
    var boX = (reco.booksOnly || []).filter(xBook);
    boX.forEach(function (b) {
      rows.push(ROW([C(b.cmpGstin || '', 'sMono'), C(b.party), C(b.gstin || '', 'sMono'), C(b.billNo, 'sMono'), C(b.vtype || ''), C(b.date || ''), C(b.amount || 0, 'sMoney'), C(b.igst || 0, 'sMoney'), C(b.cgst || 0, 'sMoney'), C(b.sgst || 0, 'sMoney'), C(b.gst || 0, 'sMoney'), C(b.tds || 0, 'sMoney'), C(b.tax || 0, 'sMoney'),
        C(b.supplierIn2b ? 'Supplier IS in this 2B - check number/value against their filed docs' : 'Supplier absent this month - likely appears in a later 2B', 'sWrap')]));
    });
    var n = boX.length;
    if (n) {
      var t = [C('TOTAL', 'sTotal'), C('', 'sTotal'), C('', 'sTotal'), C('', 'sTotal'), C('', 'sTotal'), C('', 'sTotal')];
      for (var i = 0; i < 7; i++) t.push(C(0, 'sTotalM', '=SUM(R[-' + n + ']C:R[-1]C)'));
      t.push(C('', 'sTotal'));
      rows.push(ROW(t));
    }
    sheets.push(['ITC at Risk', '<Column ss:Width="120"/><Column ss:Width="170"/><Column ss:Width="120"/><Column ss:Width="110"/><Column ss:Width="100"/><Column ss:Width="72"/>' + '<Column ss:Width="90"/>'.repeat(7) + '<Column ss:Width="300"/>', rows]);
  })();

  // ---- Sheet 5: Supplier gaps ----
  (function () {
    var rows = [ROW(['Regn', 'Supplier', 'GSTIN', '2B docs', '2B total (gross)', '2B taxable', 'Book entries', 'Books total', 'Gap (2B - books)'].map(function (x) { return C(x, 'sHead'); }))];
    ((S.supplierGaps) || []).filter(function (g) { return !xf || !g.own || g.own === xf; }).forEach(function (g) {
      rows.push(ROW([C(g.own || '', 'sMono'), C(g.supplier), C(g.gstin || '', 'sMono'), C(g.count2b || 0, 'sNum'), C(g.sum2b || 0, 'sMoney'), C(g.sum2bTaxable || 0, 'sMoney'), C(g.countBooks || 0, 'sNum'), C(g.sumBooks || 0, 'sMoney'), C(g.diff || 0, 'sMoneyBad', '=RC[-4]-RC[-1]')]));
    });
    sheets.push(['Supplier Gaps', '<Column ss:Width="120"/><Column ss:Width="190"/><Column ss:Width="120"/><Column ss:Width="60"/>' + '<Column ss:Width="100"/>'.repeat(5), rows]);
  })();

  // ---- Sheet 5A: Wrong Registration — booked under another state's GSTIN ----
  (function () {
    var wr = xDocs.filter(function (r) { return r.wrongReg; });
    if (!wr.length) return;
    var rows = [ROW(['Belongs to (per 2B)', 'Booked under', 'Supplier', 'GSTIN', 'Doc type', 'Doc no', 'Date', 'Taxable', 'IGST', 'CGST', 'SGST', 'Books voucher', 'Action'].map(function (x) { return C(x, 'sHead'); }))];
    wr.forEach(function (r) {
      var d = docBy[r.key] || {};
      rows.push(ROW([
        C(r.own || d.own || '', 'sMono'), C(r.wrongReg, 'sMono'), C(d.name || ''), C(d.gstin || '', 'sMono'),
        C(d.type || ''), C(d.no || '', 'sMono'), C(d.date || ''),
        C(taxableOf(d) || 0, 'sMoney'), C(d.igst || 0, 'sMoney'), C(d.cgst || 0, 'sMoney'), C(d.sgst || 0, 'sMoney'),
        C(r.bookRef || '', 'sMono'),
        C('Change the GST Registration on this voucher in Tally to ' + (r.own || d.own || 'the correct registration') + ' — do NOT book it again.', 'sWrap'),
      ]));
    });
    sheets.push(['Wrong Registration', '<Column ss:Width="120"/><Column ss:Width="120"/><Column ss:Width="170"/><Column ss:Width="120"/><Column ss:Width="70"/><Column ss:Width="110"/><Column ss:Width="72"/>' + '<Column ss:Width="85"/>'.repeat(4) + '<Column ss:Width="110"/><Column ss:Width="330"/>', rows]);
  })();

  // ---- Sheet 6: IMS actions — accept/reject/pending recommendation per doc ----
  (function () {
    var rows = [ROW(['Regn', 'Supplier', 'GSTIN', 'Doc type', 'Doc no', 'Date', '2B Value', 'ITC', 'Recon status', 'Recommended IMS action', 'Why'].map(function (x) { return C(x, 'sHead'); }))];
    xDocs.forEach(function (r) {
      var d = docBy[r.key] || {};
      var itc = r2((d.igst || 0) + (d.cgst || 0) + (d.sgst || 0) + (d.cess || 0));
      var act, why, stl;
      if (r.status === 'matched' || r.status === 'grouped') {
        act = 'ACCEPT'; stl = 'sOk';
        why = 'Matches the books' + (r.status === 'grouped' ? ' (supplier-level total)' : '') + ' — safe to accept.';
      } else if (r.status === 'mismatch') {
        act = 'PENDING'; stl = 'sWarn';
        why = 'Values differ from the books — verify the physical invoice before accepting.';
      } else if (r.status === 'probable') {
        act = 'PENDING'; stl = 'sWarn';
        why = 'Probably booked under a different number — confirm the pair first.';
      } else {
        act = 'PENDING'; stl = 'sBad';
        why = 'Not found in the books — book it in Tally, then accept. If the supplier/invoice is UNKNOWN to you, REJECT it (possible misuse of your GSTIN).';
      }
      if (r.eligible === false) why += ' Portal marks ITC as NOT available — credit is blocked either way.';
      rows.push(ROW([C(r.own || d.own || '', 'sMono'), C(d.name || ''), C(d.gstin || '', 'sMono'), C(d.type || ''), C(d.no || '', 'sMono'), C(d.date || ''),
        C(d.val || 0, 'sMoney'), C(itc, 'sMoney'), C(r.status), C(act, stl), C(why, 'sWrap')]));
    });
    sheets.push(['IMS Actions', '<Column ss:Width="120"/><Column ss:Width="170"/><Column ss:Width="120"/><Column ss:Width="70"/><Column ss:Width="110"/><Column ss:Width="72"/><Column ss:Width="90"/><Column ss:Width="90"/><Column ss:Width="80"/><Column ss:Width="95"/><Column ss:Width="380"/>', rows]);
  })();

  var styles = '<Styles>' +
    '<Style ss:ID="Default" ss:Name="Normal"><Font ss:FontName="Calibri" ss:Size="11"/><Alignment ss:Vertical="Top"/></Style>' +
    '<Style ss:ID="sTitle"><Font ss:Bold="1" ss:Size="14" ss:Color="#10243E"/></Style>' +
    '<Style ss:ID="sSection"><Font ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#10243E" ss:Pattern="Solid"/></Style>' +
    '<Style ss:ID="sHead"><Font ss:Bold="1"/><Interior ss:Color="#DCE6F1" ss:Pattern="Solid"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/></Borders><Alignment ss:Vertical="Bottom" ss:WrapText="1"/></Style>' +
    '<Style ss:ID="sLabel"><Font ss:Bold="1"/></Style>' +
    '<Style ss:ID="sMono"><Font ss:FontName="Consolas" ss:Size="10"/></Style>' +
    '<Style ss:ID="sNum"><NumberFormat ss:Format="#,##0"/></Style>' +
    '<Style ss:ID="sMoney"><NumberFormat ss:Format="#,##0.00"/></Style>' +
    '<Style ss:ID="sMoneyBad"><Font ss:Bold="1" ss:Color="#B3261E"/><NumberFormat ss:Format="#,##0.00"/></Style>' +
    '<Style ss:ID="sOk"><Font ss:Color="#0A7D33" ss:Bold="1"/></Style>' +
    '<Style ss:ID="sWarn"><Font ss:Color="#B06A00" ss:Bold="1"/></Style>' +
    '<Style ss:ID="sBad"><Font ss:Color="#B3261E" ss:Bold="1"/></Style>' +
    '<Style ss:ID="sWrap"><Alignment ss:Vertical="Top" ss:WrapText="1"/></Style>' +
    '<Style ss:ID="sTotal"><Font ss:Bold="1"/><Interior ss:Color="#EDEFF2" ss:Pattern="Solid"/><Borders><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2"/></Borders></Style>' +
    '<Style ss:ID="sTotalM"><Font ss:Bold="1"/><Interior ss:Color="#EDEFF2" ss:Pattern="Solid"/><NumberFormat ss:Format="#,##0.00"/><Borders><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2"/></Borders></Style>' +
    '</Styles>';

  var wb = '<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    styles +
    sheets.map(function (s) { return '<Worksheet ss:Name="' + XA(s[0]) + '"><Table>' + s[1] + s[2].join('') + '</Table></Worksheet>'; }).join('') +
    '</Workbook>';
  var blob = new Blob([wb], { type: 'application/vnd.ms-excel' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'gstr2b-tally-recon-' + Object.keys(periods).join('-').replace(/[^A-Za-z0-9-]/g, '') + (xf ? '-' + xf : '') + '.xls';
  a.click();
  URL.revokeObjectURL(a.href);
}

function selectNotBooked() {
  var n = 0;
  docs.forEach(function (d) {
    var k = key(d);
    if (!matchesFilter(d)) return;
    if (reco && reco.byKey[k] && reco.byKey[k].st === 'notbooked' && !reco.byKey[k].gap && !postedReg[k] && !d.amended) { selected[k] = true; n++; }
  });
  renderDocs();
  document.getElementById('bar-msg').textContent = n + ' not-booked document(s) selected — review, then ▶ Post to Tally.';
}

var pickNotes = '';
function pickSelected() {
  var out = [], missing = 0, already = 0, zero = 0, amended = 0, mismatched = 0, gapped = 0;
  docs.forEach(function (d) {
    var k = key(d);
    if (!selected[k]) return;
    if (d.amended) { amended++; return; }
    if (postedReg[k]) { already++; return; }
    // MISMATCH = exists in Tally with different figures; PROBABLE = likely the
    // same document under another number. Posting either would duplicate the
    // entry — resolve in Tally (or confirm the probable pair) instead.
    var rst = reco && reco.byKey[k] && reco.byKey[k].st;
    if (rst === 'mismatch' || rst === 'probable') { mismatched++; return; }
    // Its month never came back from Tally — the double-entry guard would be
    // blind there too, so posting could duplicate an unseen booking.
    if (reco && reco.byKey[k] && reco.byKey[k].gap) { gapped++; return; }
    if (partyAmountOf(d) <= 0) { zero++; return; }
    var m = mappings[d.gstin];
    if (!m || !m.ledger) { missing++; return; }
    out.push(d);
  });
  return { docs: out, missing: missing, already: already, zero: zero, amended: amended, mismatched: mismatched, gapped: gapped };
}
function precheck() {
  var missing = [];
  if (!String(settings.purchaseLedger || '').trim()) missing.push('Purchase ledger');
  if (!String(settings.igstLedger || '').trim()) missing.push('Input IGST ledger');
  if (!String(settings.cgstLedger || '').trim()) missing.push('Input CGST ledger');
  if (!String(settings.sgstLedger || '').trim()) missing.push('Input SGST ledger');
  if (missing.length) {
    document.getElementById('bar-msg').innerHTML =
      '<b style="color:var(--bad)">Cannot post — missing under Settings: ' + missing.join(', ') + '. Fill them in and click Save settings.</b>';
    document.getElementById('settings-box').open = true;
    document.getElementById('settings-box').scrollIntoView({ behavior: 'smooth' });
    return null;
  }
  var pick = pickSelected();
  var msg = [];
  if (pick.already) msg.push(pick.already + ' skipped (already posted)');
  if (pick.missing) msg.push(pick.missing + ' skipped (supplier not mapped)');
  if (pick.zero) msg.push(pick.zero + ' skipped (zero value)');
  if (pick.amended) msg.push(pick.amended + ' skipped (amended — adjust in Tally manually)');
  if (pick.mismatched) msg.push(pick.mismatched + ' skipped (mismatch/probable — resolve in Tally first)');
  if (pick.gapped) msg.push(pick.gapped + ' skipped (their month was NOT read from Tally — widen Alt+F2 and reconcile before posting)');
  pickNotes = msg.join(' · ');
  document.getElementById('bar-msg').textContent = msg.join(' · ');
  if (!pick.docs.length) {
    document.getElementById('bar-msg').textContent =
      (msg.length ? msg.join(' · ') + ' — ' : '') + 'nothing to do. Tick pending, mapped documents.';
    return null;
  }
  return pick.docs;
}

async function postSelected() {
  var list = precheck();
  if (!list) return;
  // Single-party panel choices persist to the party's mapping BEFORE posting
  // (so ledger auto-create and the vouchers use them consistently).
  var selGstins = [...new Set(list.map(function (d) { return d.gstin; }))];
  if (selGstins.length === 1) {
    var pm = mappings[selGstins[0]] || (mappings[selGstins[0]] = { ledger: list[0].name, autoCreate: true });
    var pv = povr('pp-party');
    var pu = povr('pp-purchase');
    var dirty = false;
    if (pv && pv !== pm.ledger) { pm.ledger = pv; dirty = true; }
    if (pu && pu !== pm.purchaseLedger) { pm.purchaseLedger = pu; pm.purchaseLedgerManual = true; dirty = true; }
    if (dirty) { pushMappings(); renderMappings(); }
  }
  activeOvr = ovrNow(); // panel re-renders as rows complete — freeze the choices
  var btn = document.getElementById('post-btn');
  btn.disabled = true;

  // Double-entry guard: read what is ALREADY in Tally around these dates
  // (wide window, in case the entry was keyed in on a different day) and
  // skip anything that matches. If Tally can't be read, post nothing.
  document.getElementById('bar-msg').textContent = 'Checking Tally for entries already on the books…';
  var dates = list.map(function (d) { return d.date; }).sort();
  var idx = await tallyIndex(shiftDate(dates[0], -60), shiftDate(dates[dates.length - 1], 60));
  if (!idx.ok) {
    btn.disabled = false;
    document.getElementById('bar-msg').textContent =
      'Could not verify against Tally, so nothing was posted — ' + idx.error;
    return;
  }

  var okCount = 0, failCount = 0, dupCount = 0;
  var mastersDone = {};
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    var k = key(d);
    var m = mappings[d.gstin];
    var p = normKey(m.ledger);
    if (idx.numParty[normKey(d.no) + '|' + p] ||
        idx.pad[p + '|' + partyAmountOf(d).toFixed(2) + '|' + d.date.replace(/-/g, '')]) {
      live[k] = { status: 'dup' };
      postedReg[k] = { at: new Date().toISOString() };
      delete selected[k];
      dupCount++;
      fetch('/api/posted', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ entries: [{ key: k, meta: { period: d.period, docNo: d.no, supplier: d.name, via: 'found-in-tally' } }] }) });
      renderDocs();
      continue;
    }
    live[k] = { status: 'posting' };
    renderDocs();
    try {
      // Create the party ledger when the mapping asks for it OR when Tally's
      // own ledger list says it is missing (restored company / new company —
      // the stored flag can be stale, Tally is the truth).
      var needMaster = !mastersDone[d.gstin] && (m.autoCreate || !ledgerKnown(m.ledger));
      if (needMaster) {
        var mr = await fetch('/api/tally', { method:'POST', headers:{'content-type':'application/json'},
          body: JSON.stringify({ kind:'master', xml: envelope([ledgerXml(m.ledger, d.gstin)], 'All Masters') }) }).then(function (r) { return r.json(); });
        if (!mr.ok) throw new Error('Could not create ledger "' + m.ledger + '": ' + (mr.error || 'unknown'));
        mastersDone[d.gstin] = true;
        ledgerSet[normKey(m.ledger)] = true;
        m.autoCreate = false;
        pushMappings();
      }
      var vr = await fetch('/api/tally', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ kind:'voucher', xml: envelope([voucherXml(d, m.ledger)], 'Vouchers') }) }).then(function (r) { return r.json(); });
      // Tally says the party ledger is missing even though we thought it
      // existed — create it and retry this voucher once.
      if (!vr.ok && !mastersDone[d.gstin]) {
        var miss = /ledger\s*'([^']+)'\s*does not exist/i.exec(vr.error || '');
        if (miss && normKey(miss[1]) === normKey(m.ledger)) {
          var mr2 = await fetch('/api/tally', { method:'POST', headers:{'content-type':'application/json'},
            body: JSON.stringify({ kind:'master', xml: envelope([ledgerXml(m.ledger, d.gstin)], 'All Masters') }) }).then(function (r) { return r.json(); });
          if (mr2.ok) {
            mastersDone[d.gstin] = true;
            ledgerSet[normKey(m.ledger)] = true;
            vr = await fetch('/api/tally', { method:'POST', headers:{'content-type':'application/json'},
              body: JSON.stringify({ kind:'voucher', xml: envelope([voucherXml(d, m.ledger)], 'Vouchers') }) }).then(function (r) { return r.json(); });
          }
        }
      }
      // Tally "Internal Error / Record insertion failure": on Edit Log builds
      // an internal id used before (posted & deleted earlier, or a restored
      // backup) can refuse re-insertion — retry ONCE under a fresh id. The
      // duplicate guard above already confirmed nothing matching is on file.
      var usedRid = null;
      if (!vr.ok && tallyInternalErr(vr.error)) {
        usedRid = (remoteIdOf(d) + '-R2').slice(0, 64);
        vr = await fetch('/api/tally', { method:'POST', headers:{'content-type':'application/json'},
          body: JSON.stringify({ kind:'voucher', xml: envelope([voucherXml(d, m.ledger, usedRid)], 'Vouchers') }) }).then(function (r) { return r.json(); });
      }
      if (!vr.ok) throw new Error((vr.error || 'Tally rejected the voucher') + (tallyInternalErr(vr.error) ? TALLY_ERR_HELP : ''));
      live[k] = { status: 'ok' };
      okCount++;
      var meta = { period: d.period, docNo: d.no, supplier: d.name, total: r2(d.txval + d.igst + d.cgst + d.sgst + d.cess),
        remoteId: usedRid || remoteIdOf(d), vch: vchTypeOf(d), dt: d.date.replace(/-/g, '') };
      postedReg[k] = Object.assign({ at: new Date().toISOString() }, meta);
      delete selected[k];
      await fetch('/api/posted', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ entries: [{ key: k, meta: meta }] }) });
    } catch (err) {
      live[k] = { status: 'fail', error: String(err.message || err) };
      failCount++;
      // A Tally internal error blocks its whole XML port behind the error
      // dialog — pushing the rest of the batch would only pile up timeouts.
      // A timeout mid-batch means the same thing: Tally has stopped answering.
      if (tallyInternalErr(err.message || err) || /timed?\s*out|timeouterror|aborted/i.test(String(err.message || err))) {
        renderDocs();
        btn.disabled = false;
        activeOvr = null;
        document.getElementById('bar-msg').innerHTML =
          '<b style="color:var(--bad)">🛑 Posting stopped after ' + okCount + ' — TALLY raised an internal error ("Record insertion failure") or stopped answering (an error box is probably open IN Tally).</b> ' +
          'Click OK on the error box IN TALLY, return to the Gateway of Tally, then try ONE entry. If it repeats: back up, REWRITE the data (Select Company screen → Ctrl+Alt+R), and update TallyPrime to the latest release (common on Edit Log versions). The remaining documents stay selected.';
        return;
      }
    }
    renderDocs();
  }
  btn.disabled = false;
  activeOvr = null;
  document.getElementById('bar-msg').textContent = '✓ ' + okCount + ' posted into Tally' +
    (dupCount ? ', ' + dupCount + ' skipped — matching entry already in Tally' : '') +
    (failCount ? ', ' + failCount + ' rejected (see Status column)' : '') + '.' +
    (pickNotes ? ' Also: ' + pickNotes + '.' : '');
}

function downloadXml() {
  var list = precheck();
  if (!list) return;
  activeOvr = ovrNow();
  try {
  var masters = [], vouchers = [], mastersDone = {}, keys = [];
  list.forEach(function (d) {
    var m = mappings[d.gstin];
    if ((m.autoCreate || !ledgerKnown(m.ledger)) && !mastersDone[d.gstin]) { mastersDone[d.gstin] = true; masters.push(ledgerXml(m.ledger, d.gstin)); }
    vouchers.push(voucherXml(d, m.ledger));
    keys.push(key(d));
  });
  var xml = envelope(masters.concat(vouchers), 'Vouchers');
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([xml], { type: 'text/xml' }));
  a.download = 'gstr2b-tally-import.xml';
  a.click();
  // Mark as posted so they aren't accidentally posted twice; un-mark if the
  // file is never imported.
  var entries = [];
  list.forEach(function (d) {
    var k = key(d);
    var meta = { period: d.period, docNo: d.no, supplier: d.name, via: 'xml-download',
      remoteId: remoteIdOf(d), vch: vchTypeOf(d), dt: d.date.replace(/-/g, '') };
    postedReg[k] = Object.assign({ at: new Date().toISOString() }, meta);
    live[k] = { status: 'ok' };
    delete selected[k];
    entries.push({ key: k, meta: meta });
  });
  fetch('/api/posted', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ entries: entries }) });
  Object.keys(mastersDone).forEach(function (g) { mappings[g].autoCreate = false; });
  pushMappings();
  renderDocs();
  document.getElementById('bar-msg').textContent = '✓ ' + vouchers.length + ' voucher(s) in the XML — import in Tally via Alt+O → Import → Vouchers. Marked posted here.';
  } finally { activeOvr = null; }
}

// ------------------------------ manual entry ------------------------------
var mlines = [];
function blankLine() { return { ledger: '', dc: 'D', amount: '', billRef: '', billType: 'New Ref' }; }
function addLine() { mlines.push(blankLine()); renderLines(); }
function rmLine(i) { mlines.splice(i, 1); if (!mlines.length) mlines.push(blankLine()); renderLines(); }
function lnSet(i, k, v) { mlines[i][k] = v; updateTotals(); }
function typeChanged() {
  var custom = document.getElementById('m-type').value === '__custom';
  document.getElementById('m-type-custom').style.display = custom ? '' : 'none';
}
var vchTypeList = [];
function loadVchTypes() {
  fetch('/api/vouchertypes').then(function (r) { return r.json(); }).then(function (j) {
    if (!j.ok || !(j.types || []).length) return;
    vchTypeList = j.types;
    var sel = document.getElementById('m-type');
    var cur = sel.value;
    var h = '';
    j.types.forEach(function (t) { h += '<option value="' + escAttr(t) + '">' + esc(t) + '</option>'; });
    h += '<option value="__custom">Custom…</option>';
    sel.innerHTML = h;
    // keep the previous choice if it still exists, else prefer Purchase
    var names = j.types;
    sel.value = names.indexOf(cur) >= 0 ? cur : (names.indexOf('Purchase') >= 0 ? 'Purchase' : names[0]);
    typeChanged();
  });
}
function renderLines() {
  var h = '<tr><th style="width:38%">Ledger</th><th>Dr / Cr</th><th class="r">Amount ₹</th>' +
    '<th>Bill ref (optional)</th><th>Bill type</th><th></th></tr>';
  mlines.forEach(function (l, i) {
    h += '<tr>' +
      '<td><input type="text" list="ledger-list" value="' + escAttr(l.ledger) + '" placeholder="exact Tally ledger name" oninput="lnSet(' + i + ',\\'ledger\\',this.value)"></td>' +
      '<td><select onchange="lnSet(' + i + ',\\'dc\\',this.value)" style="padding:6px;border:1px solid var(--line);border-radius:7px;font:inherit">' +
        '<option value="D"' + (l.dc === 'D' ? ' selected' : '') + '>Dr</option>' +
        '<option value="C"' + (l.dc === 'C' ? ' selected' : '') + '>Cr</option></select></td>' +
      '<td class="r"><input type="text" value="' + escAttr(l.amount) + '" style="text-align:right" placeholder="0.00" oninput="lnSet(' + i + ',\\'amount\\',this.value)"></td>' +
      '<td><input type="text" value="' + escAttr(l.billRef) + '" placeholder="—" oninput="lnSet(' + i + ',\\'billRef\\',this.value)"></td>' +
      '<td><select onchange="lnSet(' + i + ',\\'billType\\',this.value)" style="padding:6px;border:1px solid var(--line);border-radius:7px;font:inherit">' +
        '<option' + (l.billType === 'New Ref' ? ' selected' : '') + '>New Ref</option>' +
        '<option' + (l.billType === 'Agst Ref' ? ' selected' : '') + '>Agst Ref</option>' +
        '<option' + (l.billType === 'Advance' ? ' selected' : '') + '>Advance</option>' +
        '<option' + (l.billType === 'On Account' ? ' selected' : '') + '>On Account</option></select></td>' +
      '<td><button class="btn danger" style="padding:4px 9px" onclick="rmLine(' + i + ')" title="remove line">✕</button></td></tr>';
  });
  document.getElementById('m-lines').innerHTML = h;
  updateTotals();
}
function numOf(v) { var n = Number(String(v).replace(/[₹,\\s]/g, '')); return isFinite(n) ? n : 0; }
function manualTotals() {
  var dr = 0, cr = 0;
  mlines.forEach(function (l) {
    var a = numOf(l.amount);
    if (!l.ledger.trim() || a <= 0) return;
    if (l.dc === 'D') dr += a; else cr += a;
  });
  return { dr: r2(dr), cr: r2(cr), diff: r2(dr - cr) };
}
function updateTotals() {
  var t = manualTotals();
  var el = document.getElementById('m-totals');
  el.innerHTML = 'Dr ₹' + inr(t.dr) + ' · Cr ₹' + inr(t.cr) +
    (Math.abs(t.diff) > 0.005
      ? ' · <b style="color:var(--bad)">difference ₹' + inr(Math.abs(t.diff)) + ' — must be zero</b>'
      : (t.dr > 0 ? ' · <b style="color:var(--ok)">balanced ✓</b>' : ''));
}
function buildManual(remoteId) {
  var typeSel = document.getElementById('m-type').value;
  var vch = typeSel === '__custom' ? document.getElementById('m-type-custom').value.trim() : typeSel;
  var dateIso = document.getElementById('m-date').value;
  var no = document.getElementById('m-no').value.trim();
  var narr = document.getElementById('m-narr').value.trim();
  if (!vch) return { error: 'Enter the custom voucher type name.' };
  if (!dateIso) return { error: 'Pick the voucher date.' };
  var lines = mlines.filter(function (l) { return l.ledger.trim() && numOf(l.amount) > 0; });
  if (lines.length < 2) return { error: 'Enter at least two lines (a debit and a credit).' };
  var t = manualTotals();
  if (Math.abs(t.diff) > 0.005) return { error: 'Voucher does not balance — Dr and Cr must be equal.' };
  var date = dateIso.replace(/-/g, '');
  var body = '';
  lines.forEach(function (l) {
    var a = numOf(l.amount);
    body += lineXml(l.ledger.trim(), l.dc === 'D' ? -a : a, l.billRef.trim() || null, l.billType);
  });
  // Party ledger: the explicit pick wins; else derived from the lines.
  var party = document.getElementById('m-party').value.trim();
  if (!party) {
    var wantCredit = vch === 'Purchase' || vch === 'Debit Note' || vch === 'Payment';
    var wantDebit = vch === 'Sales' || vch === 'Credit Note' || vch === 'Receipt';
    if (wantCredit || wantDebit) {
      var p = lines.filter(function (l) { return l.dc === (wantCredit ? 'C' : 'D'); })[0];
      if (p) party = p.ledger.trim();
    }
  }
  var xml = '<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ' + (remoteId ? 'REMOTEID="' + escAttr(remoteId) + '" ' : '') + 'VCHTYPE="' + escAttr(vch) + '" ACTION="Create" OBJVIEW="Accounting Voucher View">' +
    '<DATE>' + date + '</DATE><EFFECTIVEDATE>' + date + '</EFFECTIVEDATE>' +
    '<VOUCHERTYPENAME>' + esc(vch) + '</VOUCHERTYPENAME>' +
    (no ? '<VOUCHERNUMBER>' + esc(no) + '</VOUCHERNUMBER><REFERENCE>' + esc(no) + '</REFERENCE>' : '') +
    (party ? '<PARTYLEDGERNAME>' + esc(party) + '</PARTYLEDGERNAME>' : '') +
    '<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>' +
    (narr ? '<NARRATION>' + esc(narr) + '</NARRATION>' : '') +
    body + '</VOUCHER></TALLYMESSAGE>';
  return { xml: xml, vch: vch, date: dateIso, no: no, total: t.dr, party: party };
}
async function postManual() {
  var rid = 'G2BM-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  var b = buildManual(rid);
  var msg = document.getElementById('m-msg');
  if (b.error) { msg.innerHTML = '<span class="msg bad">' + esc(b.error) + '</span>'; return; }
  var btn = document.getElementById('m-post');
  btn.disabled = true;

  // Double-entry guard: look a month either side in Tally before posting.
  msg.innerHTML = '<span class="pill warn">Checking Tally for duplicates…</span>';
  var idx = await tallyIndex(shiftDate(b.date, -30), shiftDate(b.date, 30));
  if (!idx.ok) {
    btn.disabled = false;
    msg.innerHTML = '<span class="msg bad">Could not verify against Tally, so nothing was posted — ' + esc(idx.error) + '</span>';
    return;
  }
  var dup = '';
  if (b.no && idx.numAny[normKey(b.no)]) {
    dup = 'Voucher / reference number "' + b.no + '" already exists in Tally in this period.';
  } else if (b.party && idx.pad[normKey(b.party) + '|' + b.total.toFixed(2) + '|' + b.date.replace(/-/g, '')]) {
    dup = 'Tally already has a voucher for ' + b.party + ' of ₹' + inr(b.total) + ' dated ' + b.date + '.';
  }
  if (dup && !confirm(dup + '\\n\\nThis looks like a double entry. Post anyway?')) {
    btn.disabled = false;
    msg.innerHTML = '<span class="msg bad">Not posted — ' + esc(dup) + '</span>';
    return;
  }

  msg.innerHTML = '<span class="pill warn">Posting…</span>';
  var vr = await fetch('/api/tally', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ kind:'voucher', xml: envelope([b.xml], 'Vouchers') }) }).then(function (r) { return r.json(); });
  btn.disabled = false;
  var entry = { at: new Date().toISOString(), type: b.vch, date: b.date, no: b.no, total: b.total, ok: !!vr.ok, error: vr.error || '', remoteId: vr.ok ? rid : '' };
  manualLog.unshift(entry);
  fetch('/api/log', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ entry: entry }) });
  renderManualLog();
  if (vr.ok) {
    msg.innerHTML = '<span class="msg ok">✓ ' + esc(b.vch) + ' voucher for ₹' + inr(b.total) + ' posted into Tally.</span>';
    mlines = [blankLine(), blankLine()];
    document.getElementById('m-no').value = '';
    document.getElementById('m-narr').value = '';
    renderLines();
  } else {
    msg.innerHTML = '<span class="msg bad">' + esc((vr.error || 'Tally rejected the voucher') + (tallyInternalErr(vr.error) ? TALLY_ERR_HELP : '')) + '</span>';
  }
}
function downloadManual() {
  var b = buildManual('');
  var msg = document.getElementById('m-msg');
  if (b.error) { msg.innerHTML = '<span class="msg bad">' + esc(b.error) + '</span>'; return; }
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([envelope([b.xml], 'Vouchers')], { type: 'text/xml' }));
  a.download = 'manual-voucher.xml';
  a.click();
  msg.innerHTML = '<span class="msg ok">✓ XML downloaded — import in Tally via Alt+O → Import → Vouchers.</span>';
}
function dutyLedgerXml(name) {
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="' + escAttr(name) + '" ACTION="Create">' +
    '<NAME.LIST><NAME>' + esc(name) + '</NAME></NAME.LIST><PARENT>Duties &amp; Taxes</PARENT></LEDGER></TALLYMESSAGE>';
}
// RCM totals per return period, broken down PARTY-WISE (notes subtract).
function rcmGroups() {
  var by = {};
  var multi = ownList().length > 1;
  docs.forEach(function (d) {
    if (!d.rcm) return;
    // RCM liability is per REGISTRATION — separate journals per state, and
    // the registration chips filter this card like everything else.
    if (regFilter && d.own !== regFilter) return;
    var sign = d.type === 'creditnote' ? -1 : 1;
    var pk = multi ? d.period + '|' + (d.own || '') : d.period;
    var P = by[pk] = by[pk] || { n: 0, tx: 0, igst: 0, cgst: 0, sgst: 0, parties: {}, period: d.period, ownReg: multi ? (d.own || '') : '' };
    var g = P.parties[d.gstin] = P.parties[d.gstin] || { name: d.name, n: 0, tx: 0, igst: 0, cgst: 0, sgst: 0 };
    [P, g].forEach(function (b) {
      b.n++;
      b.tx = r2(b.tx + sign * taxableOf(d));
      b.igst = r2(b.igst + sign * d.igst);
      b.cgst = r2(b.cgst + sign * d.cgst);
      b.sgst = r2(b.sgst + sign * d.sgst);
    });
  });
  return by;
}
function rcmJournalId(p, g) { return 'G2BRCM-' + p + '-' + g; }
function rcmDone(p, g) {
  var id = rcmJournalId(p, g);
  return manualLog.some(function (e) { return e.remoteId === id && e.ok && !e.deleted; });
}
function renderRcm() {
  var host = document.getElementById('rcm-card');
  var by = rcmGroups();
  var periods = Object.keys(by).sort();
  if (!periods.length) { host.innerHTML = ''; return; }
  var h = '<div class="card card-pad" style="padding:14px 18px"><details><summary style="cursor:pointer;font-weight:600;font-size:14.5px">' +
    'RCM — reverse charge liability, party-wise (GSTR-3B Table 3.1(d))</summary>' +
    '<p class="muted" style="font-size:12.5px;margin:8px 0">RCM purchase vouchers book only the taxable value against the supplier. ' +
    'Post one journal PER PARTY (Dr Input GST, Cr RCM Payable — with the "Increase in Tax Liability & Input Tax Credit / Purchase Under Reverse Charge" stat flags), pay the tax in cash through GSTR-3B, and the ITC comes back the same month.</p>' +
    '<div class="tbl-scroll"><table><tr><th>Month / Party</th><th class="r">Docs</th><th class="r">Taxable (3.1d) ₹</th><th class="r">IGST ₹</th><th class="r">CGST ₹</th><th class="r">SGST ₹</th><th class="r">Tax total ₹</th><th></th></tr>';
  periods.forEach(function (p) {
    var P = by[p];
    var mtax = r2(P.igst + P.cgst + P.sgst);
    var gs = Object.keys(P.parties).sort(function (a, b) { return P.parties[a].name.localeCompare(P.parties[b].name); });
    var pendingParties = gs.filter(function (g) {
      var b = P.parties[g];
      return r2(b.igst + b.cgst + b.sgst) > 0 && !rcmDone(p, g);
    });
    h += '<tr style="background:var(--bg)"><td><b>' + esc(periodLabel(P.period || p)) + (P.ownReg ? ' <span class="muted mono" style="font-size:11px">for ' + esc(P.ownReg) + '</span>' : '') + '</b></td><td class="r"><b>' + P.n + '</b></td>' +
      '<td class="r"><b>' + inr(P.tx) + '</b></td><td class="r"><b>' + inr(P.igst) + '</b></td><td class="r"><b>' + inr(P.cgst) + '</b></td>' +
      '<td class="r"><b>' + inr(P.sgst) + '</b></td><td class="r"><b>' + inr(mtax) + '</b></td>' +
      '<td>' + (pendingParties.length
        ? '<button type="button" class="btn primary" style="padding:4px 12px;font-size:12px" data-p="' + escAttr(p) + '" onclick="postRcmAll(this.dataset.p)">▶ Post all ' + pendingParties.length + ' journal(s)</button>'
        : mtax > 0 ? '<span class="pill ok">All journals posted</span>' : '<span class="muted">no tax</span>') + '</td></tr>';
    gs.forEach(function (g) {
      var b = P.parties[g];
      var tax = r2(b.igst + b.cgst + b.sgst);
      h += '<tr><td style="padding-left:26px">' + esc(b.name) + '<div class="muted mono" style="font-size:11px">' + esc(g) + '</div></td>' +
        '<td class="r">' + b.n + '</td><td class="r">' + inr(b.tx) + '</td><td class="r">' + inr(b.igst) + '</td>' +
        '<td class="r">' + inr(b.cgst) + '</td><td class="r">' + inr(b.sgst) + '</td><td class="r">' + inr(tax) + '</td>' +
        '<td>' + (rcmDone(p, g) ? '<span class="pill ok">Journal posted</span>'
          : tax > 0 ? '<button type="button" class="btn" style="padding:3px 10px;font-size:12px" data-p="' + escAttr(p) + '" data-g="' + escAttr(g) + '" onclick="postRcmJournal(this.dataset.p, this.dataset.g)">▶ Post journal</button>'
          : '<span class="muted">no tax</span>') + '</td></tr>';
    });
  });
  host.innerHTML = h + '</table></div></details></div>';
}
async function postRcmJournalInner(p, g, skipConfirm) {
  var by = rcmGroups();
  var P = by[p];
  var b = P && P.parties[g];
  if (!b) return false;
  var heads = [
    [b.igst, settings.igstLedger, settings.rcmIgstLedger, 'IGST'],
    [b.cgst, settings.cgstLedger, settings.rcmCgstLedger, 'CGST'],
    [b.sgst, settings.sgstLedger, settings.rcmSgstLedger, 'SGST'],
  ].filter(function (x) { return x[0] > 0; });
  if (!heads.length) return false;
  var missing = heads.filter(function (x) { return !String(x[2] || '').trim(); }).map(function (x) { return x[3]; });
  if (missing.length) {
    alert('Fill the RCM payable ledger name(s) under Settings first: ' + missing.join(', '));
    document.getElementById('settings-box').open = true;
    return false;
  }
  var per = (P && P.period) || String(p).split('|')[0];
  var forReg = (P && P.ownReg) ? ' [' + P.ownReg + ']' : '';
  var tax = r2(heads.reduce(function (s, x) { return s + x[0]; }, 0));
  if (!skipConfirm && !confirm('Post the RCM liability journal for ' + b.name + ' — ' + periodLabel(per) + forReg + '? Dr Input GST ' + inr(tax) + ' / Cr RCM Payable ' + inr(tax) + ' (3.1(d) taxable ' + inr(b.tx) + ').')) return false;
  for (var i = 0; i < heads.length; i++) {
    var ln = heads[i][2];
    if (!ledgerKnown(ln)) {
      var mr = await fetch('/api/tally', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ kind:'master', xml: envelope([dutyLedgerXml(ln)], 'All Masters') }) }).then(function (r) { return r.json(); });
      if (mr.ok) ledgerSet[normKey(ln)] = true;
    }
  }
  var mm = +per.slice(0, 2), yy = +per.slice(2);
  var lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  var ymd = String(yy) + String(mm).padStart(2, '0') + String(lastDay).padStart(2, '0');
  var lines = '';
  heads.forEach(function (x) { lines += lineXml(x[1], -x[0], null); });
  heads.forEach(function (x) { lines += lineXml(x[2], x[0], null); });
  var rid = rcmJournalId(p, g);
  var narr = 'RCM liability on ' + b.n + ' inward supplies from ' + b.name + ' (' + g + ') as per GSTR-2B ' + periodLabel(per) + forReg + ' — GSTR-3B 3.1(d) taxable ' + inr(b.tx);
  var xml = '<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="' + escAttr(rid) + '" VCHTYPE="Journal" ACTION="Create" OBJVIEW="Accounting Voucher View">' +
    '<DATE>' + ymd + '</DATE><EFFECTIVEDATE>' + ymd + '</EFFECTIVEDATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>' +
    '<NATUREOFADJUSTMENT>' + esc('Increase In Tax Liability & Input Tax Credit') + '</NATUREOFADJUSTMENT>' +
    '<ADDLNATUREOFADJUSTMENT>' + esc('Purchase Under Reverse Charge from Registered Dealer') + '</ADDLNATUREOFADJUSTMENT>' +
    '<PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW><ISINVOICE>No</ISINVOICE>' +
    '<NARRATION>' + esc(narr) + '</NARRATION>' + lines + '</VOUCHER></TALLYMESSAGE>';
  var vr = await fetch('/api/tally', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ kind:'voucher', xml: envelope([xml], 'Vouchers') }) }).then(function (r) { return r.json(); });
  var entry = { at: new Date().toISOString(), type: 'RCM Journal', date: ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8),
    no: 'RCM ' + b.name.slice(0, 18) + ' ' + periodLabel(p), total: tax, ok: !!vr.ok, error: vr.error || '', remoteId: vr.ok ? rid : '' };
  manualLog.unshift(entry);
  fetch('/api/log', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ entry: entry }) });
  if (!vr.ok) alert('Tally rejected the RCM journal for ' + b.name + ': ' + (vr.error || 'unknown') + (tallyInternalErr(vr.error) ? TALLY_ERR_HELP : ''));
  return !!vr.ok;
}
async function postRcmJournal(p, g) {
  await postRcmJournalInner(p, g, false);
  renderManualLog();
  renderRcm();
}
async function postRcmAll(p) {
  var by = rcmGroups();
  var P = by[p];
  if (!P) return;
  var gs = Object.keys(P.parties).filter(function (g) {
    var b = P.parties[g];
    return r2(b.igst + b.cgst + b.sgst) > 0 && !rcmDone(p, g);
  });
  if (!gs.length) return;
  var tax = r2(gs.reduce(function (s, g) { var b = P.parties[g]; return s + b.igst + b.cgst + b.sgst; }, 0));
  if (!confirm('Post ' + gs.length + ' party-wise RCM liability journal(s) for ' + periodLabel(p) + '? Total tax ' + inr(tax) + '.')) return;
  var ok = 0;
  for (var i = 0; i < gs.length; i++) {
    if (await postRcmJournalInner(p, gs[i], true)) ok++;
    renderRcm();
  }
  renderManualLog();
  document.getElementById('bar-msg').textContent = '✓ ' + ok + ' of ' + gs.length + ' RCM journal(s) posted for ' + periodLabel(p) + '.';
}
function delVoucherXml(remoteId, vch, dateYmd, no) {
  return '<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="' + escAttr(remoteId) + '" VCHTYPE="' + escAttr(vch) + '" ACTION="Delete">' +
    '<DATE>' + dateYmd + '</DATE><VOUCHERTYPENAME>' + esc(vch) + '</VOUCHERTYPENAME>' +
    (no ? '<VOUCHERNUMBER>' + esc(no) + '</VOUCHERNUMBER>' : '') + '</VOUCHER></TALLYMESSAGE>';
}
async function deleteManual(i) {
  var e = manualLog[i];
  if (!e || !e.remoteId || e.deleted) return;
  if (!confirm('Delete this ' + e.type + ' voucher (' + (e.no || 'auto no') + ', ₹' + inr(e.total || 0) + ') from Tally?')) return;
  var vr = await fetch('/api/tally', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ kind:'delete', xml: envelope([delVoucherXml(e.remoteId, e.type, e.date.replace(/-/g, ''), e.no)], 'Vouchers') }) })
    .then(function (r) { return r.json(); });
  var msg = document.getElementById('m-msg');
  if (vr.ok) {
    e.deleted = true;
    fetch('/api/log', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ markDeleted: e.remoteId }) });
    renderManualLog();
    msg.innerHTML = '<span class="msg ok">✓ Voucher deleted from Tally.</span>';
  } else {
    msg.innerHTML = '<span class="msg bad">' + esc(vr.error || 'Could not delete') + '</span>';
  }
}
var manualLog = [];
function renderManualLog() {
  var host = document.getElementById('m-log');
  if (!manualLog.length) { host.innerHTML = ''; return; }
  var h = '<div class="muted" style="margin-bottom:4px">Recent manual entries</div><table><tr><th>When</th><th>Type</th><th>Date</th><th>No</th><th class="r">Amount ₹</th><th>Result</th><th></th></tr>';
  manualLog.slice(0, 8).forEach(function (e, i) {
    h += '<tr><td class="muted">' + new Date(e.at).toLocaleString('en-IN') + '</td><td>' + esc(e.type) + '</td>' +
      '<td>' + esc(e.date) + '</td><td>' + esc(e.no || '—') + '</td><td class="r">' + inr(e.total || 0) + '</td>' +
      '<td>' + (e.deleted ? '<span class="pill idle">Deleted</span>' : e.ok ? '<span class="pill ok">Posted</span>' : '<span class="pill bad" title="' + escAttr(e.error || '') + '">Rejected</span>') + '</td>' +
      '<td>' + (e.ok && e.remoteId && !e.deleted ? '<button type="button" class="btn danger" style="padding:2px 8px;font-size:11px" onclick="deleteManual(' + i + ')">Delete from Tally</button>' : '') + '</td></tr>';
  });
  host.innerHTML = h + '</table>';
}
var ledgerSet = {};   // normalised name -> true, from the live Tally ledger list
function ledgerKnown(name) {
  // Only trust the check when a list actually loaded.
  return Object.keys(ledgerSet).length === 0 || !!ledgerSet[normKey(name)];
}
function loadLedgers(manual) {
  fetch('/api/ledgers').then(function (r) { return r.json(); }).then(function (j) {
    ledgerSet = {};
    (j.ledgers || []).forEach(function (n) { ledgerSet[normKey(n)] = true; });
    var dl = document.getElementById('ledger-list');
    dl.innerHTML = (j.ledgers || []).map(function (n) { return '<option value="' + escAttr(n) + '"></option>'; }).join('');
    var c = document.getElementById('ledger-count');
    c.textContent = j.ok ? '(' + j.ledgers.length + ' ledgers loaded from Tally)' : '(ledger list unavailable — is Tally open?)';
    if (manual) document.getElementById('m-msg').innerHTML =
      j.ok ? '<span class="msg ok">✓ ' + j.ledgers.length + ' ledger names loaded.</span>'
           : '<span class="msg bad">' + esc(j.error || 'Could not read ledgers from Tally') + '</span>';
  });
}

async function deleteFromTally() {
  var keys = Object.keys(selected).filter(function (k) { return postedReg[k] && postedReg[k].remoteId; });
  var noRid = Object.keys(selected).filter(function (k) { return postedReg[k] && !postedReg[k].remoteId; }).length;
  if (!keys.length) {
    document.getElementById('bar-msg').textContent =
      noRid ? 'Selected entries were not posted by this tool (found in Tally / older posts) — delete those inside Tally itself.'
            : 'Tick posted documents to delete their vouchers from Tally.';
    return;
  }
  if (!confirm('Delete ' + keys.length + ' voucher(s) OUT of Tally? They will be removed from the Tally company and go back to Pending here.' +
    (noRid ? '\\n(' + noRid + ' selected entries were not posted by this tool and will be skipped.)' : ''))) return;
  var ok = 0, fail = 0, lastErr = '';
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var p = postedReg[k];
    var vr = await fetch('/api/tally', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ kind:'delete', xml: envelope([delVoucherXml(p.remoteId, p.vch || 'Purchase', p.dt || '', p.docNo || p.no || '')], 'Vouchers') }) })
      .then(function (r) { return r.json(); });
    if (vr.ok) {
      ok++;
      delete postedReg[k];
      delete live[k];
      delete selected[k];
      fetch('/api/unposted', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ keys: [k] }) });
    } else {
      fail++;
      lastErr = vr.error || '';
    }
    renderDocs();
  }
  document.getElementById('bar-msg').textContent =
    '🗑 ' + ok + ' voucher(s) deleted from Tally' + (fail ? ', ' + fail + ' failed — ' + lastErr : '') + '.';
}
async function startFresh() {
  if (!confirm('Clear ALL loaded documents and reconciliation results? Mappings, settings and the posted register are kept. Upload a GSTR-2B JSON afterwards to start over.')) return;
  await fetch('/api/clear', { method: 'POST' });
  docs = [];
  reco = null;
  selected = {};
  live = {};
  filterText = '';
  bucketFilter = 'all';
  document.getElementById('filter').value = '';
  document.getElementById('reco-summary').innerHTML = '';
  document.getElementById('rcm-card').innerHTML = '';
  document.getElementById('upload-msg').innerHTML = '';
  render();
  document.getElementById('bar-msg').textContent = '🧹 Fresh slate — upload a GSTR-2B JSON to begin.';
}
function unmarkSelected() {
  var keys = Object.keys(selected).filter(function (k) { return postedReg[k]; });
  if (!keys.length) { document.getElementById('bar-msg').textContent = 'Tick posted documents to un-mark.'; return; }
  if (!confirm('Un-mark ' + keys.length + ' document(s) as posted? Only do this if they are NOT in Tally — otherwise posting again will duplicate them.')) return;
  keys.forEach(function (k) { delete postedReg[k]; delete live[k]; });
  fetch('/api/unposted', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ keys: keys }) });
  renderDocs();
  document.getElementById('bar-msg').textContent = keys.length + ' document(s) back to pending.';
}
</script>
</body>
</html>`;

// An older copy still running would silently keep serving the OLD version —
// the browser then shows a stale v-number no matter how often this file is
// replaced. Say it loudly instead of dying with a stack trace.
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('');
    console.log('  🛑 ANOTHER COPY OF THE POSTER IS ALREADY RUNNING on port ' + PORT + '.');
    console.log('     The browser is talking to THAT (older) copy — this one cannot start.');
    console.log('');
    console.log('     Close the other black "GSTR-2B Tally Poster" window (check the taskbar),');
    console.log('     or press Ctrl+Shift+Esc → Task Manager → end every "Node.js" process,');
    console.log('     then run this .bat again and refresh the browser.');
    console.log('');
  } else {
    console.log('  🛑 Could not start: ' + String((e && e.message) || e));
  }
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  GSTR-2B → Tally poster v' + VERSION + ' running.');
  console.log('  Open   http://localhost:' + PORT + '   in your browser.');
  console.log('');
  console.log('  Data file: ' + DATA_FILE);
  console.log('  Tally URL: ' + state.settings.tallyUrl + ' (change under Settings in the page)');
  console.log('  Press Ctrl+C to stop.');
});
