// KNAP Tools hub server.
// Serves the static hub page + tool downloads, and hosts the Marketplace Fee
// Register parser: uploaded fee PDFs are handed to the tested Python parser
// (parser/amazon_invoice_parser.py) as a child process, and an .xlsx register
// plus a per-document reconciliation summary come back. Nothing leaves the
// server; temp files are swept after a short TTL.
//
// Ported from TeamHub's server/src/routes/feeParser.js so the tool runs on
// apps.knapadvisory.com directly, with no TeamHub login. Set TOOLS_PASSCODE
// to require a shared passcode for the parser API (off when unset).
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

// ------------------------------------------------------------ fee parser API

const upload = multer({
  dest: os.tmpdir(),
  limits: { files: 80, fileSize: 25 * 1024 * 1024 }, // 80 PDFs, 25 MB each
});

const JOBS = new Map(); // token -> { file, dir, expires }
const TTL = 15 * 60 * 1000;

function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }

// Optional shared passcode. The page stores it in localStorage and sends it on
// every API call; without TOOLS_PASSCODE set, the tool is open.
function gate(req, res, next) {
  if (!PASSCODE) return next();
  if ((req.get('x-passcode') || '') === PASSCODE) return next();
  res.status(401).json({ error: 'Passcode required.' });
}

// POST /api/fee-parser/process  (multipart: files[])
app.post('/api/fee-parser/process', gate, upload.array('files', 80), (req, res) => {
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
app.get('/api/fee-parser/download/:token', gate, (req, res) => {
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
