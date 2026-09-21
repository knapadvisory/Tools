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
import { buildCashFlow } from '../../finprep/core/cashflow.js';
import { toPaise, toRupees } from '../../finprep/core/money.js';
import { captionFor } from '../../finprep/core/schedule3.js';
import { presentationModel } from '../../finprep/core/notes.js';
import { sectionOf as sectionOfLine, linesFor, SECTIONS } from '../../finprep/core/schedule3.js';
import { assessAll, requiredFacts, RULE_DEFS } from '../../finprep/core/applicability.js';
import { observe } from '../../finprep/core/observations.js';
import { coverage } from './inputs.js';

/** "2026-03-31" -> "31 March 2026" */
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : ''));
  if (isNaN(d)) return String(iso);
  const M = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function priorLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d)) return '';
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return fmtDate(d.toISOString().slice(0, 10));
}
/**
 * Deep paise -> rupees. Key-aware: some numeric fields (note numbers, ids) are
 * NOT money and must not be scaled.
 */
const NON_MONEY = new Set(['number', 'note', 'id', 'key', 'lineId', 'caption', 'name', 'reason',
  'severity', 'status', 'requirement', 'evidence', 'section', 'title', 'period', 'method',
  'reconciled', 'drcr', 'group', 'primary', 'lineCaption', 'text', 'label']);
const rupDeep = (v, key) => {
  if (typeof v === 'number') return NON_MONEY.has(key) ? v : toRupees(v);
  if (Array.isArray(v)) return v.map((x) => rupDeep(x, key));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rupDeep(x, k)]));
  }
  return v;
};

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
  const payload = buildPayload(ctx, req.query.schedules ? JSON.parse(req.query.schedules) : {});
  delete payload._engine;
  res.json({ ok: true, ...payload });
});

/** One shared payload for the screen and the export, so they cannot disagree. */
function buildPayload(ctx, schedules = {}) {
  const r = build({ ledgers: ctx.ledgers, journals: ctx.journals,
    division: ctx.eng.division, overrides: ctx.overrides });
  const cf = buildCashFlow(r, { schedules });
  const model = presentationModel(r);
  const allChecks = r.checks.concat(cf.checks);
  const releasable = r.releasable && cf.reconciled;

  // trial balance rows, natural sign, with the head each ledger reached
  const trialBalance = r.ledgers.map((l) => {
    const cur = l.perPeriod.current, pri = l.perPeriod.prior;
    const natural = (v, id) => {
      const sec = sectionOfLine(id);
      return ['EQUITY', 'NCL', 'CL', 'INCOME', 'OCI'].includes(sec) ? -v : v;
    };
    return {
      ledger: l.name, group: l.group, primary: l.primary,
      drcr: cur.amount >= 0 ? 'Dr' : 'Cr',
      current: toRupees(natural(cur.amount, cur.lineId)),
      prior: toRupees(natural(pri.amount, pri.lineId)),
      lineId: cur.lineId, lineCaption: captionFor(cur.lineId, r.division),
      note: r.noteNumbers.get(cur.lineId) || null,
    };
  });

  return {
    meta: {
      entity: ctx.eng.client_name, cin: ctx.eng.cin || '', division: ctx.eng.division,
      currentLabel: fmtDate(ctx.eng.fy_end), priorLabel: priorLabel(ctx.eng.fy_end),
      status: releasable ? 'Draft' : 'Draft — blocked',
      snapshotId: ctx.snap.id, takenAt: ctx.snap.taken_at,
      scaleLabel: 'Amounts in ₹',
    },
    trialBalance,
    balanceSheet: rupDeep(model.balanceSheet),
    profitAndLoss: rupDeep(model.profitAndLoss),
    notes: rupDeep(model.notes),
    cashFlow: rupDeep({ ...cf, checks: undefined }),
    checks: allChecks.map((c) => ({ ...c, amount: c.amount != null ? toRupees(c.amount) : undefined })),
    disclosures: model.disclosures,
    releasable,
    status: releasable ? 'draft' : 'blocked',
    _engine: r,
  };
}

