# GSTR-2B ⇄ Tally Poster — README (v1.7)

One single file (`gstr2btallyposter.mjs`) that runs on the Tally computer and
gives you a complete GSTR-2B workbench in the browser:

- **Reconcile** GSTR-2B JSON files against the Tally books (same 3-pass engine
  as the GSTR-2B/Tally verification tool).
- **Post** the not-booked invoices straight into Tally — with a double-entry
  guard so nothing is ever booked twice.
- **RCM** party-wise liability journals, **manual voucher entry**, a **6-sheet
  Excel working paper**, and **delete-from-Tally** for anything this tool posted.

Everything runs on your own PC. No internet, no cloud — the browser page is
served from `localhost` only.

---

## 1. Requirements

| Thing | Detail |
| --- | --- |
| Windows PC | The one where Tally Prime runs |
| Node.js | Install once from https://nodejs.org (LTS version) |
| Tally Prime | Open, with the client's company loaded |
| Tally XML port | Tally usually answers on port 9000 automatically. If not: F1 (Help) → Settings → Connectivity → Client/Server → "Both" |
| GSTR-2B JSON | Download from the GST portal: Returns → GSTR-2B → Download JSON (one file per month) |

## 2. Files in C:\TallyPoster

| File | What it is |
| --- | --- |
| `gstr2btallyposter.mjs` | The tool itself (this is the file you replace when I send an update) |
| `Start Tally Poster.bat` | Double-click to start; opens the browser page |
| `gstr2b-tally-data.json` | Its memory — settings, supplier→ledger mappings, posted-entry register. Created automatically. Don't edit by hand |

**Updating to a new version:** replace ONLY the `.mjs` file (keep the same
name), then run the same `.bat`. The version shows in the page header (v1.4).
Your settings and history are kept — they live in the data file, not the tool.

## 3. Daily workflow

1. **Start** — open Tally with the company, press **Alt+F2** in Tally and set
   the period to cover ALL the months of your 2B data (e.g. 1-Apr-2025 to
   today). Then double-click the `.bat`.
2. **Upload** — drop one or MANY GSTR-2B `.json` files at once on the upload
   box. Documents accumulate; IMPG (import of goods) rows are reported but not
   imported.
3. **Reconcile** — press 🔁 Reconcile with Tally. A progress bar shows the
   books being read month by month. Read the "📖 Books read from Tally" line —
   it tells you which months Tally actually returned.
4. **Review** — use the chips (Not booked / Probable / Mismatch / In Tally /
   Posted / Amended…) and the Month-wise / Party-wise view toggle. Every
   mismatch shows an on-face 2B vs books comparison with a diagnosis
   (wrong head, booked twice, half-booked, rate difference…).
5. **Post** — tick the not-booked rows (☑ button selects them all), choose
   ledgers in the posting panel (party / expense / IGST / CGST / SGST /
   voucher type — per-party learning fills the usual expense ledger
   automatically), press ▶ Post to Tally.
6. **Excel** — 📊 Download Excel summary: Summary, All Documents (with
   difference formulas), Possible Duplicates, ITC at Risk, Supplier Gaps and
   IMS Actions (accept / pending recommendations with reasons).
7. **RCM** — the RCM card groups reverse-charge documents party-wise per
   month and posts the liability journal (Dr Input GST / Cr RCM Payable) with
   the correct statutory adjustment flags. Tax is paid in cash; ITC same month.

## 4. What the status pills mean

| Pill | Meaning | What to do |
| --- | --- | --- |
| In Tally ✓ | Found in the books during reconcile | Nothing — locked, can't be posted again |
| Posted ✓ in Tally | Posted by this tool and verified in books | Nothing |
| NOT BOOKED | In 2B, nowhere in the books | Tick and post, or book manually |
| PROBABLE | Likely booked under a different number/date | Confirm the pair shown in the note |
| MISMATCH | Booked, but figures differ | Fix the voucher in Tally (see the comparison grid) |
| MONTH NOT READ | Tally never exported that month | Widen Alt+F2, reconcile again — posting is blocked for these |
| AMENDED / REVISED | Portal revision of a document | Adjust the original voucher manually; never auto-posted |
| In Tally already | Duplicate guard found a matching voucher at posting time | Nothing — skipped |
| Rejected | Tally refused the voucher | Read the error under the pill |

## 5. Safety guards (why it refuses sometimes)

- **Company guard 🛡** — if the open Tally company's GSTIN differs from the
  loaded 2B data's GSTIN, posting and reconciling are blocked.
- **Period guard** — if Tally's on-screen period (Alt+F2) doesn't overlap the
  2B months at all, reconcile stops with instructions.
- **Company-name check** — a Company name in Settings that doesn't EXACTLY
  match the open company would make Tally return empty books; the tool
  detects this and says so instead of showing everything NOT BOOKED.
- **Double-entry guard** — before posting anything it re-reads Tally around
  the batch dates and skips documents that match on number+party or
  party+amount+date. If Tally can't be read, nothing posts.
- **Fresh start 🧹** — by default every launch starts clean (documents and
  cached verdicts cleared; posted-by-tool history kept). Turn off in Settings.
- **Self-worker 🤖** — OFF by default. When on, it watches a folder for new
  2B JSONs (of your own GSTIN only) and auto-reconciles.

## 5A. Multi-GSTIN (one PAN, several state registrations)

If ONE Tally company carries all your registrations (TallyPrime 3.0+):

