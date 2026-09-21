import { RULE_DEFS, evaluate, assessAll, requiredFacts, CONCLUSION, ruleDef } from './applicability.js';
import assert from 'node:assert/strict';
let p=0,f=0; const t=(n,fn)=>{try{fn();p++;console.log('  PASS  '+n)}catch(e){f++;console.log('  FAIL  '+n+'\n        '+e.message)}};

t('every domain the spec requires has a rule', () => {
  for (const d of ['caro','msme','tax_audit','ifc','framework'])
    assert.ok(RULE_DEFS.some(r=>r.domain===d), 'missing '+d);
});
t('an unverified rule NEVER concludes', () => {
  for (const def of RULE_DEFS) {
    const r = evaluate(def, { status:'unverified' }, {});
    assert.equal(r.conclusion, CONCLUSION.UNKNOWN);
    assert.equal(r.requiresProfessionalValidation, true);
  }
});
t('no threshold is hardcoded anywhere in the definitions', () => {
  const src = JSON.stringify(RULE_DEFS);
  // any bare number >= 100000 would be a threshold slipped in
  const nums = (src.match(/\d{6,}/g)||[]);
  assert.equal(nums.length, 0, 'found numeric literals: '+nums.join(','));
});
t('a verified rule with missing facts reports exactly what is missing', () => {
  const def = ruleDef('tax_audit','tax_audit_applicability');
  const r = evaluate(def, { status:'verified', operands: JSON.stringify({turnoverLimit:1,cashConditionPercent:1}) }, {});
  assert.equal(r.conclusion, CONCLUSION.UNKNOWN);
  assert.ok(r.missingFacts.includes('turnover'));
});
t('a verified rule outside its effective window says so', () => {
  const def = ruleDef('caro','caro_applicability');
  const r = evaluate(def, { status:'verified', effective_from:'2030-04-01' }, {}, '2026-03-31');
  assert.match(r.reason, /takes effect from 2030-04-01/);
});
t('CARO asks for PEAK borrowings, not the year-end balance', () => {
  const def = ruleDef('caro','caro_applicability');
  const fact = def.requiredFacts.find(f=>f.key==='totalBorrowingsPeak');
  assert.ok(fact && /Peak, not the year-end/.test(fact.help));
});
t('the two tax-audit cash conditions are separate', () => {
  const def = ruleDef('tax_audit','tax_audit_applicability');
  assert.ok(def.conditions.some(c=>c.id==='cash_receipts'));
  assert.ok(def.conditions.some(c=>c.id==='cash_payments'));
});
t('MSME records that missing Udyam evidence is unknown, not exempt', () => {
  assert.match(ruleDef('msme','msme_disclosure').note, /never automatic exemption/);
});
t('assessAll returns one result per rule and none concludes while unseeded', () => {
  const out = assessAll([], {}, '2026-03-31');
  assert.equal(out.length, RULE_DEFS.length);
  assert.ok(out.every(o=>o.conclusion===CONCLUSION.UNKNOWN));
});
t('requiredFacts deduplicates across domains', () => {
  const rf = requiredFacts();
  const turnover = rf.find(f=>f.key==='turnover');
  assert.ok(turnover.usedBy.length>=2, 'turnover is used by tax_audit and ifc');
});
console.log(`\n${p} passed, ${f} failed\n`); process.exit(f?1:0);
