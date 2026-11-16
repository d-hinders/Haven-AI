/**
 * #4853: the Stripe module — configuration, the PaymentIntent request, and the
 * recorder's failure handling. The Stripe API is a fake; nothing here needs a
 * real key, and the key used is obviously fake.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ATOMIC_PER_CENT,
  STRIPE_API_VERSION_LIVE,
  STRIPE_API_VERSION_SANDBOX,
  STRIPE_NETWORK,
  StripeApiError,
  createStripeRecording,
  encodeStripeForm,
  resolveStripeConfig,
  stripeAmountCents,
  stripeApiVersionForChain,
  type StripeHttpClient,
  type StripeHttpRequest,
} from './stripe.js'

const DEPOSIT = '0x2222222222222222222222222222222222222222' as const
const OLD_DEPOSIT = '0x4444444444444444444444444444444444444444' as const
const MERCHANT = '0x1111111111111111111111111111111111111111' as const
/** Obviously fake: a test key, never a real one. */
const FAKE_KEY = 'sk_test_fake_key_for_tests_only'
const TX = `0x${'ab'.repeat(32)}` as const
const TX2 = `0x${'cd'.repeat(32)}` as const

function config(overrides: Partial<Parameters<typeof resolveStripeConfig>[0]> = {}) {
  return resolveStripeConfig({
    depositAddressRaw: DEPOSIT,
    secretKeyRaw: FAKE_KEY,
    cdpConfigured: true,
    priceAtomic: 10_000n,
    chainId: 84532,
    warn: () => {},
    ...overrides,
  })
}

