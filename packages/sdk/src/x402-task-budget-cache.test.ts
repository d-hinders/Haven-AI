/**
 * #3392 — the SDK's x402 receipt cache and in-flight map record the
 * `taskBudgetId` each entry was created under, and a call naming a different
 * one is refused with the typed `X402TaskBudgetMismatchError` BEFORE any
 * network call. `resumeAuthorizedX402` records the caller-supplied
 * `taskBudgetId` option (absent when none is given). "Absent" is a value:
 * none-vs-none hits, none-vs-named refuses, ids compare case-insensitively.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { HavenClient } from './client.js'
import { X402TaskBudgetMismatchError } from './types.js'
import type { X402PaymentOption, X402PaymentRequired, X402Receipt } from './types.js'
import { sameX402TaskBudget } from './x402-funding-leg.js'

const accepted: X402PaymentOption = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '1000',
  payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
}

const paymentRequired: X402PaymentRequired = {
  x402Version: 2,
  error: 'Payment required',
  resource: {
    url: 'https://api.merchant.example/paid',
    description: 'NordShield VPN Basic - $0.001 USDC',
    mimeType: 'application/json',
  },
  accepts: [accepted],
}

const BUDGET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BUDGET_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const KEY = 'tb-cache-key'

/** A header whose validBefore is in the future, so cacheReceipt keeps the entry. */
function validHeader(): string {
  return Buffer.from(
    JSON.stringify({ payload: { authorization: { validBefore: String(Math.floor(Date.now() / 1000) + 600) } } }),
  ).toString('base64')
}

function receipt(id: string): X402Receipt {
  return { paymentId: id } as X402Receipt
}

function client(): HavenClient {
  return new HavenClient({
    apiKey: 'sk_agent_test',
    delegateKey: `0x${'01'.repeat(32)}`,
    baseUrl: 'https://haven.example',
  })
}

function fundingLegOf(c: HavenClient) {
  return (c as unknown as { fundingLeg: InstanceType<typeof import('./x402-funding-leg.js').X402FundingLeg> }).fundingLeg
}

/** The `/x402` POST answer for a fresh (still-signable) intent. */
function pendingSignatureResponse(): Response {
  return new Response(JSON.stringify({
    success: false,
    payment_id: 'pay_fresh',
    status: 'pending_signature',
    sign_data: { hash: `0x${'ab'.repeat(32)}` },
  }), { status: 201 })
}

/** The status answer `resumeAuthorizedX402` needs (funded, ready to retry). */
function executedStatusResponse(): Response {
  return new Response(JSON.stringify({
    payment_id: 'pay_fresh',
    kind: 'approval_request',
    rail: 'x402',
    status: 'executed',
    phase: 'funding_sent',
    next_action: 'retry_original_x402_request',
    amount: '0.001',
    token: 'USDC',
    resource_url: paymentRequired.resource.url,
    merchant_address: accepted.payTo,
    tx_hash: `0x${'cd'.repeat(32)}`,
    expires_at: '2026-12-10T20:00:00.000Z',
    chain_id: 8453,
    message: 'Retry the original x402 request.',
  }), { status: 200 })
}

describe('#3392 sameX402TaskBudget — "absent" is a value', () => {
  it('none vs none matches; none vs named does not; ids are case-insensitive', () => {
    expect(sameX402TaskBudget(undefined, undefined)).toBe(true)
    expect(sameX402TaskBudget(undefined, BUDGET_A)).toBe(false)
    expect(sameX402TaskBudget(BUDGET_A, undefined)).toBe(false)
    expect(sameX402TaskBudget(BUDGET_A, BUDget_A_UPPER())).toBe(true)
    expect(sameX402TaskBudget(BUDGET_A, BUDGET_B)).toBe(false)
  })

  function BUDget_A_UPPER(): string {
    return BUDGET_A.toUpperCase()
  }
})

describe('#3392 funding-leg receipt cache pins the task budget', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a matching budget (or both absent) hits; a different one throws the typed error', () => {
    const leg = fundingLegOf(client())
    leg.cacheReceipt(KEY, validHeader(), receipt('pay_a'), BUDGET_A)

    expect(leg.cachedReceipt(KEY, BUDGET_A)).toMatchObject({ paymentId: 'pay_a' })
    expect(leg.cachedReceipt(KEY, BUDGET_A.toUpperCase())).toMatchObject({ paymentId: 'pay_a' })
    expect(() => leg.cachedReceipt(KEY, BUDGET_B)).toThrow(X402TaskBudgetMismatchError)
    expect(() => leg.cachedReceipt(KEY)).toThrow(X402TaskBudgetMismatchError)

    // An entry created under NO budget: none-vs-none hits, naming one refuses.
    leg.cacheReceipt(`${KEY}-bare`, validHeader(), receipt('pay_bare'))
    expect(leg.cachedReceipt(`${KEY}-bare`)).toMatchObject({ paymentId: 'pay_bare' })
    expect(() => leg.cachedReceipt(`${KEY}-bare`, BUDGET_A)).toThrow(X402TaskBudgetMismatchError)
  })

  it('the typed error names the key, the entry budget and the requested one', () => {
    const leg = fundingLegOf(client())
    leg.cacheReceipt(KEY, validHeader(), receipt('pay_a'), BUDGET_A)

    const err = (() => {
      try {
        leg.cachedReceipt(KEY, BUDGET_B)
      } catch (e) {
        return e as X402TaskBudgetMismatchError
      }
      throw new Error('expected a throw')
    })()

    expect(err).toBeInstanceOf(X402TaskBudgetMismatchError)
    expect(err.x402ErrorCode).toBe('task_budget_mismatch')
    expect(err.idempotencyKey).toBe(KEY)
    expect(err.entryTaskBudgetId).toBe(BUDGET_A)
    expect(err.requestedTaskBudgetId).toBe(BUDGET_B)
    expect(err.message).toContain('idempotencyKey')
  })
})

