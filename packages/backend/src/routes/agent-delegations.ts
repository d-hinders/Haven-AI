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

import { RelayerBudgetExceededError } from '../infra/relayer-spend-guard.js'
import { FastifyInstance } from 'fastify'
import type { Hex, Address } from '../domain/chain-client.js'
// dep-lint-exempt: 8 grant-lifecycle statements on a dedicated client (pool.connect); the guarded version/waiver checks must travel with their writes, making this a >100-line move deferred under #999
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import { getChain } from '../domain/chains.js'
import { DELEGATION_RAIL_CHAIN_IDS } from '../rails/delegation-contracts.js'
import { computeHybridAccountAddress, ensureHybridDeployed } from '../rails/hybrid-provisioning.js'
import { loadHybridOwnerConfig } from '../rails/hybrid-account-config.js'
import { listAccountPasskeys, passkeyEnrollmentDates } from '../infra/repositories/hybrid-signers.js'
import {
  loadOwnedDelegationAgent,
  insertPendingDelegationForOwnedNonRevokedAgent,
  lockOwnedNonRevokedDelegationAgent,
  HAS_IN_FLIGHT_REKEY_FOR_AGENT_SQL,
} from '../infra/repositories/agents.js'
import type { HybridOwnerConfig } from '../rails/hybrid-provisioning.js'
import {
  buildBudgetDelegation,
  buildRevocation,
  delegationIdentity,
  delegationSigningPayload,
  type HavenBudgetPolicy,
} from '../rails/delegation-policy.js'
import {
  createTreasuryOps,
  delegationRailBundlerUrl,
  readDisabledDelegationHashes,
} from '../rails/delegation-rail.js'
import {
  activatePendingDelegationInSlot,
  listNonRevokedDelegationsForAgent,
  revokeDelegationsByHashes,
} from '../infra/repositories/delegation-budgets.js'
import { redactVendorSecrets } from '../rails/execution-rail.js'
// Signer management is shared with the account-scoped routes (#1081) — one
// copy of the authority rules, reached two ways.
import {
  prepareSignerChange,
  resolveSignatureScheme,
  submitSignerChange,
  validateSignedSubmission,
  type SignerActionBody,
} from '../rails/hybrid-signer-actions.js'

/** Vendor errors echo the bundler URL (which embeds the API key) — #764. */
function safeDetails(err: unknown): string {
  return redactVendorSecrets(err instanceof Error ? err.message : String(err))
}

const MAX_UINT96 = (1n << 96n) - 1n
const HASH_RE = /^0x[0-9a-fA-F]{64}$/

// #1423: revoke-all bundles one disableDelegation call per delegation into a
// single UserOp. Unbounded, a pathological agent could blow gas/payload
// limits (a loud 502 — availability, not safety). Real agents hold a handful
// of budgets; past this, per-hash revocation is the escape hatch.
const MAX_REVOKE_ALL_BATCH = 25
// Coarse pre-read ceiling: past this we refuse BEFORE spending any RPC budget
// on the reconciliation reads. Sits well above the batch cap so healed
// orphans can never push a legitimately-sized batch into this refusal.
const RECONCILE_READ_CEILING = 100

export const REVOKED_AGENT_REFUSAL = 'Revoked agents cannot receive new budget delegations'
export const NOT_DELEGATION_RAIL_REFUSAL = 'Agent account is not on the delegation rail'
export const NO_DELEGATE_KEY_REFUSAL = 'Agent has no delegate key or treasury account'
export const IN_FLIGHT_REKEY_REFUSAL =
  'A key rotation is in flight for this agent — finish or abandon the re-key before granting a new budget'
export const UNAVAILABLE_AGENT_REFUSAL =
  'Agent cannot receive a budget while its account or re-key is unavailable'

/**
 * Name the reason a pending-grant insert was refused (#2416).
 *
 * `insertPendingDelegationForOwnedNonRevokedAgent` collapses FOUR distinct
 * refusals into one boolean — revoked agent, account off the delegation rail,
 * no delegate key, and (since #2331) an in-flight re-key. `build` reported all
 * four as "Revoked agents cannot receive new budget delegations", so an owner
 * who abandoned a re-key part-way was told their perfectly healthy `active`
 * agent was revoked.
 *
 * This is PURELY diagnostic and runs only on the refusal path: the grant
 * transaction has already concluded and the request is already refused. Note
 * what that concluding is — `insertPendingDelegationForOwnedNonRevokedAgent`
 * returns `false` from inside `withTransaction`'s callback, which is a NORMAL
 * return, so the transaction COMMITs (an empty commit — the lock found no row
 * and nothing was written). It is not a rollback; the refusal is carried by
 * the boolean, not by an aborted transaction. Either way nothing was stored,
 * and this re-read only decides which 409 body the owner sees. It can never
 * turn a refusal into a grant — the set of refused requests is exactly what
 * it was.
 *
 * The branch order mirrors `lockOwnedNonRevokedDelegationAgent`'s own SQL
 * (status, then account_type, then delegate_address, then the re-key probe), so
 * when more than one reason holds the message names the same one the lock
 * stopped on.
 */
