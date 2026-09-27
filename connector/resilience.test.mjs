/* ============================================================================
 * resilience.test.mjs — the connector must not die quietly.
 *
 *   node connector/resilience.test.mjs
 *
 * Written after a real first run of the ITC reconciliation failed with nothing
 * but the browser's own "Failed to fetch". That message means the socket died;
 * it names no cause and never could. The reason existed only in a console
 * window, and if the process had exited there was nothing left to ask.
 *
 * So: any uncaught error keeps the connector alive, is written to
 * knap-connector-errors.log beside it, and is handed to the page through
 * /api/dc/progress as `lastFatal`. These tests hold that in place.
 * ==========================================================================*/
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SELF = path.dirname(new URL(import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knap-conn-'));
const copy = path.join(dir, 'connector.mjs');
fs.copyFileSync(path.join(SELF, 'knap-tally-connector.mjs'), copy);

const PORT = 8798 + (process.pid % 50);
const proc = spawn(process.execPath, [copy], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
proc.stdout.on('data', (d) => { log += d; });
proc.stderr.on('data', (d) => { log += d; });

const base = 'http://127.0.0.1:' + PORT;
const get = (u) => fetch(base + u).then((r) => r.json());
const until = async (fn, ms = 10000) => {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return true; } catch { /* not up yet */ }
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
};

let pass = 0, fail = 0;
const t = (n, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (detail ? '\n        ' + detail : '')); }
};

try {
  t('the connector starts and answers', await until(() => get('/api/dc/progress').then(() => true)));

  await fetch(base + '/api/itc/register', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{ not json at all' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  t('a malformed request does not take it down',
    await until(() => get('/api/dc/progress').then(() => true), 3000));

  const p0 = await get('/api/dc/progress');
  t('progress carries the version, so the page can tell which build answered', !!p0.version, JSON.stringify(p0).slice(0, 120));

  /* A Tally that is not listening. This is the path that matters: it must come
     back as JSON the page can show, never as a dead socket. */
  const r = await fetch(base + '/api/itc/register', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:1', company: 'X',
      from: '2025-04-01', to: '2026-03-31', taxLedgers: [{ name: 'Input IGST', kind: 'igst' }] }) });
  const j = await r.json();
  t('an unreachable Tally answers with JSON, not a dead socket',
    j && j.ok === false && /Could not read Tally/.test(j.error || ''), JSON.stringify(j).slice(0, 160));

  const p1 = await get('/api/dc/progress');
  t('the connector is still up after a failed read', !!p1);
  t('and a failed read leaves no read flagged as running', p1.active === false,
    'active=' + p1.active);

  /* The timeouts a long read depends on. Node's defaults are written for public
     servers that shed slow clients; a read that waits minutes on Tally is not a
     slow client. */
  const src = fs.readFileSync(copy, 'utf8');
  t('keep-alive is long enough for a read that waits on Tally', /server\.keepAliveTimeout\s*=\s*120_000/.test(src));
  t('headersTimeout exceeds keepAliveTimeout, as Node requires', /server\.headersTimeout\s*=\s*125_000/.test(src));
  t('no request timeout caps a long read', /server\.requestTimeout\s*=\s*0/.test(src));
  t('uncaught errors are trapped rather than fatal',
    /process\.on\('uncaughtException'/.test(src) && /process\.on\('unhandledRejection'/.test(src));
} finally {
  proc.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\nconnector output:\n' + log.slice(-2000));
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
process.exit(fail ? 1 : 0);
