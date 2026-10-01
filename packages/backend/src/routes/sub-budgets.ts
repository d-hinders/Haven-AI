/**
 * Sub-budgets API (#3330) — agent-facing lifecycle for a sub-budget: a
 * narrower budget an agent (A) re-delegates to another agent (B) in the
 * same account, as an ERC-7710 child of A's OWN budget delegation. Chain
 * `[B child, A child, A budget]`; issuance is owner-governed (decision log
 * 2026-09-27 — the owner issues each sub-budget, and A's delegate key only
 * SIGNS the built children within that envelope, here and nowhere else).
 * #3506: the agent completes the flow itself — it learns its pending rows
 * from `GET /sub-budgets?status=awaiting_signature`, signs each one's
 * sign-context, and submits the signature to `POST /:id/submit` below. The
 * owner's `/agents/:id/sub-budgets/:sub/sign` relay still works but is an
 * optional relay, no longer a required step.
 *
 * Haven never signs (#824 invariant 12): `submit` applies the agent's own
 * signature over typed data this backend built, `close` returns a userOp
 * typed data for a live child's revocation. All the on-chain / chain-SDK
 * work lives in `modules/sub-budgets/` — this file is auth wiring, body
 * validation and response shaping, mirroring `routes/task-budgets.ts`.
 */

import { FastifyInstance } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import { getChain } from '../domain/chains.js'
import { DELEGATION_RAIL_CHAIN_IDS } from '../rails/delegation-contracts.js'
import { selectActiveDelegationByHash } from '../infra/repositories/delegation-budgets.js'
import {
  findForAgent,
  findForDelegatingAgent,
  insertPendingSubBudget,
  listAwaitingSignatureForDelegatingAgent,
  listForAgent,
  markClosed,
  markClosing,
  markOpen,
  type SubBudgetRow,
} from '../infra/repositories/sub-budgets.js'
import {
  buildSubBudgetSignContext,
  checkNarrowingRefusal,
  isSubBudgetChildDisabledOnChain,
  prepareSubBudgetClose,
  recoverSubBudgetChildSigner,
  serializeClosePreparedUserOp,
  submitSubBudgetClose,
} from '../modules/sub-budgets/index.js'
import { redactVendorSecrets } from '../rails/execution-rail.js'
import { SubmittedUserOpFailedError } from '../rails/delegation-rail.js'

// `chain-sdk-not-in-routes`: no viem import here — a hex signature/address is
// carried as a plain string and cast at the module boundary that DOES own
// the chain SDK (`modules/sub-budgets/`), same discipline `routes/task-budgets.ts`.
type Hex = `0x${string}`

const MAX_UINT96 = (1n << 96n) - 1n

function safeDetails(err: unknown): string {
  return redactVendorSecrets(err instanceof Error ? err.message : String(err))
}

/** Wire shape — snake_case, `is_expired` derived (same as task budgets). */
function toWire(row: SubBudgetRow, nowSec: number) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    parent_agent_id: row.parent_agent_id,
    parent_sub_budget_id: row.parent_sub_budget_id,
    chain_id: row.chain_id,
    token_address: row.token_address,
    recipient_address: row.recipient_address,
    parent_delegation_hash: row.parent_delegation_hash,
    delegation_hash: row.delegation_hash,
    label: row.label,
    period_amount_atomic: row.period_amount_atomic,
    status: row.status,
    expires_at: Number(row.expires_at),
    is_expired: Number(row.expires_at) <= nowSec,
    created_at: row.created_at,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    close_tx_hash: row.close_tx_hash,
  }
}

