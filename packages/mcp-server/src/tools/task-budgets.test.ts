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
import { HavenApiError, TASK_SIGN_CONTEXT_VERSION } from '@haven_ai/sdk'
import type { HavenClient } from '@haven_ai/sdk'
import { createToolHandlers, toolSchemas } from '../tools.js'
import { hostedConnectorUpgradeCommand } from '../connector-channel.js'
import {
  SIGNER_CAPABILITY_KEY,
  TASK_BUDGET_MIN_SIGNER_VERSION,
  taskSignerCompatibilityNotice,
} from './support/signer-compat.js'

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
    // #3419: the handoff carries the old-signer recovery notice.
    expect(result.data).toMatchObject({
      signer_compatibility: {
        task_sign_context_version: TASK_SIGN_CONTEXT_VERSION,
        min_signer_version: TASK_BUDGET_MIN_SIGNER_VERSION,
        signer_capability: SIGNER_CAPABILITY_KEY,
      },
    })
    const notice = (result.data as { signer_compatibility: ReturnType<typeof taskSignerCompatibilityNotice> })
      .signer_compatibility
    // The recovery sentence exists as prose AND as data, names the release of
    // the pending budget, the deployment's upgrade command and the reopen.
    expect(notice.check).toContain('Pass payment_id (preferred for delegation-rail x402')
    expect(notice.check).toContain('haven_close_task_budget')
    expect(notice.check).toContain(hostedConnectorUpgradeCommand())
    expect(notice.fallback).toContain('Pass payment_id (preferred for delegation-rail x402')
    expect(notice.fallback).toContain('haven_close_task_budget')
    expect(notice.fallback).toContain(hostedConnectorUpgradeCommand())
    // It names NO relay fallback — unlike the #3277 direct-payment notice.
    expect(notice.fallback).toContain('no relay fallback')
    expect(notice.check).not.toMatch(/typed_data_b64|payload_hash/)
  })

  it('open WITHOUT sign_data carries no signer_compatibility (#3419 negative)', async () => {
    const { haven } = stubHaven({
      openTaskBudget: vi.fn(async () => ({
        taskBudget: { id: 'tb_1', status: 'pending' },
      })),
    })
    const result = await createToolHandlers(haven).haven_open_task_budget({
      max_amount_human: '5',
      ttl_minutes: 60,
    })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.data).not.toHaveProperty('signer_compatibility')
    expect(result.data).not.toHaveProperty('sign_data')
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
    // #3419: the CLOSING handoff carries the same notice from the same builder.
    expect(result.data).toMatchObject({
      signer_compatibility: taskSignerCompatibilityNotice(),
    })
  })

  it('a CLOSED close result carries no signer_compatibility (#3419 negative)', async () => {
    const { haven } = stubHaven()
    const result = await createToolHandlers(haven).haven_close_task_budget({ task_budget_id: 'tb_1' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect(result.data).toMatchObject({ status: 'closed' })
    expect(result.data).not.toHaveProperty('signer_compatibility')
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

/**
 * #4468: the two close codes on `haven_submit`'s TASK-budget path. The
 * sub-budget path has mapped them since #3506; the task-budget path had no
 * catch at all, so a close whose outcome is unconfirmed read as the generic
 * 5xx "retry once" and a stale close op read as a generic 4xx stop. The
 * backend names the remedy on both — call close again — and this handler is
 * the one that knows the id, so the step names `haven_close_task_budget` with
 * `task_budget_id`.
 */
describe('haven_submit — task_budget_id close refusals (#4468)', () => {
  const SIG = `0x${'ab'.repeat(65)}`
  const backendRefusal = (errorCode: string, status: number) =>
    new HavenApiError('backend message', status, { error: 'backend message', error_code: errorCode })

  it('close_needs_reprepare names haven_close_task_budget with the id', async () => {
    const { haven } = stubHaven({
      submitTaskBudget: vi.fn(async () => {
        throw backendRefusal('close_needs_reprepare', 409)
      }),
    })
    const result = await createToolHandlers(haven).haven_submit({ task_budget_id: 'tb_1', signature: SIG })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.code).toBe('CLOSE_NEEDS_REPREPARE')
    expect(result.statusCode).toBe(409)
    expect(result.next_action).toBe('sign_and_submit_payment')
    expect(result.next_tool_name).toBe('haven_close_task_budget')
    expect(result.next_arguments).toEqual({ task_budget_id: 'tb_1' })
  })

  it('close_outcome_unconfirmed names haven_close_task_budget with the id and says to wait', async () => {
    const { haven } = stubHaven({
      submitTaskBudget: vi.fn(async () => {
        throw backendRefusal('close_outcome_unconfirmed', 502)
      }),
    })
    const result = await createToolHandlers(haven).haven_submit({ task_budget_id: 'tb_1', signature: SIG })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.code).toBe('CLOSE_OUTCOME_UNCONFIRMED')
    expect(result.statusCode).toBe(502)
    expect(result.next_action).toBe('check_status_later')
    expect(result.next_tool_name).toBe('haven_close_task_budget')
    expect(result.next_arguments).toEqual({ task_budget_id: 'tb_1' })
    expect(result.message).toMatch(/not confirmed yet/)
  })

  it('any other submit failure is relayed unchanged', async () => {
    const { haven } = stubHaven({
      submitTaskBudget: vi.fn(async () => {
        throw backendRefusal('something_else', 500)
      }),
    })
    const result = await createToolHandlers(haven).haven_submit({ task_budget_id: 'tb_1', signature: SIG })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.code).toBe('API_ERROR')
    expect(result.next_tool_name).toBeUndefined()
  })
})