/** An in-memory Stripe: search by metadata, create with an idempotency key. */
function fakeStripe(opts: { failCreate?: boolean; failSearch?: boolean; hang?: boolean } = {}) {
  const intents = new Map<string, { id: string; form: Record<string, string> }>()
  const byTx = new Map<string, string>()
  const requests: StripeHttpRequest[] = []
  let nextId = 1
  const client: StripeHttpClient = {
    async request(request) {
      requests.push(request)
      if (opts.hang) return new Promise<never>(() => {})
      if (request.method === 'GET') {
        if (opts.failSearch) return { status: 500, body: { error: { type: 'api_error' } } }
        const query = new URLSearchParams(request.path.split('?')[1] ?? '').get('query') ?? ''
        const tx = /transaction_hash'\]\s*:\s*'([^']+)'/.exec(query)?.[1]
        const id = tx ? byTx.get(tx) : undefined
        return { status: 200, body: { data: id ? [{ id }] : [] } }
      }
      if (opts.failCreate) {
        return { status: 402, body: { error: { type: 'card_error', code: 'crypto_declined' } } }
      }
      const tx = request.form?.['metadata[transaction_hash]']
      if (!tx) return { status: 400, body: { error: { type: 'invalid_request_error' } } }
      const id = `pi_test_${nextId++}`
      intents.set(id, { id, form: request.form ?? {} })
      byTx.set(tx, id)
      return { status: 200, body: { id } }
    },
  }
  return { client, intents, byTx, requests }
}

describe('stripeAmountCents (#4853)', () => {
  it('converts a whole number of cents', () => {
    expect(stripeAmountCents(ATOMIC_PER_CENT)).toBe(1)
    expect(stripeAmountCents(10_000n)).toBe(1)
    expect(stripeAmountCents(20_000n)).toBe(2)
    expect(stripeAmountCents(1_000_000n)).toBe(100)
  })

  it('refuses a price below one cent', () => {
    expect(stripeAmountCents(0n)).toBeUndefined()
    expect(stripeAmountCents(500n)).toBeUndefined()
    expect(stripeAmountCents(9_999n)).toBeUndefined()
  })

  it('refuses a price that is not a whole number of cents', () => {
    expect(stripeAmountCents(15_000n)).toBeUndefined()
    expect(stripeAmountCents(10_001n)).toBeUndefined()
  })
})

describe('stripeApiVersionForChain (#4853)', () => {
  it('uses the sandbox version on Base Sepolia and the live one on Base', () => {
    expect(stripeApiVersionForChain(84532)).toBe(STRIPE_API_VERSION_SANDBOX)
    expect(stripeApiVersionForChain(8453)).toBe(STRIPE_API_VERSION_LIVE)
  })
})

describe('resolveStripeConfig (#4853)', () => {
  it('is off and silent with neither variable set', () => {
    const warn = vi.fn()
    expect(
      resolveStripeConfig({
        depositAddressRaw: undefined,
        secretKeyRaw: undefined,
        cdpConfigured: true,
        priceAtomic: 10_000n,
        warn,
      }),
    ).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('is off with a warning when only the deposit address is set', () => {
    const warn = vi.fn()
    expect(config({ secretKeyRaw: undefined, warn })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('STRIPE_DEPOSIT_ADDRESS')
    expect(warn.mock.calls[0]![0]).toContain('STRIPE_SECRET_KEY')
  })

  it('is off with a warning when only the secret key is set', () => {
    const warn = vi.fn()
    expect(config({ depositAddressRaw: undefined, warn })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('set BOTH')
  })

  it('is off with a warning when CDP is not configured', () => {
    const warn = vi.fn()
    expect(config({ cdpConfigured: false, warn })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('CDP')
  })

  it('is off with a warning when the price is below one cent', () => {
    const warn = vi.fn()
    expect(config({ priceAtomic: 500n, warn })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('whole number of cents')
  })

  it('is off with a warning when the price is not a whole number of cents', () => {
    const warn = vi.fn()
    expect(config({ priceAtomic: 15_000n, warn })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('whole number of cents')
  })

  it('is off with a warning when the deposit address is not an address', () => {
    const warn = vi.fn()
    expect(config({ depositAddressRaw: 'not-an-address', warn })).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('STRIPE_DEPOSIT_ADDRESS')
  })

  it('is on with both variables, CDP and a whole-cent price', () => {
    expect(config()).toEqual({
      depositAddress: DEPOSIT,
      secretKey: FAKE_KEY,
      apiVersion: STRIPE_API_VERSION_SANDBOX,
      network: STRIPE_NETWORK,
    })
  })

  it('never puts the secret in a warning', () => {
    const warn = vi.fn()
    config({ cdpConfigured: false, warn })
    config({ priceAtomic: 500n, warn })
    config({ depositAddressRaw: 'nope', warn })
    config({ secretKeyRaw: undefined, warn })
    for (const call of warn.mock.calls) expect(call[0]).not.toContain(FAKE_KEY)
  })

  it('skips the CDP check when the caller does not need CDP (the reconciliation script)', () => {
    expect(config({ cdpConfigured: false, requireCdp: false })).toBeDefined()
  })
})

describe('the previous deposit address (#4853, review S7)', () => {
  it('is carried when the operator names a different, valid address', () => {
    expect(config({ previousDepositAddressRaw: OLD_DEPOSIT })).toMatchObject({
      depositAddress: DEPOSIT,
      previousDepositAddress: OLD_DEPOSIT,
    })
  })

  it('is absent when it equals the current address', () => {
    expect(config({ previousDepositAddressRaw: DEPOSIT })).not.toHaveProperty('previousDepositAddress')
  })

  it('is ignored with a warning when it is not an address, and Stripe stays on', () => {
    const warn = vi.fn()
    const resolved = config({ previousDepositAddressRaw: 'not-an-address', warn })
    expect(resolved).toBeDefined()
    expect(resolved).not.toHaveProperty('previousDepositAddress')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('STRIPE_PREVIOUS_DEPOSIT_ADDRESS')
  })

  it('is absent when the operator names none', () => {
    expect(config()).not.toHaveProperty('previousDepositAddress')
  })
})

describe('encodeStripeForm (#4853)', () => {
  it('escapes keys and values', () => {
    expect(encodeStripeForm({ 'metadata[transaction_hash]': '0xab', amount: '1' })).toBe(
      'metadata%5Btransaction_hash%5D=0xab&amount=1',
    )
  })
})

describe('createStripeRecording (#4853)', () => {
  it('creates one PaymentIntent with the amount in cents and the transaction hash as idempotency key', async () => {
    const stripe = fakeStripe()
    const recording = createStripeRecording(config()!, { http: stripe.client, log: () => {} })

    const result = await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })

    expect(result).toEqual({ status: 'recorded', paymentIntentId: 'pi_test_1' })
    const create = stripe.requests.find((request) => request.method === 'POST')!
    expect(create.path).toBe('/v1/payment_intents')
    expect(create.apiVersion).toBe(STRIPE_API_VERSION_SANDBOX)
    expect(create.idempotencyKey).toBe(TX)
    expect(create.form).toMatchObject({
      amount: '1',
      currency: 'usd',
      confirm: 'true',
      'payment_method_data[type]': 'crypto',
      'allowed_payment_method_types[0]': 'crypto',
      'payment_method_options[crypto][mode]': 'transaction_verification',
      'payment_method_options[crypto][transaction_verification_options][network]': 'base',
      'payment_method_options[crypto][transaction_verification_options][transaction_hash]': TX,
      'metadata[transaction_hash]': TX,
      'metadata[product_id]': 'joke',
    })
  })

  it('decides "already recorded" by reading Stripe, not by the idempotency key', async () => {
    const stripe = fakeStripe()
    const recording = createStripeRecording(config()!, { http: stripe.client, log: () => {} })

    await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })
    const second = await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })

    expect(second).toEqual({ status: 'already_recorded', paymentIntentId: 'pi_test_1' })
    expect(stripe.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    expect(recording.stats()).toEqual({ attempted: 2, recorded: 1, alreadyRecorded: 1, failed: 0 })
  })

  it('records a different transaction separately', async () => {
    const stripe = fakeStripe()
    const recording = createStripeRecording(config()!, { http: stripe.client, log: () => {} })
    await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })
    const second = await recording.record({ txHash: TX2, amountAtomic: 10_000n, productId: 'joke' })
    expect(second).toEqual({ status: 'recorded', paymentIntentId: 'pi_test_2' })
  })

  it('logs a create failure as the hash plus Stripe type/code, never the key, and does not reject', async () => {
    const stripe = fakeStripe({ failCreate: true })
    const lines: string[] = []
    const recording = createStripeRecording(config()!, { http: stripe.client, log: (line) => lines.push(line) })

    const result = await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })

    expect(result).toEqual({ status: 'failed', reason: 'card_error/crypto_declined' })
    expect(lines).toEqual([`[stripe] record_failed tx=${TX} reason=card_error/crypto_declined`])
    for (const line of lines) expect(line).not.toContain(FAKE_KEY)
    expect(recording.stats()).toEqual({ attempted: 1, recorded: 0, alreadyRecorded: 0, failed: 1 })
  })

  it('logs a lookup failure the same way', async () => {
    const stripe = fakeStripe({ failSearch: true })
    const lines: string[] = []
    const recording = createStripeRecording(config()!, { http: stripe.client, log: (line) => lines.push(line) })

    const result = await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })

    expect(result).toEqual({ status: 'failed', reason: 'api_error' })
    expect(lines[0]).toBe(`[stripe] record_failed tx=${TX} reason=api_error`)
    expect(stripe.requests.some((request) => request.method === 'POST')).toBe(false)
  })

  it('gives up on a Stripe call that does not answer, and does not reject', async () => {
    const stripe = fakeStripe({ hang: true })
    const lines: string[] = []
    const recording = createStripeRecording(config()!, {
      http: stripe.client,
      log: (line) => lines.push(line),
      timeoutMs: 20,
    })

    const result = await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })

    expect(result).toEqual({ status: 'failed', reason: 'StripeTimeoutError' })
    expect(lines[0]).toBe(`[stripe] record_failed tx=${TX} reason=StripeTimeoutError`)
    expect(recording.stats().failed).toBe(1)
  })

  it('refuses to record an amount that is not a whole number of cents, without calling Stripe', async () => {
    const stripe = fakeStripe()
    const lines: string[] = []
    const recording = createStripeRecording(config()!, { http: stripe.client, log: (line) => lines.push(line) })

    const result = await recording.record({ txHash: TX, amountAtomic: 15_000n, productId: 'joke' })

    expect(result).toEqual({ status: 'failed', reason: 'amount_not_whole_cents' })
    expect(stripe.requests).toHaveLength(0)
    expect(lines[0]).toBe(`[stripe] record_failed tx=${TX} reason=amount_not_whole_cents`)
  })

  it('flush waits for every recording started so far', async () => {
    const stripe = fakeStripe()
    const recording = createStripeRecording(config()!, { http: stripe.client, log: () => {} })
    void recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })
    void recording.record({ txHash: TX2, amountAtomic: 10_000n, productId: 'joke' })
    await recording.flush()
    expect(recording.stats().recorded).toBe(2)
  })
})

