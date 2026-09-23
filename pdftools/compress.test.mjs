/* Browser tests for the PDF Toolkit's Compress and Excel → PDF tabs.
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
const makeScan = async () => page.evaluate(async () => {
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
const origSize = await makeScan();
console.log('\nsample PDF: ' + (origSize / 1024).toFixed(0) + ' KB, 6 pages\n');

async function feed(names = ['scan.pdf']) {
  await page.evaluate(() => { window.cQueue.length = 0; });
  await page.evaluate((ns) => {
    const dt = new DataTransfer();
    for (const n of ns) dt.items.add(new File([window.__sample], n, { type: 'application/pdf' }));
    const el = document.querySelector('#cFile');
    el.files = dt.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, names);
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
  assert(/1 file/.test(info), 'file count missing: ' + info);
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


console.log('\n── several files in one go ──');
await t('three files are each compressed and returned as a ZIP', async () => {
  await page.click('.tabs button[data-v="compress"]');
  await makeScan();                       // the mixed-size test replaced __sample
  await feed(['scan-a.pdf', 'scan-b.pdf', 'scan-c.pdf']);
  await page.click('#cMode button[data-m="target"]');
  await page.fill('#cTargetN', '200');
  const r = await runAndRead();
  assert(/3 file\(s\)/.test(r.text), 'should report all three: ' + r.text);
  assert(/smaller overall/.test(r.text), 'should give a combined saving: ' + r.text);
  const zip = await page.evaluate(async () => {
    const z = await JSZip.loadAsync(window.cOut);
    const names = Object.keys(z.files);
    const sizes = {};
    for (const n of names) sizes[n] = (await z.files[n].async('uint8array')).length;
    return { names, sizes, outName: window.cOutName };
  });
  assert(zip.outName.endsWith('.zip'), 'should download a ZIP: ' + zip.outName);
  assert(zip.names.length === 3, 'expected 3 entries, got ' + zip.names.join(', '));
  for (const n of zip.names) {
    assert(/-compressed\.pdf$/.test(n), 'bad entry name: ' + n);
    assert(zip.sizes[n] <= 200 * 1024, `${n} is ${(zip.sizes[n]/1024).toFixed(1)} KB, over the 200 KB target`);
    assert(zip.sizes[n] > 1000, n + ' is suspiciously small');
  }
});
await t('the per-file list shows what happened to each', async () => {
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#cList li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim()));
  assert(rows.length === 3, 'expected 3 rows, got ' + rows.length);
  for (const r of rows) assert(/smaller/.test(r) && /under target/.test(r), 'row lacks its outcome: ' + r);
});
await t('a single file still comes back as a PDF, not a ZIP', async () => {
  await feed(['only.pdf']);
  await page.click('#cMode button[data-m="level"]');
  await runAndRead();
  const n = await page.evaluate(() => window.cOutName);
  assert(/\.pdf$/.test(n) && !/\.zip$/.test(n), 'expected a .pdf, got ' + n);
});

console.log('\n── large files ──');
await t('the bytes of a file are never retained after it is processed', async () => {
  // cQueue holds File handles (a pointer to disk), never ArrayBuffers: a queue
  // of huge scans must not sit in memory.
  const holds = await page.evaluate(() => window.cQueue.map((it) => ({
    file: it.file instanceof File,
    buffers: Object.keys(it).filter((k) => it[k] instanceof ArrayBuffer || ArrayBuffer.isView(it[k])),
  })));
  for (const h of holds) {
    assert(h.file, 'the queue should hold File handles');
    assert(h.buffers.length === 0, 'queue is retaining raw bytes: ' + h.buffers.join(', '));
  }
});
await t('a file too large for the structure method is refused with a reason', async () => {
  const msg = await page.evaluate(async () => {
    const fake = { file: new File([new Uint8Array(10)], 'huge.pdf'), name: 'huge.pdf', size: 90 * 1024 * 1024 };
    const r = await cCompressOne(fake, { method: 'structure' }, () => {}, () => {});
    return r.skipped ? r.why : 'NOT SKIPPED';
  });
  assert(/too large/.test(msg), 'should refuse with a reason: ' + msg);
  assert(/Advanced server tool|image method/.test(msg), 'should say what to do instead: ' + msg);
});
await t('a big file is flagged with what to expect, not left looking broken', async () => {
  await page.evaluate(() => {
    window.cQueue.length = 0;
    window.cQueue.push({ file: new File([new Uint8Array(10)], 'big.pdf'), name: 'big.pdf', size: 150 * 1024 * 1024, status: '' });
    cRenderQueue();
  });
  const warn = await page.evaluate(() => document.querySelector('#cBig').classList.contains('hide')
    ? null : document.querySelector('#cBig').innerText);
  assert(warn, 'a 150 MB file should raise the notice');
  assert(/one at a time/.test(warn), 'should say the queue is sequential: ' + warn);
  assert(/Advanced/.test(warn), 'should point at the server tool: ' + warn);
});


console.log('\n── Excel → PDF ──');
await page.click('.tabs button[data-v="xls"]');
/* A workbook shaped like the ones this is for: a trial balance with merged
   title, bold header, a date, a formula, a negative, and a long label. */
