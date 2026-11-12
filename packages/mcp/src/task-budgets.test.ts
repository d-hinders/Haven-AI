/**
 * #3329 — task budgets on the local MCP surface: haven_open_task_budget,
 * haven_close_task_budget, haven_submit, and the task_budget_id hand-off on
 * haven_send / haven_pay_x402_quote / haven_pay_x402.
 *
 * These tests stub `HavenClient` (the pattern `spelling-window.test.ts` uses),
 * so each proves only the TOOL-TO-SDK hand-off: that the handler passes the
 * option to the SDK method. Whether the SDK then puts it on the wire is pinned
 * against a real client with mocked HTTP elsewhere — for haven_pay_x402_quote
 * in `tools.test.ts` (#3378: the SDK's `payX402Quote` dropped it while this
 * stub test passed), and in the SDK's own `funding-leg-pin.test.ts` and
 * `x402-task-budget-key.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers, toolSchemas } from './tools.js'

const ALLOWANCES = {
  agentId: 'agt_1',
  accountAddress: '0xaccount',
  delegateAddress: '0xdelegate',
  chainId: 8453,
  allowances: [
    {
      id: 'al_1',
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      tokenSymbol: 'USDC',
      configuredAmount: '100',
      resetPeriodMin: 1440,
      remainingDisplay: '100 USDC',
      onchain: {
        amount: '100000000',
        spent: '0',
        remaining: '100000000',
        effectiveSpent: '0',
        resetTimeMin: 1440,
        lastResetMin: 0,
        nonce: 0,
        isResetPending: false,
      },
    },
  ],
}

function stubHaven(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Record<string, unknown[]> = {}
  const record =
    (name: string, impl: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      calls[name] = args
      return impl(...args)
    }
  const haven = {
    getAllowances: vi.fn(record('getAllowances', async () => ALLOWANCES)),
    openTaskBudget: vi.fn(
      record('openTaskBudget', async () => ({
        taskBudget: {
          id: 'tb_1',
          agentId: 'agt_1',
          chainId: 8453,
          tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          recipientAddress: null,
          status: 'pending',
          maxAtomic: '5000000',
          label: null,
          expiresAt: 1234567890,
          isExpired: false,
          createdAt: '2026-09-25T00:00:00Z',
          openedAt: null,
          closedAt: null,
          closeTxHash: null,
        },
        signData: { signatureScheme: 'eip712_delegation', typedData: {} },
      })),
    ),
    closeTaskBudget: vi.fn(
      record('closeTaskBudget', async () => ({
        taskBudget: { id: 'tb_1', status: 'closed' },
        status: 'closed',
      })),
    ),
    submitTaskBudget: vi.fn(
      record('submitTaskBudget', async () => ({
        taskBudget: { id: 'tb_1', status: 'open' },
        status: 'open',
      })),
    ),
    pay: vi.fn(record('pay', async () => ({ paymentId: 'pay_1', status: 'executed', txHash: '0xabc' }))),
    payX402Quote: vi.fn(
      record('payX402Quote', async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    ),
    fetch: vi.fn(record('fetch', async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))),
    withRequestContext: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
    clientUpdate: () => undefined,
    ...overrides,
  } as unknown as HavenClient
  return { haven, calls }
}

describe('haven_open_task_budget (#3329, #4825)', () => {
  it('is declared in the tool schema and description surfaces', () => {
    expect(toolSchemas.haven_open_task_budget).toBeDefined()
  })

  it('refuses with TASK_BUDGET_SIGNING_UNAVAILABLE and never calls POST /task-budgets (#4825)', async () => {
    // The stub client fails the test if `openTaskBudget` is reached: a pending
    // row must not be created on a runtime that cannot sign it.
    const { haven, calls } = stubHaven({
      openTaskBudget: vi.fn(async () => {
        throw new Error('the local haven_open_task_budget reached openTaskBudget')
      }),
    })
    const result = await createToolHandlers(haven).haven_open_task_budget({
      max_amount_human: '5',
      ttl_minutes: 60,
    })
    expect(result).toMatchObject({
      success: false,
      code: 'TASK_BUDGET_SIGNING_UNAVAILABLE',
      next_action: 'stop_and_tell_user',
    })
    expect(calls.openTaskBudget).toBeUndefined()
    // Nothing else is contacted either — not even the allowance read.
    expect(calls.getAllowances).toBeUndefined()
    const failure = result as { message: string; next_tool?: string; next_tool_omitted_reason?: string }
    expect(failure.next_tool).toBeUndefined()
    expect(failure.message).toMatch(/hosted-plus-signer/)
    expect(failure.next_tool_omitted_reason).toMatch(/cannot sign a task budget/)
  })

  it('refuses the same way whatever the arguments are — no argument makes this runtime able to sign', async () => {
    const { haven, calls } = stubHaven()
    for (const args of [
      { max_amount_human: '5', ttl_minutes: 60 },
      { max_amount_human: '5', ttl_minutes: 60, token: 'DAI' },
      { max_amount_human: '5.1234567', ttl_minutes: 60 },
    ]) {
      const result = await createToolHandlers(haven).haven_open_task_budget(args)
      expect(result).toMatchObject({ success: false, code: 'TASK_BUDGET_SIGNING_UNAVAILABLE' })
    }
    expect(calls.openTaskBudget).toBeUndefined()
  })

  it('rejects ttl_minutes outside 1..1440 at the schema level', () => {
    expect(() => toolSchemas.haven_open_task_budget).not.toThrow()
    const parsed = Object.assign({}, toolSchemas.haven_open_task_budget)
    expect(parsed.ttl_minutes.safeParse(1441).success).toBe(false)
    expect(parsed.ttl_minutes.safeParse(1440).success).toBe(true)
  })
})

describe('haven_close_task_budget (#3329, #4825)', () => {
  /** A stub whose `getTaskBudget` answers `budget` and whose close answers `close`. */
  function stubClose(budget: Record<string, unknown>, close?: () => Promise<unknown>) {
    const closeTaskBudget = vi.fn(
      close ??
        (async () => ({
          taskBudget: { id: 'tb_1', status: 'closed' },
          status: 'closed',
        })),
    )
    const getTaskBudget = vi.fn(async () => budget)
    const haven = {
      getTaskBudget,
      closeTaskBudget,
      withRequestContext: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
      clientUpdate: () => undefined,
    } as unknown as HavenClient
    return { haven, getTaskBudget, closeTaskBudget }
  }

  it('still answers status closed for a PENDING budget, without a signature', async () => {
    const { haven, closeTaskBudget } = stubClose({
      id: 'tb_1',
      status: 'pending',
      isExpired: false,
      isLive: true,
      openedAt: null,
      closedAt: null,
    })
    const result = await createToolHandlers(haven).haven_close_task_budget({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.data).toMatchObject({ task_budget: { id: 'tb_1' }, status: 'closed' })
    expect(closeTaskBudget).toHaveBeenCalledWith('tb_1')
  })

  it('still answers status closed for an EXPIRED budget, without a signature', async () => {
    const { haven, closeTaskBudget } = stubClose({
      id: 'tb_1',
      status: 'open',
      isExpired: true,
      isLive: false,
      openedAt: '2026-11-01T00:00:00Z',
      closedAt: null,
    })
    const result = await createToolHandlers(haven).haven_close_task_budget({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.data).toMatchObject({ status: 'closed' })
    expect(closeTaskBudget).toHaveBeenCalledWith('tb_1')
  })

  it('answers status closed for an already-CLOSED budget without calling the close route', async () => {
    const { haven, closeTaskBudget } = stubClose({
      id: 'tb_1',
      status: 'closed',
      isExpired: false,
      isLive: false,
      openedAt: '2026-11-01T00:00:00Z',
      closedAt: '2026-11-02T00:00:00Z',
    })
    const result = await createToolHandlers(haven).haven_close_task_budget({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.data).toMatchObject({ status: 'closed' })
    expect(closeTaskBudget).not.toHaveBeenCalled()
  })

  it.each([
    ['an open', { id: 'tb_1', status: 'open', isExpired: false, isLive: true, openedAt: '2026-11-01T00:00:00Z', closedAt: null }],
    ['a closing', { id: 'tb_1', status: 'closing', isExpired: false, isLive: true, openedAt: '2026-11-01T00:00:00Z', closedAt: null }],
  ])('refuses %s budget with TASK_BUDGET_SIGNING_UNAVAILABLE and never calls POST /task-budgets/:id/close (#4825)', async (_label, budget) => {
    // The stub fails the test if the close route is reached: a refused close
    // must not leave the budget `closing`.
    const { haven, closeTaskBudget } = stubClose(budget, async () => {
      throw new Error('the local haven_close_task_budget reached closeTaskBudget')
    })
    const result = await createToolHandlers(haven).haven_close_task_budget({ task_budget_id: 'tb_1' })
    expect(result).toMatchObject({
      success: false,
      code: 'TASK_BUDGET_SIGNING_UNAVAILABLE',
      next_action: 'stop_and_tell_user',
    })
    expect(closeTaskBudget).not.toHaveBeenCalled()
    const failure = result as { message: string; next_tool?: string; next_tool_omitted_reason?: string }
    expect(failure.next_tool).toBeUndefined()
    expect(failure.message).toMatch(/hosted-plus-signer/)
    expect(failure.next_tool_omitted_reason).toMatch(/cannot sign a task budget/)
  })

  it('refuses an open budget on a backend that predates is_live, using isExpired instead', async () => {
    const { haven, closeTaskBudget } = stubClose({
      id: 'tb_1',
      status: 'open',
      isExpired: false,
      openedAt: '2026-11-01T00:00:00Z',
      closedAt: null,
    })
    const result = await createToolHandlers(haven).haven_close_task_budget({ task_budget_id: 'tb_1' })
    expect(result).toMatchObject({ success: false, code: 'TASK_BUDGET_SIGNING_UNAVAILABLE' })
    expect(closeTaskBudget).not.toHaveBeenCalled()
  })

  it('passes a failed budget read through as the typed refusal it is', async () => {
    const haven = {
      getTaskBudget: vi.fn(async () => {
        throw new Error('network down')
      }),
      withRequestContext: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
      clientUpdate: () => undefined,
    } as unknown as HavenClient
    const result = await createToolHandlers(haven).haven_close_task_budget({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(false)
  })
})

describe('haven_submit (#3329)', () => {
  const SIG = `0x${'ab'.repeat(65)}`

  it('refuses when both task_budget_id and payment_id are sent', async () => {
    const { haven } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({
      task_budget_id: 'tb_1',
      payment_id: 'pay_1',
      signature: SIG,
    })
    expect(result).toMatchObject({ success: false, code: 'INVALID_INPUT' })
  })

  it('refuses when neither task_budget_id nor payment_id is sent', async () => {
    const { haven } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({ signature: SIG })
    expect(result).toMatchObject({ success: false, code: 'INVALID_INPUT' })
  })

  it('relays a task_budget_id submission to the SDK', async () => {
    const { haven, calls } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({ task_budget_id: 'tb_1', signature: SIG })
    expect(result.success).toBe(true)
    expect(calls.submitTaskBudget).toEqual(['tb_1', SIG])
  })

  it('refuses a payment_id submission — no relay step exists on the local surface', async () => {
    const { haven } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({ payment_id: 'pay_1', signature: SIG })
    expect(result.success).toBe(false)
  })
})

describe('task_budget_id pass-through on payment tools (#3329)', () => {
  it('haven_send hands task_budget_id to haven.pay as taskBudgetId (hand-off only)', async () => {
    const { haven, calls } = stubHaven()
    await createToolHandlers(haven).haven_send({
      asset: 'USDC',
      recipient: '0xabc',
      amount: '1',
      task_budget_id: 'tb_1',
    })
    expect(calls.pay[0]).toMatchObject({ taskBudgetId: 'tb_1' })
  })

  it('haven_send omits taskBudgetId entirely when not given', async () => {
    const { haven, calls } = stubHaven()
    await createToolHandlers(haven).haven_send({ asset: 'USDC', recipient: '0xabc', amount: '1' })
    expect(calls.pay[0]).not.toHaveProperty('taskBudgetId')
  })

  it('haven_pay_x402_quote hands task_budget_id to the SDK as taskBudgetId (hand-off only; wire: tools.test.ts)', async () => {
    const { haven, calls } = stubHaven()
    await createToolHandlers(haven).haven_pay_x402_quote({
      quote: { paymentRequired: {} },
      task_budget_id: 'tb_1',
    })
    expect(calls.payX402Quote[1]).toMatchObject({ taskBudgetId: 'tb_1' })
  })

  it('haven_pay_x402 hands task_budget_id to the SDK as taskBudgetId (hand-off only)', async () => {
    const { haven, calls } = stubHaven()
    await createToolHandlers(haven).haven_pay_x402({
      url: 'https://merchant.example/paid',
      task_budget_id: 'tb_1',
    })
    expect(calls.fetch[2]).toMatchObject({ taskBudgetId: 'tb_1' })
  })
})
