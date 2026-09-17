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

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'

/**
 * The refusal body, one producer (the lesson `safe-inflow-retired.ts` records:
 * a tombstone per route duplicates the producer once per address).
 *
 * `error` carries the human sentence; `replacement` carries the new path as a
 * field so a client can route on it without parsing prose.
 */
export function retiredSafePath(
  replacement: string,
  note?: string,
): {
  statusCode: 410
  body: { error: string; replacement: string }
} {
  return {
    statusCode: 410,
    body: {
      error:
        'The /user/safes paths are retired (#2906) — Haven accounts are addressed as ' +
        `accounts, not Safes. Use ${replacement}.` +
        (note === undefined ? '' : ` ${note}`),
      replacement,
    },
  }
}

/**
 * One handler per retired address, naming where that address moved to.
 *
 * Named `retired…` deliberately: `qa-seed-routes.test.ts`'s retirement
 * detector matches `.<method>('<path>', retired*(` and is how the QA seed is
 * stopped from calling a permanently-gone path. A handler called anything
 * else leaves the address uncounted in BOTH directions — which is why
 * `PUT /user/safe` uses this factory too rather than an inline arrow, even
 * though it lives in `routes/user.ts`.
 */
export function retiredSafePathHandler(replacement: string, note?: string) {
  return async (_request: FastifyRequest, reply: FastifyReply) => {
    const retired = retiredSafePath(replacement, note)
    return reply.code(retired.statusCode).send(retired.body)
  }
}

export default async function userAccountsRetiredRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware)

  // Registered one literal `app.<method>('<path>', retired…)` call at a time
  // rather than looped over a table through `app.route({ method, url })`. The
  // table was tidier and made this module INVISIBLE to
  // `openapi/route-inventory.ts`, whose extractor matches
  // `<ident>.<method>('<path>'` and cannot see a url that arrives as data — so
  // `owner-cli-route-census.test.ts` and `qa-seed-routes.test.ts` counted
  // these seven paths as neither live nor retired. A route no census can see
  // is the failure mode the owner_cli allow-list comment names: it reads as
  // coverage and is not. The producer stays single, which is the part that
  // mattered.
  // The note is per address, because "use the replacement" is not uniformly
  // safe advice. Two things a migrating client cannot see from the path alone:
  //
  //  - the LIST envelope key moved `safes` -> `accounts`, so swapping the path
  //    alone leaves a reader destructuring `undefined`. That is not
  //    hypothetical — it is exactly how `@haven_ai/cli` broke six commands in
  //    this very slice, against a green test suite;
  //  - three of these replacements are THEMSELVES 410 (the Safe-rail inflow
  //    closure, #1984/#1988). Sending a caller there would hand them a second
  //    410 with a different explanation and no way forward, so those say the
  //    operation is closed and name the live alternative instead.
  app.get('/', retiredSafePathHandler(
    'GET /user/accounts',
    'The response envelope key is `accounts`, not `safes` — a client that only swaps the path will read an undefined array.',
  ))
  app.post('/', retiredSafePathHandler(
    'POST /user/accounts',
    'That path is itself retired (#1984): importing an account is closed with the Safe rail, and no path replaces it. Create a Haven account on the delegation rail with POST /accounts/hybrid.',
  ))
  app.post('/deploy', retiredSafePathHandler(
    'POST /user/accounts/deploy',
    'That path is itself retired (#1984): Haven no longer deploys Safes, and no path replaces it. Create a Haven account on the delegation rail with POST /accounts/hybrid.',
  ))
  app.put('/:id', retiredSafePathHandler('PUT /user/accounts/:accountId'))
  app.put('/:id/default', retiredSafePathHandler('PUT /user/accounts/:accountId/default'))
  app.delete('/:id', retiredSafePathHandler('DELETE /user/accounts/:accountId'))
  app.get('/:id/funding', retiredSafePathHandler('GET /user/accounts/:accountId/funding'))
}
