#!/usr/bin/env node
// KNAP Tally Connector — standalone, single file, zero dependencies.
// ---------------------------------------------------------------------------
// The local half of the hosted GSTR-2B → Tally poster. The page lives at
// https://apps.knapadvisory.com/gstr2b/ ; this connector runs on the computer
// where Tally Prime is installed and does everything that must happen next to
// Tally: reading the books, posting vouchers, keeping the supplier mappings
// and the posted-documents register. All books data flows browser ↔ connector
// ↔ Tally on THIS machine — nothing reaches the server; the server only
// serves the page itself.
//
// It answers only on 127.0.0.1 and only to pages from apps.knapadvisory.com
// (CORS), engine ported unchanged from gstr2b-tally-poster.mjs v1.7. It
// self-updates from https://apps.knapadvisory.com/connector/version.json when
// idle; the installer's run-loop restarts it after an update.
//
// Installed by Install-Tally-Connector.bat (auto-starts with Windows).
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

const VERSION = '4.16';
const PORT = Number(process.env.PORT || 8797);
const SELF = fileURLToPath(import.meta.url);
const DATA_FILE = path.join(path.dirname(SELF), 'gstr2b-tally-data.json');
const HUB = process.env.KNAP_HUB || 'https://apps.knapadvisory.com';
// Browser pages allowed to talk to this connector.
const ORIGIN_OK = /^https:\/\/apps\.knapadvisory\.com$|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

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
      // Preserve any extra keys the tools persist (tdsMap, finMap, dcAliases…)
      // so learned memory survives a connector restart — before this spread
      // they were written to disk but dropped on load.
      ...raw,
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
  const s = String(v ?? '');
  // Forex amount like "SGD34.50 @ ₹380.55/SGD = -₹13129.05" — the BASE (INR)
  // value is after the last '='. Take that (stripping any currency symbol),
  // never the foreign figure. Non-forex amounts have no '=', so behaviour there
  // is unchanged.
  if (s.indexOf('=') >= 0) {
    const n = Number(s.slice(s.lastIndexOf('=') + 1).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(s.replace(/[₹,\s]/g, ''));
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
// Live progress for the financials trial-balance read, polled by /finprep/.
const finProgress = { active: false, phase: '', step: 0, steps: 3 };

// Every Tally call goes through one cancellable controller so a "Release Tally"
// request can abort the in-flight fetch — dropping the socket is the only way
// to free a Tally that's busy serving a heavy request (aborting our wait alone
// leaves Tally computing). Also lets us cancel cleanly when a tab is closed.
let currentTallyAbort = null;
async function tallyFetch(tallyUrl, body, ms) {
  const ctl = new AbortController();
  currentTallyAbort = ctl;
  const timer = ms ? setTimeout(() => ctl.abort(new Error('Tally request timed out')), ms) : null;
  try {
    const res = await fetch(tallyUrl, { method: 'POST', body, headers: { 'content-type': 'text/xml' }, signal: ctl.signal });
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
    if (currentTallyAbort === ctl) currentTallyAbort = null;
  }
}
async function askTally(tallyUrl, body) {
  return tallyFetch(tallyUrl, body, 300000); // 5 min per chunk — a hung Tally fails loudly instead of forever
}
// Shorter timeout for interactive reads. Retries ONLY transient connection
// errors — never a timeout or a user release, since re-sending a heavy request
// just re-freezes Tally.
async function askTallyFast(tallyUrl, body, ms = 60000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await tallyFetch(tallyUrl, body, ms);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (attempt === 1 || /abort|timed out|timeout|released/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 1500)); // transient only: brief pause, one retry
    }
  }
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

// ---- Trial-balance reader (financial-statement tool) -----------------------
// The GROUP tree only: every Group's Name + Parent (to walk up to the reserved
// primary group) and its debit/credit nature. All stored fields — never a
// computed balance — so this read is fast (~0.2s) and never hangs Tally. The
// ledger balances themselves are DERIVED from vouchers (see the block after
// tallyAmt), because asking Tally to COMPUTE ClosingBalance in bulk hangs it.
const COLL_ATTRS = 'ISMODIFY="No"';
const GROUPS_REQUEST = () => `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>KnapGroups</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${svCompany()}</STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="KnapGroups" ${COLL_ATTRS}>
    <TYPE>Group</TYPE>
    <FETCH>NAME</FETCH><FETCH>PARENT</FETCH><FETCH>ISREVENUE</FETCH><FETCH>ISDEEMEDPOSITIVE</FETCH>
   </COLLECTION>
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;

// Tally amounts arrive as "12,345.67", "-12345.67", or "12345.67 Cr" — a Cr
// balance is a credit (negative in the Dr-positive convention we return).
function tallyAmt(raw) {
  let s = String(raw || '').trim();
  if (!s) return 0;
  const cr = /cr\.?$/i.test(s), dr = /dr\.?$/i.test(s);
  s = s.replace(/[^0-9.\-]/g, '');
  let n = parseFloat(s);
  if (isNaN(n)) return 0;
  if (cr) n = -Math.abs(n);
  else if (dr) n = Math.abs(n);
  return r2(n);
}

// ===========================================================================
// VOUCHER-BASED TRIAL BALANCE  (financial-statement tool, v3.6+)
// ---------------------------------------------------------------------------
// Asking Tally for ledger CLOSING balances hangs it (ClosingBalance is a
// computed field — Tally recomputes every ledger from scratch and the socket
// times out). So instead we build the trial balance the same way this
// connector already reads the books every day for the GST/TDS tools: pull the
// VOUCHERS for the period (a plain collection Tally serves fast, honouring the
// date range) and add up each ledger's movements. Balances we DERIVE ourselves
// never hang Tally.
//
//   closing (Dr-positive) at period-to  = master opening + Σ movement(… → to)
//   opening (Dr-positive) at period-from = master opening + Σ movement(… → from-)
//
// Each ledger ENTRY inside a voucher carries <ISDEEMEDPOSITIVE> (Yes = debit),
// so we read the debit/credit side straight from Tally's own flag and never
// depend on the amount's sign — which differs between Tally builds. A debit
// adds +amount, a credit −amount, so assets/expenses come out positive and
// liabilities/income/equity negative, and every balanced voucher contributes
// net zero — the whole trial balance ties to ~0 automatically.

// Ledger MASTERS — Name, Parent and the STORED opening balance only. All three
// are stored fields (never computed like ClosingBalance), so this read is as
// fast as the group read and never hangs Tally. Gives the ledger→group map (to
// classify into Schedule III heads) and the opening position at books start.
const LEDGER_MASTERS_REQUEST = () => `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>KnapLedgerMasters</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${svCompany()}</STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="KnapLedgerMasters" ISMODIFY="No">
    <TYPE>Ledger</TYPE>
    <FETCH>NAME</FETCH><FETCH>PARENT</FETCH><FETCH>OPENINGBALANCE</FETCH>
    <FETCH>PARTYGSTIN</FETCH><FETCH>GSTREGISTRATIONNUMBER</FETCH><FETCH>VATTINNUMBER</FETCH>
   </COLLECTION>
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;

// Convert a Tally opening-balance string to the Dr-positive convention
// (assets/expenses +, liabilities/income/equity −). Tally writes the master
// opening balance either as a plain signed number (debit negative, credit
// positive) OR with a Dr/Cr suffix — handle both so the sign is always right.
function openingDr(raw) {
  let s = String(raw || '').trim();
  if (!s) return 0;
  // Forex opening like "-SGD34.50 @ ₹380.55/SGD = -₹13129.05" — keep the BASE
  // (INR) value after the last '=', never the foreign figure.
  if (s.indexOf('=') >= 0) s = s.slice(s.lastIndexOf('=') + 1).trim();
  if (/(cr|dr)\.?\s*$/i.test(s)) {
    const cr = /cr\.?\s*$/i.test(s);
    const n = Math.abs(parseFloat(s.replace(/[^0-9.]/g, ''))) || 0;
    return r2(cr ? -n : n);          // Dr → +, Cr → −
  }
  const n = parseFloat(s.replace(/[^0-9.\-]/g, '')) || 0;
  return r2(-n);                     // plain signed number: Tally debit = negative
}

