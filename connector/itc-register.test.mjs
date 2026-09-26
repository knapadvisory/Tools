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
let mode = 'good', stats = { plain: 0, filtered: 0, bytes: 0 };

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

const srv = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    res.setHeader('content-type', 'text/xml');
    if (/KnapLedgers|Ledger/i.test(b) && !/Voucher/i.test(b)) {
      return res.end('<ENVELOPE><LEDGER NAME="Stock Supplier"><PARENT>Sundry Creditors</PARENT></LEDGER></ENVELOPE>');
    }
    const isFiltered = /KnapItcVch/.test(b);
    isFiltered ? stats.filtered++ : stats.plain++;
    const from = Number((b.match(/<SVFROMDATE[^>]*>(\d{8})/i) || [])[1] || 20250401);
    const to = Number((b.match(/<SVTODATE[^>]*>(\d{8})/i) || [])[1] || 20260331);
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

async function run(label) {
  stats = { plain: 0, filtered: 0, bytes: 0 };
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:8898/api/itc/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:9977/', company: 'X',
      from: '2025-04-01', to: '2026-03-31', taxLedgers: [{ name: 'Input IGST', kind: 'igst' }] }),
  });
  const j = await r.json();
  const prog = await (await fetch('http://127.0.0.1:8898/api/dc/progress')).json();
  console.log(`\n[${label}] rows=${j.rows ? j.rows.length : '-'} requests: plain=${stats.plain} filtered=${stats.filtered} ` +
              `bytes=${(stats.bytes / 1048576).toFixed(1)}MB time=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`         note: ${prog.note}`);
  return { j, stats: { ...stats }, note: prog.note };
}

console.log('\n── Tally\'s filter agrees with the books ──');
mode = 'good';
const good = await run('filter honoured');
t('every ITC voucher is found', () => {
  const expected = Math.ceil(TOTAL / ITC_EVERY) + 1;        // + the stock-item purchase
  assert(good.j.rows.length === expected, `expected ${expected} rows, got ${good.j.rows.length}`);
});
t('the fast path is used, and says so', () => {
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

console.log('\n── Tally\'s filter quietly drops one ──');
mode = 'bad';
const bad = await run('filter unsafe');
t('the filter is refused and the books are read in full', () => {
  assert(/not used|in full/.test(bad.note), 'note should say the filter was rejected: ' + bad.note);
  assert(bad.stats.filtered <= 2, 'the filter must not be used beyond the probe: ' + bad.stats.filtered);
});
t('no ITC voucher is lost', () => {
  const expected = Math.ceil(TOTAL / ITC_EVERY) + 1;
  assert(bad.j.rows.length === expected, `expected ${expected} rows, got ${bad.j.rows.length}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
conn.kill(); srv.close();
process.exit(fail ? 1 : 0);
