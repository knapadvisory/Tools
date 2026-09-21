/* ============================================================================
 * finprep2.js — engagement API over the accounting core
 *
 * Vertical slice: Tally extract → sealed snapshot → approved mappings and
 * journals → adjusted TB → statements, with every integrity check surfaced and
 * release blocked while a CRITICAL check stands (spec §11 "Block a 'Final'
 * release if required evidence, essential reconciliation or reviewer approval
 * is missing").
 * ==========================================================================*/
import express from 'express';
import { handle, uid, now, log, sealSnapshot, isSealed } from '../db.js';
import { build, validateJournal } from '../../finprep/core/engine.js';
import { toPaise, toRupees } from '../../finprep/core/money.js';
import { captionFor } from '../../finprep/core/schedule3.js';

export const router = express.Router();
router.use(express.json({ limit: '32mb' }));

const db = () => handle();
const actor = (req) => (req.session && req.session.user) || req.get('x-actor') || 'unknown';
const bad = (res, msg, code = 400) => res.status(code).json({ ok: false, error: msg });

/* ---------- engagements ------------------------------------------------- */
router.post('/engagements', (req, res) => {
  const { clientName, cin, fyStart, fyEnd, division } = req.body || {};
  if (!clientName || !fyStart || !fyEnd) return bad(res, 'clientName, fyStart and fyEnd are required');
  if (division && !['AS', 'INDAS'].includes(division)) return bad(res, 'division must be AS or INDAS');
  const id = uid('eng');
  db().prepare(`INSERT INTO engagements (id,client_name,cin,fy_start,fy_end,division,created_at,created_by)
                VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, clientName, cin || null, fyStart, fyEnd, division || 'AS', now(), actor(req));
  log(id, actor(req), 'engagement.created', { clientName, fyStart, fyEnd });
  res.json({ ok: true, id });
});

router.get('/engagements', (_req, res) => {
  res.json({ ok: true, engagements: db().prepare('SELECT * FROM engagements ORDER BY created_at DESC').all() });
});

/* ---------- snapshots (immutable once sealed) --------------------------- */
router.post('/engagements/:id/snapshots', (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  if (eng.status === 'frozen') return bad(res, 'engagement is frozen');
  const { source = 'tally', method = 'live', connectorVersion, company, periodFrom, periodTo, ledgers } = req.body || {};
  if (!Array.isArray(ledgers) || !ledgers.length) return bad(res, 'ledgers[] is required');

  const sid = uid('snap');
  const d = db();
  d.exec('BEGIN');
  try {
    d.prepare(`INSERT INTO snapshots (id,engagement_id,source,method,connector_ver,company,period_from,period_to,taken_at)
               VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(sid, eng.id, source, method, connectorVersion || null, company || null, periodFrom || null, periodTo || null, now());

    const insL = d.prepare(`INSERT INTO ledgers (id,snapshot_id,tally_id,name,grp,primary_grp,group_path,gstin,is_revenue)
                            VALUES (?,?,?,?,?,?,?,?,?)`);
    const insB = d.prepare('INSERT INTO balances (snapshot_id,ledger_id,period,amount_paise) VALUES (?,?,?,?)');
    let ctrl = { current: 0, prior: 0 };
    for (const l of ledgers) {
      const lid = uid('led');
      insL.run(lid, sid, l.id || l.tallyId || null, l.name, l.group || null, l.primary || null,
        JSON.stringify(l.groupPath || []), l.gstin || null, l.isRevenue ? 1 : 0);
      for (const p of ['current', 'prior']) {
        const amt = toPaise(l[p] == null ? 0 : l[p]);
        insB.run(sid, lid, p, amt);
        ctrl[p] += amt;
      }
    }
    // spec §3: reconcile to control totals BEFORE marking the import complete
    const complete = ctrl.current === 0 && ctrl.prior === 0;
    d.prepare('UPDATE snapshots SET control_totals=?, complete=? WHERE id=?')
      .run(JSON.stringify(ctrl), complete ? 1 : 0, sid);
    d.exec('COMMIT');
    sealSnapshot(sid);
    log(eng.id, actor(req), 'snapshot.created', { sid, ledgers: ledgers.length, ctrl, complete });
    res.json({ ok: true, snapshotId: sid, ledgerCount: ledgers.length,
      controlTotals: { current: toRupees(ctrl.current), prior: toRupees(ctrl.prior) },
      balanced: complete,
      warning: complete ? null : 'The source trial balance does not sum to nil. The snapshot is stored but the books do not balance.' });
  } catch (e) { d.exec('ROLLBACK'); return bad(res, 'snapshot failed: ' + e.message, 500); }
});