export default async function subBudgetRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  // ── GET /sub-budgets — list (default: open, not expired) ─────────────────
  // `status=awaiting_signature` (#3506) is the DELEGATING side: the rows this
  // agent must still sign (its parent-child row and the grants it issued,
  // `pending` or `closing`) — how agent A discovers its sign targets.
  app.get<{ Querystring: { status?: string } }>('/', async (request, reply) => {
    const agent = request.agent as AgentContext
    const nowSec = Math.floor(Date.now() / 1000)
    if (request.query?.status === 'awaiting_signature') {
      const awaiting = await listAwaitingSignatureForDelegatingAgent(agent.id, nowSec)
      return reply.send({ sub_budgets: awaiting.map((r) => toWire(r, nowSec)) })
    }
    const status = request.query?.status === 'all' ? 'all' : 'open'
    const rows = await listForAgent(agent.id, { status, nowSec })
    return reply.send({ sub_budgets: rows.map((r) => toWire(r, nowSec)) })
  })

  // ── GET /sub-budgets/:id ─────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const agent = request.agent as AgentContext
    const row = await findForAgent(request.params.id, agent.id)
    if (!row) return reply.code(404).send({ error: 'Sub-budget not found' })
    return reply.send({ sub_budget: toWire(row, Math.floor(Date.now() / 1000)) })
  })

  // ── GET /sub-budgets/:id/sign-context — re-servable, byte-free ───────────
  // DELEGATOR-scoped: BOTH children are signed by the delegating agent's
  // delegate key (A signs its parent-child AND B's grant), so only A can
  // fetch typed data to sign. B reads its grant via GET /:id above.
  app.get<{ Params: { id: string } }>(
    '/:id/sign-context',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const row = await findForDelegatingAgent(request.params.id, agent.id)
      if (!row) return reply.code(404).send({ error: 'Sub-budget not found' })
      const context = await buildSubBudgetSignContext(agent, row)
      if (!context) {
        return reply.code(409).send({
          error: `Sub-budget is '${row.status}' — no signature is currently pending`,
          error_code: 'sign_context_unavailable',
        })
      }
      return reply.send({ sub_budget_id: row.id, ...context })
    },
  )

  // ── POST /sub-budgets/:id/submit — the delegating agent's signature ──────
  app.post<{ Params: { id: string }; Body: { signature?: string } }>(
    '/:id/submit',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const { signature } = request.body ?? {}
      if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        return reply.code(400).send({ error: 'A hex signature is required' })
      }
      const row = await findForDelegatingAgent(request.params.id, agent.id)
      if (!row) return reply.code(404).send({ error: 'Sub-budget not found' })

      if (row.status === 'pending') {
        let signer: string
        try {
          signer = await recoverSubBudgetChildSigner(row, agent.chain_id, signature as Hex)
        } catch (err) {
          return reply.code(400).send({ error: 'signature_mismatch', details: safeDetails(err) })
        }
        // BOTH children of a tree are signed by the DELEGATING agent's own
        // delegate key: A signs its parent-child, and A signs B's grant
        // (whose delegator is A's account). B never signs here — the grant
        // is authority A gives, not authority B claims.
        if (signer.toLowerCase() !== agent.delegate_address.toLowerCase()) {
          return reply.code(400).send({
            error: 'Signature does not recover the delegating agent delegate key',
            error_code: 'signature_mismatch',
          })
        }
        const child = JSON.parse(row.delegation_json) as Record<string, unknown>
        const signed = JSON.stringify({ ...child, signature })
        const opened = await markOpen(row.id, agent.id, signed)
        if (!opened) return reply.code(409).send({ error: 'Sub-budget is no longer pending' })
        return reply.send({ sub_budget: toWire(opened, Math.floor(Date.now() / 1000)), status: 'open' })
      }

      if (row.status === 'closing') {
        let result
        try {
          result = await submitSubBudgetClose(agent, row, signature as Hex)
        } catch (err) {
          // #3329 review finding N2(a)'s split: a failure BEFORE the op was
          // sent means nothing changed on-chain (re-prepare); a
          // SubmittedUserOpFailedError MAY have landed — check before
          // re-preparing, or a landed disable loops 502 forever.
          if (err instanceof SubmittedUserOpFailedError) {
            const disabled = await isSubBudgetChildDisabledOnChain(agent.chain_id, row.delegation_hash as Hex)
            if (disabled) {
              const closed = await markClosed(row.id, agent.id, null)
              if (closed) {
                return reply.send({ sub_budget: toWire(closed, Math.floor(Date.now() / 1000)), status: 'closed' })
              }
            }
            return reply.code(502).send({
              error: 'The close operation was submitted but its outcome is not confirmed yet. Call close again later: it reports closed once the chain has finalised the disable (on Base that can take tens of minutes); if it instead returns a new operation to sign, the earlier one did not land — sign and submit that one.',
              error_code: 'close_outcome_unconfirmed',
              details: safeDetails(err),
            })
          }
          return reply.code(409).send({
            error: 'The stored close UserOp is stale — call /sub-budgets/:id/close again for a fresh one, then submit that.',
            error_code: 'close_needs_reprepare',
            details: safeDetails(err),
          })
        }
        const closed = await markClosed(row.id, agent.id, result.txHash)
        if (!closed) return reply.code(409).send({ error: 'Sub-budget is no longer closing' })
        return reply.send({
          sub_budget: toWire(closed, Math.floor(Date.now() / 1000)),
          status: 'closed',
          close_tx_hash: result.txHash,
        })
      }

      return reply.code(409).send({ error: `Sub-budget is '${row.status}' — nothing to submit` })
    },
  )

  // ── POST /sub-budgets/:id/close ──────────────────────────────────────────
  // DELEGATOR-scoped: closing prepares disableDelegation UNDER the
  // delegating agent's account — only A can close any row of its tree.
  app.post<{ Params: { id: string } }>('/:id/close', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const row = await findForDelegatingAgent(request.params.id, agent.id)
    if (!row) return reply.code(404).send({ error: 'Sub-budget not found' })
    if (row.status === 'closed') return reply.code(409).send({ error: 'Sub-budget is already closed' })

    const nowSec = Math.floor(Date.now() / 1000)

    // #3329 review finding N2(b): a PRIOR /submit on this 'closing' row may
    // have landed without confirmation — check before re-preparing, or
    // AlreadyDisabled 502s forever.
    if (row.status === 'closing') {
      const disabled = await isSubBudgetChildDisabledOnChain(agent.chain_id, row.delegation_hash as Hex)
      if (disabled) {
        const closed = await markClosed(row.id, agent.id, null)
        if (closed) return reply.send({ sub_budget: toWire(closed, nowSec), status: 'closed' })
      }
    }

    // #3329 review finding A: a 'closing' row does NOT idempotently re-serve
    // the stored UserOp — /close always re-prepares a FRESH
    // disableDelegation UserOp, idempotent in EFFECT, never in bytes.
    let outcome
    try {
      outcome = await prepareSubBudgetClose(agent, row, nowSec)
    } catch (err) {
      return reply.code(502).send({ error: 'Could not prepare the sub-budget close', details: safeDetails(err) })
    }

    if (outcome.trivial) {
      const closed = await markClosed(row.id, agent.id, null)
      if (!closed) return reply.code(409).send({ error: 'Sub-budget could not be closed' })
      return reply.send({ sub_budget: toWire(closed, nowSec), status: 'closed' })
    }

    const prepared = outcome.prepared!
    const closing = await markClosing(row.id, agent.id, serializeClosePreparedUserOp(prepared))
    if (!closing) return reply.code(409).send({ error: 'Sub-budget is no longer open or closing' })
    return reply.send({
      sub_budget: toWire(closing, nowSec),
      sign_data: {
        signature_scheme: 'eip712_userop',
        typed_data: prepared.signingTypedData,
        user_op_hash: prepared.userOpHash,
      },
      next_action: 'sign_then_submit',
    })
  })
}
