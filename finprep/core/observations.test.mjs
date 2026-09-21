import assert from 'node:assert/strict';
import { build } from './engine.js';
import { buildCashFlow } from './cashflow.js';
import { observe, WEIGHT } from './observations.js';
let p=0,f=0; const t=(n,fn)=>{try{fn();p++;console.log('  PASS  '+n)}catch(e){f++;console.log('  FAIL  '+n+'\n        '+e.message)}};
const L=(name,path,cur,pri,x={})=>({name,group:path[0],primary:path[path.length-1],groupPath:path,current:cur,prior:pri,...x});
const base=[
 L('Share Capital',['Capital Account'],-1000000,-1000000),
 L('Profit & Loss A/c',['Reserves & Surplus'],-700000,-200000),
 L('Plant & Machinery',['Fixed Assets'],1460000,1600000),
 L('HDFC Bank',['Bank Accounts'],1060000,400000),
 L('Sundry Creditors A',['Sundry Creditors'],-300000,-300000),
 L('Fees',['Sales Accounts'],-1000000,-900000,{isRevenue:true}),
 L('Salary',['Indirect Expenses'],340000,300000,{isRevenue:true}),
 L('Depreciation',['Indirect Expenses'],140000,100000,{isRevenue:true})];

t('profit with no tax provision is observed', ()=>{
  const r=build({ledgers:base}); const o=observe(r,buildCashFlow(r),{});
  const x=o.observations.find(z=>z.id==='OBS-PL-NOTAX');
  assert.ok(x, 'expected a no-tax observation');
  assert.match(x.verify,/adjusting journal/);
});
t('missing evidence is observed for every input kind', ()=>{
  const r=build({ledgers:base}); const o=observe(r,null,{inputs:{counts:{}}});
  for(const k of ['prior_financials','gstr2b','gstr1_3b','tds_conso'])
    assert.ok(o.observations.some(z=>z.id==='OBS-EV-'+k), 'missing '+k);
});
t('a month with no return is a GAP, never a nil return', ()=>{
  const r=build({ledgers:base});
  const o=observe(r,null,{inputs:{counts:{gstr2b:1},perKind:{gstr2b:{label:'GSTR-2B',missing:['2025-07','2025-08'],filesWithoutPeriod:0}}}});
  const x=o.observations.find(z=>z.id==='OBS-EV-GAP-gstr2b');
  assert.ok(x); assert.match(x.verify,/must not be assumed to be a nil return/);
});
t('unclassified balances are BLOCKING', ()=>{
  const r=build({ledgers:base.concat([L('Mystery',['Suspense A/c'],500000,0)])});
  const o=observe(r,null,{});
  assert.ok(o.observations.some(z=>z.weight===WEIGHT.BLOCKING));
  assert.ok(o.summary.blocking>0);
});
t('whole payables shown as non-MSME is challenged', ()=>{
  const r=build({ledgers:base}); const o=observe(r,null,{});
  const x=o.observations.find(z=>z.id==='OBS-BS-MSME');
  assert.ok(x); assert.match(x.verify,/does not mean there are no MSME dues/);
});
t('ageing cannot be derived from a trial balance', ()=>{
  const r=build({ledgers:base}); const o=observe(r,null,{});
  const x=o.observations.find(z=>z.id==='OBS-BS-AGEING');
  assert.ok(x); assert.match(x.verify,/Do not derive it from closing balances/);
});
t('undetermined applicability is surfaced', ()=>{
  const r=build({ledgers:base});
  const o=observe(r,null,{applicability:[{domain:'caro',conclusion:'Unable to determine'}]});
  assert.ok(o.observations.some(z=>z.id==='OBS-APPL'));
});
t('the disclaimer refuses to present this as an opinion', ()=>{
  const r=build({ledgers:base}); const o=observe(r,null,{});
  assert.match(o.disclaimer,/not audit findings/);
  assert.match(o.disclaimer,/absence of an observation is not assurance/);
});
t('every observation tells the user what to verify', ()=>{
  const r=build({ledgers:base}); const o=observe(r,buildCashFlow(r),{});
  for(const x of o.observations){ assert.ok(x.verify && x.verify.length>10, x.id+' has no verify action'); assert.ok(x.basis, x.id+' has no basis'); }
});
console.log(`\n${p} passed, ${f} failed\n`); process.exit(f?1:0);