router.get('/engagements/:id/snapshots', (req, res) => {
  res.json({ ok: true, snapshots: db().prepare('SELECT * FROM snapshots WHERE engagement_id=? ORDER BY taken_at DESC').all(req.params.id) });
});

/* ---------- mappings ---------------------------------------------------- */
router.post('/engagements/:id/mappings', (req, res) => {
  const { mappings } = req.body || {};
  if (!Array.isArray(mappings)) return bad(res, 'mappings[] is required');
  const d = db();
  const up = d.prepare(`INSERT INTO mappings (id,engagement_id,ledger_key,line_id,confidence,reason,approved,approved_by,approved_at,created_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?)
                        ON CONFLICT(engagement_id,ledger_key) DO UPDATE SET
                          line_id=excluded.line_id, approved=excluded.approved,
                          approved_by=excluded.approved_by, approved_at=excluded.approved_at,
                          reason=excluded.reason`);
  d.exec('BEGIN');
  try {
    for (const m of mappings) {
      up.run(uid('map'), req.params.id, m.ledgerKey, m.lineId, m.confidence || 'manual',
        m.reason || 'reviewer assignment', m.approved ? 1 : 0,
        m.approved ? actor(req) : null, m.approved ? now() : null, now());
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); return bad(res, e.message, 500); }
  log(req.params.id, actor(req), 'mappings.saved', { count: mappings.length });
  res.json({ ok: true, saved: mappings.length });
});