- Upload ALL registrations' 2B JSONs together — every document remembers
  which of your GSTINs it belongs to.
- **Registration chips** appear above the list (e.g. `09… / 27… / 07…`).
  Pick one to work that state alone — the counts, NOT BOOKED list, select-all,
  posting and the RCM card all follow the chip, so one registration's
  documents never show as "not booked" while you work on another.
- Matching is registration-aware: a document reported to your Delhi GSTIN is
  only paired with vouchers booked under the Delhi registration (Tally tags
  each voucher with its registration). Vouchers of registrations whose 2B you
  did NOT load stay out of the "in books, not in 2B" and ITC figures.
- The reconcile summary and the Excel Summary sheet show a **per-registration
  ITC split** (eligible / matched / not booked) — one line per GSTIN, ready
  for each state's GSTR-3B.
- **Per-registration Excel**: pick a registration chip and press Download —
  the workbook contains only that GSTIN (the file name carries it). Every
  document sheet also has a **Regn** column showing which of your GSTINs the
  row belongs to.
- **🚩 Wrong-registration report**: when a document's number is found on a
  voucher booked under ANOTHER of your registrations (e.g. supplier billed
  your Andhra GSTIN but the entry sits in Haryana), the row is flagged
  "BOOKED UNDER THE WRONG REGISTRATION" (mismatch — never NOT BOOKED, so you
  can't double-book it), a 🚩 pill shows the count, and the Excel gets a
  dedicated **Wrong Registration** sheet: belongs-to vs booked-under, values,
  the voucher, and the fix (change the GST Registration on that voucher).
- RCM liability journals post **per registration** per month.
- The company guard accepts any of the loaded registrations (Tally usually
  reveals only the principal GSTIN of a multi-registration company).
- In Settings, "Your GSTIN(s)" accepts a comma-separated list for the
  self-worker filter.

If instead each registration is a SEPARATE Tally company, work one at a time:
upload that company's months → reconcile → post → 🧹 Start fresh → switch.

## 6. Troubleshooting

| Problem | Cause & fix |
| --- | --- |
| "Tally not reachable" | Tally closed, company not loaded, or port 9000 off (see Requirements). During a reconcile it says "busy reading the books" instead — that's normal |
| Everything shows NOT BOOKED | 1) Alt+F2 period doesn't cover the data months — the 🛑 note on each row says exactly what to set. 2) Company field in Settings doesn't match the open company name exactly — clear it or fix it |
| "TALLY PERIOD MISMATCH" on reconcile | Press Alt+F2 in Tally and set the period the message asks for |
| A booked entry shows NOT BOOKED | Check: is the bill number in Tally's "Supplier Invoice No." field or narration? Is the supplier ledger's GSTIN filled in (Alter → Ledger)? Both make matching exact. Zero-GST expense vouchers need the Supplier Invoice No. filled |
| "Record insertion failure in Database(1)" while posting | Tally's own error. Click OK in Tally, go back to the Gateway (close open voucher screens), try one entry. If it repeats: back up, rewrite the data (Select Company screen → Ctrl+Alt+R), update TallyPrime. The tool auto-retries once and stops the batch so nothing piles up |
| "Ledger 'X' does not exist" | The tool creates missing party ledgers automatically and retries; if it still fails, create the ledger in Tally and post again |
| Posted earlier, but Tally was restored from backup | Reconcile again — the tool re-checks the books and resets stale "Posted" locks |
| Wrong figures uploaded | Re-upload the corrected JSON — changed rows show "UPDATED"; reconcile again |

## 7. Deleting an entry the tool posted

Open the posted row (or the Manual entry log) and press 🗑 Delete from Tally.
Only vouchers created by this tool can be deleted this way — it uses the
internal ID stamped at posting time.

## 8. Version history

| Version | What changed |
| --- | --- |
| v1.0 | Full workbench: recon engine, posting, RCM, learning, guards, Excel/IMS, manual entry, self-worker |
| v1.1 | Six engine fixes from the deep audit (amended rows, corrected re-uploads, note windows, zero-padding, and more) |
| v1.2 | "MONTH NOT READ" diagnosis, notes matched at any date on exact taxable+GST, journal-booked reversals, busy-status fix |
| v1.3 | Zero-GST vouchers (customs duty / clearing agents) kept via the Supplier Invoice No. field |
| v1.4 | Tally "Record insertion failure" handled: auto fresh-ID retry, fix-it checklist, batch stops instead of piling timeouts |
| v1.5 | Multi-GSTIN books: registration chips, registration-aware matching, per-GSTIN summary & Excel split, per-registration RCM journals, multi-GSTIN company guard |
| v1.6 | Regn column on every Excel sheet; the workbook follows the registration chip (per-GSTIN reports); "in books, not in 2B" pill made prominent; registration restriction only when the books truly carry per-registration tags |
| v1.7 | TRUE voucher numbers (Day Book is the authority — the collection export shows "001(26-27)" for auto-numbered journals); 🚩 wrong-registration detection with its own Excel sheet and pill |

## 9. Good practices (from your own data)

- Fill the **GSTIN on every supplier ledger** in Tally — it upgrades matching
  from name-based to exact.
- Always key the supplier's bill number into **Supplier Invoice No.** (or at
  least the narration) — especially on zero-GST and journal-type vouchers.
- Open Tally with the **full financial-year period** (Alt+F2) before
  reconciling.
- Post in **small batches** the first time on a new company, then bulk.
