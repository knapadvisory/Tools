# GSTR-2B ⇄ Books: the rules this matcher follows, and why

Every rule below was written after a real run got something wrong. The
examples are from ECLAT, FY 2025-26 — the run the client checked line by line
against a second tool. Each one is pinned by a test in `reco.test.mjs`, built
from the actual row.

Read this before changing `findMatch` or `buildRec` in `index.html`. The
matcher is not complicated; it is *calibrated*, and the calibration is what
this file is.

---

## 1. Evidence has an order, and assignment must respect it

A 2B document and a books voucher can agree on the invoice number, the GSTIN,
the party, the tax, and the taxable value. Those are not equal evidence:

| Evidence | Score | Worth |
|---|---|---|
| The same invoice number, both sides | `invMatch` 3 | conclusive |
| One number is the other's tail (≥3 chars) | 2 | strong — `100` ↔ `26-27/100` |
| One contains the other (≥5 chars) | 1 | weak — needs the party or the tax too |
| Nothing — party and amount only | 0 | a guess worth reporting as one |

**The order matters more than the scores do.** Matching used to walk the 2B
file top to bottom, giving each document the best unclaimed voucher. So
`SA/25-26/100` — a containment match, same party — took voucher `SA/25-26/10`,
and when the real `SA/25-26/10` came along its voucher was gone: reported as
not booked, though it sat in the books with the identical number and GST to
the paisa. The same thing hid RAMCO's `VGDIN026605/2526`, and then reported
the document that had eaten its voucher as *ITC claimed under the wrong
registration* — a finding that did not exist at all.

Assignment therefore runs in passes at evidence floors **3, 2, 0**. Every
document that can be settled on an exact number is settled before any
containment match is allowed to claim anything.

Anything added to the scoring must keep this shape: a new signal that can
accept a pair must also be able to say how firm it is, or it belongs in the
ranking key rather than in `accept`.

Zero padding is not a difference either. The supplier reports `005`, the books
hold voucher `5`, and a preparer writes "different invoice no." against every
one of them — 27 in the CGST run. `invPlain` strips the padding at the start of
a number and after any letter, so `005` ↔ `5` and `INV/005` ↔ `INV/5` are the
same number. The pair is still short after stripping, so rule 2 still applies
and it does not carry the match alone.

## 2. A short number is a number, but it is not evidence on its own

Candidates under two characters used to be dropped, so Maa Kalyani's invoice
**6** (taxable ₹1,34,964) could not be found even though the books held the
same number, party and tax. They are kept now, and the acceptance rule asks
for length: an invoice number carries a pair by itself only when the agreeing
part is at least two characters. `6` ↔ `6` still needs the party or the tax to
agree, because two unrelated suppliers both have a sixth bill.

## 3. Sign is not negotiable

A credit note takes credit away; the voucher answering it must do the same. In
the books that voucher is a **debit note** (purchase return, rate or quantity
difference) which *credits* the input-tax ledger, so it reaches the matcher
with its tax negative — the same sign as the note.

Without that rule the matcher does something quietly terrible. Suppliers often
number a credit note after the invoice it relates to, so the note matches the
original **purchase**, reads "credit note reversed", and the reversal that was
actually missing is never reported. A pair of signs only decides when both
sides have one, so a nil-rated note still matches on its value.

## 4. 2A and 2B are the same tables, and not the same question

The parser reads both (`srcOfJson` decides from the shape, not the filename:
`itcavl` exists only in 2B, `iamt` only in 2A). They are merged on the
document's identity — supplier GSTIN + document number + invoice/note +
amendment — with **2B winning every common document**, untouched.

What is left from 2A is 2A-only, and that is a finding of its own kind: the
books question ("is it recorded?") is answered exactly as for any other
document, but the credit question is not. Under Sec 16(2)(aa) ITC comes
through 2B, so 2A-only means *reported by the supplier, not yet claimable* —
usually a late GSTR-1 that will land in a later month's 2B. Both answers go on
the row; neither is allowed to stand in for the other.

The reverse — in 2B but not in 2A — is **not** flagged. Loading twelve months
of each still leaves the two sets ending on different documents, so the
"finding" would be an artefact of which files were loaded.

