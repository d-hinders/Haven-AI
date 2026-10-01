/**
 * #3506 — the hosted agent-completes sub-budget flow, owned by
 * tools/state-direct-recovery.ts: `haven_submit`'s `sub_budget_id` branch and
 * the sub-budget sign targets `haven_get_agent` reports.
 *
 * `haven` is stubbed directly (the pattern task-budgets.test.ts uses), so what
 * is pinned here is the handler's own contract: which SDK call it makes, what
 * next step it names (with arguments in the SIGNER's vocabulary), and the
 * exactly-one-id refusal.
 */
import { describe, expect, it, vi } from 'vitest'
import { HavenApiError, type HavenClient } from '@haven_ai/sdk'
import { createToolHandlers, toolSchemas } from '../tools.js'

const SIG = `0x${'ab'.repeat(65)}`
const PARENT_CHILD = '11111111-1111-4111-8111-111111111111'
const GRANT = '22222222-2222-4222-8222-222222222222'

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    subBudgetId: id,
    parentSubBudgetId: id === PARENT_CHILD ? null : PARENT_CHILD,
    purpose: 'open',
    what: id === PARENT_CHILD ? 'parent-child' : 'grant',
    subAgentId: id === PARENT_CHILD ? null : 'agent-b',
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    recipientAddress: null,
    periodAmountAtomic: '500000',
    expiresAt: 4102444800,
    isExpired: false,
    ...over,
  }
}

function stubHaven(opts: {
  submit?: () => Promise<unknown>
  pending?: () => Promise<unknown[]>
  summary?: () => Promise<unknown>
} = {}) {
  const submitSubBudget = vi.fn(
    opts.submit ??
      (async (id: string) => ({
        subBudget: { id, status: 'open', parentSubBudgetId: id === PARENT_CHILD ? null : PARENT_CHILD },
        status: 'open',
      })),
  )
  const listPendingSubBudgetSignatures = vi.fn(opts.pending ?? (async () => []))
  const submitTaskBudget = vi.fn(async () => ({ taskBudget: { id: 'tb_1' }, status: 'open' }))
  const submitSignature = vi.fn(async () => ({ status: 'submitted' }))
  const getAgentSummary = vi.fn(
    opts.summary ?? (async () => ({ id: 'agt_1', name: 'A', pendingSubBudgetSignatures: [] })),
  )
  const haven = {
    submitSubBudget,
    listPendingSubBudgetSignatures,
    submitTaskBudget,
    submitSignature,
    getAgentSummary,
    withRequestContext: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
    clientUpdate: () => undefined,
  } as unknown as HavenClient
  return { haven, submitSubBudget, listPendingSubBudgetSignatures, submitTaskBudget, submitSignature, getAgentSummary }
}

describe('haven_submit schema (#3506)', () => {
  it('declares sub_budget_id beside payment_id / task_budget_id, and accepts exactly the signer\'s handoff arguments', () => {
    expect(Object.keys(toolSchemas.haven_submit)).toEqual(
      expect.arrayContaining(['payment_id', 'task_budget_id', 'sub_budget_id', 'signature']),
    )
  })
})

