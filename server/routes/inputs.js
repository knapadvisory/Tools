/* ============================================================================
 * inputs.js — the documents an engagement is built on (spec §2)
 *
 * Originals are retained with their SHA-256, so the same file uploaded twice is
 * detected instead of being counted twice. Nothing here interprets a file yet;
 * it establishes WHAT evidence exists, what period it covers, and what is still
 * missing — which is what the observations and the release gate need.
 *
 * A missing month is never treated as a nil return. It is reported as a gap.
 * ==========================================================================*/
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { handle, uid, now, log } from '../db.js';

export const router = express.Router();
const db = () => handle();
const actor = (req) => (req.session && req.session.user) || req.get('x-actor') || 'unknown';
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, error: msg });

/** What we ask for, why, and what it unlocks. Drives the checklist in the UI. */
export const INPUT_KINDS = [
  { kind: 'prior_financials', label: 'Previous year signed financial statements',
    accepts: '.xlsx,.xls,.pdf', multiple: true, recommended: true,
    purpose: 'Comparative figures, opening balances, last year’s grouping and accounting policies.',
    unlocks: 'Comparative column, opening reserves, prior-year note structure.',
    withoutIt: 'Comparatives fall back to Tally’s prior column, which may not agree with the signed accounts.' },
  { kind: 'gstr2b', label: 'GSTR-2B',
    accepts: '.json,.xlsx,.xls,.csv,.zip', multiple: true, recommended: true, perPeriod: true,
    purpose: 'Input tax credit available, supplier-wise, per GSTIN per month.',
    unlocks: 'Purchase / input-tax reconciliation and the ITC observations.',
    withoutIt: 'Input tax balances cannot be corroborated against the portal.' },
  { kind: 'gstr1_3b', label: 'GSTR-1 and GSTR-3B summaries',
    accepts: '.json,.xlsx,.xls,.csv,.pdf', multiple: true, recommended: true, perPeriod: true,
    purpose: 'Turnover and output tax as returned, month by month.',
    unlocks: 'Books-to-returns turnover bridge and output-tax observations.',
    withoutIt: 'Revenue in the accounts cannot be reconciled to the returns.' },
  { kind: 'tds_conso', label: 'TDS consolidated statement (annual, all quarters)',
    accepts: '.xlsx,.xls,.csv,.txt,.zip', multiple: true, recommended: true,
    purpose: 'Deductions made, challans and deductee detail for the year.',
    unlocks: 'TDS payable reconciliation and deduction observations.',
    withoutIt: 'Statutory dues and TDS disallowance exposure cannot be tested.',
    caution: 'State whether this is tax DEDUCTED BY the company or deducted FROM its income — they reconcile differently. Deductor conso data is not a substitute for Form 26AS/AIS.' },
  { kind: 'other', label: 'Anything else you want considered',
    accepts: '*', multiple: true, recommended: false,
    purpose: 'Fixed-asset register, bank statements, loan agreements, shareholder register, related-party register, actuarial report, tax computation, litigation summary, Udyam certificates.',
    unlocks: 'Whatever the document evidences; the tool will list what it still needs.',
    withoutIt: '' },
];
const KIND_SET = new Set(INPUT_KINDS.map((k) => k.kind));

/* ---------- storage ------------------------------------------------------ */
const ROOT = process.env.KNAP_UPLOADS
  || (fs.existsSync('/data') ? '/data/uploads' : path.join(process.cwd(), 'data', 'uploads'));
const upload = multer({
  dest: path.join(ROOT, '_tmp'),
  limits: { files: 20, fileSize: 60 * 1024 * 1024 },
});
const sha256 = (file) => {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
};

router.get('/kinds', (_req, res) => res.json({ ok: true, kinds: INPUT_KINDS }));

