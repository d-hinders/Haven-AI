/**
 * Hybrid DeleGator account provisioning (#825, epic #821 Phase 1).
 *
 * POST /accounts/hybrid — owner-facing: computes the counterfactual Hybrid
 * address for the given owner configuration (EOA and/or passkey P256 keys)
 * and records the account row. NO transaction happens here: the address is
 * deterministic and deployment rides the first sponsored operation (#828).
 *
 * Fail-closed wiring (the #745 dark-launch pattern): the row carries
 * account_type='delegator_hybrid' and execution_rail='delegation' — a rail
 * value nothing routes to until #829; the payments route blocks it cleanly
 * rather than falling through to a legacy path that cannot serve it.
 */

import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '../lib/address.js'
import { DELEGATION_RAIL_CHAIN_IDS } from '../lib/delegation-contracts.js'
import { computeHybridAccountAddress, type PasskeySigner } from '../lib/hybrid-provisioning.js'

interface CreateHybridBody {
  chain_id?: number
  name?: string
  owner_address?: string
  passkeys?: Array<{ key_id?: string; x?: string; y?: string }>
}

const HEX_COORD_RE = /^0x[0-9a-fA-F]{1,64}$/

export default async function hybridAccountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.post<{ Body: CreateHybridBody }>('/hybrid', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { chain_id, name, owner_address, passkeys } = request.body ?? {}

    const chainId = chain_id ?? 84532
    if (!DELEGATION_RAIL_CHAIN_IDS.has(chainId)) {
      return reply.code(400).send({
        error: `Hybrid accounts are not available on chain ${chainId} yet`,
        supported: [...DELEGATION_RAIL_CHAIN_IDS],
      })
    }
    if (owner_address !== undefined && !isValidAddress(owner_address)) {
      return reply.code(400).send({ error: 'owner_address must be a valid address' })
    }
    const parsedPasskeys: PasskeySigner[] = []
    for (const pk of passkeys ?? []) {
      if (!pk.key_id || typeof pk.key_id !== 'string') {
        return reply.code(400).send({ error: 'each passkey needs a key_id' })
      }
      if (!pk.x || !pk.y || !HEX_COORD_RE.test(pk.x) || !HEX_COORD_RE.test(pk.y)) {
        return reply.code(400).send({ error: 'each passkey needs 0x-hex x and y coordinates' })
      }
      parsedPasskeys.push({ keyId: pk.key_id, x: BigInt(pk.x), y: BigInt(pk.y) })
    }
    if (!owner_address && parsedPasskeys.length === 0) {
      return reply.code(400).send({ error: 'at least one owner (owner_address or passkeys) is required' })
    }

    let accountAddress: string
    try {
      accountAddress = await computeHybridAccountAddress(chainId, {
        ownerAddress: owner_address as `0x${string}` | undefined,
        passkeys: parsedPasskeys,
      })
    } catch (err) {
      return reply.code(502).send({
        error: 'Could not derive the account address',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM user_safes
       WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3`,
      [sub, accountAddress, chainId],
    )
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'Account already registered', id: existing.rows[0].id })
    }

    const firstCheck = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM user_safes WHERE user_id = $1`,
      [sub],
    )
    const isFirst = firstCheck.rows[0]?.count === '0'

    const result = await pool.query<{ id: string; created_at: string }>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, name, is_default, account_type, execution_rail, owner_address)
       VALUES ($1, $2, $3, $4, $5, 'delegator_hybrid', 'delegation', $6)
       RETURNING id, created_at`,
      // owner_address: the EOA owner for treasury ops (#828 revoke). A pure-
      // passkey account has none — its owner signs via WebAuthn (#833).
      [sub, accountAddress, chainId, name?.trim() || 'My account', isFirst, owner_address?.toLowerCase() ?? null],
    )

    return reply.code(201).send({
      id: result.rows[0].id,
      account_address: accountAddress,
      chain_id: chainId,
      account_type: 'delegator_hybrid',
      // Counterfactual: no deployment tx — the first sponsored operation
      // (the budget grant, #828) deploys the code.
      deployed: false,
      created_at: result.rows[0].created_at,
    })
  })
}
