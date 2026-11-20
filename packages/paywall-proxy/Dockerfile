# syntax=docker/dockerfile:1
#
# The merchant kit's paywall proxy as a container image (#5007).
#
# Build from the REPOSITORY ROOT, because the workspace slice spans three
# packages:
#
#   docker build -f packages/paywall-proxy/Dockerfile -t haven-paywall-proxy .
#
# The slice is `sdk`, `merchant-payments` and `paywall-proxy`, and nothing else:
# `paywall-proxy`'s build script builds the SDK and the shared merchant payment
# core first, and `tsup` externalises the three packages' runtime dependencies
# (they are `dependencies` in their package.json files), so the runner installs
# production dependencies only and copies the three `dist` trees.
#
# `node:sqlite` is loaded at runtime through `createRequire`
# (`src/sqlite-store.ts`), and it is built into Node 24 — there is no native
# module to compile, which is why the alpine base needs no build toolchain.
#
# ONE PROCESS PER STORE. The proxy opens `PAYMENTS_DB` with
# `PRAGMA locking_mode=EXCLUSIVE` and a startup write transaction, and refuses
# to start while another process holds it (`StoreLockedError`, design §12). So:
#
#   - one container per `/data` volume;
#   - stop the old container before starting the new one;
#   - never scale above one replica on a volume;
#   - `report-sale` and `check` run with the proxy container stopped.
#
# BACKUP. Back `/data` up like a ledger — a disk snapshot, or the in-process
# `backup()`. An external `sqlite3 .backup` cannot run while the proxy holds the
# lock.
#
# The ignore file beside this one is `Dockerfile.dockerignore`, not a root
# `.dockerignore`: a root one would change the mcp-server image's build context
# (`.github/workflows/ci.yml`, the MCP-server job). It also keeps Haven's own
# demo configuration (`demo/`) out of the published image: the image carries the
# kit and `products.example.json`, and a merchant supplies its own products file
# at `/config/products.json`.

# ── Builder ────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies for the workspace slice the proxy needs. Only the
# package.json files are copied first, so this layer is cached until a
# dependency changes.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/merchant-payments/package.json ./packages/merchant-payments/
COPY packages/paywall-proxy/package.json ./packages/paywall-proxy/

RUN npm ci --workspace=packages/paywall-proxy --workspace=packages/merchant-payments --workspace=packages/sdk --include-workspace-root

# The sources. `paywall-proxy`'s build script builds the SDK and the shared
# merchant payment core first (`npm --prefix ../sdk run build`,
# `npm --prefix ../merchant-payments run build:self`), then bundles the CLI.
COPY packages/sdk ./packages/sdk
COPY packages/merchant-payments ./packages/merchant-payments
COPY packages/paywall-proxy ./packages/paywall-proxy

RUN npm run build -w packages/paywall-proxy

# ── Runner ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Production dependencies only. `@haven_ai/sdk` arrives through
# `@haven_ai/merchant-payments`'s `dependencies`, so `--omit=dev` still installs
# it; `@x402/extensions` is a test-only devDependency and is not needed here.
COPY package.json package-lock.json* ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/merchant-payments/package.json ./packages/merchant-payments/
COPY packages/paywall-proxy/package.json ./packages/paywall-proxy/

RUN npm ci --workspace=packages/paywall-proxy --workspace=packages/merchant-payments --workspace=packages/sdk --include-workspace-root --omit=dev

# Compiled output. The three packages are external to the bundle, so their
# `dist` trees are what `node_modules/@haven_ai/*` resolves into.
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder /app/packages/merchant-payments/dist ./packages/merchant-payments/dist
COPY --from=builder /app/packages/paywall-proxy/dist ./packages/paywall-proxy/dist

# The image's paths (#5006's defaults sit on top of these): the products file is
# the merchant's own, mounted read-only at `/config/products.json`; the store and
# the sales outbox live on `/data`, which is the volume. `SALES_OUTBOX` is unset
# on purpose — its default is `sales-outbox.jsonl` beside `PAYMENTS_DB`, so it
# lands at `/data/sales-outbox.jsonl` without a second setting.
ENV PRODUCTS_FILE=/config/products.json \
    PAYMENTS_DB=/data/payments.sqlite

# The non-root user. `node` (uid 1000) ships with the base image; `/data` and
# `/config` are created and chowned HERE, before `VOLUME`, so a fresh named
# volume inherits their ownership. Declaring the volume first would put the
# `chown` in an anonymous volume instead of the image layer, and a named volume
# mounted later would copy a root-owned `/data`.
RUN mkdir -p /data /config && chown node:node /data /config

# `/data` is the volume. A NAMED volume is the recommended mount: Docker copies
# the image directory's ownership into a fresh named volume, so the non-root user
# below can write it. A host-directory bind mount is the second choice, and it
# has two caveats: the host directory must be writable by uid 1000, and SQLite
# file locking across Docker Desktop bind mounts on macOS is not dependable.
VOLUME ["/data"]

USER node

EXPOSE 8080

# The pilot terms, carried where a registry and a `docker inspect` can read them
# (#5009's wording). The kit stays `"private": true` and nothing goes to npm.
LABEL org.opencontainers.image.title="Haven paywall proxy" \
      org.opencontainers.image.description="The Haven merchant kit's paywall proxy: x402 in front of any HTTP API, settled through Haven's shared merchant payment core. A merchant in Haven's pilot may run and modify the kit to evaluate Haven. Do not redistribute it. A licence comes before general availability." \
      org.opencontainers.image.source="https://github.com/d-hinders/Haven-AI" \
      org.opencontainers.image.documentation="https://github.com/d-hinders/Haven-AI/blob/dev/packages/paywall-proxy/README.md" \
      org.opencontainers.image.licenses="UNLICENSED"

# The existing CLI is the entrypoint, so the subcommands run through it:
#   docker run … <image> report-sale 0x…
#   docker run … <image> check
#   docker run … <image> nonsense   → the usage line, exit 2
ENTRYPOINT ["node", "packages/paywall-proxy/dist/index.js"]
