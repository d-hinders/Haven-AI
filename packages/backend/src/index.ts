// config.ts loads dotenv and validates required env vars — import first
import { config } from './config.js'

import Fastify, { type FastifyError, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import fastifyJwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import { rateLimitKeyFor } from './middleware/rate-limit.js'
import { runMigrations } from './db/migrate.js'
import { runDelegateBalanceMonitor } from './lib/delegate-balance-monitor.js'
import { runScheduleRenewalMonitor } from './lib/schedule-renewal-monitor.js'
import { runRelayerBalanceMonitor, getRelayerBalanceStatus } from './lib/relayer-balance-monitor.js'
import { runIfLeader, LEADER_LOCK_KEYS } from './lib/leader-lock.js'
import { deployableChainIds, SUPPORTED_CHAIN_IDS } from './lib/chains.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/user.js'
import balanceRoutes from './routes/balances.js'
import transactionRoutes from './routes/transactions.js'
import portfolioRoutes from './routes/portfolio.js'
import dashboardRoutes from './routes/dashboard.js'
import safeDetailRoutes from './routes/safe-details.js'
import agentRoutes from './routes/agents.js'
import agentScheduleRoutes from './routes/agent-schedule.js'
import agentRecipientRoutes from './routes/agent-recipients.js'
import hybridAccountRoutes from './routes/hybrid-accounts.js'
import agentDelegationRoutes from './routes/agent-delegations.js'
import agentConnectionSetupRoutes from './routes/agent-connection-setups.js'
import contactRoutes from './routes/contacts.js'
import paymentRoutes from './routes/payments.js'
import approvalRoutes from './routes/approvals.js'
import agentActivityRoutes from './routes/agent-activity.js'
import x402Routes from './routes/x402.js'
import userSafesRoutes from './routes/user-safes.js'
import passkeyRoutes from './routes/passkeys.js'
import safeDeployRoutes from './routes/safe-deploy.js'
import safeExecRoutes from './routes/safe-exec.js'
import x402ResourceRoutes from './routes/x402-resources.js'
import machinePaymentRoutes from './routes/machine-payments.js'
import demoMppRoutes from './routes/demo-mpp.js'
import openapiRoutes from './routes/openapi.js'
import catalogRoutes from './routes/catalog.js'
import analyticsRoutes from './routes/analytics.js'
import accountingRoutes from './routes/accounting.js'
import fortnoxRoutes from './routes/fortnox.js'
import reportingRoutes from './routes/reporting.js'
import { refreshCatalog, type QueryableLike } from './lib/merchant-catalog.js'
import { ingestDiscoveredCatalog } from './lib/catalog-discovery.js'
import { registerAgentToolAuditHooks } from './middleware/agentToolAudit.js'
import { registerAgentLastSeenHook } from './middleware/agentAuth.js'
import pool from './db.js'

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
})

// --- Global error handler ---
app.setErrorHandler((error: FastifyError, request, reply) => {
  const statusCode = error.statusCode ?? 500

  if (statusCode >= 500) {
    request.log.error({ err: error, reqId: request.id }, 'Unhandled server error')
  } else {
    request.log.warn({ err: error, reqId: request.id }, 'Client error')
  }

  reply.status(statusCode).send({
    error: statusCode >= 500 ? 'Internal server error' : error.message,
    statusCode,
  })
})

// --- Process-level error handlers ---
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'Unhandled promise rejection')
})

process.on('uncaughtException', (error) => {
  app.log.fatal({ err: error }, 'Uncaught exception — shutting down')
  process.exit(1)
})

// --- Plugins ---
// CORS:
//   - Browser dashboard: served from `config.frontendUrl`. CORS protects it
//     from other websites making authenticated requests on the user's behalf.
//   - Agent SDK clients: hit `/agents/...` and `/payments/...` from arbitrary
//     hosts (any agent runtime — Claude console, custom servers, MCP, etc.).
//     They authenticate with `Authorization: Bearer sk_agent_*` — that's the
//     real security boundary, not the Origin header.
//
// Reflecting the request origin (or accepting requests with no Origin, which
// is what server-side fetch sends) gives us both: dashboard credential flow
// keeps working, agents from anywhere can authenticate.
await app.register(cors, {
  origin: true,
  credentials: true,
})

