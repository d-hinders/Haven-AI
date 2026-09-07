# ── Builder ────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* tsconfig.base.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/frontend/package.json ./packages/frontend/

RUN npm ci --workspace=packages/frontend --workspace=packages/core --include-workspace-root

# Build the Next.js app
COPY packages/core ./packages/core
RUN npm run build -w packages/core

COPY packages/frontend ./packages/frontend

# The four product docs the frontend serves as Markdown under /docs/ (#2532).
# `next.config.ts` generates them at build time by READING these sources, so a
# build context without them fails hard with ENOENT — not a soft 404. Build
# stage only: the runtime image copies `.next/standalone`, `.next/static` and
# `public/`, so the sources are discarded with the rest of this stage and the
# generated copies travel inside `public/`.
# `served-docs.test.ts` asserts this COPY covers every allowlisted source.
COPY docs ./docs

ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build -w packages/frontend

# ── Runner ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

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
