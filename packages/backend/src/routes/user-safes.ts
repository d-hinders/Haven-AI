import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { retiredSafeInflowHandler } from '../middleware/safe-inflow-retired.js'
import {
  deleteSafeForUser,
  findOwnedSafeAddress,
  findOwnedSafeDefaultFlag,
  listSafesForUser,
  renameSafeForUser,
  setDefaultSafeForUser,
} from '../infra/repositories/user-safes.js'

// ── Types ─────────────────────────────────────────────────────────

interface RenameSafeBody {
  name: string
}

// ── Routes ────────────────────────────────────────────────────────

export default async function userSafesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /user/safes — list all Safes for the authenticated user
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    const safes = await listSafesForUser(sub)

    return { safes }
  })

  // POST /user/safes/deploy — TOMBSTONE (#1984 closed it, #1988 deleted the
  // body). It relay-sponsored a wallet-owned Safe deployment through
  // `relaySafeDeploy`, which is deleted with this slice. Note what it never
  // had: any check that the caller owned `owner_address`. The relayer paid gas
  // to deploy a Safe for whatever address a caller named, bounded only by a
  // global rate limit — a surface that is now gone rather than guarded.
  app.post('/deploy', retiredSafeInflowHandler('deploy'))

  // POST /user/safes — TOMBSTONE (#1984 closed it, #1988 deleted the body).
  // Importing is the other half of creating; both are how a Safe entered Haven.
  app.post('/', retiredSafeInflowHandler('import'))

  // PUT /user/safes/:safeId — rename a Safe
  app.put<{ Params: { safeId: string }; Body: RenameSafeBody }>(
    '/:safeId',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { safeId } = request.params
      const { name } = request.body

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ error: 'Name is required' })
      }

      const renamed = await renameSafeForUser(name.trim(), safeId, sub)

      if (!renamed) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      return renamed
    },
  )

  // PUT /user/safes/:safeId/default — set a Safe as the default
  app.put<{ Params: { safeId: string } }>(
    '/:safeId/default',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { safeId } = request.params

      // Verify the Safe belongs to the user
      const owned = await findOwnedSafeAddress(safeId, sub)
      if (!owned) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      await setDefaultSafeForUser(safeId, owned.safe_address, sub)

      return { success: true }
    },
  )

  // DELETE /user/safes/:safeId — remove (unlink) a Safe
  app.delete<{ Params: { safeId: string } }>(
    '/:safeId',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { safeId } = request.params

      // Check the Safe exists and belongs to user
      const owned = await findOwnedSafeDefaultFlag(safeId, sub)
      if (!owned) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      await deleteSafeForUser(safeId, sub, owned.is_default)

      return { success: true }
    },
  )

  // ── Approvers (Safe owners) — DELETED (#1988, epic #1440 slice 5) ────
  //
  // Five routes lived here: `GET /user/safes/known-approvers`, `GET|POST
  // /user/safes/:safeId/approvers`, `POST /user/safes/:safeId/approvers/tx`
  // and `DELETE /user/safes/:safeId/approvers/:address`. They constructed and
  // guarded Safe owner-change self-calls (Haven never signed one) and stored
  // the label/type decoration in `safe_approver_metadata` — the table the
  // epic's approved phase 5 drops in #1990. `modules/accounts/safe-owner-tx.ts`
  // went with them.
  //
  // WHAT THIS COSTS, stated rather than buried: this was Haven's only surface
  // for adding a backup owner to a legacy Safe (#1229's preventive recovery).
  // It is not the last way an owner reaches their account. `POST /safe/exec`
  // stays OPEN, so an owner-signed Safe transaction — including moving funds
  // out — is still relayable, and a passkey already enrolled as an on-chain
  // owner still authorises there against the live owner list. Every one of the
  // 15 Safes in the epic's census is owned by an external EOA (or, in one
  // case, the prod relayer, wound down in #1985), and an EOA owner manages
  // owners directly at app.safe.global with their own key — which Haven's
  // non-custody rule requires to be true regardless of what Haven offers.
  //
  // The frontend callers (`ManageApprovers`, `RecoveryNudge`,
  // `useSafeApprovers`, `lib/approver-tx.ts`) are removed in #1989; until then
  // they see a 404 from these paths, the same owner-sequenced consequence
  // #1986 accepted for the approval queue.
}
