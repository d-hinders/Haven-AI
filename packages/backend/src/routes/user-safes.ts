import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isSupportedChain } from '../lib/chains.js'
import { relaySafeDeploy } from '../lib/safe-deployer.js'
import { getSafeDetails } from '../lib/safe-details.js'
import {
  buildAddOwnerTx,
  buildRemoveOwnerTx,
  LastOwnerError,
  OwnerExistsError,
  OwnerNotFoundError,
} from '../lib/safe-owner-tx.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const APPROVER_TYPES = new Set(['eoa', 'passkey'])

// ── Types ─────────────────────────────────────────────────────────

interface UserSafeRow {
  id: string
  user_id: string
  safe_address: string
  chain_id: number
  name: string
  is_default: boolean
  created_at: string
  updated_at: string
}

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

interface ApproverMetadataRow {
  address: string
  type: 'eoa' | 'passkey'
  label: string | null
}

// ── Routes ────────────────────────────────────────────────────────

export default async function userSafesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /user/safes — list all Safes for the authenticated user
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    const result = await pool.query<UserSafeRow>(
      `SELECT id, safe_address, chain_id, name, is_default, created_at
       FROM user_safes
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [sub],
    )

    return { safes: result.rows }
  })

  // POST /user/safes/deploy — relay-sponsored Safe deployment
  // The relayer pays gas and returns the deployed Safe address + txHash.
  // Registration is done separately via POST /user/safes so the flow is
  // identical for both onboarding and add-account.
  app.post<{ Body: DeploySafeBody }>('/deploy', async (request, reply) => {
    const { chain_id = 100, owner_address } = request.body

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
    const { safe_address, chain_id = 100, name } = request.body

    if (!safe_address || !ETH_ADDRESS_RE.test(safe_address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    if (!isSupportedChain(chain_id)) {
      return reply.code(400).send({ error: `Unsupported chain: ${chain_id}` })
    }

    // Check if already added (same address + chain)
    const existing = await pool.query(
      `SELECT id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3`,
      [sub, safe_address, chain_id],
    )
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'This Safe is already linked to your account' })
    }

    // Check if user has any Safes yet (first one becomes default)
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM user_safes WHERE user_id = $1`,
      [sub],
    )
    const isFirst = Number(countResult.rows[0].count) === 0

    const result = await pool.query<UserSafeRow>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, name, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, safe_address, chain_id, name, is_default, created_at`,
      [sub, safe_address, chain_id, name?.trim() || 'My account', isFirst],
    )

    // Also update legacy users.safe_address if this is the first Safe
    if (isFirst) {
      await pool.query(
        `UPDATE users SET safe_address = $1, updated_at = NOW() WHERE id = $2`,
        [safe_address, sub],
      )
    }

    return reply.code(201).send(result.rows[0])
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

      const result = await pool.query<UserSafeRow>(
        `UPDATE user_safes SET name = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3
         RETURNING id, safe_address, chain_id, name, is_default, created_at`,
        [name.trim(), safeId, sub],
      )

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      return result.rows[0]
    },
  )

  // PUT /user/safes/:safeId/default — set a Safe as the default
  app.put<{ Params: { safeId: string } }>(
    '/:safeId/default',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { safeId } = request.params

      // Verify the Safe belongs to the user
      const check = await pool.query<UserSafeRow>(
        `SELECT id, safe_address FROM user_safes WHERE id = $1 AND user_id = $2`,
        [safeId, sub],
      )
      if (check.rows.length === 0) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Clear all defaults for this user
        await client.query(
          `UPDATE user_safes SET is_default = false, updated_at = NOW()
           WHERE user_id = $1`,
          [sub],
        )

        // Set the new default
        await client.query(
          `UPDATE user_safes SET is_default = true, updated_at = NOW()
           WHERE id = $1`,
          [safeId],
        )

        // Update legacy users.safe_address
        await client.query(
          `UPDATE users SET safe_address = $1, updated_at = NOW() WHERE id = $2`,
          [check.rows[0].safe_address, sub],
        )

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

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
      const check = await pool.query<UserSafeRow>(
        `SELECT id, is_default FROM user_safes WHERE id = $1 AND user_id = $2`,
        [safeId, sub],
      )
      if (check.rows.length === 0) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Orphan agents linked to this Safe
        await client.query(
          `UPDATE agents SET safe_id = NULL, updated_at = NOW() WHERE safe_id = $1`,
          [safeId],
        )

        // Orphan any leftover self-sign agents too. The self-sign track was
        // removed, but its table lingers with a RESTRICT foreign key on
        // user_safes(id) — rows from that era would otherwise block deletion
        // of an old Safe with a "violates foreign key constraint" error.
        await client.query(
          `UPDATE self_sign_agents SET safe_id = NULL, updated_at = NOW() WHERE safe_id = $1`,
          [safeId],
        )

        // Delete the Safe link
        await client.query(
          `DELETE FROM user_safes WHERE id = $1`,
          [safeId],
        )

        // If this was the default, promote the oldest remaining Safe
        if (check.rows[0].is_default) {
          const next = await client.query<UserSafeRow>(
            `SELECT id, safe_address FROM user_safes
             WHERE user_id = $1
             ORDER BY created_at ASC
             LIMIT 1`,
            [sub],
          )
          if (next.rows.length > 0) {
            await client.query(
              `UPDATE user_safes SET is_default = true, updated_at = NOW() WHERE id = $1`,
              [next.rows[0].id],
            )
            await client.query(
              `UPDATE users SET safe_address = $1, updated_at = NOW() WHERE id = $2`,
              [next.rows[0].safe_address, sub],
            )
          } else {
            // No Safes left — clear legacy column
            await client.query(
              `UPDATE users SET safe_address = NULL, updated_at = NOW() WHERE id = $1`,
              [sub],
            )
          }
        }

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      return { success: true }
    },
  )

  // ── Approvers (Safe owners) ─────────────────────────────────────
  //
  // Membership truth is on-chain (`getOwners()`); this metadata table only
  // decorates owners with a label + type. Owner changes are Safe self-calls
  // the *user* signs and relays via /safe-exec — Haven never signs them, so
  // these endpoints construct + guard but never execute.

  // GET /user/safes/:safeId/approvers — on-chain owners + stored metadata
  app.get<{ Params: { safeId: string } }>(
    '/:safeId/approvers',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const safe = await loadOwnedSafe(safeId(request), sub)
      if (!safe) return reply.code(404).send({ error: 'Account not found' })

      let details
      try {
        details = await getSafeDetails(safe.safe_address, safe.chain_id)
      } catch {
        return reply.code(502).send({ error: 'Could not read owners from the network. Try again.' })
      }

      const metadata = await pool.query<ApproverMetadataRow>(
        `SELECT address, type, label FROM safe_approver_metadata WHERE safe_id = $1`,
        [safe.id],
      )
      const byAddress = new Map(
        metadata.rows.map((row) => [row.address.toLowerCase(), row]),
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
      const safe = await loadOwnedSafe(safeId(request), sub)
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
      const safe = await loadOwnedSafe(safeId(request), sub)
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

      await pool.query(
        `INSERT INTO safe_approver_metadata (safe_id, address, type, label)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (safe_id, LOWER(address))
         DO UPDATE SET type = EXCLUDED.type, label = EXCLUDED.label, updated_at = NOW()`,
        [safe.id, address, type, label],
      )

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
      const safe = await loadOwnedSafe(safeId(request), sub)
      if (!safe) return reply.code(404).send({ error: 'Account not found' })

      await pool.query(
        `DELETE FROM safe_approver_metadata WHERE safe_id = $1 AND LOWER(address) = LOWER($2)`,
        [safe.id, request.params.address],
      )

      return { success: true }
    },
  )
}

function safeId(request: { params: unknown }): string {
  return (request.params as { safeId: string }).safeId
}

async function loadOwnedSafe(
  id: string,
  userId: string,
): Promise<{ id: string; safe_address: string; chain_id: number } | null> {
  const result = await pool.query<{ id: string; safe_address: string; chain_id: number }>(
    `SELECT id, safe_address, chain_id FROM user_safes WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  return result.rows[0] ?? null
}
