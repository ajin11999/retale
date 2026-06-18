# Retale reverse proxy — Caddy with the LAN Caddyfile and the static POS +
# workshop web bundles baked in, so the distributable stack needs no repo bind
# mounts.
#
# Build with context = repo root, AFTER `bun run build:pos-web` and
# `bun run build:workshop-web` have produced packages/{pos,workshop}/build/web:
#   docker build -f packages/caddy/Dockerfile -t ghcr.io/<owner>/retale-caddy:TAG .
FROM caddy:2

# Reverse-proxy + TLS config (HOST_IP is supplied at container start).
COPY deploy/Caddyfile /etc/caddy/Caddyfile

# Static Flutter POS web/PWA build, served at :8081 (see Caddyfile root *).
COPY packages/pos/build/web /srv/pos-web

# Static Flutter workshop web/PWA build, served at :8082 (see Caddyfile root *).
COPY packages/workshop/build/web /srv/workshop-web
