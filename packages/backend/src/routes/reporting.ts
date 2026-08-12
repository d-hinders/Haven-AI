import { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireReportingFeed } from '../middleware/reportingFeed.js'
import { reportingFeedAvailable } from '../modules/agents/index.js'
import { getReportingStatus, syncUser } from '../modules/reporting/index.js'
import { hasLiveConnector } from '../modules/reporting/index.js'
import { getFortnoxConnection, verifyFortnoxInvoice } from '../modules/reporting/index.js'

/**
 * Reporting feed surface for the dashboard (epic #491, P2 #500).
 *
 * Status is NOT hard-gated — the page needs to know whether to render the full
 * UI, an add-on upsell, or hide entirely. The data-moving `/sync` action is
 * gated (404 when unavailable).
 */
export default async function reportingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /accounting/reporting/status
  app.get('/status', async (request) => {
    const { sub } = request.user as { sub: string }
    // `liveSyncReady` is true when the live Fortnox adapter (#496/#498) is
    // registered (i.e. Fortnox is configured) — false flags the UI that sync
    // is a preview not delivering anywhere. See lib/reporting/connector.ts.
    const base = {
      hosted: config.hosted,
      flagEnabled: config.reportingFeedEnabled,
      liveSyncReady: hasLiveConnector(),
    }
    const available = await reportingFeedAvailable(sub)
    if (!available) {
      return { ...base, available: false, connected: false, syncs: [] }
    }
    const [conn, syncs] = await Promise.all([getFortnoxConnection(sub), getReportingStatus(sub)])
    return { ...base, available: true, connected: Boolean(conn), syncs }
  })

  // POST /accounting/reporting/sync — backfill + retry (gated)
  app.post('/sync', { onRequest: requireReportingFeed }, async (request) => {
    const { sub } = request.user as { sub: string }
    return syncUser(sub)
  })

  // GET /accounting/reporting/verify/:paymentId — read-back verification
  // (#1362): confirm against Fortnox's own records that the pushed supplier
  // invoice exists (registered) and whether a human has booked it (accounted,
  // with the voucher reference). Strictly read-only — asserts nothing, cannot
  // modify the invoice; the non-asserting principle (#491) is untouched.
  app.get<{ Params: { paymentId: string } }>(
    '/verify/:paymentId',
    { onRequest: requireReportingFeed },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const result = await verifyFortnoxInvoice(sub, request.params.paymentId)
      if (!result.ok) {
        return reply.code(409).send({
          error:
            result.error_code === 'not_pushed'
              ? `This payment has not been pushed to Fortnox (sync status: ${result.status ?? 'none'}).`
              : result.error_code === 'not_connected'
                ? 'Fortnox is not connected — reconnect and try again.'
                : 'The sync row carries no Fortnox invoice reference.',
          error_code: result.error_code,
          status: result.status,
        })
      }
      return result.verification
    },
  )
}