## 5. Read the dialect the file is actually written in

2B and 2A/GSTR-1 name a credit note's fields differently, and the difference is
silent:

| | 2B | 2A / GSTR-1 |
|---|---|---|
| number | `ntnum` | `nt_num` |
| type (C/D) | `typ` | `ntty` |
| date | `dt` | `nt_dt` |

Reading only the 2A names left every 2B credit note with a **blank document
number** and, the type being unreadable, a **positive sign** — so a reversal was
carried through the whole reconciliation as an extra invoice. Nothing failed;
the sheet just quietly said the opposite of the truth. It surfaced only by
comparing a real CGST run against the same books reconciled by hand, where the
notes appeared with their numbers and as negatives.

Both dialects are read now, and the test builds a note in each. When adding a
table, check the key names against a real file of **both** returns — and against
`downloads/gstr2b-tally-poster.mjs`, which has been reading real 2B files for
longer than this tool has.

## 6. The credit follows the tax, not the taxable value

GST tolerance is **₹1**; taxable tolerance is **max(₹10, 0.5%)**.

When the GST agrees and only the taxable differs, that is almost always
freight, loading or packing charged on the voucher and outside the supplier's
invoice value — `ST/25-26/221`, books taxable ₹5,000 higher, GST ₹1,09,031.40
on both sides. It is **not** an ITC finding. Explain it in the note and leave
the remark as *booked*. 70 of 71 documents once sitting in "probable match —
verify" were of exactly this kind, which is how a preparer learns to ignore
the column.

A taxable gap matters only when the invoice number does *not* vouch for the
pairing: there the gap is evidence about whether this is even the right
voucher, and it earns *verify*.

## 7. A remark must be a finding, not a hedge

The second tool the client compared against was, in their words, "more
reliable and concise with no extra comments". That is the standard. Every
hedge spends the preparer's attention, and there is a fixed amount of it.

- Don't say *verify* about something the numbers have already confirmed.
- Don't say *amount mismatch* when the amounts agree to the paisa.
- Do say *matched on party and amount alone* when that is all there is —
  Ultratech billed ₹8,424.00 eleven times over, and `913900250` paired with
  voucher `913900258` on nothing but the party and the value.

## 8. Each kind of wrong gets its own bucket

*ITC taken in the wrong registration* is not an amount mismatch. Three ECLAT
documents had identical figures on both sides and read "booked — amount
mismatch" with a difference of 0.00, because the registration branch
overwrote the remark whatever the figures said. `wrongreg` is its own
category; when the figures are *also* wrong, the note says both.

A supplier credit note is the clearest example. It is not a missing entry like
an unbooked purchase — it is a **reversal due**. The credit was taken on the
original invoice, and if nothing in the books gives it back the ITC stands
over-claimed with interest running under Sec 50. So credit notes carry their
own verdicts:

| Bucket | What it means |
|---|---|
| `cnok` | a reversal was found and the tax agrees |
| `cnmm` | a reversal was found and is short by a stated amount |
| `cnmiss` | **nothing answers it — reverse ₹x** |
| `onlybkCN` | the books reversed credit no supplier note asked for |

That last one is usually right — a Rule 37 non-payment reversal, Rule 42/43
apportionment, an ineligible credit written back — and the note says so. It is
reported because the same reversal passed twice looks identical, and because
the supplier's note may be sitting in a month nobody loaded.

## 9. Nothing in the input may be silently dropped

Every one of these was a bug that presented as a wall of false findings:

- **Tax heads.** Books fetched for the IGST ledger alone, against a 2B file
  carrying CGST/SGST too, reported ~2,100 intra-state documents as "not in
  books". The tool now asks which heads to reconcile, and documents outside
  that choice are **set aside and counted** — never dropped, never reported as
  unbooked.
- **Period coverage.** A 2B document dated outside the window the books were
  read for is a period gap, not an unbooked invoice.
- **Duplicates.** The same document in two months' files is dropped once and
  the count is shown. Left in, the second copy finds its voucher already taken
  and reads "not in books" — a false finding manufactured by the input.
