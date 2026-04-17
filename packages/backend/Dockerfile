# ── Builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies for the whole monorepo (needed for workspace resolution)
COPY package.json package-lock.json* ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/backend/package.json ./packages/backend/

RUN npm ci --workspace=packages/backend --workspace=packages/sdk --include-workspace-root

# Build SDK first (backend depends on it)
COPY packages/sdk ./packages/sdk
RUN npm run build -w packages/sdk

# Build backend
COPY packages/backend ./packages/backend
RUN npm run build -w packages/backend

# ── Runner ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy production dependencies
COPY package.json package-lock.json* ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/backend/package.json ./packages/backend/

RUN npm ci --workspace=packages/backend --workspace=packages/sdk --include-workspace-root --omit=dev

# Copy compiled output
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist

EXPOSE 3001

CMD ["node", "packages/backend/dist/index.js"]
