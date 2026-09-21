import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const ExcelJS = createRequire('/tmp/x.js')('/tmp/xl.cjs');
const { readWorkbook, lineFromCaption, cellNum } = await import('./priorImport.js');
let p=0,f=0; const t=(n,fn)=>{try{fn();p++;console.log('  PASS  '+n)}catch(e){f++;console.log('  FAIL  '+n+'\n        '+e.message)}};

console.log('\n── caption matching ──');
t('longest match wins; other income never beats other expenses', ()=>{
  assert.equal(lineFromCaption('Other income'),'other_income');
  assert.equal(lineFromCaption('Other expenses'),'other_expenses');
  assert.equal(lineFromCaption('(a) Property, Plant and Equipment'),'ppe');
  assert.equal(lineFromCaption('Revenue from operations'),'revenue_operations');
  assert.equal(lineFromCaption('Deferred tax liabilities (Net)'),'deferred_tax_liability');
  assert.equal(lineFromCaption('Total outstanding dues of micro enterprises and small enterprises'),'trade_payables_msme');
});
t('a caption it does not know returns null rather than guessing', ()=>{
  assert.equal(lineFromCaption('Sundry balances written back'), null);
});
t('bracketed and comma amounts parse', ()=>{
  const c = v => ({value:v});
  assert.equal(cellNum(c('(1,23,456.50)')), -123456.5);
  assert.equal(cellNum(c('1,00,000')), 100000);
});

console.log('\n── reading a signed-format workbook ──');
const buf = fs.readFileSync('/root/.claude/uploads/1dd9ba9d-5035-5314-b75b-235a2fc0b48b/a7fdc04a-Balance_sheet_format_1.3.xlsx');
const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
// populate the face amounts so there is something to read
for (const sn of ['Balance Sheet','Profit & loss']) {
  const ws = wb.getWorksheet(sn); let seed = 1000;
  for (let r=7; r<=ws.rowCount; r++){ const row=ws.getRow(r);
    const lbl=row.getCell(2).value; if(lbl && typeof lbl==='string' && lbl.trim().length>4){ row.getCell(4).value=seed; seed+=1000; } }
}
const out = await readWorkbook(ExcelJS, await wb.xlsx.writeBuffer());

t('particulars are extracted with a source for each', ()=>{
  const byKey = Object.fromEntries(out.fields.map(f=>[f.key,f]));
  assert.ok(byKey.cin, 'no CIN'); assert.match(byKey.cin.value, /^[LU]\d{5}/);
  assert.ok(byKey.auditorFrn, 'no FRN');
  assert.ok(byKey.auditorFirm, 'no auditor firm');
  for (const f of out.fields){ assert.ok(f.source, f.key+' has no source'); assert.equal(f.status,'unconfirmed'); }
  console.log('        ->', out.fields.map(f=>f.key+'='+f.value).join(' | ').slice(0,190));
});
t('shareholders are picked up', ()=>{
  console.log('        ->', JSON.stringify(out.shareholders));
  assert.ok(Array.isArray(out.shareholders));
});
t('figures map to OUR line ids, not last year’s note numbers', ()=>{
  console.log('        ->', out.figures.slice(0,8).map(f=>f.lineId+'='+f.amount).join(', '));
  assert.ok(out.figures.length>5, 'expected several figures, got '+out.figures.length);
  for (const f of out.figures){ assert.ok(f.source, 'figure without a source'); assert.ok(f.caption); }
});
t('totals are never imported', ()=>{
  assert.ok(!out.figures.some(f=>/^total/i.test(f.caption)));
});

console.log('\n── the statement of profit and loss ──');
/* A signed P&L numbers its sections in column 1 — "I | Revenue from operations"
   — and the cash flow statement repeats many of the same captions as MOVEMENTS.
   Both were silently costing the whole P&L its comparatives. */
