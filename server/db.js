/* ============================================================================
 * db.js — SQLite persistence (spec §15)
 *
 * Uses Node's built-in `node:sqlite`, so there is no native build step in the
 * node:22-slim image and no new runtime dependency. Everything goes through
 * this adapter, so swapping to better-sqlite3 or Postgres later is a one-file
 * change.
 *
 * Money is stored as INTEGER PAISE. No REAL column ever holds a monetary value.
 * ==========================================================================*/
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  {
    id: 1,
    name: 'init',
    up: `
    CREATE TABLE engagements (
      id            TEXT PRIMARY KEY,
      client_name   TEXT NOT NULL,
      cin           TEXT,
      fy_start      TEXT NOT NULL,
      fy_end        TEXT NOT NULL,
      division      TEXT NOT NULL DEFAULT 'AS',      -- AS | INDAS
      status        TEXT NOT NULL DEFAULT 'open',    -- open | frozen | closed
      created_at    TEXT NOT NULL,
      created_by    TEXT
    );

    -- immutable record of one extraction from a source (spec §3)
    CREATE TABLE snapshots (
      id             TEXT PRIMARY KEY,
      engagement_id  TEXT NOT NULL REFERENCES engagements(id),
      source         TEXT NOT NULL,                  -- tally | excel | manual
      method         TEXT NOT NULL,                  -- live | file
      connector_ver  TEXT,
      company        TEXT,
      period_from    TEXT,
      period_to      TEXT,
      taken_at       TEXT NOT NULL,
      control_totals TEXT,                           -- JSON, reconciled before "complete"
      complete       INTEGER NOT NULL DEFAULT 0,
      sealed         INTEGER NOT NULL DEFAULT 0      -- once 1, rows may never change
    );

    CREATE TABLE ledgers (
      id            TEXT PRIMARY KEY,
      snapshot_id   TEXT NOT NULL REFERENCES snapshots(id),
      tally_id      TEXT,                            -- stable identity from source
      name          TEXT NOT NULL,
      grp           TEXT,
      primary_grp   TEXT,
      group_path    TEXT,                            -- JSON array
      gstin         TEXT,
      is_revenue    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_ledgers_snapshot ON ledgers(snapshot_id);

    CREATE TABLE balances (
      snapshot_id   TEXT NOT NULL REFERENCES snapshots(id),
      ledger_id     TEXT NOT NULL REFERENCES ledgers(id),
      period        TEXT NOT NULL,                   -- current | prior
      amount_paise  INTEGER NOT NULL,                -- Dr positive
      PRIMARY KEY (snapshot_id, ledger_id, period)
    );

    -- approved ledger -> Schedule III line decisions (spec §5)
    CREATE TABLE mappings (
      id            TEXT PRIMARY KEY,
      engagement_id TEXT NOT NULL REFERENCES engagements(id),
      ledger_key    TEXT NOT NULL,                   -- stable identity, survives re-import
      line_id       TEXT NOT NULL,
      confidence    TEXT,
      reason        TEXT,
      approved      INTEGER NOT NULL DEFAULT 0,
      approved_by   TEXT,
      approved_at   TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_map_unique ON mappings(engagement_id, ledger_key);

    CREATE TABLE journals (
      id            TEXT PRIMARY KEY,
      engagement_id TEXT NOT NULL REFERENCES engagements(id),
      period        TEXT NOT NULL,
      narration     TEXT NOT NULL,
      kind          TEXT NOT NULL DEFAULT 'reclass', -- reclass | provision | correction
      approved      INTEGER NOT NULL DEFAULT 0,
      superseded    INTEGER NOT NULL DEFAULT 0,
      created_by    TEXT, created_at TEXT NOT NULL,
      approved_by   TEXT, approved_at TEXT
    );
    CREATE TABLE journal_entries (
      id           TEXT PRIMARY KEY,
      journal_id   TEXT NOT NULL REFERENCES journals(id),
      ledger_id    TEXT,
      line_id      TEXT,
      amount_paise INTEGER NOT NULL                  -- Dr positive; must sum to 0
    );
    CREATE INDEX idx_je_journal ON journal_entries(journal_id);

    CREATE TABLE report_versions (
      id            TEXT PRIMARY KEY,
      engagement_id TEXT NOT NULL REFERENCES engagements(id),
      snapshot_id   TEXT REFERENCES snapshots(id),
      kind          TEXT NOT NULL,                   -- bs | pl | cf | notes | pack
      status        TEXT NOT NULL,                   -- draft | reviewed | final
      framework     TEXT,
      created_at    TEXT NOT NULL,
      created_by    TEXT,
      payload       TEXT                             -- JSON of the computed result
    );

    -- versioned legal rules; nothing is assumed verified (spec §12)
    CREATE TABLE rules (
      id             TEXT PRIMARY KEY,
      domain         TEXT NOT NULL,                  -- caro | msme | tax_audit | ifc | framework
      rule_key       TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'unverified', -- unverified | verified | superseded
      authority      TEXT, provision TEXT, url TEXT,
      effective_from TEXT, effective_to TEXT,
      operands       TEXT,                           -- JSON
      retrieved_at   TEXT, reviewed_by TEXT, reviewed_at TEXT,
      notes          TEXT
    );
    CREATE UNIQUE INDEX idx_rule_key ON rules(domain, rule_key, COALESCE(effective_from,''));

    CREATE TABLE activity (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      engagement_id TEXT,
      actor         TEXT,
      action        TEXT NOT NULL,
      detail        TEXT,
      at            TEXT NOT NULL
    );
    CREATE INDEX idx_activity_eng ON activity(engagement_id, at);
    `,
  },
  {
    id: 2,
    name: 'input_files',
    up: `
    -- Documents the engagement is built on (spec §2). Originals are retained
    -- with their hash, so a re-upload is detected rather than silently doubled.
    CREATE TABLE input_files (
      id            TEXT PRIMARY KEY,
      engagement_id TEXT NOT NULL REFERENCES engagements(id),
      kind          TEXT NOT NULL,        -- prior_financials | gstr2b | gstr1_3b | tds_conso | other
      label         TEXT,                 -- what the user called it
      filename      TEXT NOT NULL,
      mime          TEXT,
      bytes         INTEGER NOT NULL,
      sha256        TEXT NOT NULL,
      stored_path   TEXT NOT NULL,
      period_from   TEXT,                 -- coverage, so gaps can be shown
      period_to     TEXT,
      gstin         TEXT,
      revised       INTEGER NOT NULL DEFAULT 0,
      supersedes    TEXT,                 -- id of the file this replaces
      status        TEXT NOT NULL DEFAULT 'received',  -- received | quarantined | superseded
      quarantine_reason TEXT,
      uploaded_by   TEXT,
      uploaded_at   TEXT NOT NULL,
      notes         TEXT
    );
    CREATE INDEX idx_input_eng ON input_files(engagement_id, kind);
    CREATE UNIQUE INDEX idx_input_hash ON input_files(engagement_id, sha256);

    -- Information requested from the client but not yet received (spec §2).
    CREATE TABLE info_requests (
      id            TEXT PRIMARY KEY,
      engagement_id TEXT NOT NULL REFERENCES engagements(id),
      item          TEXT NOT NULL,
      purpose       TEXT,
      affects       TEXT,                 -- which output is blocked without it
      owner         TEXT,
      status        TEXT NOT NULL DEFAULT 'open',   -- open | received | waived
      created_at    TEXT NOT NULL,
      closed_at     TEXT
    );
    CREATE INDEX idx_info_eng ON info_requests(engagement_id, status);
    `,
  },
  {
    id: 3,
    name: 'presentation_scale',
    up: `ALTER TABLE engagements ADD COLUMN scale TEXT NOT NULL DEFAULT 'full';`,
  },
  {
    id: 4,
    name: 'prior_year_import',
    up: `
    -- Comparatives taken from last year's SIGNED statements, once confirmed by
    -- the preparer. Stored in paise, in PRESENTED terms (positive in the line's
    -- own nature), with the place in the source document they came from.
    CREATE TABLE prior_figures (
      engagement_id TEXT NOT NULL REFERENCES engagements(id),
      line_id       TEXT NOT NULL,
      amount_paise  INTEGER NOT NULL,
      source        TEXT,
      caption       TEXT,
      confirmed_by  TEXT,
      confirmed_at  TEXT NOT NULL,
      PRIMARY KEY (engagement_id, line_id)
    );

    -- Entity, auditor and signatory particulars read from that document. Each
    -- keeps its source and confidence and is unconfirmed until a human says so.
    CREATE TABLE entity_particulars (
      engagement_id TEXT NOT NULL REFERENCES engagements(id),
      field_key     TEXT NOT NULL,
      label         TEXT,
      value         TEXT,
      source        TEXT,
      confidence    TEXT,
      status        TEXT NOT NULL DEFAULT 'unconfirmed',
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (engagement_id, field_key)
    );

    CREATE TABLE shareholders (
      id            TEXT PRIMARY KEY,
      engagement_id TEXT NOT NULL REFERENCES engagements(id),
      name          TEXT NOT NULL,
      shares        REAL,
      percent       REAL,
      source        TEXT
    );
    CREATE INDEX idx_sh_eng ON shareholders(engagement_id);
    `,
  },
];

