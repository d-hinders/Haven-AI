/**
 * #3329 — the hosted task-budget capability: haven_open_task_budget,
 * haven_close_task_budget, and haven_submit's task_budget_id branch
 * (owned by tools/state-direct-recovery.ts).
 *
 * The SDK client methods this slice calls (`openTaskBudget`, `closeTaskBudget`,
 * `submitTaskBudget`) are being added concurrently by another worker and are
 * not yet present on `HavenClient` — verified against `packages/sdk/src/client.ts`
 * as of this slice. So `haven` is stubbed directly here, the same pattern the
 * local `@haven_ai/mcp` package's tests use for `pay`, rather than driven
 * through a real `HavenClient` over a mocked HTTP transport.
 */
import { describe, expect, it, vi } from 'vitest'
import type { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers, toolSchemas } from '../tools.js'

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
        taskBudget: { id: 'tb_1', status: 'pending' },
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
    withRequestContext: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
    clientUpdate: () => undefined,
    ...overrides,
  } as unknown as HavenClient
  return { haven, calls }
}

describe('haven_open_task_budget (#3329)', () => {
  it('is declared, strict, and described', () => {
    expect(toolSchemas.haven_open_task_budget).toBeDefined()
  })

  it('resolves USDC by default, converts the human amount to atomic, and hands back the signer context', async () => {
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
      next_action: 'sign_and_submit_payment',
      next_tool_name: 'haven_sign',
      next_tool_server_role: 'signer',
      next_arguments: { task_budget_id: 'tb_1' },
    })
    expect((result.data as { sign_data: unknown }).sign_data).toBeDefined()
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

  it('refuses an over-precise human amount before any reservation', async () => {
    const { haven, calls } = stubHaven()
    const result = await createToolHandlers(haven).haven_open_task_budget({
      max_amount_human: '5.1234567',
      ttl_minutes: 60,
    })
    expect(result.success).toBe(false)
    expect(calls.openTaskBudget).toBeUndefined()
  })

  it('refuses an undeclared argument (strict input)', async () => {
    const { haven } = stubHaven()
    const result = await createToolHandlers(haven).haven_open_task_budget({
      max_amount_human: '5',
      ttl_minutes: 60,
      unexpected: 'nope',
    })
    expect(result.success).toBe(false)
  })
})

describe('haven_close_task_budget (#3329)', () => {
  it('returns status closed directly when the backend already closed it (pending or expired)', async () => {
    const { haven } = stubHaven()
    const result = await createToolHandlers(haven).haven_close_task_budget({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.data).toMatchObject({ task_budget: { id: 'tb_1' }, status: 'closed' })
  })

  it('hands back the signer context when a close UserOp needs a signature', async () => {
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
      next_action: 'sign_and_submit_payment',
      next_tool_name: 'haven_sign',
      next_tool_server_role: 'signer',
      next_arguments: { task_budget_id: 'tb_1' },
    })
    expect((result.data as { sign_data: unknown }).sign_data).toBeDefined()
  })
})

describe('haven_submit — task_budget_id branch (#3329, owned by state-direct-recovery.ts)', () => {
  const SIG = `0x${'ab'.repeat(65)}`

  it('refuses when both payment_id and task_budget_id are sent', async () => {
    const { haven } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({
      payment_id: 'pay_1',
      task_budget_id: 'tb_1',
      signature: SIG,
    })
    expect(result.success).toBe(false)
  })

  it('refuses when neither payment_id nor task_budget_id is sent', async () => {
    const { haven } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({ signature: SIG })
    expect(result.success).toBe(false)
  })

  it('relays a task_budget_id submission to the SDK', async () => {
    const { haven, calls } = stubHaven()
    const result = await createToolHandlers(haven).haven_submit({ task_budget_id: 'tb_1', signature: SIG })
    expect(result.success).toBe(true)
    expect(calls.submitTaskBudget).toEqual(['tb_1', SIG])
    if (!result.success) throw new Error('expected success')
    expect(result.data).toMatchObject({ task_budget: { id: 'tb_1' }, status: 'open' })
  })
})
