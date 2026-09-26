/* ============================================================================
 * datepicker.test.mjs — the period picker on the GSTR-2B vs Books ITC page.
 *
 *   npm i --no-save playwright-core && node itc-reco/datepicker.test.mjs
 *
 * The browser's own picker scrolls its day grid while its header stays put, so
 * it can show one month and name another — and a fetch then runs over a period
 * nobody chose. These check that this picker cannot drift: whatever month the
 * header names is the month the grid shows, through every way of moving.
 * ==========================================================================*/
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(8141, '127.0.0.1', r));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium/chrome-linux/chrome',
  args: ['--no-sandbox'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:8141/itc-reco/');
/* The period lives in step 2, which the page keeps hidden until a company has
   been picked. Nothing here is about Tally, so the card is simply revealed. */
await page.evaluate(() => {
  for (const id of ['card2', 'confirmBlock']) {
    const c = document.querySelector('#' + id);
    if (c) c.classList.remove('hidden');
  }
});
await page.waitForSelector('#fromDate', { state: 'visible', timeout: 5000 });

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const openPicker = async () => {
  await page.click('#fromDate');
  await page.waitForSelector('.kdp', { timeout: 5000 });
};
/* What the picker SAYS, and what it SHOWS — read separately, on purpose. */
const state = () => page.evaluate(() => {
  const el = document.querySelector('.kdp');
  const days = [...el.querySelectorAll('.kdp-g button:not(.out)')].map((b) => b.dataset.iso);
  return {
    saysMonth: +el.querySelector('.kdp-m').value,
    saysYear: +el.querySelector('.kdp-y').value,
    firstDay: days[0], lastDay: days[days.length - 1], count: days.length,
  };
});
const agrees = (s) => {
  const [y, m] = s.firstDay.split('-').map(Number);
  const [ly, lm] = s.lastDay.split('-').map(Number);
  assert(y === s.saysYear && m - 1 === s.saysMonth,
    `header says ${s.saysYear}-${s.saysMonth + 1} but the grid starts ${s.firstDay}`);
  assert(ly === s.saysYear && lm - 1 === s.saysMonth,
    `header says ${s.saysYear}-${s.saysMonth + 1} but the grid ends ${s.lastDay}`);
  const inMonth = new Date(s.saysYear, s.saysMonth + 1, 0).getDate();
  assert(s.count === inMonth, `${s.saysYear}-${s.saysMonth + 1} has ${inMonth} days, grid shows ${s.count}`);
};

console.log('\n── the header always names the grid ──');
await t('it opens on the month of the date already in the box', async () => {
  await page.evaluate(() => { document.querySelector('#fromDate').value = '2025-09-03'; });
  await openPicker();
  const s = await state();
  assert(s.saysYear === 2025 && s.saysMonth === 8, `expected September 2025, got ${s.saysYear}-${s.saysMonth + 1}`);
  agrees(s);
});
await t('stepping back a month moves both the header and the grid', async () => {
  for (let i = 0; i < 4; i++) {
    await page.click('.kdp [data-step="-1"]');
    agrees(await state());
  }
  const s = await state();
  assert(s.saysYear === 2025 && s.saysMonth === 4, `four steps back from Sept should be May, got ${s.saysYear}-${s.saysMonth + 1}`);
});
await t('stepping across a year boundary keeps them together', async () => {
  for (let i = 0; i < 6; i++) { await page.click('.kdp [data-step="-1"]'); agrees(await state()); }
  const s = await state();
  assert(s.saysYear === 2024 && s.saysMonth === 10, `expected November 2024, got ${s.saysYear}-${s.saysMonth + 1}`);
});
await t('choosing a month or year from the header redraws the grid', async () => {
  await page.selectOption('.kdp .kdp-m', '1');        // February
  agrees(await state());
  await page.selectOption('.kdp .kdp-y', '2024');     // a leap year
  const s = await state();
  agrees(s);
  assert(s.count === 29, 'February 2024 has 29 days, grid shows ' + s.count);
});
await t('there is nothing to scroll, so nothing can drift out of step', async () => {
  const scrollable = await page.evaluate(() => {
    const g = document.querySelector('.kdp-g');
    return g.scrollHeight > g.clientHeight + 1 || getComputedStyle(g).overflowY === 'scroll';
  });
  assert(!scrollable, 'the day grid scrolls — that is how the native picker drifts');
});
await t('picking a day sets the field and closes', async () => {
  await page.click('.kdp .kdp-g button:not(.out)[data-iso="2024-02-15"]');
  const v = await page.inputValue('#fromDate');
  assert(v === '2024-02-15', 'expected 2024-02-15, got ' + v);
  assert(await page.locator('.kdp').count() === 0, 'the picker should close after a pick');
});

console.log('\n── the shortcuts, which is what the period usually is ──');
await t('a financial year sets both ends at once', async () => {
  const label = await page.evaluate(() => document.querySelector('#fyQuick button').textContent);
  await page.click('#fyQuick button:nth-child(1)');
  const from = await page.inputValue('#fromDate'), to = await page.inputValue('#toDate');
  assert(/^\d{4}-04-01$/.test(from), `${label} should start on 1 April, got ${from}`);
  assert(/^\d{4}-03-31$/.test(to), `${label} should end on 31 March, got ${to}`);
  assert(+to.slice(0, 4) === +from.slice(0, 4) + 1, `${label} should span two calendar years: ${from} to ${to}`);
});
await t('the previous financial year is the one before it', async () => {
  await page.click('#fyQuick button:nth-child(1)');
  const cur = await page.inputValue('#fromDate');
  await page.click('#fyQuick button:nth-child(2)');
  const prev = await page.inputValue('#fromDate');
  assert(+prev.slice(0, 4) === +cur.slice(0, 4) - 1, `${prev} should be a year before ${cur}`);
});
await t('a month shortcut covers exactly that month', async () => {
  await page.click('#fyQuick button:nth-child(3)');
  const from = await page.inputValue('#fromDate'), to = await page.inputValue('#toDate');
  const [y, m] = from.split('-').map(Number);
  assert(from.endsWith('-01'), 'should start on the 1st, got ' + from);
  assert(to === `${y}-${String(m).padStart(2, '0')}-${new Date(y, m, 0).getDate()}`,
    `should end on the last day of ${y}-${m}, got ${to}`);
});


console.log('\n── it stays on screen ──');
await t('near the bottom of the window it opens upwards, not off the edge', async () => {
  await page.setViewportSize({ width: 1100, height: 470 });
  await openPicker();
  const fits = await page.evaluate(() => {
    const el = document.querySelector('.kdp');
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, h: window.innerHeight };
  });
  assert(fits.bottom <= fits.h + 1, `the picker runs ${Math.round(fits.bottom - fits.h)}px past the bottom of the window`);
  assert(fits.top >= -1, 'the picker runs off the top of the window');
  await page.setViewportSize({ width: 1100, height: 900 });
});
await t('clicking where the browser\'s calendar button sat opens THIS picker', async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const e = document.querySelector('.kdp'); if (e) e.remove(); });
  const box = await page.locator('#fromDate').boundingBox();
  // the far right of the field is where the native indicator lives
  await page.mouse.click(box.x + box.width - 6, box.y + box.height / 2);
  await page.waitForSelector('.kdp', { timeout: 3000 });
  assert(await page.locator('.kdp').count() === 1, 'expected exactly one picker');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (errs.length) { console.log('\nBROWSER ERRORS:'); errs.slice(0, 5).forEach((e) => console.log('  ' + e)); }
await browser.close(); srv.close();
process.exit(fail || errs.length ? 1 : 0);
