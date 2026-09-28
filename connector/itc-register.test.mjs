/* ============================================================================
 * itc-register.test.mjs — the ITC register read, against a stub Tally.
 *
 *   node connector/itc-register.test.mjs
 *
 * The stub serves a day book of 3,000 vouchers of which 600 carry input GST,
 * plus one stock-item purchase whose purchase leg is NOT beside the tax legs.
 * It can honour the pre-filter or quietly drop one voucher from it, which is
 * the case that matters: a faster read that loses ITC is not faster, it is
 * wrong. The reader must prove the filter before trusting it.
 * ==========================================================================*/
import http from 'node:http';
import { spawn } from 'node:child_process';

const TOTAL = 3000, ITC_EVERY = 5;           // 600 ITC vouchers among 3000
let mode = 'good', stats = { plain: 0, filtered: 0, ledger: 0, bytes: 0 };

const vch = (i, itc) => `<VOUCHER VCHTYPE="Purchase">
<DATE>${20250401 + Math.floor(i / 20)}</DATE><GUID>g-${i}</GUID>
<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>PI/${i}</VOUCHERNUMBER>
<PARTYLEDGERNAME>Supplier ${i % 50}</PARTYLEDGERNAME><SUPPLIERINVOICENO>INV-${i}</SUPPLIERINVOICENO>
<ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><CMPGSTIN>06AAACE1234F1Z5</CMPGSTIN>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Supplier ${i % 50}</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>11800</AMOUNT></ALLLEDGERENTRIES.LIST>
${itc ? '' : '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchases</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-11800</AMOUNT></ALLLEDGERENTRIES.LIST>'}
${itc ? '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchases</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-10000</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Input IGST</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1800</AMOUNT></ALLLEDGERENTRIES.LIST>' : ''}
</VOUCHER>`;

/* a stock-item purchase: the purchase leg lives in the inventory allocations,
   so only the party and tax legs are at the top level */
const stockVch = (i) => `<VOUCHER VCHTYPE="Purchase">
<DATE>20250405</DATE><GUID>s-${i}</GUID><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
<VOUCHERNUMBER>SPI/${i}</VOUCHERNUMBER><PARTYLEDGERNAME>Stock Supplier</PARTYLEDGERNAME>
<SUPPLIERINVOICENO>SINV-${i}</SUPPLIERINVOICENO><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Stock Supplier</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>23600</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input IGST</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-3600</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER>`;

/* A real purchase from the field (Bombay Hardware, MNL-25-26-3459): stock
   items 7,63,104.80 plus loading 2,200 and freight 10,000 make a taxable
   value of 7,75,304.80 — exactly 18% of which is the 1,39,554.86 IGST. TDS of
   763.10 is withheld and 0.44 is rounded. The taxable figure must be the
   7,75,304.80 the supplier billed, not that plus the TDS. */
const tdsVch = () => `<VOUCHER VCHTYPE="Purchase">
<DATE>20251105</DATE><GUID>tds-1</GUID><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
<VOUCHERNUMBER>MNL-25-26-3459</VOUCHERNUMBER><SUPPLIERINVOICENO>MNL-25-26-3459</SUPPLIERINVOICENO>
<PARTYLEDGERNAME>Bombay Hardware Pvt Ltd</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Bombay Hardware Pvt Ltd</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>914097.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>PURCHASE</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-763104.80</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>LOADING CHARGE @18%</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-2200.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Freight Charges</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Input IGST</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-139554.86</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>TDS on Goods@0.1%</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>763.10</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Round Off</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-0.44</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER>`;