function parseLedgerMasters(xml) {
  const out = {};
  for (const b of xml.match(/<LEDGER[\s>][\s\S]*?<\/LEDGER>/gi) || []) {
    const name = decodeXml((b.match(/<LEDGER[^>]*\sNAME="([^"]*)"/i)?.[1] ?? tag(b, 'NAME'))).trim();
    if (!name) continue;
    // A party GSTIN can land in PARTYGSTIN, GSTREGISTRATIONNUMBER, or a nested
    // LEDGSTREGDETAILS.LIST depending on the Tally version — scanning the whole
    // ledger block for the GSTIN shape catches whichever one is populated.
    out[name] = {
      parent: decodeXml(tag(b, 'PARENT')).trim(),
      openingRaw: tag(b, 'OPENINGBALANCE'), // kept raw for the diagnostic
      openingDr: openingDr(tag(b, 'OPENINGBALANCE')),
      gstin: (b.match(GSTIN_RE) || [''])[0],
    };
  }
  return out;
}

// Numeric YYYYMMDD key for a Tally DATE tag ("20260415" or "15-Apr-2026").
function dateKey(v) {
  const d = parseTallyFieldDate(v);
  return d ? d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate() : 0;
}

// Add ONE export chunk's voucher ledger movements into the per-ledger
// Dr-positive running sums. `sums[name] = { dr, priorDr }` where dr covers the
// whole read window and priorDr covers only vouchers dated before `fromKey`
// (so closing = opening+dr and period-opening = opening+priorDr). Deduped by
// voucher GUID across chunks, so a Tally that repeats vouchers for every
// monthly window can't multiply the books.
function accumulateTB(xml, sums, seen, cal, fromKey, toKey, seenSig) {
  const sig = new Map(); // per-chunk signature counter for GUID-less vouchers
  for (const block of xml.match(/<VOUCHER[\s>][\s\S]*?<\/VOUCHER>/gi) || []) {
    if (/(^|>)\s*Yes\s*<\/ISCANCELLED>/i.test(block.match(/<ISCANCELLED>[\s\S]*?<\/ISCANCELLED>/i)?.[0] ?? '')) continue;
    if (/<ISOPTIONAL>\s*Yes/i.test(block)) continue;
    let key = tag(block, 'GUID');
    if (!key) {
      const s = `${tag(block, 'VOUCHERTYPENAME')}|${tag(block, 'DATE')}|${tag(block, 'VOUCHERNUMBER')}|${tag(block, 'PARTYLEDGERNAME')}`;
      const n = (sig.get(s) ?? 0) + 1; sig.set(s, n);
      key = s + '#' + n;
    }
    if (seen.has(key)) { cal.dupes++; continue; }
    seen.add(key);
    const dk = dateKey(tag(block, 'DATE'));
    // ENFORCE the cut-off ourselves. Some Tally setups ignore SVTODATE and
    // return every voucher for each request; without this a balance "as on"
    // an earlier date silently includes later vouchers (i.e. the latest
    // balance). `toKey` (YYYYMMDD) drops anything dated after the "as on" date.
    if (toKey && dk > toKey) { cal.afterTo = (cal.afterTo || 0) + 1; continue; }
    // Duplicate-voucher guard (DC path only). Tally can export the SAME voucher
    // twice with DIFFERENT GUIDs (so the GUID dedup above misses it), doubling a
    // ledger's movement. A voucher's type|date|number is a unique identity, so
    // skip a repeat of one already counted. Only when a real number exists, so
    // unnumbered vouchers are never wrongly merged.
    if (seenSig) {
      const vno = tag(block, 'VOUCHERNUMBER');
      if (vno) {
        const vs = `${tag(block, 'VOUCHERTYPENAME')}|${tag(block, 'DATE')}|${vno}`;
        if (seenSig.has(vs)) { cal.dupes++; continue; }
        seenSig.add(vs);
      }
    }
    const isPrior = fromKey ? (dk < fromKey) : false;
    // Prefer ALLLEDGERENTRIES (the complete set); fall back to LEDGERENTRIES so a
    // voucher carrying both never double-counts. Within a voucher, drop a byte-
    // identical repeated entry block (another export artefact). DC path only.
    let entryBlocks;
    if (seenSig) {
      const allE = block.match(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/gi);
      entryBlocks = (allE && allE.length) ? allE : (block.match(/<LEDGERENTRIES\.LIST>[\s\S]*?<\/LEDGERENTRIES\.LIST>/gi) || []);
    } else {
      entryBlocks = block.match(/<(?:ALL)?LEDGERENTRIES\.LIST>[\s\S]*?<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi) || [];
    }
    const seenEntry = seenSig ? new Set() : null;
    for (const e of entryBlocks) {
      const name = tag(e, 'LEDGERNAME');
      if (!name) continue;
      if (seenEntry) { if (seenEntry.has(e)) { continue; } seenEntry.add(e); }
      const rawAmt = toNum(tag(e, 'AMOUNT'));
      const amt = Math.abs(rawAmt);
      const dpStr = tag(e, 'ISDEEMEDPOSITIVE');
      let c;                            // Dr-positive contribution
      if (dpStr) c = /yes/i.test(dpStr) ? amt : -amt;
      else { c = -rawAmt; cal.noFlag++; } // Tally standard fallback: debit is negative
      let s = sums[name];
      if (!s) s = sums[name] = { dr: 0, priorDr: 0 };
      s.dr = r2(s.dr + c);
      if (isPrior) s.priorDr = r2(s.priorDr + c);
    }
    cal.vouchers++;
  }
}

// Read every voucher from the earliest needed date up to `to`, month by month,
// discarding each chunk's XML after summing it (a multi-month window is far too
// much XML to hold at once). Returns per-ledger Dr-positive movement sums.
async function readTBFromVouchers(tallyUrl, readStart, from, to) {
  const sums = {};
  const seen = new Set();
  const cal = { vouchers: 0, dupes: 0, noFlag: 0 };
  const fromKey = from.getUTCFullYear() * 10000 + (from.getUTCMonth() + 1) * 100 + from.getUTCDate();
  let monthsTotal = 0;
  for (let d = new Date(Date.UTC(readStart.getUTCFullYear(), readStart.getUTCMonth(), 1)); d <= to;
       d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) monthsTotal++;
  let done = 0;
  for (let d = new Date(Date.UTC(readStart.getUTCFullYear(), readStart.getUTCMonth(), 1)); d <= to;
       d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const mFrom = d < readStart ? readStart : d;
    const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const mTo = mEnd > to ? to : mEnd;
    finProgress.phase = `Reading vouchers · ${MONTH_NAMES[mFrom.getUTCMonth()]} ${mFrom.getUTCFullYear()} (${done + 1} of ${monthsTotal})…`;
    const xml = await askTally(tallyUrl, voucherCollectionRequest(mFrom, mTo));
    accumulateTB(xml, sums, seen, cal, fromKey);
    done++;
    finProgress.step = 2 + done / Math.max(1, monthsTotal);
  }
  return { sums, cal, monthsTotal };
}

// Company period — master data (no balance computation), so it's fast like the
// group read. Tells us the real books range so we never ask Tally for balances
// at dates outside its data (which hangs Tally).
const FIN_COMPANY_REQUEST = () => `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>KnapCompany</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>${svCompany()}</STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="KnapCompany" ISMODIFY="No">
    <TYPE>Company</TYPE>
    <FETCH>NAME</FETCH><FETCH>STARTINGFROM</FETCH><FETCH>BOOKSFROM</FETCH><FETCH>ENDINGAT</FETCH><FETCH>LASTVOUCHERDATE</FETCH>
   </COLLECTION>
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;

// Tally dates in XML export come as "YYYYMMDD" or "1-Apr-2026" — normalise to
// a Date (UTC midnight) or null.
function parseTallyFieldDate(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  m = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3})[-\/ ](\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1]));
  return null;
}
function parseCompany(xml) {
  // Tally's reply carries a bare "<COMPANY>1</COMPANY>" counter inside CMPINFO
  // BEFORE the real company master (<COMPANY NAME="…"> … </COMPANY>). Require a
  // space after COMPANY (so the bare counter is skipped) and prefer the block
  // that actually carries a period.
  const blocks = xml.match(/<COMPANY\s[\s\S]*?<\/COMPANY>/gi) || [];
  const b = blocks.find((x) => /STARTINGFROM|BOOKSFROM|LASTVOUCHERDATE/i.test(x)) || blocks[0] || xml;
  const name = decodeXml((b.match(/<COMPANY[^>]*\sNAME="([^"]*)"/i)?.[1] ?? tag(b, 'NAME'))).trim();
  const start = parseTallyFieldDate(tag(b, 'STARTINGFROM')) || parseTallyFieldDate(tag(b, 'BOOKSFROM'));
  const booksFrom = parseTallyFieldDate(tag(b, 'BOOKSFROM')) || start;
  const lastVch = parseTallyFieldDate(tag(b, 'LASTVOUCHERDATE'));
  const endingAt = parseTallyFieldDate(tag(b, 'ENDINGAT'));
  return { name, start, booksFrom, lastVch, endingAt };
}

function parseGroups(xml) {
  const out = {};
  for (const b of xml.match(/<GROUP[\s>][\s\S]*?<\/GROUP>/gi) || []) {
    const name = decodeXml((b.match(/<GROUP[^>]*\sNAME="([^"]*)"/i)?.[1] ?? tag(b, 'NAME'))).trim();
    if (!name) continue;
    out[name] = {
      parent: decodeXml(tag(b, 'PARENT')).trim(),
      isRevenue: /yes/i.test(tag(b, 'ISREVENUE')),
      isDeemedPositive: /yes/i.test(tag(b, 'ISDEEMEDPOSITIVE')),
    };
  }
  return out;
}

// A Tally primary (reserved top-level) group: no parent, or its parent is
// Tally's "Primary" sentinel. Some Tally builds export the 28 reserved groups
// with <PARENT>Primary</PARENT> rather than an empty parent, so we must stop
// there — otherwise the walk climbs one step too far and returns "Primary" for
// EVERY ledger, which then classifies nothing (all land in note 99).
function isPrimaryGroup(g) {
  return !g || !g.parent || /^primary$/i.test(g.parent);
}
// Walk a ledger's parent groups up to (and stopping at) the reserved primary
// group — e.g. "Sundry Creditors" → "Current Liabilities", "AAJ ..." →
// "Current Liabilities". Returns the primary group's name.
function primaryGroupOf(groupName, groups, depth = 0) {
  if (!groupName || depth > 30) return groupName || '';
  const g = groups[groupName];
  if (isPrimaryGroup(g)) return groupName; // this group IS a primary group
  return primaryGroupOf(g.parent, groups, depth + 1);
}
// The full "Booked under" path from the ledger's own group up to the primary
// group, e.g. ["Sundry Creditors","Current Liabilities"]. Lets the page show
// exactly where a ledger is parked in Tally.
function groupPathOf(groupName, groups, depth = 0) {
  if (!groupName || depth > 30) return groupName ? [groupName] : [];
  const g = groups[groupName];
  if (isPrimaryGroup(g)) return [groupName];
  return [groupName, ...groupPathOf(g.parent, groups, depth + 1)];
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
    bookRef: billNo(hit), bookParty: hit.party, bookDate: hit.date, bookGstin: hit.gstin || '', bookRegn: hit.cmpGstin || '', bookAmount: hit.amount,
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
        // Books-side identity for the "Reco sheet (2B vs Books)" export — the
        // page's per-row name/GSTIN/date checks need who and when, not just how much.
        bookParty: d.bookParty || null, bookGstin: d.bookGstin || null, bookRegn: d.bookRegn || null,
        bookDate: d.bookDate ? (d.bookDate.toISOString ? d.bookDate.toISOString().slice(0, 10) : String(d.bookDate)) : null,
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

// ===========================================================================
// MULTI-COMPANY DEBTOR / CREDITOR CONSOLIDATION  (page: HUB/debtor-creditor/)
// ---------------------------------------------------------------------------
// One party (a customer or a supplier) is often carried in the books of
// several group companies — a sale raised by Company A is settled through
// Company B, so B carries A's customer too. This tool lists every debtor (or
// creditor) as at a chosen date across ALL the companies the connector can
// reach — whether they are many companies loaded in one Tally, or several
// Tally instances each on its own port — and lays their balances side by side
// so they can be matched into one row per real party.
//
// The balance for each party is DERIVED the same proven way the financials
// tool builds its trial balance: read the vouchers from books-start to the
// chosen date and sum each ledger's movements in the Dr-positive convention
// (opening + Σ movement). Asking Tally to COMPUTE closing balances hangs it,
// so we never do that. Balances are returned Dr-positive:
//   • Debtors   → a normal receivable is +, a party in CREDIT shows −.
//   • Creditors → the page negates, so a normal payable is +, a party in
//                 DEBIT shows −.
// Matching (PAN-from-GSTIN → GSTIN → exact name → fuzzy) and the review step
// happen in the browser; confirmed groupings are remembered in state.dcAliases.

const dcProgress = { active: false, phase: '', sub: '', done: 0, total: 0, company: '', startedAt: 0, monthsDone: 0, monthsTotal: 0 };

// Read a company's per-ledger Dr-positive movements from books-start to `asOn`,
// month by month (discarding each chunk's XML after summing it), enforcing the
// `asOn` cut-off in code so a Tally that ignores SVTODATE can't leak later
// vouchers into an earlier-dated balance. Updates dcProgress month counters.
async function readDCMovements(url, readStart, asOn) {
  const sums = {}, seen = new Set(), seenSig = new Set();
  const cal = { vouchers: 0, dupes: 0, noFlag: 0, afterTo: 0 };
  const toKey = asOn.getUTCFullYear() * 10000 + (asOn.getUTCMonth() + 1) * 100 + asOn.getUTCDate();
  let monthsTotal = 0;
  for (let d = new Date(Date.UTC(readStart.getUTCFullYear(), readStart.getUTCMonth(), 1)); d <= asOn;
       d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) monthsTotal++;
  dcProgress.monthsTotal = monthsTotal; dcProgress.monthsDone = 0;
  let done = 0;
  for (let d = new Date(Date.UTC(readStart.getUTCFullYear(), readStart.getUTCMonth(), 1)); d <= asOn;
       d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const mFrom = d < readStart ? readStart : d;
    const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const mTo = mEnd > asOn ? asOn : mEnd;
    dcProgress.sub = `${MONTH_NAMES[mFrom.getUTCMonth()]} ${mFrom.getUTCFullYear()} (${done + 1}/${monthsTotal})`;
    const xml = await askTally(url, voucherCollectionRequest(mFrom, mTo)); // svCompany() is set by the caller
    accumulateTB(xml, sums, seen, cal, 0, toKey, seenSig);
    done++; dcProgress.monthsDone = done;
  }
  return { sums, cal, monthsTotal };
}

// PAN sits inside every GSTIN as characters 3–12 (0-based 2..12). Deriving it
// lets one party that holds several state GSTINs collapse under a single PAN —
// the single most reliable cross-company key for Indian entities.
// Financial-year start (1 April) for a date — the period Tally's ledger
// OPENINGBALANCE is anchored to, so debtor/creditor movement is summed from here.
function fyStartOf(d) {
  return d.getUTCMonth() >= 3
    ? new Date(Date.UTC(d.getUTCFullYear(), 3, 1))
    : new Date(Date.UTC(d.getUTCFullYear() - 1, 3, 1));
}
const PAN_RE = /[A-Z]{5}\d{4}[A-Z]/;
function panFromGstin(g) {
  const s = String(g || '').toUpperCase();
  if (!GSTIN_RE.test(s)) return '';
  const pan = s.slice(2, 12);
  return PAN_RE.test(pan) ? pan : '';
}

// Is this ledger parked under Sundry Debtors / Sundry Creditors? We test the
// WHOLE group chain (ledger → primary) so custom sub-groups like
// "Sundry Debtors › Local" are caught by their reserved ancestor.
function dcClassOf(groupPath) {
  for (const g of groupPath) {
    const n = norm(g);
    if (n.includes('sundrydebtor')) return 'debtors';
    if (n.includes('sundrycreditor')) return 'creditors';
  }
  return null;
}

// AUTHORITATIVE closing balances. Ask Tally for the ledgers under Sundry
// Debtors / Sundry Creditors (the whole sub-tree, via CHILDOF + BELONGSTO)
// with their CLOSINGBALANCE as at the date — the exact figure Tally's own
// Group Summary shows, so the tool ties to Tally by construction. Scoped to
// one group it is light and does not hang like a whole-company balance read.
function GROUP_LEDGERS_REQUEST(group, asOn) {
  const fyStart = asOn.getUTCMonth() >= 3
    ? new Date(Date.UTC(asOn.getUTCFullYear(), 3, 1))
    : new Date(Date.UTC(asOn.getUTCFullYear() - 1, 3, 1));
  return `<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>DcLedgers</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES>
   <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   <SVFROMDATE>${toTallyDate(fyStart)}</SVFROMDATE>
   <SVTODATE>${toTallyDate(asOn)}</SVTODATE>${svCompany()}
  </STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="DcLedgers" ISMODIFY="No">
    <TYPE>Ledger</TYPE>
    <CHILDOF>${escXml(group)}</CHILDOF>
    <BELONGSTO>Yes</BELONGSTO>
    <FETCH>NAME</FETCH><FETCH>PARENT</FETCH><FETCH>CLOSINGBALANCE</FETCH>
    <FETCH>PARTYGSTIN</FETCH><FETCH>GSTREGISTRATIONNUMBER</FETCH><FETCH>VATTINNUMBER</FETCH>
   </COLLECTION>
  </TDLMESSAGE></TDL>
 </DESC></BODY>
</ENVELOPE>`;
}
function parseDcLedgers(xml) {
  const out = [];
  for (const b of xml.match(/<LEDGER[\s>][\s\S]*?<\/LEDGER>/gi) || []) {
    const name = decodeXml((b.match(/<LEDGER[^>]*\sNAME="([^"]*)"/i)?.[1] ?? tag(b, 'NAME'))).trim();
    if (!name) continue;
    const gstin = (b.match(GSTIN_RE) || [''])[0].toUpperCase();
    out.push({
      ledger: name,
      group: decodeXml(tag(b, 'PARENT')).trim(),
      gstin,
      pan: panFromGstin(gstin),
      // openingDr() (not tallyAmt) — Tally exports a ledger CLOSINGBALANCE
      // either with a Dr/Cr suffix OR as a plain signed number where a DEBIT is
      // negative. openingDr handles both and returns the Dr-positive convention
      // (Dr +, Cr −); tallyAmt would leave a plain debit-negative value inverted.
      balanceDr: openingDr(tag(b, 'CLOSINGBALANCE')),
    });
  }
  return out;
}

// Read one company's debtors OR creditors (`kind`) as at `asOn`. `company`
// scopes the Tally requests via SVCURRENTCOMPANY.
//
// Balance = master opening (as at books-start) + every voucher movement up to
// `asOn`, in the Dr-positive convention. We DERIVE it from vouchers rather than
// ask Tally for CLOSINGBALANCE, because a bare Tally collection computes
// ClosingBalance at the latest date and ignores SVTODATE — so an "as on 15-Jul"
// balance silently returned the latest figure. The voucher read enforces the
// cut-off itself (readDCMovements' toKey), so the date is honoured exactly, and
// membership comes from walking each ledger's group chain to Sundry Debtors /
// Creditors, which catches ledgers nested in customer sub-groups.
async function readDCForCompany(url, company, asOn, label, kind) {
  const savedCompany = state.settings.company;
  state.settings.company = company || '';
  try {
    dcProgress.phase = `Reading ${label} — group tree & ledgers…`;
    dcProgress.monthsTotal = 0; dcProgress.monthsDone = 0;
    const groups = parseGroups(await askTallyFast(url, GROUPS_REQUEST()));
    const masters = parseLedgerMasters(await askTallyFast(url, LEDGER_MASTERS_REQUEST()));

    // Tally's ledger OPENINGBALANCE is the opening at the CURRENT financial-year
    // start (not books-start), so movements must be summed from that SAME FY
    // start — otherwise prior-year vouchers get double-counted on top of an
    // opening that already includes them. (Verified against Group Summary: the
    // opening total ties to the paisa; only the movement window was wrong —
    // reading from books-start added ~4 years of stale movement.)
    const readStart = fyStartOf(asOn);

    dcProgress.phase = `Reading ${label} — vouchers ${readStart.toISOString().slice(0, 10)} → ${asOn.toISOString().slice(0, 10)}…`;
    const { sums, cal } = await readDCMovements(url, readStart, asOn); // toKey enforces the asOn cut-off
    const voucherCount = cal.vouchers;

    const parties = [];
    const method = 'vouchers';
    for (const name of new Set([...Object.keys(masters), ...Object.keys(sums)])) {
      const m = masters[name] || { parent: '', openingDr: 0, gstin: '' };
      if (dcClassOf(groupPathOf(m.parent, groups)) !== kind) continue; // only Sundry Debtors/Creditors
      const balanceDr = r2((m.openingDr || 0) + ((sums[name] && sums[name].dr) || 0));
      if (Math.abs(balanceDr) < 0.005) continue; // drop fully-settled ledgers
      const gstin = (m.gstin || '').toUpperCase();
      parties.push({ ledger: name, gstin, pan: panFromGstin(gstin), group: m.parent, balanceDr });
    }
    dcProgress.sub = '';
    return { ok: true, url, company: company || '', label, method, voucherCount, ledgerCount: parties.length, parties };
  } finally {
    state.settings.company = savedCompany;
  }
}

// ===========================================================================
// AGEING & BILL-WISE (FIFO)  (page reports)
// ---------------------------------------------------------------------------
// The client's ledgers are NOT maintained bill-by-bill — invoices are Sales
// vouchers and receipts are booked on-account against the bank, never adjusted
// to a specific bill. So bill allocations don't exist to age against. Instead
// we do what Tally itself does for such ledgers: FIFO. Each debit (invoice) is
// an outstanding item dated at its voucher date; each credit (receipt / credit
// note) pays off the OLDEST outstanding item first. Whatever debits remain are
// the aged outstanding (by their own dates); any credit left after clearing
// everything is the advance / on-account (shown in its own bucket).
//
// Everything is computed in the PARTY's natural sign (debtors Dr-positive,
// creditors Cr-positive), so a normal balance is positive and the contrary side
// negative. Anchored to the master FY-start opening (the figure that ties to
// Tally): the opening is fed in as one item dated at FY start, and FY vouchers
// on top. Σ(open items) + on-account == closing, by construction.

const DAY_MS = 86400000;
// One voucher pass (FY start → asOn): for the party ledgers in `partySet`,
// collect each dated Dr-positive movement with a reference for display.
async function readAgeMovements(url, fyStart, asOn, partySet) {
  const moves = {}, seen = new Set(), seenSig = new Set();
  const cal = { vouchers: 0, noFlag: 0, afterTo: 0 };
  const toKey = asOn.getUTCFullYear() * 10000 + (asOn.getUTCMonth() + 1) * 100 + asOn.getUTCDate();
  let monthsTotal = 0;
  for (let d = new Date(Date.UTC(fyStart.getUTCFullYear(), fyStart.getUTCMonth(), 1)); d <= asOn; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) monthsTotal++;
  dcProgress.monthsTotal = monthsTotal; dcProgress.monthsDone = 0;
  let done = 0;
  for (let d = new Date(Date.UTC(fyStart.getUTCFullYear(), fyStart.getUTCMonth(), 1)); d <= asOn; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const mFrom = d < fyStart ? fyStart : d;
    const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const mTo = mEnd > asOn ? asOn : mEnd;
    dcProgress.sub = `${MONTH_NAMES[mFrom.getUTCMonth()]} ${mFrom.getUTCFullYear()} (${done + 1}/${monthsTotal})`;
    const xml = await askTally(url, voucherCollectionRequest(mFrom, mTo));
    for (const block of xml.match(/<VOUCHER[\s>][\s\S]*?<\/VOUCHER>/gi) || []) {
      if (/(^|>)\s*Yes\s*<\/ISCANCELLED>/i.test(block.match(/<ISCANCELLED>[\s\S]*?<\/ISCANCELLED>/i)?.[0] ?? '')) continue;
      if (/<ISOPTIONAL>\s*Yes/i.test(block)) continue;
      let key = tag(block, 'GUID');
      if (!key) key = `${tag(block, 'VOUCHERTYPENAME')}|${tag(block, 'DATE')}|${tag(block, 'VOUCHERNUMBER')}|${tag(block, 'PARTYLEDGERNAME')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dk = dateKey(tag(block, 'DATE'));
      if (toKey && dk > toKey) { cal.afterTo++; continue; }
      const vdate = parseTallyFieldDate(tag(block, 'DATE'));
      const vno = tag(block, 'VOUCHERNUMBER'), vtype = tag(block, 'VOUCHERTYPENAME');
      // Duplicate-voucher guard (see accumulateTB): a repeat of a numbered
      // voucher already counted (Tally re-exports with a different GUID).
      if (vno) { const vs = `${vtype}|${tag(block, 'DATE')}|${vno}`; if (seenSig.has(vs)) continue; seenSig.add(vs); }
      const ref = ((vtype ? vtype + ' ' : '') + (vno || '')).trim() || '(voucher)';
      const allE = block.match(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/gi);
      const entryBlocks = (allE && allE.length) ? allE : (block.match(/<LEDGERENTRIES\.LIST>[\s\S]*?<\/LEDGERENTRIES\.LIST>/gi) || []);
      const seenEntry = new Set();
      for (const e of entryBlocks) {
        const name = tag(e, 'LEDGERNAME');
        if (!name || !partySet.has(name)) continue;
        if (seenEntry.has(e)) continue; seenEntry.add(e);
        const rawAmt = toNum(tag(e, 'AMOUNT'));
        const dp = tag(e, 'ISDEEMEDPOSITIVE');
        if (!dp) cal.noFlag++;
        const sign = dp ? (/yes/i.test(dp) ? 1 : -1) : (rawAmt < 0 ? 1 : -1); // Dr-positive
        (moves[name] || (moves[name] = [])).push({ date: vdate, dr: r2(sign * Math.abs(rawAmt)), ref, vtype });
      }
      cal.vouchers++;
    }
    done++; dcProgress.monthsDone = done;
  }
  return { moves, cal };
}
// Pass-through pre-pass. At KNAP a client also pays the firm the tax it will
// remit on the client's behalf; the firm raises a *Reimbursement* invoice
// (a debit) squared by the client's *Receipt*. Those two legs are not a genuine
// sales receivable, and — because the receipt is often booked a few days BEFORE
// the reimbursement invoice — plain FIFO would wrongly apply the receipt to old
// sales and leave the reimbursement showing as outstanding. So we net each
// reimbursement debit against the receipt(s) that fund it BEFORE ageing.
//
// Matching is two-phase and value-partial, because the real world isn't 1:1:
//   Phase 1 — a reimbursement squared by ONE receipt of the same value
//             (nearest by date). Handles the clean case.
//   Phase 2 — whatever reimbursement is still open pulls from the nearest
//             receipts within a 15-day window, splitting a receipt if it also
//             covers a little fee (e.g. a ₹5,92,967 receipt funding a
//             ₹5,92,797.91 reimbursement leaves ₹169.09 of genuine trade), and
//             combining several receipts for one reimbursement (₹8,00,000 +
//             ₹4,67,278 → one ₹12,67,278 reimbursement).
// Only *Receipt*-type credits fund reimbursements (never credit notes or
// journals). Matched value is removed from both legs — equal and opposite, so
// the closing balance is untouched; only the bucket mix corrects. A leftover
// reimbursement (client hasn't paid) stays and ages normally. Runs in Dr space,
// so it is sign-agnostic (debtors & creditors), and a party with no
// reimbursements — or whose reimbursements all pair cleanly — is unchanged.
const isReimbType = (v) => /reimburs/i.test(v || '');
const isReceiptType = (v) => /receipt/i.test(v || '');
const PT_WINDOW_MS = 15 * DAY_MS;
function passThroughPair(items) {
  const tOf = (i) => (items[i].date ? items[i].date.getTime() : 0);
  // remaining reimbursement debit / receipt credit per item (positive magnitudes)
  const reimR = items.map((m) => (m.dr > 0.005 && isReimbType(m.vtype) ? m.dr : 0));
  const credR = items.map((m) => (m.dr < -0.005 && isReceiptType(m.vtype) ? -m.dr : 0));
  if (!reimR.some((x) => x > 0.005) || !credR.some((x) => x > 0.005)) return items;
  // Phase 1 — exact-value 1:1, nearest date.
  for (let i = 0; i < items.length; i++) {
    if (reimR[i] <= 0.005) continue;
    let best = -1, gap = Infinity;
    for (let j = 0; j < items.length; j++) {
      if (credR[j] <= 0.005 || Math.abs(credR[j] - reimR[i]) > 0.02) continue;
      const g = Math.abs(tOf(j) - tOf(i));
      if (g < gap) { gap = g; best = j; }
    }
    if (best >= 0) { credR[best] = r2(credR[best] - reimR[i]); reimR[i] = 0; }
  }
  // Phase 2 — leftover reimbursement pulls nearest receipts within the window.
  for (let i = 0; i < items.length; i++) {
    if (reimR[i] <= 0.005) continue;
    const cands = [];
    for (let j = 0; j < items.length; j++) if (credR[j] > 0.005 && Math.abs(tOf(j) - tOf(i)) <= PT_WINDOW_MS) cands.push(j);
    cands.sort((a, b) => Math.abs(tOf(a) - tOf(i)) - Math.abs(tOf(b) - tOf(i)));
    for (const j of cands) {
      if (reimR[i] <= 0.005) break;
      const k = Math.min(reimR[i], credR[j]);
      reimR[i] = r2(reimR[i] - k); credR[j] = r2(credR[j] - k);
    }
  }
  // Rebuild: shrink each matched leg to its remainder; drop fully-consumed legs.
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    if (m.dr > 0.005 && isReimbType(m.vtype)) { if (reimR[i] > 0.005) out.push(reimR[i] === m.dr ? m : { ...m, dr: reimR[i] }); }
    else if (m.dr < -0.005 && isReceiptType(m.vtype)) { const rem = r2(-credR[i]); if (Math.abs(rem) > 0.005) out.push(rem === m.dr ? m : { ...m, dr: rem }); }
    else out.push(m);
  }
  return out;
}
// FIFO knock-off of dated items in the party's NATURAL sign. `natSign` maps the
// Dr-positive amounts to natural (debtors +1, creditors −1). Returns the still-
// open items (aged) and the leftover advance as on-account.
function fifoAge(items, natSign, asOn) {
  const list = passThroughPair(items).map((m) => ({ date: m.date, ref: m.ref, amt: r2(natSign * m.dr) }))
    .sort((a, b) => (a.date ? a.date.getTime() : 0) - (b.date ? b.date.getTime() : 0));
  const inv = []; let credit = 0;
  for (const it of list) {
    let a = it.amt;
    if (a > 0.005) {                 // an invoice on the party's own side
      if (credit > 0.005) { const k = Math.min(credit, a); credit = r2(credit - k); a = r2(a - k); }
      if (a > 0.005) inv.push({ date: it.date, ref: it.ref, amount: a });
    } else if (a < -0.005) {         // a payment / contra — clears oldest first
      let pay = -a;
      while (pay > 0.005 && inv.length) { const k = Math.min(pay, inv[0].amount); inv[0].amount = r2(inv[0].amount - k); pay = r2(pay - k); if (inv[0].amount <= 0.005) inv.shift(); }
      if (pay > 0.005) credit = r2(credit + pay);
    }
  }
  const iso = (d) => d ? d.toISOString().slice(0, 10) : null;
  const open = inv.filter((x) => Math.abs(x.amount) > 0.005).map((x) => ({
    ref: x.ref, date: iso(x.date),
    days: x.date ? Math.floor((asOn - x.date) / DAY_MS) : null,
    amount: x.amount,               // natural sign
  }));
  return { open, onAccount: r2(-credit) }; // leftover credit is contra → negative in natural sign
}
// Ageing + open-item list for one company (`kind`), as at `asOn`.
async function readBillwiseForCompany(url, company, asOn, label, kind) {
  const savedCompany = state.settings.company;
  state.settings.company = company || '';
  const natSign = kind === 'creditors' ? -1 : 1;
  try {
    dcProgress.phase = `Reading ${label} — ledgers…`;
    dcProgress.monthsTotal = 0; dcProgress.monthsDone = 0;
    const groups = parseGroups(await askTallyFast(url, GROUPS_REQUEST()));
    const masters = parseLedgerMasters(await askTallyFast(url, LEDGER_MASTERS_REQUEST()));
    const partySet = new Set(Object.keys(masters).filter((n) => dcClassOf(groupPathOf(masters[n].parent, groups)) === kind));
    const fyStart = fyStartOf(asOn);
    dcProgress.phase = `Reading ${label} — vouchers ${fyStart.toISOString().slice(0, 10)} → ${asOn.toISOString().slice(0, 10)}…`;
    const { moves, cal } = await readAgeMovements(url, fyStart, asOn, partySet);
    dcProgress.sub = '';

    const ledgers = [];
    for (const name of partySet) {
      const m = masters[name];
      const vMoves = moves[name] || [];
      const items = vMoves.slice();
      const openDr = m.openingDr || 0;
      if (Math.abs(openDr) > 0.005) items.push({ date: fyStart, dr: openDr, ref: 'Opening balance' });
      const closingDr = r2(openDr + vMoves.reduce((s, x) => r2(s + x.dr), 0));
      const closing = r2(natSign * closingDr);
      if (Math.abs(closing) < 0.005 && !items.length) continue;
      const { open, onAccount } = fifoAge(items, natSign, asOn);
      ledgers.push({ ledger: name, gstin: m.gstin || '', pan: panFromGstin(m.gstin || ''), closing, onAccount, bills: open });
    }
    return { ok: true, url, company: company || '', label, vouchers: cal.vouchers, ledgerCount: ledgers.length, ledgers };
  } finally {
    state.settings.company = savedCompany;
  }
}

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
    // Only real user ACTIONS (POSTs: reconcile, post, upload, settings) count
    // as activity for the update idle-guard. GET polling from an open browser
    // tab (/api/data, /api/tally-check, /health every few seconds) must NOT —
    // it kept connectors "busy" forever and silently blocked self-updates.
    if (req.method === 'POST' && url.pathname !== '/update') lastActivity = Date.now();

    // CORS: the UI is a page on apps.knapadvisory.com talking to 127.0.0.1.
    // Chrome sends a preflight (incl. Private-Network) — answer it fully.
    const origin = req.headers.origin || '';
    if (ORIGIN_OK.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, version: VERSION, tallyBusy: !!currentTallyAbort });
      return;
    }
    // Release Tally: abort any in-flight request so Tally is freed for normal
    // use, without killing it from Task Manager. Also clears progress state.
    if (req.method === 'POST' && url.pathname === '/api/tally/release') {
      const wasBusy = !!currentTallyAbort;
      if (currentTallyAbort) { try { currentTallyAbort.abort(new Error('released by user')); } catch { /* */ } currentTallyAbort = null; }
      finProgress.active = false; recoProgress.active = false;
      json(res, 200, { ok: true, released: wasBusy });
      return;
    }

    // ---------------- TDS × 26AS tool (page: HUB/tds26as/) ----------------
    // The deductor memory: Tally party name -> { tan, section }, kept forever
    // in the data file — the connector's answer to "Tally doesn't know TANs".
    if (req.method === 'GET' && url.pathname === '/api/tds/data') {
      json(res, 200, { ok: true, version: VERSION, map: state.tdsMap || {}, tallyUrl: state.settings.tallyUrl });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/tds/map') {
      const body = JSON.parse(await readBody(req));
      state.tdsMap = state.tdsMap || {};
      for (const [name, v] of Object.entries(body.map || {})) {
        const key = String(name).trim();
        if (!key) continue;
        if (v === null) { delete state.tdsMap[key]; continue; }
        state.tdsMap[key] = { tan: String(v.tan || '').toUpperCase().trim(), section: String(v.section || '').toUpperCase().trim() };
      }
      saveState();
      json(res, 200, { ok: true, count: Object.keys(state.tdsMap).length });
      return;
    }
    // Read every voucher touching a TDS-receivable ledger for the period.
    // Month-chunked like the GSTR-2B read; returns one entry per TDS leg.
    if (req.method === 'POST' && url.pathname === '/api/tds/read') {
      const body = JSON.parse(await readBody(req));
      const from = tallyDateOf(String(body.from || '').replace(/-/g, ''));
      const to = tallyDateOf(String(body.to || '').replace(/-/g, ''));
      if (!from || !to || from > to) { json(res, 400, { ok: false, error: 'Bad period.' }); return; }
      const pat = new RegExp(String(body.pattern || 'tds.*receivable').trim() || 'tds.*receivable', 'i');
      const entries = [];
      // Tally's collection export can emit the same voucher block several
      // times (seen in the field: every entry exactly 4×). Dedupe by GUID,
      // falling back to a full signature for GUID-less blocks.
      const seenV = new Set();
      let months = 0, vouchers = 0;
      try {
        for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); d <= to;
             d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
          const mFrom = d < from ? from : d;
          const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
          const mTo = mEnd > to ? to : mEnd;
          const xml = await askTally(state.settings.tallyUrl, voucherCollectionRequest(mFrom, mTo));
          months++;
          for (const block of xml.match(/<VOUCHER[\s>][\s\S]*?<\/VOUCHER>/gi) || []) {
            if (/<ISCANCELLED>\s*Yes/i.test(block) || /<ISOPTIONAL>\s*Yes/i.test(block)) continue;
            const legs = [];
            for (const e of block.match(/<(?:ALL)?LEDGERENTRIES\.LIST>[\s\S]*?<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi) || []) {
              const name = tag(e, 'LEDGERNAME');
              if (name) legs.push({ name, amt: toNum(tag(e, 'AMOUNT')) });
            }
            const tdsLegs = legs.filter((l) => pat.test(l.name));
            if (!tdsLegs.length) continue;
            const vid = tag(block, 'GUID') ||
              (tag(block, 'DATE') + '|' + tag(block, 'VOUCHERTYPENAME') + '|' + tag(block, 'VOUCHERNUMBER') + '|' +
               legs.map((l) => l.name + '=' + l.amt).join(';'));
            if (seenV.has(vid)) continue;
            seenV.add(vid);
            const date = tallyDateOf(tag(block, 'DATE'));
            // Some Tally setups ignore SVFROMDATE/SVTODATE on collection
            // exports and return the WHOLE ledger for every monthly chunk
            // (seen in the field: totals = ledger × number of months read).
            // The dedupe above collapses the repeats; this keeps the period
            // honest by dropping vouchers dated outside the asked range.
            if (date && (date < from || date > to)) continue;
            vouchers++;
            const partyTag = tag(block, 'PARTYLEDGERNAME');
            for (const tl of tdsLegs) {
              // The deductor: the voucher's party ledger, else the biggest
              // opposite-signed leg (journal Dr TDS / Cr Customer; receipt
              // Dr Bank + Dr TDS / Cr Customer both resolve to the customer).
              let party = partyTag;
              if (!party || pat.test(party)) {
                const opp = legs.filter((l) => !pat.test(l.name) && Math.sign(l.amt) !== Math.sign(tl.amt))
                  .sort((a, b) => Math.abs(b.amt) - Math.abs(a.amt));
                party = opp.length ? opp[0].name : (legs.find((l) => !pat.test(l.name)) || {}).name || '';
              }
              entries.push({
                date: date ? date.toISOString().slice(0, 10) : '',
                vno: tag(block, 'VOUCHERNUMBER'), vtype: tag(block, 'VOUCHERTYPENAME'),
                party, ledger: tl.name, tds: r2(Math.abs(tl.amt)),
                narration: tag(block, 'NARRATION').slice(0, 200),
              });
            }
          }
        }
        json(res, 200, { ok: true, entries, months, vouchers });
      } catch (e) {
        json(res, 502, { ok: false, error: 'Could not read Tally: ' + String((e && e.message) || e) });
      }
      return;
    }

    // ---------------- Financial statements (page: HUB/finprep/) -----------
    // Grouped trial balance for two year-ends: every ledger with its closing
    // balance (current + prior) and its full group path up to the reserved
    // primary group, so the page can classify into Schedule III heads.
    if (req.method === 'GET' && url.pathname === '/api/fin/progress') {
      json(res, 200, finProgress);
      return;
    }
    // Company + its books period (fast master read) so the page can default to
    // dates that are actually inside the data.
    // Company + its books period — a single FAST master read, so the page can
    // fill the name/period/entity instantly. Ledger + group COUNTS are a
    // separate call (/api/fin/counts) so nothing heavy delays the name.
    if (req.method === 'GET' && url.pathname === '/api/fin/company') {
      try {
        const c = parseCompany(await askTallyFast(state.settings.tallyUrl, FIN_COMPANY_REQUEST(), 15000));
        json(res, 200, {
          ok: true, name: c.name, version: VERSION,
          start: c.start ? c.start.toISOString().slice(0, 10) : null,
          booksFrom: c.booksFrom ? c.booksFrom.toISOString().slice(0, 10) : null,
          lastVoucher: c.lastVch ? c.lastVch.toISOString().slice(0, 10) : null,
          endingAt: c.endingAt ? c.endingAt.toISOString().slice(0, 10) : null,
        });
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    // Cheap stored-only counts (group tree + ledger list) for the books grid —
    // best-effort, fetched in the background so they never hold up the name.
    if (req.method === 'GET' && url.pathname === '/api/fin/counts') {
      let groupCount = null, ledgerCount = null;
      try { groupCount = Object.keys(parseGroups(await askTallyFast(state.settings.tallyUrl, GROUPS_REQUEST(), 20000))).length; } catch { /* */ }
      try { ledgerCount = Object.keys(parseLedgerMasters(await askTallyFast(state.settings.tallyUrl, LEDGER_MASTERS_REQUEST(), 25000))).length; } catch { /* */ }
      json(res, 200, { ok: true, groupCount, ledgerCount });
      return;
    }
    // Saved ledger → Schedule III note map, remembered on THIS machine so the
    // reviewer's assignments stick across sessions and future reads.
    if (req.method === 'GET' && url.pathname === '/api/fin/map') {
      json(res, 200, { ok: true, map: state.finMap || {} });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/fin/map') {
      const body = JSON.parse(await readBody(req));
      state.finMap = state.finMap || {};
      if (body && body.map && typeof body.map === 'object') {
        for (const k of Object.keys(body.map)) {
          const v = body.map[k];
          if (v == null || v === '') delete state.finMap[k];
          else state.finMap[k] = Number(v);
        }
      }
      saveState();
      json(res, 200, { ok: true, map: state.finMap });
      return;
    }
    // Diagnostic: probe the FAST candidate ways to get balances (the bulk
    // ClosingBalance collection is known-slow), returning exactly what Tally
    // replies so we can pick the working method and parse its real structure.
    if (req.method === 'POST' && url.pathname === '/api/fin/diag') {
      const probe = async (label, body, ms = 20000, sampleLen = 2200) => {
        const t0 = Date.now();
        try {
          const xml = await askTallyFast(state.settings.tallyUrl, body, ms);
          return { label, ok: true, ms: Date.now() - t0, length: xml.length, sample: xml.slice(0, sampleLen) };
        } catch (e) {
          return { label, ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) };
        }
      };
      // Step 1: detect the company's real books period (fast master read).
      const companyProbe = await probe('0) Company period', FIN_COMPANY_REQUEST(), 15000);
      let comp = null;
      try { comp = parseCompany(companyProbe.sample ? await askTallyFast(state.settings.tallyUrl, FIN_COMPANY_REQUEST(), 15000) : ''); } catch { /* */ }
      // The v3.6 read path: everything below is a FAST, stored-only or
      // voucher read (no ClosingBalance computation), so none of it hangs.
      const to = comp && comp.lastVch ? comp.lastVch
        : comp && comp.endingAt ? comp.endingAt : new Date(Date.UTC(2026, 2, 31));
      const from = comp && (comp.booksFrom || comp.start) ? (comp.booksFrom || comp.start) : new Date(Date.UTC(2025, 3, 1));
      // A) ledger masters (Name + Parent + OpeningBalance) — stored only.
      const mastersProbe = await probe('A) Ledger masters (name+parent+opening)', LEDGER_MASTERS_REQUEST(), 30000);
      // A2) group tree + how sample ledgers resolve (raw parent → primary →
      //     full "booked under" chain). This is what pins down any group-tree
      //     surprise (e.g. reserved groups whose parent is "Primary").
      let groupResolve = null;
      try {
        const groups = parseGroups(await askTallyFast(state.settings.tallyUrl, GROUPS_REQUEST(), 20000));
        const masters = parseLedgerMasters(await askTallyFast(state.settings.tallyUrl, LEDGER_MASTERS_REQUEST(), 30000));
        const primaries = Object.entries(groups).filter(([, g]) => isPrimaryGroup(g)).map(([n]) => n);
        const sample = Object.keys(masters).slice(0, 15).map((name) => ({
          ledger: name, rawParent: masters[name].parent,
          primary: primaryGroupOf(masters[name].parent, groups),
          path: groupPathOf(masters[name].parent, groups).join(' > '),
          gstin: masters[name].gstin || '',
        }));
        groupResolve = { groupCount: Object.keys(groups).length, primaryGroups: primaries.slice(0, 40), sampleLedgers: sample };
      } catch (e) { groupResolve = { error: String((e && e.message) || e) }; }
      // B) one month of vouchers — the proven read the GST/TDS tools use daily.
      const oneFrom = to ? new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1)) : from;
      const vProbe = await probe('B) One month of vouchers', voucherCollectionRequest(oneFrom, to), 60000, 2600);
      // Summarise what the voucher read actually contained.
      let vSummary = null;
      if (vProbe.ok) {
        try {
          const xml = await askTallyFast(state.settings.tallyUrl, voucherCollectionRequest(oneFrom, to), 60000);
          const sums = {}, seen = new Set(), cal = { vouchers: 0, dupes: 0, noFlag: 0 };
          accumulateTB(xml, sums, seen, cal, 0);
          const led = Object.keys(sums).length;
          const net = r2(Object.values(sums).reduce((s, v) => s + v.dr, 0));
          const top = Object.entries(sums).map(([n, v]) => ({ ledger: n, dr: v.dr }))
            .sort((a, b) => Math.abs(b.dr) - Math.abs(a.dr)).slice(0, 12);
          vSummary = { vouchers: cal.vouchers, ledgersTouched: led, netShouldBeZero: net, unflaggedEntries: cal.noFlag, top };
        } catch (e) { vSummary = { error: String((e && e.message) || e) }; }
      }
      const out = {
        tallyUrl: state.settings.tallyUrl, company: state.settings.company || '(active company)', version: VERSION,
        readPath: 'v3.6 vouchers (balances derived here, not computed by Tally)',
        detectedCompany: comp ? comp.name : '(unknown)',
        detectedStart: from ? from.toISOString().slice(0, 10) : null,
        detectedLastVoucher: comp && comp.lastVch ? comp.lastVch.toISOString().slice(0, 10) : null,
        oneMonthProbed: (oneFrom && to) ? (oneFrom.toISOString().slice(0, 10) + ' → ' + to.toISOString().slice(0, 10)) : '(unknown)',
        company0: companyProbe,
        A_ledgerMasters: mastersProbe,
        A2_groupResolve: groupResolve,
        B_oneMonthVouchers: vProbe,
        B_voucherSummary: vSummary,
      };
      json(res, 200, { ok: true, diag: out });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/fin/trialbalance') {
      const body = JSON.parse(await readBody(req));
      // Accept a period {from, to}; fall back to the old {asOn, priorAsOn}.
      const to = tallyDateOf(String(body.to || body.asOn || '').replace(/-/g, ''));
      const from = tallyDateOf(String(body.from || body.priorAsOn || '').replace(/-/g, ''));
      if (!to || !from) { json(res, 400, { ok: false, error: 'Set both period dates.' }); return; }
      if (from > to) { json(res, 400, { ok: false, error: 'Period-from is after period-to.' }); return; }
      finProgress.active = true; finProgress.steps = 3; finProgress.step = 1;
      try {
        // 1) Group tree + ledger masters — both stored-only reads, fast, never
        //    hang Tally (the group read has always worked in ~0.2s).
        finProgress.phase = 'Reading the group tree from Tally…';
        const groups = parseGroups(await askTallyFast(state.settings.tallyUrl, GROUPS_REQUEST()));
        finProgress.phase = 'Reading the ledger list from Tally…';
        const masters = parseLedgerMasters(await askTallyFast(state.settings.tallyUrl, LEDGER_MASTERS_REQUEST()));

        // 2) Books start — informational only (confirms the right company is
        //    open and the period sits inside the data).
        let booksStart = null;
        try {
          const c = parseCompany(await askTallyFast(state.settings.tallyUrl, FIN_COMPANY_REQUEST(), 15000));
          booksStart = c.booksFrom || c.start || null;
        } catch { /* not essential */ }

        // 3) Vouchers → per-ledger Dr-positive movements (the proven read path).
        //    We read exactly the requested period, so:
        //      • Balance-sheet ledgers  → master opening + this period's movement
        //      • P&L ledgers            → this period's movement (opening is 0)
        //    and the whole trial balance ties to ~0 automatically. (Reading from
        //    books-start instead would make P&L accounts show life-to-date
        //    figures — wrong for a period statement — so we don't. True prior-
        //    year comparatives are a later enhancement.)
        const readStart = from;
        finProgress.step = 2; finProgress.phase = 'Reading vouchers for the period…';
        const { sums, cal, monthsTotal } = await readTBFromVouchers(state.settings.tallyUrl, readStart, from, to);
        finProgress.active = false;

        // Union of every ledger we know about: masters (group + opening) plus
        // any ledger seen only in vouchers.
        const names = new Set([...Object.keys(masters), ...Object.keys(sums)]);
        if (!names.size || cal.vouchers === 0) {
          json(res, 200, { ok: false, error: 'Tally returned no vouchers for this period. Make sure the right company is open and the period actually has transactions — then try again.' });
          return;
        }
        const anyRevenueAncestor = (gn) => (function up(g, d) {
          if (!g || d > 30) return false; const gg = groups[g]; if (!gg) return false;
          return gg.isRevenue || up(gg.parent, d + 1);
        })(gn, 0);
        const ledgers = [...names].map((name) => {
          const m = masters[name] || { parent: '', openingDr: 0 };
          const mv = sums[name] || { dr: 0, priorDr: 0 };
          const open = m.openingDr || 0;
          const path = groupPathOf(m.parent, groups); // ["Sundry Creditors","Current Liabilities"]
          return {
            name, group: m.parent, primary: primaryGroupOf(m.parent, groups),
            groupPath: path,                  // full "Booked under" chain, ledger → primary
            gstin: m.gstin || '',             // party GSTIN from the master (sharpens classification)
            opening: r2(open),                // stored master opening balance (Dr +)
            isRevenue: !!(groups[m.parent] && anyRevenueAncestor(m.parent)),
            current: r2(open + mv.dr),        // closing at period-to
            prior: r2(open + mv.priorDr),     // balance at period-from
          };
        }).filter((l) => Math.abs(l.current) > 0.005 || Math.abs(l.prior) > 0.005);

        // Diagnostics the page surfaces: the trial balance should tie to ~0.
        const tieCurrent = r2(ledgers.reduce((s, l) => s + l.current, 0));
        const tiePrior = r2(ledgers.reduce((s, l) => s + l.prior, 0));
        json(res, 200, {
          ok: true, version: VERSION, basis: 'vouchers',
          asOn: to.toISOString().slice(0, 10),
          priorAsOn: from.toISOString().slice(0, 10),
          readFrom: readStart.toISOString().slice(0, 10),
          booksStart: booksStart ? booksStart.toISOString().slice(0, 10) : null,
          groupCount: Object.keys(groups).length,
          ledgerCount: Object.keys(masters).length,
          voucherCount: cal.vouchers, duplicatesDropped: cal.dupes,
          monthsRead: monthsTotal, unflaggedEntries: cal.noFlag,
          tieCurrent, tiePrior,
          savedMap: state.finMap || {},   // ledger → Schedule III note, remembered here
          ledgers,
        });
      } catch (e) {
        finProgress.active = false;
        const msg = /timeout|abort|released/i.test(String((e && e.message) || e))
          ? 'Tally stopped responding while reading vouchers. Keep Tally on the Gateway (not inside a report) and try again. If it keeps failing, use “Release Tally”, then retry a shorter period.'
          : 'Could not read Tally: ' + String((e && e.message) || e);
        json(res, 502, { ok: false, error: msg });
      }
      return;
    }

    // ---------- Multi-company debtor/creditor consolidation ----------
    // DIAGNOSTIC: per-ledger breakdown for one company so a mismatch against
    // Tally's Group Summary can be pinned down exactly. Open in a browser on
    // the Tally PC, e.g.
    //   /api/dc/diag?company=N%20K%20MEHTA%20AND%20ASSOCIATES&kind=debtors&asOn=2026-06-20
    // Returns raw opening string, parsed opening (Dr+), voucher movement and the
    // computed closing for every ledger under Sundry Debtors/Creditors.
    if (req.method === 'GET' && url.pathname === '/api/dc/diag') {
      const company = url.searchParams.get('company') || '';
      const kind = url.searchParams.get('kind') === 'creditors' ? 'creditors' : 'debtors';
      const u = url.searchParams.get('url') || state.settings.tallyUrl;
      const asOn = tallyDateOf(String(url.searchParams.get('asOn') || '').replace(/-/g, ''));
      if (!asOn) { json(res, 400, { ok: false, error: 'Add &asOn=YYYY-MM-DD' }); return; }
      const saved = state.settings.company;
      state.settings.company = company;
      // Raw voucher-entry dump for ONE ledger (add &ledger=<name>) — shows the
      // exact <AMOUNT>/forex fields so a specific mismatch can be pinned down.
      const wantLedger = url.searchParams.get('ledger');
      if (wantLedger) {
        const wln = norm(wantLedger);
        const fyStart = fyStartOf(asOn);
        const toKey = asOn.getUTCFullYear() * 10000 + (asOn.getUTCMonth() + 1) * 100 + asOn.getUTCDate();
        const entries = []; const seen = new Set();
        try {
          for (let d = new Date(Date.UTC(fyStart.getUTCFullYear(), fyStart.getUTCMonth(), 1)); d <= asOn; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
            const mFrom = d < fyStart ? fyStart : d;
            const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
            const mTo = mEnd > asOn ? asOn : mEnd;
            const xml = await askTally(u, voucherCollectionRequest(mFrom, mTo));
            for (const block of xml.match(/<VOUCHER[\s>][\s\S]*?<\/VOUCHER>/gi) || []) {
              const gk = tag(block, 'GUID') || `${tag(block, 'DATE')}|${tag(block, 'VOUCHERNUMBER')}|${tag(block, 'VOUCHERTYPENAME')}`;
              if (seen.has(gk)) continue; seen.add(gk);
              if (toKey && dateKey(tag(block, 'DATE')) > toKey) continue;
              const guid = tag(block, 'GUID');
              const allBlocks = block.match(/<ALLLEDGERENTRIES\.LIST>[\s\S]*?<\/ALLLEDGERENTRIES\.LIST>/gi) || [];
              const plainBlocks = block.match(/<LEDGERENTRIES\.LIST>[\s\S]*?<\/LEDGERENTRIES\.LIST>/gi) || [];
              const matchInVoucher = (block.match(/<(?:ALL)?LEDGERENTRIES\.LIST>[\s\S]*?<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi) || []).filter((e) => norm(tag(e, 'LEDGERNAME')) === wln).length;
              for (const e of block.match(/<(?:ALL)?LEDGERENTRIES\.LIST>[\s\S]*?<\/(?:ALL)?LEDGERENTRIES\.LIST>/gi) || []) {
                if (norm(tag(e, 'LEDGERNAME')) !== wln) continue;
                entries.push({
                  guid, allBlocks: allBlocks.length, plainBlocks: plainBlocks.length, matchInVoucher,
                  date: tag(block, 'DATE'), vtype: tag(block, 'VOUCHERTYPENAME'), vno: tag(block, 'VOUCHERNUMBER'),
                  amountRaw: tag(e, 'AMOUNT'), isDeemedPositive: tag(e, 'ISDEEMEDPOSITIVE'),
                  forexAmount: tag(e, 'FOREXAMOUNT'), rateOfExchange: tag(e, 'RATEOFEXCHANGE'),
                  // trimmed raw entry block so any other amount fields are visible
                  rawEntry: e.replace(/\s+/g, ' ').slice(0, 900),
                });
              }
            }
          }
          const master = parseLedgerMasters(await askTallyFast(u, LEDGER_MASTERS_REQUEST()))[wantLedger] || null;
          state.settings.company = saved;
          json(res, 200, { ok: true, company, ledger: wantLedger, asOn: asOn.toISOString().slice(0, 10), openingRaw: master ? master.openingRaw : null, openingDr: master ? master.openingDr : null, count: entries.length, entries });
        } catch (e) { state.settings.company = saved; json(res, 502, { ok: false, error: String((e && e.message) || e) }); }
        return;
      }
      try {
        const groups = parseGroups(await askTallyFast(u, GROUPS_REQUEST()));
        const masters = parseLedgerMasters(await askTallyFast(u, LEDGER_MASTERS_REQUEST()));
        const readStart = fyStartOf(asOn); // movement from the FY start (see readDCForCompany)
        const { sums, cal } = await readDCMovements(u, readStart, asOn);
        const rows = [];
        let total = 0;
        for (const name of new Set([...Object.keys(masters), ...Object.keys(sums)])) {
          const m = masters[name] || { parent: '', openingRaw: '', openingDr: 0 };
          if (dcClassOf(groupPathOf(m.parent, groups)) !== kind) continue;
          const mv = (sums[name] && sums[name].dr) || 0;
          const closingDr = r2((m.openingDr || 0) + mv);
          total = r2(total + closingDr);
          rows.push({ ledger: name, group: m.parent, openingRaw: m.openingRaw || '', openingDr: m.openingDr || 0, movementDr: r2(mv), closingDr });
        }
        rows.sort((a, b) => Math.abs(b.closingDr) - Math.abs(a.closingDr));
        state.settings.company = saved;
        json(res, 200, { ok: true, company, kind, asOn: asOn.toISOString().slice(0, 10), readFrom: readStart.toISOString().slice(0, 10), vouchers: cal.vouchers, noFlag: cal.noFlag, afterTo: cal.afterTo || 0, ledgerCount: rows.length, total, rows });
      } catch (e) {
        state.settings.company = saved;
        json(res, 502, { ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    // Live progress for the (long) side-by-side read, polled by the page.
    if (req.method === 'GET' && url.pathname === '/api/dc/progress') {
      // Overall fraction = companies fully done + fraction of the current one.
      const frac = dcProgress.monthsTotal ? dcProgress.monthsDone / dcProgress.monthsTotal : 0;
      const pct = dcProgress.total ? Math.min(100, Math.round(100 * (dcProgress.done + frac) / dcProgress.total)) : 0;
      const elapsed = dcProgress.startedAt ? (Date.now() - dcProgress.startedAt) / 1000 : 0;
      const etaSec = (dcProgress.active && pct > 2 && pct < 100) ? Math.round(elapsed * (100 - pct) / pct) : null;
      json(res, 200, { ...dcProgress, pct, etaSec });
      return;
    }
    // Learned aliases — confirmed groupings remembered across runs.
    if (req.method === 'GET' && url.pathname === '/api/dc/aliases') {
      json(res, 200, { ok: true, version: VERSION, aliases: state.dcAliases || {} });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/dc/aliases') {
      const body = JSON.parse(await readBody(req));
      state.dcAliases = body.aliases && typeof body.aliases === 'object' ? body.aliases : {};
      saveState();
      json(res, 200, { ok: true, count: Object.keys(state.dcAliases).length });
      return;
    }
    // List the companies open on each Tally endpoint (with their GSTINs). The
    // page passes the Tally URLs to scan (one Tally on many companies, and/or
    // several Tally instances on different ports); default is the connector's
    // configured Tally URL.
    if (req.method === 'POST' && url.pathname === '/api/dc/companies') {
      const body = JSON.parse(await readBody(req).catch(() => '{}') || '{}');
      let urls = Array.isArray(body.urls) ? body.urls.map((u) => String(u).trim()).filter(Boolean) : [];
      if (!urls.length) urls = [state.settings.tallyUrl];
      urls = [...new Set(urls)];
      const endpoints = [];
      for (const u of urls) {
        try {
          const companies = parseCompanies(await askTallyFast(u, COMPANY_REQUEST(), 15000));
          endpoints.push({ url: u, ok: true, companies });
        } catch (e) {
          endpoints.push({ url: u, ok: false, error: String((e && e.message) || e), companies: [] });
        }
      }
      json(res, 200, { ok: true, version: VERSION, defaultUrl: state.settings.tallyUrl, endpoints });
      return;
    }
    // Extract debtors/creditors as at a date across the chosen companies, one
    // by one (never all at once). Returns each company's party list; the page
    // does the matching, review and Excel.
    if (req.method === 'POST' && url.pathname === '/api/dc/extract') {
      if (dcProgress.active) { json(res, 409, { ok: false, error: 'A read is already running.' }); return; }
      const body = JSON.parse(await readBody(req));
      const kind = body.kind === 'creditors' ? 'creditors' : 'debtors';
      const asOn = tallyDateOf(String(body.asOn || '').replace(/-/g, ''));
      const targets = Array.isArray(body.targets) ? body.targets : [];
      if (!asOn) { json(res, 400, { ok: false, error: 'Set the "as on" date.' }); return; }
      if (!targets.length) { json(res, 400, { ok: false, error: 'Pick at least one company.' }); return; }
      dcProgress.active = true; dcProgress.done = 0; dcProgress.total = targets.length; dcProgress.phase = 'Starting…'; dcProgress.sub = '';
      dcProgress.startedAt = Date.now(); dcProgress.monthsDone = 0; dcProgress.monthsTotal = 0;
      const companies = [];
      try {
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i] || {};
          const label = String(t.company || '').trim() || `Tally ${t.url || ''}`;
          dcProgress.company = label; dcProgress.done = i;
          const one = await readDCForCompany(String(t.url || state.settings.tallyUrl), String(t.company || ''), asOn, label, kind);
          const parties = one.parties.map((p) => ({
            ledger: p.ledger, gstin: p.gstin, pan: p.pan, group: p.group,
            // Present in the natural sign of the side being viewed: debtors
            // Dr-positive (credit balances negative); creditors Cr-positive
            // (debit balances negative).
            balance: kind === 'creditors' ? r2(-p.balanceDr) : p.balanceDr,
          }));
          companies.push({
            url: one.url, company: one.company, label, method: one.method,
            voucherCount: one.voucherCount, partyCount: parties.length, parties,
          });
          dcProgress.done = i + 1;
        }
        dcProgress.active = false;
        json(res, 200, { ok: true, version: VERSION, kind, asOn: asOn.toISOString().slice(0, 10), companies, aliases: state.dcAliases || {} });
      } catch (e) {
        dcProgress.active = false;
        const msg = /timeout|abort|released/i.test(String((e && e.message) || e))
          ? 'Tally stopped responding while reading. Keep Tally on the Gateway (not inside a report), make sure the company is open, then try again. “Release Tally” frees a stuck read.'
          : 'Could not read Tally: ' + String((e && e.message) || e);
        json(res, 502, { ok: false, error: msg, company: dcProgress.company });
      }
      return;
    }
    // Bill-wise outstanding + ageing across the chosen companies. Same targets
    // and date as /api/dc/extract; the page maps ledgers to the matched parties.
    if (req.method === 'POST' && url.pathname === '/api/dc/billwise') {
      if (dcProgress.active) { json(res, 409, { ok: false, error: 'A read is already running.' }); return; }
      const body = JSON.parse(await readBody(req));
      const kind = body.kind === 'creditors' ? 'creditors' : 'debtors';
      const asOn = tallyDateOf(String(body.asOn || '').replace(/-/g, ''));
      const targets = Array.isArray(body.targets) ? body.targets : [];
      if (!asOn) { json(res, 400, { ok: false, error: 'Set the "as on" date.' }); return; }
      if (!targets.length) { json(res, 400, { ok: false, error: 'Pick at least one company.' }); return; }
      dcProgress.active = true; dcProgress.done = 0; dcProgress.total = targets.length; dcProgress.phase = 'Starting…'; dcProgress.sub = '';
      dcProgress.startedAt = Date.now(); dcProgress.monthsDone = 0; dcProgress.monthsTotal = 0;
      const companies = [];
      try {
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i] || {};
          const label = String(t.company || '').trim() || `Tally ${t.url || ''}`;
          dcProgress.company = label; dcProgress.done = i;
          const one = await readBillwiseForCompany(String(t.url || state.settings.tallyUrl), String(t.company || ''), asOn, label, kind);
          // values already in the party's natural sign (debtors +, creditors +)
          const ledgers = one.ledgers.map((L) => ({
            ledger: L.ledger, gstin: L.gstin, pan: L.pan,
            closing: L.closing, onAccount: L.onAccount,
            bills: L.bills.map((b) => ({ ref: b.ref, date: b.date, dueDate: b.dueDate || null, days: b.days, amount: b.amount })),
          }));
          companies.push({ url: one.url, company: one.company, label, ledgerCount: ledgers.length, ledgers });
          dcProgress.done = i + 1;
        }
        dcProgress.active = false;
        json(res, 200, { ok: true, version: VERSION, kind, asOn: asOn.toISOString().slice(0, 10), companies });
      } catch (e) {
        dcProgress.active = false;
        const msg = /timeout|abort|released/i.test(String((e && e.message) || e))
          ? 'Tally stopped responding while reading bills. Keep Tally on the Gateway, make sure the company is open, then try again. “Release Tally” frees a stuck read.'
          : 'Could not read Tally: ' + String((e && e.message) || e);
        json(res, 502, { ok: false, error: msg, company: dcProgress.company });
      }
      return;
    }

    // One-click "Update now" from a tool page: check the hub immediately,
    // ignoring the idle guard — the user explicitly asked for it.
    if (req.method === 'POST' && url.pathname === '/update') {
      json(res, 200, { ok: true, version: VERSION });
      setTimeout(() => selfUpdate(true), 200);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>KNAP Tally Connector</title>' +
        '<body style="font:15px system-ui;padding:40px;max-width:560px;margin:auto">' +
        '<h2>🔌 KNAP Tally Connector v' + VERSION + '</h2>' +
        '<p>Running. This window has no interface of its own — the tool lives at</p>' +
        '<p><a href="' + HUB + '/gstr2b/">' + HUB + '/gstr2b/</a></p>');
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

