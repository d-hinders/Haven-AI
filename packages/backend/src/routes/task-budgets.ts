/**
 * Task budgets API (#3329) — agent-facing lifecycle for a task budget: a
 * short-lived, self-delegated CHILD of the agent's own budget delegation,
 * scoped to one task. Chain `[task child, budget]`, delegate = the agent's
 * OWN delegate account (owner decision #3329-1) — never `ANY_BENEFICIARY`.
 *
 * Haven never signs (#824 invariant 12): `build`/`open` return typed data
 * for the agent to sign client-side, `close` returns a userOp typed data for
 * a live child's revocation. All the on-chain / chain-SDK work lives in
 * `modules/task-budgets/` — this file is auth wiring, body validation and
 * response shaping, mirroring `routes/x402.ts` and `routes/agent-delegations.ts`.
 */

import { FastifyInstance } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import { getChain } from '../domain/chains.js'
import { DELEGATION_RAIL_CHAIN_IDS } from '../rails/delegation-contracts.js'
import { selectDelegationForPayment } from '../infra/repositories/delegation-budgets.js'
import {
  findForAgent,
  insertPendingTaskBudget,
  listForAgent,
  markClosed,
  markClosing,
  markOpen,
  type TaskBudgetRow,
} from '../infra/repositories/task-budgets.js'
import {
  MAX_TASK_BUDGET_TTL_SECONDS,
  MIN_TASK_BUDGET_TTL_SECONDS,
  buildTaskBudgetChild,
  buildTaskBudgetSignContext,
  checkRemainderForNewTaskBudget,
  isTaskBudgetChildDisabledOnChain,
  prepareTaskBudgetClose,
  recoverTaskBudgetChildSigner,
  serializeClosePreparedUserOp,
  submitTaskBudgetClose,
} from '../modules/task-budgets/index.js'
import { redactVendorSecrets } from '../rails/execution-rail.js'
import { SubmittedUserOpFailedError } from '../rails/delegation-rail.js'

// `chain-sdk-not-in-routes`: no viem import here — a hex signature/address is
// carried as a plain string and cast at the module boundary that DOES own
// the chain SDK (`modules/task-budgets/`), same discipline `routes/x402.ts`
// and `routes/agent-delegations.ts` already keep.
type Hex = `0x${string}`

const MAX_UINT96 = (1n << 96n) - 1n

function safeDetails(err: unknown): string {
  return redactVendorSecrets(err instanceof Error ? err.message : String(err))
}

/** Wire shape (#3329 §3 TaskBudget object) — snake_case, `is_expired` derived. */
function toWire(row: TaskBudgetRow, nowSec: number) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    chain_id: row.chain_id,
    token_address: row.token_address,
    recipient_address: row.recipient_address,
    parent_delegation_hash: row.parent_delegation_hash,
    delegation_hash: row.delegation_hash,
    label: row.label,
    max_atomic: row.max_atomic,
    status: row.status,
    expires_at: Number(row.expires_at),
    is_expired: Number(row.expires_at) <= nowSec,
    created_at: row.created_at,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    close_tx_hash: row.close_tx_hash,
  }
}

