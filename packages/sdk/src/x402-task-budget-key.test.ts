/**
 * #3329 — `/x402` request bodies are camelCase (`X402AuthorizeRequest`
 * declares `taskBudgetId`, `additionalProperties: false`), unlike
 * `POST /payments`, which is snake_case (`task_budget_id`). The SDK's
 * eip3009 dispatch sent `task_budget_id` on `/x402` too, which the
 * request-validation plugin refuses with a 400 (`haven_pay_x402` reached it
 * through `fetch()`; `haven_pay_x402_quote` never sent any task-budget key
 * until #3378, because `payX402Quote` dropped the option — pinned in
 * `funding-leg-pin.test.ts`). These tests pin the wire key on both eip3009
 * producers directly, without exercising the full funding/signing round trip.
 */
import { describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { X402FundingLeg } from './x402-funding-leg.js'
import type { X402PaymentOption, X402PaymentRequired } from './types.js'

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

const paymentRequired: X402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: 'https://api.merchant.example/paid',
    description: 'paid resource',
    mimeType: 'application/json',
  },
  accepts: [accepted],
}

const delegateAddress = '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1'

describe('#3329 taskBudgetId wire key — eip3009 dispatch', () => {
  it('createX402Intent (client.ts, keyless) sends taskBudgetId, never task_budget_id', async () => {
    const client = new HavenClient({ baseUrl: 'https://example.invalid', apiKey: 'sk_test' })
    vi.spyOn(client as never, 'getAgent').mockResolvedValue({
      id: 'agent-1',
      name: 'A',
      status: 'active',
      accountAddress: '0x1111111111111111111111111111111111111111',
      delegateAddress,
      chainId: 8453,
      executionRail: 'delegation',
    } as never)
    const postSpy = vi.spyOn(client as never, 'post').mockResolvedValue({
      status: 'pending_signature',
      payment_id: 'pay_1',
      sign_data: { hash: '0x' + '11'.repeat(32) },
      x402_expected_auth: { version: 3, network: accepted.network, asset: accepted.asset },
    } as never)

    await client.createX402Intent(paymentRequired, { taskBudgetId: 'tb_1' })

    const [path, body] = (postSpy.mock.calls[0] as [string, Record<string, unknown>])
    expect(path).toBe('/x402')
    expect(body.taskBudgetId).toBe('tb_1')
    expect(body).not.toHaveProperty('task_budget_id')
  })

  it('X402FundingLeg.authorize (local-key path) sends taskBudgetId, never task_budget_id', async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const post = vi.fn(async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
      posts.push({ path, body })
      return {
        status: 'confirmed',
        tx_hash: '0xabc',
        payment_id: 'pay_1',
        chain_id: 8453,
        token: 'USDC',
        amount: '0.02',
        to: delegateAddress,
      } as unknown as T
    })

    const fundingLeg = new X402FundingLeg({
      delegateKey: `0x${'01'.repeat(32)}`,
      delegateAddress,
      x402Wallet: undefined,
      chainRpcs: {},
      post: post as never,
      signForData: vi.fn(),
      assertSignableAuthorizationState: vi.fn(),
    })

    await fundingLeg
      .authorize(paymentRequired, accepted, 'idem-key-1', 'tb_1')
      .catch(() => undefined) // the funding-status branch is irrelevant here — only the POST body is under test

    expect(posts).toHaveLength(1)
    expect(posts[0].path).toBe('/x402')
    expect(posts[0].body.taskBudgetId).toBe('tb_1')
    expect(posts[0].body).not.toHaveProperty('task_budget_id')
  })

  it('X402FundingLeg.authorize omits taskBudgetId entirely when none is passed', async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = []
    const post = vi.fn(async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
      posts.push({ path, body })
      return {
        status: 'confirmed',
        tx_hash: '0xabc',
        payment_id: 'pay_1',
        chain_id: 8453,
        token: 'USDC',
        amount: '0.02',
        to: delegateAddress,
      } as unknown as T
    })

    const fundingLeg = new X402FundingLeg({
      delegateKey: `0x${'01'.repeat(32)}`,
      delegateAddress,
      x402Wallet: undefined,
      chainRpcs: {},
      post: post as never,
      signForData: vi.fn(),
      assertSignableAuthorizationState: vi.fn(),
    })

    await fundingLeg.authorize(paymentRequired, accepted, 'idem-key-2').catch(() => undefined)

    expect(posts[0].body).not.toHaveProperty('taskBudgetId')
    expect(posts[0].body).not.toHaveProperty('task_budget_id')
  })
})
