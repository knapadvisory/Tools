/* ============================================================================
 * version.test.mjs — the two places a connector version lives must agree.
 *
 *   node connector/version.test.mjs
 *
 * The connector self-updates by comparing its own VERSION against
 * /connector/version.json. If version.json is AHEAD, every connector in the
 * field downloads the file, restarts, still reports the old version, and
 * downloads again — an update loop. If it is BEHIND, a new build is never
 * offered and nobody gets the fix. Neither failure is visible from the code.
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); pass++; console.log('  PASS  ' + n); }
  catch (e) { fail++; console.log('  FAIL  ' + n + '\n        ' + e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const src = fs.readFileSync(path.join(dir, 'knap-tally-connector.mjs'), 'utf8');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
const inCode = (/const VERSION = '([^']+)'/.exec(src) || [])[1];

t('the connector declares a version', () => {
  assert(inCode, 'no `const VERSION = ...` found in knap-tally-connector.mjs');
  assert(/^\d+\.\d+$/.test(inCode), 'version should look like 4.59, got ' + inCode);
});
t('version.json matches the connector exactly', () => {
  assert(meta.version === inCode,
    `version.json says ${meta.version} but the connector says ${inCode} — `
    + (meta.version > inCode ? 'every connector in the field would update in a loop'
                             : 'the new build would never be offered'));
});

const audit = fs.readFileSync(path.join(dir, 'knap-tally-audit-engine.mjs'), 'utf8');
const auditV = (/const VERSION = '([^']+)'/.exec(audit) || [])[1];
t('the audit engine version matches too', () => {
  assert(auditV, 'no VERSION in knap-tally-audit-engine.mjs');
  assert(meta.audit === auditV, `version.json audit is ${meta.audit} but the engine says ${auditV}`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
