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

Zero padding is not a difference either, and it has to be stripped **before**
the separators are. The supplier reports `SG/25-26/00111`, the books hold
`SG/25-26/0111`, and squeezing out the punctuation first leaves `SG252600111`
against `SG25260111` — two numbers no rule can join. `normInv` removes a run of
zeros wherever a digit group starts, so `005` ↔ `5`, `INV/005` ↔ `INV/5` and
`SG/25-26/00111` ↔ `SG/25-26/0111` all reduce alike. The pair is still short
after stripping, so rule 2 still applies and it does not carry the match alone.

But a number is carried in **both** readings, padded and flat, and the best
agreement between any pair wins. `EIPL/AP/202504` and `EIPL/AP/2025/04` are one
invoice: squeezed flat they are identical, and stripping padding changes only
the second — so a padding rule applied alone *broke* a document that had always
matched. The padded reading finds `SG/25-26/00111` ↔ `SG/25-26/0111`, the flat
one keeps `EIPL/AP/202504` ↔ `EIPL/AP/2025/04`, and neither costs the other.

A books voucher that has simply lost the financial year — `694` against the
supplier's `694/25-26` — counts as strong evidence (2), not conclusive: the
prefix alone could belong to another of his documents.

**What is left over is signal.** Of the 117 documents the first real run put in
"probable match — verify", only five were avoidable: three padding, two dropped
years. The other **109 are numbers that genuinely differ by a digit or two** —
`25-26/2856` against `25-26/2849`, `17` against `16`, `BB/17638` against
`BB/17538` — matched on party and amount, and every one a real thing for a
preparer to check.

### The books number vouchers in their own series

A supplier numbers his invoice; the books number the purchase in the COMPANY's
own voucher series — 43, 27, 574, 1245. So a 2B invoice numbered 43 will sooner
or later meet the buyer's own voucher 43, raised for an entirely different
supplier, and an exact number match on its own will pair them. It did, on the
first full run:

| 2B | books |
|---|---|
| SANGEETHA ELECTRICALS, `582/2025-26` | SS Associates, voucher `582/2025-26` |
| SRI BALAJI CONSTRUCTIONS, `43` | LAKSHMI AGENCIES, voucher `43` |
| ANANDHA TIMBER DEPOT, `27` | MSB INDUSTRIES, voucher `27` |
| OM STEEL & FABRICATION, `1245` | SREE MARUTI CHEMICALS, voucher `1245` |

Different GSTIN, different name, reported as *booked with an amount difference*
rather than as two unrelated documents — which also inflated the
amount-mismatch findings with pure fiction.

So: **an invoice number is evidence only while nothing contradicts it.** A
supplier's GSTIN is his identity and his name is the next best thing; when
either contradicts the pairing, the number has to be a coincidence unless the
party *and* the money both say otherwise. GSTIN agreement outranks a name that
merely reads differently — a trade name against a legal name is not a conflict.

The rule is narrow on purpose. Of 4,680 paired rows in that run, 26 had a
contradicted identity: **nine separated** (all four above among them) and
**seventeen stayed matched** — Tata AIG, Sunderdas, Epack Durable — suppliers
billing under a second GSTIN, or a GSTIN mistyped in Tally, where the name
agrees and the tax ties to the paisa.

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

Against the client's real set (28 returns of 2B, 29 of 2A, three registrations),
**5,422 documents appear in both and 110 in 2A only** — ₹7,42,259.46 of IGST and
₹9,55,077.10 of CGST. 106 of the 110 sit in the **March 2026** 2A, which is the
shape the rule predicts: the supplier filed, the 2B cut-off had passed, and the
credit lands in April's 2B. The six Odisha ones (₹12,678.04 of CGST) are the
same documents an earlier comparison had found only in the other tool's sheet.

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

And the **tables** are named differently too, which is worse, because a table
that is not there looks exactly like a table with nothing in it:

| | 2B | 2A |
|---|---|---|
| invoices | `b2b`, `b2ba` | `b2b`, `b2ba` |
| notes | `cdnr`, `cdnra` | **`cdn`**, `cdna` |
| supplier name | `trdnm` | **absent** |

Reading only the 2B names dropped **all 82 credit notes in the client's 29 real
2A files** — ₹4,60,132.52 of CGST and ₹6,13,955.76 of IGST — in silence. Every
alias is read now, and `unreadTables` reports any table in a return that this
tool does not know, so ISD credit or imports turning up is a *stated* gap rather
than a quiet one.

