# ── Builder ────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies for the workspace slice the server needs.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/mcp-server/package.json ./packages/mcp-server/

RUN npm ci --workspace=packages/mcp-server --workspace=packages/sdk --include-workspace-root

# Build SDK first (mcp-server consumes its built output).
COPY packages/sdk ./packages/sdk
RUN npm run build -w packages/sdk

# Build the hosted MCP server.
COPY packages/mcp-server ./packages/mcp-server
RUN npm run build -w packages/mcp-server

# ── Runner ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Production dependencies only.
COPY package.json package-lock.json* ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/mcp-server/package.json ./packages/mcp-server/

RUN npm ci --workspace=packages/mcp-server --workspace=packages/sdk --include-workspace-root --omit=dev

# Compiled output.
COPY --from=builder /app/packages/sdk/dist ./packages/sdk/dist
COPY --from=builder /app/packages/mcp-server/dist ./packages/mcp-server/dist

# Hosted MCP listens on $PORT (default 8788). Railway sets PORT automatically;
# locally Compose forwards 8788. The CLI reads HAVEN_API_URL to relay through.
EXPOSE 8788

# Custody: the hosted server is keyless by construction. The CLI refuses to
# boot if HAVEN_DELEGATE_KEY is in the environment — see src/cli.ts.
CMD ["node", "packages/mcp-server/dist/cli.js"]
