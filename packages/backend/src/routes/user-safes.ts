import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { isSupportedChain } from '../lib/chains.js'
import { DEFAULT_CHAIN_ID } from '@haven_ai/core'
import { relaySafeDeploy } from '../lib/safe-deployer.js'
import { getSafeDetails } from '../lib/safe-details.js'
import {
  buildAddOwnerTx,
  buildRemoveOwnerTx,
  LastOwnerError,
  OwnerExistsError,
  OwnerNotFoundError,
} from '../lib/safe-owner-tx.js'
import { ETH_ADDRESS_RE } from '@haven_ai/core'
import {
  countSafesForUser,
  deleteApproverMetadata,
  deleteSafeForUser,
  findOwnedSafe,
  findOwnedSafeAddress,
  findOwnedSafeDefaultFlag,
  findSafeIdByAddressAndChain,
  insertUserSafe,
  listApproverMetadataForSafe,
  listKnownApproversForUser,
  listSafesForUser,
  renameSafeForUser,
  setDefaultSafeForUser,
  setLegacyUserSafeAddress,
  upsertApproverMetadata,
} from '../infra/repositories/user-safes.js'

const APPROVER_TYPES = new Set(['eoa', 'passkey'])

// ── Types ─────────────────────────────────────────────────────────

interface AddSafeBody {
  safe_address: string
  chain_id?: number
  name?: string
}

interface DeploySafeBody {
  chain_id?: number
  owner_address: string
}

interface RenameSafeBody {
  name: string
}

interface ApproverTxBody {
  action: 'add' | 'remove'
  address: string
}

interface UpsertApproverBody {
  address: string
  type?: 'eoa' | 'passkey'
  label?: string
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

  // POST /user/safes/deploy — relay-sponsored Safe deployment
  // The relayer pays gas and returns the deployed Safe address + txHash.
  // Registration is done separately via POST /user/safes so the flow is
  // identical for both onboarding and add-account.
  app.post<{ Body: DeploySafeBody }>('/deploy', async (request, reply) => {
    const { chain_id = DEFAULT_CHAIN_ID, owner_address } = request.body

    if (!owner_address || !ETH_ADDRESS_RE.test(owner_address)) {
      return reply.code(400).send({ error: 'Invalid owner address' })
    }

    if (!isSupportedChain(chain_id)) {
      return reply.code(400).send({ error: `Unsupported chain: ${chain_id}` })
    }

    try {
      const { safeAddress, txHash } = await relaySafeDeploy(chain_id, owner_address)
      return reply.code(201).send({ safe_address: safeAddress, tx_hash: txHash })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Relay deployment failed'
      return reply.code(500).send({ error: msg })
    }
  })

  // POST /user/safes — add (import) an existing Safe
  app.post<{ Body: AddSafeBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { safe_address, chain_id = DEFAULT_CHAIN_ID, name } = request.body

    if (!safe_address || !ETH_ADDRESS_RE.test(safe_address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    if (!isSupportedChain(chain_id)) {
      return reply.code(400).send({ error: `Unsupported chain: ${chain_id}` })
    }

    // Check if already added (same address + chain)
    const existingId = await findSafeIdByAddressAndChain(sub, safe_address, chain_id)
    if (existingId) {
      return reply.code(409).send({ error: 'This Safe is already linked to your account' })
    }

    // Check if user has any Safes yet (first one becomes default)
    const isFirst = (await countSafesForUser(sub)) === 0

    const safe = await insertUserSafe({
      userId: sub,
      safeAddress: safe_address,
      chainId: chain_id,
      name: name?.trim() || 'My account',
      isDefault: isFirst,
    })

    // Also update legacy users.safe_address if this is the first Safe
    if (isFirst) {
      await setLegacyUserSafeAddress(safe_address, sub)
    }

    return reply.code(201).send(safe)
  })

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

  // ── Approvers (Safe owners) ─────────────────────────────────────
  //
  // Membership truth is on-chain (`getOwners()`); this metadata table only
  // decorates owners with a label + type. Owner changes are Safe self-calls
  // the *user* signs and relays via /safe-exec — Haven never signs them, so
  // these endpoints construct + guard but never execute.

  // GET /user/safes/known-approvers — the user's approver registry across all
  // their Safes, for reusing an approver on another account (#417). Distinct
  // by address; carries the most recent label/type and the safe_ids it is
  // known on so the picker can exclude Safes it is already on.
  app.get('/known-approvers', async (request) => {
    const { sub } = request.user as { sub: string }
    const approvers = await listKnownApproversForUser(sub)
    return { approvers }
  })

  // GET /user/safes/:safeId/approvers — on-chain owners + stored metadata
  app.get<{ Params: { safeId: string } }>(
    '/:safeId/approvers',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const safe = await findOwnedSafe(safeId(request), sub)
      if (!safe) return reply.code(404).send({ error: 'Account not found' })

      let details
      try {
        details = await getSafeDetails(safe.safe_address, safe.chain_id)
      } catch {
        return reply.code(502).send({ error: 'Could not read owners from the network. Try again.' })
      }

      const metadata = await listApproverMetadataForSafe(safe.id)
      const byAddress = new Map(
        metadata.map((row) => [row.address.toLowerCase(), row]),
      )

      const approvers = details.owners.map((address) => {
        const meta = byAddress.get(address.toLowerCase())
        return {
          address,
          type: meta?.type ?? 'eoa',
          label: meta?.label ?? null,
        }
      })

      return { threshold: details.threshold, approvers }
    },
  )