async function describeBuildRefusal(agentId: string, userId: string): Promise<string> {
  const agent = await loadOwnedDelegationAgent(agentId, userId)
  if (!agent) return UNAVAILABLE_AGENT_REFUSAL
  if (agent.status === 'revoked') return REVOKED_AGENT_REFUSAL
  if (agent.account_type !== 'delegator_hybrid') return NOT_DELEGATION_RAIL_REFUSAL
  if (!agent.delegate_address) return NO_DELEGATE_KEY_REFUSAL
  const rekey = await pool.query<{ in_flight: boolean }>(HAS_IN_FLIGHT_REKEY_FOR_AGENT_SQL, [agentId])
  if (rekey.rows[0]?.in_flight === true) return IN_FLIGHT_REKEY_REFUSAL
  return UNAVAILABLE_AGENT_REFUSAL
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

  // ── GET /:id/account-signers — the treasury's signer set (#887) ───────────
  // The dashboard builds the account's WebAuthn signer from this (kit
  // deployParams must match EXACTLY what provisioning derived the address
  // from). Owner-scoped; public-key material only — nothing secret.
  app.get<{ Params: { id: string } }>('/:id/account-signers', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    if (agent.account_type !== 'delegator_hybrid' || !agent.treasury_address) {
      return reply.code(409).send({ error: 'Agent account is not on the delegation rail' })
    }
    const owner = await loadHybridOwnerConfig(sub, agent.treasury_address, agent.chain_id)
    if (!owner) return reply.code(409).send({ error: 'Account signer configuration unknown' })
    // #1679: per-credential enrollment time, same join as the account-scoped
    // read in hybrid-accounts.ts — this twin can hydrate the same stored
    // signer set the UI labels ("Passkey · added {date}"), so the two reads
    // must carry the same shape.
    const createdByKey = passkeyEnrollmentDates(await listAccountPasskeys(owner.userSafeId))
    return {
      account_address: agent.treasury_address,
      chain_id: agent.chain_id,
      owner_address: owner.config.ownerAddress ?? null,
      passkeys: (owner.config.passkeys ?? []).map((p) => ({
        key_id: p.keyId,
        x: `0x${p.x.toString(16)}`,
        y: `0x${p.y.toString(16)}`,
        created_at: createdByKey.get(p.keyId.toLowerCase()) ?? null,
      })),
    }
  })

  // ── Signer management (#888, epic #836) ───────────────────────────────────
  // Enroll a backup passkey/EOA, or remove a passkey — as ACCOUNT ops
  // (addKey / removeKey / transferOwnership) prepared here and signed by an
  // EXISTING signer. Haven prepares, never signs (#824 invariant 12). The
  // The shared guard mirrors only the chain's CannotRemoveLastSigner rule
  // (#884), so an attempted final-signer removal gets a clear 409 instead of
  // an opaque revert. An informed two-to-one transition is permitted (#1199).
  app.post<{ Params: { id: string }; Body: SignerActionBody }>(
    '/:id/account-signers/prepare',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const agent = await loadOwnedDelegationAgent(request.params.id, sub)
      if (!agent) return reply.code(404).send({ error: 'Agent not found' })
      if (agent.account_type !== 'delegator_hybrid' || !agent.treasury_address) {
        return reply.code(409).send({ error: 'Agent account is not on the delegation rail' })
      }
      const owner = await loadHybridOwnerConfig(sub, agent.treasury_address, agent.chain_id)
      if (!owner) return reply.code(409).send({ error: 'Account signer configuration unknown' })

      const result = await prepareSignerChange(
        {
          accountAddress: agent.treasury_address as Address,
          chainId: agent.chain_id,
          userSafeId: owner.userSafeId,
          config: owner.config,
          singleSignerWaiverAt: owner.singleSignerWaiverAt,
        },
        request.body ?? {},
      )
      if (!result.ok) {
        const { status, error, details } = result.failure
        return reply.code(status).send(details ? { error, details } : { error })
      }
      return result.prepared
    },
  )

  app.post<{ Params: { id: string }; Body: SignerActionBody & { signature?: string; user_operation?: unknown } }>(
    '/:id/account-signers/submit',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const agent = await loadOwnedDelegationAgent(request.params.id, sub)
      if (!agent) return reply.code(404).send({ error: 'Agent not found' })
      // Envelope first, config second — the precedence this route has always
      // had: a malformed body is a 400 regardless of config state.
      const envelope = validateSignedSubmission(request.body ?? {})
      if (!envelope.ok) {
        return reply.code(envelope.failure.status).send({ error: envelope.failure.error })
      }
      const owner = await loadHybridOwnerConfig(sub, agent.treasury_address as string, agent.chain_id)
      if (!owner) return reply.code(409).send({ error: 'Account signer configuration unknown' })

      const result = await submitSignerChange(
        {
          accountAddress: agent.treasury_address as Address,
          chainId: agent.chain_id,
          userSafeId: owner.userSafeId,
          config: owner.config,
          singleSignerWaiverAt: owner.singleSignerWaiverAt,
        },
        request.body ?? {},
      )
      if (!result.ok) {
        const { status, error, details } = result.failure
        return reply.code(status).send(details ? { error, details } : { error })
      }
      return { updated: true, tx_hash: result.txHash }
    },
  )

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
    if (agent.status === 'revoked') {
      return reply.code(409).send({ error: REVOKED_AGENT_REFUSAL })
    }
    if (agent.account_type !== 'delegator_hybrid') {
      return reply.code(409).send({ error: NOT_DELEGATION_RAIL_REFUSAL })
    }
    if (!agent.delegate_address || !agent.treasury_address) {
      return reply.code(409).send({ error: NO_DELEGATE_KEY_REFUSAL })
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
    const inserted = await insertPendingDelegationForOwnedNonRevokedAgent({
      agentId: request.params.id,
      userId: sub,
      chainId: agent.chain_id,
      tokenAddress: token_address,
      recipientAddress: recipient_address ? recipient_address.toLowerCase() : null,
      delegationHash: hash,
      delegationJson: JSON.stringify(delegation),
      version,
      budgetAtomic: budget_atomic,
      periodSeconds: period_seconds,
      startDate: nowSec - 60,
      expiresAt: expiry,
    })
    if (!inserted) {
      // Same 409, same refused request set — only the reason reporting changes (#2416).
      return reply.code(409).send({ error: await describeBuildRefusal(request.params.id, sub) })
    }
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
      if (agent.status === 'revoked') {
        return reply.code(409).send({ error: REVOKED_AGENT_REFUSAL })
      }
      const { signature } = request.body ?? {}
      // EOA signatures are 65 bytes (130 hex); a passkey account's delegation
      // signature is an ABI-encoded WebAuthn assertion — longer (#887). The
      // REAL validator is EIP-1271 at redemption; this is a shape check only.
      if (!signature || !/^0x[0-9a-fA-F]{130,}$/.test(signature) || signature.length % 2 !== 0) {
        return reply.code(400).send({ error: 'An owner signature is required (65-byte ECDSA or WebAuthn assertion)' })
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
      const owner = await loadHybridOwnerConfig(sub, agent.treasury_address as string, agent.chain_id)
      if (!owner) {
        return reply.code(409).send({
          error: 'Account signer configuration unknown — cannot deploy this account',
        })
      }

      // #1153: activation no longer refuses below the signer floor. A budget
      // may be granted to a single-signer account on a value-bearing chain —
      // the backup-signer recommendation reaches the user after funding
      // instead. The account is no more recoverable than it was; what changed
      // is that Haven says so at a moment the user can act on, rather than
      // refusing the grant. (#908's activation gate lived here.)

      try {
        const deployed = await ensureHybridDeployed(
          agent.chain_id,
          owner.config,
          agent.treasury_address as Address,
          { agentId: agent.agent_id, userId: sub },
        )
        if (deployed.address.toLowerCase() !== String(agent.treasury_address).toLowerCase()) {
          // The stored owner no longer derives the stored account — refuse
          // rather than activate a grant the chain can never honour.
          return reply.code(500).send({ error: 'Account derivation mismatch — contact support' })
        }
      } catch (err) {
        if (err instanceof RelayerBudgetExceededError) {
          return reply.code(429).send({ error: err.message })
        }
        return reply.code(502).send({
          error: 'Could not deploy the account for this budget — try again',
          details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
        })
      }

      const signed = { ...JSON.parse(pending.delegation_json), signature }
      // Activate the new grant and mark any previously ACTIVE grant for the
      // same (token, recipient) slot as replaced — the on-chain kill of the
      // old one is the revoke flow (compose for immediate replacement).
      //
      // ONE transaction (#1053 review, finding 4): as two separate queries, a
      // failure between them left the slot with ZERO active grants — every
      // payment 403s while the old grant is still perfectly valid on-chain.
      // Atomically it's replace-and-activate or neither.
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        // Lock the lifecycle row before changing delegation state. If a revoke
        // committed first, refuse; if it races us, it serializes after this
        // atomic activation and can still revoke the resulting authority.
        const lockedAgent = await lockOwnedNonRevokedDelegationAgent(request.params.id, sub, client)
        if (!lockedAgent) {
          await client.query('ROLLBACK')
          return reply.code(409).send({ error: UNAVAILABLE_AGENT_REFUSAL })
        }
        const currentDelegateAccountAddress = await computeHybridAccountAddress(agent.chain_id, {
          ownerAddress: lockedAgent.delegate_address as Address,
        })
        if (
          typeof signed.delegate !== 'string' ||
          signed.delegate.toLowerCase() !== currentDelegateAccountAddress.toLowerCase()
        ) {
          await client.query('ROLLBACK')
          return reply.code(409).send({ error: 'Delegation was built for a previous delegate key' })
        }
        // Sweep the slot's OTHER active grants, then flip the pending row —
        // one repository call that owns the order and excludes the new row by
        // id (#2411: #2331 ran the sweep after the activation, without an
        // exclusion, and every activation committed with zero active rows).
        const activated = await activatePendingDelegationInSlot(
          {
            agentId: request.params.id,
            delegationId: pending.id,
            tokenAddress: pending.token_address,
            recipientAddress: pending.recipient_address,
            signedDelegationJson: JSON.stringify(signed),
          },
          client,
        )
        if (!activated) {
          await client.query('ROLLBACK')
          return reply.code(409).send({ error: 'Delegation is no longer pending' })
        }
        // #1069: on the delegation rail the OWNER'S GRANT SIGNATURE is the
        // approval — there is no AllowanceModule wallet-approval step to flip
        // the agent, so a modal-created agent stayed 'pending_approval'
        // forever. Activating the first budget activates the agent, inside
        // the same transaction as the grant it rests on.
        await client.query(
          `UPDATE agents SET status = 'active', updated_at = NOW()
           WHERE id = $1 AND status = 'pending_approval'`,
          [request.params.id],
        )
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
      return { activated: true, delegation_hash: request.params.hash }
    },
  )

  // ── POST /:id/delegations/revoke-all — #1400: ONE signature kills every
  // non-revoked budget delegation. Step 1 of #1402's Remove-agent action.
  // Mirrors the per-hash prepare exactly; the only new mechanics is the
  // batched UserOp (prepareCalls) — no second copy of the authority rules.
  app.post<{ Params: { id: string } }>('/:id/delegations/revoke-all', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    if (agent.account_type !== 'delegator_hybrid') {
      return reply.code(409).send({
        error:
          'Batch revocation is a delegation-rail operation. This agent is on the AllowanceModule rail — remove its allowances via the wallet-approval teardown instead.',
      })
    }

    let targets = await listNonRevokedDelegationsForAgent(request.params.id)
    if (targets.length === 0) {
      return reply.code(409).send({ error: 'Nothing to revoke — the agent has no pending or active budget delegations.' })
    }

    if (targets.length > RECONCILE_READ_CEILING) {
      // Cite the ceiling this actually gated on — quoting the batch cap here
      // told an agent with 150 delegations "150 > 25", a true refusal with a
      // wrong number.
      return reply.code(422).send({
        error: `Too many delegations to reconcile in one request (${targets.length} > ${RECONCILE_READ_CEILING}). Revoke individually via POST /agents/:id/delegations/:hash/revoke, then retry.`,
      })
    }

    // #1423: disableDelegation is NOT idempotent (AlreadyDisabled revert), and
    // the batch is atomic — one already-disabled entry would revert the whole
    // op. A row can be stale-active while disabled on-chain (the #1400 crash
    // window: UserOp landed, process died before the UPDATE). Heal those rows
    // to `revoked` here and drop them from the batch. A failed read degrades
    // to the pre-#1423 behavior (full batch) rather than blocking revocation —
    // availability over a rare bundled revert, which still fails loudly (502).
    // Heals are marked-without-a-signature, so the read is double-confirmed at
    // `finalized` (see readDisabledDelegationHashes) and every heal is logged
    // distinctly from an owner-signed revoke.
    try {
      const disabled = await readDisabledDelegationHashes(
        agent.chain_id,
        getChain(agent.chain_id).rpcUrl,
        targets.map((t) => t.delegation_hash as Hex),
      )
      if (disabled.size > 0) {
        const healed = await revokeDelegationsByHashes(request.params.id, [...disabled])
        request.log.warn(
          { agentId: request.params.id, healed },
          'revoke-all reconciled on-chain-disabled delegations to revoked (no signature — chain state was already disabled)',
        )
        targets = targets.filter((t) => !disabled.has(t.delegation_hash as Hex))
      }
    } catch (err) {
      request.log.warn({ err }, 'disabled-delegations read failed; proceeding with the full batch')
    }
    if (targets.length === 0) {
      // Everything was already disabled on-chain — the rows are now healed,
      // so this is the same "step already done" signal the retry flow expects.
      return reply.code(409).send({ error: 'Nothing to revoke — every delegation was already disabled on-chain (records reconciled).' })
    }
    if (targets.length > MAX_REVOKE_ALL_BATCH) {
      return reply.code(422).send({
        error: `Too many delegations for one batch (${targets.length} > ${MAX_REVOKE_ALL_BATCH}). Revoke individually via POST /agents/:id/delegations/:hash/revoke, then retry.`,
      })
    }

    const owner = await loadHybridOwnerConfig(sub, agent.treasury_address as string, agent.chain_id)
    if (!owner) {
      return reply.code(409).send({
        error: 'Account signer configuration unknown — revoke via the exit path (docs)',
      })
    }

    try {
      const calls = targets.map((target) => {
        const revocation = buildRevocation(JSON.parse(target.delegation_json), agent.chain_id)
        return { to: revocation.to, data: revocation.data }
      })
      const resolved = resolveSignatureScheme(
        (request.body as { signature_scheme?: string } | undefined)?.signature_scheme,
        owner.config,
      )
      if ('error' in resolved) return reply.code(409).send({ error: resolved.error })
      const treasury = await createTreasuryOps({
        ownerAddress: owner.config.ownerAddress,
        passkeys: owner.config.passkeys,
        accountAddress: agent.treasury_address as Address,
        chainId: agent.chain_id,
        bundlerUrl: delegationRailBundlerUrl(agent.chain_id),
        rpcUrl: getChain(agent.chain_id).rpcUrl,
        sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
        signWith: resolved.scheme === 'webauthn_userop' ? 'passkey' : 'owner',
      })
      const prepared = await treasury.prepareCalls(calls)
      const user_operation = JSON.parse(
        JSON.stringify(prepared.userOperation, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
      )
      const delegation_hashes = targets.map((target) => target.delegation_hash)
      if (resolved.scheme === 'webauthn_userop') {
        return {
          signature_scheme: 'webauthn_userop',
          user_op_hash: prepared.userOpHash,
          user_operation,
          treasury_address: prepared.treasuryAddress,
          delegation_hashes,
          instructions:
            'Sign user_op_hash with the account passkey (WebAuthn), then POST /revoke-all/submit',
        }
      }
      return {
        signature_scheme: 'eip712_userop',
        signing_payload: prepared.signingTypedData,
        user_operation,
        treasury_address: prepared.treasuryAddress,
        delegation_hashes,
        instructions:
          'Sign signing_payload (EIP-712) with the treasury owner key, then POST /revoke-all/submit',
      }
    } catch (err) {
      return reply.code(502).send({ error: 'Could not prepare the batch revocation', details: safeDetails(err) })
    }
  })

  // ── POST /:id/delegations/revoke-all/submit — step 2 ─────────────────────
  app.post<{
    Params: { id: string }
    Body: { signature?: string; user_operation?: unknown; delegation_hashes?: unknown }
  }>('/:id/delegations/revoke-all/submit', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    const { signature, user_operation, delegation_hashes } = request.body ?? {}
    if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return reply.code(400).send({ error: 'signature is required' })
    }
    if (!user_operation || typeof user_operation !== 'object') {
      return reply.code(400).send({ error: 'user_operation (from the prepare step) is required' })
    }
    if (
      !Array.isArray(delegation_hashes) ||
      delegation_hashes.length === 0 ||
      !delegation_hashes.every((h) => typeof h === 'string' && HASH_RE.test(h))
    ) {
      return reply.code(400).send({ error: 'delegation_hashes (from the prepare step) is required' })
    }
    const owner = await loadHybridOwnerConfig(sub, agent.treasury_address as string, agent.chain_id)
    if (!owner) return reply.code(409).send({ error: 'Account signer configuration unknown' })

    try {
      const treasury = await createTreasuryOps({
        ownerAddress: owner.config.ownerAddress,
        passkeys: owner.config.passkeys,
        accountAddress: agent.treasury_address as Address,
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
      // DB write ONLY after the UserOp landed — a failed submit leaves every
      // row untouched (no optimistic revocation). Scoped to this agent, so a
      // stray hash flips nothing foreign; the response reports what actually
      // flipped rather than echoing the request.
      const revoked = await revokeDelegationsByHashes(request.params.id, delegation_hashes as string[])
      return { revoked: true, tx_hash: result.txHash, delegation_hashes: revoked }
    } catch (err) {
      return reply.code(502).send({ error: 'Batch revocation failed', details: safeDetails(err) })
    }
  })

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

      // #1423: same crash-window hardening as revoke-all — disableDelegation
      // REVERTS on an already-disabled delegation, so an orphaned row here
      // would 502 on prepare forever. Heal it and answer with the same
      // already-done signal; a failed read degrades to the normal prepare.
      try {
        const disabled = await readDisabledDelegationHashes(
          agent.chain_id,
          getChain(agent.chain_id).rpcUrl,
          [request.params.hash as Hex],
        )
        if (disabled.size > 0) {
          const healed = await revokeDelegationsByHashes(request.params.id, [request.params.hash])
          request.log.warn(
            { agentId: request.params.id, healed },
            'per-hash revoke reconciled an on-chain-disabled delegation to revoked (no signature — chain state was already disabled)',
          )
          return reply.code(409).send({ error: 'Already revoked — the delegation was disabled on-chain and the record has been reconciled.' })
        }
      } catch (err) {
        request.log.warn({ err }, 'disabled-delegation read failed; proceeding with the normal prepare')
      }

      // Reconstruct the treasury's owner config (#885): an EOA account signs
      // the EIP-712 typed data; a pure-passkey account signs the userOpHash via
      // WebAuthn (#887). Check BEFORE building — a cheap 409 beats a 502.
      const owner = await loadHybridOwnerConfig(sub, agent.treasury_address as string, agent.chain_id)
      if (!owner) {
        return reply.code(409).send({
          error: 'Account signer configuration unknown — revoke via the exit path (docs)',
        })
      }

      try {
        const revocation = buildRevocation(JSON.parse(target.delegation_json), agent.chain_id)
        const resolved = resolveSignatureScheme(
          (request.body as { signature_scheme?: string } | undefined)?.signature_scheme,
          owner.config,
        )
        if ('error' in resolved) return reply.code(409).send({ error: resolved.error })
        const treasury = await createTreasuryOps({
          ownerAddress: owner.config.ownerAddress,
          passkeys: owner.config.passkeys,
          accountAddress: agent.treasury_address as Address,
          chainId: agent.chain_id,
          bundlerUrl: delegationRailBundlerUrl(agent.chain_id),
          rpcUrl: getChain(agent.chain_id).rpcUrl,
          sponsorshipPolicyId: process.env.DELEGATION_RAIL_SPONSORSHIP_POLICY_ID || undefined,
          signWith: resolved.scheme === 'webauthn_userop' ? 'passkey' : 'owner',
        })
        const prepared = await treasury.prepareCall(revocation.to, revocation.data)
        const user_operation = JSON.parse(
          JSON.stringify(prepared.userOperation, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
        )
        if (resolved.scheme === 'webauthn_userop') {
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
    const owner = await loadHybridOwnerConfig(sub, agent.treasury_address as string, agent.chain_id)
    if (!owner) return reply.code(409).send({ error: 'Account signer configuration unknown' })

    try {
      const treasury = await createTreasuryOps({
        ownerAddress: owner.config.ownerAddress,
        passkeys: owner.config.passkeys,
        accountAddress: agent.treasury_address as Address,
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
