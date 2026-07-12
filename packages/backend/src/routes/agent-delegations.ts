/**
 * Delegation lifecycle API (#828, epic #821 Phase 2) — owner-facing.
 *
 * Signature economics (the honest accounting):
 * - GRANT   = ONE offline EIP-712 owner signature, zero OWNER transactions
 *   (if the delegator account is still counterfactual, activate deploys it
 *   via the relayer's permissionless factory call, #860) — the
 *             flagship UX: build → owner signs client-side → activate.
 * - REVOKE  = ONE signature: a sponsored treasury UserOp executing
 *             disableDelegation (prepare → owner signs hash → submit).
 * - REPLACE = grant(new) + revoke(old) — a composition (two prompts when
 *             the old grant must die on-chain immediately; the new version
 *             always gets a fresh identity via #827's salt, so there is no
 *             collision either way).
 * - Agent KEY ROTATION (epic-review addition) = replace with the new
 *             delegate account — the same composition.
 *
 * Custody: the signed delegation is api_key_hash-class data (#824 §3) —
 * never logged, never echoed into error surfaces; responses return it only
 * to the authenticated OWNER. The backend never signs anything here: build
 * returns typed data, revoke returns a userOpHash (#824 invariants 5/12).
 *
 * Unapplied-edit visibility (#802's lesson): rows are 'pending' until
 * activated with the owner's signature; list exposes status so the
 * dashboard (#833) renders exactly what is and isn't live.
 */

import { FastifyInstance } from 'fastify'
import type { Hex, Address } from 'viem'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '../lib/address.js'
import { getChain } from '../lib/chains.js'
import { DELEGATION_RAIL_CHAIN_IDS } from '../lib/delegation-contracts.js'
import { computeHybridAccountAddress, ensureHybridDeployed } from '../lib/hybrid-provisioning.js'
import { loadHybridOwnerConfig, isPasskeyOnly } from '../lib/hybrid-account-config.js'
import {
  buildBudgetDelegation,
  buildRevocation,
  delegationIdentity,
  delegationSigningPayload,
  type HavenBudgetPolicy,
} from '../lib/delegation-policy.js'
import { createTreasuryOps, delegationRailBundlerUrl } from '../lib/delegation-rail.js'
import { redactVendorSecrets } from '../lib/execution-rail.js'

/** Vendor errors echo the bundler URL (which embeds the API key) — #764. */
function safeDetails(err: unknown): string {
  return redactVendorSecrets(err instanceof Error ? err.message : String(err))
}

const MAX_UINT96 = (1n << 96n) - 1n
const HASH_RE = /^0x[0-9a-fA-F]{64}$/

interface AgentAccountRow {
  agent_id: string
  delegate_address: string | null
  chain_id: number
  treasury_address: string | null
  account_type: string | null
}

/** The agent joined to its delegation-rail account — owner-scoped. */
async function loadOwnedDelegationAgent(
  agentId: string,
  userId: string,
): Promise<AgentAccountRow | null> {
  const result = await pool.query<AgentAccountRow>(
    `SELECT a.id AS agent_id, a.delegate_address, us.chain_id,
            us.safe_address AS treasury_address, us.account_type
     FROM agents a
     LEFT JOIN user_safes us ON us.id = a.safe_id
     WHERE a.id = $1 AND a.user_id = $2`,
    [agentId, userId],
  )
  return result.rows[0] ?? null
}

