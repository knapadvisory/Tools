/* Browser tests for the PDF Toolkit's Compress tab.
 *
 * The tool is browser code — canvas, pdf.js and pdf-lib — so it is tested in a
 * real browser rather than mocked. Run:
 *
 *   npm i --no-save playwright-core
 *   node pdftools/compress.test.mjs
 *
 * A stub PDF of noisy, scan-like pages stands in for the case people actually
 * need: a scanned statement too big for a portal's upload limit.
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.png':'image/png', '.svg':'image/svg+xml', '.css':'text/css' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(8123, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto('http://127.0.0.1:8123/pdftools/');
await page.waitForFunction(() => window.PDFLib && window.pdfjsLib);

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/* A scan-like PDF: each page is a noisy photograph, which is exactly the file
   people need to shrink for a portal upload. */
const origSize = await page.evaluate(async () => {
  const doc = await PDFLib.PDFDocument.create();
  for (let p = 0; p < 6; p++) {
    const cv = document.createElement('canvas');
    cv.width = 1240; cv.height = 1754;                       // ~150dpi A4
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(cv.width, cv.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 190 + ((Math.random() * 65) | 0);            // paper-like noise
      img.data[i] = v; img.data[i + 1] = v - (p * 3); img.data[i + 2] = v - 10;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ctx.fillStyle = '#123'; ctx.font = '40px sans-serif';
    for (let r = 0; r < 25; r++) ctx.fillText('Invoice line ' + r + ' page ' + (p + 1), 60, 120 + r * 60);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.95));
    const jpg = await doc.embedJpg(await blob.arrayBuffer());
    const pg = doc.addPage([595.28, 841.89]);
    pg.drawImage(jpg, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
  const bytes = await doc.save();
  window.__sample = bytes;
  return bytes.length;
});
console.log('\nsample PDF: ' + (origSize / 1024).toFixed(0) + ' KB, 6 pages\n');

async function feed() {
  await page.evaluate(() => {
    const f = new File([window.__sample], 'scan.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer(); dt.items.add(f);
    const el = document.querySelector('#cFile');
    el.files = dt.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('#cPanel:not(.hide)', { timeout: 15000 });
}

async function runAndRead() {
  await page.click('#cGo');
  await page.waitForSelector('#cResult:not(.hide)', { timeout: 180000 });
  return page.evaluate(() => ({
    text: document.querySelector('#cResultText').innerText,
    size: window.cOut ? window.cOut.size : null,
  }));
}

await page.click('.tabs button[data-v="compress"]');
await feed();

console.log('── by quality level ──');
await t('the file is read and the panel appears with its size', async () => {
  const info = await page.textContent('#cInfo');
  assert(/6 page/.test(info), 'page count missing: ' + info);
  assert(/KB|MB/.test(info), 'size missing: ' + info);
});
let balanced;
await t('"balanced" makes a scan markedly smaller', async () => {
  await page.selectOption('#cLevel', 'balanced');
  balanced = await runAndRead();
  assert(balanced.size > 0, 'no output');
  assert(balanced.size < origSize * 0.6, `expected well under 60% of ${origSize}, got ${balanced.size}`);
  assert(/smaller/.test(balanced.text), 'result text should state the saving: ' + balanced.text);
});
await t('"maximum" is smaller again than "balanced"', async () => {
  await page.selectOption('#cLevel', 'max');
  const max = await runAndRead();
  assert(max.size < balanced.size, `max ${max.size} should be < balanced ${balanced.size}`);
});
await t('greyscale shrinks a colour scan further', async () => {
  await page.selectOption('#cLevel', 'balanced');
  await page.check('#cGrey');
  const g = await runAndRead();
  await page.uncheck('#cGrey');
  assert(g.size < balanced.size, `grey ${g.size} should be < colour ${balanced.size}`);
});

console.log('\n── to a size I choose ──');
await page.click('#cMode button[data-m="target"]');
for (const kb of [300, 150, 80]) {
  await t(`a ${kb} KB target is met, and reported against the real file`, async () => {
    await page.fill('#cTargetN', String(kb));
    const r = await runAndRead();
    assert(r.size <= kb * 1024, `asked for <= ${kb} KB, got ${(r.size / 1024).toFixed(1)} KB`);
    assert(/under your target/.test(r.text), 'should confirm the target was met: ' + r.text);
    assert(r.size >= kb * 1024 * 0.88, `wasted quality: asked ${kb} KB, used only ${(r.size/1024).toFixed(1)} KB`);
    console.log(`        -> ${(origSize/1024).toFixed(0)} KB -> ${(r.size/1024).toFixed(1)} KB`);
  });
}
await t('an impossible target is admitted, not faked', async () => {
  await page.fill('#cTargetN', '2');                 // 2 KB for a 6-page scan
  const r = await runAndRead();
  assert(r.size > 2 * 1024, 'fixture assumption: 2 KB should be unreachable');
  assert(/still over your target/.test(r.text), 'must admit the miss: ' + r.text);
});

console.log('\n── page geometry and structure ──');
await t('the rebuilt PDF keeps every page at its original size', async () => {
  await page.click('#cMode button[data-m="level"]');
  await page.selectOption('#cLevel', 'balanced');
  await runAndRead();
  const dims = await page.evaluate(async () => {
    const buf = await window.cOut.arrayBuffer();
    const d = await PDFLib.PDFDocument.load(buf);
    return d.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
  });
  assert(dims.length === 6, 'page count changed: ' + dims.length);
  for (const [w, h] of dims) assert(w === 595 && h === 842, `page is ${w}x${h}, expected 595x842`);
});
await t('structure-only mode keeps the text and says what it did', async () => {
  await page.selectOption('#cMethod', 'structure');
  const r = await runAndRead();
  assert(r.size > 0, 'no output');
  assert(/selectable|already compactly stored/.test(r.text), 'should explain the trade-off: ' + r.text);
});


console.log('\n── the output is a real document, not a blank one ──');
await t('the compressed page still carries its ink', async () => {
  await page.click('#cMode button[data-m="level"]');
  await page.selectOption('#cMethod', 'image');
  await page.selectOption('#cLevel', 'balanced');
  await runAndRead();
  const ink = await page.evaluate(async () => {
    const buf = await window.cOut.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const pg = await pdf.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 120 && d[i + 1] < 120) dark++;
    return { dark, total: d.length / 4, pages: pdf.numPages };
  });
  assert(ink.pages === 6, 'page count changed: ' + ink.pages);
  assert(ink.dark > ink.total * 0.002, `page looks blank — only ${ink.dark} dark pixels of ${ink.total}`);
});
await t('mixed page sizes are each kept', async () => {
  await page.evaluate(async () => {
    const doc = await PDFLib.PDFDocument.create();
    const f = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const sizes = [[595.28, 841.89], [841.89, 595.28], [420, 595]];
    sizes.forEach((sz, i) => {
      const p = doc.addPage(sz);
      p.drawText('Page ' + (i + 1) + ' of mixed sizes', { x: 40, y: sz[1] - 60, size: 20, font: f });
      p.drawRectangle({ x: 40, y: 40, width: sz[0] - 80, height: 60, color: PDFLib.rgb(0.1, 0.1, 0.1) });
    });
    window.__sample = await doc.save();
  });
  await feed();
  await page.click('#cMode button[data-m="level"]');
  await runAndRead();
  const dims = await page.evaluate(async () => {
    const d = await PDFLib.PDFDocument.load(await window.cOut.arrayBuffer());
    return d.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
  });
  assert(JSON.stringify(dims) === JSON.stringify([[595, 842], [842, 595], [420, 595]]),
    'sizes changed: ' + JSON.stringify(dims));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
const real = errs.filter((e) => !/favicon/.test(e));
if (real.length) { console.log('\nBROWSER ERRORS:'); real.slice(0, 10).forEach((e) => console.log('  ' + e)); }
await browser.close(); srv.close();
process.exit(fail || real.length ? 1 : 0);