const pl = new ExcelJS.Workbook();
{
  const ws = pl.addWorksheet('Profit & loss');
  ws.addRow(['ABC Private Limited']);
  ws.addRow(['Statement of Profit and Loss for the year ended 31 March 2025']);
  ws.addRow([]);
  ws.addRow(['Particulars', '', 'Notes', 'For the year ended  31 March 2025', 'For the year ended  31 March 2024']);
  ws.addRow(['I', 'Revenue from operations', 23, 26268459, 100]);
  ws.addRow(['II', 'Other Income', 24, 558550, 200]);
  ws.addRow(['III', 'Total income (I+II)', '', 26827009, 300]);
  ws.addRow(['IV', 'Expenses', '', '', '']);
  ws.addRow(['', '(a) Employee benefits expense', 25, 13921714, 400]);
  ws.addRow(['', '(b) Finance costs', 26, 182, 500]);
  ws.addRow(['', '(c) Depreciation and amortisation expense', 27, 1917474, 600]);
  ws.addRow(['', '(d) Other expenses', 28, 13922381, 700]);
  ws.addRow(['V', 'Total expenses', '', 28038430, 800]);
  const cf = pl.addWorksheet('CFS');
  cf.addRow(['ABC Private Limited']);
  cf.addRow(['Cash Flow Statement For The Year Ended March 31, 2025']);
  cf.addRow([]);
  cf.addRow(['S. No.', 'Particulars', '', '', 'For the year ended March 31, 2025']);
  cf.addRow(['A.', 'Cash Flow From Operating Activities', '', '', '']);
  cf.addRow(['', 'Depreciation and amortisation expense', '', '', 9999999]);
  cf.addRow(['', 'Trade receivables', '', '', -8888888]);
}
const plOut = await readWorkbook(ExcelJS, await pl.xlsx.writeBuffer());
const plBy = Object.fromEntries(plOut.figures.map(f => [f.lineId, f.amount]));

t('a P&L numbered I, II, III in column 1 still imports every line', ()=>{
  assert.equal(plBy.revenue_operations, 26268459, 'revenue from operations');
  assert.equal(plBy.other_income, 558550);
  assert.equal(plBy.employee_benefits, 13921714);
  assert.equal(plBy.finance_costs, 182);
  assert.equal(plBy.depreciation_amortisation, 1917474);
  assert.equal(plBy.other_expenses, 13922381);
});
t('figures are never taken from the cash flow statement', ()=>{
  assert.notEqual(plBy.depreciation_amortisation, 9999999, 'took a movement off the cash flow');
  assert.equal(plBy.trade_receivables, undefined, 'imported a movement as a balance');
  assert.ok(plOut.skippedSheets.some(s => /cash flow/i.test(s.why)), 'the cash flow sheet must be reported as skipped');
});
t('totals are still never imported', ()=>{
  assert.ok(!plOut.figures.some(f => /^total/i.test(f.caption)));
});

/* Some firms put the wording in a banner and only the date in the column. */
const hdr = new ExcelJS.Workbook();
{
  const ws = hdr.addWorksheet('P and L');
  ws.addRow(['ABC Private Limited']);
  ws.addRow(['Statement of Profit and Loss']);
  ws.addRow([]);
  ws.addRow(['Particulars', 'Note', '31 March 2025', '31 March 2024']);
  ws.addRow(['Revenue from operations', 23, 5000, 4000]);
  ws.addRow(['Other expenses', 28, 1500, 1200]);
}
const hdrOut = await readWorkbook(ExcelJS, await hdr.xlsx.writeBuffer());
t('a period column headed only by a date is still recognised', ()=>{
  const by = Object.fromEntries(hdrOut.figures.map(f => [f.lineId, f.amount]));
  assert.equal(by.revenue_operations, 5000);
  assert.equal(by.other_expenses, 1500);
});

const split = new ExcelJS.Workbook();
{
  const ws = split.addWorksheet('PL split header');
  ws.addRow(['ABC Private Limited']);
  ws.addRow([]);
  ws.addRow(['Particulars', 'Note', 'For the year ended', 'For the year ended']);
  ws.addRow(['', '', '31 March 2025', '31 March 2024']);
  ws.addRow(['Revenue from operations', 23, 7000, 6000]);
}
const splitOut = await readWorkbook(ExcelJS, await split.xlsx.writeBuffer());
t('a header split over two rows is still recognised', ()=>{
  const by = Object.fromEntries(splitOut.figures.map(f => [f.lineId, f.amount]));
  assert.equal(by.revenue_operations, 7000);
});

const banner = new ExcelJS.Workbook();
{
  const ws = banner.addWorksheet('BS');
  // a merged title carrying "as at 31 March 2023" across every column
  ws.addRow(['Balance Sheet as at 31 March 2023', 'Balance Sheet as at 31 March 2023',
             'Balance Sheet as at 31 March 2023', 'Balance Sheet as at 31 March 2023']);
  ws.addRow(['Particulars', 'Notes', 'As at 31 March 2023', 'As at 31 March 2022']);
  ws.addRow(['Share capital', 1, 250000, 250000]);
}
const bannerOut = await readWorkbook(ExcelJS, await banner.xlsx.writeBuffer());
t('a merged title row is not mistaken for the period columns', ()=>{
  const by = Object.fromEntries(bannerOut.figures.map(f => [f.lineId, f.amount]));
  assert.equal(by.share_capital, 250000, 'must read the 2023 column, not the title');
});
console.log(`\n${p} passed, ${f} failed\n`); process.exit(f?1:0);
