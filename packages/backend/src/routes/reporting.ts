import { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireReportingFeed } from '../middleware/reportingFeed.js'
import { reportingFeedAvailable } from '../lib/entitlements.js'
import { getReportingStatus, syncUser } from '../lib/reporting/feed-orchestrator.js'
import { hasLiveConnector } from '../lib/reporting/connector.js'
import { getFortnoxConnection } from '../lib/fortnox-connection.js'

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
    // `liveSyncReady` is false until the live Fortnox adapter (#496/#498) is
    // registered — the UI uses it to flag that sync is a preview that does not
    // yet deliver to an external tool. See lib/reporting/connector.ts.
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
}
