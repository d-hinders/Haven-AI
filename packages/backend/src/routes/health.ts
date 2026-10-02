import type { FastifyInstance } from 'fastify'
import { matchesOpsToken } from '../middleware/ops-token.js'
import type { AccountingOpsCounters } from '../modules/accounting/index.js'
import { requestValidationOpsSnapshot } from '../openapi/request-validation.js'

// The payload SHAPE lives in `health-payload-types.ts` (#3514): a minimal
// module the ops console's `GET /ops/health` can import WITHOUT reaching
// `infra/relayer*`, which this route module imports — the ops invariant-1
// walk (`__tests__/ops.invariants.test.ts`) bounds the ops graph. The shape
// types are re-declared there, structurally identical to the interfaces the
// producer modules export; the assignability pin in `health.test.ts` fails
// on a drift.
export type {
  HealthOpsPayload,
  HealthOpsInputs,
  HealthOpsAccounting,
  HealthRelayerStatus,
  HealthPassportReadiness,
  HealthRequestValidationSnapshot,
} from './health-payload-types.js'
import type { HealthOpsPayload, HealthOpsAccounting } from './health-payload-types.js'

// Named by the modules that produce them (#3030: the `typeof import(...)`
// forms these replaced counted against the request-schemas gauge).
import type { RelayerBalanceStatus } from '../infra/relayer-balance-monitor.js'
import type { PassportReadiness } from '../modules/passport/index.js'
type RelayerStatus = RelayerBalanceStatus[]
type PassportStatus = PassportReadiness

export interface HealthRouteOptions {
  checkDatabase: () => Promise<unknown>
  getRelayerStatus: () => RelayerStatus
  getPassportStatus: () => PassportStatus
  trustProxyHops: number
  opsToken: string
  /**
   * The accounting feed's on-call numbers (#2872, widened by #3019):
   * exhausted sync rows, connections needing a user's hand, and the
   * Accounted webhook receiver's in-process counters. Two aggregate
   * queries plus an in-memory read, no per-user data. Behind the same
   * operator token as everything else here.
   */
  getAccountingCounters: () => Promise<AccountingOpsCounters>
}

/**
 * What `/health/ops` reports for `accounting`: the counters, or — when the
 * aggregate queries throw — all three `null` with `unavailable: true`. The
 * siblings on the payload are in-memory reads that cannot throw; the two
 * integer counters are the database round-trip, and a database that is down
 * must not take the relayer and passport diagnostics with it (that is
 * exactly when on-call reads them).
 */
export type HealthRouteAccounting = HealthOpsAccounting

const ACCOUNTING_UNAVAILABLE: HealthOpsAccounting = {
  exhaustedSyncs: null,
  connectionsNeedingAttention: null,
  webhookCounters: null,
  unavailable: true,
}

/**
 * The `/health/ops` payload, built by ONE function (#3514): the route serves
 * it behind the operator token, and `GET /ops/health` embeds it as
 * `ops_diagnostics`. The same construction — same degradations, same
 * in-memory reads — is the point: the two answers cannot disagree about what
 * the backend's own diagnostics say. The accounting catch is the route's
 * documented behaviour (health.test.ts "degrades accounting"), kept here
 * where the payload is built.
 */
export async function buildHealthOpsPayload(options: HealthRouteOptions, log?: { warn(obj: unknown, msg: string): void }): Promise<HealthOpsPayload> {
  let accounting: HealthOpsAccounting
  try {
    accounting = await options.getAccountingCounters()
  } catch (err) {
    // The error's class only — never its message, which can carry SQL or a host name.
    log?.warn({ errName: err instanceof Error ? err.name : 'non-error' }, 'health/ops accounting counters unavailable')
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
    // The request-validation shadow counter (#3029): mode, would-refuse
    // total, and the per route+field breakdown. In-memory read, cannot
    // throw; per-process by design (no generic counter module exists).
    request_validation: requestValidationOpsSnapshot(),
  }
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

    // The accounting catch lives in the builder (health.test.ts "degrades
    // accounting"): a database error must not 500 the whole payload, because
    // that is exactly when on-call reads the in-memory siblings.
    return await buildHealthOpsPayload(options, request.log)
  })
}