// An older copy still running would silently keep serving the OLD version —
// the browser then shows a stale v-number no matter how often this file is
// replaced. Say it loudly instead of dying with a stack trace.
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('');
    console.log('  🛑 ANOTHER COPY OF THE CONNECTOR IS ALREADY RUNNING on port ' + PORT + '.');
    console.log('     That is usually fine — the tool page is talking to that copy.');
    console.log('     To restart cleanly: Ctrl+Shift+Esc → Task Manager → end the "Node.js"');
    console.log('     processes, then run the installer or run-loop again.');
    console.log('');
  } else {
    console.log('  🛑 Could not start: ' + String((e && e.message) || e));
  }
  process.exit(1);
});
// --------------------------- audit engine (child) ----------------------------
// The connector also runs the Tally Audit engine (its page: HUB/audit/) as a
// supervised child process on 127.0.0.1:8799, downloading it on first run and
// keeping it current from the hub's version.json ("audit" field).
import { spawn } from 'node:child_process';
const AUDIT_FILE = path.join(path.dirname(SELF), 'knap-tally-audit-engine.mjs');
let auditChild = null;
let stopping = false;

function auditLocalVersion() {
  try {
    const m = /const VERSION = '([^']+)'/.exec(fs.readFileSync(AUDIT_FILE, 'utf8'));
    return m ? m[1] : '';
  } catch { return ''; }
}

