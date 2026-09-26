/**
 * #3375 (epic #3284, slice 3) — HavenClient's own EIP-3009 funding leg runs
 * the #3281 recipient pin (`assertFundingLegPaysDelegate`), not only the
 * #3271 binding and the #3283 direct-payment allowlist.
 *
 * Every refused payload below is self-consistent and guard-shaped (own
 * account, pinned chain, one redemption of a grant from another account), so
 * the binding and the allowlist pass. Only WHERE the leg pays is wrong — the
 * redirect a compromised Haven API could serve against an open budget. Each
 * asserts the refusal comes from the pin and that nothing reached `/sign`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { HavenClient } from './client.js'
import { addressFromKey } from './edge-signing.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'
import { HavenTypedDataRefusedError, TYPED_DATA_NOT_ALLOWED } from './direct-payment-guard.js'
import { DELEGATION_MANAGER } from './settlement-child.js'
import { REDEEM_DELEGATIONS_ABI, SINGLE_DEFAULT_MODE } from './redemption-guard.js'
import {
  DEFAULT_DELEGATOR,
  buildBoundDirectUserOp,
  buildChainPermissionContext,
  buildDelegation,
  buildExecuteCallData,
  buildFundingLegUserOp,
  buildTransferExecutionCallData,
} from './test-support/direct-userop.js'
import type { X402PaymentOption, X402PaymentRequired } from './types.js'

const DELEGATE_KEY = `0x${'01'.repeat(32)}`
const DELEGATE = addressFromKey(DELEGATE_KEY) as Address
const OWN_ACCOUNT = deriveDelegateAccountAddress(DELEGATE)
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const ATTACKER = '0x7777777777777777777777777777777777777777' as Address

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: BASE_USDC,
  amount: '20000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

const paymentRequired: X402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: { url: 'https://api.merchant.example/paid', description: 'pin test', mimeType: 'application/json' },
  accepts: [accepted],
}

/**
 * Serve `authorizeX402` a pending funding intent carrying `userOp`, then a
 * confirmed `/sign` answer. Returns the fetch mock so a test can see whether
 * anything reached `/payments/:id/sign`.
 */
function serveFundingLeg(userOp: { typedData: unknown; payloadHash: string }) {
  const fetchMock = vi.spyOn(globalThis, 'fetch')
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    payment_id: 'pay_3375',
    status: 'pending_signature',
    expires_at: 'later',
    chain_id: 8453,
    to: DELEGATE,
    merchant_to: accepted.payTo,
    sign_data: { hash: userOp.payloadHash, signature_scheme: 'eip712_userop', typed_data: userOp.typedData },
  }), { status: 201 }))
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    payment_id: 'pay_3375',
    status: 'confirmed',
    tx_hash: `0x${'ab'.repeat(32)}`,
    chain_id: 8453,
  }), { status: 200 }))
  const client = new HavenClient({ apiKey: 'sk_agent_test', delegateKey: DELEGATE_KEY, baseUrl: 'https://haven.example' })
  const signPosts = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/sign'))
  return { client, signPosts }
}

/** A funding leg redeemed through a two-link `[task child, budget]` chain (#3329) paying `recipient`. */
function twoLinkFundingLeg(recipient: Address) {
  const taskChild = buildDelegation({ delegate: OWN_ACCOUNT, delegator: OWN_ACCOUNT })
  const budget = buildDelegation({ delegate: OWN_ACCOUNT, delegator: DEFAULT_DELEGATOR })
  const redeem = encodeFunctionData({
    abi: REDEEM_DELEGATIONS_ABI,
    functionName: 'redeemDelegations',
    args: [
      [buildChainPermissionContext([taskChild, budget])],
      [SINGLE_DEFAULT_MODE],
      [buildTransferExecutionCallData(BASE_USDC, recipient, 20000n)],
    ],
  })
  return buildBoundDirectUserOp({
    delegate: DELEGATE,
    chainId: 8453,
    callData: buildExecuteCallData(DELEGATION_MANAGER as Address, 0n, redeem as Hex),
  })
}

