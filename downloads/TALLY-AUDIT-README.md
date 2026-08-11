# Tally Statutory Audit Assistant

A standalone tool (`tools/tally-audit.mjs`) that connects directly to **Tally
Prime** on your computer, reads **every ledger, group and voucher** of the
selected company for the audit period, and runs the test battery a Chartered
Accountant runs on the books — then tells you what looks wrong, graded
**High / Medium / Low / Info**, each with its statute or Standard-on-Auditing
reference and a ready recommendation for the management letter.

Everything runs locally. **The books never leave your machine.**

---

## Quick start

**Easiest (Windows):** take the single file `TallyAudit-AllInOne.bat`, put it
in any folder (e.g. `C:\TallyAudit`), and double-click it. It contains the
whole tool, unpacks `tally-audit.mjs` next to itself and starts everything —
only Node.js (step 1 below) and the Tally setting (step 2) are needed first.
Rebuild it after changing the tool with `node tools/build-tally-audit-bat.mjs`.

Manual route:

1. Install Node.js (LTS) from <https://nodejs.org> — one time.
2. In Tally Prime: **F1 (Help) → Settings → Connectivity → Client/Server
   configuration** → *TallyPrime acts as* = **Both**, *Port* = **9000**.
   Keep the company open.
3. Run:

   ```
   node tools/tally-audit.mjs
   ```

   and open **http://localhost:8789** in your browser.
4. Pick the company and the financial year → **Run audit**. A full FY of a
   mid-size company takes a couple of minutes (vouchers are read month by
   month with a progress bar).

Settings, checklist ticks and the last run are saved in
`tally-audit-data.json` next to the tool. Delete that file to start fresh.
`node tools/tally-audit.mjs --selftest` runs the built-in engine test
without needing Tally.

---

## What it checks (44 automated tests)

| Area | Tests | References |
|---|---|---|
| **Books & audit trail** | duplicate voucher numbers, sequence gaps, cancelled vouchers, optional vouchers pending, large vouchers without narration, Sunday/holiday entries, suspense balances, master-vs-computed balance mismatch | Sec 128 · Rule 11(g) · SA 230 |
| **Trial balance & openings** | TB out of balance, opening balances out of balance, P&L ledgers with opening balances, wrong-side balances, dormant balances | SA 510 · Schedule III |
| **Cash & bank** | **day-wise negative cash**, cash payments > ₹10,000 aggregated per payee per day, cash receipts ≥ ₹2,00,000 per payer per day, loans accepted/repaid in cash ≥ ₹20,000, bank ledgers with credit balances | Sec 40A(3) · 269ST · 269SS/269T · CARO 3(xi) |
| **Revenue & receivables** | sales credited via Journal, year-end sales clustering (cut-off), year-end credit notes, debtors with credit balances, missing / checksum-invalid GSTINs | SA 240 · AS 9/Ind AS 115 · Schedule III |
| **Purchases & payables** | purchases via Journal, same supplier bill reference booked twice, creditors with debit balances, **MSME > 45-day bill-wise ageing**, Schedule III ageing buckets | Sec 43B(h) · MSMED Sec 15 · Schedule III |
| **Statutory dues** | TDS/TCS ledger positions, GST ledger positions + net payable, PF/ESI/PT/gratuity balances, other Duties & Taxes wrong-side | Sec 200/201 · 36(1)(va) · CARO 3(vii) |
| **Journal testing** | round-sum entries, year-end journal clustering, same-ledger-both-sides vouchers, **Benford first-digit test** (Nigrini MAD), largest vouchers | SA 240 (R) |
| **Companies Act & RPT** | director/related-party ledger scan, borrowings without interest cost, loans given without interest income, fixed assets without depreciation | Sec 185/186/188 · Sch II · AS 18/Ind AS 24 · CARO 3(iii)/(xiii) |
| **Payroll** | missing salary/rent months, salary paid in cash | Sec 40A(3) |
| **Analytics** | auto **materiality** (ICAI benchmarks: % of turnover / PBT / assets → OM, PM, clearly-trivial), key ratios, monthly trend, expense spikes, biggest movements | SA 320 · SA 520 |
| **Sampling** | key items ≥ performance materiality + monetary-unit sample for vouching, exportable | SA 530 |

## What's in the app

- **Findings** — every check as an expandable card: severity chip, count,
  statutory reference, the actual voucher/ledger rows, per-check CSV
  download, and a ready "Action" note.
- **Analytics** — ratios and monthly sales-vs-spend chart.
- **Trial balance** — the full period TB (Dr-positive convention), filter +
  CSV.
- **Sampling** — the SA 530 vouching sample.
- **Audit checklist** — the complete 10-phase statutory-audit programme
  (acceptance → AGM filings). Items the tool tests are auto-linked with live
  status pills; the manual ones (confirmations, physical verification,
  minutes, CARO drafting…) have tick boxes saved per company + FY.
- **Report** — a printable **management-letter draft** built from the
  findings, plus all-findings CSV.

## Notes & limits

- Findings are **audit leads, not conclusions** — every row still needs
  professional judgement and evidence.
- Balance conventions: the tool normalises Tally XML to debit-positive.
- Bill-wise ageing needs bill-wise details enabled in Tally; if the Bills
  Receivable/Payable export is empty the MSME/ageing checks mark themselves
  "not available" instead of guessing.
- The audit-trail (Edit Log) *configuration* — whether the feature stayed on
  all year — must be verified inside Tally itself; the tool covers the
  book-side symptoms (cancellations, gaps, mismatches).
- Multi-company: leave Company blank to audit the open company, or pick one
  from the dropdown when several are open.
- Different port: `PORT=8790 node tools/tally-audit.mjs`.
