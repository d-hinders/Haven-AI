import { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireReportingFeed } from '../middleware/reportingFeed.js'
import { reportingFeedAvailable } from '../modules/agents/index.js'
import { getReportingStatus, syncUser } from '../modules/reporting/index.js'
import { hasLiveConnector } from '../modules/reporting/index.js'
import { getFortnoxConnection, verifyFortnoxInvoice, reopenMissingPushed } from '../modules/reporting/index.js'

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

  // POST /accounting/reporting/reopen/:paymentId — verification-gated reopen
  // (#1365). The ONLY path that ever flips a pushed row back to retryable,
  // and it is conditional on Fortnox ITSELF: the server re-runs the #1362
  // read-back and reopens only when the invoice is confirmed gone (or a
  // number collision made it provably not-ours — same registered:false
  // verdict). An invoice that still exists refuses (409, nothing written) —
  // the double-post guard is preserved because the one added transition is
  // pushed→failed on an invoice the provider says does not exist. The next
  // "Sync now" then re-claims and re-pushes through the normal retry path.
  app.post<{ Params: { paymentId: string } }>(
    '/reopen/:paymentId',
    { onRequest: requireReportingFeed },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { paymentId } = request.params
      const result = await verifyFortnoxInvoice(sub, paymentId)
      if (!result.ok) {
        return reply.code(409).send({
          error:
            result.error_code === 'not_pushed'
              ? `Nothing to reopen — the payment is not pushed (sync status: ${result.status ?? 'none'}).`
              : result.error_code === 'not_connected'
                ? 'Fortnox is not connected — reconnect and try again.'
                : 'The sync row carries no Fortnox invoice reference.',
          error_code: result.error_code,
        })
      }
      if (result.verification.registered) {
        // MUTATION-TESTED: reopening against an EXISTING invoice must refuse —
        // that reopen would re-push a live invoice and double-post.
        return reply.code(409).send({
          error:
            `Fortnox invoice ${result.verification.invoice_number} still exists — reopening would ` +
            'create a duplicate. Nothing was changed.',
          error_code: 'invoice_exists',
          invoice_number: result.verification.invoice_number,
        })
      }
      const reopened = await reopenMissingPushed(
        sub,
        'fortnox',
        paymentId,
        // #1376 review: the audit string must not say "no longer exists"
        // about a foreign invoice that exists — distinguish the two verdicts.
        result.verification.missing === 'foreign_invoice'
          ? `reopened ${result.verification.checked_at}: Fortnox invoice ${result.verification.invoice_number} belongs to a different external invoice number (company-switch collision) — our record was never delivered under it`
          : `reopened ${result.verification.checked_at}: Fortnox invoice ${result.verification.invoice_number} no longer exists`,
      )
      if (!reopened) {
        // The row moved between the verification and the flip (raced by a
        // concurrent reopen/sync) — report honestly rather than pretending.
        return reply.code(409).send({
          error: 'The sync row is no longer in a pushed state — nothing was changed.',
          error_code: 'not_pushed',
        })
      }
      return { reopened: true, payment_id: paymentId, next: 'Run "Sync now" to push it again.' }
    },
  )

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