export default async function agentDelegationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // ── GET /:id/delegations — lifecycle visibility (#802 lesson) ─────────────
  app.get<{ Params: { id: string } }>('/:id/delegations', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    const result = await pool.query(
      `SELECT id, chain_id, token_address, recipient_address, delegation_hash,
              version, status, budget_atomic, period_seconds, start_date,
              expires_at, created_at
       FROM agent_delegations
       WHERE agent_id = $1
       ORDER BY created_at DESC`,
      [request.params.id],
    )
    // delegation_json intentionally NOT in the list — fetch is explicit.
    return { delegations: result.rows }
  })

  // ── POST /:id/delegations/build — grant step 1 (nothing signed yet) ───────
  app.post<{
    Params: { id: string }
    Body: {
      token_address?: string
      recipient_address?: string | null
      budget_atomic?: string
      period_seconds?: number
      expires_at?: number
    }
  }>('/:id/delegations/build', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    if (agent.account_type !== 'delegator_hybrid') {
      return reply.code(409).send({ error: 'Agent account is not on the delegation rail' })
    }
    if (!agent.delegate_address || !agent.treasury_address) {
      return reply.code(409).send({ error: 'Agent has no delegate key or treasury account' })
    }
    if (!DELEGATION_RAIL_CHAIN_IDS.has(agent.chain_id)) {
      return reply.code(409).send({ error: `Delegation rail not enabled on chain ${agent.chain_id}` })
    }

    const { token_address, recipient_address, budget_atomic, period_seconds, expires_at } =
      request.body ?? {}
    if (!token_address || !isValidAddress(token_address)) {
      return reply.code(400).send({ error: 'Valid token_address is required' })
    }
    if (recipient_address != null && !isValidAddress(recipient_address)) {
      return reply.code(400).send({ error: 'recipient_address must be a valid address when set' })
    }
    if (!budget_atomic || !/^\d+$/.test(budget_atomic) || BigInt(budget_atomic) <= 0n || BigInt(budget_atomic) > MAX_UINT96) {
      return reply.code(400).send({ error: 'budget_atomic must be a positive atomic amount' })
    }
    if (!period_seconds || !Number.isInteger(period_seconds) || period_seconds < 60) {
      return reply.code(400).send({ error: 'period_seconds must be an integer ≥ 60' })
    }
    const nowSec = Math.floor(Date.now() / 1000)
    const expiry = expires_at ?? nowSec + 90 * 86_400
    if (!Number.isInteger(expiry) || expiry <= nowSec) {
      return reply.code(400).send({ error: 'expires_at must be in the future' })
    }

    // Version = next per (agent, token, recipient|open) — fresh identity per
    // replacement (#827/#813).
    const versionRow = await pool.query<{ next_version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM agent_delegations
       WHERE agent_id = $1 AND token_address = LOWER($2)
         AND recipient_address IS NOT DISTINCT FROM LOWER($3)`,
      [request.params.id, token_address, recipient_address ?? null],
    )
    const version = versionRow.rows[0].next_version

    let delegation
    let delegateAccountAddress: Address
    try {
      delegateAccountAddress = await computeHybridAccountAddress(agent.chain_id, {
        ownerAddress: agent.delegate_address as Address,
      })
      const policy: HavenBudgetPolicy = {
        agentId: request.params.id,
        chainId: agent.chain_id,
        treasuryAddress: agent.treasury_address as Address,
        delegateAccountAddress,
        tokenAddress: token_address as Address,
        budgetAtomic: BigInt(budget_atomic),
        periodSeconds: period_seconds,
        startDate: nowSec - 60, // chain-time skew anchor (#820 run 6)
        recipient: (recipient_address ?? undefined) as Address | undefined,
        expiresAt: expiry,
        version,
      }
      delegation = buildBudgetDelegation(policy)
    } catch (err) {
      return reply.code(502).send({ error: 'Could not build the delegation', details: safeDetails(err) })
    }

    const hash = delegationIdentity(delegation)
    await pool.query(
      `INSERT INTO agent_delegations (
         agent_id, chain_id, token_address, recipient_address, delegation_hash,
         delegation_json, version, status, budget_atomic, period_seconds,
         start_date, expires_at
       ) VALUES ($1, $2, LOWER($3), $4, $5, $6, $7, 'pending', $8, $9, $10, $11)
       ON CONFLICT (delegation_hash) DO NOTHING`,
      [
        request.params.id, agent.chain_id, token_address,
        recipient_address ? recipient_address.toLowerCase() : null,
        hash, JSON.stringify(delegation), version,
        budget_atomic, period_seconds, nowSec - 60, expiry,
      ],
    )

    return reply.code(201).send({
      delegation_hash: hash,
      version,
      delegate_account_address: delegateAccountAddress,
      // The OWNER signs this client-side (EIP-712). One signature, no tx.
      signing_payload: delegationSigningPayload(delegation, agent.chain_id),
    })
  })

  // ── POST /:id/delegations/:hash/activate — grant step 2 ───────────────────
  app.post<{ Params: { id: string; hash: string }; Body: { signature?: string } }>(
    '/:id/delegations/:hash/activate',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const agent = await loadOwnedDelegationAgent(request.params.id, sub)
      if (!agent) return reply.code(404).send({ error: 'Agent not found' })
      const { signature } = request.body ?? {}
      if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        return reply.code(400).send({ error: 'A 65-byte owner signature is required' })
      }
      if (!HASH_RE.test(request.params.hash)) {
        return reply.code(400).send({ error: 'Invalid delegation hash' })
      }

      const row = await pool.query<{ id: string; delegation_json: string; status: string; token_address: string; recipient_address: string | null }>(
        `SELECT id, delegation_json, status, token_address, recipient_address
         FROM agent_delegations
         WHERE agent_id = $1 AND delegation_hash = $2`,
        [request.params.id, request.params.hash],
      )
      const pending = row.rows[0]
      if (!pending) return reply.code(404).send({ error: 'Delegation not found' })
      if (pending.status !== 'pending') {
        return reply.code(409).send({ error: `Delegation is ${pending.status}, not pending` })
      }

      // ── Deploy the delegator account if still counterfactual (#860) ──
      // The DelegationManager validates the delegation's signature via
      // EIP-1271, which reverts against an account with no code — found live
      // by the #835 DoD. A 4337 factory deploy is permissionless, so the
      // relayer deploys WITHOUT any owner signature (one-signature grant UX
      // preserved; non-custody unchanged — the account's signers are the
      // owner's keys). Fail-closed: no activation on a failed deploy, the
      // grant stays pending and activate can be retried.
      const owner = await loadHybridOwnerConfig(sub, agent.treasury_address as string)
      if (!owner) {
        return reply.code(409).send({
          error: 'Account signer configuration unknown — cannot deploy this account',
        })
      }
      try {
        const deployed = await ensureHybridDeployed(agent.chain_id, owner.config)
        if (deployed.address.toLowerCase() !== String(agent.treasury_address).toLowerCase()) {
          // The stored owner no longer derives the stored account — refuse
          // rather than activate a grant the chain can never honour.
          return reply.code(500).send({ error: 'Account derivation mismatch — contact support' })
        }
      } catch (err) {
        return reply.code(502).send({
          error: 'Could not deploy the account for this budget — try again',
          details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
        })
      }

      const signed = { ...JSON.parse(pending.delegation_json), signature }
      // Activate the new grant and mark any previously ACTIVE grant for the
      // same (token, recipient) slot as replaced — the on-chain kill of the
      // old one is the revoke flow (compose for immediate replacement).
      await pool.query(
        `UPDATE agent_delegations SET status = 'replaced', updated_at = NOW()
         WHERE agent_id = $1 AND token_address = $2
           AND recipient_address IS NOT DISTINCT FROM $3
           AND status = 'active'`,
        [request.params.id, pending.token_address, pending.recipient_address],
      )
      await pool.query(
        `UPDATE agent_delegations
         SET status = 'active', delegation_json = $1, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(signed), pending.id],
      )
      return { activated: true, delegation_hash: request.params.hash }
    },
  )

  // ── POST /:id/delegations/:hash/revoke — step 1: prepare (one signature) ──
  app.post<{ Params: { id: string; hash: string } }>(
    '/:id/delegations/:hash/revoke',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const agent = await loadOwnedDelegationAgent(request.params.id, sub)
      if (!agent) return reply.code(404).send({ error: 'Agent not found' })
      if (!HASH_RE.test(request.params.hash)) {
        return reply.code(400).send({ error: 'Invalid delegation hash' })
      }
      const row = await pool.query<{ delegation_json: string; status: string }>(
        `SELECT delegation_json, status FROM agent_delegations
         WHERE agent_id = $1 AND delegation_hash = $2`,
        [request.params.id, request.params.hash],
      )
      const target = row.rows[0]
      if (!target) return reply.code(404).send({ error: 'Delegation not found' })
      if (target.status === 'revoked') {
        return reply.code(409).send({ error: 'Already revoked' })
      }

      // Reconstruct the treasury's owner config (#885): an EOA account signs
      // the EIP-712 typed data; a pure-passkey account signs the userOpHash via
      // WebAuthn (#887). Check BEFORE building — a cheap 409 beats a 502.
      const owner = await loadHybridOwnerConfig(sub, agent.treasury_address as string)
      if (!owner) {
        return reply.code(409).send({
          error: 'Account signer configuration unknown — revoke via the exit path (docs)',
        })
      }

      try {
        const revocation = buildRevocation(JSON.parse(target.delegation_json), agent.chain_id)
        const passkeyOnly = isPasskeyOnly(owner.config)
        const treasury = await createTreasuryOps({
          ownerAddress: owner.config.ownerAddress,
          passkeys: owner.config.passkeys,
          chainId: agent.chain_id,
          bundlerUrl: delegationRailBundlerUrl(agent.chain_id),
          rpcUrl: getChain(agent.chain_id).rpcUrl,
          sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
        })
        const prepared = await treasury.prepareCall(revocation.to, revocation.data)
        const user_operation = JSON.parse(
          JSON.stringify(prepared.userOperation, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
        )
        if (passkeyOnly) {
          // Passkey accounts: the owner signs the userOpHash with the account
          // passkey (WebAuthn) — the frontend slice, #887. No EIP-712 payload.
          return {
            signature_scheme: 'webauthn_userop',
            user_op_hash: prepared.userOpHash,
            user_operation,
            treasury_address: prepared.treasuryAddress,
            instructions:
              'Sign user_op_hash with the account passkey (WebAuthn), then POST /revoke/submit',
          }
        }
        return {
          // The EOA owner signs THIS typed data (the account validates it),
          // not the bare hash — same scheme as delegation payments (#829).
          signature_scheme: 'eip712_userop',
          signing_payload: prepared.signingTypedData,
          user_operation,
          treasury_address: prepared.treasuryAddress,
          instructions: 'Sign signing_payload (EIP-712) with the treasury owner key, then POST /revoke/submit',
        }
      } catch (err) {
        return reply.code(502).send({ error: 'Could not prepare the revocation', details: safeDetails(err) })
      }
    },
  )

  // ── POST /:id/delegations/:hash/revoke/submit — step 2 ────────────────────
  app.post<{
    Params: { id: string; hash: string }
    Body: { signature?: string; user_operation?: unknown }
  }>('/:id/delegations/:hash/revoke/submit', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    const { signature, user_operation } = request.body ?? {}
    if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return reply.code(400).send({ error: 'signature is required' })
    }
    if (!user_operation || typeof user_operation !== 'object') {
      return reply.code(400).send({ error: 'user_operation (from the prepare step) is required' })
    }
    const owner = await loadHybridOwnerConfig(sub, agent.treasury_address as string)
    if (!owner) return reply.code(409).send({ error: 'Account signer configuration unknown' })

    try {
      const treasury = await createTreasuryOps({
        ownerAddress: owner.config.ownerAddress,
        passkeys: owner.config.passkeys,
        chainId: agent.chain_id,
        bundlerUrl: delegationRailBundlerUrl(agent.chain_id),
        rpcUrl: getChain(agent.chain_id).rpcUrl,
        sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
      })
      const revived = JSON.parse(JSON.stringify(user_operation), (_k, v) =>
        typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
      )
      const result = await treasury.submitCall(
        { userOperation: revived, userOpHash: '0x' as Hex, signingTypedData: null, treasuryAddress: treasury.treasuryAddress },
        signature as Hex,
      )
      await pool.query(
        `UPDATE agent_delegations SET status = 'revoked', updated_at = NOW()
         WHERE agent_id = $1 AND delegation_hash = $2`,
        [request.params.id, request.params.hash],
      )
      return { revoked: true, tx_hash: result.txHash }
    } catch (err) {
      return reply.code(502).send({ error: 'Revocation failed', details: safeDetails(err) })
    }
  })
}
