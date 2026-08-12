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
import { execFile } from 'child_process';
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

// Deterministic cookie token: survives container restarts, dies with the key.
const TOKEN = PASSCODE
  ? crypto.createHmac('sha256', PASSCODE).update('knap-tools-gate-v1').digest('hex')
  : '';

function cookieToken(req) {
  const m = /(?:^|;\s*)knap_key=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}

function hasAccess(req) {
  if (!PASSCODE) return true;
  if (cookieToken(req) === TOKEN) return true;
  return (req.get('x-passcode') || '') === PASSCODE; // curl / script access
}

app.post('/api/auth/login', express.json(), (req, res) => {
  if (PASSCODE && (req.body?.key || '') !== PASSCODE) {
    // Small damper against key guessing.
    return setTimeout(() => res.status(401).json({ error: 'Wrong key.' }), 700);
  }
  const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `knap_key=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=15552000${secure}`);
  res.status(204).end();
});

// Everything below this point requires the key (when one is set).
app.use((req, res, next) => {
  if (req.path === '/healthz' || hasAccess(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Passcode required.' });
  res.status(401).set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'gate.html'));
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

app.use('/fee-parser', express.static(path.join(__dirname, 'fee-parser'), {
  setHeaders: (res) => res.set(NO_CACHE),
}));

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
  console.log(`KNAP Tools hub listening on :${PORT}` + (PASSCODE ? ' (parser passcode ON)' : ''));
});