- **Amendments.** An amendment *restates* a document; it does not add one. The
  original is marked superseded, shown for the trail, and kept out of both the
  total and the matching, so it cannot take the voucher the live version needs.
  Four documents in the CGST run were counted twice for ₹3,55,466.25 — and the
  portal's own tool did the same, so the two sheets agreed on a figure that was
  wrong in both. Agreement is not correctness.

  In a multi-GSTIN group the commonest amendment is not a change of figures at
  all: the supplier reported the invoice against the **wrong registration** of
  yours and moved it. SS Associates reported 23/2025-26 and 38/2025-26 against
  06 in the April 2B and amended both to 37 in May's. So the match is made on
  supplier GSTIN + document number, deliberately ignoring which registration's
  2B a row came from, and the remark names where the credit went. It also
  resolves the wrong-registration flag raised on the original: the books, which
  had it under 37, were right and the first 2B was not.
- **TDS and round off.** Neither belongs in the taxable base. A voucher's TDS
  deduction was inflating it; the giveaway was that 18% of the base without
  TDS equalled the IGST exactly.

## 10. Noise is a finding about the input, not 674 findings

In the CGST run, **674 of the 722 documents "not in books" were one supplier** —
Kotak Mahindra Bank, ₹25,280.72 of GST between them, against ₹13 lakh on the
other 48. The preparer hand-labelled the whole run "bank charges/finance cost"
in one go, and was right to: the GST on bank and card charges is normally
expensed along with it, so no input ledger ever holds it. Read as 674 separate
lines it buries the 48 that matter.

So a run of ten or more unbooked documents from one supplier is summarised —
on screen and on its own sheet — with the count, the GST, and what it usually
means. One supplier's whole run missing is a question about the ledgers that
were fetched, not about 674 omissions.

## 11. A total is only as complete as the files behind it

The client checked the tool's 2B total against the portal's own 2A/2B summary
and found it short. It reconciled **to the paisa**, and not one rupee of it was
a matching failure:

```
portal 2B CGST (all three registrations)      3,24,52,790.09
less  13 invoices in the APRIL and MAY 2026
      2B — FY 2025-26 purchases whose
      suppliers filed GSTR-1 late              -14,07,998.95
add   3 documents in our 2B that the portal
      download does not contain                 +2,86,644.96
                                              ---------------
our reconciled sheet                          3,13,31,436.10   ✓
```

and the notes the same way: portal ₹4,60,132.52 = our ₹7,210.67 + two Yankit
notes worth ₹4,52,921.85 sitting in the April 2026 2B.

### Make the file prove itself

Every 2B file states its own ITC totals in `itcsumm`. That is a check the tool
runs on itself at load: the documents parsed must add up to what GSTN says the
return holds, and the file chip shows `= ✓` or `≠ <amount>`. Across the client's
28 real returns, 27 tie **to the paisa**; the 28th carries no `itcsumm` at all
and is reported as unchecked rather than assumed good.

This is the cheapest guard in the tool and it would have caught the credit-note
dialect bug the moment a file was loaded. Run it against a new dialect before
trusting anything else.

One subtlety it has to respect: **the `b2ba` / `cdnra` lines in `itcsumm` are
differentials** (amended value less the original), not gross. June 2025 reads
`-2,20,654.44` because of the three Kaushik amendments above. So the comparison
is made on the non-amendment documents only, where it ties exactly.

### Coverage is per registration

**A financial year's GSTR-2B is not twelve returns.** A supplier who files his
March GSTR-1 after the 2B cut-off appears in April's 2B; a quarterly filer in
May's. So when the last 2B loaded is a March, the report says outright that the
year does not end there — and any month missing from the middle of the loaded
range is named. The periods loaded are printed on the report itself, because a
month nobody noticed was absent looks exactly like a year of clean books.

And the count is taken **per registration**. In the client's 28 files, Haryana
and Andhra had all twelve returns and Odisha had four. Pooled, every month of
the year was covered and the check reported no gap at all — while Odisha's
February was missing and every Odisha purchase in it would have read "booked,
but not in 2B". One registration having every month says nothing about another.

