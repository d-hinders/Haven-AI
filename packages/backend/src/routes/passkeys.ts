import { FastifyInstance } from 'fastify'
import { listUserPasskeys } from '../infra/repositories/user-passkeys.js'
import { authMiddleware } from '../middleware/auth.js'
import { withSessionAccountAddressAlias } from '../openapi/wire-aliases.js'

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

    // #2907: account_address twins safe_address on each passkey (same value).
    const passkeys = (await listUserPasskeys(sub)).map((p) =>
      withSessionAccountAddressAlias({ ...p, safe_address: p.safe_address ?? null }),
    )
    return { passkeys }
  })
}