Not one of those 1,093 supplier blocks carried a `trdnm`. 2A has no supplier
names at all, which costs twice over: a blank party in the report, and
`nameScore` returning 0 for exactly the documents that need it most — the
2A-only ones, which have no 2B row to lean on. So a name is borrowed from
another document of the **same supplier GSTIN** that has one. Where a supplier
appears only in 2A there is nothing to borrow, and the party stays blank rather
than being invented.

Both dialects are read now, and the test builds a note in each. When adding a
table, check the key names against a real file of **both** returns — and against
`downloads/gstr2b-tally-poster.mjs`, which has been reading real 2B files for
longer than this tool has.

One more difference, on the arithmetic rather than the keys: a supplier's
**debit note increases** the tax, it does not reduce it. The portal's own
2A-vs-2B sheet adds both kinds into one "CN" figure (₹6,38,291.76 against our
₹6,13,955.76 of IGST — the ₹24,336 of debit notes counted the wrong way). We net
them by `ntty`/`typ`.

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

### A cell that can contradict the tool is worse than a static one

The exported remark used to be a live Excel formula, recomputing itself from
three numbers: the registration, the GST check and the taxable check. That is
not how the verdict is reached. A document the tool called **"probable match —
verify" because the invoice numbers differ** has a GST check of zero and a
taxable check of zero — so Excel overwrote it with "booked" the moment the file
was opened.

Twenty-one Shree Rajasthan Gases documents read `booked` beside a note that
said, in the same row, *"matched on party and amount alone — this can pair the
wrong two"*. The tool's real verdict survived only in the Note, and every count
taken off that column — including two of my own comparisons between runs — was
counting Excel's arithmetic, not the tool's reasoning.

The remark is text now, and a test asserts it is never a formula again. The
arithmetic columns stay live, because they *are* the arithmetic and cannot
disagree with it.

### Dates are evidence too

Two rules came out of the same run:

- **A document dated before the books were read cannot have its voucher in
  them.** Shree Ganesh's `003` of 15-03-2025 — last year's, reported late in the
  April 2025 2B — was married to a books voucher `003` dated 30-10-2025, a
  different invoice of the same number in the next year. The ₹3,83,482.62
  "difference" between them was the largest finding in the sheet and was not a
  finding at all.
- **Among candidates that are otherwise equal, the nearest in date wins.** Shree
  Rajasthan Gases bills ₹216 twenty-one times a year, so every document ties
  with every voucher on amount and the choice fell to file order — pairing a
  January invoice with a May voucher eight months away.

And the export now carries **Bill No (books)** beside **Vch No (books)**. They
are different fields, a match may have been made on either, and a sheet printing
only one cannot be audited: those 21 rows showed voucher `SRG/25-26/S1218`
against document `2025-26/S6569` with no way to see which number, if any, had
agreed.

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
  Three documents in the CGST run were counted twice for ₹71,966.25 — and the
  portal's own tool does the same, so the two sheets agreed on a figure that was
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

### The three sources, reconciled exactly

Three independent statements of the same year's 2B, and every rupee between
them accounted for:

```
GSTN portal, "ITC auto-drafted in GSTR-2B",
returns Apr-25 to Mar-26, all three registrations
                                          IGST 11,07,87,376.84   CGST 3,06,23,349.03
  add reverse charge and blocked ITC
      (the portal's column excludes both)        +42,531.00          +3,42,265.19
  add FY 2025-26 invoices filed late, in
      the April and May 2026 returns            +8,24,214.83         +9,55,077.10
                                          ----------------------------------------
  = this tool                             IGST 11,16,54,122.67   CGST 3,19,20,691.32

  less 2 supplier DEBIT notes Computax
      subtracts instead of adding                -24,336.00                  0.00
  add 3 amendment originals Computax
      counts twice                                     0.00          +71,966.25
                                          ----------------------------------------
  = Computax 2A-vs-2B sheet               IGST 11,16,29,786.67   CGST 3,19,92,657.57
```

Both differences from Computax are ones where the tool is right: an amendment
*restates* a document rather than adding one (rule 9), and a supplier's debit
note *increases* the tax rather than reducing it (rule 5).

### The workbook ties itself out now

