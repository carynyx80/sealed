# syntax=docker/dockerfile:1.7
# Sealed Launchpad API — Railway / any Docker host.
# Build context MUST be the monorepo root:   docker build -f apps/api/Dockerfile -t sealed-api .
# (railway.json sets dockerfilePath accordingly; Railway builds from the repo root.)

ARG NODE_VERSION=22
ARG PNPM_VERSION=12.23.0

############################
# 1) deps + build
############################
FROM node:${NODE_VERSION}-slim AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app

# Manifests first for layer caching.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma

# Only the API and its workspace deps (@sealed/shared).
# (No BuildKit cache mount: Railway requires service-scoped cache ids.)
RUN pnpm install --frozen-lockfile --filter "@sealed/api..."

COPY packages/shared packages/shared
COPY apps/api apps/api
# Program IDL (programs/sealed-launchpad/idl/sealed_launchpad.json, committed by the contracts workspace;
# used by workers for tx building when not in demo mode).
COPY programs/sealed-launchpad/idl programs/sealed-launchpad/idl

RUN pnpm --filter @sealed/shared build \
 && pnpm --filter @sealed/api exec prisma generate \
 && pnpm --filter @sealed/api exec tsc -p tsconfig.json
# Fail the build if sharp's prebuilt linux-x64 (glibc) binary + bundled libvips were not installed
# (pnpm picks the platform optional dep @img/sharp-linux-x64 at install time inside this container).
RUN cd apps/api && node -e "import('sharp').then(async ({default: s}) => { await s({create:{width:64,height:64,channels:3,background:'#000'}}).webp().toBuffer(); console.log('sharp ok, libvips', s.versions.vips); })"

# Note: dev deps are intentionally kept — the `prisma` CLI is needed at boot for `db push`.

############################
# 2) runtime
############################
FROM node:${NODE_VERSION}-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=4000 HOST=0.0.0.0
WORKDIR /app

COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/programs/sealed-launchpad/idl programs/sealed-launchpad/idl

RUN useradd --system --uid 10001 --home /app sealed && chown -R sealed /app
USER sealed
WORKDIR /app/apps/api
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Apply migrations when a database is configured, then boot. Memory/demo mode needs no DB.
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ] && [ -f node_modules/prisma/build/index.js ]; then node node_modules/prisma/build/index.js db push --skip-generate || echo '[boot] prisma db push skipped/failed — continuing'; fi; exec node dist/server.js"]
