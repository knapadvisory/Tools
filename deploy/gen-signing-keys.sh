#!/usr/bin/env bash
# Generate the Ed25519 keypair used to sign connector releases (security P0).
#
# Run this ONCE, on YOUR OWN machine — NOT on the VPS. The private key must live
# only in a GitHub Actions secret; if it ever sits on the hub/VPS, a compromise
# of that box could forge updates, which is the whole thing we're preventing.
set -euo pipefail

PRIV="connector-signing-private.pem"
PUB="connector-signing-public.pem"
umask 077
openssl genpkey -algorithm ed25519 -out "$PRIV"
openssl pkey -in "$PRIV" -pubout -out "$PUB"

cat <<EOF

============================================================
 Connector signing keypair generated.
============================================================

 1) PRIVATE KEY  ($PRIV)  — secret, never commit it.
    GitHub → this repo → Settings → Secrets and variables →
    Actions → New repository secret:
        Name:   CONNECTOR_SIGNING_KEY
        Value:  the ENTIRE contents of $PRIV (below)
    Then DELETE $PRIV from this machine (keep one offline copy
    somewhere safe if you want a backup — a USB/password manager).

 2) PUBLIC KEY   ($PUB)  — safe to share/commit.
    Send me its contents (below) and I'll paste it into
    UPDATE_PUBLIC_KEY in connector/knap-tally-connector.mjs and
    bump the version — from that release on, every connector
    refuses any update that isn't signed by your private key.

------------------------- PUBLIC KEY -------------------------
$(cat "$PUB")
-------------------------------------------------------------
(The private key is in $PRIV — open it, copy it into the GitHub
 secret, then delete the file.)
============================================================
EOF