Everything above was done by hand. The Excel carries a **Tie-out** sheet that
does it every run: give the portal's "ITC auto-drafted in GSTR-2B" once per
registration in step 4 — typed, or read straight out of the portal's *Tax
liability and ITC comparison* .xlsx — and the sheet walks from that figure to
this tool's, line by line —

```
portal: ITC auto-drafted in GSTR-2B                     (given)
  add reverse charge                        (portal reports it separately)
  add ITC blocked in 2B, itcavl = N         (portal excludes it)
  add invoices filed late, in a return after the year
  add amendments restating a year not read  (portal shows only the change)
  = expected on this tool's basis
  this tool
  difference — nil, or a question
```

### Reading the report instead of retyping it

The figure can be read out of the portal's own workbook. Nothing in that parser
is addressed by cell: the GSTIN is found by its own pattern wherever it sits,
the block by its heading *"ITC auto-drafted in GSTR-2B during the month"*, and
IGST / CGST / SGST by the sub-headings underneath it. A report whose columns
shift by one and is still read without complaint would be worse than one that
fails loudly, so a workbook missing either the heading or those three
sub-headings is refused rather than guessed at.

**It sums the months, never the Total row** — unless no month matches, in which
case it says so. The report covers a whole financial year; a run need not. The
Odisha registration was opened in November, so only four of its twelve rows are
taken; the April and May 2026 returns this tool reads are not in a FY 2025-26
report at all, and are reported as falling outside it rather than silently
dropped. Read this way against the client's 34 returns and their three real
reports, the difference is still **0.00 on every head of every registration**.

### 2A is not in the portal's 2B column

A document that reached GSTR-2A and never reached 2B cannot stand on this tool's
side of the bridge, because the portal's column is *auto-drafted in GSTR-2B*.
Load a year of 2A alongside the 2B and, before this, the difference would have
been the whole of the 2A-only credit. It is now a line of its own —
`less found only in GSTR-2A, never in 2B` — which is also a finding in its own
right: the supplier filed, but the document never became claimable.

Against the client's 34 returns and their three portal reports the difference is
**0.00 on every head of every registration**. The last line of that bridge was
earned: ₹125.82 sat unexplained until it turned out to be a Bharti Airtel
invoice the supplier amended in October 2025 whose original belongs to
FY 2024-25 — a year none of the loaded returns covers.

### Verified against the GST portal's own figures

The client supplied the portal's *Tax liability and ITC comparison* report for
all three registrations — the GSTN's own month-wise statement of ITC auto-drafted
in GSTR-2B. Our parse was compared to it for every one of the 27 return periods:

**In all 27, the difference is exactly the file's reverse-charge block.** No
exceptions, no residue. Put on the portal's own basis — excluding reverse charge
and blocked ITC, counting each document once — the tool's figure ties to the
portal's **per registration, per month, to 0.00**, including Haryana's March
2026, the one file with no `itcsumm` to check itself against. The portal's auto-drafted column excludes inward supplies
liable to reverse charge (they sit in its own RCM sheet); we include them. Add
them back and every period ties to the paisa.

The one period that could not be compared is Haryana's March 2026, whose 2B file
carries no `itcsumm` at all — which the file-check reports as unchecked rather
than assuming it good.

The same report also settles two things the tool had only inferred:

- **Odisha's missing months are genuinely empty.** The portal shows nil for April
  to October and February, so there was no return to download — the per-
  registration coverage rule was right to stay quiet once the books showed
  nothing in them either.
- **Reverse charge needs its own ledgers.** 46 documents in the first full run
  came back "verify" or "not booked" because only the three Input ledgers were
  fetched. That is a statement about which ledgers were picked, not about the
  books, so a reverse-charge document is now set aside and counted when the books
  hold no reverse-charge tax at all — the test being the books themselves, not
  the tick boxes.

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

With all **fourteen** returns per registration loaded (Apr-25 → May-26) against
the 29 of 2A, the year closes on both heads, every difference from the portal's
own 2A-vs-2B summary named:

```
CGST   portal summary, net                         3,19,92,657.57
       less 3 amendment originals it counts twice       -71,966.25
                                                   3,19,20,691.32
       this tool                                   3,19,20,691.32   ✓ 0.00

IGST   portal summary, net                        11,16,29,786.67
       less the 2A-only credit note (in no 2B)         -81,955.37
       add back 2 supplier DEBIT notes it subtracts     +24,336.00
                                                  11,15,72,167.30
       this tool                                  11,15,72,167.30   ✓ 0.00
```