/* ---------- journals ---------------------------------------------------- */
router.post('/engagements/:id/journals', (req, res) => {
  const { narration, period = 'current', kind = 'reclass', entries, approve } = req.body || {};
  const check = validateJournal({ narration, entries });
  if (!check.ok) return bad(res, check.errors.join('; '));
  const jid = uid('jrn');
  const d = db();
  d.exec('BEGIN');
  try {
    d.prepare(`INSERT INTO journals (id,engagement_id,period,narration,kind,approved,created_by,created_at,approved_by,approved_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(jid, req.params.id, period, narration, kind, approve ? 1 : 0, actor(req), now(),
        approve ? actor(req) : null, approve ? now() : null);
    const ins = d.prepare('INSERT INTO journal_entries (id,journal_id,ledger_id,line_id,amount_paise) VALUES (?,?,?,?,?)');
    for (const e of entries) ins.run(uid('je'), jid, e.ledgerId || null, e.lineId || null, toPaise(e.amount));
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); return bad(res, e.message, 500); }
  log(req.params.id, actor(req), 'journal.created', { jid, narration, approve: !!approve });
  res.json({ ok: true, journalId: jid });
});

/* ---------- build statements ------------------------------------------- */
function loadForBuild(engagementId, snapshotId) {
  const d = db();
  const eng = d.prepare('SELECT * FROM engagements WHERE id=?').get(engagementId);
  if (!eng) return { error: 'engagement not found' };
  const snap = snapshotId
    ? d.prepare('SELECT * FROM snapshots WHERE id=? AND engagement_id=?').get(snapshotId, engagementId)
    : d.prepare('SELECT * FROM snapshots WHERE engagement_id=? ORDER BY taken_at DESC LIMIT 1').get(engagementId);
  if (!snap) return { error: 'no snapshot for this engagement' };

  const rows = d.prepare('SELECT * FROM ledgers WHERE snapshot_id=?').all(snap.id);
  const bals = d.prepare('SELECT * FROM balances WHERE snapshot_id=?').all(snap.id);
  const byLedger = new Map();
  for (const b of bals) {
    const m = byLedger.get(b.ledger_id) || {};
    m[b.period] = b.amount_paise;
    byLedger.set(b.ledger_id, m);
  }
  const ledgers = rows.map((r) => {
    const b = byLedger.get(r.id) || {};
    return {
      id: r.tally_id || r.id, name: r.name, group: r.grp, primary: r.primary_grp,
      groupPath: JSON.parse(r.group_path || '[]'), gstin: r.gstin, isRevenue: !!r.is_revenue,
      // balances already integer paise — hand them over as rupees for a single conversion point
      balances: { current: toRupees(b.current || 0), prior: toRupees(b.prior || 0) },
    };
  });

  const overrides = {};
  for (const m of d.prepare('SELECT * FROM mappings WHERE engagement_id=? AND approved=1').all(engagementId)) {
    overrides[m.ledger_key] = m.line_id;
  }
  const jrows = d.prepare('SELECT * FROM journals WHERE engagement_id=? AND superseded=0').all(engagementId);
  const journals = jrows.map((j) => ({
    id: j.id, approved: !!j.approved, period: j.period, narration: j.narration,
    entries: d.prepare('SELECT * FROM journal_entries WHERE journal_id=?').all(j.id)
      .map((e) => ({ ledgerId: e.ledger_id, lineId: e.line_id, amount: toRupees(e.amount_paise) })),
  }));
  return { eng, snap, ledgers, overrides, journals };
}

router.get('/engagements/:id/statements', (req, res) => {
  const ctx = loadForBuild(req.params.id, req.query.snapshot);
  if (ctx.error) return bad(res, ctx.error, 404);
  const r = build({ ledgers: ctx.ledgers, journals: ctx.journals,
    division: ctx.eng.division, overrides: ctx.overrides });

  const lines = [];
  for (const id of r.used) {
    lines.push({
      lineId: id, caption: captionFor(id, r.division), note: r.noteNumbers.get(id) || null,
      current: toRupees(r.presented(id, 'current')), prior: toRupees(r.presented(id, 'prior')),
      contributors: (r.trace.get(id) || []).map((t) => ({ ledger: t.name, period: t.period, amount: toRupees(t.amount), reason: t.reason })),
    });
  }
  const rup = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) =>
    [k, typeof v === 'number' ? toRupees(v) : (v && typeof v === 'object' ? rup(v) : v)]));

  res.json({
    ok: true,
    engagement: { id: ctx.eng.id, client: ctx.eng.client_name, division: ctx.eng.division },
    snapshot: { id: ctx.snap.id, takenAt: ctx.snap.taken_at, sealed: !!ctx.snap.sealed, method: ctx.snap.method },
    lines,
    profitAndLoss: rup(r.pl),
    balanceSheet: rup(r.bs),
    checks: r.checks.map((c) => ({ ...c, amount: c.amount != null ? toRupees(c.amount) : undefined })),
    disclosureGaps: r.disclosureGaps,
    releasable: r.releasable,
    status: r.releasable ? 'draft' : 'blocked',
  });
});

/* ---------- release control (spec §11) ---------------------------------- */
router.post('/engagements/:id/release', (req, res) => {
  const ctx = loadForBuild(req.params.id, req.body && req.body.snapshotId);
  if (ctx.error) return bad(res, ctx.error, 404);
  const r = build({ ledgers: ctx.ledgers, journals: ctx.journals, division: ctx.eng.division, overrides: ctx.overrides });
  const wanted = (req.body && req.body.status) || 'reviewed';
  if (wanted === 'final' && !r.releasable) {
    return bad(res, 'Cannot mark Final: ' + r.checks.filter((c) => c.severity === 'CRITICAL').map((c) => c.message).join(' | '));
  }
  const id = uid('rep');
  db().prepare(`INSERT INTO report_versions (id,engagement_id,snapshot_id,kind,status,framework,created_at,created_by,payload)
                VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, ctx.eng.id, ctx.snap.id, 'pack', wanted, ctx.eng.division, now(), actor(req),
      JSON.stringify({ pl: r.pl, bs: r.bs, checks: r.checks }));
  log(ctx.eng.id, actor(req), 'report.released', { id, status: wanted });
  res.json({ ok: true, reportVersionId: id, status: wanted });
});

router.get('/engagements/:id/activity', (req, res) => {
  res.json({ ok: true, activity: db().prepare('SELECT * FROM activity WHERE engagement_id=? ORDER BY at DESC LIMIT 200').all(req.params.id) });
});

export default router;