function startAudit() {
  if (auditChild || stopping || !fs.existsSync(AUDIT_FILE)) return;
  auditChild = spawn(process.execPath, [AUDIT_FILE], {
    env: { ...process.env, PORT: '8799', KNAP_HUB: HUB },
    stdio: 'inherit',
  });
  auditChild.on('exit', (code) => {
    auditChild = null;
    if (!stopping) setTimeout(startAudit, 5000).unref(); // crash → retry
  });
}

async function ensureAudit(wantVersion, force) {
  try {
    if (fs.existsSync(AUDIT_FILE) && (!wantVersion || auditLocalVersion() === wantVersion)) { startAudit(); return; }
    if (!force && auditChild && lastActivity && Date.now() - lastActivity < 10 * 60 * 1000) return; // busy — later
    const code = await fetch(HUB + '/connector/knap-tally-audit-engine.mjs', { signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.text() : null));
    if (!code || !code.includes('KNAP Tally Audit Engine')) return; // sanity check
    fs.writeFileSync(AUDIT_FILE + '.new', code);
    if (auditChild) { stopping = true; auditChild.kill(); await new Promise((r) => setTimeout(r, 1500)); stopping = false; auditChild = null; }
    fs.renameSync(AUDIT_FILE + '.new', AUDIT_FILE);
    console.log('  ⬆ Audit engine ' + (wantVersion ? 'updated to v' + wantVersion : 'installed') + '.');
    startAudit();
  } catch { startAudit(); /* offline: run whatever we have */ }
}

