/* Browser tests for the PDF Toolkit's PDF -> Markdown tab.
 *
 *   npm i --no-save playwright-core && node pdftools/md.test.mjs
 *
 * A text PDF is built in the page with pdf-lib — a title, headings, paragraphs
 * that wrap, a hyphenated line break, bullets, a numbered list, a table with
 * aligned columns, and a footer repeated on every page — then fed through the
 * real tab, and the Markdown that comes out is read back. A second, image-only
 * PDF stands in for a scan.
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
await new Promise((r) => srv.listen(8124, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto('http://127.0.0.1:8124/pdftools/');
await page.waitForFunction(() => window.PDFLib && window.pdfjsLib);

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

/* The document, as a report might be laid out. */
await page.evaluate(async () => {
  const { PDFDocument, StandardFonts } = PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle('ITC Reconciliation Note');
  const F = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89;
  const pages = [doc.addPage([W, H]), doc.addPage([W, H]), doc.addPage([W, H])];
  const line = (pg, txt, x, y, size, font) => pg.drawText(txt, { x, y, size, font: font || F });
  // page 1
  let p = pages[0], y = H - 80;
  line(p, 'ITC Reconciliation Note', 60, y, 22, B); y -= 40;
  line(p, '1. Background', 60, y, 16, B); y -= 24;
  const para1 = ['The input tax credit claimed in the books was compared with the credit', 'auto-drafted in GSTR-2B for the year. Every document was matched on the', 'supplier GSTIN and the invoice number, and the amounts were tied to the rupee.'];
  for (const l of para1) { line(p, l, 60, y, 11); y -= 15; }
  y -= 12;
  const para2 = ['Where the two did not agree, the difference was traced to a recon-', 'ciliation item and reported under its own head.'];
  for (const l of para2) { line(p, l, 60, y, 11); y -= 15; }
  y -= 12;
  line(p, '2. Findings', 60, y, 16, B); y -= 24;
  for (const l of ['• Three amendments restated an earlier month', '• Two supplier debit notes were booked as credit notes', '• One invoice was booked under the wrong registration']) { line(p, l, 60, y, 11); y -= 15; }
  y -= 12;
  for (const l of ['1. Reverse the credit on the two debit notes', '2. Re-book the invoice under the Haryana registration', '3. Confirm the amendments with the supplier']) { line(p, l, 60, y, 11); y -= 15; }
  line(p, 'Page 1 of 3', 260, 40, 9);
  // page 2: a table
  p = pages[1]; y = H - 80;
  line(p, '3. Summary by head', 60, y, 16, B); y -= 28;
  const cols = [60, 220, 340, 460];
  const rows = [['Head', 'Books', 'GSTR-2B', 'Difference'], ['IGST', '11,16,29,786', '11,16,29,786', '0'], ['CGST', '3,19,92,657', '3,19,92,657', '0'], ['SGST', '3,19,92,657', '3,19,92,657', '0']];
  for (const r of rows) { r.forEach((c, i) => line(p, c, cols[i], y, 11, r === rows[0] ? B : F)); y -= 18; }
  y -= 12;
  line(p, 'The year closes on all three heads.', 60, y, 11);
  line(p, 'Page 2 of 3', 260, 40, 9);
  // page 3
  p = pages[2]; y = H - 80;
  line(p, '4. Closing', 60, y, 16, B); y -= 24;
  line(p, 'Nothing remains open.', 60, y, 11);
  line(p, 'Page 3 of 3', 260, 40, 9);
  window.__text = await doc.save();

  // a scan: one page, one picture, no text layer
  const sc = await PDFDocument.create();
  const cv = document.createElement('canvas'); cv.width = 600; cv.height = 800;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#eee'; ctx.fillRect(0, 0, 600, 800); ctx.fillStyle = '#333'; ctx.font = '30px sans-serif'; ctx.fillText('A scanned page', 50, 100);
  const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.9));
  const jpg = await sc.embedJpg(await blob.arrayBuffer());
  const sp = sc.addPage([W, H]); sp.drawImage(jpg, { x: 0, y: 0, width: W, height: H });
  window.__scan = await sc.save();
});