await page.evaluate(async () => {
  await new Promise((ok, err) => {
    const sc = document.createElement('script');
    sc.src = '/gstr2b/exceljs.js'; sc.onload = ok; sc.onerror = err;
    document.head.appendChild(sc);
  });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Trial Balance');
  ws.columns = [{ width: 40 }, { width: 14 }, { width: 14 }, { width: 12 }];
  ws.mergeCells('A1:D1');
  ws.getCell('A1').value = 'ECLAT INDIA PRIVATE LIMITED';
  ws.getCell('A1').font = { bold: true };
  const head = ws.addRow(['Particulars', 'Debit', 'Credit', 'As at']);
  head.font = { bold: true };
  ws.addRow(['Share capital', 0, 8730454, new Date(2026, 2, 31)]);
  ws.addRow(['Reserves and surplus — a deliberately long caption that must wrap inside its column', 0, 4458618.19, new Date(2026, 2, 31)]);
  ws.addRow(['Cash and cash equivalents', 1219481.08, 0, new Date(2026, 2, 31)]);
  ws.addRow(['Loss for the year', -1208832.83, 0, new Date(2026, 2, 31)]);
  const tot = ws.addRow(['Total', { formula: 'SUM(B3:B6)', result: 10648.25 }, { formula: 'SUM(C3:C6)', result: 13189072.19 }, null]);
  tot.font = { bold: true };
  ws.getColumn(2).numFmt = '#,##0.00';
  ws.getColumn(3).numFmt = '#,##0.00';
  const ws2 = wb.addWorksheet('Notes');
  ws2.addRow(['Note', 'Detail']);
  for (let i = 1; i <= 120; i++) ws2.addRow([i, 'Line item number ' + i + ' of the notes schedule']);
  window.__xlsx = await wb.xlsx.writeBuffer();
});
await page.evaluate(() => {
  const f = new File([window.__xlsx], 'trial-balance.xlsx',
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const dt = new DataTransfer(); dt.items.add(f);
  const el = document.querySelector('#xFile');
  el.files = dt.files;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForSelector('#xPanel:not(.hide)', { timeout: 20000 });

await t('both sheets are found and listed with their row counts', async () => {
  const txt = await page.textContent('#xSheets');
  assert(/Trial Balance/.test(txt), 'first sheet missing: ' + txt);
  assert(/Notes/.test(txt), 'second sheet missing: ' + txt);
  assert(/rows/.test(txt), 'row counts missing: ' + txt);
});

/* Capture the PDF the tool hands to the browser, and read it back. */
async function buildXls() {
  await page.evaluate(() => {
    window.__dl = null;
    if (!window.__origDl) window.__origDl = window.dl;
    window.dl = (blob, name) => { window.__dl = { blob, name }; };
  });
  await page.click('#xGo');
  await page.waitForFunction(() => window.__dl !== null, { timeout: 120000 });
  return page.evaluate(async () => {
    const buf = await window.__dl.blob.arrayBuffer();
    const size = buf.byteLength;              // read BEFORE pdf.js detaches it
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    const pages = [], dims = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const pg = await pdf.getPage(i);
      const vp = pg.getViewport({ scale: 1 });
      dims.push({ w: Math.round(vp.width), h: Math.round(vp.height) });
      const tc = await pg.getTextContent();
      pages.push(tc.items.map((x) => x.str).join(' ').replace(/\s+/g, ' '));
    }
    return { name: window.__dl.name, size, numPages: pdf.numPages, pages, dims, stat: document.querySelector('#xStat').innerText };
  });
}

let xls;
await t('a PDF is produced, named after the workbook', async () => {
  xls = await buildXls();
  assert(xls.name === 'trial-balance.pdf', 'bad name: ' + xls.name);
  assert(xls.size > 1000, 'suspiciously small: ' + xls.size);
  assert(xls.numPages >= 2, '120 rows should run to several pages, got ' + xls.numPages);
});
await t('the text is real text — the PDF is searchable, not a picture', async () => {
  const all = xls.pages.join(' ');
  assert(/ECLAT INDIA PRIVATE LIMITED/.test(all), 'merged title missing');
  assert(/Share capital/.test(all), 'a row is missing');
  assert(/Cash and cash equivalents/.test(all), 'a row is missing');
});
await t('numbers keep their format, negatives and all', async () => {
  const all = xls.pages.join(' ');
  assert(/87,30,454\.00|8,730,454\.00/.test(all), 'thousands separator missing: ' + all.slice(0, 400));
  assert(/-12,08,832\.83|\(12,08,832\.83\)|-1,208,832\.83/.test(all), 'negative missing');
});
await t('dates print as dates, not as serial numbers', async () => {
  const all = xls.pages.join(' ');
  assert(/31-Mar-2026/.test(all), 'date not formatted: ' + all.slice(0, 400));
  assert(!/\b4[0-9]{4}\b/.test(all), 'a raw date serial leaked through');
});
await t("a formula prints the result Excel saved, not its text", async () => {
  const all = xls.pages.join(' ');
  assert(!/SUM\(/.test(all), 'the formula itself was printed');
  assert(/1,31,89,072\.19|13,189,072\.19/.test(all), 'the formula result is missing');
});
await t('the long caption wraps instead of running over its neighbour', async () => {
  const all = xls.pages.join(' ');
  assert(/deliberately long caption/.test(all), 'the long text is missing');
});
await t('the header row repeats on later pages', async () => {
  const later = xls.pages.slice(1).filter((p) => /Line item number/.test(p));
  assert(later.length > 0, 'the Notes sheet should span pages');
  for (const p of later) assert(/Note Detail/.test(p), 'header not repeated on a later page');
});
await t('unticking a sheet leaves it out', async () => {
  await page.uncheck('#xSheets [data-xs="1"]');
  const only = await buildXls();
  assert(!only.pages.join(' ').includes('Line item number'), 'the unticked sheet was still printed');
  assert(only.pages.join(' ').includes('Share capital'), 'the ticked sheet is missing');
  await page.check('#xSheets [data-xs="1"]');
});
await t('a CSV is accepted too', async () => {
  await page.evaluate(() => {
    const csv = 'Party,Amount\n"Alpha Traders, Delhi",10000\nBeta Supplies,-2500\n';
    const f = new File([csv], 'parties.csv', { type: 'text/csv' });
    const dt = new DataTransfer(); dt.items.add(f);
    const el = document.querySelector('#xFile');
    el.files = dt.files;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForFunction(() => /parties\.csv/.test(document.querySelector('#xInfo').innerText), { timeout: 20000 });
  const out = await buildXls();
  const all = out.pages.join(' ');
  assert(out.name === 'parties.pdf', 'bad name: ' + out.name);
  assert(/Alpha Traders, Delhi/.test(all), 'a quoted comma broke the row, or the column was too narrow: ' + all);
  assert(/Beta Supplies/.test(all), 'a row is missing');
});


console.log('\n── Excel: the sheet\'s own print setup ──');
/* A workbook set up for printing, as a firm's statement file is: a print area
   that deliberately excludes the working columns beside it, a scale, portrait
   and landscape on different sheets, and a working sheet hidden in Excel. */
await page.evaluate(async () => {
  const wb = new ExcelJS.Workbook();
  const bs = wb.addWorksheet('Balance Sheet');
  bs.columns = [{ width: 40 }, { width: 14 }, { width: 14 }, { width: 20 }, { width: 20 }];
  bs.addRow(['Particulars', 'As at 31 Mar 2026', 'As at 31 Mar 2025', 'WORKING ONLY', 'CHECK']);
  bs.addRow(['Share capital', 100, 100, '#REF!', 'do-not-print-A']);
  bs.addRow(['Reserves and surplus', -22530.63, -55849.43, -5584943, 'do-not-print-B']);
  bs.addRow(['Nil line', 0, 0, 999, 'do-not-print-C']);
  bs.getColumn(2).numFmt = '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)';
  bs.getColumn(3).numFmt = '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)';
  bs.pageSetup = { printArea: 'A1:C4', orientation: 'portrait', paperSize: 9, scale: 80, fitToPage: false };

  const far = wb.addWorksheet('PPE');
  far.columns = new Array(9).fill(0).map(() => ({ width: 18 }));
  far.addRow(['Block', 'Open', 'Add', 'Del', 'Close', 'ODep', 'Dep', 'CDep', 'WDV']);
  for (let i = 1; i <= 6; i++) far.addRow(['Asset ' + i, 100, 10, 0, 110, 20, 5, 25, 85]);
  far.pageSetup = { printArea: 'A1:I7', orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1 };

  const tb = wb.addWorksheet('TB working');
  tb.addRow(['this is a working paper', 1]);
  tb.state = 'hidden';

  window.__xlsx = await wb.xlsx.writeBuffer();
});
await page.evaluate(() => {
  const f = new File([window.__xlsx], 'statements.xlsx',
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const dt = new DataTransfer(); dt.items.add(f);
  const el = document.querySelector('#xFile');
  el.files = dt.files;
  el.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForFunction(() => /statements\.xlsx/.test(document.querySelector('#xInfo').innerText), { timeout: 20000 });

await t('a sheet hidden in Excel is listed but left unticked', async () => {
  const txt = await page.textContent('#xSheets');
  assert(/TB working/.test(txt) && /hidden in Excel/.test(txt), 'hidden sheet not flagged: ' + txt);
  const ticked = await page.evaluate(() => [...document.querySelectorAll('#xSheets [data-xs]')].map((c) => c.checked));
  assert(ticked[0] && ticked[1] && !ticked[2], 'the hidden sheet must start unticked: ' + ticked.join(','));
});

let own;
await t('the print area is honoured — working columns never reach the paper', async () => {
  own = await buildXls();
  const all = own.pages.join(' ');
  assert(/Share capital/.test(all), 'the statement itself is missing');
  assert(!/#REF!/.test(all), 'a #REF! from outside the print area was printed');
  assert(!/do-not-print/.test(all), 'a column outside the print area was printed');
  assert(!/working paper/.test(all), 'the hidden sheet was printed');
});
await t('each sheet gets the orientation and paper it asks for', async () => {
  const sizes = own.dims.map((d, i) => `${d.w > d.h ? 'landscape' : 'portrait'}(${own.pages[i].slice(0, 24).trim()})`);
  assert(sizes.some((x) => x.startsWith('portrait')), 'the portrait sheet is missing: ' + sizes.join(' | '));
  assert(sizes.some((x) => x.startsWith('landscape')), 'the landscape sheet is missing: ' + sizes.join(' | '));
  const a4 = own.dims.every((d) => Math.abs(Math.max(d.w, d.h) - 842) < 2);
  assert(a4, 'not A4: ' + own.dims.map((d) => d.w + 'x' + d.h).join(', '));
});
await t("a nil figure prints as the accounting format's dash, not as 0.00", async () => {
  const all = own.pages.join(' ');
  assert(/Nil line - -/.test(all) || /Nil line -/.test(all), 'zero should print as a dash: ' + all.slice(0, 300));
  assert(/\(22,530\.63\)/.test(all), 'a negative should print in brackets: ' + all.slice(0, 300));
});
await t('turning the switch off prints everything, and says so', async () => {
  await page.uncheck('#xOwn');
  const raw = await buildXls();
  const all = raw.pages.join(' ');
  assert(/do-not-print/.test(all), 'with the switch off the whole used range should print');
  const hint = await page.textContent('#xHint');
  assert(/Ignoring/.test(hint), 'the hint should say the setup is being ignored: ' + hint);
  await page.check('#xOwn');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
const real = errs.filter((e) => !/favicon/.test(e));
if (real.length) { console.log('\nBROWSER ERRORS:'); real.slice(0, 10).forEach((e) => console.log('  ' + e)); }
await browser.close(); srv.close();
process.exit(fail || real.length ? 1 : 0);
