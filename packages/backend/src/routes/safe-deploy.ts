/**
 * `POST /safe/deploy` — TOMBSTONE (#1988, epic #1440 slice 5).
 *
 * This module used to deploy a passkey-owned Safe: predict the passkey signer
 * address, deploy the signer if needed, deploy the Safe proxy through the
 * factory, and register the result in `user_safes` inside one Postgres
 * transaction. #1984 closed that inflow with a 410; this slice deletes the
 * implementation behind it, along with `modules/accounts/safe-deployer.ts` and
 * the proxy-factory half of `infra/chain/safe-proxy-deployer.ts`.
 *
 * The route itself stays, answering 410, for the reason #834 kept the session
 * rail's: a permanently-gone flow must not read as a transient 404 that invites
 * retries. `safeRailRetired()` is still the single producer of the body.
 *
 * Deleting the handler also buries #1753 (a bare `tx.wait()` awaited inside an
 * open Postgres transaction on a pooled client) and the `relaySafeDeploy` half
 * of #1755. The OTHER half of #1755 — `ensurePasskeySignerDeployed` — is NOT
 * buried: it is still reached from `routes/safe-exec.ts`, which stays open.
 * See the PR for #1988 and the note on #1755.
 */

import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { retiredSafeInflowHandler } from '../middleware/safe-inflow-retired.js'

export default async function safeDeployRoutes(app: FastifyInstance): Promise<void> {
  // Auth first, so an anonymous caller still gets 401 rather than 410.
  app.addHook('onRequest', authMiddleware)

  app.post('/deploy', retiredSafeInflowHandler('deploy'))
}
