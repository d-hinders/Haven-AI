/**
 * `POST /machine-payments/reconciliation-events` — in its OWN route file so
 * the request-validation rollout can hold it in shadow while the rest of
 * `routes/machine-payments.ts` is enforced (#3031, epic #3028 slice 3).
 *
 * **The owner decision.** Epic #3028, 2026-09-24T21:24:44Z, closing #3223:
 * this operation is the rollout's NAMED RESIDUE — it "stays shadowed". It is
 * only posted on a genuine merchant rejection after a confirmed payment;
 * driving it synthetically would write a false record into a payment's
 * ledger (`modules/mpp/reconciliation.ts` upserts into
 * `machine_payment_reconciliation_events`). It waits for a real rejection or
 * a QA scenario that produces one, and the `dev → main` promotion checklist
 * says so (`docs/operations/promoting-dev-to-main.md`).
 *
 * **Why a separate file.** Enforcement is keyed on the route FILE
 * (#3135/#3167: one file = one `enforcedModules` entry, resolved per
 * operation through `route-modules.generated.ts`), and the plugin has no
 * per-operation opt-out — its `onRoute` hook stamps
 * `config.havenRequestValidation` on every route it touches. While this
 * route lived in `routes/machine-payments.ts`, flipping that file for the
 * slice enforced it too (round-1 review, CHANGES REQUESTED). The split is
 * the mechanism file keying offers: the rest of the machine-payments surface
 * enforces on the slice's instrument, and this operation stays shadowed
 * until a real rejection drives it. The `lint:request-schemas` gauge reads
 * the file the same way the plugin does, so its `shadow: 1` entry for THIS
 * file is the honest record of the residue — an in-file exception would have
 * read as `shadow: 0` while the route ran in shadow.
 *
 * **The shape rungs STAY here.** An enforced module may delete its
 * hand-rolled shape checks — the spec refuses first. A SHADOWED route must
 * not: shadow's promise is "no behaviour change on any currently-accepted
 * request" (a would-refusal is logged and the request CONTINUES), so the
 * checks the enforced siblings moved into the spec remain the answer here.
 * They are the pre-#3031 rungs verbatim; when the route is one day enforced
 * on a real-rejection reading, this file deletes them exactly the way its
 * siblings did.
 */

import { FastifyInstance } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import {
  handleReconciliationEvent,
  RECONCILIATION_EVENT_TYPES,
  type ReconciliationEventBody,
} from '../modules/mpp/index.js'

export default async function machinePaymentsReconciliationEventsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  // The Body generic stays the module's own `ReconciliationEventBody`: this
  // route is SHADOWED (owner decision above), so no injected schema
  // guarantees the fields before the handler — the rungs below do. A NAMED
  // generic is unnecessary here (the route-modules extractor matches
  // `app.post(` up to the first quote and this generic carries no string
  // literals), but the registration stays one literal `app.post` call like
  // every route file, per the #3135 extractor.
  app.post<{ Body: ReconciliationEventBody }>(
    '/reconciliation-events',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const {
        paymentId,
        rail,
        eventType,
        txHash,
        reason,
        details,
      } = request.body

      if (!paymentId || typeof paymentId !== 'string') {
        return reply.code(400).send({ error: 'paymentId is required' })
      }
      if (!rail || typeof rail !== 'string') {
        return reply.code(400).send({ error: 'rail is required' })
      }
      if (!eventType || !RECONCILIATION_EVENT_TYPES.has(eventType)) {
        return reply.code(400).send({ error: 'Unsupported reconciliation event type' })
      }
      if (txHash !== undefined && (
        typeof txHash !== 'string' ||
        !/^0x[0-9a-fA-F]{64}$/.test(txHash)
      )) {
        return reply.code(400).send({ error: 'txHash must be a 0x-prefixed transaction hash' })
      }
      if (reason !== undefined && typeof reason !== 'string') {
        return reply.code(400).send({ error: 'reason must be a string' })
      }
      if (details !== undefined && (
        !details ||
        typeof details !== 'object' ||
        Array.isArray(details)
      )) {
        return reply.code(400).send({ error: 'details must be an object' })
      }

      // The SEMANTIC layer — payment ownership, state agreement, the
      // duplicate-report rule — is `modules/mpp/reconciliation.ts`. That is
      // also why this route must never be driven synthetically for a shadow
      // reading (#3223): a forced event reports a merchant rejection that
      // did not happen.

      const result = await handleReconciliationEvent(
        agent.id,
        paymentId,
        rail,
        eventType,
        txHash,
        reason,
        details,
      )
      return reply.code(result.statusCode).send(result.body)
    },
  )
}