/* ---------- release control (spec §11) ---------------------------------- */
router.post('/engagements/:id/release', (req, res) => {
  const ctx = loadForBuild(req.params.id, req.body && req.body.snapshotId);
  if (ctx.error) return bad(res, ctx.error, 404);
  const r = build({ ledgers: ctx.ledgers, journals: ctx.journals, division: ctx.eng.division, overrides: ctx.overrides });
  const cf = buildCashFlow(r, { schedules: (req.body && req.body.schedules) || {} });
  const blocking = r.checks.concat(cf.checks).filter((c) => c.severity === 'CRITICAL');
  const wanted = (req.body && req.body.status) || 'reviewed';
  if (wanted === 'final' && blocking.length) {
    return bad(res, 'Cannot mark Final: ' + blocking.map((c) => c.message).join(' | '));
  }
  const id = uid('rep');
  db().prepare(`INSERT INTO report_versions (id,engagement_id,snapshot_id,kind,status,framework,created_at,created_by,payload)
                VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, ctx.eng.id, ctx.snap.id, 'pack', wanted, ctx.eng.division, now(), actor(req),
      JSON.stringify({ pl: r.pl, bs: r.bs, cashFlow: cf, checks: r.checks.concat(cf.checks) }));
  log(ctx.eng.id, actor(req), 'report.released', { id, status: wanted });
  res.json({ ok: true, reportVersionId: id, status: wanted });
});

/* ---------- the full chart of Schedule III heads ------------------------- */
/* The grouping dropdown must offer EVERY head, not only the ones already in
 * use — otherwise a head can never be assigned for the first time.           */
router.get('/lines', (req, res) => {
  const division = ['AS', 'INDAS'].includes(req.query.division) ? req.query.division : 'AS';
  const SECTION_TITLE = {
    EQUITY: 'Shareholders’ funds / Equity', NCL: 'Non-current liabilities', CL: 'Current liabilities',
    NCA: 'Non-current assets', CA: 'Current assets', INCOME: 'Income', EXPENSE: 'Expenses',
    TAX: 'Tax expense', OCI: 'Other comprehensive income', UNCLASSIFIED: 'Unassigned',
  };
  const lines = linesFor(division).map((l) => ({
    lineId: l.id, caption: captionFor(l.id, division), section: l.section,
    sectionTitle: SECTION_TITLE[l.section] || l.section,
    statement: (SECTIONS[l.section] || {}).statement || '',
  }));
  res.json({ ok: true, division, lines });
});

/* ---------- observations (for the preparer to verify) -------------------- */
router.get('/engagements/:id/observations', (req, res) => {
  const ctx = loadForBuild(req.params.id, req.query.snapshot);
  if (ctx.error) return bad(res, ctx.error, 404);
  const payload = buildPayload(ctx, {});
  const r = payload._engine;
  const cfRaw = buildCashFlow(r, {});

  const files = db().prepare('SELECT * FROM input_files WHERE engagement_id=?').all(req.params.id);
  const cov = coverage(files, ctx.eng);
  const stored = db().prepare('SELECT * FROM rules').all();
  let facts = {}; try { facts = JSON.parse(req.query.facts || '{}'); } catch { /* ignore */ }

  const result = observe(r, cfRaw, {
    inputs: cov,
    disclosures: payload.disclosures,
    applicability: assessAll(stored, facts, ctx.eng.fy_end),
  });
  res.json({ ok: true, ...result,
    meta: payload.meta,
    releasable: payload.releasable });
});

/* ---------- applicability (spec §12) ------------------------------------ */
router.get('/rules', (_req, res) => {
  const stored = db().prepare('SELECT * FROM rules').all();
  res.json({ ok: true, definitions: RULE_DEFS, stored, requiredFacts: requiredFacts() });
});

/** Record a verified rule. The reviewer's name and the authority are mandatory:
 *  an unattributed threshold is exactly what this engine refuses to rely on. */
router.post('/rules', (req, res) => {
  const { domain, ruleKey, authority, provision, url, effectiveFrom, effectiveTo, operands, notes, reviewedBy } = req.body || {};
  if (!domain || !ruleKey) return bad(res, 'domain and ruleKey are required');
  if (!RULE_DEFS.some((d) => d.domain === domain && d.key === ruleKey)) return bad(res, 'unknown rule');
  if (!authority || !provision || !effectiveFrom || !reviewedBy) {
    return bad(res, 'a verified rule needs authority, provision, effectiveFrom and reviewedBy');
  }
  db().prepare(`INSERT INTO rules (id,domain,rule_key,status,authority,provision,url,effective_from,effective_to,operands,retrieved_at,reviewed_by,reviewed_at,notes)
                VALUES (?,?,?,'verified',?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(domain, rule_key, COALESCE(effective_from,'')) DO UPDATE SET
                  status='verified', authority=excluded.authority, provision=excluded.provision,
                  url=excluded.url, effective_to=excluded.effective_to, operands=excluded.operands,
                  reviewed_by=excluded.reviewed_by, reviewed_at=excluded.reviewed_at, notes=excluded.notes`)
    .run(uid('rule'), domain, ruleKey, authority, provision, url || null, effectiveFrom, effectiveTo || null,
      JSON.stringify(operands || {}), now(), reviewedBy, now(), notes || null);
  log(null, actor(req), 'rule.verified', { domain, ruleKey, authority, provision, effectiveFrom });
  res.json({ ok: true });
});

router.get('/engagements/:id/applicability', (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  let facts = {};
  try { facts = JSON.parse(req.query.facts || '{}'); } catch { /* ignore */ }
  const stored = db().prepare('SELECT * FROM rules').all();
  const results = assessAll(stored, facts, eng.fy_end);
  res.json({ ok: true, asOf: eng.fy_end, results, requiredFacts: requiredFacts(),
    caveat: 'No conclusion is produced from an unverified rule. Record the authority, provision, effective dates and operands for each rule, have them reviewed, and re-run.' });
});

router.get('/engagements/:id/activity', (req, res) => {
  res.json({ ok: true, activity: db().prepare('SELECT * FROM activity WHERE engagement_id=? ORDER BY at DESC LIMIT 200').all(req.params.id) });
});

export default router;
