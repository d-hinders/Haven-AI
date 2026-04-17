# ── Builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
COPY packages/frontend/package.json ./packages/frontend/

RUN npm ci --workspace=packages/frontend --include-workspace-root

# Build the Next.js app
COPY packages/frontend ./packages/frontend

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build -w packages/frontend

# ── Runner ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/.next/static ./packages/frontend/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/packages/frontend/public ./packages/frontend/public

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "packages/frontend/server.js"]
