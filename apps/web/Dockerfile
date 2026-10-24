# HaHart web image (OP-07): build the static export, serve it with nginx.
#
# Build context is the repository root (see deploy/docker-compose.yml):
#   context: ..
#   dockerfile: apps/web/Dockerfile

# ── Stage 1: build apps/web/out ─────────────────────────────────────
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@10.26.2 --activate

WORKDIR /app

# Workspace manifests first, so the dependency layer is cached.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/config/package.json packages/config/

# Network tuning for the registry (OP-06/OP-07 deploy reliability). Measured on
# the .37 host (2026-10-24): concurrent downloads from registry.npmjs.org get
# ECONNRESET and per-package speed collapses to 3-47 KiB/s, while a single
# threaded curl of the same 47MB tarball reaches 2.2 MB/s -- so the bandwidth is
# fine and the failures are aborted parallel connections without enough retries.
# Lower the concurrency and raise the retry/timeout budget instead.
ARG NPM_NETWORK_CONCURRENCY=8
ARG NPM_FETCH_RETRIES=6
ARG NPM_FETCH_TIMEOUT=120000
# The default registry stays the official one; pass
# `--build-arg NPM_REGISTRY=<mirror>` to build against a mirror instead
# (measured on .37: the official registry serves only ~30 KiB/s).
ARG NPM_REGISTRY=https://registry.npmjs.org

RUN pnpm install --frozen-lockfile --ignore-scripts \
    --network-concurrency=$NPM_NETWORK_CONCURRENCY \
    --fetch-retries=$NPM_FETCH_RETRIES \
    --fetch-timeout=$NPM_FETCH_TIMEOUT \
    --registry=$NPM_REGISTRY

COPY packages/shared/ packages/shared/
COPY packages/config/ packages/config/
COPY apps/web/ apps/web/

# NEXT_PUBLIC_* values are inlined at build time (webpack DefinePlugin), so they
# are build arguments rather than runtime environment.
# `same-origin` makes getServerBaseUrl() return "" so the bundle only calls the
# serving host through deploy/nginx.conf (OP-07 acceptance).
ARG NEXT_PUBLIC_SERVER_BASE_URL=same-origin
ARG NEXT_PUBLIC_HAHART_AUTH_PROVIDER=self
ENV NEXT_PUBLIC_SERVER_BASE_URL=${NEXT_PUBLIC_SERVER_BASE_URL}
ENV NEXT_PUBLIC_HAHART_AUTH_PROVIDER=${NEXT_PUBLIC_HAHART_AUTH_PROVIDER}

RUN pnpm --filter @loomic/shared build
RUN pnpm --filter @loomic/web build

# ── Stage 2: serve /app/apps/web/out with the same-origin proxy ─────
FROM nginx:1.27-alpine AS production

COPY --from=build /app/apps/web/out /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
