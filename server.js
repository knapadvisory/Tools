// KNAP Tools hub server.
// Serves the static hub page + tool downloads, and hosts the Marketplace Fee
// Register parser: uploaded fee PDFs are handed to the tested Python parser
// (parser/amazon_invoice_parser.py) as a child process, and an .xlsx register
// plus a per-document reconciliation summary come back. Nothing leaves the
// server; temp files are swept after a short TTL.
//
// Ported from TeamHub's server/src/routes/feeParser.js so the tool runs on
// apps.knapadvisory.com directly, with no TeamHub login.
//
// Access: set TOOLS_PASSCODE to gate the WHOLE site behind one shared key —
// every page and download serves the key screen (gate.html) until the right
// key is entered, then a long-lived HttpOnly cookie remembers the browser.
// The cookie token is derived from the key, so changing the key signs
// everyone out. Unset = fully open. (A stand-in until proper login arrives.)
import express from 'express';
import multer from 'multer';
import http from 'http';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 80);
const PASSCODE = process.env.TOOLS_PASSCODE || '';
const PYTHON = process.env.PARSER_PYTHON || 'python3';
const PARSER = process.env.PARSER_SCRIPT || path.join(__dirname, 'parser', 'amazon_invoice_parser.py');

const app = express();
app.disable('x-powered-by');

// ------------------------------------------------------------ access gate

// Sessions are a signed expiry timestamp in a browser-session cookie: the key
// stops working when the browser closes OR after SESSION_MS (default 3 h),
// whichever comes first. On top of that, session.js keeps a per-TAB marker in
// sessionStorage, so even reopening a closed tab asks for the key again. It
// also warns 10 minutes before the time limit and lets the user extend in
// place, so in-progress work is never lost. Tokens are stateless (HMAC-signed
// with the key itself): they survive container restarts and all die together
// when the key changes.
const SESSION_MS = (Number(process.env.TOOLS_SESSION_HOURS) || 3) * 3600 * 1000;

function sign(exp) {
  return crypto.createHmac('sha256', PASSCODE).update('knap-tools-gate-v2:' + exp).digest('hex');
}
function makeToken() { const exp = Date.now() + SESSION_MS; return exp + '.' + sign(exp); }
function tokenExp(t) {
  const dot = (t || '').indexOf('.');
  if (dot < 1) return 0;
  const exp = Number(t.slice(0, dot));
  if (!exp || exp < Date.now()) return 0;
  try {
    const a = Buffer.from(t.slice(dot + 1)), b = Buffer.from(sign(exp));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return exp;
  } catch { /* fall through */ }
  return 0;
}

function cookieToken(req) {
  const m = /(?:^|;\s*)knap_key=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}

function hasAccess(req) {
  if (!PASSCODE) return true;
  if (tokenExp(cookieToken(req)) > 0) return true;
  return (req.get('x-passcode') || '') === PASSCODE; // curl / script access
}

function setSession(req, res) {
  const token = makeToken();
  const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  // No Max-Age: a browser-session cookie, gone when the browser closes.
  res.setHeader('Set-Cookie', `knap_key=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`);
  return Number(token.split('.')[0]);
}

app.post('/api/auth/login', express.json(), (req, res) => {
  if (PASSCODE && (req.body?.key || '') !== PASSCODE) {
    // Small damper against key guessing.
    return setTimeout(() => res.status(401).json({ error: 'Wrong key.' }), 700);
  }
  res.json({ exp: setSession(req, res) });
});

// Signing out needs no auth — it only clears the browser's own cookie.
app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'knap_key=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.status(204).end();
});

// The Tally connector's install + self-update files stay OPEN (no key): the
// connector on a Tally PC fetches these unattended, and they contain no data.
app.use('/connector', express.static(path.join(__dirname, 'connector'), {
  setHeaders: (res, filePath) => {
    res.set('Cache-Control', 'no-cache');
    if (/\.bat$/i.test(filePath)) res.set('Content-Disposition', 'attachment');
  },
}));

