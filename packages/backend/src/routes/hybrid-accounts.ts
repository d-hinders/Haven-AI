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
// dep-lint-exempt: 5 provisioning statements (duplicate check, first-account gate, insert with rail+type, passkey persist, ownership read) whose guards travel with the insert; a >100-line move deferred under #999
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import { DELEGATION_RAIL_CHAIN_IDS } from '../rails/delegation-contracts.js'
import { isValueBearingChain } from '../modules/accounts/index.js'
import { computeHybridAccountAddress, type PasskeySigner } from '../rails/hybrid-provisioning.js'
import {
  prepareSignerChange,
  submitSignerChange,
  validateSignedSubmission,
  type SignerActionAccount,
  type SignerActionBody,
} from '../rails/hybrid-signer-actions.js'
import { prepareTransfer, submitTransfer, type TransferBody } from '../rails/hybrid-transfers.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { loadHybridOwnerConfig } from '../rails/hybrid-account-config.js'

interface CreateHybridBody {
  chain_id?: number
  name?: string
  owner_address?: string
  passkeys?: Array<{ key_id?: string; x?: string; y?: string }>
  /**
   * Optional acknowledgment that a single-signer account has no recovery —
   * "losing my only device loses this account".
   *
   * **Not required for anything.** It gated provisioning under #908; #1153
   * turned the signer floor into a post-funding recommendation, so nothing
   * refuses a single-signer account any more. Sending it records the
   * acknowledgement durably (`user_safes.single_signer_waiver_at`) as history
   * and changes no outcome; omitting it changes no outcome either. Kept on the
   * request shape so existing clients that send it keep working.
   */
  single_signer_waiver?: { acknowledged?: boolean }
}

const HEX_COORD_RE = /^0x[0-9a-fA-F]{1,64}$/

