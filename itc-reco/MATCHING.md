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

## 2. A short number is a number, but it is not evidence on its own

Candidates under two characters used to be dropped, so Maa Kalyani's invoice
**6** (taxable ₹1,34,964) could not be found even though the books held the
same number, party and tax. They are kept now, and the acceptance rule asks
for length: an invoice number carries a pair by itself only when the agreeing
part is at least two characters. `6` ↔ `6` still needs the party or the tax to
agree, because two unrelated suppliers both have a sixth bill.

## 3. The credit follows the tax, not the taxable value

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

## 4. A remark must be a finding, not a hedge

The second tool the client compared against was, in their words, "more
reliable and concise with no extra comments". That is the standard. Every
hedge spends the preparer's attention, and there is a fixed amount of it.

- Don't say *verify* about something the numbers have already confirmed.
- Don't say *amount mismatch* when the amounts agree to the paisa.
- Do say *matched on party and amount alone* when that is all there is —
  Ultratech billed ₹8,424.00 eleven times over, and `913900250` paired with
  voucher `913900258` on nothing but the party and the value.

## 5. Each kind of wrong gets its own bucket

*ITC taken in the wrong registration* is not an amount mismatch. Three ECLAT
documents had identical figures on both sides and read "booked — amount
mismatch" with a difference of 0.00, because the registration branch
overwrote the remark whatever the figures said. `wrongreg` is its own
category; when the figures are *also* wrong, the note says both.

## 6. Nothing in the input may be silently dropped

Every one of these was a bug that presented as a wall of false findings:

- **Tax heads.** Books fetched for the IGST ledger alone, against a 2B file
  carrying CGST/SGST too, reported ~2,100 intra-state documents as "not in
  books". The tool now asks which heads to reconcile, and documents outside
  that choice are **set aside and counted** — never dropped, never reported as
  unbooked.
- **Period coverage.** A 2B document dated outside the window the books were
  read for is a period gap, not an unbooked invoice.
- **TDS and round off.** Neither belongs in the taxable base. A voucher's TDS
  deduction was inflating it; the giveaway was that 18% of the base without
  TDS equalled the IGST exactly.

## 7. Recall gaps are not all matcher gaps

142 documents worth ₹12.37 lakh appeared in the other tool's sheet and not in
ours. Before touching the matcher: **119 of them were dated March 2026**, and
their source file included 2A, not 2B alone. That is an input difference. Only
the remaining handful were ours to fix — and they were the assignment-order
and short-number bugs above.

Always separate the two before concluding the matching is weak.

---

## Open, and honestly not done

- **2A is not read.** We reconcile 2B. A document that appears only in 2A will
  read as not booked. Worth stating on the page, or supporting.
- **The Tally-side ITC filter is proved only against a stub.** Three TDL
  shapes are tried in order and each is validated against an unfiltered sample
  window, which is why `/api/itc/diagnose` exists. Output from a real Tally
  with the fastest shape failing has still not been seen, so tier 1 is
  untested in the field.
- **Credit notes** are reported separately but not netted against the invoice
  they relate to.
- **Nothing ages the unmatched.** A 2B document unbooked for five months is
  reported the same as one unbooked for five days.

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