// Everything below this point requires the key (when one is set).
app.use((req, res, next) => {
  if (req.path === '/healthz' || hasAccess(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Passcode required.' });
  res.status(401).set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'gate.html'));
});

// Session info for the pages' timer (gated: only reachable once signed in).
app.get('/api/auth/status', (req, res) => {
  if (!PASSCODE) return res.json({ gated: false });
  res.json({ gated: true, exp: tokenExp(cookieToken(req)) || null });
});

// "Continue" on the expiry warning: a fresh full session, no reload needed.
app.post('/api/auth/extend', (req, res) => {
  if (!PASSCODE) return res.json({ gated: false });
  res.json({ exp: setSession(req, res) });
});

// ------------------------------------------------------------ fee parser API

const upload = multer({
  dest: os.tmpdir(),
  limits: { files: 80, fileSize: 25 * 1024 * 1024 }, // 80 PDFs, 25 MB each
});

const JOBS = new Map(); // token -> { file, dir, expires }
const TTL = 15 * 60 * 1000;

function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

// POST /api/fee-parser/process  (multipart: files[])
// (Access is enforced by the site-wide gate middleware above.)
app.post('/api/fee-parser/process', upload.array('files', 80), (req, res) => {
  const all = req.files || [];
  const pdfs = all.filter((f) => f.originalname.toLowerCase().endsWith('.pdf'));
  // Always clear whatever multer wrote to the OS temp dir; keep only the PDFs we move.
  const nonPdf = all.filter((f) => !f.originalname.toLowerCase().endsWith('.pdf'));
  for (const f of nonPdf) { try { fs.rmSync(f.path, { force: true }); } catch { /* ignore */ } }
  if (!pdfs.length) {
    return res.status(400).json({ error: 'No PDF files were received.' });
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'feereg-'));
  for (const f of pdfs) {
    const safe = f.originalname.replace(/[\\/:*?"<>|]/g, '_');
    try { fs.renameSync(f.path, path.join(work, safe)); }
    catch { fs.copyFileSync(f.path, path.join(work, safe)); fs.rmSync(f.path, { force: true }); }
  }
  const out = path.join(work, 'Fee_Register.xlsx');

  execFile(PYTHON, [PARSER, work, out, '--json'], { timeout: 120000 }, (err, stdout, stderr) => {
    if (err || !fs.existsSync(out)) {
      cleanup(work);
      return res.status(500).json({
        error: 'Could not process the files.',
        detail: String(stderr || err || '').slice(0, 400),
      });
    }
    const line = (stdout || '').split('\n').find((l) => l.startsWith('RECON_JSON:'));
    let payload = { version: '', rows: [] };
    if (line) { try { payload = JSON.parse(line.slice('RECON_JSON:'.length)); } catch { /* keep default */ } }

    const token = crypto.randomBytes(12).toString('hex');
    JOBS.set(token, { file: out, dir: work, expires: Date.now() + TTL });
    const rows = payload.rows || [];
    const ok = rows.filter((r) => r.status === 'OK').length;
    res.json({ token, rows, ok, total: rows.length, version: payload.version || '' });
  });
});

// GET /api/fee-parser/download/:token
app.get('/api/fee-parser/download/:token', (req, res) => {
  const job = JOBS.get(req.params.token);
  if (!job || !fs.existsSync(job.file)) {
    return res.status(404).send('This register has expired. Please process the files again.');
  }
  res.download(job.file, 'Fee_Register.xlsx');
});

// Sweep expired jobs.
setInterval(() => {
  const now = Date.now();
  for (const [t, j] of JOBS) if (j.expires < now) { cleanup(j.dir); JOBS.delete(t); }
}, 5 * 60 * 1000).unref();

// ------------------------------------------------------------ static site

const NO_CACHE = { 'Cache-Control': 'no-cache' };

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

app.get('/', (_req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'index.html')));
app.get('/session.js', (_req, res) => res.set(NO_CACHE).sendFile(path.join(__dirname, 'session.js')));

