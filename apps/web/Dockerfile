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

RUN pnpm install --frozen-lockfile --ignore-scripts

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
