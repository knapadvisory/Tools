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
| AR / Customer Dashboard | Web app (link) | `Dashboard` repo `main`, deployed at <https://dashboard-knap1.vercel.app> |
| Tally Statutory Audit Assistant | Desktop download | `Dashboard` repo, branch `claude/tally-audit-tool-24lawp` (`tools/`) |
| GSTR-2B ⇄ Tally Poster (v1.7) | Desktop download | `Dashboard` repo, branch `claude/gstr2b-tally-posting-mqt7zn` (`tools/`) |
| GSTR-1 Excel Summary | Desktop download | `Dashboard` repo, branch `claude/pdf-excel-extraction-tool-izu1zp` (`tools/`) |

The desktop tools in `downloads/` are **copies** of the branch files above —
they are what the page serves. When a tool gets a new version, copy the new
file over the one in `downloads/` (keep the same filename), commit, and
redeploy.

## Repo layout

```
index.html            the hub page (self-contained, no build step)
fee-parser/           the hosted Marketplace Fee Register tool page
parser/               amazon_invoice_parser.py (Python, pdfplumber + openpyxl)
server.js             Express: static site + /api/fee-parser (runs the parser)
downloads/            the files the page serves for download (+ their READMEs)
Dockerfile            node:22-slim + python3, runs server.js on :80
deploy/tools-setup.sh one-command deploy on the TeamHub VPS
```

## The hosted fee parser

- `POST /api/fee-parser/process` — multipart PDFs → runs the Python parser in a
  temp dir → returns a reconciliation summary + download token.
- `GET /api/fee-parser/download/<token>` — the `Fee_Register.xlsx`. Tokens and
  temp files expire after 15 minutes; nothing is kept.
- **Access**: open by default. To require a shared team passcode, deploy with
  `TOOLS_PASSCODE=something bash deploy/tools-setup.sh` — the page then asks
  for it once and remembers it in the browser. (The passcode is remembered in
  `/root/knap-tools.env` on the VPS for future redeploys.)

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
