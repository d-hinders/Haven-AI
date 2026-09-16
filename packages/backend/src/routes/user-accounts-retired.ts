/**
 * `/user/safes*` — the retired Safe-vocabulary paths (#2914, naming epic #2906
 * phase 5, the contraction).
 *
 * #2907 registered `userAccountsRoutes` a second time under `/user/accounts` so
 * both vocabularies served the same handlers for exactly one release. #2908
 * shipped the consumer half, `0.2.0-alpha.0` reached `main` on 2026-09-14, and
 * the further promotion the slice waits for landed on 2026-09-16 — so the old
 * prefix stops serving here and answers 410 instead.
 *
 * **410 with a body, never a deleted route.** Dropping the registration would
 * make Fastify answer a bare 404, which reads as a transient routing error and
 * invites a retry loop against a path that is never coming back. The repo has
 * settled this twice before — the session rail (#834), `mpp_demo` (#1328) —
 * and the Safe inflow tombstones next door in `middleware/safe-inflow-retired.ts`
 * are the same shape. An old client must fail LOUDLY and typed, which is this
 * slice's stated acceptance bar.
 *
 * The body names the exact replacement path rather than the vocabulary change
 * in the abstract, because the reader is a caller holding a URL that just
 * stopped working, not someone reading the epic.
 *
 * **Auth still runs first.** `authMiddleware` is an `onRequest` hook on this
 * module exactly as it is on `userAccountsRoutes`, and Fastify runs `onRequest`
 * before the handler, so an anonymous caller gets 401 rather than a 410 that
 * would tell an unauthenticated stranger which paths this deployment used to
 * serve. Pinned in `__tests__/user-accounts-retired.test.ts`, not assumed — the
 * same property `safe-inflow-retired.test.ts` pins for the inflow tombstones.
 *
 * The two inflow paths (`POST /user/safes`, `POST /user/safes/deploy`) were
 * already 410 from #1984/#1988 under `retiredSafeInflowHandler`. They are
 * re-stated here with the naming body so the whole retired prefix answers one
 * way: a caller hitting two of these paths should not get two different
 * explanations for the same 410. Their `/user/accounts` twins keep the
 * Safe-rail refusal, which is a different fact and still true.
 */

import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'

/** Every method+path `userAccountsRoutes` served under the retired prefix. */
const RETIRED_ROUTES = [
  { method: 'GET', path: '/', replacement: 'GET /user/accounts' },
  { method: 'POST', path: '/', replacement: 'POST /user/accounts' },
  { method: 'POST', path: '/deploy', replacement: 'POST /user/accounts/deploy' },
  { method: 'PUT', path: '/:id', replacement: 'PUT /user/accounts/:accountId' },
  { method: 'PUT', path: '/:id/default', replacement: 'PUT /user/accounts/:accountId/default' },
  { method: 'DELETE', path: '/:id', replacement: 'DELETE /user/accounts/:accountId' },
  { method: 'GET', path: '/:id/funding', replacement: 'GET /user/accounts/:accountId/funding' },
] as const

/**
 * The refusal body, one producer (the lesson `safe-inflow-retired.ts` records:
 * a tombstone per route duplicates the producer once per address).
 *
 * `error` carries the human sentence; `replacement` carries the new path as a
 * field so a client can route on it without parsing prose.
 */
export function retiredSafePath(replacement: string): {
  statusCode: 410
  body: { error: string; replacement: string }
} {
  return {
    statusCode: 410,
    body: {
      error:
        'The /user/safes paths are retired (#2906) — Haven accounts are addressed as ' +
        `accounts, not Safes. Use ${replacement}. The response shape is unchanged.`,
      replacement,
    },
  }
}

export default async function userSafesRetiredRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware)

  for (const { method, path, replacement } of RETIRED_ROUTES) {
    app.route({
      method,
      url: path,
      handler: async (_request, reply) => {
        const retired = retiredSafePath(replacement)
        return reply.code(retired.statusCode).send(retired.body)
      },
    })
  }
}
