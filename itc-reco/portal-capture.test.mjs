/* ============================================================================
 * portal-capture.test.mjs — the record-and-replay capture, against a stub
 * portal that behaves the way GSTN's does: ask for the file, be told it is
 * being generated, ask again, get it.
 *
 *   npm i --no-save playwright-core && node itc-reco/portal-capture.test.mjs
 *
 * What this can and cannot prove. It proves the machinery: that the recorder
 * sees both fetch and XHR, that the period is recognised and substituted, that
 * a generate-then-poll sequence replays, that the return is recognised however
 * the portal wraps it, and that the ZIP written by hand is a ZIP other software
 * can open. It cannot prove anything about the real portal's endpoints — that
 * is exactly why the script records them instead of knowing them.
 * ==========================================================================*/
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = fs.readFileSync(path.join(HERE, 'portal-capture.js'), 'utf8');
const JSZIP = fs.readFileSync(path.join(HERE, '..', 'pdftools', 'jszip.min.js'), 'utf8');

/* A 2B return as GSTN shapes it, for whichever month is asked for. */
const ret = (gstin, p) => ({ data: { gstin, rtnprd: p, docdata: { b2b: [{ ctin: '07BICPL2786D1ZB',
  trdnm: 'DEEPALI ENGINEERING', inv: [{ inum: 'INV/' + p, dt: '10-' + p.slice(0, 2) + '-' + p.slice(2),
    txval: 1000, igst: 180, cgst: 0, sgst: 0, itcavl: 'Y' }] }] } } });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium/chrome-linux/chrome',
  args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

/* ---- the stub portal -----------------------------------------------------
   /gen  — "start making the file for this month"
   /get  — "is it ready?"  first ask no, second ask here it is.            */
const asked = {};
const hits = [];
await page.route('https://services.gst.gov.in/**', async (route) => {
  const url = new URL(route.request().url());
  hits.push(url.pathname + url.search);
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>portal</title><body>' });
  const p = url.searchParams.get('rtnprd') || (route.request().postData() || '').match(/\d{6}/)?.[0] || '';
  if (url.pathname === '/services/api/gstr2b/gen') return json({ status: 'IP', rtnprd: p });
  if (url.pathname === '/services/api/gstr2b/get') {
    asked[p] = (asked[p] || 0) + 1;
    if (asked[p] < 2) return json({ status: 'IP' });
    return json(ret('06AAGCE4293A1ZX', p));
  }
  if (url.pathname === '/services/api/noise.png') return route.fulfill({ status: 200, contentType: 'image/png', body: 'x' });
  return json({ ok: true });
});
await page.goto('https://services.gst.gov.in/');
await page.addScriptTag({ content: SCRIPT });

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

console.log('── watching one real download ──');

await t('the panel installs and offers to start watching', async () => {
  assert(await page.locator('text=Start watching').count() === 1, 'the Start button must be there');
});

await t('it records what the portal does — over fetch and over XHR alike', async () => {
  await page.click('text=Start watching');
  await page.evaluate(async () => {
    await fetch('/services/api/gstr2b/gen', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rtnprd: '042025', gstin: '06AAGCE4293A1ZX' }) });
    await new Promise((r) => {
      const x = new XMLHttpRequest();
      x.open('GET', '/services/api/gstr2b/get?rtnprd=042025&gstin=06AAGCE4293A1ZX');
      x.setRequestHeader('authtoken', 'session-token-abc');
      x.onload = r; x.send();
    });
    await new Promise((r) => {
      const x = new XMLHttpRequest();
      x.open('GET', '/services/api/gstr2b/get?rtnprd=042025&gstin=06AAGCE4293A1ZX');
      x.setRequestHeader('authtoken', 'session-token-abc');
      x.onload = r; x.send();
    });
    await fetch('/services/api/noise.png');          // must be ignored
  });
  const calls = await page.evaluate(() => window.__KNAP_CAP__.calls().map((c) => c.url));
  assert(calls.length === 3, `three API calls, not the image: got ${calls.length} — ${calls}`);
  assert(calls.every((u) => !/noise\.png/.test(u)), `an image is not an API call: ${calls}`);
});

await t('it reads the return period and the GSTIN out of what it saw', async () => {
  const seen = await page.textContent('body');
  assert(/Apr-25/.test(seen), `the month must show in the panel: ${seen.slice(0, 300)}`);
  assert(/06AAGCE4293A1ZX/.test(seen), 'the GSTIN must show in the panel');
});

await t('a named parameter beats a bare six digits', async () => {
  const got = await page.evaluate(() => {
    const P = window.__KNAP_CAP__._internals.periodOf;
    return [P({ url: '/x?id=122023&rtnprd=042025', body: '' }),
            P({ url: '/x?whatever=999999', body: '{"ret_period":"112025"}' }),
            P({ url: '/x?only=052025', body: '' })];
  });
  assert(got[0] === '042025', `the named one wins, got ${got[0]}`);
  assert(got[1] === '112025', `in the body too, got ${got[1]}`);
  assert(got[2] === '052025', `and a bare period still counts, got ${got[2]}`);
});

await t('the year it offers is April to March, plus the two spill months', async () => {
  const y = await page.evaluate(() => window.__KNAP_CAP__._internals.yearOf('122025'));
  assert(y.length === 14, `twelve returns and the two after, got ${y.length}`);
  assert(y[0] === '042025' && y[11] === '032026', `April 2025 to March 2026, got ${y[0]}..${y[11]}`);
  assert(y[12] === '042026' && y[13] === '052026', `then April and May 2026, got ${y.slice(12)}`);
});

console.log('\n── replaying it for another month ──');