async function feed(list) {
  await page.evaluate((list) => {
    window.mdQueue.length = 0;
    const dt = new DataTransfer();
    for (const [key, name] of list) dt.items.add(new File([window[key]], name, { type: 'application/pdf' }));
    const el = document.querySelector('#dFile'); el.files = dt.files; el.dispatchEvent(new Event('change', { bubbles: true }));
  }, list);
  await page.waitForSelector('#dPanel:not(.hide)', { timeout: 15000 });
}
async function convert() {
  await page.click('#dGo');
  await page.waitForSelector('#dResult:not(.hide)', { timeout: 120000 });
  return page.evaluate(async () => ({ text: document.querySelector('#dResultText').innerText, name: window.mdOutName,
    md: window.mdLast, size: window.mdOut ? window.mdOut.size : 0 }));
}

await page.click('.tabs button[data-v="md"]');
await feed([['__text', 'note.pdf']]);
const r = await convert();
const md = r.md || '';
console.log('\n' + md.split('\n').slice(0, 40).map((l) => '    ' + l).join('\n') + '\n');

console.log('── the structure of a report, rebuilt ──');
await t('it is a .md with front matter naming the source', () => {
  assert(/\.md$/.test(r.name), 'name: ' + r.name);
  assert(/^---\ntitle: "ITC Reconciliation Note"\nsource: "note.pdf"\npages: 3\n/.test(md), 'front matter:\n' + md.slice(0, 120));
});
await t('the title and the section headings become headings, by size', () => {
  assert(/^# ITC Reconciliation Note$/m.test(md), 'the 22pt title should be #');
  assert(/^## 1\. Background$/m.test(md) && /^## 2\. Findings$/m.test(md), 'the 16pt sections should be ##');
});
await t('wrapped lines are joined back into paragraphs', () => {
  assert(/compared with the credit auto-drafted in GSTR-2B for the year\. Every document/.test(md), 'the paragraph should read as one line');
  assert(!/credit\nauto-drafted/.test(md), 'a line break mid-sentence survived');
});
await t('a word hyphenated across a line break is mended', () => {
  assert(/traced to a reconciliation item/.test(md), 'recon- ciliation should be joined: ' + (md.match(/recon.{0,15}/) || [''])[0]);
});
await t('bullets and the numbered list come through as lists', () => {
  assert(/^- Three amendments restated an earlier month$/m.test(md), 'bullet');
  assert(/^1\. Reverse the credit on the two debit notes$/m.test(md) && /^3\. Confirm the amendments/m.test(md), 'numbered list');
});
await t('the table is rebuilt with its header row', () => {
  assert(/^\| Head \| Books \| GSTR-2B \| Difference \|$/m.test(md), 'header row:\n' + (md.match(/^\|.*$/gm) || []).join('\n'));
  assert(/^\|---\|---\|---\|---\|$/m.test(md), 'separator row');
  assert(/^\| IGST \| 11,16,29,786 \| 11,16,29,786 \| 0 \|$/m.test(md), 'a data row');
});
await t('the running footer is dropped, and every page is marked', () => {
  assert(!/Page 1 of 3/.test(md) && !/Page 2 of 3/.test(md), 'the footer should be gone');
  assert(/<!-- page 1 -->/.test(md) && /<!-- page 2 -->/.test(md) && /<!-- page 3 -->/.test(md), 'page markers');
});
await t('the result says what it made', () => {
  assert(/3 page\(s\)/.test(r.text) && /heading\(s\)/.test(r.text) && /1 table\(s\)/.test(r.text), r.text);
});

console.log('\n── a scanned page ──');
await feed([['__scan', 'scan.pdf']]);
const sr = await convert();
await t('a page with no text layer is marked as such, not invented', () => {
  assert(/no text layer \(scanned image\)/.test(sr.md || ''), 'marker missing:\n' + sr.md);
  assert(/scanned_pages: \[1\]/.test(sr.md || ''), 'front matter should list it');
  assert(/had no text layer/.test(sr.text), 'the result should warn: ' + sr.text);
  assert(!/A scanned page/.test(sr.md || ''), 'words were invented from a picture');
});

console.log('\n── several files ──');
await feed([['__text', 'note.pdf'], ['__scan', 'scan.pdf']]);
const zr = await convert();
await t('two PDFs come back as a ZIP of two .md files', async () => {
  assert(/\.zip$/.test(zr.name), 'name: ' + zr.name);
  const names = await page.evaluate(async () => Object.keys((await JSZip.loadAsync(window.mdOut)).files).sort());
  assert(names.join() === 'note.md,scan.md', 'members: ' + names);
});

console.log('\n── a bank statement: wrapped rows, centred amounts, a two-line header, no header on page 2 ──');
/* Laid out the way a bank statement that came from the field is: nine
   columns closer together than any gap on one line reveals, a header whose
   words stack over two lines, a Remarks cell wrapping over three lines, an
   amount column that is CENTRED, a balance so wide the column breaks it into
   "-", "31120874.2", "3", a date wrapped as "23-Sep-" / "2025", and page 2
   carrying straight on with no header. */
await page.evaluate(async () => {
  const { PDFDocument, StandardFonts } = PDFLib;
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica);
  const W = 595.28, H = 841.89;
  const cols = [44, 80, 133, 187, 259, 340, 425, 478, 530];           // column centres-ish
  const centred = (pg, txt, cx, y, size) => pg.drawText(txt, { x: cx - F.widthOfTextAtSize(txt, size) / 2, y, size, font: F });
  const left = (pg, txt, x, y, size) => pg.drawText(txt, { x, y, size, font: F });
  const rows = [
    { sr: '1', id: 'S1120044', d: ['02-Apr-2025', '02-Apr-2025'], rem: ['004512003387:Int.', 'Coll:03-03-2025 to', '01-04-2025'], wd: '193166.00', dp: 'NA', bal: ['-', '31120874.2', '3'] },
    { sr: '2', id: 'S1120391', d: ['02-Apr-2025', '02-Apr-2025'], rem: ['RTGS-', 'XBNKR52025040', '21188047-MEHRA', 'STORES'], wd: 'NA', dp: '274253.00', bal: ['-', '30846621.2', '3'] },
    { sr: '3', id: 'S1120875', d: ['04-Apr-2025', '04-Apr-2025'], rem: ['RTGS/XBNKR42025', '040700112233/YB', 'NK0004410/STAR'], wd: '5000000.00', dp: 'NA', bal: ['-', '30750939.0', '1'] },
    { sr: '4', id: 'S1121002', d: ['23-Sep-', '2025'], d2: '23-Sep-2025', rem: ['penal charges'], wd: '3219.78', dp: 'NA', bal: ['-', '30750939.0', '1'] },
  ];
  const drawRows = (pg, list, y0) => {
    let y = y0;
    for (const r of list) {
      left(pg, r.sr, cols[0], y, 9); left(pg, r.id, cols[1], y, 9);
      left(pg, r.d[0], cols[2], y, 9); left(pg, r.d2 || r.d[1], cols[3], y, 9);
      centred(pg, r.rem[0], cols[5], y, 9); centred(pg, r.wd, cols[6], y, 9); centred(pg, r.dp, cols[7], y, 9); centred(pg, r.bal[0], cols[8], y, 9);
      let yy = y - 9;
      if (r.d2) { left(pg, r.d[1], cols[2], yy, 9); }
      for (let k = 1; k < Math.max(r.rem.length, r.bal.length); k++) {
        if (r.rem[k]) centred(pg, r.rem[k], cols[5], yy, 9);
        if (r.bal[k]) centred(pg, r.bal[k], cols[8], yy, 9);
        yy -= 9;
      }
      y = yy - 4;
    }
    return y;
  };
  const p1 = doc.addPage([W, H]);
  left(p1, 'Detailed Statement', 36, H - 80, 12);
  left(p1, 'Name:', 38, H - 110, 12); left(p1, 'ANAND EXPORTS', 157, H - 110, 12); left(p1, 'A/C Type:', 323, H - 110, 12); left(p1, 'CAA', 442, H - 110, 12);
  left(p1, 'Address:', 38, H - 130, 12); left(p1, 'GURUGRAM', 157, H - 130, 12); left(p1, 'Cust ID:', 323, H - 130, 12); left(p1, '412380977', 442, H - 130, 12);
  left(p1, 'A/C No:', 38, H - 150, 12); left(p1, '004512003387', 157, H - 150, 12); left(p1, 'IFSC Code:', 323, H - 150, 12); left(p1, 'XBNK0000412', 442, H - 150, 12);
  const hy = H - 340;
  [['Sr', 'No'], ['Tran', 'ID'], ['Value', 'Date'], ['Transaction', 'Date'], ['Cheque', 'no/ RefNo'], ['Transaction', 'Remarks'], ['Withdrawl', '(Dr)'], ['Deposit', '(Cr)'], ['Balance', '']].forEach(([a, b], i) => {
    left(p1, a, cols[i], hy, 10); if (b) left(p1, b, cols[i], hy - 10, 10);
  });
  drawRows(p1, rows.slice(0, 3), hy - 26);
  const p2 = doc.addPage([W, H]);
  drawRows(p2, rows.slice(3), H - 50);
  window.__stmt = await doc.save();
});
if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, Buffer.from(await page.evaluate(() => btoa(String.fromCharCode.apply(null, window.__stmt))), 'base64'));
await feed([['__stmt', 'statement.pdf']]);
const st = await convert();
const smd = st.md || '';
console.log('\n' + smd.split('\n').filter((l) => /^\|/.test(l)).map((l) => '    ' + l.slice(0, 150)).join('\n') + '\n');
await t('the two-line header becomes nine columns', () => {
  assert(/^\| Sr No \| Tran ID \| Value Date \| Transaction Date \| Cheque no\/ RefNo \| Transaction Remarks \| Withdrawl \(Dr\) \| Deposit \(Cr\) \| Balance \|$/m.test(smd),
    'header:\n' + (smd.match(/^\| Sr.*$/m) || ['(none)'])[0]);
});
await t('a row wrapped over three lines is one row, its remarks joined', () => {
  assert(/^\| 1 \| S1120044 \| 02-Apr-2025 \| 02-Apr-2025 \|  \| 004512003387:Int\. Coll:03-03-2025 to 01-04-2025 \| 193166\.00 \| NA \| -31120874\.23 \|$/m.test(smd),
    'row 1:\n' + (smd.match(/^\| 1 \|.*$/m) || ['(none)'])[0]);
});
await t('a balance broken into "-", "31120874.2", "3" is one number again', () => {
  assert(/-31120874\.23/.test(smd) && !/\| -3 \|/.test(smd), 'the balance fragments must be joined without spaces');
});
await t('a number beside a remark, however close, is its own cell', () => {
  assert(/^\| 3 \| S1120875 \| .* \| RTGS\/XBNKR42025 040700112233\/YB NK0004410\/STAR \| 5000000\.00 \| NA \| -30750939\.01 \|$/m.test(smd),
    'row 3:\n' + (smd.match(/^\| 3 \|.*$/m) || ['(none)'])[0]);
});
await t('page 2 carries the header forward, and a wrapped date is mended', () => {
  const after = smd.slice(smd.indexOf('<!-- page 2 -->'));
  assert(/^\| Sr No \| Tran ID/m.test(after), 'the header must be repeated on page 2');
  assert(/^\| 4 \| S1121002 \| 23-Sep-2025 \| 23-Sep-2025 \|/m.test(after), 'row 4:\n' + (after.match(/^\| 4 \|.*$/m) || ['(none)'])[0]);
});
await t('the label block above the table is its own small table, and nothing in it is a heading', () => {
  assert(/^\| Name: \| ANAND EXPORTS \| A\/C Type: \| CAA \|$/m.test(smd), 'label block:\n' + (smd.match(/^\| Name.*$/m) || ['(none)'])[0]);
  assert(!/^#+ /m.test(smd.replace(/^---[\s\S]*?---/, '')), 'no headings in a statement: ' + (smd.match(/^#+ .*$/m) || [''])[0]);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (errs.length) { console.log('\nBROWSER ERRORS:'); errs.slice(0, 5).forEach((e) => console.log('  ' + e)); }
await browser.close(); srv.close();
process.exit(fail || errs.length ? 1 : 0);
