import type { FastifyInstance } from 'fastify'
import { matchesOpsToken } from '../middleware/ops-token.js'
import type { AccountingOpsCounters } from '../modules/accounting/index.js'

type RelayerStatus = ReturnType<typeof import('../infra/relayer-balance-monitor.js')['getRelayerBalanceStatus']>
type PassportStatus = ReturnType<typeof import('../modules/passport/index.js')['passportReadiness']>

export interface HealthRouteOptions {
  checkDatabase: () => Promise<unknown>
  getRelayerStatus: () => RelayerStatus
  getPassportStatus: () => PassportStatus
  trustProxyHops: number
  opsToken: string
  /**
   * The accounting feed's two on-call numbers (#2872): exhausted sync rows
   * and connections needing a re-consent. Two aggregate queries, no per-user
   * data. Behind the same operator token as everything else here.
   */
  getAccountingCounters: () => Promise<AccountingOpsCounters>
}

/**
 * What `/health/ops` reports for `accounting`: the two counters, or — when the
 * aggregate queries throw — both `null` with `unavailable: true`. The siblings
 * on the payload are in-memory reads that cannot throw; the counters are the
 * one database round-trip, and a database that is down must not take the
 * relayer and passport diagnostics with it (that is exactly when on-call
 * reads them).
 */
export type HealthOpsAccounting =
  | (AccountingOpsCounters & { unavailable?: false })
  | { exhaustedSyncs: null; connectionsNeedingAttention: null; unavailable: true }

const ACCOUNTING_UNAVAILABLE: HealthOpsAccounting = {
  exhaustedSyncs: null,
  connectionsNeedingAttention: null,
  unavailable: true,
}

/** Register the public liveness probe and the separately authenticated operator diagnostics. */
export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  app.get('/health', async (_request, reply) => {
    const start = Date.now()
    try {
      await options.checkDatabase()
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        db: { status: 'ok', latencyMs: Date.now() - start },
      }
    } catch {
      reply.status(503)
      return {
        status: 'degraded',
        timestamp: new Date().toISOString(),
        db: { status: 'error' },
      }
    }
  })

  app.get('/health/ops', async (request, reply) => {
    // An unconfigured deployment must not advertise an operator endpoint.
    if (!options.opsToken) return reply.status(404).send()

    const candidate = request.headers['x-haven-ops-token']
    const token = Array.isArray(candidate) ? candidate[0] : candidate
    if (!matchesOpsToken(options.opsToken, token)) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }

    // MUTATION TARGET (health.test.ts "degrades accounting"): without this
    // catch a database error 500s the whole payload, siblings included.
    let accounting: HealthOpsAccounting
    try {
      accounting = await options.getAccountingCounters()
    } catch (err) {
      // The error's class only — never its message, which can carry SQL or a host name.
      request.log.warn({ errName: err instanceof Error ? err.name : typeof err }, 'health/ops accounting counters unavailable')
      accounting = ACCOUNTING_UNAVAILABLE
    }

    return {
      relayer: options.getRelayerStatus(),
      passport: options.getPassportStatus(),
      trustProxy: {
        hops: options.trustProxyHops,
        authRateLimitArmed: options.trustProxyHops > 0,
      },
      accounting,
    }
  })
}