const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    res.setHeader('content-type', 'text/xml');
    if (/KnapLedgers|Ledger/i.test(b) && !/Voucher/i.test(b)) {
      return res.end('<ENVELOPE><LEDGER NAME="Stock Supplier"><PARENT>Sundry Creditors</PARENT></LEDGER></ENVELOPE>');
    }
    /* Which "give me this ledger's vouchers" shape is being asked for. A real
       Tally answers some and not others, which is the whole point of trying
       several — so the stub can be told which ones it knows. */
    const shape = /KnapLedVch2/.test(b) ? 'collection-voucher-childof'
                : /KnapLedVch/.test(b) ? 'collection-voucher-ledger'
                : /<ID>Ledger Vouchers<\/ID>/i.test(b) ? 'report-ledger-vouchers'
                : null;
    const isLedger = !!shape;
    const from = Number((b.match(/<SVFROMDATE[^>]*>(\d{8})/i) || [])[1] || 20250401);
    const to = Number((b.match(/<SVTODATE[^>]*>(\d{8})/i) || [])[1] || 20260331);
    const isFiltered = /KnapItcVch/.test(b);
    if (isLedger) stats.ledger++; else if (isFiltered) stats.filtered++; else stats.plain++;

    /* A book Tally will not scan at all. SHIVAM ENTERPRISES answered no day-book
       request — 20 days, a quarter, a year, all timed out — while its sixteen
       input-GST ledgers were seconds of reading. The socket is dropped rather
       than hung so the test does not wait out a real 90-second timeout; what is
       under test is the state that leaves behind, which is the same either way:
       no day-book evidence at all. */
    if (/^dead/.test(mode) && !isLedger && !isFiltered) return res.destroy();

    /* SHIVAM ENTERPRISES: the ledger list came back in 0.28s, and then nothing
       — the day book and all three ledger shapes each timed out at ninety
       seconds, on the first ledger alone. Tally perfectly well, and serving no
       vouchers at all. Here the socket is simply held open and never answered,
       which is what a timeout is. */
    if (mode === 'mute') return;                          // answer no voucher request, ever

    /* Tally's ledger index: only the vouchers that hit the named ledger.
       In "noLedgerIndex" the server refuses it, as an older Tally would. */
    if (isLedger) {
      // Which shapes this "Tally" knows. Anything else answers empty, as a
      // build that does not support that TDL would.
      const knows = { good: ['collection-voucher-ledger'],
                      onlyReport: ['report-ledger-vouchers'],
                      ledgerMisses: ['collection-voucher-ledger'],
                      // the client's Tally: it answers the CHILDOF shape, but
                      // with the whole day book — ledger and dates both ignored
                      noFilter: ['collection-voucher-childof'],
                      // the day book will not answer at all, but the ledgers do
                      deadDayBook: ['collection-voucher-ledger'],
                      // the day book will not answer AND the only shape ignores
                      // the ledger — nothing can be trusted here
                      deadNoFilter: ['collection-voucher-childof'],
                      mute: [],
                      filterOnly: [], bad: [], noLedgerIndex: [] }[mode] || [];
      if (!knows.includes(shape)) { res.statusCode = 200; return res.end('<ENVELOPE></ENVELOPE>'); }
      if (mode === 'noFilter' || mode === 'deadNoFilter') {
        /* Byte-for-byte the day book, whatever ledger and whatever window was
           asked for — exactly what the client's Tally did. */
        const all = [];
        for (let i = 0; i < TOTAL; i++) all.push(vch(i, (i % ITC_EVERY) === 0));
        const body0 = '<ENVELOPE>' + all.join('') + '</ENVELOPE>';
        stats.bytes += body0.length;
        return setTimeout(() => res.end(body0), 30);
      }
      const out = [];
      for (let i = 0; i < TOTAL; i++) {
        if ((i % ITC_EVERY) !== 0) continue;
        const d = 20250401 + Math.floor(i / 20);
        if (d < from || d > to) continue;                 // a real ledger read honours the window
        if (mode === 'ledgerMisses' && i === ITC_EVERY * 3) continue;   // silently short
        out.push(vch(i, true));
      }
      if (from <= 20250405 && to >= 20250405) out.push(stockVch(1));
    if (from <= 20251105 && to >= 20251105) out.push(tdsVch());
      if (from <= 20251105 && to >= 20251105) out.push(tdsVch());
      const body = '<ENVELOPE>' + out.join('') + '</ENVELOPE>';
      stats.bytes += body.length;
      return setTimeout(() => res.end(body), 30);
    }
    const out = [];
    for (let i = 0; i < TOTAL; i++) {
      const d = 20250401 + Math.floor(i / 20);
      if (d < from || d > to) continue;
      const itc = (i % ITC_EVERY) === 0;
      // "bad": the filter silently omits one ITC voucher that the plain read returns
      if (isFiltered && !itc) continue;
      if (isFiltered && mode === 'bad' && i === ITC_EVERY * 2) continue;
      out.push(vch(i, itc));
    }
    if (from <= 20250405 && to >= 20250405) out.push(stockVch(1));
    if (from <= 20251105 && to >= 20251105) out.push(tdsVch());
    const body = '<ENVELOPE>' + out.join('') + '</ENVELOPE>';
    stats.bytes += body.length;
    setTimeout(() => res.end(body), 30);
  });
});
await new Promise((r) => srv.listen(9977, '127.0.0.1', r));

