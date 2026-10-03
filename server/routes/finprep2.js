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
import { toPaise, toRupees, SCALES, permittedScales } from '../../finprep/core/money.js';
import { captionFor, CONSTITUTIONS, constitutionOf, divisionForConstitution, frameworkLabel } from '../../finprep/core/schedule3.js';
import { presentationModel, sectionTitles } from '../../finprep/core/notes.js';
import { sectionOf as sectionOfLine, linesFor, SECTIONS } from '../../finprep/core/schedule3.js';
import { OWNER_LEDGER_KINDS } from '../../finprep/core/owners.js';
import { assessAll, requiredFacts, RULE_DEFS } from '../../finprep/core/applicability.js';
import { observe } from '../../finprep/core/observations.js';
import { subGroupOf } from '../../finprep/core/subgroup.js';
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
  'reconciled', 'drcr', 'group', 'primary', 'lineCaption', 'text', 'label', 'ratio', 'ownerId',
  'kind', 'owner', 'basis', 'profitTo', 'shareBasis', 'ledger', 'depBasis', 'splitBasis', 'personalPct', 'footnote', 'extra', 'provided']);
let SCALE_DIV = 1;
const rupDeep = (v, key) => {
  if (typeof v === 'number') return NON_MONEY.has(key) ? v : (toRupees(v) / SCALE_DIV);
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
  const { clientName, cin, pan, fyStart, fyEnd } = req.body || {};
  let { division, constitution } = req.body || {};
  if (!clientName || !fyStart || !fyEnd) return bad(res, 'clientName, fyStart and fyEnd are required');
  constitution = constitution || 'company';
  if (!CONSTITUTIONS[constitution]) return bad(res, 'constitution must be one of ' + Object.keys(CONSTITUTIONS).join(', '));
  if (division && !['AS', 'INDAS', 'NCE'].includes(division)) return bad(res, 'division must be AS, INDAS or NCE');
  // The constitution decides the format. A company picks AS or Ind AS; every
  // other constitution reports in the ICAI non-corporate format.
  division = divisionForConstitution(constitution, division);
  const id = uid('eng');
  db().prepare(`INSERT INTO engagements (id,client_name,cin,pan,fy_start,fy_end,division,constitution,created_at,created_by)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, clientName, cin || null, pan || null, fyStart, fyEnd, division, constitution, now(), actor(req));
  log(id, actor(req), 'engagement.created', { clientName, fyStart, fyEnd, constitution, division });
  res.json({ ok: true, id, division, constitution });
});

/** Live engagements; `?archived=1` lists the archived ones instead. */
router.get('/engagements', (req, res) => {
  const archived = req.query.archived === '1';
  const rows = db().prepare(`SELECT * FROM engagements WHERE archived_at IS ${archived ? 'NOT ' : ''}NULL ORDER BY created_at DESC`).all();
  res.json({ ok: true, engagements: rows.map((e) => ({ ...e, constitutionLabel: constitutionOf(e.constitution).label })) });
});
/**
 * Archive: out of the picker, kept in full. Everything under the engagement —
 * snapshots, mappings, owners, journals, inputs, text — stays as it is, and
 * restoring brings it straight back. Nothing here deletes.
 */
router.post('/engagements/:id/archive', (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  const on = !(req.body && req.body.archived === false);
  db().prepare('UPDATE engagements SET archived_at=? WHERE id=?').run(on ? now() : null, eng.id);
  log(eng.id, actor(req), on ? 'engagement.archived' : 'engagement.restored', { clientName: eng.client_name, fyEnd: eng.fy_end });
  res.json({ ok: true, archived: on });
});

/* ---------- clients and the year before ---------------------------------- */
/** Engagements grouped by client, newest year first. */
router.get('/clients', (_req, res) => {
  const rows = db().prepare('SELECT * FROM engagements WHERE archived_at IS NULL ORDER BY lower(client_name), fy_end DESC').all();
  const byClient = new Map();
  for (const e of rows) {
    const k = e.client_name.trim().toLowerCase();
    if (!byClient.has(k)) byClient.set(k, { name: e.client_name, constitution: e.constitution, pan: e.pan || e.cin || '', engagements: [] });
    byClient.get(k).engagements.push({ id: e.id, fyStart: e.fy_start, fyEnd: e.fy_end, division: e.division, status: e.status });
  }
  res.json({ ok: true, clients: [...byClient.values()] });
});
/** The most recent earlier engagement of the same client — last year's file. */
function previousEngagement(eng) {
  return db().prepare(`SELECT * FROM engagements WHERE id<>? AND lower(trim(client_name))=lower(trim(?)) AND fy_end<? ORDER BY fy_end DESC LIMIT 1`)
    .get(eng.id, eng.client_name, eng.fy_end) || null;
}
router.get('/engagements/:id/carry-forward', (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  const prev = previousEngagement(eng);
  if (!prev) return res.json({ ok: true, candidate: null });
  const d = db();
  res.json({ ok: true, candidate: { id: prev.id, fyStart: prev.fy_start, fyEnd: prev.fy_end,
    mappings: d.prepare('SELECT count(*) n FROM mappings WHERE engagement_id=? AND approved=1').get(prev.id).n,
    subgroups: d.prepare('SELECT count(*) n FROM sub_groups WHERE engagement_id=?').get(prev.id).n,
    owners: d.prepare('SELECT count(*) n FROM owners WHERE engagement_id=?').get(prev.id).n } });
});
/**
 * Carry last year's decisions into this year: approved heads and note captions
 * for ledgers that are still in the books, and the owners if none are recorded
 * yet. Nothing already decided this year is overwritten.
 */
router.post('/engagements/:id/carry-forward', (req, res) => {
  const d = db();
  const eng = d.prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  const prev = (req.body && req.body.from) ? d.prepare('SELECT * FROM engagements WHERE id=?').get(req.body.from) : previousEngagement(eng);
  if (!prev) return bad(res, 'no earlier engagement of this client to carry from');
  const names = latestLedgerNames(eng.id);
  if (!names.size) return bad(res, 'import this year’s trial balance first — the heads are carried for ledgers that are in it');
  const have = new Set(d.prepare('SELECT ledger_key FROM mappings WHERE engagement_id=? AND approved=1').all(eng.id).map((x) => x.ledger_key));
  const haveSub = new Set(d.prepare('SELECT ledger_key FROM sub_groups WHERE engagement_id=?').all(eng.id).map((x) => x.ledger_key));
  const carried = { mappings: 0, subgroups: 0, owners: 0 }, skipped = { notInBooks: [], alreadySet: 0 };
  const label = `carried forward from FY ending ${prev.fy_end}`;
  d.exec('BEGIN');
  try {
    const up = d.prepare(`INSERT INTO mappings (id,engagement_id,ledger_key,line_id,confidence,reason,approved,approved_by,approved_at,created_at)
      VALUES (?,?,?,?,?,?,1,?,?,?) ON CONFLICT(engagement_id,ledger_key) DO UPDATE SET line_id=excluded.line_id, approved=1,
      approved_by=excluded.approved_by, approved_at=excluded.approved_at, reason=excluded.reason`);
    for (const m of d.prepare('SELECT * FROM mappings WHERE engagement_id=? AND approved=1').all(prev.id)) {
      if (!names.has(m.ledger_key)) { skipped.notInBooks.push(m.ledger_key); continue; }
      if (have.has(m.ledger_key)) { skipped.alreadySet += 1; continue; }
      up.run(uid('map'), eng.id, m.ledger_key, m.line_id, 'carried', label, actor(req), now(), now());
      carried.mappings += 1;
    }
    const sg = d.prepare('INSERT OR IGNORE INTO sub_groups (engagement_id,ledger_key,label,set_by,set_at) VALUES (?,?,?,?,?)');
    for (const s of d.prepare('SELECT * FROM sub_groups WHERE engagement_id=?').all(prev.id)) {
      if (!names.has(s.ledger_key) || haveSub.has(s.ledger_key)) continue;
      sg.run(eng.id, s.ledger_key, s.label, actor(req), now());
      carried.subgroups += 1;
    }
    if (!d.prepare('SELECT count(*) n FROM owners WHERE engagement_id=?').get(eng.id).n) {
      const ins = d.prepare('INSERT INTO owners (id,engagement_id,name,role,ratio,pan,ledgers,split_paise,sort) VALUES (?,?,?,?,?,?,?,NULL,?)');
      for (const o of d.prepare('SELECT * FROM owners WHERE engagement_id=? ORDER BY sort').all(prev.id)) {
        // ledgers that no longer exist are dropped from the owner; the split is never carried (it was last year's)
        let ledgers = {}; try { ledgers = JSON.parse(o.ledgers || '{}'); } catch { /* */ }
        for (const k of Object.keys(ledgers)) ledgers[k] = (ledgers[k] || []).filter((n) => names.has(n));
        ins.run(uid('own'), eng.id, o.name, o.role, o.ratio, o.pan, JSON.stringify(ledgers), o.sort);
        carried.owners += 1;
      }
      if (carried.owners) d.prepare('UPDATE engagements SET profit_to=? WHERE id=?').run(prev.profit_to || 'capital', eng.id);
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); return bad(res, e.message, 500); }
  log(eng.id, actor(req), 'carry.forward', { from: prev.id, carried, skipped: { notInBooks: skipped.notInBooks.length, alreadySet: skipped.alreadySet } });
  res.json({ ok: true, from: { id: prev.id, fyEnd: prev.fy_end }, carried, skipped });
});

router.get('/constitutions', (_req, res) => {
  res.json({ ok: true, constitutions: Object.entries(CONSTITUTIONS).map(([key, c]) =>
    ({ key, label: c.label, isCorporate: c.isCorporate, owners: c.owners, ownerRole: c.ownerRole,
       division: divisionForConstitution(key), framework: frameworkLabel(divisionForConstitution(key)) })) });
});

/* ---------- owners: proprietor, partners, karta ------------------------- */
function loadOwners(engagementId) {
  return db().prepare('SELECT * FROM owners WHERE engagement_id=? ORDER BY sort, rowid').all(engagementId).map((o) => ({
    id: o.id, name: o.name, role: o.role || '', ratio: o.ratio, pan: o.pan || '',
    ledgers: (() => { try { return JSON.parse(o.ledgers || '{}'); } catch { return {}; } })(),
    split: o.split_paise == null ? null : toRupees(o.split_paise),
  }));
}
router.get('/engagements/:id/owners', (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  res.json({ ok: true, owners: loadOwners(eng.id), profitTo: eng.profit_to || 'capital',
    constitution: eng.constitution, kinds: OWNER_LEDGER_KINDS });
});
/** Replace the owners as a set — ratios, PAN, ledgers by kind, manual split. */
router.put('/engagements/:id/owners', (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  const { owners, profitTo } = req.body || {};
  if (!Array.isArray(owners)) return bad(res, 'owners[] is required');
  if (profitTo && !['capital', 'current'].includes(profitTo)) return bad(res, 'profitTo must be capital or current');
  const d = db();
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM owners WHERE engagement_id=?').run(eng.id);
    const ins = d.prepare('INSERT INTO owners (id,engagement_id,name,role,ratio,pan,ledgers,split_paise,sort) VALUES (?,?,?,?,?,?,?,?,?)');
    owners.forEach((o, i) => {
      if (!o || !String(o.name || '').trim()) return;
      const ledgers = {};
      for (const k of OWNER_LEDGER_KINDS) ledgers[k] = Array.isArray(o.ledgers && o.ledgers[k]) ? o.ledgers[k].map(String) : [];
      const ratio = Number(o.ratio);
      ins.run(o.id && /^own_/.test(o.id) ? o.id : uid('own'), eng.id, String(o.name).trim(), o.role || null,
        Number.isFinite(ratio) && ratio > 0 ? ratio : 0, o.pan || null, JSON.stringify(ledgers),
        (o.split == null || o.split === '') ? null : toPaise(o.split), i);
    });
    if (profitTo) d.prepare('UPDATE engagements SET profit_to=? WHERE id=?').run(profitTo, eng.id);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); return bad(res, e.message, 500); }
  log(eng.id, actor(req), 'owners.saved', { count: owners.length, profitTo });
  res.json({ ok: true, owners: loadOwners(eng.id), profitTo: profitTo || eng.profit_to });
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

    const insL = d.prepare(`INSERT INTO ledgers (id,snapshot_id,tally_id,name,grp,primary_grp,group_path,gstin,is_revenue,mov_dr_paise,mov_cr_paise)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const insB = d.prepare('INSERT INTO balances (snapshot_id,ledger_id,period,amount_paise) VALUES (?,?,?,?)');
    let ctrl = { current: 0, prior: 0 };
    for (const l of ledgers) {
      const lid = uid('led');
      // gross movements for the period, when the source supplied them
      const hasMov = l.drTotal != null || l.crTotal != null;
      insL.run(lid, sid, l.id || l.tallyId || null, l.name, l.group || null, l.primary || null,
        JSON.stringify(l.groupPath || []), l.gstin || null, l.isRevenue ? 1 : 0,
        hasMov ? Math.abs(toPaise(l.drTotal || 0)) : null, hasMov ? Math.abs(toPaise(l.crTotal || 0)) : null);
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

/* ---------- what changed between two imports ----------------------------- */
/**
 * Ledger by ledger: the balance in the previous snapshot, the balance now, the
 * difference — for both periods — plus ledgers that appeared or disappeared.
 * Default: the latest snapshot against the one before it.
 */
router.get('/engagements/:id/variance', (req, res) => {
  const d = db();
  const snaps = d.prepare('SELECT * FROM snapshots WHERE engagement_id=? ORDER BY taken_at DESC, rowid DESC').all(req.params.id);
  if (snaps.length < 2 && !(req.query.to && req.query.from)) {
    return res.json({ ok: true, rows: [], summary: null, note: snaps.length ? 'Only one import so far — nothing to compare it with.' : 'No import yet.' });
  }
  const to = req.query.to ? snaps.find((s) => s.id === req.query.to) : snaps[0];
  const from = req.query.from ? snaps.find((s) => s.id === req.query.from) : snaps[1];
  if (!to || !from) return bad(res, 'snapshot not found', 404);
  const load = (sid) => {
    const out = new Map();
    for (const l of d.prepare('SELECT * FROM ledgers WHERE snapshot_id=?').all(sid)) out.set(l.name, { ...l, current: 0, prior: 0 });
    for (const b of d.prepare('SELECT l.name, b.period, b.amount_paise FROM balances b JOIN ledgers l ON l.id=b.ledger_id WHERE b.snapshot_id=?').all(sid)) {
      const l = out.get(b.name); if (l) l[b.period] = b.amount_paise;
    }
    return out;
  };
  const A = load(from.id), B = load(to.id);
  const names = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x.localeCompare(y));
  const rows = [], summary = { added: 0, dropped: 0, changed: 0, same: 0, netCurrent: 0, netPrior: 0, grossCurrent: 0 };
  for (const n of names) {
    const a = A.get(n), b = B.get(n);
    const status = !a ? 'added' : !b ? 'dropped' : (a.current !== b.current || a.prior !== b.prior) ? 'changed' : 'same';
    summary[status] += 1;
    const dCur = (b ? b.current : 0) - (a ? a.current : 0), dPri = (b ? b.prior : 0) - (a ? a.prior : 0);
    summary.netCurrent += dCur; summary.netPrior += dPri; summary.grossCurrent += Math.abs(dCur);
    if (status === 'same') continue;
    rows.push({ ledger: n, group: (b || a).grp, status,
      wasCurrent: a ? toRupees(a.current) : null, nowCurrent: b ? toRupees(b.current) : null, deltaCurrent: toRupees(dCur),
      wasPrior: a ? toRupees(a.prior) : null, nowPrior: b ? toRupees(b.prior) : null, deltaPrior: toRupees(dPri),
      groupChanged: !!(a && b && (a.grp || '') !== (b.grp || '')) });
  }
  for (const k of ['netCurrent', 'netPrior', 'grossCurrent']) summary[k] = toRupees(summary[k]);
  res.json({ ok: true, from: { id: from.id, takenAt: from.taken_at, source: from.source }, to: { id: to.id, takenAt: to.taken_at, source: to.source },
    rows, summary, note: null });
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

/* ---------- journals (adjustment entries) -------------------------------- */
/**
 * An entry targets a LEDGER by name (`ledgerKey`, which survives a re-import)
 * or a statement HEAD (`lineId`). Amounts are Dr-positive rupees and must sum
 * to nil. The same ledger may appear on several lines of one entry.
 */
function latestLedgerNames(engagementId) {
  const d = db();
  const snap = d.prepare('SELECT id FROM snapshots WHERE engagement_id=? ORDER BY taken_at DESC, rowid DESC LIMIT 1').get(engagementId);
  if (!snap) return new Map();
  return new Map(d.prepare('SELECT id, name FROM ledgers WHERE snapshot_id=?').all(snap.id).map((l) => [l.name, l.id]));
}
function insertJournal(d, engagementId, body, who) {
  const { narration, period = 'current', kind = 'reclass', entries, approve } = body || {};
  if (!['current', 'prior'].includes(period)) return { error: 'period must be current or prior' };
  if (!['reclass', 'provision', 'correction', 'closing', 'other'].includes(kind)) return { error: 'unknown kind' };
  const names = latestLedgerNames(engagementId);
  const idToName = new Map([...names].map(([n, id]) => [id, n]));
  const resolved = (entries || []).map((e) => {
    const key = e.ledgerKey || (e.ledgerId ? idToName.get(e.ledgerId) : null) || null;
    return { ledgerKey: key, ledgerId: key ? (names.get(key) || null) : null, lineId: e.lineId || null, amount: e.amount };
  });
  const missing = resolved.filter((e) => e.ledgerKey && !e.ledgerId).map((e) => e.ledgerKey);
  if (missing.length) return { error: `not in the trial balance: ${missing.join(', ')}` };
  const check = validateJournal({ narration, entries: resolved });
  if (!check.ok) return { error: check.errors.join('; ') };
  const jid = uid('jrn');
  d.prepare(`INSERT INTO journals (id,engagement_id,period,narration,kind,approved,created_by,created_at,approved_by,approved_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(jid, engagementId, period, narration, kind, approve ? 1 : 0, who, now(), approve ? who : null, approve ? now() : null);
  const ins = d.prepare('INSERT INTO journal_entries (id,journal_id,ledger_id,ledger_key,line_id,amount_paise) VALUES (?,?,?,?,?,?)');
  for (const e of resolved) ins.run(uid('je'), jid, e.ledgerId, e.ledgerKey, e.lineId, toPaise(e.amount));
  return { jid };
}
router.post('/engagements/:id/journals', (req, res) => {
  const d = db();
  d.exec('BEGIN');
  let out;
  try { out = insertJournal(d, req.params.id, req.body, actor(req)); if (out.error) { d.exec('ROLLBACK'); return bad(res, out.error); } d.exec('COMMIT'); }
  catch (e) { d.exec('ROLLBACK'); return bad(res, e.message, 500); }
  log(req.params.id, actor(req), 'journal.created', { jid: out.jid, narration: req.body.narration, approve: !!req.body.approve });
  res.json({ ok: true, journalId: out.jid });
});
/** Approve, or take approval back. */
router.post('/engagements/:id/journals/:jid/approve', (req, res) => {
  const j = db().prepare('SELECT * FROM journals WHERE id=? AND engagement_id=? AND superseded=0').get(req.params.jid, req.params.id);
  if (!j) return bad(res, 'journal not found', 404);
  const on = !(req.body && req.body.approved === false);
  db().prepare('UPDATE journals SET approved=?, approved_by=?, approved_at=? WHERE id=?').run(on ? 1 : 0, on ? actor(req) : null, on ? now() : null, j.id);
  log(req.params.id, actor(req), on ? 'journal.approved' : 'journal.unapproved', { jid: j.id });
  res.json({ ok: true, approved: on });
});
/** Withdraw: the entry is kept for the record but no longer applied. */
router.delete('/engagements/:id/journals/:jid', (req, res) => {
  const j = db().prepare('SELECT * FROM journals WHERE id=? AND engagement_id=? AND superseded=0').get(req.params.jid, req.params.id);
  if (!j) return bad(res, 'journal not found', 404);
  db().prepare('UPDATE journals SET superseded=1 WHERE id=?').run(j.id);
  log(req.params.id, actor(req), 'journal.withdrawn', { jid: j.id });
  res.json({ ok: true });
});
/** Edit = supersede the old entry and record the new one, so the trail stays. */
router.put('/engagements/:id/journals/:jid', (req, res) => {
  const d = db();
  const j = d.prepare('SELECT * FROM journals WHERE id=? AND engagement_id=? AND superseded=0').get(req.params.jid, req.params.id);
  if (!j) return bad(res, 'journal not found', 404);
  d.exec('BEGIN');
  let out;
  try {
    out = insertJournal(d, req.params.id, req.body, actor(req));
    if (out.error) { d.exec('ROLLBACK'); return bad(res, out.error); }
    d.prepare('UPDATE journals SET superseded=1 WHERE id=?').run(j.id);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); return bad(res, e.message, 500); }
  log(req.params.id, actor(req), 'journal.edited', { from: j.id, to: out.jid });
  res.json({ ok: true, journalId: out.jid, supersedes: j.id });
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
      mov: (r.mov_dr_paise != null || r.mov_cr_paise != null)
        ? { dr: toRupees(r.mov_dr_paise || 0), cr: toRupees(r.mov_cr_paise || 0) } : null,
    };
  });

  const overrides = {};
  for (const m of d.prepare('SELECT * FROM mappings WHERE engagement_id=? AND approved=1').all(engagementId)) {
    overrides[m.ledger_key] = m.line_id;
  }
  // Comparatives confirmed from last year's signed statements, if any. These
  // REPLACE the Tally prior column head by head.
  const priorRows = d.prepare('SELECT * FROM prior_figures WHERE engagement_id=?').all(engagementId);
  const priorOverrides = priorRows.length
    ? Object.fromEntries(priorRows.map((x) => [x.line_id, toRupees(x.amount_paise)]))
    : null;

  const subOverrides = Object.fromEntries(
    d.prepare('SELECT ledger_key, label FROM sub_groups WHERE engagement_id=?').all(engagementId)
      .map((x) => [x.ledger_key, x.label]));

  // Entries name their ledger; the id is looked up in THIS snapshot, so an
  // adjustment recorded before a re-import still lands on the right ledger.
  const idByName = new Map(rows.map((r) => [r.name, r.tally_id || r.id]));
  const jrows = d.prepare('SELECT * FROM journals WHERE engagement_id=? AND superseded=0').all(engagementId);
  const journals = jrows.map((j) => ({
    id: j.id, approved: !!j.approved, period: j.period, narration: j.narration, kind: j.kind,
    createdAt: j.created_at, approvedBy: j.approved_by,
    entries: d.prepare('SELECT * FROM journal_entries WHERE journal_id=?').all(j.id)
      .map((e) => ({ id: e.id, ledgerKey: e.ledger_key, lineId: e.line_id, amount: toRupees(e.amount_paise),
        ledgerId: e.ledger_key ? (idByName.get(e.ledger_key) || ('missing:' + e.ledger_key)) : (e.ledger_id || null) })),
  }));
  const owners = loadOwners(engagementId);
  const inputs = loadInputs(engagementId);
  return { eng, snap, ledgers, overrides, journals, priorOverrides, subOverrides, owners, inputs };
}

/* ---------- what the preparer types: policies, footnotes, MSMED, PPE, sign-off ---- */
function loadInputs(engagementId) {
  return Object.fromEntries(db().prepare('SELECT key, value FROM note_inputs WHERE engagement_id=?').all(engagementId).map((x) => [x.key, x.value]));
}
router.get('/engagements/:id/text', (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  res.json({ ok: true, inputs: loadInputs(eng.id) });
});
/** Upsert the given keys; a null or empty value removes the key. */
router.put('/engagements/:id/text', (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  const inputs = (req.body && req.body.inputs) || {};
  if (typeof inputs !== 'object') return bad(res, 'inputs{} is required');
  const d = db();
  const up = d.prepare(`INSERT INTO note_inputs (engagement_id,key,value,updated_by,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(engagement_id,key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`);
  const del = d.prepare('DELETE FROM note_inputs WHERE engagement_id=? AND key=?');
  d.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(inputs)) {
      if (!/^[a-z]+(:[^:]{1,200}){0,2}$/i.test(k)) continue;
      if (v == null || String(v).trim() === '') del.run(eng.id, k); else up.run(eng.id, k, String(v).slice(0, 20000), actor(req), now());
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); return bad(res, e.message, 500); }
  log(eng.id, actor(req), 'text.saved', { keys: Object.keys(inputs).length });
  res.json({ ok: true, inputs: loadInputs(eng.id) });
});
/** A starting text for the accounting policies, by constitution and framework. */
router.get('/engagements/:id/policies/default', async (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  const { defaultPolicies } = await import('../../finprep/core/policies.js');
  res.json({ ok: true, text: defaultPolicies({ constitution: eng.constitution, division: eng.division, entity: eng.client_name }) });
});

/** Everything build() needs from a loaded context — one place, so the screen,
 *  the export and the release all compute the same statements. */
function buildArgs(ctx) {
  return { ledgers: ctx.ledgers, journals: ctx.journals, division: ctx.eng.division,
    constitution: ctx.eng.constitution || 'company', owners: ctx.owners || [], profitTo: ctx.eng.profit_to || 'capital',
    overrides: ctx.overrides, priorOverrides: ctx.priorOverrides };
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
  const scaleKey = SCALES[ctx.eng.scale] ? ctx.eng.scale : 'full';
  SCALE_DIV = SCALES[scaleKey].div;
  const r = build(buildArgs(ctx));
  const cf = buildCashFlow(r, { schedules });
  const inputs = ctx.inputs || {};
  const model = presentationModel(r, { subOverrides: ctx.subOverrides || {}, inputs });
  const allChecks = r.checks.concat(cf.checks, model.scheduleChecks || []);
  const releasable = r.releasable && cf.reconciled;
  const sign = (k) => inputs[`sign:${k}`] || '';

  // trial balance rows, natural sign, with the head each ledger reached
  // The caption each ledger ends up on, looked up once rather than per row.
  const lineOfLedger = new Map();   // ledger name -> {noteLine, source}
  for (const n of model.notes) {
    for (const sl of n.subLines) {
      for (const mm of (sl.members || [])) lineOfLedger.set(mm.name, { noteLine: sl.name, source: sl.source });
    }
  }

  const trialBalance = r.ledgers.map((l) => {
    const cur = l.perPeriod.current, pri = l.perPeriod.prior;
    const natural = (v, id) => {
      const sec = sectionOfLine(id);
      return ['EQUITY', 'NCL', 'CL', 'INCOME', 'OCI'].includes(sec) ? -v : v;
    };
    return {
      ledger: l.name, group: l.group, primary: l.primary,
      drcr: cur.amount >= 0 ? 'Dr' : 'Cr',
      current: toRupees(natural(cur.amount, cur.lineId)) / SCALE_DIV,
      prior: toRupees(natural(pri.amount, pri.lineId)) / SCALE_DIV,
      lineId: cur.lineId, lineCaption: captionFor(cur.lineId, r.division, r.constitution),
      note: r.noteNumbers.get(cur.lineId) || null,
      movDr: l.mov ? toRupees(l.mov.dr) / SCALE_DIV : null,
      movCr: l.mov ? toRupees(l.mov.cr) / SCALE_DIV : null,
      // Grouping ▸ Sub-grouping ▸ Ledger, as Tally holds it
      tallySubGroup: subGroupOf(l),
      subGroup: (lineOfLedger.get(l.name) || {}).noteLine || null,
      subGroupSource: (lineOfLedger.get(l.name) || {}).source || null,
    };
  });

  const con = constitutionOf(ctx.eng.constitution);
  return {
    meta: {
      entity: ctx.eng.client_name, cin: ctx.eng.cin || '', pan: ctx.eng.pan || '', division: r.division,
      constitution: ctx.eng.constitution || 'company', constitutionLabel: con.label,
      ownersLabel: con.owners, ownerRole: con.ownerRole, framework: frameworkLabel(r.division),
      owners: (r.ownersUsed || []).map((o) => ({ id: o.id, name: o.name, role: o.role || con.ownerRole, pan: o.pan || '', ratio: o.ratio })),
      profitTo: ctx.eng.profit_to || 'capital',
      currentLabel: fmtDate(ctx.eng.fy_end), priorLabel: priorLabel(ctx.eng.fy_end),
      fyStart: ctx.eng.fy_start, fyEnd: ctx.eng.fy_end,
      status: releasable ? 'Draft' : 'Draft — blocked',
      snapshotId: ctx.snap.id, takenAt: ctx.snap.taken_at,
      scale: scaleKey,
      scaleLabel: SCALES[scaleKey].label,
      permittedScales: permittedScales(r.value('revenue_operations', 'current') * -1 || 0),
      sectionTitles: sectionTitles(r.division),
      auditor: { firm: sign('firm'), frn: sign('frn'), partner: sign('partner'), membership: sign('membership') },
      place: sign('place'), signedOn: sign('date'),
    },
    text: {
      policies: inputs.policies || '',
      footnotes: Object.fromEntries(Object.entries(inputs).filter(([k]) => k.startsWith('footnote:')).map(([k, v]) => [k.slice(9), v])),
      msme: Object.fromEntries(Object.entries(inputs).filter(([k]) => k.startsWith('msme:')).map(([k, v]) => [k.slice(5), v])),
      ppe: Object.fromEntries(Object.entries(inputs).filter(([k]) => k.startsWith('ppe:')).map(([k, v]) => [k.slice(4), v])),
      sign: { firm: sign('firm'), frn: sign('frn'), partner: sign('partner'), membership: sign('membership'), place: sign('place'), date: sign('date') },
    },
    policies: inputs.policies || '',
    ppe: model.ppe ? rupDeep(model.ppe) : null,
    trialBalance,
    balanceSheet: rupDeep(model.balanceSheet),
    profitAndLoss: rupDeep(model.profitAndLoss),
    notes: rupDeep(model.notes),
    ownersAccounts: model.ownersAccounts ? rupDeep(model.ownersAccounts) : null,
    journals: ctx.journals.map((j) => ({ ...j, entries: j.entries.map((e) => ({ ...e,
      ledgerName: e.ledgerKey || (ctx.ledgers.find((l) => l.id === e.ledgerId) || {}).name || null,
      lineCaption: e.lineId ? captionFor(e.lineId, r.division, r.constitution) : null,
      missing: typeof e.ledgerId === 'string' && e.ledgerId.startsWith('missing:') })) })),
    cashFlow: rupDeep({ ...cf, checks: undefined }),
    checks: allChecks.map((c) => ({ ...c, amount: c.amount != null ? toRupees(c.amount) / SCALE_DIV : undefined })),
    disclosures: model.disclosures,
    disclosureSources: model.disclosureSources,
    releasable,
    status: releasable ? 'draft' : 'blocked',
    _engine: r,
  };
}

/* ---------- release control (spec §11) ---------------------------------- */
router.post('/engagements/:id/release', (req, res) => {
  const ctx = loadForBuild(req.params.id, req.body && req.body.snapshotId);
  if (ctx.error) return bad(res, ctx.error, 404);
  // The SAME build as the one that was reviewed and exported. Leaving the
  // imported comparatives out here would seal a version whose prior column
  // differs from the one on screen.
  const r = build(buildArgs(ctx));
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

/* ---------- note sub-groups --------------------------------------------- */
/* Ledgers of the same nature share one note line. The tool proposes a caption;
 * this records what the preparer decided, which always wins.               */
router.post('/engagements/:id/subgroups', (req, res) => {
  const { subgroups } = req.body || {};
  if (!Array.isArray(subgroups)) return bad(res, 'subgroups[] is required');
  const d = db();
  const up = d.prepare(`INSERT INTO sub_groups (engagement_id,ledger_key,label,set_by,set_at)
    VALUES (?,?,?,?,?) ON CONFLICT(engagement_id,ledger_key) DO UPDATE SET
    label=excluded.label, set_by=excluded.set_by, set_at=excluded.set_at`);
  const del = d.prepare('DELETE FROM sub_groups WHERE engagement_id=? AND ledger_key=?');
  d.exec('BEGIN');
  try {
    for (const g of subgroups) {
      if (!g || !g.ledgerKey) continue;
      if (g.label && String(g.label).trim()) up.run(req.params.id, g.ledgerKey, String(g.label).trim(), actor(req), now());
      else del.run(req.params.id, g.ledgerKey);   // blank = go back to the proposal
    }
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); return bad(res, e.message, 500); }
  log(req.params.id, actor(req), 'subgroups.saved', { count: subgroups.length });
  res.json({ ok: true, saved: subgroups.length });
});

/* ---------- prior-year import, once the preparer has confirmed it -------- */
router.post('/engagements/:id/prior-import', (req, res) => {
  const eng = db().prepare('SELECT * FROM engagements WHERE id=?').get(req.params.id);
  if (!eng) return bad(res, 'engagement not found', 404);
  const { figures = [], particulars = [], shareholders = [], replace = true } = req.body || {};
  const d = db();
  d.exec('BEGIN');
  try {
    // replace: true  — this import supersedes everything on file
    // replace: 'figures' — the comparatives editor rewrites the figures only,
    //                      leaving particulars and shareholders alone
    if (replace) {
      d.prepare('DELETE FROM prior_figures WHERE engagement_id=?').run(eng.id);
      if (replace !== 'figures') d.prepare('DELETE FROM shareholders WHERE engagement_id=?').run(eng.id);
    }
    const pf = d.prepare(`INSERT INTO prior_figures (engagement_id,line_id,amount_paise,source,caption,confirmed_by,confirmed_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(engagement_id,line_id) DO UPDATE SET
      amount_paise=excluded.amount_paise, source=excluded.source, caption=excluded.caption,
      confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at`);
    for (const f of figures) {
      if (!f || !f.lineId) continue;
      pf.run(eng.id, f.lineId, toPaise(f.amount), f.source || null, f.caption || null, actor(req), now());
    }
    const ep = d.prepare(`INSERT INTO entity_particulars (engagement_id,field_key,label,value,source,confidence,status,updated_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(engagement_id,field_key) DO UPDATE SET
      value=excluded.value, source=excluded.source, confidence=excluded.confidence,
      status=excluded.status, updated_at=excluded.updated_at`);
    for (const f of particulars) {
      if (!f || !f.key) continue;
      ep.run(eng.id, f.key, f.label || null, f.value == null ? null : String(f.value),
        f.source || null, f.confidence || null, f.status || 'confirmed', now());
    }
    const sh = d.prepare('INSERT INTO shareholders (id,engagement_id,name,shares,percent,source) VALUES (?,?,?,?,?,?)');
    for (const x of shareholders) { if (x && x.name) sh.run(uid('sh'), eng.id, x.name, x.shares ?? null, x.percent ?? null, x.source || null); }

    // keep the engagement header in step with the confirmed particulars
    const get = (k) => (particulars.find((f) => f.key === k) || {}).value;
    if (get('legalName')) d.prepare('UPDATE engagements SET client_name=? WHERE id=?').run(get('legalName'), eng.id);
    if (get('cin')) d.prepare('UPDATE engagements SET cin=? WHERE id=?').run(get('cin'), eng.id);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); return bad(res, e.message, 500); }
  log(eng.id, actor(req), 'prior.imported', { figures: figures.length, particulars: particulars.length, shareholders: shareholders.length });
  res.json({ ok: true, figures: figures.length, particulars: particulars.length, shareholders: shareholders.length });
});

router.get('/engagements/:id/prior-import', (req, res) => {
  const d = db();
  res.json({ ok: true,
    figures: d.prepare('SELECT line_id, amount_paise, source, caption FROM prior_figures WHERE engagement_id=?').all(req.params.id)
      .map((x) => ({ lineId: x.line_id, amount: toRupees(x.amount_paise), source: x.source, caption: x.caption })),
    particulars: d.prepare('SELECT * FROM entity_particulars WHERE engagement_id=?').all(req.params.id),
    shareholders: d.prepare('SELECT * FROM shareholders WHERE engagement_id=?').all(req.params.id) });
});

/* ---------- presentation scale (Schedule III General Instruction 4) ------ */
router.get('/scales', (_req, res) => {
  res.json({ ok: true, scales: Object.entries(SCALES).map(([key, v]) => ({ key, label: v.label, divisor: v.div })) });
});
router.post('/engagements/:id/scale', (req, res) => {
  const scale = String((req.body && req.body.scale) || 'full');
  if (!SCALES[scale]) return bad(res, 'unknown scale');
  db().prepare('UPDATE engagements SET scale=? WHERE id=?').run(scale, req.params.id);
  log(req.params.id, actor(req), 'scale.set', { scale });
  res.json({ ok: true, scale });
});

/* ---------- the full chart of Schedule III heads ------------------------- */
/* The grouping dropdown must offer EVERY head, not only the ones already in
 * use — otherwise a head can never be assigned for the first time.           */
router.get('/lines', (req, res) => {
  const division = ['AS', 'INDAS', 'NCE'].includes(req.query.division) ? req.query.division : 'AS';
  const constitution = CONSTITUTIONS[req.query.constitution] ? req.query.constitution : null;
  const SECTION_TITLE = {
    EQUITY: division === 'NCE' ? 'Owners’ funds' : 'Shareholders’ funds / Equity',
    NCL: 'Non-current liabilities', CL: 'Current liabilities',
    NCA: 'Non-current assets', CA: 'Current assets', INCOME: 'Income', EXPENSE: 'Expenses',
    TAX: 'Tax expense', OCI: 'Other comprehensive income', UNCLASSIFIED: 'Unassigned',
  };
  const lines = linesFor(division).map((l) => ({
    lineId: l.id, caption: captionFor(l.id, division, constitution), section: l.section,
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