describe('#3392 authorizeX402 refuses a mismatched cache/in-flight entry before any network call', () => {
  afterEach(() => vi.restoreAllMocks())

  it('a cached receipt under the same budget is returned with zero fetches', async () => {
    const c = client()
    fundingLegOf(c).cacheReceipt(KEY, validHeader(), receipt('pay_cached'), BUDGET_A)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const out = await c.authorizeX402(paymentRequired, { idempotencyKey: KEY, taskBudgetId: BUDGET_A })

    expect(out).toMatchObject({ paymentId: 'pay_cached' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a cached receipt under a DIFFERENT budget throws the typed error with zero fetches', async () => {
    const c = client()
    fundingLegOf(c).cacheReceipt(KEY, validHeader(), receipt('pay_cached'), BUDGET_A)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(pendingSignatureResponse())

    const err = await c
      .authorizeX402(paymentRequired, { idempotencyKey: KEY, taskBudgetId: BUDGET_B })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(X402TaskBudgetMismatchError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an in-flight payment under the same budget is joined — one authorize, no second network leg', async () => {
    const c = client()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    // The in-flight map and its budget comparison are the unit here; the
    // funding leg is a collaborator whose timing this test controls.
    let resolveAuth!: (r: X402Receipt) => void
    const authPromise = new Promise<X402Receipt>((res) => {
      resolveAuth = res
    })
    const authorizeSpy = vi.spyOn(fundingLegOf(c), 'authorize').mockReturnValue(authPromise)

    const first = c.authorizeX402(paymentRequired, { idempotencyKey: KEY, taskBudgetId: BUDGET_A })
    // No await: the join blocks on the first call's in-flight promise, which
    // only resolveAuth (below) releases.
    const joinedPromise = c.authorizeX402(paymentRequired, { idempotencyKey: KEY, taskBudgetId: BUDGET_A })

    expect(authorizeSpy).toHaveBeenCalledTimes(1)
    resolveAuth(receipt('pay_fresh'))
    expect(await joinedPromise).toBe(await first)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('an in-flight payment under a DIFFERENT budget throws the typed error without joining', async () => {
    const c = client()
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    let resolveAuth!: (r: X402Receipt) => void
    const authPromise = new Promise<X402Receipt>((res) => {
      resolveAuth = res
    })
    const authorizeSpy = vi.spyOn(fundingLegOf(c), 'authorize').mockReturnValue(authPromise)

    const first = c.authorizeX402(paymentRequired, { idempotencyKey: KEY, taskBudgetId: BUDGET_A })
    const err = await c
      .authorizeX402(paymentRequired, { idempotencyKey: KEY, taskBudgetId: BUDGET_B })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(X402TaskBudgetMismatchError)
    expect(authorizeSpy).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
    resolveAuth(receipt('pay_fresh'))
    await expect(first).resolves.toMatchObject({ paymentId: 'pay_fresh' })
  })
})

describe('#3392 resumeAuthorizedX402 records the caller-supplied taskBudgetId', () => {
  afterEach(() => vi.restoreAllMocks())

  it('refuses a cache entry created under a different budget before any network call', async () => {
    const c = client()
    fundingLegOf(c).cacheReceipt(KEY, validHeader(), receipt('pay_cached'), BUDGET_A)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(executedStatusResponse())

    const err = await c
      .resumeAuthorizedX402({
        paymentId: 'pay_cached',
        paymentRequired,
        idempotencyKey: KEY,
        taskBudgetId: BUDGET_B,
      })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(X402TaskBudgetMismatchError)
    // The status read would have been the first fetch — it never happened.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a matching cached entry is returned with zero fetches', async () => {
    const c = client()
    fundingLegOf(c).cacheReceipt(KEY, validHeader(), receipt('pay_cached'), BUDGET_A)
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const out = await c.resumeAuthorizedX402({
      paymentId: 'pay_cached',
      paymentRequired,
      idempotencyKey: KEY,
      taskBudgetId: BUDGET_A,
    })

    expect(out).toMatchObject({ paymentId: 'pay_cached' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the entry it writes records the caller-supplied taskBudgetId option', async () => {
    const c = client()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(executedStatusResponse())
    vi.spyOn(fundingLegOf(c), 'createPaymentHeader').mockResolvedValue(validHeader())

    const out = await c.resumeAuthorizedX402({
      paymentId: 'pay_fresh',
      paymentRequired,
      idempotencyKey: KEY,
      taskBudgetId: BUDGET_A,
    })

    const leg = fundingLegOf(c)
    expect(leg.cachedReceipt(KEY, BUDGET_A)).toBe(out)
    expect(() => leg.cachedReceipt(KEY, BUDGET_B)).toThrow(X402TaskBudgetMismatchError)
  })
})
