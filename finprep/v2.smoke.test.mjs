/* Drives the real page in headless Chromium against the real server and a
 * scratch database: a partnership firm from an Excel trial balance to the
 * exported workbook.
 * Run: CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node finprep/v2.smoke.test.mjs
 * Needs: npm i --no-save playwright-core                                    */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { buildTemplate, COLUMNS } from './core/tbTemplate.js';
import { linesFor, captionFor } from './core/schedule3.js';

const ROOT = '/home/user/Tools';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knap-v2-smoke-'));
const PORT = 8300 + Math.floor(Math.random() * 500);
const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), KNAP_DB: path.join(dir, 'knap.db'),
  KNAP_DATA: path.join(dir, 'data'), KNAP_UPLOADS: path.join(dir, 'uploads'), TOOLS_PASSCODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
srv.stdout.on('data', (d) => { log += d; }); srv.stderr.on('data', (d) => { log += d; });
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(base + '/healthz'); if (r.ok) break; } catch { /* not yet */ }
  await new Promise((ok) => setTimeout(ok, 250));
}

// a filled template, written with the same ExcelJS the page uses
const tmp = path.join(os.tmpdir(), 'finprep-exceljs-smoke.cjs');
fs.copyFileSync(path.join(ROOT, 'gstr2b/exceljs.js'), tmp);
const ExcelJS = createRequire(import.meta.url)(tmp);
const heads = linesFor('NCE').map((l) => ({ lineId: l.id, caption: captionFor(l.id, 'NCE', 'partnership'), sectionTitle: l.section }));
const wb = buildTemplate(ExcelJS, { heads });
const ws = wb.getWorksheet('Trial Balance');
const R = (name, group, oDr, oCr, mDr, mCr, cDr, cCr) => [name, group, null, oDr || null, oCr || null, mDr || null, mCr || null, cDr || null, cCr || null, null, null];
[
  R('Ramesh Capital A/c', 'Capital Account', 0, 400000, 60000, 220000, 0, 560000),
  R('Suresh Capital A/c', 'Capital Account', 0, 300000, 40000, 0, 0, 260000),
  R('Remuneration - Ramesh', 'Indirect Expenses', 0, 0, 0, 0, 120000, 0),
  R('Remuneration - Suresh', 'Indirect Expenses', 0, 0, 0, 0, 120000, 0),
  R('Sales', 'Sales Accounts', 0, 0, 0, 0, 0, 1500000),
  R('Purchases', 'Purchase Accounts', 0, 0, 0, 0, 700000, 0),
  R('Shop Rent', 'Indirect Expenses', 0, 0, 0, 0, 120000, 0),
  R('HDFC Bank', 'Bank Accounts', 500000, 0, 0, 0, 1060000, 0),
  R('Sundry Creditors X', 'Sundry Creditors', 0, 100000, 0, 0, 0, 100000),
  R('Furniture', 'Fixed Assets', 300000, 0, 0, 0, 300000, 0),
].forEach((row, i) => { ws.getRow(i + 2).values = row; });
const tbFile = path.join(dir, 'tb.xlsx');
fs.writeFileSync(tbFile, Buffer.from(await wb.xlsx.writeBuffer()));

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
const page = await browser.newPage({ acceptDownloads: true });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
// a fresh engagement has no snapshot yet, and the page probes for one — that 404 is by design
page.on('response', (r) => { if (r.status() >= 400 && !(r.status() === 404 && /\/statements$/.test(r.url()))) errs.push(`${r.status()} ${r.url()}`); });