describe('StripeApiError (#4853)', () => {
  it('keeps only the status, type and code — never the response body', () => {
    const error = new StripeApiError(402, 'card_error', 'crypto_declined')
    expect(error.message).toBe('Stripe answered 402 (card_error/crypto_declined)')
    expect(error.name).toBe('StripeApiError')
  })
})

describe('the deposit address is the recorded product’s receiving address (#4853)', () => {
  it('is used for the joke and for no other product', async () => {
    const { productReceivingAddress, PRODUCTS } = await import('./products.js')
    expect(productReceivingAddress(PRODUCTS.joke, MERCHANT, { stripeDepositAddress: DEPOSIT })).toBe(DEPOSIT)
    expect(productReceivingAddress(PRODUCTS.vpn_basic, MERCHANT, { stripeDepositAddress: DEPOSIT })).toBe(MERCHANT)
    expect(productReceivingAddress(PRODUCTS.vpn_legacy, MERCHANT, { stripeDepositAddress: DEPOSIT })).toBe(MERCHANT)
    expect(productReceivingAddress(PRODUCTS.storage_50gb, MERCHANT, { stripeDepositAddress: DEPOSIT })).toBe(MERCHANT)
  })

  it('falls back to MERCHANT_ADDRESS when Stripe is off', async () => {
    const { productReceivingAddress, PRODUCTS } = await import('./products.js')
    expect(productReceivingAddress(PRODUCTS.joke, MERCHANT)).toBe(MERCHANT)
    expect(productReceivingAddress(PRODUCTS.joke, MERCHANT, {})).toBe(MERCHANT)
  })
})

describe('each off condition warns and leaves the joke on MERCHANT_ADDRESS (#4853)', () => {
  const cases: Array<{ name: string; input: Partial<Parameters<typeof resolveStripeConfig>[0]> }> = [
    { name: 'only one Stripe variable set', input: { secretKeyRaw: undefined } },
    { name: 'CDP not configured', input: { cdpConfigured: false } },
    { name: 'price below one cent', input: { priceAtomic: 500n } },
    { name: 'price not a whole number of cents', input: { priceAtomic: 15_000n } },
  ]

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const warn = vi.fn()
      const resolved = config({ ...testCase.input, warn })
      expect(resolved).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      const { productReceivingAddress, PRODUCTS } = await import('./products.js')
      expect(
        productReceivingAddress(PRODUCTS.joke, MERCHANT, { stripeDepositAddress: resolved?.depositAddress }),
      ).toBe(MERCHANT)
    })
  }
})
