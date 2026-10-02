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
| `finprep/core/applicability.js` | Versioned, effective-date-aware rules for framework / CARO / MSME / tax audit / IFC. Ships with **no threshold**. |
| `finprep/export/workbook.js` | Formula-linked Excel workbook: faces → notes → trial balance, one file, no external references. |
| `finprep/v2.html` + `v2.js` | The redesigned six-step workflow. Computes nothing; renders the server's model. |
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

## The export's honesty rule

A formula is written **only if it recalculates to the figure being shown**. If a
note's linked trial-balance rows do not add back to the note line, or a face
figure is not equal to its note total, the value is written plain and the
shortfall is reported on the Review sheet as `EXP-LINK`. A formula that looks
right but computes something else is worse than no formula.

## Non-corporate entities (proprietorships, HUFs, firms, LLPs)

An engagement carries a **constitution**. A company reports under Schedule III
(division `AS` or `INDAS`); every other constitution reports in the **ICAI
Guidance Note on Financial Statements of Non-Corporate Entities** (division
`NCE`), whatever framework was asked for. The chart in `schedule3.js` is shared:
a line's `division` keyword (`BOTH | AS | INDAS | CORP | NCE`) says where it
applies, so share capital exists only for companies and the owners' lines only
for the rest.

| Piece | Where | What it does |
|---|---|---|
| Owners' lines | `core/schedule3.js` | `owners_capital`, `partners_current` (Owners' funds); `partners_remuneration`, `interest_on_capital` (appropriations charged in the P&L, never employee or finance costs). Captions follow the constitution. |
| Classification | `core/classify.js` | `classifyLedger(led, {nce})`: Tally's Capital Account group → owners' capital (drawings net inside it, a current a/c to `partners_current`); partner remuneration / interest on capital recognised before the employee and finance-cost rules. |
| Profit | `core/engine.js` | The year's PAT closes into the owners' capital (or current) accounts; reserves carry only what the books hold. The comparative capital figure is last year's closing and is NOT re-added last year's profit; the comparative P&L is a comparative, so the prior-period TB check tests the balance-sheet half on its own. |
| Capital accounts | `core/owners.js` | Owner by owner: opening, introduced, interest, remuneration, share of profit, drawings, closing. Share by ratio with `allocate()` (largest remainder; a nil ratio never gets a paisa) or a manual split that must add to PAT (`OWN-SPLIT` CRITICAL otherwise). Introduced vs drawings from GROSS movements when supplied (connector 4.80+ sends `drTotal`/`crTotal`), else net with `OWN-GROSS`. Remuneration/interest "credited to the account" is inferred from the gross credits and reported (`OWN-CREDITED`). Unassigned ledgers sit in an "unallocated" column (`OWN-UNALLOC`). `OWN-APPROP` warns when the books also appropriated profit by journal. The statement always adds across to the face (`OWN-TIE`). |
| Owners | `server/db.js` migration 6, `/api/fin2/engagements/:id/owners` | name, role, PAN, ratio, ledgers by kind, manual split; `profit_to` on the engagement. Ledgers are matched to an owner by name when exactly one owner's name appears in the ledger name. |
| Cash flow | `core/cashflow.js` | Owners' net capital movement is a financing item (`CF-OWN`). |
| Export | `export/workbook.js` | Framework and PAN on every masthead; "Owners' funds" on the face; a **Capital Accounts** sheet with a column per owner whose closing row is a `SUM`; the partners sign for the firm with their PAN. |

Tests: `node finprep/core/owners.test.mjs`, `node finprep/export/workbook.nce.test.mjs`,
`node server/finprep2.test.mjs` (end to end against a scratch database).

## Books that arrive as a spreadsheet, and the years that follow