let db = null;

export function open(file) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)');
  migrate();
  return db;
}

export function migrate() {
  const done = new Set(db.prepare('SELECT id FROM schema_version').all().map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_version (id,name,applied_at) VALUES (?,?,?)')
        .run(m.id, m.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.id} (${m.name}) failed: ${e.message}`);
    }
  }
}

/** Rollback plan: the DB file is the unit of backup. */
export function backup(toFile) {
  if (!db) throw new Error('db not open');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(currentFile, toFile);
  return toFile;
}
let currentFile = '';
export function openAt(file) { currentFile = file; return open(file); }

export const handle = () => db;
export const uid = (p = 'x') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const now = () => new Date().toISOString();

export function log(engagementId, actor, action, detail) {
  db.prepare('INSERT INTO activity (engagement_id,actor,action,detail,at) VALUES (?,?,?,?,?)')
    .run(engagementId || null, actor || null, action, detail ? JSON.stringify(detail) : null, now());
}

/** Seal a snapshot: after this, its ledgers/balances must never change. */
export function sealSnapshot(id) {
  db.prepare('UPDATE snapshots SET sealed = 1, complete = 1 WHERE id = ?').run(id);
}
export function isSealed(id) {
  const r = db.prepare('SELECT sealed FROM snapshots WHERE id = ?').get(id);
  return !!(r && r.sealed);
}
