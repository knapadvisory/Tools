# Static hub page + tool downloads, served by Caddy on :80.
# Built and run on the TeamHub VPS by deploy/tools-setup.sh.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html
COPY downloads/ /srv/downloads/