| Piece | Where | What it does |
|---|---|---|
| Excel template | `core/tbTemplate.js` | `buildTemplate()` writes a workbook with the engagement's heads as a drop-down; `readTemplate()` / `parseTemplateRows()` read a filled one back, finding columns by heading (Tally's own export headings included). Refused with every problem listed: duplicate names, blank or numeric group, both sides on one row, negatives, non-numbers, unknown head, debits ≠ credits. Gross movement columns are optional and feed the owners' accounts. Snapshot `source: excel`. |
| Variance | `GET /api/fin2/engagements/:id/variance` | Latest import against the previous one, ledger by ledger: changed, added, dropped, with both periods. Shown on the import step after every import. |
| Adjustment entries | step 5 of `v2.html`; `insertJournal()` in `server/routes/finprep2.js`; migration 7 | Entries target a ledger by NAME (`ledger_key`) or a head; the id is resolved in the current snapshot at build time, so entries survive a re-import. Approve / take back (`POST …/journals/:jid/approve`), withdraw (`DELETE`, superseded, kept for the record), edit (`PUT` supersedes and re-records). A ledger that disappears from the books raises `JRN-LEDGER` CRITICAL in `engine.js` rather than vanishing. |
| Clients and next year | `GET /clients`, `GET/POST …/carry-forward` | Engagements grouped by client; "Start next year for this client" pre-fills the form; "Carry forward last year's grouping" copies approved heads and note captions for ledgers still in the books, and the owners (ratios, PAN, ledgers; never last year's manual split) when none are recorded — nothing decided this year is overwritten. |

Tests: `node finprep/core/tbTemplate.test.mjs`; `node server/finprep2.test.mjs` (now
18 steps); `CHROME_PATH=… node finprep/v2.smoke.test.mjs` drives the real page in
headless Chromium against the real server and a scratch database.

## AI suggestions, the PDF, and the cash report

| Piece | Where | What it does |
|---|---|---|
| AI head suggestions | `core/aiMap.js`; ⚙ and "Suggest heads with AI" on the grouping step | With the preparer's OWN key (Anthropic, any OpenAI-compatible endpoint, or a local Ollama; the key lives in the browser under the same `knap-as-cfg` the old assistant used). Sends ONLY the ledger name and its Tally group path for the ledgers shown under the current filter — never amounts, GSTINs, parties or the client's name. Replies are parsed as JSON, any head not in the chart is discarded, and proposals are pre-selected only where the tool itself had no confident head; nothing is saved until "Approve & rebuild". |
| PDF | `export/pdf.js` (pdf-lib, loaded on demand from `/pdftools/`) | Balance sheet, P&L, the owners' accounts, notes with both period dates and the accounting policies; Indian grouping, brackets for negatives, DRAFT watermark while a critical check stands; the auditor and the board or the owners sign. WinAnsi fonts: amounts headed "Rs.", a glyph the font lacks becomes "?" rather than stopping the export. |
| Cash report | connector 4.81 `POST /api/fin/cashbook`; "Cash report" tab on the statements step | The connector returns every voucher leg on a Cash-in-Hand ledger (date, type, number, party or largest counter-leg, narration, amount, payment/receipt, bank/cash counter flags). The page groups by party and day: s.40A(3) payments above 10,000 and the 9,000–10,000 near band; s.269ST receipts of 2,00,000 or more and the 1,90,000–1,99,999 near band; contras excluded; CSV download. The page lists, it does not conclude. |

Tests: `node finprep/core/aiMap.test.mjs` (fake fetch), `node finprep/export/pdf.test.mjs`
(inflates the content streams and reads the text back), `node connector/cashbook.test.mjs`
(stub Tally).

## Not yet built

Listed honestly; none of it is stubbed or faked.

- **Schedule III 2021 disclosures** — ageing schedules, promoter holdings, title
  deeds, struck-off entities, CSR, etc. The requirements are recorded per head
  in `schedule3.js` and surface as `disclosureGaps` and on the Disclosures
  sheet, but the schedules themselves need bill-level data from the connector.
- **Applicability thresholds** — the engine is built and tested, but every rule
  is `unverified` and returns *Unable to determine*. Nothing will conclude until
  a reviewer records the authority, provision, effective dates and operands.
- **PDF and DOCX export** — only Excel is implemented.
- **GST/TDS reconciliation**, **tax audit annexures**, **roles/tenant isolation**,
  **background jobs**.

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
