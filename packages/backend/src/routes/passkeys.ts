import { FastifyInstance } from 'fastify'
import { listUserPasskeys } from '../infra/repositories/user-passkeys.js'
import { authMiddleware } from '../middleware/auth.js'

/**
 * Passkeys, read-only as of #2847 (epic #1440).
 *
 * `POST /passkeys` — the Safe WebAuthn signer enrolment — is deleted with the
 * Safe rail's last live behaviour. `GET /passkeys` stays: `AuthContext` reads
 * it every session and existing enrolled passkeys remain part of the account
 * record. The repository (`infra/repositories/user-passkeys.ts`) is untouched:
 * the GET still reads it, and the enrol/bind helpers it also carries go with
 * the `user_passkeys` table in a later slice — not here.
 */
export default async function passkeyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    return { passkeys: await listUserPasskeys(sub) }
  })
}
