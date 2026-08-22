// config.ts loads dotenv and validates required env vars — import first
import { config } from './config.js'
import { httpErrorHandler } from './infra/http-error-handler.js'

import Fastify, { type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import fastifyJwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import { rateLimitKeyFor } from './middleware/rate-limit.js'
import { SharedRateLimitStore, setRateLimitDegradedReporter } from './middleware/shared-rate-limit-store.js'
import { deleteExpiredRateLimits } from './infra/repositories/rate-limit-counters.js'
import { runMigrations } from './db/migrate.js'
import { runDelegateBalanceMonitor } from './infra/delegate-balance-monitor.js'
import { runRelayerBalanceMonitor, getRelayerBalanceStatus } from './infra/relayer-balance-monitor.js'
import { runIfLeader, LEADER_LOCK_KEYS } from './platform/leader-lock.js'
import { deployableChainIds, SUPPORTED_CHAIN_IDS } from './domain/chains.js'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/user.js'
import balanceRoutes from './routes/balances.js'
import transactionRoutes from './routes/transactions.js'
import portfolioRoutes from './routes/portfolio.js'
import dashboardRoutes from './routes/dashboard.js'
import safeDetailRoutes from './routes/safe-details.js'
import agentRoutes from './routes/agents.js'
import hybridAccountRoutes from './routes/hybrid-accounts.js'
import agentDelegationRoutes from './routes/agent-delegations.js'
import agentPassportRoutes from './routes/agent-passports.js'
import {
  setAnchor,
  setAnchorRecovery,
  setAnchorLiveness,
  anchorOnChain,
  recoverAnchorFromReceipt,
  classifyAnchorTxLiveness,
  setRevoker,
  revokeOnChain,
  setRevocationProbe,
  readRevocationAnchor,
  setReceiptSigningKey,
  passportReadiness,
  logPassportReadiness,
  retryPendingPassports,
  reconcilePendingRevocations,
  listStuckRevocations,
} from './modules/passport/index.js'
import passportVerifyRoutes from './routes/passport-verify.js'
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
import openapiRoutes from './routes/openapi.js'
import catalogRoutes from './routes/catalog.js'
import analyticsRoutes from './routes/analytics.js'
import accountingRoutes from './routes/accounting.js'
import fortnoxRoutes from './routes/fortnox.js'
import reportingRoutes from './routes/reporting.js'
import { registerConnector } from './modules/reporting/index.js'
import { FortnoxConnector } from './modules/reporting/index.js'
import { fortnoxConfigured } from './modules/reporting/index.js'
import { refreshCatalog, type QueryableLike } from './modules/catalog/index.js'
import { ingestDiscoveredCatalog } from './modules/catalog/index.js'
import { registerAgentToolAuditHooks } from './middleware/agentToolAudit.js'
import { registerAgentLastSeenHook } from './middleware/agentAuth.js'
// dep-lint-exempt: composition root — owns the pool for the /health liveness probe (SELECT 1) and hands it to the leader-gated catalog jobs at boot; it wires infrastructure rather than running tenant SQL
import pool from './db.js'

const app = Fastify({
  logger: {
    level: config.logLevel,
  },
  // #1670: a hop COUNT, not `true` — see the note on trustProxyHops in
  // config.ts. 0 → false → request.ip stays the socket peer, exactly as
  // before this option existed.
  trustProxy: config.trustProxyHops > 0 ? config.trustProxyHops : false,
})

// --- Global error handler (extracted for testability, #1464) ---
app.setErrorHandler(httpErrorHandler)

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
// to per-IP. With TRUST_PROXY_HOPS unset that per-IP fallback collapses to
// the proxy address behind Railway — acceptable for the public demo routes,
// where a shared throttle still beats an open faucet, and the reason the
// auth tier (#1670) refuses to arm itself until the proxy is trusted.
// #1680: the shared Postgres-backed store replaces the plugin's in-process
// LRU. With the default store each replica counted only its own share of the
// traffic, so the real ceiling was `max × replicas` and it ROSE with load —
// live probing of dev read x-ratelimit-remaining back as two interleaved
// descending series. The store is fail-open and deadline-bounded: a database
// problem degrades to the old per-replica counting rather than locking anyone
// out of signup or login.
await app.register(rateLimit, {
  global: false,
  keyGenerator: (request: FastifyRequest) => rateLimitKeyFor(request),
  store: SharedRateLimitStore,
})

setRateLimitDegradedReporter((reason) => {
  app.log.warn({ reason }, 'Rate-limit store fell back to per-replica counting (#1680)')
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
  // Passport configuration state (#1151). Pure env/config read, no chain or DB
  // access. Booleans plus the already-published issuer address — never key
  // material, never the schema UID. Reported on the degraded branch too: a
  // passport misconfiguration is exactly the thing an operator is looking for
  // when they curl /health, and losing it because Postgres is slow would repeat
  // the failure this field exists to end.
  const passport = passportReadiness()
  // Trust-proxy state (#1670). The auth rate-limit tier arms only when the
  // process actually READS a hop count > 0 — and whether it does is invisible
  // from outside: on the first dev rollout the operator set the variable, the
  // service kept answering, and 32 probe logins still went unthrottled because
  // the running process predated the env change. This field ends that class of
  // guessing. Not secret: the setting is documented in .env.example, and the
  // hop count reveals topology no more than any traceroute would.
  const trustProxy = { hops: config.trustProxyHops, authRateLimitArmed: config.trustProxyHops > 0 }
  try {
    await pool.query('SELECT 1')
    const dbLatencyMs = Date.now() - start
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      db: { status: 'ok', latencyMs: dbLatencyMs },
      relayer,
      passport,
      trustProxy,
    }
  } catch (err) {
    reply.status(503)
    return {
      status: 'degraded',
      timestamp: new Date().toISOString(),
      db: { status: 'error', error: err instanceof Error ? err.message : String(err) },
      relayer,
      passport,
      trustProxy,
    }
  }
})

