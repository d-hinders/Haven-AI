import type { FastifyInstance } from 'fastify'
import { matchesOpsToken } from '../middleware/ops-token.js'

type RelayerStatus = ReturnType<typeof import('../infra/relayer-balance-monitor.js')['getRelayerBalanceStatus']>
type PassportStatus = ReturnType<typeof import('../modules/passport/index.js')['passportReadiness']>

export interface HealthRouteOptions {
  checkDatabase: () => Promise<unknown>
  getRelayerStatus: () => RelayerStatus
  getPassportStatus: () => PassportStatus
  trustProxyHops: number
  opsToken: string
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

    return {
      relayer: options.getRelayerStatus(),
      passport: options.getPassportStatus(),
      trustProxy: {
        hops: options.trustProxyHops,
        authRateLimitArmed: options.trustProxyHops > 0,
      },
    }
  })
}