process.on('exit', () => { stopping = true; if (auditChild) auditChild.kill(); });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// ------------------------------ self-update ---------------------------------
// Checks the hub for a newer connector when idle; writes the new file over
// itself and exits 0 — the installer's run-loop restarts the fresh copy.
let lastActivity = 0;
async function selfUpdate(force) {
  try {
    // Never restart mid-reconcile or mid-posting — even a forced update waits.
    if (recoProgress.active) return;
    const v = await fetch(HUB + '/connector/version.json', { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : null));
    if (!v) { startAudit(); return; }
    await ensureAudit(v.audit || '', force);
    if (!v.version || v.version === VERSION) return;
    if (!force && lastActivity && Date.now() - lastActivity < 10 * 60 * 1000) return; // someone is working — not now
    const code = await fetch(HUB + '/connector/knap-tally-connector.mjs', { signal: AbortSignal.timeout(30000) })
      .then((r) => (r.ok ? r.text() : null));
    if (!code || !code.includes('KNAP Tally Connector')) return; // sanity check
    fs.writeFileSync(SELF + '.new', code);
    fs.renameSync(SELF + '.new', SELF);
    console.log('  ⬆ Updated to v' + v.version + ' — restarting.');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  } catch { startAudit(); /* offline or hub unreachable — run what we have */ }
}
setTimeout(selfUpdate, 15 * 1000);                       // shortly after start
setInterval(selfUpdate, 6 * 3600 * 1000).unref();        // then every 6 hours
startAudit();                                            // run local copy immediately if present

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  KNAP Tally Connector v' + VERSION + ' running on 127.0.0.1:' + PORT + '.');
  console.log('  The tool page: ' + HUB + '/gstr2b/');
  console.log('');
  console.log('  Data file: ' + DATA_FILE);
  console.log('  Tally URL: ' + state.settings.tallyUrl + ' (change under Settings in the page)');
});