describe('HavenClient funding leg — recipient pin (#3375)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('control: signs the leg the backend builds — the quoted amount of the quoted token to the own delegate', async () => {
    const { client, signPosts } = serveFundingLeg(
      buildFundingLegUserOp({ delegate: DELEGATE, asset: BASE_USDC, amount: accepted.amount, chainId: 8453 }),
    )
    const receipt = await client.authorizeX402(paymentRequired)
    expect(receipt.success).toBe(true)
    expect(signPosts()).toHaveLength(1)
  })

  it.each([
    ['a different recipient', { recipient: ATTACKER }, /pays 0x7777.*not this agent's own delegate wallet/i],
    ['a different amount', { amount: '20001' }, /moves 20001, not the quoted amount 20000/],
    ['a different token', { asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address }, /not the quoted token/],
  ])('refuses a guard-shaped leg with %s, and posts nothing to /sign', async (_label, override, message) => {
    const leg = buildFundingLegUserOp({
      delegate: DELEGATE,
      asset: BASE_USDC,
      amount: accepted.amount,
      chainId: 8453,
      ...override,
    })
    const { client, signPosts } = serveFundingLeg(leg)
    const attempt = client.authorizeX402(paymentRequired)
    await expect(attempt).rejects.toBeInstanceOf(HavenTypedDataRefusedError)
    await expect(attempt).rejects.toThrow(/Refusing to sign this x402 funding leg/)
    await expect(attempt).rejects.toThrow(message)
    await expect(attempt).rejects.toMatchObject({ code: TYPED_DATA_NOT_ALLOWED })
    expect(signPosts()).toHaveLength(0)
  })

  it('two-link [task, budget] chain (#3329): signs a leg paying the delegate, refuses one paying anyone else', async () => {
    const ok = serveFundingLeg(twoLinkFundingLeg(DELEGATE))
    await expect(ok.client.authorizeX402(paymentRequired, { taskBudgetId: 'tb_1' })).resolves.toMatchObject({ success: true })
    expect(ok.signPosts()).toHaveLength(1)
    vi.restoreAllMocks()

    const redirected = serveFundingLeg(twoLinkFundingLeg(ATTACKER))
    const attempt = redirected.client.authorizeX402(paymentRequired, { taskBudgetId: 'tb_1' })
    await expect(attempt).rejects.toBeInstanceOf(HavenTypedDataRefusedError)
    await expect(attempt).rejects.toThrow(/Refusing to sign this x402 funding leg/)
    await expect(attempt).rejects.toThrow(/not this agent's own delegate wallet/)
    await expect(attempt).rejects.toMatchObject({ code: TYPED_DATA_NOT_ALLOWED })
    expect(redirected.signPosts()).toHaveLength(0)
  })
})

describe('payX402Quote forwards taskBudgetId to /x402 (#3378)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Quote the merchant, then pay the quote; returns the body of the POST /x402 request. */
  async function payQuote(options: { taskBudgetId?: string; idempotencyKey?: string }) {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    // 1. The merchant's 402 (quoteX402).
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(paymentRequired), {
      status: 402, headers: { 'Content-Type': 'application/json' },
    }))
    // 2–3. /x402 funding intent, then /sign (the leg the backend builds).
    const leg = buildFundingLegUserOp({ delegate: DELEGATE, asset: BASE_USDC, amount: accepted.amount, chainId: 8453 })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      payment_id: 'pay_3378', status: 'pending_signature', expires_at: 'later', chain_id: 8453, to: DELEGATE,
      merchant_to: accepted.payTo,
      sign_data: { hash: leg.payloadHash, signature_scheme: 'eip712_userop', typed_data: leg.typedData },
    }), { status: 201 }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      payment_id: 'pay_3378', status: 'confirmed', tx_hash: `0x${'ab'.repeat(32)}`, chain_id: 8453,
    }), { status: 200 }))
    // 4. The merchant's paid answer.
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const client = new HavenClient({ apiKey: 'sk_agent_test', delegateKey: DELEGATE_KEY, baseUrl: 'https://haven.example' })
    const quote = await client.quoteX402(paymentRequired.resource.url)
    const response = await client.payX402Quote(quote, options)
    expect(response.status).toBe(200)
    const x402Call = fetchMock.mock.calls.find(([url]) => String(url) === 'https://haven.example/x402')
    expect(x402Call).toBeDefined()
    return { body: JSON.parse((x402Call![1] as RequestInit).body as string) as Record<string, unknown>, quote }
  }

  it('sends the task budget the caller named', async () => {
    const { body } = await payQuote({ taskBudgetId: 'tb_3378' })
    expect(body.taskBudgetId).toBe('tb_3378')
  })

  it('sends no taskBudgetId key without one, and keeps the quote\'s idempotency key by default', async () => {
    const { body, quote } = await payQuote({})
    expect(body).not.toHaveProperty('taskBudgetId')
    expect(body.idempotencyKey).toBe(quote.idempotencyKey)
  })

  it('an explicit idempotencyKey still overrides the quote\'s', async () => {
    const { body } = await payQuote({ idempotencyKey: 'idem_3378' })
    expect(body.idempotencyKey).toBe('idem_3378')
  })
})
