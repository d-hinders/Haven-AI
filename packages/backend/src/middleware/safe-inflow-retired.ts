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
 * **Why a preHandler and not an early `return` in each handler.** The refusal
 * has to be unconditional, and an unconditional early return leaves the whole
 * handler body as unreachable code — which either gets deleted (that is
 * deletion slices #1987/#1988, deliberately not this one) or sits there
 * tripping lint. A route-level `preHandler` refuses *before* the handler runs,
 * so the bodies stay exactly as they are for the deletion slices to remove,
 * and no code path inside a handler can reach around the guard. Fastify
 * short-circuits as soon as the hook sends a reply, so nothing below it runs:
 * no database connection, no relayer touch, no funnel event.
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
 * - it removes no rail code (#1987) and no route (#1988);
 * - it drops no data (#1990). `user_safes` rows and the `account_type` /
 *   `execution_rail` columns stay: Hybrid lives in the same table, and the
 *   rail seam stays for reversibility.
 *
 * Every READ and every EDIT of an existing account is untouched — listing,
 * renaming, re-defaulting, unlinking, balances, approvers and history all
 * behave exactly as before. The inflow is closed; nothing else is.
 */

import type { FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify'

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
 * Route options that close one Safe inflow. Spread into the route's options
 * object so the refusal runs ahead of the handler:
 *
 *   app.post('/deploy', { ...retiredSafeInflow('deploy') }, handler)
 */
export function retiredSafeInflow(kind: SafeInflowKind): RouteShorthandOptions {
  return {
    preHandler: async (_request: FastifyRequest, reply: FastifyReply) => {
      const retired = safeRailRetired(kind)
      return reply.code(retired.statusCode).send(retired.body)
    },
  }
}