export default async function hybridAccountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.post<{ Body: CreateHybridBody }>('/hybrid', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { chain_id, name, owner_address, passkeys, single_signer_waiver } = request.body ?? {}

    const chainId = chain_id ?? 84532
    if (owner_address !== undefined && !isValidAddress(owner_address)) {
      return reply.code(400).send({ error: 'owner_address must be a valid address' })
    }
    // The zero address is the Hybrid derivation's "no EOA owner" encoding —
    // {owner_address: 0x0, passkeys: [A]} derives the SAME account as pure-
    // passkey {passkeys: [A]} but would count as a second signer, silently
    // bypassing the #908 mainnet floor. Found by the money-path review.
    if (owner_address !== undefined && /^0x0{40}$/i.test(owner_address)) {
      return reply.code(400).send({ error: 'owner_address must not be the zero address' })
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
    // Duplicate key_ids collapse to ONE on-chain key (and the passkey table's
    // ON CONFLICT dedupes) — they must not inflate the #908 signer count.
    const uniqueKeyIds = new Set(parsedPasskeys.map((pk) => pk.keyId.toLowerCase()))
    if (uniqueKeyIds.size !== parsedPasskeys.length) {
      return reply.code(400).send({ error: 'duplicate passkey key_id' })
    }

    // #1153: provisioning no longer refuses a single-signer account on a
    // value-bearing chain. The #908 floor became a recommendation shown AFTER
    // funding — the owner's call, recorded on that issue — because a wall in
    // the first minute blocked the one-Face-ID onboarding this rail exists to
    // offer, at the moment the user has nothing at risk and no context for
    // what a backup signer protects. An acknowledgement is still RECORDED
    // below when one is sent; it just no longer unblocks anything.
    const signerCount = parsedPasskeys.length + (owner_address ? 1 : 0)
    const waiverAcknowledged = single_signer_waiver?.acknowledged === true

    if (!DELEGATION_RAIL_CHAIN_IDS.has(chainId)) {
      return reply.code(400).send({
        error: `Hybrid accounts are not available on chain ${chainId} yet`,
        supported: [...DELEGATION_RAIL_CHAIN_IDS],
      })
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

    // Record the waiver ONLY when it actually gated something: a value-bearing
    // chain below the signer floor (#908 — "recorded, signed-off"). Testnet
    // requests and ≥2-signer accounts never carry one.
    const recordWaiver =
      waiverAcknowledged && isValueBearingChain(chainId) && signerCount < 2

    const result = await pool.query<{ id: string; created_at: string }>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, name, is_default, account_type, execution_rail, owner_address, single_signer_waiver_at)
       VALUES ($1, $2, $3, $4, $5, 'delegator_hybrid', 'delegation', $6, $7)
       RETURNING id, created_at`,
      // owner_address: the EOA owner for treasury ops (#828 revoke). A pure-
      // passkey account has none — its config lives in hybrid_account_passkeys.
      [sub, accountAddress, chainId, name?.trim() || 'My account', isFirst, owner_address?.toLowerCase() ?? null, recordWaiver ? new Date().toISOString() : null],
    )
    const userSafeId = result.rows[0].id

    // Persist the passkey signer set (#885): the account address was derived
    // from EXACTLY these coordinates, so activation (#860 deploy) and revoke
    // can reconstruct the owner config for a pure-passkey account.
    for (const pk of parsedPasskeys) {
      await pool.query(
        `INSERT INTO hybrid_account_passkeys (user_safe_id, key_id, public_key_x, public_key_y)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_safe_id, key_id) DO NOTHING`,
        [userSafeId, pk.keyId, `0x${pk.x.toString(16)}`, `0x${pk.y.toString(16)}`],
      )
    }

    return reply.code(201).send({
      id: userSafeId,
      account_address: accountAddress,
      chain_id: chainId,
      account_type: 'delegator_hybrid',
      // Counterfactual: no deployment tx — the first sponsored operation
      // (the budget grant, #828) deploys the code.
      deployed: false,
      created_at: result.rows[0].created_at,
    })
  })

  /**
   * Resolve an account the caller owns from (address, chain) — the
   * account-scoped counterpart to agent-delegations' `loadOwnedDelegationAgent`.
   * Ownership is the `user_safes` row, so a caller can only ever reach their
   * own account regardless of which address they name.
   */
  async function resolveOwnedHybridAccount(
    userId: string,
    address: string,
    chainIdRaw: string | undefined,
  ): Promise<
    | { ok: true; account: SignerActionAccount }
    | { ok: false; status: 400 | 404 | 409; error: string }
  > {
    if (!isValidAddress(address)) {
      return { ok: false, status: 400, error: 'Invalid address' }
    }
    const chainId = Number(chainIdRaw)
    if (!Number.isFinite(chainId)) {
      return { ok: false, status: 400, error: 'chain_id is required' }
    }
    // `SELECT 1`, matching the sibling GET verbatim — the provisioning route's
    // duplicate check is a `SELECT id FROM user_safes`, and sharing that shape
    // would make pattern-matched test mocks ambiguous between the two.
    const owned = await pool.query(
      `SELECT 1 FROM user_safes
       WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3
         AND account_type = 'delegator_hybrid'`,
      [userId, address, chainId],
    )
    if (owned.rows.length === 0) {
      return { ok: false, status: 404, error: 'Account not found' }
    }
    const owner = await loadHybridOwnerConfig(userId, address, chainId)
    if (!owner) {
      return { ok: false, status: 409, error: 'Account signer configuration unknown' }
    }
    return {
      ok: true,
      account: {
        accountAddress: address as `0x${string}`,
        chainId,
        userSafeId: owner.userSafeId,
        config: owner.config,
        singleSignerWaiverAt: owner.singleSignerWaiverAt,
      },
    }
  }

  // ── Account-scoped signer management (#1081) ──────────────────────────────
  //
  // The agent-scoped twin (`/agents/:id/account-signers/*`, #888) required an
  // agent to exist before an account could enrol a backup or remove a key —
  // so a fresh account had no path to its own recovery setup, which is when
  // a user can add a backup before it holds funds.
  //
  // Same helpers, same authority rules, same last-signer guard — the only
  // difference is that the account is resolved by (address, chain) instead of
  // through an agent. `chain_id` stays on the query string so an account is
  // addressed identically here and on the sibling GET.
  app.post<{
    Params: { address: string }
    Querystring: { chain_id?: string }
    Body: SignerActionBody
  }>('/hybrid/:address/signers/prepare', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const resolved = await resolveOwnedHybridAccount(sub, request.params.address, request.query.chain_id)
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error })

    const result = await prepareSignerChange(resolved.account, request.body ?? {})
    if (!result.ok) {
      const { status, error, details } = result.failure
      return reply.code(status).send(details ? { error, details } : { error })
    }
    return result.prepared
  })

  app.post<{
    Params: { address: string }
    Querystring: { chain_id?: string }
    Body: SignerActionBody & { signature?: string; user_operation?: unknown }
  }>('/hybrid/:address/signers/submit', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    // Envelope first, matching the agent-scoped route's precedence.
    const envelope = validateSignedSubmission(request.body ?? {})
    if (!envelope.ok) {
      return reply.code(envelope.failure.status).send({ error: envelope.failure.error })
    }
    const resolved = await resolveOwnedHybridAccount(sub, request.params.address, request.query.chain_id)
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error })

    const result = await submitSignerChange(resolved.account, request.body ?? {})
    if (!result.ok) {
      const { status, error, details } = result.failure
      return reply.code(status).send(details ? { error, details } : { error })
    }
    return { updated: true, tx_hash: result.txHash }
  })

  // ── Owner-initiated send (#1083) ──────────────────────────────────────────
  // The rail's "Send": the treasury executes an ERC-20 transfer as a
  // sponsored account op the OWNER signs — same prepare/submit +
  // calldata-pinning discipline as signer changes, same device-decides
  // signature scheme (#1086). Works on a COUNTERFACTUAL account (#1106:
  // deploy + transfer ride one sponsored op).
  app.post<{
    Params: { address: string }
    Querystring: { chain_id?: string }
    Body: TransferBody
  }>('/hybrid/:address/transfers/prepare', { config: moneyPathRateLimit }, async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const resolved = await resolveOwnedHybridAccount(sub, request.params.address, request.query.chain_id)
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error })

    const result = await prepareTransfer(resolved.account, request.body ?? {})
    if (!result.ok) {
      const { status, error, details } = result.failure
      return reply.code(status).send(details ? { error, details } : { error })
    }
    return result.prepared
  })

  app.post<{
    Params: { address: string }
    Querystring: { chain_id?: string }
    Body: TransferBody & { signature?: string; user_operation?: unknown }
  }>('/hybrid/:address/transfers/submit', { config: moneyPathRateLimit }, async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const resolved = await resolveOwnedHybridAccount(sub, request.params.address, request.query.chain_id)
    if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error })

    const result = await submitTransfer(resolved.account, request.body ?? {})
    if (!result.ok) {
      const { status, error, details } = result.failure
      return reply.code(status).send(details ? { error, details } : { error })
    }
    return { submitted: true, tx_hash: result.txHash }
  })

  // ── GET /hybrid/:address/signers — the ACCOUNT's signer set (#1079) ───────
  //
  // The agent-scoped twin lives in agent-delegations.ts (#887); this one is
  // needed twice over: to resolve a signer at LOGIN (before any agent
  // exists), and to give account-level recovery a data source — a delegation
  // account with zero agents previously had no path to its own signer set.
  // Owner-scoped; public-key material only — nothing secret.
  app.get<{ Params: { address: string }; Querystring: { chain_id?: string } }>(
    '/hybrid/:address/signers',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      // Same resolution as the management routes below — one copy, so the
      // read and the write can never disagree about who owns an account.
      const resolved = await resolveOwnedHybridAccount(sub, request.params.address, request.query.chain_id)
      if (!resolved.ok) return reply.code(resolved.status).send({ error: resolved.error })

      const { accountAddress, chainId, config } = resolved.account
      return {
        account_address: accountAddress,
        chain_id: chainId,
        owner_address: config.ownerAddress ?? null,
        passkeys: (config.passkeys ?? []).map((p) => ({
          key_id: p.keyId,
          x: `0x${p.x.toString(16)}`,
          y: `0x${p.y.toString(16)}`,
        })),
      }
    },
  )
}