await t('it replays the whole sequence and comes back with that month’s return', async () => {
  const got = await page.evaluate(async () => {
    const r = await window.__KNAP_CAP__._internals.fetchPeriod('042025', '072025', 5, () => {});
    return r && r.kind === 'json' ? JSON.parse(r.text) : r;
  });
  assert(got && got.data, `something must come back: ${JSON.stringify(got)}`);
  assert(got.data.rtnprd === '072025', `and it must be July, not April: got ${got.data.rtnprd}`);
  assert(got.data.docdata.b2b[0].inv[0].inum === 'INV/072025', 'the documents must be July’s');
});

await t('the period is substituted everywhere it appears, body included', async () => {
  const before = hits.length;
  await page.evaluate(() => window.__KNAP_CAP__._internals.fetchPeriod('042025', '092025', 5, () => {}));
  const after = hits.slice(before);
  assert(after.length >= 2, `the sequence must be replayed, got ${after.length} calls`);
  assert(after.every((h) => !/042025/.test(h)), `no call may still ask for April: ${after}`);
  assert(after.some((h) => /092025/.test(h)), `and they must ask for September: ${after}`);
});

await t('a month the portal has nothing for comes back empty, not wrong', async () => {
  const got = await page.evaluate(async () => {
    window.__KNAP_CAP__._internals.setCalls([{ method: 'GET', url: '/services/api/gstr2b/nothing?rtnprd=042025',
      headers: {}, body: null }]);
    return await window.__KNAP_CAP__._internals.fetchPeriod('042025', '052025', 5, () => {});
  });
  assert(!got, `nothing recognisable means nothing returned, got ${JSON.stringify(got)}`);
});

console.log('\n── recognising the payload, however it is wrapped ──');

await t('plain JSON, a raw ZIP and a ZIP base64’d inside JSON are all recognised', async () => {
  const got = await page.evaluate(() => {
    const P = window.__KNAP_CAP__._internals.payloadOf;
    const enc = (s) => new TextEncoder().encode(s).buffer;
    const zipBytes = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 1, 2, 3, 4]);
    const b64 = btoa(String.fromCharCode.apply(null, zipBytes) + 'x'.repeat(80));
    return {
      json: P({ buf: enc(JSON.stringify({ data: { rtnprd: '042025', docdata: { b2b: [] } } })) }).kind,
      statusEcho: P({ buf: enc(JSON.stringify({ status: 'IP', rtnprd: '042025' })) }),
      a2a: P({ buf: enc(JSON.stringify({ gstin: 'X', fp: '042025', cdn: [] })) }).kind,
      raw: P({ buf: zipBytes.buffer }).kind,
      wrapped: P({ buf: enc(JSON.stringify({ status: 'OK', data: b64 })) }).kind,
      junk: P({ buf: enc(JSON.stringify({ status: 'IP' })) }),
      html: P({ buf: enc('<html>session expired</html>') }),
    };
  });
  assert(got.json === 'json', `a 2B payload is JSON, got ${got.json}`);
  assert(got.a2a === 'json', `a 2A payload is JSON too — cdn at the top, got ${got.a2a}`);
  assert(got.raw === 'zip', `a raw ZIP is a ZIP, got ${got.raw}`);
  assert(got.wrapped === 'zip', `a base64 ZIP inside JSON is a ZIP, got ${got.wrapped}`);
  assert(got.junk === null, '"still generating" is not a payload');
  assert(got.statusEcho === null,
    'nor is one that echoes the return period back — that would save a status message as the month');
  assert(got.html === null, 'a login page is not a payload');
});

console.log('\n── the ZIP it hands you ──');

await t('the hand-written ZIP is one other software can open', async () => {
  await page.addScriptTag({ content: JSZIP });
  const out = await page.evaluate(async () => {
    const enc = new TextEncoder();
    const bytes = window.__KNAP_CAP__._internals.zipOf([
      { name: 'returns_06AAGCE4293A1ZX_042025.json', bytes: enc.encode('{"a":1}') },
      { name: 'returns_06AAGCE4293A1ZX_052025.json', bytes: enc.encode('{"b":"' + 'x'.repeat(5000) + '"}') },
    ]);
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).sort();
    return { names, first: await zip.file(names[0]).async('string'),
             secondLen: (await zip.file(names[1]).async('string')).length };
  });
  assert(out.names.length === 2, `two members, got ${out.names}`);
  assert(out.first === '{"a":1}', `contents must survive, got ${out.first}`);
  assert(out.secondLen === 5008, `a larger member too, got ${out.secondLen}`);
});

await t('and its CRCs are right, so a stricter unzipper accepts it too', async () => {
  const b64 = await page.evaluate(() => {
    const bytes = window.__KNAP_CAP__._internals.zipOf([
      { name: 'x.json', bytes: new TextEncoder().encode('{"hello":"world"}') }]);
    let s = '';
    bytes.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s);
  });
  const buf = Buffer.from(b64, 'base64');
  /* Read the stored entry back the long way and check the CRC in the header. */
  const nameLen = buf.readUInt16LE(26), extraLen = buf.readUInt16LE(28);
  const size = buf.readUInt32LE(22);
  const data = buf.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + size);
  assert(data.toString() === '{"hello":"world"}', `the stored bytes must read back, got ${data.toString()}`);
  assert(buf.readUInt32LE(14) === zlib.crc32(data), 'the CRC in the local header must be the real one');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (errs.length) { console.log('\nBROWSER ERRORS:'); errs.slice(0, 5).forEach((e) => console.log('  ' + e)); }
await browser.close();
process.exit(fail || errs.length ? 1 : 0);