export default async function taskBudgetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  // ── POST /task-budgets — open a task budget, step 1 (nothing signed yet) ──
  app.post<{
    Body: {
      token_address?: string
      max_amount_atomic?: string
      ttl_seconds?: number
      recipient_address?: string | null
      label?: string
    }
  }>('/', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    if (agent.account_type !== 'delegator_hybrid') {
      return reply.code(409).send({ error: 'Agent account is not on the delegation rail', error_code: 'not_delegation_rail' })
    }
    if (!DELEGATION_RAIL_CHAIN_IDS.has(agent.chain_id)) {
      return reply.code(409).send({
        error: `Delegation rail not enabled on chain ${agent.chain_id}`,
        error_code: 'not_delegation_rail',
      })
    }

    const { max_amount_atomic, ttl_seconds, recipient_address, label } = request.body ?? {}
    let { token_address } = request.body ?? {}
    if (!token_address) {
      const usdc = Object.values(getChain(agent.chain_id).tokens).find((t) => t.symbol === 'USDC')
      token_address = usdc?.address ?? undefined
    }
    if (!token_address || !isValidAddress(token_address)) {
      return reply.code(400).send({ error: 'Valid token_address is required' })
    }
    if (recipient_address != null && !isValidAddress(recipient_address)) {
      return reply.code(400).send({ error: 'recipient_address must be a valid address when set' })
    }
    if (
      !max_amount_atomic ||
      !/^\d+$/.test(max_amount_atomic) ||
      BigInt(max_amount_atomic) <= 0n ||
      BigInt(max_amount_atomic) > MAX_UINT96
    ) {
      return reply.code(400).send({ error: 'max_amount_atomic must be a positive atomic amount' })
    }
    if (
      !ttl_seconds ||
      !Number.isInteger(ttl_seconds) ||
      ttl_seconds < MIN_TASK_BUDGET_TTL_SECONDS ||
      ttl_seconds > MAX_TASK_BUDGET_TTL_SECONDS
    ) {
      return reply.code(400).send({
        error: `ttl_seconds must be an integer between ${MIN_TASK_BUDGET_TTL_SECONDS} and ${MAX_TASK_BUDGET_TTL_SECONDS}`,
      })
    }
    // label's shape (a string of at most 120 characters) is the spec's job
    // (`type: 'string', maxLength: 120`) — this handler only reads it.

    const nowSec = Math.floor(Date.now() / 1000)
    const targetRecipient = recipient_address ?? null
    // The active budget delegation this task budget is carved from — same
    // selection a payment would use for (token, recipient|any).
    const parentDelegation = await selectDelegationForPayment(
      agent.id,
      token_address,
      targetRecipient ?? agent.account_address, // an open budget matches any `to`
    )
    if (!parentDelegation) {
      return reply.code(403).send({
        error: 'No active budget delegation authorizes this token/recipient',
        error_code: 'no_delegation_for_target',
      })
    }

    const requested = BigInt(max_amount_atomic)
    // Owner decision #3329-3: pre-sign refusal when open children + request
    // exceed the on-chain remainder — a convenience, never the real control.
    // #3329 review finding D: the fallback on a failed on-chain read is the
    // parent's GRANTED budget (`budget_atomic`), never the REQUESTED amount
    // — the latter would report a fabricated "remaining" in the 409 body
    // that happens to equal whatever the caller just asked for.
    const remainder = await checkRemainderForNewTaskBudget(
      agent.id,
      agent.chain_id,
      parentDelegation,
      requested,
      parentDelegation.budget_atomic,
      nowSec,
    )
    if (!remainder.ok) {
      return reply.code(409).send({
        error: `This task budget's cap exceeds the parent budget's remaining, unreserved amount ` +
          `(remaining ${remainder.remainingAtomic}, already reserved by open task budgets ${remainder.reservedAtomic}).`,
        error_code: 'task_budget_exceeds_remaining',
        remaining_atomic: remainder.remainingAtomic,
        reserved_atomic: remainder.reservedAtomic,
        requested_atomic: max_amount_atomic,
      })
    }

    // #3329 review finding B: mint the row's REAL id first — the row does
    // not exist yet, but `taskBudgetSalt(id)` must be derived from the id
    // this row is actually inserted with, or `haven-task-budget:<id>` names
    // a row that never exists. `insertPendingTaskBudget` below is given this
    // SAME id explicitly rather than letting the table default supply one.
    const taskBudgetId = crypto.randomUUID()

    let built
    try {
      built = await buildTaskBudgetChild({
        chainId: agent.chain_id,
        taskBudgetId,
        delegateOwnerAddress: agent.delegate_address as `0x${string}`,
        budgetDelegation: JSON.parse(parentDelegation.delegation_json),
        token: token_address as `0x${string}`,
        maxAtomic: requested,
        recipient: (targetRecipient ?? undefined) as `0x${string}` | undefined,
        ttlSeconds: ttl_seconds,
      })
    } catch (err) {
      return reply.code(502).send({ error: 'Could not build the task budget', details: safeDetails(err) })
    }

    const row = await insertPendingTaskBudget({
      id: taskBudgetId,
      agentId: agent.id,
      chainId: agent.chain_id,
      tokenAddress: token_address,
      recipientAddress: targetRecipient,
      parentDelegationHash: parentDelegation.delegation_hash,
      delegationHash: built.childHash,
      delegationJson: JSON.stringify(built.child),
      label: label ?? null,
      maxAtomic: max_amount_atomic,
      expiresAt: built.expiresAt,
    })

    return reply.code(201).send({
      task_budget: toWire(row, nowSec),
      sign_data: { signature_scheme: 'eip712_delegation', typed_data: built.signingPayload },
      next_action: 'sign_then_submit',
      instructions:
        'Sign this EIP-712 typed data with your delegate key, then POST /task-budgets/:id/submit with the signature to open it.',
    })
  })

  // ── GET /task-budgets — list (default: open, not expired) ────────────────
  app.get<{ Querystring: { status?: string } }>('/', async (request, reply) => {
    const agent = request.agent as AgentContext
    const status = request.query?.status === 'all' ? 'all' : 'open'
    const nowSec = Math.floor(Date.now() / 1000)
    const rows = await listForAgent(agent.id, { status, nowSec })
    return reply.send({ task_budgets: rows.map((r) => toWire(r, nowSec)) })
  })

  // ── GET /task-budgets/:id ──────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const agent = request.agent as AgentContext
    const row = await findForAgent(request.params.id, agent.id)
    if (!row) return reply.code(404).send({ error: 'Task budget not found' })
    return reply.send({ task_budget: toWire(row, Math.floor(Date.now() / 1000)) })
  })

  // ── GET /task-budgets/:id/sign-context — re-servable, byte-free ──────────
  app.get<{ Params: { id: string } }>(
    '/:id/sign-context',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const row = await findForAgent(request.params.id, agent.id)
      if (!row) return reply.code(404).send({ error: 'Task budget not found' })
      const context = await buildTaskBudgetSignContext(agent, row)
      if (!context) {
        return reply.code(409).send({
          error: `Task budget is '${row.status}' — no signature is currently pending`,
          error_code: 'sign_context_unavailable',
        })
      }
      return reply.send({ task_budget_id: row.id, ...context })
    },
  )

  // ── POST /task-budgets/:id/submit — the agent's signature ────────────────
  app.post<{ Params: { id: string }; Body: { signature?: string } }>(
    '/:id/submit',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const { signature } = request.body ?? {}
      if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        return reply.code(400).send({ error: 'A hex signature is required' })
      }
      const row = await findForAgent(request.params.id, agent.id)
      if (!row) return reply.code(404).send({ error: 'Task budget not found' })

      if (row.status === 'pending') {
        let signer: string
        try {
          signer = await recoverTaskBudgetChildSigner(row, agent.chain_id, signature as Hex)
        } catch (err) {
          return reply.code(400).send({ error: 'signature_mismatch', details: safeDetails(err) })
        }
        if (signer.toLowerCase() !== agent.delegate_address.toLowerCase()) {
          return reply.code(400).send({ error: 'Signature does not recover the agent delegate key', error_code: 'signature_mismatch' })
        }
        const child = JSON.parse(row.delegation_json) as Record<string, unknown>
        const signed = JSON.stringify({ ...child, signature })
        const opened = await markOpen(row.id, agent.id, signed)
        if (!opened) return reply.code(409).send({ error: 'Task budget is no longer pending' })
        return reply.send({ task_budget: toWire(opened, Math.floor(Date.now() / 1000)), status: 'open' })
      }

      if (row.status === 'closing') {
        let result
        try {
          result = await submitTaskBudgetClose(agent, row, signature as Hex)
        } catch (err) {
          // #3329 review finding N2(a): a failure BEFORE the op was sent
          // (bundler rejected it) means nothing changed on-chain — the
          // stored op is genuinely stale, so re-preparing is the fix.
          // `SubmittedUserOpFailedError` names the OTHER case: the op MAY
          // have landed (receipt wait errored/timed out, or it reverted).
          // Re-preparing there risks looping 502 forever against an
          // already-disabled child (`AlreadyDisabled`) — check first.
          if (err instanceof SubmittedUserOpFailedError) {
            const disabled = await isTaskBudgetChildDisabledOnChain(agent.chain_id, row.delegation_hash as Hex)
            if (disabled) {
              const closed = await markClosed(row.id, agent.id, null)
              if (closed) {
                return reply.send({ task_budget: toWire(closed, Math.floor(Date.now() / 1000)), status: 'closed' })
              }
            }
            return reply.code(502).send({
              error: 'The close operation was submitted but its outcome is not confirmed yet. Call close again later: it reports closed once the chain has finalised the disable (on Base that can take tens of minutes); if it instead returns a new operation to sign, the earlier one did not land — sign and submit that one.',
              error_code: 'close_outcome_unconfirmed',
              details: safeDetails(err),
            })
          }
          return reply.code(409).send({
            error: 'The stored close UserOp is stale — call /task-budgets/:id/close again for a fresh one, then submit that.',
            error_code: 'close_needs_reprepare',
            details: safeDetails(err),
          })
        }
        const closed = await markClosed(row.id, agent.id, result.txHash)
        if (!closed) return reply.code(409).send({ error: 'Task budget is no longer closing' })
        return reply.send({
          task_budget: toWire(closed, Math.floor(Date.now() / 1000)),
          status: 'closed',
          close_tx_hash: result.txHash,
        })
      }

      return reply.code(409).send({ error: `Task budget is '${row.status}' — nothing to submit` })
    },
  )

  // ── POST /task-budgets/:id/close ─────────────────────────────────────────
  app.post<{ Params: { id: string } }>('/:id/close', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const row = await findForAgent(request.params.id, agent.id)
    if (!row) return reply.code(404).send({ error: 'Task budget not found' })
    if (row.status === 'closed') return reply.code(409).send({ error: 'Task budget is already closed' })

    const nowSec = Math.floor(Date.now() / 1000)

    // #3329 review finding N2(b): a PRIOR /submit on this 'closing' row may
    // have sent a UserOp whose outcome we could not confirm (receipt wait
    // errored or timed out) — it can be disabled on-chain ALREADY, in which
    // case a fresh prepare reverts `AlreadyDisabled` and this route would
    // 502 forever. Check first, and answer closed without ever preparing.
    if (row.status === 'closing') {
      const disabled = await isTaskBudgetChildDisabledOnChain(agent.chain_id, row.delegation_hash as Hex)
      if (disabled) {
        const closed = await markClosed(row.id, agent.id, null)
        if (closed) return reply.send({ task_budget: toWire(closed, nowSec), status: 'closed' })
      }
    }

    // #3329 review finding A: a 'closing' row does NOT idempotently re-serve
    // the stored UserOp — that goes stale the moment the delegate account's
    // nonce moves or the sponsorship window lapses, at which point every
    // future /submit 502s forever while the child stays live until expiry.
    // Instead `/close` always re-prepares a FRESH disableDelegation UserOp
    // (below), overwriting `prepared_user_op` — idempotent in EFFECT (the
    // row ends 'closing' with a prepare of the same call, every time), never
    // in bytes.
    let outcome
    try {
      outcome = await prepareTaskBudgetClose(agent, row, nowSec)
    } catch (err) {
      return reply.code(502).send({ error: 'Could not prepare the task budget close', details: safeDetails(err) })
    }

    if (outcome.trivial) {
      const closed = await markClosed(row.id, agent.id, null)
      if (!closed) return reply.code(409).send({ error: 'Task budget could not be closed' })
      return reply.send({ task_budget: toWire(closed, nowSec), status: 'closed' })
    }

    const prepared = outcome.prepared!
    const closing = await markClosing(row.id, agent.id, serializeClosePreparedUserOp(prepared))
    if (!closing) return reply.code(409).send({ error: 'Task budget is no longer open or closing' })
    return reply.send({
      task_budget: toWire(closing, nowSec),
      sign_data: {
        signature_scheme: 'eip712_userop',
        typed_data: prepared.signingTypedData,
        user_op_hash: prepared.userOpHash,
      },
      next_action: 'sign_then_submit',
    })
  })
}
