/**
 * Owner-facing sub-budget routes (#3330) — mounted at the `/agents` prefix
 * beside `agent-delegations.ts` and `agent-task-budgets.ts`, same
 * owner-session auth and the same `loadOwnedDelegationAgent` scoping
 * (agent id AND owner).
 *
 * The flow (owner decision, decision log 2026-09-27: issuance is
 * owner-governed, the delegating agent's delegate key only signs):
 *
 *   1. POST   /agents/:id/sub-budgets          — the OWNER issues: narrowing
 *      is checked against the parent budget delegation (amount, expiry,
 *      recipient — a child wider than the parent is refused BEFORE signing,
 *      400 `sub_budget_wider_than_parent`), both children are built and
 *      stored `pending` (two rows: A's parent-child + B's grant).
 *   2. The delegating agent (A) signs each pending row and each row flips
 *      `pending`→`open` as its signature lands (#3506: the agent completes
 *      this itself — `GET /sub-budgets?status=awaiting_signature` lists its
 *      rows, `GET /sub-budgets/:id/sign-context` serves the typed data, and
 *      `POST /sub-budgets/:id/submit` applies the signature). B's grant
 *      stays unusable until BOTH rows are open.
 *      POST   /agents/:id/sub-budgets/:id/sign — an OPTIONAL owner relay of
 *      that same signature, kept for callers that route it through the
 *      owner session; it applies exactly what the agent's own submit would.
 *   3. GET    /agents/:id/sub-budgets          — flat list (both rows).
 *   4. GET    /agents/:id/sub-budgets/tree     — the parent→child tree.
 *   5. DELETE /agents/:id/sub-budgets/:id      — owner revoke: mirrors
 *      `agent-delegations.ts`'s revoke (authority-reducing, the closing
 *      agent prepares disableDelegation of its OWN child).
 */

import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  findAgentForUserAllStatuses,
  loadOwnedDelegationAgent,
} from '../infra/repositories/agents.js'
import { getChain } from '../domain/chains.js'
import {
  selectActiveDelegationByHash,
  selectDelegationForPayment,
  type DelegationForPaymentRow,
} from '../infra/repositories/delegation-budgets.js'
import {
  findForDelegatingAgent,
  insertPendingSubBudget,
  listForOwner,
  listTreeForOwner,
  markClosed,
  markClosing,
  sumOpenReservedForParent,
  type SubBudgetRow,
} from '../infra/repositories/sub-budgets.js'
import type { Delegation } from '../rails/delegation-policy.js'
import {
  buildSubBudgetChildren,
  checkNarrowingRefusal,
  prepareSubBudgetClose,
  recoverSubBudgetChildSigner,
  serializeClosePreparedUserOp,
} from '../modules/sub-budgets/index.js'

/**
 * #3553: the issuing agent may not carve new sub-budget authority while it is
 * revoked or archived — including the half-revoked state (credential revoked,
 * budget delegation still live on-chain). `paused` is deliberately allowed, as
 * on the budget-delegation routes. Deliberately NOT the delegation routes'
 * REVOKED_AGENT_REFUSAL: that text says the agent "cannot receive", and here
 * the agent is the one giving. The gate lives in the two issuance-side routes,
 * never in `loadOwnedDelegationAgent` — DELETE and the reads must still reach a
 * revoked agent.
 */
export const SUB_BUDGET_ISSUER_RETIRED_CODE = 'issuer_retired'
export const SUB_BUDGET_ISSUER_RETIRED_REFUSAL =
  'This agent is revoked or archived and cannot issue new sub-budgets'
/** #3553: only an `active` or `paused`, un-archived agent may receive a sub-budget. */
export const SUB_BUDGET_SUB_AGENT_RETIRED_CODE = 'sub_agent_retired'
export const SUB_BUDGET_SUB_AGENT_RETIRED_REFUSAL =
  'A revoked, archived or pending-approval agent cannot receive a sub-budget'

