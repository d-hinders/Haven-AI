/**
 * #3329 — task budgets on the local MCP surface: haven_open_task_budget,
 * haven_close_task_budget, haven_submit, and the task_budget_id pass-through
 * on haven_send / haven_pay_x402_quote / haven_pay_x402.
 *
 * The SDK client methods this slice calls (`openTaskBudget`, `closeTaskBudget`,
 * `submitTaskBudget`, plus `taskBudgetId` on `pay`/`payX402Quote`/`fetch`) are
 * being added concurrently by another worker and are not yet built into
 * `@haven_ai/sdk`'s dist output — verified: `packages/sdk/src/client.ts` has no
 * `openTaskBudget`/`closeTaskBudget`/`submitTaskBudget` as of this slice, and
 * the DTS build currently fails on an unrelated in-progress file
 * (`task-budget-guards.ts`). So this file stubs `HavenClient` directly, the
 * same pattern `spelling-window.test.ts` uses for its `pay` stub, rather than
 * driving a real client against a mocked HTTP transport.
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

describe('haven_open_task_budget (#3329)', () => {
  it('is declared in the tool schema and description surfaces', () => {
    expect(toolSchemas.haven_open_task_budget).toBeDefined()
  })

  it('resolves the default token (USDC) from allowances, converts the human amount, and hands off to the signer', async () => {
    const { haven, calls } = stubHaven()
    const result = await createToolHandlers(haven).haven_open_task_budget({
      max_amount_human: '5',
      ttl_minutes: 60,
    })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(calls.openTaskBudget[0]).toMatchObject({
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      maxAmountAtomic: '5000000',
      ttlSeconds: 3600,
    })
    expect(result.data).toMatchObject({
      task_budget: { id: 'tb_1' },
      next_action: 'sign',
      next_tool: 'mcp__haven-signer__haven_sign',
      next_arguments: { task_budget_id: 'tb_1' },
    })
  })

  it('refuses a token this agent holds no allowance for, before any reservation', async () => {
    const { haven, calls } = stubHaven()
    const result = await createToolHandlers(haven).haven_open_task_budget({
      max_amount_human: '5',
      ttl_minutes: 60,
      token: 'DAI',
    })
    expect(result.success).toBe(false)
    expect(calls.openTaskBudget).toBeUndefined()
  })

  it('refuses a human amount with more decimal places than the token supports', async () => {
    const { haven, calls } = stubHaven()
    const result = await createToolHandlers(haven).haven_open_task_budget({
      max_amount_human: '5.1234567',
      ttl_minutes: 60,
    })
    expect(result.success).toBe(false)
    expect(calls.openTaskBudget).toBeUndefined()
  })

  it('rejects ttl_minutes outside 1..1440 at the schema level', () => {
    expect(() => toolSchemas.haven_open_task_budget).not.toThrow()
    const parsed = Object.assign({}, toolSchemas.haven_open_task_budget)
    expect(parsed.ttl_minutes.safeParse(1441).success).toBe(false)
    expect(parsed.ttl_minutes.safeParse(1440).success).toBe(true)
  })
})

describe('haven_close_task_budget (#3329)', () => {
  it('returns status closed directly when the backend already closed it', async () => {
    const { haven } = stubHaven()
    const result = await createToolHandlers(haven).haven_close_task_budget({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.data).toMatchObject({ task_budget: { id: 'tb_1' }, status: 'closed' })
  })

  it('hands off to the signer when a close UserOp needs a signature', async () => {
    const { haven } = stubHaven({
      closeTaskBudget: vi.fn(async () => ({
        taskBudget: { id: 'tb_1', status: 'closing' },
        status: 'closing',
        signData: { signatureScheme: 'eip712_userop', typedData: {} },
      })),
    })
    const result = await createToolHandlers(haven).haven_close_task_budget({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.data).toMatchObject({
      next_action: 'sign',
      next_tool: 'mcp__haven-signer__haven_sign',
      next_arguments: { task_budget_id: 'tb_1' },
    })
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
  it('haven_send forwards task_budget_id as taskBudgetId to haven.pay', async () => {
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

  it('haven_pay_x402_quote forwards task_budget_id as taskBudgetId', async () => {
    const { haven, calls } = stubHaven()
    await createToolHandlers(haven).haven_pay_x402_quote({
      quote: { paymentRequired: {} },
      task_budget_id: 'tb_1',
    })
    expect(calls.payX402Quote[1]).toMatchObject({ taskBudgetId: 'tb_1' })
  })

  it('haven_pay_x402 forwards task_budget_id as taskBudgetId', async () => {
    const { haven, calls } = stubHaven()
    await createToolHandlers(haven).haven_pay_x402({
      url: 'https://merchant.example/paid',
      task_budget_id: 'tb_1',
    })
    expect(calls.fetch[2]).toMatchObject({ taskBudgetId: 'tb_1' })
  })
})
