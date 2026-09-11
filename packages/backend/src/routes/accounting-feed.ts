import { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { authMiddleware } from '../middleware/auth.js'
import { requireAccountingFeed } from '../middleware/accountingFeed.js'
import { accountingFeedAvailability } from '../modules/agents/index.js'
import { getAccountingFeedStatus, getAccountingFeedCounts, syncUser } from '../modules/accounting/index.js'
import { hasLiveConnector } from '../modules/accounting/index.js'
import { hasActiveConnection, verifyPushedPayment, reopenMissingPushed } from '../modules/accounting/index.js'

/**
 * Reporting feed surface for the dashboard (epic #491, P2 #500).
 *
 * Status is NOT hard-gated — the page needs to know whether to render the full
 * UI, an add-on upsell, or hide entirely. The data-moving `/sync` action is
 * gated (404 when unavailable).
 *
 * Verify, reopen, sync and status keep their feed-scoped home here (#2862
 * review, 2026-09-11): they act on the ACTIVE destination, which is the right
 * shape while exactly one is active, so there is no provider-scoped
 * duplicate of them under `/accounting/connections/*`. Internally they
 * dispatch to the active connection's connector `verify()`.
 */
export default async function accountingFeedRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /accounting/feed/status
  app.get('/status', async (request) => {
    const { sub } = request.user as { sub: string }
    // `liveSyncReady` is true when the live Fortnox adapter (#496/#498) is
    // registered (i.e. Fortnox is configured) — false flags the UI that sync
    // is a preview not delivering anywhere. See modules/accounting/connector.ts.
    // #2861: say WHY the feed is or is not available, not only whether. The
    // UI renders three different states from these — off, not entitled, ready —
    // and a bare `available:false` could not tell the second from the first.
    const { available, entitled, entitlementMode } = await accountingFeedAvailability(sub)
    const base = {
      hosted: config.hosted,
      flagEnabled: config.accountingEnabled,
      liveSyncReady: hasLiveConnector(),
      entitled,
      entitlementMode,
    }
    if (!available) {
      return { ...base, available: false, connected: false, syncs: [], counts: { pending: 0, failed: 0, exhausted: 0 } }
    }
    // #2866: `counts` is over EVERY row, not the 100 the list shows — the
    // retry sweep's pending / retryable / given-up numbers.
    const [connected, syncs, counts] = await Promise.all([
      hasActiveConnection(sub),
      getAccountingFeedStatus(sub),
      getAccountingFeedCounts(sub),
    ])
    return { ...base, available: true, connected, syncs, counts }
  })

  // POST /accounting/feed/sync — backfill + retry (gated)
  app.post('/sync', { onRequest: requireAccountingFeed }, async (request) => {
    const { sub } = request.user as { sub: string }
    return syncUser(sub)
  })

  // POST /accounting/feed/reopen/:paymentId — verification-gated reopen
  // (#1365). The ONLY path that ever flips a pushed row back to retryable,
  // and it is conditional on the PROVIDER ITSELF: the server re-runs the
  // #1362 read-back and reopens only when the invoice is confirmed gone (or a
  // number collision made it provably not-ours — same registered:false
  // verdict). An invoice that still exists refuses (409, nothing written) —
  // the double-post guard is preserved because the one added transition is
  // pushed→failed on an invoice the provider says does not exist. The next
  // "Sync now" then re-claims and re-pushes through the normal retry path.
  app.post<{ Params: { paymentId: string } }>(
    '/reopen/:paymentId',
    { onRequest: requireAccountingFeed },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { paymentId } = request.params
      const result = await verifyPushedPayment(sub, paymentId)
      if (!result.ok) {
        return reply.code(409).send({
          error:
            result.error_code === 'not_pushed'
              ? `Nothing to reopen — the payment is not pushed (sync status: ${result.status ?? 'none'}).`
              : result.error_code === 'not_connected'
                ? 'Your accounting software is not connected — reconnect and try again.'
                : 'The sync row carries no invoice reference.',
          error_code: result.error_code,
        })
      }
      if (result.verification.registered) {
        // MUTATION-TESTED: reopening against an EXISTING invoice must refuse —
        // that reopen would re-push a live invoice and double-post.
        return reply.code(409).send({
          error:
            `Invoice ${result.verification.invoice_number} still exists at the provider — reopening would ` +
            'create a duplicate. Nothing was changed.',
          error_code: 'invoice_exists',
          invoice_number: result.verification.invoice_number,
        })
      }
      const reopened = await reopenMissingPushed(
        sub,
        result.provider,
        paymentId,
        // #1376 review: the audit string must not say "no longer exists"
        // about a foreign invoice that exists — distinguish the two verdicts.
        result.verification.missing === 'foreign_invoice'
          ? `reopened ${result.verification.checked_at}: ${result.provider} invoice ${result.verification.invoice_number} belongs to a different external invoice number (company-switch collision) — our record was never delivered under it`
          : `reopened ${result.verification.checked_at}: ${result.provider} invoice ${result.verification.invoice_number} no longer exists`,
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

  // GET /accounting/feed/verify/:paymentId — read-back verification
  // (#1362): confirm against the provider's own records that the pushed
  // supplier invoice exists (registered) and whether a human has booked it
  // (accounted, with the voucher reference). Strictly read-only — asserts
  // nothing, cannot modify the invoice; the non-asserting principle (#491) is
  // untouched. Dispatches to the ACTIVE connection's connector (#2862).
  app.get<{ Params: { paymentId: string } }>(
    '/verify/:paymentId',
    { onRequest: requireAccountingFeed },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const result = await verifyPushedPayment(sub, request.params.paymentId)
      if (!result.ok) {
        return reply.code(409).send({
          error:
            result.error_code === 'not_pushed'
              ? `This payment has not been pushed to your accounting software (sync status: ${result.status ?? 'none'}).`
              : result.error_code === 'not_connected'
                ? 'Your accounting software is not connected — reconnect and try again.'
                : 'The sync row carries no invoice reference.',
          error_code: result.error_code,
          status: result.status,
        })
      }
      return result.verification
    },
  )
}
