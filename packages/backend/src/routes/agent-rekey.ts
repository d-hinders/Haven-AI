/**
 * Agent re-key — owner-authorised credential rotation (#1698, epic #1694).
 *
 * Same agent identity, new delegate key, new API key, old authority revoked.
 * The agent row keeps its id, name, history and passport; only its
 * credentials change. This is what "I lost my key" should do, and it is why
 * losing a delegate key is recoverable at all: the delegate never held owner
 * authority, so the account owner can replace it.
 *
 * ## Who may call this, and who may never
 *
 * > "An agent can never re-key itself. Re-key is authorised by the account
 * > owner, through the dashboard. An agent rotating its own credentials would
 * > be an agent editing its own authority." (#1694)
 *
 * These routes sit behind `authMiddleware` (the dashboard session), so an
 * agent API key does not authenticate here at all. That is necessary and it
 * is not sufficient as a STATEMENT of the rule: a future refactor that added
 * an agent-auth hook would break the invariant silently. `refuseAgentCaller`
 * below therefore refuses an agent credential EXPLICITLY, and names why, so
 * the rule is visible at the place it applies rather than implied by which
 * hook happens to be installed.
 *
 * ## Why this is several requests
 *
 * Revoke and issue are both on-chain and both signed by the ACCOUNT OWNER —
 * Haven signs neither (#824 invariants 5/12, non-custody). So a re-key is a
 * sequence of prepare/submit round trips, and the ordering invariant has to
 * survive between them. It lives in `modules/agents/rekey-stages.ts` and in
 * the `agent_rekeys` CHECK constraints, not in the order of statements here.
 *
 *   POST /agents/:id/rekey                        preflight → returns residual + revoke payload
 *   POST /agents/:id/rekey/:rekeyId/revoke        submit the signed revoke; then meter
 *   POST /agents/:id/rekey/:rekeyId/issue         build the carried delegations
 *   POST /agents/:id/rekey/:rekeyId/complete      activate, rotate credentials, invalidate intents
 *   POST /agents/:id/rekey/:rekeyId/abandon       record a stopped re-key
 *
 * #1700 builds the client that drives this. It is a separate issue with a
 * separate owner; nothing here implements it.
 *
 * ## Non-custody
 *
 * `new_delegate_address` is a PUBLIC address. The keypair is generated on the
 * target machine and Haven never receives the private half. There is
 * deliberately no endpoint that accepts, stores or "restores" a key to a new
 * host — #1694 says that design is out of scope and should be refused, not
 * built.
 *
 * ## Where the SQL is
 *
 * Not here. Every query this flow needs lives in
 * `infra/repositories/agent-rekeys.ts`, so the route reads as a sequence of
 * decisions and every statement is reachable from the real-DB harness without
 * standing up Fastify. The one exception is the completion transaction, which
 * takes a dedicated client so the credential swap, the intent invalidation
 * and the stage advance commit or roll back together — the same shape the
 * grant lifecycle uses, and the reason for the `dep-lint-exempt` below.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import crypto from 'crypto'
import type { Address, Hex } from '../domain/chain-client.js'
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import { getChain } from '../domain/chains.js'
import { DELEGATION_RAIL_CHAIN_IDS } from '../rails/delegation-contracts.js'
import { computeHybridAccountAddress } from '../rails/hybrid-provisioning.js'
import { loadHybridOwnerConfig } from '../rails/hybrid-account-config.js'
import {
  buildBudgetDelegation,
  buildRevocation,
  delegationIdentity,
  delegationSigningPayload,
  type HavenBudgetPolicy,
} from '../rails/delegation-policy.js'
import { createTreasuryOps, delegationRailBundlerUrl } from '../rails/delegation-rail.js'
import { redactVendorSecrets } from '../rails/execution-rail.js'
import { getTokenBalance } from '../rails/allowance-module.js'
import { sweepUsdcAddress } from '@haven_ai/sdk'
import { readRemainingBudget } from '../infra/chain/delegation-budget-reader.js'
import {
  listNonRevokedDelegationsForAgent,
  revokeDelegationsByHashes,
} from '../infra/repositories/delegation-budgets.js'
import {
  abandonRekey,
  completeRekey,
  findDelegationTerms,
  findInFlightRekey,
  findLiveAgentByDelegate,
  findOwnedRekeyAgent,
  findRekey,
  insertRekeyDelegation,
  listPendingRekeyDelegations,
  markIssued,
  markMetered,
  markRevoked,
  nextDelegationVersion,
  openRekey,
  type AgentRekeyRow,
  type CarrySnapshotEntry,
  type RekeyAgentRow,
} from '../infra/repositories/agent-rekeys.js'
import {
  assertStageAllows,
  CarryRefusedError,
  planCarry,
  railRefusal,
  refuseAgentCaller,
  RekeyOrderingError,
  type DelegationTerms,
  type RekeyStage,
} from '../modules/agents/index.js'

function safeDetails(err: unknown): string {
  return redactVendorSecrets(err instanceof Error ? err.message : String(err))
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Dispositions a caller may declare for a non-zero residual. */
const RESIDUAL_DISPOSITIONS = ['swept', 'acknowledged_unrecoverable'] as const
type ResidualDisposition = (typeof RESIDUAL_DISPOSITIONS)[number]