function isRetired(a: { status: string; archived_at: Date | string | null }): boolean {
  return a.status === 'revoked' || a.archived_at != null
}

function safeDetails(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

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

export default async function agentSubBudgetsOwnerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // ── POST /agents/:id/sub-budgets — the owner issues a sub-budget ─────────
  app.post<{
    Params: { id: string }
    Body: {
      sub_agent_id?: string
      token_address?: string
      period_amount_atomic?: string
      expires_at?: number
      recipient_address?: string | null
      label?: string
    }
  }>('/:id/sub-budgets', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent || !agent.delegate_address) return reply.code(404).send({ error: 'Agent not found' })
    // #3553: lifecycle gate BEFORE body validation, as the delegation build route does.
    if (isRetired(agent)) {
      return reply.code(409).send({
        error: SUB_BUDGET_ISSUER_RETIRED_REFUSAL,
        error_code: SUB_BUDGET_ISSUER_RETIRED_CODE,
      })
    }

    const body = request.body ?? {}
    const { sub_agent_id, period_amount_atomic, expires_at, recipient_address, label } = body
    let { token_address } = body
    if (!token_address) {
      const usdc = Object.values(getChain(agent.chain_id).tokens).find((t) => t.symbol === 'USDC')
      token_address = usdc?.address ?? undefined
    }
    if (!token_address || !isValidAddress(token_address)) {
      return reply.code(400).send({ error: 'Valid token_address is required' })
    }
    const token = token_address
    if (!sub_agent_id) return reply.code(400).send({ error: 'sub_agent_id is required' })
    if (!period_amount_atomic || !/^\d+$/.test(period_amount_atomic) || BigInt(period_amount_atomic) <= 0n) {
      return reply.code(400).send({ error: 'period_amount_atomic must be a positive atomic amount' })
    }
    if (
      !expires_at ||
      !Number.isInteger(expires_at) ||
      expires_at <= Math.floor(Date.now() / 1000)
    ) {
      return reply.code(400).send({ error: 'expires_at must be a unix timestamp in the future' })
    }
    if (recipient_address != null && !isValidAddress(recipient_address)) {
      return reply.code(400).send({ error: 'recipient_address must be a valid address when set' })
    }
    if (sub_agent_id === agent.agent_id) {
      return reply.code(400).send({
        error: 'A task budget (#3329) is the tool for narrowing an agent budget to itself — sub_agent_id must name a different agent',
      })
    }
    // Same account, owner-scoped: both agents must belong to this owner.
    const subAgent = await findAgentForUserAllStatuses(sub_agent_id, sub)
    if (!subAgent) {
      return reply.code(404).send({ error: 'Sub-agent not found in this account' })
    }
    if (isRetired(subAgent) || (subAgent.status !== 'active' && subAgent.status !== 'paused')) {
      return reply.code(409).send({
        error: SUB_BUDGET_SUB_AGENT_RETIRED_REFUSAL,
        error_code: SUB_BUDGET_SUB_AGENT_RETIRED_CODE,
      })
    }
    if (subAgent.delegate_address == null) {
      return reply.code(409).send({
        error: 'Sub-agent has no delegate key on the delegation rail',
        error_code: 'not_delegation_rail',
      })
    }

    // The parent: the delegating agent's ACTIVE budget delegation for this
    // token — selected by (token, recipient|open), the same selection a
    // payment would make. Refusing here is cheaper than building a child no
    // redemption could ever walk.
    let parentDelegation: DelegationForPaymentRow | null
    try {
      parentDelegation = await selectDelegationForPayment(
        agent.agent_id,
        token_address,
        (recipient_address ?? agent.treasury_address ?? '').toLowerCase(),
      )
    } catch (err) {
      return reply.code(502).send({ error: 'Could not read the parent budget delegation', details: String(err) })
    }
    if (!parentDelegation) {
      return reply.code(403).send({
        error: 'No active budget delegation authorizes this token/recipient',
        error_code: 'no_delegation_for_target',
      })
    }

    const budgetDelegation = JSON.parse(parentDelegation.delegation_json) as Delegation
    const nowSec = Math.floor(Date.now() / 1000)
    // #3330 gate: refuse a child wider than the parent in amount, expiry or
    // recipient BEFORE signing — the check decodes the parent delegation
    // itself (the instrument that will enforce), not a request field.
    const narrowingCheck = checkNarrowingRefusal({
      budgetDelegation,
      parentBudgetToken: token_address,
      parentRecipientAddress: parentDelegation.recipient_address,
      requested: {
        periodAmountAtomic: BigInt(period_amount_atomic),
        recipient: (recipient_address ?? undefined) as `0x${string}` | undefined,
        expiresAt: expires_at,
      },
    })
    if (!narrowingCheck.ok) {
      const reason = narrowingCheck.reason
      return reply.code(400).send({
        error:
          reason === 'amount'
            ? 'The requested period amount exceeds the parent budget delegation period amount'
            : reason === 'expiry'
              ? 'The requested expiry outlives the parent budget delegation expiry'
              : reason === 'recipient'
                ? 'The requested recipient is not the recipient the parent budget delegation pins'
                : 'The parent budget delegation is not a single-token period delegation (multi-token parents are out of scope for v1)',
        error_code: reason === 'parent_not_period_scoped' ? 'parent_not_period_scoped' : 'sub_budget_wider_than_parent',
        reason,
      })
    }

    // Owner-decision pre-sign refusal (#3329 review finding D's shape): open
    // grants under this parent-child may not over-commit the narrowed slice
    // of A's budget (A's own spend plus every sub-agent's slice must fit).
    const reserved = await sumOpenReservedForParent(agent.agent_id, parentDelegation.delegation_hash, nowSec)
    if (BigInt(period_amount_atomic) + reserved > BigInt(parentDelegation.budget_atomic)) {
      return reply.code(409).send({
        error: 'The requested period amount plus the period amounts of open sub-budget grants under this parent exceeds the parent budget',
        error_code: 'sub_budget_exceeds_remaining',
      })
    }

    // #3329 review finding B's rule: mint the id BEFORE building — the salt
    // derives from the row's real identity.
    const subBudgetId = crypto.randomUUID()
    let built
    try {
      built = await buildSubBudgetChildren({
        chainId: agent.chain_id,
        subBudgetId,
        delegatingOwnerAddress: agent.delegate_address as `0x${string}`,
        subAgentOwnerAddress: subAgent.delegate_address as `0x${string}`,
        budgetDelegation,
        narrowing: {
          token: token_address as `0x${string}`,
          periodAmountAtomic: BigInt(period_amount_atomic),
          // A slice of the SAME period window the parent's enforcer meters.
          periodDurationSeconds: narrowingCheck.parentScope.periodDuration,
          startDate: narrowingCheck.parentScope.startDate,
          recipient: (recipient_address ?? undefined) as `0x${string}` | undefined,
          expiresAt: expires_at,
        },
      })
    } catch (err) {
      return reply.code(502).send({ error: 'Could not build the sub-budget children', details: safeDetails(err) })
    }

    // Two rows, one tree. The parent-child row first (the grant row's
    // parent_sub_budget_id names it); its own parent is A's BUDGET
    // delegation, exactly what a task budget's parent_delegation_hash names.
    const parentChildRow = await insertPendingSubBudget({
      id: crypto.randomUUID(),
      agentId: agent.agent_id,
      parentAgentId: agent.agent_id,
      parentSubBudgetId: null,
      chainId: agent.chain_id,
      tokenAddress: token_address,
      recipientAddress: recipient_address ?? null,
      parentDelegationHash: parentDelegation.delegation_hash,
      delegationHash: built.parentChild.childHash,
      delegationJson: JSON.stringify(built.parentChild.child),
      label: label ?? null,
      periodAmountAtomic: period_amount_atomic,
      expiresAt: built.parentChild.expiresAt,
    })
    const grantRow = await insertPendingSubBudget({
      id: subBudgetId,
      agentId: subAgent.id,
      parentAgentId: agent.agent_id,
      parentSubBudgetId: parentChildRow.id,
      chainId: agent.chain_id,
      tokenAddress: token_address,
      recipientAddress: recipient_address ?? null,
      parentDelegationHash: built.parentChild.childHash,
      delegationHash: built.grant.childHash,
      delegationJson: JSON.stringify(built.grant.child),
      label: label ?? null,
      periodAmountAtomic: period_amount_atomic,
      expiresAt: built.grant.expiresAt,
    })

    return reply.code(201).send({
      sub_budget: toWire(grantRow, nowSec),
      parent_child_sub_budget: toWire(parentChildRow, nowSec),
      // Both children are signed by A's delegate key (agent-side); the
      // route that serves each typed data to the agent is the agent's own
      // sign-context endpoint, and the agent submits each signature itself
      // (POST /sub-budgets/:id/submit, #3506 — haven_sign then haven_submit
      // with sub_budget_id). The owner may OPTIONALLY relay a signature via
      // POST /agents/:id/sub-budgets/:id/sign (row id, one call per row);
      // that route is unchanged and no longer required.
      next_action: 'agent_signs_then_submits',
      sign_targets: [
        { sub_budget_id: parentChildRow.id, who: 'delegating_agent', what: 'parent-child' },
        { sub_budget_id: grantRow.id, who: 'delegating_agent', what: 'grant' },
      ],
    })
  })

  // ── POST /agents/:id/sub-budgets/:id/sign — OPTIONAL owner relay of A's signature ─
  // (#3506: the agent submits its own signature via POST /sub-budgets/:id/submit;
  // this relay stays working for callers that go through the owner session.)
  app.post<{
    Params: { id: string; sub: string }
    Body: { signature?: string }
  }>('/:id/sub-budgets/:sub/sign', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent || !agent.delegate_address) return reply.code(404).send({ error: 'Agent not found' })
    // #3553: a pending row seeded while the agent was live must not open after
    // it is revoked or archived (a pre-revocation signature is a live path).
    if (isRetired(agent)) {
      return reply.code(409).send({
        error: SUB_BUDGET_ISSUER_RETIRED_REFUSAL,
        error_code: SUB_BUDGET_ISSUER_RETIRED_CODE,
      })
    }
    const { signature } = request.body ?? {}
    if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return reply.code(400).send({ error: 'A hex signature is required' })
    }
    const row = await findForDelegatingAgent(request.params.sub, agent.agent_id)
    if (!row) return reply.code(404).send({ error: 'Sub-budget not found' })
    if (row.status !== 'pending') {
      return reply.code(409).send({ error: `Sub-budget is '${row.status}' — nothing to sign`, error_code: 'not_pending' })
    }

    // The signature is A's delegate key over the child typed data the
    // agent's own sign-context endpoint served. Verify it HERE (the owner
    // route is the issuance boundary), reusing the module's recovery.
    const { recoverSubBudgetChildSigner } = await import('../modules/sub-budgets/index.js')
    let signer: string
    try {
      signer = await recoverSubBudgetChildSigner(row, agent.chain_id, signature as `0x${string}`)
    } catch (err) {
      return reply.code(400).send({ error: 'signature_mismatch', details: String(err) })
    }
    if (signer.toLowerCase() !== agent.delegate_address.toLowerCase()) {
      return reply.code(400).send({
        error: 'Signature does not recover the delegating agent delegate key',
        error_code: 'signature_mismatch',
      })
    }
    const child = JSON.parse(row.delegation_json) as Record<string, unknown>
    const { markOpen } = await import('../infra/repositories/sub-budgets.js')
    const opened = await markOpen(row.id, agent.agent_id, JSON.stringify({ ...child, signature }))
    if (!opened) return reply.code(409).send({ error: 'Sub-budget is no longer pending' })
    const nowSec = Math.floor(Date.now() / 1000)
    return reply.send({ sub_budget: toWire(opened, nowSec), status: 'open' })
  })

  // ── GET /agents/:id/sub-budgets — flat list ──────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/sub-budgets', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    const rows = await listForOwner(request.params.id, sub)
    const nowSec = Math.floor(Date.now() / 1000)
    return reply.send({ sub_budgets: rows.map((r) => toWire(r, nowSec)) })
  })

  // ── GET /agents/:id/sub-budgets/tree — the parent→child tree ─────────────
  app.get<{ Params: { id: string } }>('/:id/sub-budgets/tree', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    const rows = await listTreeForOwner(request.params.id, sub)
    const nowSec = Math.floor(Date.now() / 1000)
    // Shape the flat rows into parent→child: A's parent-child rows on top,
    // each grant nested under the parent-child row its
    // `parent_sub_budget_id` names.
    const parentChildRows = rows.filter((r) => r.parent_sub_budget_id === null)
    const grants = rows.filter((r) => r.parent_sub_budget_id !== null)
    return reply.send({
      agent_id: agent.agent_id,
      trees: parentChildRows.map((parent) => ({
        parent_child_sub_budget: toWire(parent, nowSec),
        grants: grants.filter((g) => g.parent_sub_budget_id === parent.id).map((g) => toWire(g, nowSec)),
      })),
      unattached: grants
        .filter((g) => !parentChildRows.some((p) => p.id === g.parent_sub_budget_id))
        .map((g) => toWire(g, nowSec)),
    })
  })

  // ── DELETE /agents/:id/sub-budgets/:sub — owner revoke ───────────────────
  app.delete<{ Params: { id: string; sub: string } }>('/:id/sub-budgets/:sub', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent || !agent.delegate_address) return reply.code(404).send({ error: 'Agent not found' })
    const row = await findForDelegatingAgent(request.params.sub, agent.agent_id)
    if (!row) return reply.code(404).send({ error: 'Sub-budget not found' })
    if (row.status === 'closed') {
      const nowSec = Math.floor(Date.now() / 1000)
      return reply.send({ sub_budget: toWire(row, nowSec), status: 'closed' })
    }
    // Authority-reducing only (#3329-2's rule): the delegating agent's own
    // delegate account prepares disableDelegation of THIS row's child. For
    // a parent-child row this is the revoke that strands B's grants; for a
    // grant row it ends B's slice and leaves A intact.
    const { prepareSubBudgetClose, serializeClosePreparedUserOp } = await import('../modules/sub-budgets/index.js')
    const nowSec = Math.floor(Date.now() / 1000)
    try {
      const outcome = await prepareSubBudgetClose(
        { chain_id: agent.chain_id, delegate_address: agent.delegate_address },
        row,
        nowSec,
      )
      if (outcome.trivial) {
        const closed = await markClosed(row.id, agent.agent_id, null)
        return reply.send({ sub_budget: toWire(closed ?? row, nowSec), status: closed ? 'closed' : row.status })
      }
      const { markClosing } = await import('../infra/repositories/sub-budgets.js')
      const closing = await markClosing(row.id, agent.agent_id, serializeClosePreparedUserOp(outcome.prepared!))
      if (!closing) return reply.code(409).send({ error: 'Sub-budget is no longer open' })
      return reply.send({
        sub_budget: toWire(closing, nowSec),
        // #3506: the agent signs the close and submits it itself (haven_sign then
        // haven_submit with sub_budget_id); an owner relay is not required.
        next_action: 'agent_signs_close_then_submits',
      })
    } catch (err) {
      return reply.code(502).send({ error: 'Could not prepare the sub-budget close', details: String(err) })
    }
  })
}