// Public chain config (#679): which chains this environment serves account
// deploys on, so the onboarding / Add-account pickers offer only those. Not
// sensitive — no auth.
app.get('/chains', async () => {
  return { deployable: deployableChainIds(), supported: SUPPORTED_CHAIN_IDS }
})

// L0 passport attestations are anchored AND revoked by the gas-only relayer
// (#972 / #973). Both are governance metadata: EAS-only targets, zero value.
setAnchor(anchorOnChain)
setAnchorRecovery(recoverAnchorFromReceipt)
// A null receipt is not evidence the attest was dropped (#1745). The re-mint
// is unlocked only by this probe finding the transaction's nonce burned by
// something else; anything less leaves the passport retryable rather than
// minting a second live credential.
setAnchorLiveness(classifyAnchorTxLiveness)
setRevoker(revokeOnChain)
// A revoke that mines after its 120 s wait expired has no other way to close
// (#1758): EAS reverts every later revoke of the same UID, so the only fresh
// attempt that could observe success can never succeed. This probe reads the
// attestation's revoked bit as of a settled block instead, which converges the
// row without broadcasting anything. Unwired, it degrades to the pre-#1758
// behaviour — a stuck `pending` row, never a wrong `confirmed` one.
setRevocationProbe(readRevocationAnchor)
// Receipts the merchant-facing verifier hands out (#974) are signed with a
// DEDICATED key, never the relayer's: the relayer pays gas for user-authorised
// transactions, while this one signs public assertions and its address is
// published for pinning. Unset means verification is off, and the endpoint
// fails closed rather than serving an unsigned receipt.
// Refuses at boot if it IS the relayer key — the static invariant test reads
// source, so only a runtime check can catch that operator copy-paste.
setReceiptSigningKey(process.env.PASSPORT_RECEIPT_SIGNING_KEY ?? null, [
  config.relayerPrivateKey,
  ...SUPPORTED_CHAIN_IDS.map((id) => process.env[`RELAYER_PRIVATE_KEY_${id}`]),
])
// Warn — once, at boot — when this deployment anchors passports it cannot
// verify (#1151). Silent in every other combination. Must run AFTER the signer
// is installed above, or it would warn on every deployment.
logPassportReadiness(app.log)

await app.register(authRoutes, { prefix: '/auth' })
await app.register(userRoutes, { prefix: '/user' })
await app.register(balanceRoutes, { prefix: '/balances' })
await app.register(transactionRoutes, { prefix: '/transactions' })
await app.register(portfolioRoutes, { prefix: '/portfolio' })
await app.register(dashboardRoutes, { prefix: '/dashboard' })
await app.register(safeDetailRoutes, { prefix: '/safe' })
await app.register(agentRoutes, { prefix: '/agents' })
await app.register(hybridAccountRoutes, { prefix: '/accounts' })
await app.register(agentDelegationRoutes, { prefix: '/agents' })
await app.register(agentPassportRoutes, { prefix: '/agents' })
// Public and unauthenticated (#974): the caller is a merchant deciding whether
// to serve an agent, and it has no Haven account. Registered separately from
// the dashboard-authed passport routes so the auth hook cannot be assumed.
await app.register(passportVerifyRoutes, { prefix: '/passport' })
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
// #496: the live Fortnox feed adapter. Registering it flips hasLiveConnector()
// → true, which removes the Reporting page's "preview" banner. Gated on env:
// deployments without Fortnox credentials keep the feed inert (no-op), same
// posture as before this landed.
if (fortnoxConfigured()) {
  registerConnector(new FortnoxConnector())
}
// #1328: the legacy /demo/mpp/* MPP demo route is retired (see
// modules/mpp/challenge.ts's mppDemoRetired() for the authorize-side refusal).

// --- Start ---
const CATALOG_REFRESH_INTERVAL_MS = 60 * 60 * 1000 // hourly

/**
 * #1680: the sweep only reclaims space — every read already filters on expiry,
 * so a late run costs dead rows, never a wrong count. Five minutes keeps the
 * table small without adding a chatty query to a busy database.
 */