app.use('/fee-parser', express.static(path.join(__dirname, 'fee-parser'), {
  setHeaders: (res) => res.set(NO_CACHE),
}));

app.use('/gstr2b', express.static(path.join(__dirname, 'gstr2b'), {
  setHeaders: (res) => res.set(NO_CACHE),
}));

app.use('/audit', express.static(path.join(__dirname, 'audit'), {
  setHeaders: (res) => res.set(NO_CACHE),
}));

app.use('/tds26as', express.static(path.join(__dirname, 'tds26as'), {
  setHeaders: (res) => res.set(NO_CACHE),
}));

app.use('/finprep', express.static(path.join(__dirname, 'finprep'), {
  setHeaders: (res) => res.set(NO_CACHE),
}));

app.use('/debtor-creditor', express.static(path.join(__dirname, 'debtor-creditor'), {
  setHeaders: (res) => res.set(NO_CACHE),
}));

app.use('/itc-reco', express.static(path.join(__dirname, 'itc-reco'), {
  setHeaders: (res) => res.set(NO_CACHE),
}));

// ------------------------------------------------------ GSTR-1 summary tool
// The proven single-file tool runs UNMODIFIED as an internal child process on
// 127.0.0.1:8788; its page is hosted at /gstr1/ and its API reached through
// this gated proxy. Its state (party-name cache, API key) is written next to
// its script, which we place in GSTR1_DATA so a volume can persist it.

const GSTR1_DATA = process.env.KNAP_DATA
  ? path.join(process.env.KNAP_DATA, 'gstr1')
  : path.join(__dirname, 'gstr1-data');
const GSTR1_SRC = path.join(__dirname, 'gstr1-engine', 'gstr1-excel-summary.mjs');
const GSTR1_RUN = path.join(GSTR1_DATA, 'gstr1-excel-summary.mjs');

function startGstr1() {
  try {
    fs.mkdirSync(GSTR1_DATA, { recursive: true });
    fs.copyFileSync(GSTR1_SRC, GSTR1_RUN); // refresh engine each boot; cache files stay
    const child = spawn(process.execPath, [GSTR1_RUN], { stdio: 'inherit' });
    child.on('exit', () => setTimeout(startGstr1, 5000).unref());
  } catch (e) {
    console.error('gstr1 engine failed to start:', e.message);
    setTimeout(startGstr1, 15000).unref();
  }
}
startGstr1();

app.use('/gstr1', express.static(path.join(__dirname, 'gstr1'), {
  setHeaders: (res) => res.set(NO_CACHE),
}));

app.use('/gstr1-api', (req, res) => {
  const fwd = http.request(
    { host: '127.0.0.1', port: 8788, path: req.url, method: req.method, headers: { ...req.headers, host: '127.0.0.1:8788' } },
    (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); },
  );
  fwd.on('error', () => res.status(502).json({ error: 'The GSTR-1 engine is restarting — try again in a few seconds.' }));
  req.pipe(fwd);
});

// Tool files get replaced in-place on redeploys — never cache stale copies.
// .bat / .mjs must download, not render as text in the browser.
app.use('/downloads', express.static(path.join(__dirname, 'downloads'), {
  setHeaders: (res, filePath) => {
    res.set(NO_CACHE);
    if (/\.(bat|mjs)$/i.test(filePath)) res.set('Content-Disposition', 'attachment');
    if (/\.md$/i.test(filePath)) res.type('text/plain; charset=utf-8');
  },
}));

app.listen(PORT, () => {
  console.log(`KNAP Tools hub listening on :${PORT} — access key ${PASSCODE ? `ON (sessions ${SESSION_MS / 3600000}h)` : 'OFF (site is open)'}`);
});
