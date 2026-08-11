# KNAP Tools hub — `apps.knapadvisory.com`

One page where every internal tool lives. Web apps link out; desktop tools
(the ones that must run next to Tally) are downloaded straight from this page.

Sibling sites: [teamhub.knapadvisory.com](https://teamhub.knapadvisory.com) ·
[hr.teamhub.knapadvisory.com](https://hr.teamhub.knapadvisory.com)

## What's on the page

| Tool | Kind | Where it really lives |
|---|---|---|
| Marketplace Invoice Parser (Amazon/Flipkart/Myntra/Nykaa) | Web app | Inside TeamHub — `Management-tool` repo, **🧰 KNAP Tools** nav item |
| AR / Customer Dashboard | Web app | `Dashboard` repo `main`, deployed at <https://dashboard-knap1.vercel.app> |
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
downloads/            the files the page serves for download (+ their READMEs)
Dockerfile            caddy:2-alpine serving index.html + downloads/ on :80
Caddyfile             in-container config (force-download for .bat/.mjs, no-cache)
deploy/tools-setup.sh one-command deploy on the TeamHub VPS
```

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