const RATE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60 * 1000
const DELEGATE_MONITOR_INTERVAL_MS = 60 * 60 * 1000 // hourly (#714)
// Every 5 minutes, not hourly: this sweep carries revocation reconciliation,
// and the backoff schedule it drives starts at 30s. An hourly tick would flatten
// that to an hour, leaving a revoked agent's attestation live on-chain far
// longer than the retry policy intends (#973).
const PASSPORT_SWEEP_INTERVAL_MS = 5 * 60 * 1000
/** A revoke still unreconciled after this long is an incident, not a retry. */
const PASSPORT_STUCK_REVOKE_SECONDS = 60 * 60

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

    // Expired rate-limit counters (#1680): nothing else removes them, and the
    // table is written by UNAUTHENTICATED traffic — so without a sweep,
    // unbounded growth is reachable by anyone with a script and a supply of
    // source addresses. Leader-gated like every tick here; a missed run only
    // leaves dead rows, never a wrong count, because every read filters on
    // expiry.
    const runRateLimitSweep = async () => {
      try {
        await runIfLeader(LEADER_LOCK_KEYS.rateLimitSweep, async () => {
          const deleted = await deleteExpiredRateLimits()
          if (deleted > 0) app.log.debug({ deleted }, 'Swept expired rate-limit counters')
        })
      } catch (err) {
        app.log.warn({ err }, 'Rate-limit counter sweep failed')
      }
    }
    void runRateLimitSweep()
    setInterval(runRateLimitSweep, RATE_LIMIT_SWEEP_INTERVAL_MS).unref()

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

    // Outbound-tx bump/replacement worker (#1558, epic #1554): per served
    // chain, close broadcast rows the chain has already decided, replace the
    // truly stuck ones with bumped fees, and adopt orphaned queued rows from
    // a submitter that died mid-flight. Leader-locked: replacements are
    // same-nonce broadcasts, and two replicas bumping the same lane would
    // race each other's replacements.
    const OUTBOUND_BUMP_INTERVAL_MS = 60_000
    const runOutboundBump = async () => {
      try {
        await runIfLeader(LEADER_LOCK_KEYS.outboundBump, async () => {
          const { runOutboundBumpTick, productionBumpDeps } = await import('./infra/outbound-bump-worker.js')
          const deps = await productionBumpDeps()
          const chains = deployableChainIds()
          for (const chainId of chains) {
            const tick = await runOutboundBumpTick(chainId, deps, app.log)
            if (tick.bumped || tick.closedMined || tick.closedFailed || tick.rebroadcastOrphans || tick.alerted) {
              app.log.info({ chainId, ...tick }, 'Outbound bump tick acted')
            }
          }
        })
      } catch (err) {
        app.log.warn({ err }, 'Outbound bump tick failed')
      }
    }
    void runOutboundBump()
    setInterval(runOutboundBump, OUTBOUND_BUMP_INTERVAL_MS).unref()

    // L0 passport anchor sweep (#972 / #973). Both halves of issuance are
    // fire-and-forget by design — an EAS write must never block agent creation
    // or an owner's revoke — which only holds because something later retries
    // what the in-request attempt dropped. This is that something; without it
    // "best-effort + retryable" is just "best-effort".
    //
    // The revocation half is the one that matters for safety: an agent revoked
    // in Haven's DB whose attestation is still live on-chain is precisely the
    // divergence #973 exists to close, and a merchant checking only the chain
    // would still see it as valid. So a revoke that stays unreconciled past
    // the alarm threshold is logged as an operational incident rather than
    // retried silently forever.
    // The three phases are INDEPENDENT. Sequencing them under one try/catch
    // meant a throw in the issuance retry skipped both the revocation
    // reconciliation and the stuck-revoke alarm for that tick — and since the
    // queues are oldest-first, one poison row would be first on every tick and
    // silence the safety-critical half permanently. The alarm especially must
    // run even when everything above it is failing: that is when it matters.
    const phase = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (err) {
        app.log.warn({ err, phase: name }, 'Passport sweep phase failed')
      }
    }

    const runPassportSweep = async () => {
      try {
        await runIfLeader(LEADER_LOCK_KEYS.passportSweep, async () => {
          await phase('issuance', async () => {
            const issuance = await retryPendingPassports()
            if (issuance.attempted) app.log.info(issuance, 'Passport issuance retries')
            if (issuance.needingAttention) {
              app.log.warn(
                { needingAttention: issuance.needingAttention },
                'Passport issuance rows past the attention threshold — investigate, the backoff is capped',
              )
            }
          })
          await phase('revocation', async () => {
            const revocations = await reconcilePendingRevocations()
            if (revocations.attempted) app.log.info(revocations, 'Passport revocation reconciliation')
          })
          await phase('alarm', async () => {
            const stuck = await listStuckRevocations(PASSPORT_STUCK_REVOKE_SECONDS)
            if (stuck.length > 0) {
              app.log.warn(
                { count: stuck.length, agents: stuck.slice(0, 10) },
                'Passport revocations unreconciled past threshold — agents revoked in Haven still hold a live attestation on-chain',
              )
            }
          })
        })
      } catch (err) {
        // Only leader-election itself reaches here now.
        app.log.warn({ err }, 'Passport sweep failed')
      }
    }
    void runPassportSweep()
    setInterval(runPassportSweep, PASSPORT_SWEEP_INTERVAL_MS).unref()
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
