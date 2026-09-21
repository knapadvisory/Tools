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
console.log(`\n${p} passed, ${f} failed\n`); process.exit(f?1:0);