describe('haven_submit — sub_budget_id branch (#3506)', () => {
  it('relays the signature through submitSubBudget and reports the opened row', async () => {
    const { haven, submitSubBudget, submitSignature, submitTaskBudget } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: GRANT, signature: SIG })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(submitSubBudget).toHaveBeenCalledWith(GRANT, SIG)
    expect(submitSignature).not.toHaveBeenCalled()
    expect(submitTaskBudget).not.toHaveBeenCalled()
    expect(result.data).toMatchObject({ sub_budget: { id: GRANT }, status: 'open' })
  })

  it('opened while the tree\'s OTHER row is pending: names haven_sign { sub_budget_id } for it, on the signer role', async () => {
    const { haven, listPendingSubBudgetSignatures } = stubHaven({
      pending: async () => [row(GRANT)],
    })
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: PARENT_CHILD, signature: SIG })
    if (!result.success) throw new Error('expected success')
    expect(listPendingSubBudgetSignatures).toHaveBeenCalledTimes(1)
    expect(result.data).toMatchObject({
      status: 'open',
      next_action: 'sign_and_submit_payment',
      next_tool: 'mcp__haven-signer__haven_sign',
      next_tool_name: 'haven_sign',
      next_tool_server_role: 'signer',
      next_arguments: { sub_budget_id: GRANT },
    })
  })

  it('opening the grant while the parent-child row is pending points at the parent-child row', async () => {
    const { haven } = stubHaven({ pending: async () => [row(PARENT_CHILD)] })
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: GRANT, signature: SIG })
    if (!result.success) throw new Error('expected success')
    expect(result.data).toMatchObject({ next_tool_name: 'haven_sign', next_arguments: { sub_budget_id: PARENT_CHILD } })
  })

  it('ignores pending rows of OTHER trees and rows owing a close signature', async () => {
    const otherTree = row('33333333-3333-4333-8333-333333333333', { parentSubBudgetId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
    const { haven } = stubHaven({
      pending: async () => [otherTree, row(GRANT, { purpose: 'close' })],
    })
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: PARENT_CHILD, signature: SIG })
    if (!result.success) throw new Error('expected success')
    const data = result.data as Record<string, unknown>
    expect(data.next_tool).toBeUndefined()
    expect(typeof data.next_tool_omitted_reason).toBe('string')
  })

  it('opened and nothing else pending: no next tool, and says why', async () => {
    const { haven } = stubHaven({ pending: async () => [] })
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: GRANT, signature: SIG })
    if (!result.success) throw new Error('expected success')
    const data = result.data as Record<string, unknown>
    expect(data).toMatchObject({ status: 'open', next_action: 'none' })
    expect(data.next_tool).toBeUndefined()
    expect(data.next_tool_omitted_reason).toMatch(/fully open/)
  })

  it('opened but the pending read failed: the submit still succeeds and the next step is haven_get_agent', async () => {
    const { haven } = stubHaven({
      pending: async () => {
        throw new Error('network down')
      },
    })
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: GRANT, signature: SIG })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.data).toMatchObject({
      status: 'open',
      next_tool: 'mcp__haven__haven_get_agent',
      next_tool_name: 'haven_get_agent',
      next_tool_server_role: 'hosted',
      next_arguments: {},
    })
  })

  it('a submitted close reports closed, carries close_tx_hash, and names no next tool', async () => {
    const { haven, listPendingSubBudgetSignatures } = stubHaven({
      submit: async () => ({ subBudget: { id: GRANT, status: 'closed' }, status: 'closed', closeTxHash: '0xabc' }),
    })
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: GRANT, signature: SIG })
    if (!result.success) throw new Error('expected success')
    const data = result.data as Record<string, unknown>
    expect(data).toMatchObject({ status: 'closed', close_tx_hash: '0xabc', next_action: 'none' })
    expect(data.next_tool).toBeUndefined()
    expect(data.next_tool_omitted_reason).toMatch(/closed/)
    expect(listPendingSubBudgetSignatures).not.toHaveBeenCalled()
  })

  it('refuses with ZERO ids, naming all three, before anything is contacted', async () => {
    const { haven, submitSubBudget, submitTaskBudget, submitSignature } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({ signature: SIG })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(JSON.stringify(result)).toMatch(/payment_id, task_budget_id or sub_budget_id/)
    expect(submitSubBudget).not.toHaveBeenCalled()
    expect(submitTaskBudget).not.toHaveBeenCalled()
    expect(submitSignature).not.toHaveBeenCalled()
  })

  it.each([
    ['payment_id + sub_budget_id', { payment_id: 'pay_1', sub_budget_id: GRANT }],
    ['task_budget_id + sub_budget_id', { task_budget_id: 'tb_1', sub_budget_id: GRANT }],
    ['all three', { payment_id: 'pay_1', task_budget_id: 'tb_1', sub_budget_id: GRANT }],
  ])('refuses TWO or more ids (%s)', async (_label, ids) => {
    const { haven, submitSubBudget, submitTaskBudget, submitSignature } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({ ...ids, signature: SIG })
    expect(result.success).toBe(false)
    expect(submitSubBudget).not.toHaveBeenCalled()
    expect(submitTaskBudget).not.toHaveBeenCalled()
    expect(submitSignature).not.toHaveBeenCalled()
  })

  it('still relays a task_budget_id submission unchanged', async () => {
    const { haven, submitTaskBudget, submitSubBudget } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({ task_budget_id: 'tb_1', signature: SIG })
    expect(result.success).toBe(true)
    expect(submitTaskBudget).toHaveBeenCalledWith('tb_1', SIG)
    expect(submitSubBudget).not.toHaveBeenCalled()
  })
})