await app.register(fastifyJwt, {
  secret: config.jwtSecret,
})

// Rate limiting (#794): registered non-global — only routes that opt in via
// `config.rateLimit` (money-path writes and the public demo reads) are
// limited; dashboard reads stay unthrottled. Keyed per presented credential
// (Authorization or X-API-Key — see rateLimitKeyFor) so each agent gets its
// own bucket regardless of network path; unauthenticated requests fall back
// to per-IP (behind Railway's proxy that can collapse to the proxy IP —
// acceptable for the public demo routes, where a shared throttle still beats
// an open faucet).
await app.register(rateLimit, {
  global: false,
  keyGenerator: (request: FastifyRequest) => rateLimitKeyFor(request),
})

await app.register(openapiRoutes)

// Capture X-Haven-MCP-Tool header and write an agent_tool_invocations row
// whenever an authenticated agent request advertises an MCP tool name. Must
// be registered before routes that decorate request.agent so the onResponse
// hook fires after them.
registerAgentToolAuditHooks(app)

// Record agent liveness (last_seen_at) after each authenticated agent request,
// powering the dashboard "Connected · last seen" indicator. Registered as an
// onResponse hook so it runs after route handlers, never interleaving with
// their queries.
registerAgentLastSeenHook(app)

// --- Routes ---
app.get('/health', async (_request, reply) => {
  const start = Date.now()
  // Cached from the hourly relayer scan — never a live RPC read on a probe.
  const relayer = getRelayerBalanceStatus()
  try {
    await pool.query('SELECT 1')
    const dbLatencyMs = Date.now() - start
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      db: { status: 'ok', latencyMs: dbLatencyMs },
      relayer,
    }
  } catch (err) {
    reply.status(503)
    return {
      status: 'degraded',
      timestamp: new Date().toISOString(),
      db: { status: 'error', error: err instanceof Error ? err.message : String(err) },
      relayer,
    }
  }
})

// Public chain config (#679): which chains this environment serves account
// deploys on, so the onboarding / Add-account pickers offer only those. Not
// sensitive — no auth.
app.get('/chains', async () => {
  return { deployable: deployableChainIds(), supported: SUPPORTED_CHAIN_IDS }
})

await app.register(authRoutes, { prefix: '/auth' })
await app.register(userRoutes, { prefix: '/user' })
await app.register(balanceRoutes, { prefix: '/balances' })
await app.register(transactionRoutes, { prefix: '/transactions' })
await app.register(portfolioRoutes, { prefix: '/portfolio' })
await app.register(dashboardRoutes, { prefix: '/dashboard' })
await app.register(safeDetailRoutes, { prefix: '/safe' })
await app.register(agentRoutes, { prefix: '/agents' })
await app.register(agentScheduleRoutes, { prefix: '/agents' })
await app.register(agentRecipientRoutes, { prefix: '/agents' })
await app.register(hybridAccountRoutes, { prefix: '/accounts' })
await app.register(agentDelegationRoutes, { prefix: '/agents' })
await app.register(agentConnectionSetupRoutes, { prefix: '/agent-connection-setups' })
await app.register(contactRoutes, { prefix: '/contacts' })
await app.register(paymentRoutes, { prefix: '/payments' })
await app.register(approvalRoutes, { prefix: '/approvals' })
await app.register(agentActivityRoutes, { prefix: '/agent-activity' })
await app.register(x402Routes, { prefix: '/x402' })
await app.register(userSafesRoutes, { prefix: '/user/safes' })
await app.register(passkeyRoutes, { prefix: '/passkeys' })
await app.register(safeDeployRoutes, { prefix: '/safe' })
await app.register(safeExecRoutes, { prefix: '/safe' })
await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
await app.register(x402ResourceRoutes, { prefix: '/x402' })
await app.register(catalogRoutes, { prefix: '/catalog' })
await app.register(analyticsRoutes, { prefix: '/analytics' })
await app.register(accountingRoutes, { prefix: '/accounting' })
await app.register(fortnoxRoutes, { prefix: '/accounting/fortnox' })
await app.register(reportingRoutes, { prefix: '/accounting/reporting' })
// Public demo — no auth hook, registered separately
await app.register(demoMppRoutes, { prefix: '/demo/mpp' })