  // POST /user/safes/:safeId/approvers/tx — build the unsigned owner-change
  // Safe self-call for the client to sign + relay. The last-owner guard lives
  // here: a removal of the final owner is rejected before any tx is produced.
  app.post<{ Params: { safeId: string }; Body: ApproverTxBody }>(
    '/:safeId/approvers/tx',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const safe = await findOwnedSafe(safeId(request), sub)
      if (!safe) return reply.code(404).send({ error: 'Account not found' })

      const action = request.body?.action
      const address = typeof request.body?.address === 'string' ? request.body.address.trim() : ''
      if (action !== 'add' && action !== 'remove') {
        return reply.code(400).send({ error: 'action must be "add" or "remove"' })
      }
      if (!ETH_ADDRESS_RE.test(address)) {
        return reply.code(400).send({ error: 'A valid approver address is required' })
      }

      let owners: string[]
      try {
        ;({ owners } = await getSafeDetails(safe.safe_address, safe.chain_id))
      } catch {
        return reply.code(502).send({ error: 'Could not read owners from the network. Try again.' })
      }

      try {
        const tx =
          action === 'add'
            ? buildAddOwnerTx(safe.safe_address, owners, address)
            : buildRemoveOwnerTx(safe.safe_address, owners, address)
        return { chain_id: safe.chain_id, safe_address: safe.safe_address, tx }
      } catch (err) {
        if (err instanceof LastOwnerError) return reply.code(409).send({ error: err.message })
        if (err instanceof OwnerExistsError) return reply.code(409).send({ error: err.message })
        if (err instanceof OwnerNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }
    },
  )

  // POST /user/safes/:safeId/approvers — upsert approver metadata (label +
  // type). Called after the client relays the on-chain add. Idempotent.
  app.post<{ Params: { safeId: string }; Body: UpsertApproverBody }>(
    '/:safeId/approvers',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const safe = await findOwnedSafe(safeId(request), sub)
      if (!safe) return reply.code(404).send({ error: 'Account not found' })

      const address = typeof request.body?.address === 'string' ? request.body.address.trim() : ''
      if (!ETH_ADDRESS_RE.test(address)) {
        return reply.code(400).send({ error: 'A valid approver address is required' })
      }
      const type = request.body?.type ?? 'eoa'
      if (!APPROVER_TYPES.has(type)) {
        return reply.code(400).send({ error: 'type must be "eoa" or "passkey"' })
      }
      const label =
        typeof request.body?.label === 'string' && request.body.label.trim()
          ? request.body.label.trim().slice(0, 120)
          : null

      await upsertApproverMetadata(safe.id, address, type, label)

      return { success: true }
    },
  )

  // DELETE /user/safes/:safeId/approvers/:address — drop metadata after the
  // client relays the on-chain removal. The on-chain last-owner guard is
  // enforced by /approvers/tx; this only cleans up the decoration row.
  app.delete<{ Params: { safeId: string; address: string } }>(
    '/:safeId/approvers/:address',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const safe = await findOwnedSafe(safeId(request), sub)
      if (!safe) return reply.code(404).send({ error: 'Account not found' })

      await deleteApproverMetadata(safe.id, request.params.address)

      return { success: true }
    },
  )
}

function safeId(request: { params: unknown }): string {
  return (request.params as { safeId: string }).safeId
}