const conn = spawn('node', [new URL('./knap-tally-connector.mjs', import.meta.url).pathname],
  { env: { ...process.env, PORT: '8898' }, stdio: ['ignore', 'pipe', 'pipe'] });
conn.stderr.on('data', (d) => { const s = String(d); if (/Error|error/.test(s)) console.log('CONN:', s.trim().slice(0, 200)); });
await new Promise((r) => setTimeout(r, 2500));

let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

async function run(label, opts) {
  opts = opts || {};
  stats = { plain: 0, filtered: 0, ledger: 0, bytes: 0 };
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:' + (opts.port || 8898) + '/api/itc/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:9977/', company: 'X',
      from: '2025-04-01', to: '2026-03-31',
      taxLedgers: opts.ledgers || [{ name: 'Input IGST', kind: 'igst' }] }),
  });
  const j = await r.json();
  const prog = await (await fetch('http://127.0.0.1:' + (opts.port || 8898) + '/api/dc/progress')).json();
  console.log(`\n[${label}] rows=${j.rows ? j.rows.length : '-'} requests: ledger=${stats.ledger} plain=${stats.plain} filtered=${stats.filtered} ` +
              `bytes=${(stats.bytes / 1048576).toFixed(1)}MB time=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`         note: ${prog.note}`);
  return { j, stats: { ...stats }, note: prog.note };
}

console.log('\n── no ledger index, but Tally\'s filter agrees with the books ──');
mode = 'filterOnly';
const good = await run('filter honoured');
t('every ITC voucher is found', () => {
  const expected = Math.ceil(TOTAL / ITC_EVERY) + 2;        // + the stock-item purchase
  assert(good.j.rows.length === expected, `expected ${expected} rows, got ${good.j.rows.length}`);
});
t('the filter tier is used, and says so', () => {
  assert(/pre-filtered/.test(good.note), 'note should record the filter: ' + good.note);
  assert(good.stats.filtered > good.stats.plain, `expected mostly filtered reads, got plain=${good.stats.plain} filtered=${good.stats.filtered}`);
});
t('the supplier invoice number survives, since 2B matches on it', () => {
  const withInv = good.j.rows.filter((x) => x.supplierInvNo);
  assert(withInv.length === good.j.rows.length, `${good.j.rows.length - withInv.length} row(s) lost their invoice number`);
});
t('a stock-item purchase still gets its taxable base', () => {
  const s = good.j.rows.find((x) => x.voucherNo === 'SPI/1');
  assert(s, 'the stock-item purchase is missing');
  assert(Math.abs(s.taxable - 20000) < 0.01, `taxable should be 23,600 - 3,600 = 20,000, got ${s.taxable}`);
  assert(Math.abs(s.igst - 3600) < 0.01, `igst should be 3,600, got ${s.igst}`);
});

console.log('\n── no ledger index, and Tally\'s filter quietly drops one ──');
mode = 'bad';
const bad = await run('filter unsafe');
t('the filter is refused and the books are read in full', () => {
  assert(/not used|in full/.test(bad.note), 'note should say the filter was rejected: ' + bad.note);
  assert(bad.stats.filtered <= 2, 'the filter must not be used beyond the probe: ' + bad.stats.filtered);
});
t('no ITC voucher is lost', () => {
  const expected = Math.ceil(TOTAL / ITC_EVERY) + 2;
  assert(bad.j.rows.length === expected, `expected ${expected} rows, got ${bad.j.rows.length}`);
});


console.log('\n── Tally\'s ledger index answers ──');
mode = 'good';
const led = await run('ledger index');
t('the whole period comes from the ledger index', () => {
  assert(/ledger index/.test(led.note), 'note should record the ledger read: ' + led.note);
  // one day of one ledger to check Tally answers at all, then one small
  // request per ledger to PROVE the shape, then one for the period
  assert(led.stats.ledger === 3, `expected a liveness check, a probe and a full read, got ${led.stats.ledger}`);
  assert(led.stats.plain <= 1, `only the proving window should be scanned, got ${led.stats.plain}`);
  assert(led.stats.filtered === 0, 'the day-book filter should not be needed');
});
t('and it still finds every ITC voucher', () => {
  const expected = Math.ceil(TOTAL / ITC_EVERY) + 2;
  assert(led.j.rows.length === expected, `expected ${expected} rows, got ${led.j.rows.length}`);
});

console.log('\n── the ledger index comes back short ──');
mode = 'ledgerMisses';
const short = await run('ledger index unsafe');
t('a short ledger index is refused and something safer is used', () => {
  assert(!/ledger index/.test(short.note), 'the short ledger read must not be trusted: ' + short.note);
});
t('no ITC voucher is lost when it is refused', () => {
  const expected = Math.ceil(TOTAL / ITC_EVERY) + 2;
  assert(short.j.rows.length === expected, `expected ${expected} rows, got ${short.j.rows.length}`);
});

console.log('\n── an older Tally with no ledger index at all ──');
mode = 'noLedgerIndex';
const older = await run('no ledger index');
t('it falls through to a method that works, losing nothing', () => {
  const expected = Math.ceil(TOTAL / ITC_EVERY) + 2;
  assert(older.j.rows.length === expected, `expected ${expected} rows, got ${older.j.rows.length}`);
  assert(!/ledger index/.test(older.note), 'must not claim the ledger index: ' + older.note);
});


console.log('\n── a Tally that answers only the report shape ──');
mode = 'onlyReport';
const rep = await run('report shape');
t('the shape that works is found and named', () => {
  assert(/ledger index/.test(rep.note), 'should use the ledger index: ' + rep.note);
  assert(/Ledger Vouchers report/.test(rep.note), 'should name the shape that worked: ' + rep.note);
});
t('and nothing is lost by it', () => {
  const expected = Math.ceil(TOTAL / ITC_EVERY) + 2;
  assert(rep.j.rows.length === expected, `expected ${expected} rows, got ${rep.j.rows.length}`);
});



console.log('\n── TDS withheld on a purchase ──');
mode = 'good';
const tdsRun = await run('with TDS');
t('the taxable value is what the supplier billed, not that plus the TDS', () => {
  const r = tdsRun.j.rows.find((x) => x.voucherNo === 'MNL-25-26-3459');
  assert(r, 'the TDS voucher is missing');
  assert(Math.abs(r.taxable - 775304.80) < 0.01,
    `taxable should be 7,75,304.80 (items+loading+freight), got ${r.taxable}`);
  // the proof the base is right: the tax on it comes back to the paisa
  assert(Math.abs(r.taxable * 0.18 - r.igst) < 0.02,
    `18% of the base should equal the IGST: ${(r.taxable * 0.18).toFixed(2)} vs ${r.igst}`);
});
t('the TDS and the rounding are reported, not silently dropped', () => {
  const r = tdsRun.j.rows.find((x) => x.voucherNo === 'MNL-25-26-3459');
  assert(Math.abs(r.tds - 763.10) < 0.01, `TDS withheld should be 763.10, got ${r.tds}`);
  assert(Math.abs(Math.abs(r.roundOff) - 0.44) < 0.01,
    `the rounding should be carried, got ${r.roundOff}`);
});

console.log('\n── a ledger shape that does not actually filter ──');
/* The client's Tally answered "Collection of Voucher, CHILDOF the ledger" with
   the whole day book — the same bytes for every ledger, and the same bytes for a
   20-day window as for the year. The old check only asked whether the shape had
   returned everything the day book showed, which such a response passes
   trivially. Accepted, it read 294 MB and killed the process. */
mode = 'noFilter';
const nf = await run('shape returns the day book');
t('the shape is rejected rather than trusted', () => {
  assert(nf.j.ok, 'the read should still succeed by another route: ' + JSON.stringify(nf.j).slice(0, 200));
  assert(!/ledger index/.test(nf.note || ''),
    'it must not claim to have read from the ledger index: ' + nf.note);
});
t('and the figures still come out right', () => {
  const rows = nf.j.rows || [];
  assert(rows.length >= TOTAL / ITC_EVERY,
    `expected at least ${TOTAL / ITC_EVERY} ITC vouchers, got ${rows.length}`);
  assert(rows.every((r) => Math.abs(r.igst) > 0 || Math.abs(r.cgst) > 0 || Math.abs(r.sgst) > 0),
    'every row returned must actually carry input GST');
});

console.log('\n── the diagnostic ──');
mode = 'onlyReport';
const diag = await (await fetch('http://127.0.0.1:8898/api/itc/diagnose', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: 'http://127.0.0.1:9977/', company: 'X', ledger: 'Input IGST',
                         from: '2025-04-01', to: '2026-03-31' }),
})).json();
t('every shape is tried and reported', () => {
  assert(diag.ok, 'diagnose failed: ' + JSON.stringify(diag).slice(0, 200));
  assert(diag.results.length === 4, 'expected 3 shapes plus the day book, got ' + diag.results.length);
  const byShape = Object.fromEntries(diag.results.filter((r) => r.shape).map((r) => [r.shape, r]));
  assert(byShape['report-ledger-vouchers'].usable === true, 'the report shape should be usable here');
  assert(byShape['collection-voucher-ledger'].usable === false, 'the unsupported shape should read as unusable');
});
t('it shows what the day book would have cost instead', () => {
  const db = diag.results.find((r) => /day-book/.test(r.shape));
  assert(db && db.vouchers > 0, 'the day-book comparison is missing');
  const rep = diag.results.find((r) => r.shape === 'report-ledger-vouchers');
  assert(rep.vouchers < db.vouchers, `the ledger read should be smaller: ${rep.vouchers} vs ${db.vouchers}`);
});

/* ---------------------------------------------------------------------------
 * A book Tally will not scan at all.
 *
 * SHIVAM ENTERPRISES: every day-book read timed out — 20 days, then a quarter,
 * then the year. The shortcut was gated on that probe succeeding, so the
 * sixteen input-GST ledgers, which are seconds of reading, were never tried.
 * The books too dense to scan are the books that need the shortcut most, and
 * it switched itself off for exactly those.
 * ------------------------------------------------------------------------- */
console.log('\n── the day book will not answer ──');
mode = 'deadDayBook';
const dead = await run('dead day book');
t('the ledger index is still tried, and still works', () => {
  assert(dead.j.ok !== false, 'the read must not fail: ' + JSON.stringify(dead.j).slice(0, 200));
  assert(/ledger index/.test(dead.note), 'it must have used the ledger index: ' + dead.note);
  assert(dead.j.rows.length >= TOTAL / ITC_EVERY,
    `every ITC voucher must still come back, got ${dead.j.rows.length}`);
});
t('and it says plainly that nothing cross-checked it', () => {
  assert(/NOT cross-checked/.test(dead.note),
    'an unverified shortcut must admit it is unverified: ' + dead.note);
});

console.log('\n── the day book will not answer, and the shape ignores the ledger ──');
mode = 'deadNoFilter';
const deadBad = await run('dead, and no filter', {
  ledgers: [{ name: 'Input IGST', kind: 'igst' }, { name: 'Input CGST', kind: 'cgst' }] });
t('two ledgers giving byte-identical answers is refused, with no day book to prove it', () => {
  assert(deadBad.j.ok === false,
    'nothing here can be trusted, so the read must fail rather than invent: ' + JSON.stringify(deadBad.j).slice(0, 200));
});
t('and the failure says something true and useful', () => {
  const m = String(deadBad.j.error || '');
  assert(/would not answer|too many vouchers per day/.test(m), 'it must say what happened: ' + m);
  assert(!/Try a shorter period\./.test(m),
    'a shorter period does not help a book read day by day — that advice was wrong: ' + m);
});

/* The size cap, on its own connector so the ceiling can be lowered to 1 MB —
   the stub's unfiltered answer is about 2 MB, which a real book reaches in
   milliseconds and the client's reached at 98. */
console.log('\n── a probe that will not stop streaming ──');
const conn2 = spawn('node', [new URL('./knap-tally-connector.mjs', import.meta.url).pathname],
  { env: { ...process.env, PORT: '8899', KNAP_SHAPE_PROBE_MB: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => setTimeout(r, 2500));
mode = 'noFilter';
const capped = await run('probe cap', { port: 8899 });
t('the shape is abandoned mid-stream instead of downloaded whole', () => {
  assert(capped.stats.bytes < 8 * 1024 * 1024,
    `it must stop early, not pull megabytes: ${(capped.stats.bytes / 1048576).toFixed(1)}MB`);
  assert(!/ledger index/.test(capped.note),
    'and it must not then be used: ' + capped.note);
});
conn2.kill();

/* ---------------------------------------------------------------------------
 * Tally perfectly well, and serving no vouchers at all.
 *
 * SHIVAM again, on 4.69: the ledger list came back in 0.28 seconds, and then
 * the day book timed out at ninety, and each of the three ledger shapes timed
 * out at ninety, on the first ledger alone. Eight minutes to learn one thing.
 * One day of one ledger is the smallest voucher question there is; asking it
 * first turns those eight minutes into about eighty seconds and an answer.
 * ------------------------------------------------------------------------- */
console.log('\n── Tally answers its masters and nothing else ──');
const conn3 = spawn('node', [new URL('./knap-tally-connector.mjs', import.meta.url).pathname],
  { env: { ...process.env, PORT: '8900', KNAP_LIVENESS_MS: '400', KNAP_LIVENESS_SLOW_MS: '900' },
    stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => setTimeout(r, 2500));
mode = 'mute';
const t0mute = Date.now();
const mute = await run('serves no vouchers', { port: 8900 });
const muteMs = Date.now() - t0mute;
t('it gives up on the liveness probe, not on three full timeouts', () => {
  assert(mute.j.ok === false, 'the read must fail: ' + JSON.stringify(mute.j).slice(0, 160));
  // four probes at 400/400/400/900ms, not three at the shape-probe timeout
  assert(muteMs < 8000, `it must fail fast, took ${muteMs}ms`);
});
t('and says it is Tally refusing, not the period', () => {
  const m = String(mute.j.error || '');
  assert(/would not return even ONE day/.test(m), 'it must say what it actually asked for: ' + m);
  assert(/ledger list instantly/.test(m),
    'and that Tally is otherwise healthy — that is the whole diagnosis: ' + m);
  assert(!/shorter period/.test(m), 'a shorter period cannot help this: ' + m);
});
t('it does not keep hammering a Tally that will not answer', () => {
  assert(mute.stats.ledger <= 4,
    `one day of one ledger per shape, then one more — got ${mute.stats.ledger} requests`);
});
conn3.kill();

console.log(`\n${pass} passed, ${fail} failed`);
conn.kill(); srv.close();
process.exit(fail ? 1 : 0);