// --- Start ---
const CATALOG_REFRESH_INTERVAL_MS = 60 * 60 * 1000 // hourly
const DELEGATE_MONITOR_INTERVAL_MS = 60 * 60 * 1000 // hourly (#714)

const start = async () => {
  try {
    await runMigrations()
    app.log.info('Database migrations complete')

    await app.listen({ port: config.port, host: '0.0.0.0' })
    app.log.info(`Haven backend running on port ${config.port}`)

    // Every periodic tick below runs behind a Postgres advisory lock
    // (runIfLeader) so a multi-replica deployment executes each scan exactly
    // once per tick instead of once per replica — the monitors' edge-trigger
    // alert state is per-process memory, so N replicas would otherwise send
    // up to N copies of every webhook alert.

    // Catalog price verification: probe listed merchants hourly so the
    // catalog never advertises stale prices or dead endpoints. Best-effort —
    // a failed run logs and waits for the next tick.
    const runCatalogRefresh = async () => {
      try {
        await runIfLeader(LEADER_LOCK_KEYS.catalogRefresh, async () => {
          // Opt-in: pull fresh candidates from the x402 Bazaar and probe-ingest
          // them before re-verifying the catalog, so newly discovered merchants are
          // included in the same run. Best-effort — discovery failure never blocks
          // the refresh of already-listed entries.
          if (config.catalogDiscoveryEnabled) {
            try {
              const discovery = await ingestDiscoveredCatalog(pool as unknown as QueryableLike)
              app.log.info(discovery, 'Merchant catalog discovery complete')
            } catch (err) {
              app.log.warn({ err }, 'Merchant catalog discovery failed')
            }
          }
          const { verified, degraded } = await refreshCatalog()
          app.log.info({ verified, degraded }, 'Merchant catalog refreshed')
        })
      } catch (err) {
        app.log.warn({ err }, 'Merchant catalog refresh failed')
      }
    }
    void runCatalogRefresh()
    setInterval(runCatalogRefresh, CATALOG_REFRESH_INTERVAL_MS).unref()

    // Delegate balance monitor (#714): hourly read-only scan of every active
    // agent's delegate USDC balance — WARNs on lingering (sweepable) balances
    // and on aggregate dust past the threshold. Best-effort: a failed scan
    // logs and waits for the next tick. It never moves funds.
    const runDelegateMonitor = async () => {
      try {
        await runIfLeader(LEADER_LOCK_KEYS.delegateBalanceMonitor, async () => {
          await runDelegateBalanceMonitor(app.log)
        })
      } catch (err) {
        app.log.warn({ err }, 'Delegate balance monitor scan failed')
      }
    }
    void runDelegateMonitor()
    setInterval(runDelegateMonitor, DELEGATE_MONITOR_INTERVAL_MS).unref()

    // Schedule-renewal notifications (#803): hourly, edge-triggered — pushes
    // the renewal prompt (dashboard banner is pull-based) via webhook when a
    // budget window is down to its last periods. At most two per window.
    const runRenewalMonitor = async () => {
      try {
        await runIfLeader(LEADER_LOCK_KEYS.scheduleRenewalMonitor, async () => {
          await runScheduleRenewalMonitor(app.log)
        })
      } catch (err) {
        app.log.warn({ err }, 'Schedule renewal monitor scan failed')
      }
    }
    void runRenewalMonitor()
    setInterval(runRenewalMonitor, DELEGATE_MONITOR_INTERVAL_MS).unref()

    // Relayer balance monitor: hourly read-only scan of the relayer EOA's
    // native balance per served chain — structured warning + edge-triggered
    // webhook alert below the low-water mark, cached status served by
    // /health. The relayer going dry previously surfaced only as failing
    // payments. Deliberately NOT behind runIfLeader: the scan result feeds
    // each replica's own /health response, and the alert edge-trigger is the
    // per-chain lowAlerted set inside the monitor, so duplicate alerts are
    // bounded by replica count only on the low→ok→low transition.
    const runRelayerMonitor = async () => {
      try {
        await runRelayerBalanceMonitor(app.log)
      } catch (err) {
        app.log.warn({ err }, 'Relayer balance monitor scan failed')
      }
    }
    void runRelayerMonitor()
    setInterval(runRelayerMonitor, DELEGATE_MONITOR_INTERVAL_MS).unref()
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