router.post('/engagements/:id/inputs', upload.array('files', 20), (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  const kind = String(req.body.kind || 'other');
  if (!KIND_SET.has(kind)) return bad(res, 'unknown input kind');
  const files = req.files || [];
  if (!files.length) return bad(res, 'no file received');

  const dir = path.join(ROOT, eng.id, kind);
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const f of files) {
    const hash = sha256(f.path);
    const dup = db().prepare('SELECT id, filename, uploaded_at FROM input_files WHERE engagement_id=? AND sha256=?')
      .get(eng.id, hash);
    if (dup) {
      fs.rmSync(f.path, { force: true });
      out.push({ filename: f.originalname, status: 'duplicate',
        message: `Identical to "${dup.filename}" uploaded on ${String(dup.uploaded_at).slice(0, 10)} — not stored again.` });
      continue;
    }
    const safe = f.originalname.replace(/[\\/:*?"<>|]/g, '_');
    const dest = path.join(dir, hash.slice(0, 12) + '_' + safe);
    fs.renameSync(f.path, dest);
    const id = uid('inp');
    db().prepare(`INSERT INTO input_files
      (id,engagement_id,kind,label,filename,mime,bytes,sha256,stored_path,period_from,period_to,gstin,revised,uploaded_by,uploaded_at,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, eng.id, kind, req.body.label || null, safe, f.mimetype || null, f.size, hash, dest,
        req.body.periodFrom || null, req.body.periodTo || null, req.body.gstin || null,
        req.body.revised === 'true' ? 1 : 0, actor(req), now(), req.body.notes || null);
    out.push({ id, filename: safe, bytes: f.size, sha256: hash.slice(0, 12), status: 'received' });
  }
  log(eng.id, actor(req), 'inputs.uploaded', { kind, files: out.map((o) => o.filename) });
  res.json({ ok: true, files: out });
});

router.get('/engagements/:id/inputs', (req, res) => {
  const rows = db().prepare('SELECT id,kind,label,filename,bytes,sha256,period_from,period_to,gstin,revised,status,uploaded_at,notes FROM input_files WHERE engagement_id=? ORDER BY uploaded_at DESC')
    .all(req.params.id);
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  res.json({ ok: true, files: rows, kinds: INPUT_KINDS, coverage: coverage(rows, eng) });
});

router.delete('/engagements/:id/inputs/:fileId', (req, res) => {
  const row = db().prepare('SELECT * FROM input_files WHERE id=? AND engagement_id=?').get(req.params.fileId, req.params.id);
  if (!row) return bad(res, 'file not found', 404);
  try { fs.rmSync(row.stored_path, { force: true }); } catch { /* already gone */ }
  db().prepare('DELETE FROM input_files WHERE id=?').run(row.id);
  log(req.params.id, actor(req), 'inputs.removed', { filename: row.filename });
  res.json({ ok: true });
});

/* ---------- coverage ----------------------------------------------------- */
/** Months in the financial year, as YYYY-MM. */
function fyMonths(eng) {
  if (!eng || !eng.fy_start || !eng.fy_end) return [];
  const out = [];
  const d = new Date(eng.fy_start + 'T00:00:00Z');
  const end = new Date(eng.fy_end + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}
/**
 * Which months of the year each period-bearing input actually covers.
 * A month with no file is reported as MISSING — never as a nil return.
 */
export function coverage(rows, eng) {
  const months = fyMonths(eng);
  const out = {};
  for (const k of INPUT_KINDS.filter((x) => x.perPeriod)) {
    const files = rows.filter((r) => r.kind === k.kind && r.status !== 'superseded');
    const covered = new Set();
    for (const f of files) {
      if (!f.period_from) continue;
      const a = f.period_from.slice(0, 7), b = (f.period_to || f.period_from).slice(0, 7);
      for (const m of months) if (m >= a && m <= b) covered.add(m);
    }
    out[k.kind] = {
      label: k.label,
      months: months.map((m) => ({ month: m, present: covered.has(m) })),
      missing: months.filter((m) => !covered.has(m)),
      filesWithoutPeriod: files.filter((f) => !f.period_from).length,
    };
  }
  const present = {};
  for (const k of INPUT_KINDS) present[k.kind] = rows.filter((r) => r.kind === k.kind).length;
  return { months, perKind: out, counts: present };
}

/* ---------- information request register --------------------------------- */
router.get('/engagements/:id/requests', (req, res) => {
  res.json({ ok: true, requests: db().prepare('SELECT * FROM info_requests WHERE engagement_id=? ORDER BY created_at DESC').all(req.params.id) });
});
router.post('/engagements/:id/requests', express.json(), (req, res) => {
  const { item, purpose, affects, owner } = req.body || {};
  if (!item) return bad(res, 'item is required');
  const id = uid('req');
  db().prepare('INSERT INTO info_requests (id,engagement_id,item,purpose,affects,owner,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.params.id, item, purpose || null, affects || null, owner || null, now());
  res.json({ ok: true, id });
});
router.post('/engagements/:id/requests/:reqId/close', express.json(), (req, res) => {
  const st = (req.body && req.body.status) || 'received';
  db().prepare('UPDATE info_requests SET status=?, closed_at=? WHERE id=? AND engagement_id=?')
    .run(st, now(), req.params.reqId, req.params.id);
  res.json({ ok: true });
});

export default router;
