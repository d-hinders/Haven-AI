/**
 * Safe-rail retirement — the INFLOW refusal (#1984, epic #1440 slice 1).
 *
 * Owner decision 2026-08-14, phasing approved 2026-08-24: the Safe /
 * AllowanceModule rail is retired outright, not frozen. This slice closes
 * exactly one thing — the inflow. **No new Safe account can be created or
 * imported.** Four entry points could mint or attach one, and all four now
 * refuse with HTTP 410:
 *
 * - `POST /safe/deploy`        — passkey-owned Safe deployment
 * - `POST /user/safes/deploy`  — relay-sponsored, wallet-owned Safe deployment
 * - `POST /user/safes`         — importing / registering an existing Safe
 * - `PUT  /user/safe`          — the legacy single-Safe link, which is also an
 *                                import: it wrote `user_safes` through
 *                                `linkDefaultUserSafe` and emitted the
 *                                `safe_imported` funnel event. No shipped
 *                                client calls it, which is exactly why it
 *                                would have been the hole left open.
 *
 * **Why a shared handler and not a per-route stub (#1988, slice 5).** #1984
 * shipped this as a route `preHandler` so the live handler bodies underneath
 * could stay verbatim for the deletion slices to remove. Those bodies are now
 * gone, so there is nothing left to run ahead of: a `preHandler` guarding an
 * empty handler is a guard over an empty set, which is the exact shape this
 * retirement exists to clean up. Each closed inflow is therefore registered
 * with `retiredSafeInflowHandler(kind)` as its ONE handler — no second code
 * path, nothing to reach around, and the refusal body still has exactly one
 * producer (`safeRailRetired`). A tombstone per route would have duplicated
 * that producer four times.
 *
 * 410 rather than 404, per the #834 session-rail and #1328 mpp_demo
 * precedents: a permanently-gone flow should not read as a transient routing
 * error that invites retries. `safeRailRetired()` is the single producer of
 * the refusal body.
 *
 * **What this deliberately does NOT do** — each is a later slice of #1440:
 * - it does not stop an EXISTING Safe account from paying. That is #1986's
 *   410 on /payments + x402, sequenced after this one on purpose, so an
 *   `allowance_module` account keeps working until that slice lands;
 * - it removes no rail code — that is #1987;
 * - it drops no data (#1990). `user_safes` rows and the `account_type` /
 *   `execution_rail` columns stay: Hybrid lives in the same table, and the
 *   rail seam stays for reversibility.
 *
 * **Updated by #1988 (slice 5).** The deploy/import handler bodies these
 * refusals used to shadow are deleted, and so is the approver surface. What
 * remains at each of the four addresses is this tombstone and nothing else.
 * Every READ and every EDIT of an existing account is still untouched —
 * listing, renaming, re-defaulting, unlinking, balances and history behave
 * exactly as before, and `POST /safe/exec` (owner-signed execution) stays
 * open, which is how an owner still moves funds out of an account they hold.
 */

import type { FastifyReply, FastifyRequest } from 'fastify'

/** Which entry point refused — only the closing clause differs. */
export type SafeInflowKind = 'deploy' | 'import'

export function safeRailRetired(kind: SafeInflowKind): {
  statusCode: 410
  body: { error: string }
} {
  return {
    statusCode: 410,
    body: {
      error:
        kind === 'deploy'
          ? 'The Safe rail is retired — Haven no longer creates Safe accounts. ' +
            'Create a Haven account on the delegation rail instead (POST /accounts/hybrid).'
          : 'The Safe rail is retired — a Safe can no longer be imported into Haven. ' +
            'Create a Haven account on the delegation rail instead (POST /accounts/hybrid).',
    },
  }
}

/**
 * The handler for a closed Safe inflow. Register it as the route's only
 * handler:
 *
 *   app.post('/deploy', retiredSafeInflowHandler('deploy'))
 *
 * Auth still runs first: `authMiddleware` is an `onRequest` hook on each of
 * these route modules, and Fastify's lifecycle runs onRequest before the
 * handler — so an anonymous caller gets 401, not 410. That ordering is
 * asserted in `routes/__tests__/safe-inflow-retired.test.ts`, not assumed.
 */
export function retiredSafeInflowHandler(
  kind: SafeInflowKind,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply> {
  return async (_request: FastifyRequest, reply: FastifyReply) => {
    const retired = safeRailRetired(kind)
    return reply.code(retired.statusCode).send(retired.body)
  }
}
