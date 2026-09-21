# Financial statements tool — redesign

Implementation of the redesign specification. This file records what is built,
what is deliberately not yet built, and the decisions taken.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Persistence | **SQLite** via Node's built-in `node:sqlite` | No native build step in `node:22-slim`, no new dependency, ACID, file-level backup. Isolated behind `server/db.js` so Postgres is a one-file swap. |
| Stack | **Kept** (Node/Express + static pages + existing Tally connector) | Spec §: do not replace the stack by preference. The connector (v4.58) already extracts groups, ledgers, vouchers, bill allocations and snapshots. |
| Legal rules | Engine built, every rule seeded **`unverified`** | Spec §12. Primary MCA/CBDT/GST sources could not be verified here, so no threshold is asserted. An unverified rule returns *Unable to determine*. |
| Money | **Integer paise** everywhere | Spec §6/§15 — no binary floating point for money. Rupee floats exist only at the API boundary. |

## Architecture

```
Tally connector (local, read-only)
        │
        ▼
  sealed snapshot ──────────────┐      immutable: ledgers + balances,
  (control totals reconciled)   │      reconciled to nil before "complete"
        │                       │
        ▼                       │
  approved mappings  +  approved journals   (each must balance; rationale recorded)
        │                       │
        ▼                       ▼
            ADJUSTED TRIAL BALANCE
                    │
                    ▼
     lines (stable IDs) → note numbers → statements
                    │
                    ▼
     integrity checks → release gate
```

### Modules

| Path | Responsibility |
|---|---|
| `finprep/core/money.js` | Integer-paise arithmetic, largest-remainder allocation (no rounding plug), Schedule III rounding units by turnover. |
| `finprep/core/schedule3.js` | The chart of statement lines with **stable IDs**; note numbers are assigned at presentation time. Carries each head's Schedule III information requirements. |
| `finprep/core/classify.js` | Ledger → line. Whole-word matching; rules carry an `altLine` so a balance on the abnormal side is reclassified rather than netted. |
| `finprep/core/engine.js` | Original TB → journals → adjusted TB → lines → P&L/BS, integrity checks, disclosure gaps, release flag. |
| `finprep/core/cashflow.js` | AS 3 / Ind AS 7 indirect cash flow, built bottom-up from PBT and reconciled to the balance sheet. No plug. |
| `server/db.js` | SQLite, versioned migrations, snapshot sealing, activity log. |
| `server/routes/finprep2.js` | Engagement API at `/api/fin2`. |

### Data model

`engagements → snapshots → ledgers → balances`, plus `mappings`, `journals` +
`journal_entries`, `report_versions`, `rules`, `activity`. Snapshots are sealed
after creation; corrections are made by journal, never by editing a snapshot.

## Defects closed (from the audit of the previous implementation)

| Ref | Defect | Fix |
|---|---|---|
| C1 | `"indirect incomes"` matched the substring `"direct income"`, so **all** other income was reported as revenue from operations. Same for `direct expense` ⊂ `indirect expenses` and `secured loan` ⊂ `unsecured loans`. | Whole-word matching in `classify.js`. |
| C2 | Reserves rolled forward on **PBT**; keyed tax was display-only and never reached the balance sheet. | Tax lines are real lines; a provision is an approved journal; reserves close on **PAT**. The display-only input is gone. |
| C3 | A ledger was classified once from the current-year sign and that head used for both columns. | Each period resolves its own line; a change of head is flagged as a regrouping. |
| C4 | Creditors with debit balances and debtors with credit balances were netted, contrary to Schedule III. | `altLine` moves them to advances; both gross amounts are presented. |
| C5 | Depreciation could be capitalised into PPE and vanish from the P&L, and the balance sheet still tied. | Depreciation classifies straight to the P&L line; PPE is never a staging area. |
| C6 | Operating cash flow was a plug (`netCash − financing − investing`), so it always tied and could never be audited. Depreciation appeared as an investing inflow. | Rebuilt bottom-up from PBT with add-backs, working-capital movements and taxes paid. The statement is then reconciled to the movement in cash per the balance sheet and any residual is **reported as CRITICAL**, never absorbed. Interest and dividend income move to investing; finance costs to financing. |
| H1 | Unclassified balances were dropped from both face totals; offsetting items made the drop invisible. | Reported **gross Dr and Cr**, and blocks release. |
| H2 | No heads for share application money, share warrants, CWIP, intangibles, purchases of stock-in-trade or tax. | All added, with classification rules. |
| H4 | TDS receivable was captured by the Duties & Taxes group rule. | Name-specific tax rules run first. |
| H7 | Only the current-year balance sheet was checked. | Every period is checked. |
| M2 | Bank charges and interest on late statutory dues were finance costs. | Reclassified to other expenses. |
| M5 | Bank overdrafts appeared as negative cash. | Credit bank balances move to short-term borrowings. |

Verified by `node finprep/core/engine.test.mjs` (26 assertions) and
`node finprep/core/cashflow.test.mjs` (8 assertions).

### What the cash flow cannot know from a trial balance

Gross additions vs disposals, borrowings drawn vs repaid, and actual taxes paid
cannot be derived from two balance sheets. Where a supporting schedule is
supplied it is used; otherwise the net movement is presented and an **explicit
assumption is recorded and returned** (`CF-FA`, `CF-BOR`, `CF-TAX`, `CF-INT`).
Assumptions are surfaced, never silently applied.

## Not yet built

Listed honestly; none of it is stubbed or faked.

- **Notes/disclosure rendering and Excel/PDF/DOCX export** from the new engine.
  The existing export still runs off the old path.
- **Schedule III 2021 disclosures** — ageing schedules, promoter holdings, title
  deeds, struck-off entities, CSR, etc. The requirements are recorded per head
  in `schedule3.js` and surface as `disclosureGaps`, but the schedules
  themselves need bill-level data from the connector.
- **Applicability engine** (CARO / MSME / tax audit / IFC) — `rules` table exists;
  no rule is seeded, because no threshold has been verified against a primary
  source.
- **GST/TDS reconciliation**, **tax audit annexures**, **roles/tenant isolation**,
  **background jobs**, **UI migration** to the new API.

## Migration and rollback

Migrations are numbered and additive; `schema_version` records what is applied.
The database file is the unit of backup (`backup()` checkpoints WAL and copies).
Nothing in this phase reads or writes the existing `localStorage` data, and the
old finprep page is untouched, so rollback is: stop using `/api/fin2`, or revert
the commit. No client data is migrated or destroyed.

## Running

The API mounts automatically. Set `KNAP_DB` to relocate the database; it
defaults to `data/knap.db`, which needs a persistent volume in Docker.

```
curl -X POST localhost/api/fin2/engagements \
  -H 'content-type: application/json' \
  -d '{"clientName":"X Pvt Ltd","fyStart":"2025-04-01","fyEnd":"2026-03-31","division":"AS"}'
```