The 110 documents that were "in 2A only" on twelve returns fall to **one** on
fourteen — a credit note the supplier reported in 2A and in no 2B at all, which
is the same ₹81,955.37 the portal's own sheet shows as its only Haryana note
difference.

**Those returns also carry the NEXT year's invoices** — 1,133 of them — and
against this year's books every one would read "booked, but not in 2B". They are
set aside and counted, like a tax head nobody fetched. A document dated *before*
the books window keeps the "widen the fetch" treatment instead, because there the
books probably should have covered it.

### A document's identity includes its financial year

Invoice numbers restart every April. Keying a document on supplier GSTIN +
number alone collapsed three real invoices numbered **003** from one supplier —
15-03-2025, 30-10-2025 and 29-04-2026 — and dropped two of them in silence the
moment the 2026 returns were loaded. Eight documents went that way in all. The
financial year of the document date is part of `docKey`, and of the amendment
lookup (which uses `oidt`, the original's date, so an amendment filed in April
still reaches back into March's year).

This also corrects an earlier reading in this file: of the four documents once
called "counted twice", only three were amendments. `003` was two different
invoices all along.

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

Gaps are reported only *inside* each registration's own loaded range, and only
for months **the books hold entries in**. Odisha was registered in November, and
its February had no documents at all — so there is no return to download and
warning about it is a false alarm the preparer has to dismiss on every run. A
missing month matters when the books can be short against it; otherwise it is
not a finding. With no books loaded yet, every gap is reported, because nothing
is known to rule one out.

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

## Scale

ECLAT is about five thousand documents against five thousand vouchers. SHIVAM
ENTERPRISES books roughly **a hundred and fifty thousand** purchase vouchers
against as many 2B documents — thirty times as many — and that is a different
problem, not a bigger one.

### The matcher

It indexes rather than scans, so it was never a plain N². But the candidate
pool it builds for one document is *every unused voucher of the same supplier*
plus *every one of the same tax amount*, and each of those is then scored,
including a string similarity on the party name. With a few hundred suppliers
and a hundred and fifty thousand rows that is tens of millions of scored
candidates, three times over (the assignment runs in tiers). Measured before
any of the below: it did not finish.

Four changes, none of which move a single match:

1. **The perfect match is taken without searching.** A document agreeing with a
   voucher on invoice number, supplier GSTIN, own registration, tax to within a
   rupee and taxable value has the ranking key `[1,1,1,1,3,…]`. Nothing can beat
   it, and anything that could tie all five leading terms would have to match
   the invoice number too — so the shortcut only fires when exactly **one**
   candidate qualifies. Most of a well-kept book is this case.
2. **Party-name tokens are remembered.** `nameScore` re-tokenised both names on
   every comparison. The answer depends only on the string, and a book has a few
   hundred supplier names, not tens of millions.
3. **Each books row's invoice-number forms are worked out once**, at the point
   the index is built, instead of six regex passes per comparison.
4. **The candidate pool is a list of row numbers**, not an object keyed by
   strings that were then parsed back into numbers.

`reco.test.mjs` runs the same eight-thousand-row book twice, once with the
shortcut and once with it switched off, and requires the two to assign **the
same voucher to the same document in the same category** — a string comparison
of every pair. That is the guarantee: the shortcut is faster, and it cannot
disagree.

Measured in headless Chromium, a book where one document in seven does *not*
line up cleanly (unbooked, wrong amount, or the number typed differently):

| documents | suppliers | before | after |
|---|---|---|---|
| 8,000 | 120 | 1.7 s | 0.7 s |
| 1,50,000 | 800 | did not finish | **19 s** |
| 1,50,000 | 40 | did not finish | **1 m 48 s** |

The last row is the shape that still costs: the residue that does *not* take the
shortcut is searched against every other voucher of the same supplier, so a book
with forty suppliers and a hundred and fifty thousand invoices gives each of
those searches a pool of nearly four thousand. It finishes, and it is honest
about the shape of the problem — concentration of suppliers, not size of book,
is what the matcher feels. Narrowing that pool by amount is **not** available
without changing results: a same-supplier voucher whose invoice number partly
agrees is accepted however far its amount is, and an amount filter would drop
exactly those.

### The workbook

Above **40,000 rows** the Download button asks first, and a second button
appears offering **exceptions only** — the matched rows left out. On the same
hundred-and-fifty-thousand-row book:

| workbook | rows | time | browser memory |
|---|---|---|---|
| everything | 1,50,000 | 36.6 s | 1,421 MB |
| exceptions only | 14,286 | **3.8 s** | **266 MB** |

A gigabyte and a half is survivable on the machine this was measured on and not
on every machine it will run on. Nobody reads a hundred and fifty thousand rows
that agreed, so the exceptions workbook is the useful one anyway — and it says
on its own first sheet that the matched rows are missing, because a file that
quietly dropped them would read as though nothing had reconciled. The Tie-out
sheet still covers the whole 2B either way, which that sheet also says, since
its totals will not add up to the rows in the file.

### A timeout is not a cancel — it is a ten-minute penalty

4.72 knew Tally was serial and still got it wrong, and the screen showed how:
*"waiting for Tally to finish an earlier request… 65s · 16m 17s"*. The one-day
day-book request it sent first died at fifteen seconds; the recovery wait ran
its full ten minutes without the ping ever answering; and the read then carried
on **as though Tally had come back** — into the same backlog, timing out again,
poisoning it again. Two mistakes: the day book was still the *first* thing
asked, and "Tally did not come back" was a return value nobody read.

**4.73** inverts the order and the patience:

- **The ledger shapes go first.** They are the seven-millisecond class of
  question. The day book — the ten-minute class — is consulted only afterwards,
  only as a cross-check, and only when the ledgers were sampled to three days
  quickly *and* what came back was small across all of them (under 1 MB,
  `KNAP_DENSE_SAMPLE_KB`). A book whose ledgers alone answer with megabytes has
  a day book many times that, and it is not asked; the note says the shortcut
  was not cross-checked, which is true and costs nothing.
- **Every leash is long** — three minutes by default — because on a serial
  server the expensive thing is *abandoning* a request, not waiting for it.
- **A window that times out while sizing the sample is the ceiling, not a
  broken shape.** The shape keeps the sample it already has; the ceiling is
  remembered and every ledger's read starts there. Only a shape that cannot
  answer a single day is given up on.
- **"Tally did not come back" stops the read** with the one instruction that
  helps: close and reopen Tally. The connector cannot cancel Tally's work; only
  Tally can.

And one thing the density gate exposed: a shape that ignores the ledger
returns the whole day book, which makes its own sample look dense — and that
would have switched off the very cross-check that used to catch it. It was
accepted, and lost two vouchers. So a shape is now judged **from its own
answer**: asked for three days of one ledger, it is rejected if the answer
holds vouchers from other months, or vouchers that never touch that ledger.
No day book, no size guess — the answer itself is the evidence.

The stub grew two more Tallys. One keeps working on what you abandoned: given
a day-book request or anything wider than four days, it is busy for a while
and every request that arrives before then waits, whatever the client does.
Against it the reader finishes with all 602 ITC vouchers, sends **no** day-book
request, stacks a handful of pings behind the poison rather than dozens of
questions, and learns the ceiling once. The other never comes back: against
it the read stops within the recovery window, having sent at most the one
request that poisoned it, and says to restart Tally.

### Tally's XML server is serial, and a request cannot be taken back

This is the finding that explains every SHIVAM trace before it, and 4.71's own
run is the proof, once you know what to look for:

```
14:07:52.189  liveness probe answered   (1 day, 1 ledger)      7 ms, Tally idle
14:07:52.190  probe: day book, 3 days
14:08:22.197  day book timed out                              abandoned at 30 s
   [silence]  shape 1 sample, 1 day — the SAME request that took 7 ms — 30 s, nothing
   [silence]  shape 2, 30 s. shape 3, 30 s. day-book fallback, 90 s.
14:11:22.225  READ FAILED
```

The identical one-day request answered in seven milliseconds and then timed
out at thirty, with nothing changed but what came before it. **Closing our end
of the connection does not stop Tally.** Its XML server works through requests
one at a time; the abandoned three-day day-book scan kept grinding, and every
request sent afterwards queued behind it. Each "shape that would not answer"
in every trace since 4.69 was the backlog being measured and the question
being blamed. It is also why the liveness probe only ever answered right after
a connector restart — ten minutes after the previous poison had cleared.

Two rules follow, and **4.72** keeps them:

- **nothing that might not come back is sent while a cheaper question could
  settle the matter.** The day book — the request that poisons — is asked for
  **one day** on a fifteen-second leash and widened only while it answers
  quickly, never twenty days on a long one. The Ledger Vouchers report is asked
  before the shape that on ECLAT answered with the entire day book;
- **after any request is given up on, nothing else is sent until a trivial one
  answers again.** One day of one ledger — the seven-millisecond request — is
  asked every ten seconds on a five-second leash, the wait is shown on the
  page, and only then does the read continue. The windowed reader does the same
  after a window times out, instead of retrying narrower into the same backlog.

And every question is now traced *before* it is sent, because a hundred and
eighty seconds of silence in the 4.71 trace was the difference between seeing
this and guessing. When nothing works, the failure lists what every question
got — the day book at one day, each shape's sample, its size, its verdict —
because that list is what the next fix is made from.

The stub grew a serial Tally: once given a request wider than four days, or any
day-book request, it is busy for a while and every request that arrives before
then waits behind it, whatever the client does. Against it the reader finishes
with all 602 ITC vouchers, sends exactly one day-book request, stacks a handful
of pings behind the poison rather than dozens of questions, and learns the
ceiling once.

### It was never refusing — the window was too wide

The liveness probe in 4.70 was built on the belief that Tally would serve no
vouchers for SHIVAM at all. Its first run disproved that in seven milliseconds:

```
13:50:33.768  liveness probe   … "CGST Input Available (RCM)", ms 20000
13:50:33.775  liveness probe answered   {"chars":1497}
```

One day of one ledger: instant. Twenty days of the day book, immediately after:
ninety seconds and nothing. Tally honours the date window. Every question this
tool asked was simply too wide, and asking wide *first* cost ninety seconds
before anything narrower could be tried.

From **4.71** every question starts narrow and widens only while Tally keeps up:

- the **day-book sample** starts at three days and grows to ten and twenty,
  stopping as soon as it holds five ITC vouchers or takes over twelve seconds.
  A width that does not come back leaves the last one that did — a narrower
  sample is still a real sample, and is no reason to declare the day book dead;
- the **shape probe** asks for thirty seconds, not ninety. Where there is no
  day-book sample to compare against, it sizes its own window (1, 3, 9, 27 days)
  until the answer holds vouchers, which is the only way a shape can prove
  itself on a book whose day book will not answer;
- the **full read** walks each ledger in windows that size themselves, doubling
  while Tally keeps up and halving when it labours. One window is held at a
  time, parsed and released.

And a width that has timed out once becomes the **ceiling** for the rest of that
read. Without that the window doubles back to the maximum after every recovery,
times out again and halves again — a sawtooth spending a full timeout on every
climb, which over a year is most of an hour waiting for answers already known
not to come.

A stub Tally that answers four days and never answers more reads a year of
3,000 vouchers in 96 windowed requests, finds all 602 ITC vouchers, and never
falls back to the day book.

### When Tally will not serve vouchers at all

The liveness check earns its place even though SHIVAM turned out not to need it.
On 4.69 that company answered its ledger list in **0.28 seconds** — 708 ledgers,
284,905 characters — and then nothing came back for eight minutes, and there was
no way to tell a Tally that cannot serve vouchers from one that is merely being
asked badly.

That one thing is now asked first, and cheaply. **One day of one ledger** is the
smallest voucher question there is; a healthy Tally answers it in milliseconds
whatever the size of the books, and an *empty* answer counts — what is being
tested is whether Tally responds, not whether that day had entries. The first
shape to answer ends the check, so a healthy site pays one small extra request.
A silent site pays a quick round of all three, then one patient minute in case
the machine is merely slow, and then gives up in about eighty seconds saying what
it found:

> Tally answered the ledger list instantly for this company, then would not
> return even ONE day of ONE ledger's vouchers.

Which is the whole diagnosis. It is not the period, not the size of the request,
and not this tool's memory — and a shorter period, which the old message
suggested, cannot help it.

### The books side is the real limit

The browser is not what gives out first — Tally is. The connector used to fetch
every input-GST ledger's whole-period answer and hold them all before parsing
any, abandoning the shortcut past a 200 MB budget. A book of this size passes
that budget long before it finishes, so the shortcut it had just proved was
thrown away and the day book — which on SHIVAM cannot be read at all — was all
that remained. From v4.69 each ledger is fetched, parsed and released one at a
time: peak memory is one ledger's answer, there is no budget to exceed, and the
size of the books sets how long it takes rather than whether it works.