function orderingReply(reply: FastifyReply, err: RekeyOrderingError): FastifyReply {
  return reply.code(409).send({
    error: 'rekey_out_of_order',
    stage: err.actual,
    required_stage: err.required,
    detail: err.message,
  })
}

export default async function agentRekeyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  /**
   * Resolve the agent + its in-flight re-key, applying every guard that is
   * common to the post-preflight steps. Returns null after having replied.
   */
  async function loadStep(
    request: FastifyRequest<{ Params: { id: string; rekeyId: string } }>,
    reply: FastifyReply,
  ): Promise<{ agent: RekeyAgentRow; rekey: AgentRekeyRow } | null> {
    if (refuseAgentCaller(request, reply)) return null
    const { sub } = request.user as { sub: string }
    if (!UUID_RE.test(request.params.id) || !UUID_RE.test(request.params.rekeyId)) {
      reply.code(400).send({ error: 'Invalid identifier' })
      return null
    }
    const agent = await findOwnedRekeyAgent(request.params.id, sub)
    if (!agent) {
      reply.code(404).send({ error: 'Agent not found' })
      return null
    }
    const refusal = railRefusal(agent)
    if (refusal) {
      reply.code(refusal.statusCode).send(refusal.body)
      return null
    }
    const rekey = await findRekey(request.params.rekeyId, request.params.id)
    if (!rekey) {
      reply.code(404).send({ error: 'Re-key not found' })
      return null
    }
    return { agent, rekey }
  }

  // ── POST /:id/rekey — step 0: preflight ────────────────────────────────
  //
  // Reads the residual on the OLD delegate EOA and refuses to proceed with a
  // non-zero one until the caller says what happened to it. That refusal is
  // the whole point: `haven_sweep_delegate` needs the OLD key's signature, so
  // once the rotation completes, the credential set that could authorise a
  // sweep is gone and the residual is stranded permanently. The 2026-08-21
  // canary's 0.002 USDC is the concrete shape (#1694 review).
  app.post<{
    Params: { id: string }
    Body: { new_delegate_address?: string; residual_disposition?: string }
  }>('/:id/rekey', async (request, reply) => {
    if (refuseAgentCaller(request, reply)) return reply
    const { sub } = request.user as { sub: string }
    if (!UUID_RE.test(request.params.id)) {
      return reply.code(400).send({ error: 'Invalid agent id' })
    }
    const agent = await findOwnedRekeyAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })

    const refusal = railRefusal(agent)
    if (refusal) return reply.code(refusal.statusCode).send(refusal.body)

    if (!DELEGATION_RAIL_CHAIN_IDS.has(agent.chain_id)) {
      return reply
        .code(409)
        .send({ error: `Delegation rail not enabled on chain ${agent.chain_id}` })
    }
    if (!agent.delegate_address) {
      return reply.code(409).send({
        error: 'Agent has no delegate key to replace — connect it first rather than re-keying it',
      })
    }

    const { new_delegate_address, residual_disposition } = request.body ?? {}
    if (!new_delegate_address || !isValidAddress(new_delegate_address)) {
      return reply.code(400).send({
        error:
          'new_delegate_address is required — the PUBLIC address of a keypair generated on the ' +
          'target machine. Haven never receives the private key.',
      })
    }
    if (new_delegate_address.toLowerCase() === agent.delegate_address.toLowerCase()) {
      return reply
        .code(400)
        .send({ error: 'new_delegate_address must differ from the current delegate address' })
    }
    // The uniqueness rule the multi-agent model rests on: a user may hold
    // many agents, just not two non-revoked ones sharing a delegate address
    // (#1694, `017_agent_connection_setups.ts:54`).
    const collision = await findLiveAgentByDelegate(sub, new_delegate_address, request.params.id)
    if (collision) {
      return reply.code(409).send({
        error: 'delegate_address_in_use',
        detail: 'Another live agent already uses that delegate address. Generate a fresh keypair.',
      })
    }

    const existing = await findInFlightRekey(request.params.id)
    if (existing) {
      return reply.code(409).send({
        error: 'rekey_already_in_flight',
        rekey_id: existing.id,
        stage: existing.stage,
        detail:
          'A re-key is already in progress for this agent. Finish it or abandon it before ' +
          'starting another — two concurrent re-keys would race to revoke and issue against ' +
          "each other's meter reading.",
      })
    }

    // ── Residual on the OLD delegate EOA ──────────────────────────────────
    const residualToken = sweepUsdcAddress(agent.chain_id)
    let residualAtomic = 0n
    let residualReadFailed = false
    try {
      residualAtomic = await getTokenBalance(
        agent.chain_id,
        agent.delegate_address,
        residualToken as string,
      )
    } catch (err) {
      residualReadFailed = true
      request.log.warn({ err, agentId: request.params.id }, 're-key residual balance read failed')
    }
    if (residualReadFailed) {
      // Fail closed. Proceeding would retire the only key that can sweep,
      // without knowing whether there is anything to sweep — and the mistake
      // is unrecoverable, which is exactly the case for refusing rather than
      // guessing.
      return reply.code(503).send({
        error: 'residual_read_failed',
        detail:
          'Could not read the balance on the current delegate address, and a re-key retires the ' +
          'only key that could sweep it. Retry once the network read succeeds.',
      })
    }

    const disposition = residual_disposition as ResidualDisposition | undefined
    if (residualAtomic > 0n) {
      if (!disposition || !RESIDUAL_DISPOSITIONS.includes(disposition)) {
        return reply.code(409).send({
          error: 'residual_funds_on_old_delegate',
          residual_atomic: residualAtomic.toString(),
          residual_token_address: residualToken,
          detail:
            `The current delegate address still holds ${residualAtomic.toString()} atomic units. ` +
            'Sweeping requires a signature from the OLD delegate key, so after this re-key ' +
            'completes the residual is unrecoverable — permanently, by the user and by Haven. ' +
            'Sweep it first (POST /machine-payments/sweep) and retry with ' +
            'residual_disposition="swept"; or, if the old key is lost, retry with ' +
            'residual_disposition="acknowledged_unrecoverable" to proceed and write off the ' +
            'balance.',
          recoverable_only_before_rekey: true,
        })
      }
    }

    const rekey = await openRekey({
      agentId: request.params.id,
      userId: sub,
      oldDelegateAddress: agent.delegate_address,
      newDelegateAddress: new_delegate_address,
      residualAtomic: residualAtomic.toString(),
      residualTokenAddress: residualAtomic > 0n ? (residualToken as string) : null,
      residualDisposition: residualAtomic > 0n ? (disposition as string) : 'none',
    })

    const targets = await listNonRevokedDelegationsForAgent(request.params.id)
    return reply.code(201).send({
      rekey_id: rekey.id,
      stage: rekey.stage as RekeyStage,
      old_delegate_address: rekey.old_delegate_address,
      new_delegate_address: rekey.new_delegate_address,
      // Reported whether or not it is recoverable — #1698's acceptance
      // criterion is that nothing about a residual fails quietly.
      residual: {
        atomic: rekey.residual_atomic,
        token_address: rekey.residual_token_address,
        disposition: rekey.residual_disposition,
        recoverable_after_rekey: false,
        note:
          disposition === 'acknowledged_unrecoverable'
            ? 'Acknowledged as unrecoverable: sweeping needs the old key, which is gone. This ' +
              'balance will remain on the retired delegate address permanently.'
            : undefined,
      },
      delegations_to_revoke: targets.map((t) => t.delegation_hash),
      next_step: `POST /agents/${request.params.id}/rekey/${rekey.id}/revoke`,
      ordering_note:
        'The revoke happens FIRST. If it lands and the issue does not, the agent has no ' +
        'authority — recoverable, and the correct posture when a key is lost. The reverse ' +
        'ordering would leave two live keys.',
    })
  })

  // ── POST /:id/rekey/:rekeyId/revoke — prepare the owner-signed revoke ──
  app.post<{ Params: { id: string; rekeyId: string } }>(
    '/:id/rekey/:rekeyId/revoke',
    async (request, reply) => {
      const loaded = await loadStep(request, reply)
      if (!loaded) return reply
      const { agent, rekey } = loaded
      const { sub } = request.user as { sub: string }
      try {
        assertStageAllows('submitRevoke', rekey.stage)
      } catch (err) {
        if (err instanceof RekeyOrderingError) return orderingReply(reply, err)
        throw err
      }

      const targets = await listNonRevokedDelegationsForAgent(request.params.id)
      if (targets.length === 0) {
        // Nothing to revoke on-chain — an agent connected but never granted a
        // budget, or one whose grants were revoked earlier. A normal state,
        // and the exact population re-key most needs to serve: a lost key
        // with little history.
        //
        // This branch must walk BOTH stages, not just `revoked`. Found by the
        // #1698 review: stopping at `revoked` wedged the re-key permanently,
        // because the only code that advances `revoked → metered` lives in
        // the submit handler this branch never reaches, and the migration's
        // `agent_rekeys_metered_stage_check` then forbids every later stage
        // for a row with no snapshot. The owner's only exit was to abandon —
        // i.e. re-key was impossible for exactly the agent that needed it.
        //
        // The empty snapshot is the honest measurement, not a placeholder:
        // there were no delegations, so there is nothing to carry, and the
        // issue step will correctly build nothing.
        const advanced = await markRevoked(rekey.id, request.params.id, 'none')
        if (!advanced) return reply.code(409).send({ error: 'rekey_out_of_order' })
        const metered = await markMetered(rekey.id, request.params.id, [])
        if (!metered) return reply.code(409).send({ error: 'rekey_out_of_order' })
        return {
          revoked: true,
          tx_hash: null,
          delegation_hashes: [],
          stage: metered.stage,
          carry: [],
          agent_has_no_authority: true,
          next_step: `POST /agents/${request.params.id}/rekey/${rekey.id}/issue`,
        }
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
        const calls = targets.map((t) => buildRevocation(JSON.parse(t.delegation_json), agent.chain_id))
        const prepared = await treasury.prepareCalls(calls)
        const user_operation = JSON.parse(
          JSON.stringify(prepared.userOperation, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
        )
        return {
          signing_payload: prepared.signingTypedData,
          user_op_hash: prepared.userOpHash,
          user_operation,
          treasury_address: prepared.treasuryAddress,
          delegation_hashes: targets.map((t) => t.delegation_hash),
          instructions: `Sign, then POST /agents/${request.params.id}/rekey/${rekey.id}/revoke/submit`,
        }
      } catch (err) {
        return reply
          .code(502)
          .send({ error: 'Could not prepare the revocation', details: safeDetails(err) })
      }
    },
  )

  // ── POST /:id/rekey/:rekeyId/revoke/submit — land it, THEN read the meter
  //
  // Steps 1 and 2 of #1698 are in ONE handler, in this order, deliberately.
  // The meter is read AFTER the revoke lands (amended by review on #1694):
  // reading before leaves a window in which a payment lands and the carried
  // remainder over-counts it by that amount; after the revoke the on-chain
  // state cannot move and the ordering costs nothing.
  //
  // The enforcer's spent-amount storage survives the revoke, and that is
  // asserted rather than assumed — see the characterization tests: the revoke
  // encodes `disableDelegation` against the DelegationManager while the meter
  // reads the ERC20PeriodTransferEnforcer, keyed on the delegation alone.
  // Two different contracts; the read consults nothing the revoke writes.
  app.post<{
    Params: { id: string; rekeyId: string }
    Body: { signature?: string; user_operation?: unknown; delegation_hashes?: string[] }
  }>('/:id/rekey/:rekeyId/revoke/submit', async (request, reply) => {
    const loaded = await loadStep(request, reply)
    if (!loaded) return reply
    const { agent, rekey } = loaded
    const { sub } = request.user as { sub: string }
    try {
      assertStageAllows('submitRevoke', rekey.stage)
    } catch (err) {
      if (err instanceof RekeyOrderingError) return orderingReply(reply, err)
      throw err
    }

    const { signature, user_operation, delegation_hashes } = request.body ?? {}
    if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return reply.code(400).send({ error: 'signature is required' })
    }
    if (!user_operation || typeof user_operation !== 'object') {
      return reply.code(400).send({ error: 'user_operation (from the prepare step) is required' })
    }
    if (!Array.isArray(delegation_hashes) || delegation_hashes.length === 0) {
      return reply.code(400).send({ error: 'delegation_hashes (from the prepare step) is required' })
    }

    // Capture the terms BEFORE the revoke flips them — the terms are DB rows
    // and do not change on-chain, but the read must be scoped to what is
    // about to be revoked. The METER, which does move, is read afterwards.
    const toRevoke = await listNonRevokedDelegationsForAgent(request.params.id)
    const termsByHash = new Map(toRevoke.map((t) => [t.delegation_hash, t]))

    const owner = await loadHybridOwnerConfig(sub, agent.treasury_address as string, agent.chain_id)
    if (!owner) return reply.code(409).send({ error: 'Account signer configuration unknown' })

    let txHash: string
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
        {
          userOperation: revived,
          userOpHash: '0x' as Hex,
          signingTypedData: null,
          treasuryAddress: treasury.treasuryAddress,
        },
        signature as Hex,
      )
      txHash = result.txHash
    } catch (err) {
      // Fail-closed and fail-BEFORE: nothing was written, the re-key stays in
      // `preflight`, and the old key is still live. Retrying is safe.
      return reply.code(502).send({ error: 'Revocation failed', details: safeDetails(err) })
    }

    await revokeDelegationsByHashes(request.params.id, delegation_hashes)
    const advanced = await markRevoked(rekey.id, request.params.id, txHash)
    if (!advanced) {
      // Someone else advanced this re-key between our stage check and here.
      // The revoke is on-chain either way; refuse rather than double-meter.
      return reply.code(409).send({ error: 'rekey_out_of_order', stage: rekey.stage })
    }

    // ── Step 2: the meter, now frozen ────────────────────────────────────
    const snapshot: CarrySnapshotEntry[] = []
    for (const hash of delegation_hashes) {
      const row = termsByHash.get(hash)
      if (!row) continue
      const terms = await findDelegationTerms(request.params.id, hash)
      if (!terms) continue
      const meter = await readRemainingBudget(
        agent.chain_id,
        row.delegation_json,
        terms.budget_atomic,
      )
      snapshot.push({
        delegation_hash: hash,
        token_address: terms.token_address,
        recipient_address: terms.recipient_address,
        budget_atomic: terms.budget_atomic,
        period_seconds: terms.period_seconds,
        start_date: Number(terms.start_date),
        expires_at: Number(terms.expires_at),
        remaining_atomic: meter.remainingAtomic,
        from_chain: meter.fromChain,
      })
    }

    const metered = await markMetered(rekey.id, request.params.id, snapshot)
    if (!metered) return reply.code(409).send({ error: 'rekey_out_of_order' })

    return {
      revoked: true,
      tx_hash: txHash,
      delegation_hashes,
      stage: metered.stage,
      // Surfaced so a client can see the carry it is about to be given, and
      // so a fallback reading is visible rather than silently refused later.
      carry: snapshot.map((s) => ({
        delegation_hash: s.delegation_hash,
        remaining_atomic: s.remaining_atomic,
        from_chain: s.from_chain,
      })),
      agent_has_no_authority: true,
      next_step: `POST /agents/${request.params.id}/rekey/${rekey.id}/issue`,
    }
  })

  // ── POST /:id/rekey/:rekeyId/issue — build the carried delegations ─────
  app.post<{ Params: { id: string; rekeyId: string } }>(
    '/:id/rekey/:rekeyId/issue',
    async (request, reply) => {
      const loaded = await loadStep(request, reply)
      if (!loaded) return reply
      const { agent, rekey } = loaded
      // THE ordering guard. `metered` is only reachable through `revoked`, so
      // requiring it here forbids issue-before-revoke structurally rather
      // than by convention.
      try {
        assertStageAllows('issue', rekey.stage)
      } catch (err) {
        if (err instanceof RekeyOrderingError) return orderingReply(reply, err)
        throw err
      }
      const snapshot = rekey.carry_snapshot ?? []

      let delegateAccountAddress: Address
      try {
        delegateAccountAddress = await computeHybridAccountAddress(agent.chain_id, {
          ownerAddress: rekey.new_delegate_address as Address,
        })
      } catch (err) {
        return reply
          .code(502)
          .send({ error: 'Could not derive the new delegate account', details: safeDetails(err) })
      }

      const nowSec = Math.floor(Date.now() / 1000)
      const built: Array<{
        delegation_hash: string
        carry_role: string
        token_address: string
        recipient_address: string | null
        budget_atomic: string
        period_seconds: number
        start_date: number
        expires_at: number
        signing_payload: unknown
      }> = []
      const skipped: Array<{ delegation_hash: string; reason: string }> = []

      for (const entry of snapshot) {
        const old: DelegationTerms = {
          budgetAtomic: BigInt(entry.budget_atomic),
          periodSeconds: entry.period_seconds,
          startDate: entry.start_date,
          expiresAt: entry.expires_at,
        }
        let plan
        try {
          plan = planCarry({
            old,
            meter: {
              remainingAtomic: BigInt(entry.remaining_atomic),
              fromChain: entry.from_chain,
            },
            nowSec,
          })
        } catch (err) {
          if (err instanceof CarryRefusedError) {
            // A refusal here is recoverable and must be loud: the agent has
            // no authority and the owner needs to know why the replacement
            // was not built rather than being told it was.
            return reply.code(409).send({
              error: 'carry_refused',
              code: err.code,
              delegation_hash: entry.delegation_hash,
              detail: err.message,
            })
          }
          throw err
        }

        const pieces: Array<{ role: 'carry' | 'steady' | 'reanchor'; terms: DelegationTerms }> = []
        if (plan.kind === 'expired') {
          skipped.push({
            delegation_hash: entry.delegation_hash,
            reason: 'The replaced delegation had already expired — nothing to carry.',
          })
        } else if (plan.kind === 'dormant') {
          pieces.push({ role: 'reanchor', terms: plan.reissue })
        } else {
          if (plan.carry) pieces.push({ role: 'carry', terms: plan.carry })
          else
            skipped.push({
              delegation_hash: entry.delegation_hash,
              reason:
                'The period was fully spent — no carry grant is issued; authority resumes at the ' +
                'original boundary.',
            })
          if (plan.steady) pieces.push({ role: 'steady', terms: plan.steady })
        }

        for (const piece of pieces) {
          const version = await nextDelegationVersion(
            request.params.id,
            entry.token_address,
            entry.recipient_address,
          )
          const policy: HavenBudgetPolicy = {
            agentId: request.params.id,
            chainId: agent.chain_id,
            treasuryAddress: agent.treasury_address as Address,
            delegateAccountAddress,
            tokenAddress: entry.token_address as Address,
            budgetAtomic: piece.terms.budgetAtomic,
            periodSeconds: piece.terms.periodSeconds,
            startDate: piece.terms.startDate,
            recipient: (entry.recipient_address ?? undefined) as Address | undefined,
            expiresAt: piece.terms.expiresAt,
            version,
          }
          let delegation
          try {
            delegation = buildBudgetDelegation(policy)
          } catch (err) {
            return reply
              .code(502)
              .send({ error: 'Could not build the replacement delegation', details: safeDetails(err) })
          }
          const hash = delegationIdentity(delegation)
          await insertRekeyDelegation({
            agentId: request.params.id,
            chainId: agent.chain_id,
            tokenAddress: entry.token_address,
            recipientAddress: entry.recipient_address,
            delegationHash: hash,
            delegationJson: JSON.stringify(delegation),
            version,
            budgetAtomic: piece.terms.budgetAtomic.toString(),
            periodSeconds: piece.terms.periodSeconds,
            startDate: piece.terms.startDate,
            expiresAt: piece.terms.expiresAt,
            rekeyId: rekey.id,
            carryRole: piece.role,
          })
          built.push({
            delegation_hash: hash,
            carry_role: piece.role,
            token_address: entry.token_address,
            recipient_address: entry.recipient_address,
            budget_atomic: piece.terms.budgetAtomic.toString(),
            period_seconds: piece.terms.periodSeconds,
            start_date: piece.terms.startDate,
            expires_at: piece.terms.expiresAt,
            signing_payload: delegationSigningPayload(delegation, agent.chain_id),
          })
        }
      }

      const issued = await markIssued(rekey.id, request.params.id)
      if (!issued) return reply.code(409).send({ error: 'rekey_out_of_order' })

      return reply.code(201).send({
        stage: issued.stage,
        delegate_account_address: delegateAccountAddress,
        delegations: built,
        skipped,
        carry_note:
          'A "carry" grant is capped at the frozen remainder and EXPIRES at the old period ' +
          'boundary; the paired "steady" grant starts at that same instant with the original ' +
          'budget and cadence. The two never overlap, so no re-key can shorten a period or ' +
          'grant more than the original budget within one.',
        next_step: `POST /agents/${request.params.id}/rekey/${rekey.id}/complete`,
      })
    },
  )

  // ── POST /:id/rekey/:rekeyId/complete — activate + rotate + invalidate ──
  app.post<{
    Params: { id: string; rekeyId: string }
    Body: { signatures?: Array<{ delegation_hash?: string; signature?: string }> }
  }>('/:id/rekey/:rekeyId/complete', async (request, reply) => {
    const loaded = await loadStep(request, reply)
    if (!loaded) return reply
    const { agent, rekey } = loaded
    const { sub } = request.user as { sub: string }
    try {
      assertStageAllows('complete', rekey.stage)
    } catch (err) {
      if (err instanceof RekeyOrderingError) return orderingReply(reply, err)
      throw err
    }

    const signatures = request.body?.signatures
    if (!Array.isArray(signatures)) {
      return reply.code(400).send({ error: 'signatures[] (from the issue step) is required' })
    }
    const pendingRows = await listPendingRekeyDelegations(request.params.id, rekey.id)
    const signatureByHash = new Map(
      signatures
        .filter((s) => typeof s?.delegation_hash === 'string' && typeof s?.signature === 'string')
        .map((s) => [s.delegation_hash as string, s.signature as string]),
    )
    for (const row of pendingRows) {
      const sig = signatureByHash.get(row.delegation_hash)
      // Every built delegation must be signed. A partial completion would
      // rotate the credentials while some of the replacement authority stayed
      // unsigned — the agent would come back with a new key and a budget it
      // silently does not have.
      if (!sig || !/^0x[0-9a-fA-F]{130,}$/.test(sig) || sig.length % 2 !== 0) {
        return reply.code(400).send({
          error: 'missing_signature',
          delegation_hash: row.delegation_hash,
          detail:
            'Every replacement delegation from the issue step must carry an owner signature ' +
            'before credentials rotate.',
        })
      }
    }

    const newKey = `sk_agent_${crypto.randomBytes(24).toString('hex')}`
    const newKeyHash = crypto.createHash('sha256').update(newKey).digest('hex')
    const newPrefix = newKey.slice(0, 12)

    let invalidatedIntents: string[] = []
    let superseded: string[] = []
    try {
      // One transaction, in the repository: the activation, the credential
      // swap and the intent invalidation are only correct together, and the
      // route should not be able to express anything else.
      const result = await completeRekey({
        agentId: request.params.id,
        userId: sub,
        rekeyId: rekey.id,
        oldDelegateAddress: rekey.old_delegate_address,
        newDelegateAddress: rekey.new_delegate_address,
        apiKeyHash: newKeyHash,
        apiKeyPrefix: newPrefix,
        signedDelegations: pendingRows.map((row) => ({
          id: row.id,
          delegationJson: JSON.stringify({
            ...JSON.parse(row.delegation_json),
            signature: signatureByHash.get(row.delegation_hash),
          }),
        })),
      })
      superseded = result.superseded
      invalidatedIntents = result.invalidatedIntents
    } catch (err) {
      // Nothing partial survives: the delegations stay `pending`, the
      // credentials stay as they were, and the re-key stays at `issued`, so
      // the owner can retry the completion with the signatures already held.
      return reply.code(409).send({ error: 'rekey_completion_failed', details: safeDetails(err) })
    }

    return {
      completed: true,
      stage: 'completed' as RekeyStage,
      agent_id: request.params.id,
      new_delegate_address: rekey.new_delegate_address,
      // Returned ONCE, to the authenticated owner, exactly as agent creation
      // does. Never stored in plaintext, never logged.
      api_key: newKey,
      api_key_prefix: newPrefix,
      old_api_key_revoked: true,
      invalidated_intents: invalidatedIntents.length,
      superseded_delegations: superseded.length,
      residual_on_old_delegate: {
        atomic: rekey.residual_atomic,
        recoverable: false,
        note:
          rekey.residual_atomic !== '0'
            ? 'The retired delegate address still holds this balance. Sweeping it needed the old ' +
              'key, which this re-key has replaced — it is not recoverable.'
            : undefined,
      },
    }
  })

  // ── POST /:id/rekey/:rekeyId/abandon ──────────────────────────────────
  app.post<{ Params: { id: string; rekeyId: string }; Body: { reason?: string } }>(
    '/:id/rekey/:rekeyId/abandon',
    async (request, reply) => {
      const loaded = await loadStep(request, reply)
      if (!loaded) return reply
      const { rekey } = loaded
      const abandoned = await abandonRekey(
        rekey.id,
        request.params.id,
        request.body?.reason ?? 'abandoned by the account owner',
      )
      if (!abandoned) return reply.code(409).send({ error: 'Re-key is not in flight' })
      return {
        abandoned: true,
        stage: abandoned.stage,
        // Said plainly rather than left for the owner to discover: an
        // abandoned re-key past the revoke leaves an agent with no authority.
        agent_has_no_authority: ['revoked', 'metered', 'issued'].includes(rekey.stage),
      }
    },
  )
}