try {
  await page.goto(base + '/finprep/v2.html');
  await page.waitForSelector('#cCon option', { state: 'attached' });

  await t('a partnership engagement is created from the form and the page switches to the ICAI format', async () => {
    await page.fill('#cName', 'M/s Kumar Traders');
    await page.selectOption('#cCon', 'partnership');
    assert.ok(await page.isHidden('#cDivWrap'), 'the framework picker hides for a firm');
    await page.fill('#cPan', 'aaafk1234a');
    await page.click('#engNew');
    await page.waitForFunction(() => /Kumar Traders/.test(document.getElementById('engPill').textContent), null, { timeout: 15000 });
    assert.match(await page.textContent('#bandSub'), /ICAI non-corporate format · Partnership firm/);
  });

  await t('the Excel trial balance is checked and imported, and the grouping step opens with the partners card', async () => {
    await page.click('#stepper .step[data-step="3"]');
    await page.setInputFiles('#tplFile', tbFile);
    await page.click('#tplGo');
    await page.waitForFunction(() => !document.getElementById('s4').classList.contains('hidden'), null, { timeout: 20000 });
    assert.match(await page.textContent('#mTpl'), /Imported 10 ledgers/);
    assert.ok(await page.isVisible('#ownCard'));
    assert.match(await page.textContent('#ownTitle'), /Partners and profit sharing/);
    const rows = await page.$$eval('#gRows tr', (trs) => trs.length);
    assert.ok(rows >= 1, 'grouping rows rendered');
  });

  await t('two partners are added with ratios and saved; the statements rebuild with their capital accounts', async () => {
    await page.click('#ownAdd'); await page.click('#ownAdd');
    const names = await page.$$('#ownRows .o-name');
    await names[0].fill('Ramesh Kumar'); await names[1].fill('Suresh Kumar');
    const ratios = await page.$$('#ownRows .o-ratio');
    await ratios[0].fill('60'); await ratios[1].fill('40');
    await page.click('#ownSave');
    await page.waitForFunction(() => /saved/.test(document.getElementById('mOwn').textContent), null, { timeout: 15000 });
    await page.click('#stepper .step[data-step="6"]');
    await page.click('#stTabs button[data-t="nt"]');
    const notes = await page.textContent('#stBody');
    assert.match(notes, /Partners’ capital accounts/);
    assert.match(notes, /Ramesh Kumar/);
    assert.match(notes, /2,64,000\.00/, 'Ramesh’s 60% share of 4,40,000');
    await page.click('#stTabs button[data-t="bs"]');
    const bs = await page.textContent('#stBody');
    assert.match(bs, /Owners’ funds/);
    assert.match(bs, /12,60,000\.00/);
  });

  await t('an adjustment entry is recorded through the screen and changes the profit', async () => {
    await page.click('#stepper .step[data-step="5"]');
    await page.fill('#jNarr', 'Rent accrued for March');
    const leds = await page.$$('#jRows .j-led');
    await leds[0].fill('Shop Rent');
    const drs = await page.$$('#jRows .j-dr');
    await drs[0].fill('5000');
    await drs[0].dispatchEvent('change');
    await page.selectOption('#jRows tr:nth-child(2) .j-head', 'other_current_liabilities');
    const crs = await page.$$('#jRows .j-cr');
    await crs[1].fill('5000');
    await crs[1].dispatchEvent('change');
    assert.match(await page.textContent('#jDiff'), /balances/);
    await page.click('#jSaveApprove');
    await page.waitForFunction(() => /applied/.test(document.getElementById('mJ').textContent), null, { timeout: 15000 });
    assert.match(await page.textContent('#jrnList'), /Rent accrued for March/);
    await page.click('#stepper .step[data-step="6"]');
    await page.click('#stTabs button[data-t="pl"]');
    assert.match(await page.textContent('#stBody'), /4,35,000\.00/, 'profit after the 5,000 accrual');
  });

  await t('the Excel working paper downloads with a Capital Accounts sheet', async () => {
    await page.click('#stepper .step[data-step="9"]');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exXlsx')]);
    const out = path.join(dir, 'out.xlsx');
    await dl.saveAs(out);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(fs.readFileSync(out));
    assert.ok(wb2.getWorksheet('Capital Accounts'), 'sheet present');
    assert.match(dl.suggestedFilename(), /Kumar_Traders_Financials/);
  });

  await t('the variance card appears after a second import and the page raised no script errors', async () => {
    await page.click('#stepper .step[data-step="3"]');
    await page.setInputFiles('#tplFile', tbFile);
    await page.click('#tplGo');
    await page.waitForFunction(() => !document.getElementById('varCard').classList.contains('hidden'), null, { timeout: 20000 });
    assert.match(await page.textContent('#varRows'), /Nothing changed/);
    assert.deepEqual(errs, []);
  });
} finally {
  await browser.close();
  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail && log) console.log('\nSERVER LOG (tail):\n' + log.split('\n').slice(-15).join('\n'));
process.exit(fail ? 1 : 0);