describe('haven_get_agent — pending sub-budget signatures (#3506)', () => {
  it('names haven_sign { sub_budget_id } on each pending row, on the signer role', async () => {
    const { haven } = stubHaven({
      summary: async () => ({
        id: 'agt_1',
        pendingSubBudgetSignatures: [row(PARENT_CHILD), row(GRANT, { purpose: 'close' })],
      }),
    })
    const result = await createToolHandlers(haven).haven_get_agent({})
    if (!result.success) throw new Error('expected success')
    const rows = (result.data as { pendingSubBudgetSignatures: Array<Record<string, unknown>> }).pendingSubBudgetSignatures
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      subBudgetId: PARENT_CHILD,
      what: 'parent-child',
      next_tool: 'mcp__haven-signer__haven_sign',
      next_tool_name: 'haven_sign',
      next_tool_server_role: 'signer',
      next_arguments: { sub_budget_id: PARENT_CHILD },
    })
    expect(rows[1]).toMatchObject({ subBudgetId: GRANT, purpose: 'close', next_arguments: { sub_budget_id: GRANT } })
  })

  it('leaves an empty list empty and adds no next step to the summary itself', async () => {
    const { haven } = stubHaven()
    const result = await createToolHandlers(haven).haven_get_agent({})
    if (!result.success) throw new Error('expected success')
    const data = result.data as Record<string, unknown>
    expect(data.pendingSubBudgetSignatures).toEqual([])
    expect(data.next_tool).toBeUndefined()
  })
})

describe('haven_submit — a stale or unconfirmed close recovers without a close tool (#3506 review S2)', () => {
  const apiError = (status: number, error_code: string) => new HavenApiError(error_code, status, { error_code })
  const CLOSED_ROW = { id: GRANT, status: 'closed', parentSubBudgetId: PARENT_CHILD }

  function stubClose(opts: { submit: () => Promise<unknown>; close?: () => Promise<unknown> }) {
    const closeSubBudget = vi.fn(opts.close ?? (async () => ({ subBudget: { id: GRANT, status: 'closing' }, signData: { user_op_hash: '0x1' } })))
    const submitSubBudget = vi.fn(opts.submit)
    const haven = {
      submitSubBudget,
      closeSubBudget,
      listPendingSubBudgetSignatures: vi.fn(async () => []),
      withRequestContext: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
      clientUpdate: () => undefined,
    } as unknown as HavenClient
    return { haven, closeSubBudget, submitSubBudget }
  }

  it('close_needs_reprepare: re-prepares via closeSubBudget and names haven_sign { sub_budget_id } for the fresh op', async () => {
    const { haven, closeSubBudget } = stubClose({
      submit: async () => {
        throw apiError(409, 'close_needs_reprepare')
      },
    })
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: GRANT, signature: SIG })
    expect(closeSubBudget).toHaveBeenCalledWith(GRANT)
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result).toMatchObject({
      code: 'CLOSE_NEEDS_REPREPARE',
      statusCode: 409,
      next_tool: 'mcp__haven-signer__haven_sign',
      next_tool_server_role: 'signer',
      next_arguments: { sub_budget_id: GRANT },
    })
  })

  it('close_needs_reprepare where the chain already shows the disable: reports closed, no refusal', async () => {
    const { haven } = stubClose({
      submit: async () => {
        throw apiError(409, 'close_needs_reprepare')
      },
      close: async () => ({ subBudget: CLOSED_ROW, status: 'closed' }),
    })
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: GRANT, signature: SIG })
    if (!result.success) throw new Error('expected success')
    const data = result.data as Record<string, unknown>
    expect(data).toMatchObject({ status: 'closed', next_action: 'none' })
    expect(data.next_tool).toBeUndefined()
    expect(typeof data.next_tool_omitted_reason).toBe('string')
  })

  it('close_outcome_unconfirmed: does NOT re-prepare, and names this same haven_submit to retry later', async () => {
    const { haven, closeSubBudget } = stubClose({
      submit: async () => {
        throw apiError(502, 'close_outcome_unconfirmed')
      },
    })
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: GRANT, signature: SIG })
    expect(closeSubBudget).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result).toMatchObject({
      code: 'CLOSE_OUTCOME_UNCONFIRMED',
      next_tool: 'mcp__haven__haven_submit',
      next_tool_server_role: 'hosted',
      next_arguments: { sub_budget_id: GRANT, signature: SIG },
    })
  })

  it('any other submit error passes through unchanged and never calls closeSubBudget', async () => {
    const { haven, closeSubBudget } = stubClose({
      submit: async () => {
        throw apiError(400, 'signature_mismatch')
      },
    })
    const result = await createToolHandlers(haven).haven_submit({ sub_budget_id: GRANT, signature: SIG })
    expect(result.success).toBe(false)
    expect(closeSubBudget).not.toHaveBeenCalled()
  })
})
