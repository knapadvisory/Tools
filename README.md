# KNAP Tools hub — `apps.knapadvisory.com`

One page where every internal tool lives. The Marketplace Fee Register parser
**runs on this site itself** (no TeamHub needed); other web apps link out; the
desktop tools (the ones that must run next to Tally) are downloaded straight
from the page.

Sibling sites: [teamhub.knapadvisory.com](https://teamhub.knapadvisory.com) ·
[hr.teamhub.knapadvisory.com](https://hr.teamhub.knapadvisory.com)

## What's on the page

| Tool | Kind | Where it really lives |
|---|---|---|
| Marketplace Invoice Parser (Amazon/Flipkart/Myntra/Nykaa) | **Hosted here** at `/fee-parser/` | This repo — page `fee-parser/`, API in `server.js`, parser `parser/amazon_invoice_parser.py` (ported from the `Management-tool` repo) |
| AR / Customer Dashboard | Web app (link) | `Dashboard` repo, self-hosted on the TeamHub VPS at <https://dashboard.knapadvisory.com> (Next.js + own Postgres, off Vercel/Neon) |
| Tally Statutory Audit Assistant | **Hosted here** at `/audit/` + local connector | This repo — page `audit/`, engine `connector/knap-tally-audit-engine.mjs` (ported from `Dashboard` branch `claude/tally-audit-tool-24lawp` v1.2) |
| GSTR-2B ⇄ Tally Poster | **Hosted here** at `/gstr2b/` + local connector | This repo — page `gstr2b/`, engine `connector/knap-tally-connector.mjs` (ported from `Dashboard` branch `claude/gstr2b-tally-posting-mqt7zn` v1.7) |
| GSTR-1 Excel Summary | **Hosted here** at `/gstr1/` | This repo — page `gstr1/`, engine `gstr1-engine/` run unmodified as an internal child process, proxied at `/gstr1-api` (from `Dashboard` branch `claude/pdf-excel-extraction-tool-izu1zp`) |
| Debtor / Creditor Consolidation | **Hosted here** at `/debtor-creditor/` + local connector | This repo — page `debtor-creditor/`, engine in `connector/knap-tally-connector.mjs` (`/api/dc/*`). Balances = the closing balance of every ledger under Sundry Debtors / Creditors as on the date, read in one light group-scoped request (ties to Tally's Group Summary; does not hang on big companies). Ageing / bill-wise read the vouchers (FIFO, with reimbursement pass-throughs netted). A company too dense to age voucher-by-voucher (a marketplace book with millions of vouchers) is aged **month-level** instead — Tally's monthly group summaries FIFO'd into buckets (fast, never freezes, still ties to the balance). Reports: consolidated matrix, 80/20 Pareto, ageing, bill-wise summary, party master; master workbook bundles all. |

The desktop tools in `downloads/` are **copies** of the branch files above —
they are what the page serves. When a tool gets a new version, copy the new
file over the one in `downloads/` (keep the same filename), commit, and
redeploy.

## Repo layout

```
index.html            the hub page (self-contained, no build step)
fee-parser/           the hosted Marketplace Fee Register tool page
parser/               amazon_invoice_parser.py (Python, pdfplumber + openpyxl)
gstr2b/               the hosted GSTR-2B ⇄ Tally Poster page (UI only)
audit/                the hosted Tally Statutory Audit Assistant page (UI only)
gstr1/                the hosted GSTR-1 Excel Summary page (UI only)
gstr1-engine/         the GSTR-1 engine, UNMODIFIED single-file tool; server.js
                      runs it as a child on 127.0.0.1:8788 and proxies
                      /gstr1-api to it (state persists in the /data volume)
debtor-creditor/      the hosted Debtor / Creditor Consolidation page (UI only;
                      reads through the connector's /api/dc/* endpoints)
connector/            KNAP Tally Connector: gstr2b engine + supervised audit
                      engine + installer, served OPEN at /connector/
                      (self-update needs no key)
server.js             Express: static site + /api/fee-parser (runs the parser)
downloads/            the files the page serves for download (+ their READMEs)
Dockerfile            node:22-slim + python3, runs server.js on :80
deploy/tools-setup.sh one-command deploy on the TeamHub VPS
```

## The Tally tools (hosted pages + one local connector)

The pages at `/gstr2b/` and `/audit/` are UI only. Everything that must
happen next to Tally (reading the books, posting vouchers, mappings, the
posted-documents register, the audit battery) runs locally on the Tally PC
under the **KNAP Tally Connector**, installed once by
`Install-Tally-Connector.bat` (auto-starts with Windows). Books data flows
browser ↔ engines ↔ Tally on that machine; the server only serves the pages.

- `knap-tally-connector.mjs` — the GSTR-2B engine on `127.0.0.1:8797`, and
  the supervisor: it downloads/starts/restarts the audit engine and keeps
  both files current.
- `knap-tally-audit-engine.mjs` — the audit engine on `127.0.0.1:8799`,
  spawned as a child of the connector.

Both answer only to pages from this site (CORS, incl. Private Network Access
preflights). Self-update: every 6 hours (when idle) the connector compares
`/connector/version.json` (`version` = connector, `audit` = audit engine)
with what's installed, replaces the changed file(s) and restarts. The old
standalone poster's data file is carried over by the installer if found in
`C:\TallyPoster`.

**Releasing a change:** edit the engine file, bump `VERSION` inside it AND
the matching field in `connector/version.json` (keep them equal), commit,
redeploy. Installed connectors pick it up within ~6 hours, or instantly on
their next restart.

## The hosted fee parser

- `POST /api/fee-parser/process` — multipart PDFs → runs the Python parser in a
  temp dir → returns a reconciliation summary + download token.
- `GET /api/fee-parser/download/<token>` — the `Fee_Register.xlsx`. Tokens and
  temp files expire after 15 minutes; nothing is kept.
## Access (site-wide key)

The whole site sits behind one shared **access key**: every page and download
serves a key screen (`gate.html`) until the right key is entered. Enforced on
the server (`server.js`), so downloads and the parser API are covered too — a
stand-in until proper login is wired up.

**Session lifetime.** Signing in is **per tab**: closing the tab (or the
whole browser) means the key is asked again on the next visit — a marker in
`sessionStorage` dies with the tab, and a new/reopened tab gets an opaque
key screen even while the browser-wide cookie is still valid. On top of
that there is a **3-hour** time limit (`TOOLS_SESSION_HOURS` changes it).
Ten minutes before the limit, `session.js` pops up a continue-or-close
warning with a countdown:

- **Continue** → a fresh full session, extended *in place* — nothing on the
  page is reloaded or reset, half-done work stays.
- **Sign out & close** (or the **Sign out** button in the header) → session
  ends, back to the key screen.
- If the countdown hits zero unanswered, the popup asks for the key itself —
  entering it resumes right where the user left off, still without a reload.

In-progress work is lost only on explicit sign-out, pressing
"Sign out & close", closing the tab, or closing the browser.

Sessions are stateless signed tokens (HMAC of the key), so they survive
container restarts, and changing the key signs every browser out at once:
`TOOLS_PASSCODE=newkey bash deploy/tools-setup.sh`. A blank key at the prompt
leaves the site open. Scripts/curl can send the key as an `x-passcode` header
instead of the cookie.

The parser itself is the same tested file TeamHub uses
(`tools/amazon_invoice_parser.py` in the `Management-tool` repo). If it's
improved there, copy the new version into `parser/` here.

## Deploying

Same pattern as KNAP-HRMS (`hr.<domain>`): a container on the `teamhub-net`
Docker network, routed by the shared front Caddy through a
`/etc/teamhub/conf.d/*.caddy` snippet.

On the TeamHub VPS:

```bash
git clone https://github.com/knapadvisory/Tools
cd Tools
bash deploy/tools-setup.sh        # builds image, starts "teamhub-tools", registers Caddy route
```

Then add a DNS **A record** for `apps.knapadvisory.com` pointing at
the same server IP as `teamhub.knapadvisory.com`. Caddy fetches the HTTPS
certificate automatically on first load. (To serve it under a different
name, run the script with `TOOLS_DOMAIN=<domain>`.)

Redeploy after any change:

```bash
git pull && bash deploy/tools-setup.sh
```
