/**
 * #3378 — the hosted runtime declared `task_budget_id` on `haven_send`,
 * `haven_pay` and `haven_pay_x402_quote` (#3329, `tools/contracts.ts`), but no
 * handler forwarded it: the payment was charged to the agent's WHOLE budget
 * delegation instead of the open task budget, with nothing erroring. These
 * tests read the recorded WIRE bodies (`/payments` is snake_case
 * `task_budget_id`; `/x402` is camelCase `taskBudgetId`) on every path, with
 * and without the argument.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_RESPONSE,
  PAYMENT_REQUIRED,
  X402_INTENT_RESPONSE,
  clearCalls,
  handlers,
  installSharedFixtureLifecycle,
  ok,
  recordedCalls,
  stubFetch,
} from './test-support/hosted-mcp.js'

installSharedFixtureLifecycle()

beforeEach(() => {
  clearCalls()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const INTENT = {
  status: 201,
  body: {
    payment_id: 'pay_3378',
    status: 'pending_signature',
    expires_at: '2099-01-01T00:00:00.000Z',
    sign_data: { hash: '0xdeadbeef' },
  },
}

function bodyOf(path: string): Record<string, unknown> {
  const call = recordedCalls().find((c) => new URL(c.url).pathname === path)
  expect(call, `a ${path} request was made`).toBeDefined()
  const raw = call!.body
  return typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>)
}

describe.each([
  ['haven_send', { asset: 'USDC', recipient: '0xRecipient', amount: '5.00' }],
  ['haven_pay', { token: 'USDC', amount: '5.00', to: '0xRecipient' }],
] as const)('%s → POST /payments', (tool, args) => {
  it('carries task_budget_id when the caller names one', async () => {
    stubFetch({ 'POST /payments': INTENT })
    ok(await handlers()[tool]({ ...args, task_budget_id: 'tb_3378' }))
    expect(bodyOf('/payments').task_budget_id).toBe('tb_3378')
  })

  it('carries no task_budget_id key without one', async () => {
    stubFetch({ 'POST /payments': INTENT })
    ok(await handlers()[tool]({ ...args }))
    expect(bodyOf('/payments')).not.toHaveProperty('task_budget_id')
  })
})

describe('haven_pay_x402_quote → POST /x402', () => {
  const DELEGATION_AGENT = { ...AGENT_RESPONSE, execution_rail: 'delegation' }
  const ERC7710_PR = {
    ...PAYMENT_REQUIRED,
    accepts: [
      ...PAYMENT_REQUIRED.accepts,
      {
        ...PAYMENT_REQUIRED.accepts[0],
        extra: {
          assetTransferMethod: 'erc7710',
          facilitatorAddresses: ['0x4444444444444444444444444444444444444444'],
        },
      },
    ],
  }
  const CHILD = {
    payment_id: 'pay_7710',
    status: 'pending_signature',
    sign_data: {
      hash: '0x' + '11'.repeat(32),
      signature_scheme: 'eip712_delegation',
      typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
    },
  }

  async function payQuote(scheme: 'eip3009' | 'erc7710', taskBudgetId?: string) {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: scheme === 'erc7710' ? DELEGATION_AGENT : AGENT_RESPONSE },
      'POST /x402': { status: 201, body: scheme === 'erc7710' ? CHILD : X402_INTENT_RESPONSE },
    })
    ok(
      await handlers().haven_pay_x402_quote({
        payment_required: scheme === 'erc7710' ? ERC7710_PR : PAYMENT_REQUIRED,
        max_amount: '2000000',
        ...(taskBudgetId ? { task_budget_id: taskBudgetId } : {}),
      }),
    )
    return bodyOf('/x402')
  }

  it.each(['eip3009', 'erc7710'] as const)('%s: carries taskBudgetId when the caller names one', async (scheme) => {
    const body = await payQuote(scheme, 'tb_3378')
    expect(body.settlementScheme).toBe(scheme)
    expect(body.taskBudgetId).toBe('tb_3378')
    expect(body).not.toHaveProperty('task_budget_id')
  })

  it.each(['eip3009', 'erc7710'] as const)('%s: carries no taskBudgetId key without one', async (scheme) => {
    const body = await payQuote(scheme)
    expect(body.settlementScheme).toBe(scheme)
    expect(body).not.toHaveProperty('taskBudgetId')
  })
})