Gaps are reported only *inside* each registration's own loaded range: Odisha
starting at November may mean the registration began then, and the tool does not
guess. That the range starts late is visible on the report; whether it should
have is the preparer's call.

The remaining three documents (Kaushik Enterprises 110, 121, 125 —
₹2,86,644.96) were settled against the source files, and the answer reversed
twice. On the May 2025 file alone they look like ordinary invoices the portal's
download had simply missed. With the **June** file in hand they are amendments:

```
b2ba  inum "26/05/2025"  oinum 110   CGST 95,054.40 → 0.36
b2ba  inum "29/05/2025"  oinum 121   CGST 96,510.96 → 0.36
b2ba  inum "30/05/2025"  oinum 125   CGST 95,079.60 → 65,989.80
```

The supplier cut all three to almost nothing **and renumbered them**, and the
June return's own `itcsumm` carries the negative differential to prove it. So
the portal download was right to show only the live positions, our old sheet was
overstated by ₹2,86,644.96, and the ITC the books claim on those three is no
longer supported by 2B — a material finding the old sheet buried. It is caught
now only because `origNo` is parsed: the amendment's own number matches nothing.

**One month is not enough evidence about any document.** A document can only be
read against the whole year, because the return that overturns it comes later.

## 12. Recall gaps are not all matcher gaps

142 documents worth ₹12.37 lakh appeared in the other tool's sheet and not in
ours. Before touching the matcher: **119 of them were dated March 2026**, and
their source file included 2A, not 2B alone. That is an input difference — and
the answer to it was to read 2A (rule 4), not to loosen the matching. Only the
remaining handful were ours to fix, and they were the assignment-order and
short-number bugs above.

Always separate the two before concluding the matching is weak.

---

## Open, and honestly not done

- **The Tally-side ITC filter is proved only against a stub.** Three TDL
  shapes are tried in order and each is validated against an unfiltered sample
  window, which is why `/api/itc/diagnose` exists. Output from a real Tally
  with the fastest shape failing has still not been seen, so tier 1 is
  untested in the field.
- **A credit note is not tied to the invoice it relates to.** It is matched to
  the reversal in the books, which is the question that decides the tax. The
  original document number is now parsed (`origNo`, from `oinum`/`ontnum`) but
  nothing uses it yet, so the note is still not linked back to its invoice.
- **Blocked credit still needs a human.** Where 2B says `itcavl = N` we say so.
  Where it does not, judgement is required and we do not attempt it: in the CGST
  run the preparer marked five documents "ineligible" that 2B had not flagged — a
  Honda dealer (motor vehicle, Sec 17(5)) and hotel stays. Guessing from the
  supplier's name would be wrong more often than it is useful, so a "not booked"
  that was a deliberate non-claim reads the same as an omission. Worth a tick
  column the preparer can fill once per supplier.
- **Cess is parsed and then ignored.** `csamt`/`cess` is read into the row, but
  there is no cess head to reconcile it against because the connector has no
  cess ledger kind. Cess ITC is real credit and currently goes unchecked.
- **ISD credit, imports and RCM self-invoices are not read.** The `isd`,
  `impg`/`imp` and related tables in 2A/2B are skipped entirely, so a company
  with an input-service distributor or import credits is only partly covered.
- **Nothing ages the unmatched.** A document unbooked for five months is
  reported the same as one unbooked for five days, and the Sec 16(4) cut-off
  (30 Nov after the FY) is mentioned in notes but not computed.
- **Nothing reconciles the total to GSTR-3B.** The tool ties 2B to the books;
  it does not tie either to the ITC actually claimed in 3B, which is the number
  a notice is raised on.

## Running the tests

```bash
npm i --no-save playwright-core
CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  node itc-reco/reco.test.mjs        # how a matched document is labelled
CHROME_PATH=… node itc-reco/datepicker.test.mjs
node connector/itc-register.test.mjs # the Tally-side read, against a stub
```

A new finding class, or a fix to a mis-labelling, is not finished until a
test built from the real row that exposed it is in `reco.test.mjs`. Fixtures
invented from scratch have never caught any of the above.
