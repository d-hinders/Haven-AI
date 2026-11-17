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
  paymentIntentState,
  resolveStripeConfig,
  stripeAmountCents,
  stripeApiVersionForChain,
  stripeDetailsForReconciliation,
  stripeDetailsForm,
  stripeDetailsFromReceipt,
  STRIPE_METADATA_VALUE_MAX,
  type StripeHttpClient,
  type StripeHttpRequest,
} from './stripe.js'
import { generateInvoice, receiptNumberForTransaction } from './invoice.js'
import { PRODUCTS } from './products.js'

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

/** Stripe's idempotency-key retention: about 24 hours, then the key is pruned. */
const IDEMPOTENCY_KEY_RETENTION_MS = 24 * 60 * 60 * 1000

/**
 * An in-memory Stripe: search by metadata, create with an idempotency key.
 *
 * The key store models Stripe's ~24h retention (review S5): a repeated key
 * inside the window returns the SAME PaymentIntent, and after it the key is
 * forgotten, so the same key would create a new one. `advanceClock` moves the
 * fake's clock, as a day passing would.
 */
function fakeStripe(opts: { failCreate?: boolean; failSearch?: boolean; hang?: boolean } = {}) {
  const intents = new Map<string, { id: string; form: Record<string, string> }>()
  const byTx = new Map<string, string>()
  const requests: StripeHttpRequest[] = []
  const idempotencyKeys = new Map<string, { id: string; at: number }>()
  let now = Date.now()
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
        return { status: 200, body: { data: id ? [{ id, status: 'succeeded' }] : [] } }
      }
      if (opts.failCreate) {
        return { status: 402, body: { error: { type: 'card_error', code: 'crypto_declined' } } }
      }
      const tx = request.form?.['metadata[transaction_hash]']
      if (!tx) return { status: 400, body: { error: { type: 'invalid_request_error' } } }
      const key = request.idempotencyKey
      if (key) {
        const held = idempotencyKeys.get(key)
        if (held && now - held.at < IDEMPOTENCY_KEY_RETENTION_MS) {
          return { status: 200, body: { id: held.id, status: 'succeeded' } }
        }
        // Stripe prunes the key after ~24h: it no longer answers for the create.
        if (held) idempotencyKeys.delete(key)
      }
      const id = `pi_test_${nextId++}`
      intents.set(id, { id, form: request.form ?? {} })
      byTx.set(tx, id)
      if (key) idempotencyKeys.set(key, { id, at: now })
      return { status: 200, body: { id, status: 'succeeded' } }
    },
  }
  return {
    client,
    intents,
    byTx,
    requests,
    idempotencyKeys,
    /** Move the fake's clock forward, as a day passing would. */
    advanceClock(ms: number) {
      now += ms
    },
  }
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

describe('the Stripe fake models idempotency-key retention (#4853, review S5)', () => {
  const create = (stripe: ReturnType<typeof fakeStripe>, key: string) =>
    stripe.client.request({
      method: 'POST',
      path: '/v1/payment_intents',
      apiVersion: STRIPE_API_VERSION_SANDBOX,
      secretKey: FAKE_KEY,
      form: { 'metadata[transaction_hash]': TX },
      idempotencyKey: key,
    })

  it('returns the same PaymentIntent for a repeated key inside 24 hours', async () => {
    const stripe = fakeStripe()
    const first = await create(stripe, TX)
    stripe.advanceClock(23 * 60 * 60 * 1000)
    const second = await create(stripe, TX)
    expect(second.body).toEqual(first.body)
    expect(stripe.intents.size).toBe(1)
  })

  it('forgets the key after 24 hours: the same key creates a new PaymentIntent', async () => {
    const stripe = fakeStripe()
    const first = await create(stripe, TX)
    stripe.advanceClock(25 * 60 * 60 * 1000)
    const second = await create(stripe, TX)
    expect(second.body).not.toEqual(first.body)
    expect(stripe.intents.size).toBe(2)
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
    expect(recording.stats()).toEqual({ attempted: 2, recorded: 1, alreadyRecorded: 1, pending: 0, declined: 0, failed: 0 })
  })

  it('records nothing a day later, when Stripe has forgotten the idempotency key (#4853, review S5)', async () => {
    const stripe = fakeStripe()
    const recording = createStripeRecording(config()!, { http: stripe.client, log: () => {} })

    const first = await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })
    expect(first).toEqual({ status: 'recorded', paymentIntentId: 'pi_test_1' })

    // Stripe prunes idempotency keys after about 24 hours. A key-only
    // implementation would create a second PaymentIntent here; the metadata
    // search — not the key — is what prevents the duplicate.
    stripe.advanceClock(25 * 60 * 60 * 1000)

    const second = await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })
    expect(second).toEqual({ status: 'already_recorded', paymentIntentId: 'pi_test_1' })
    expect(stripe.intents.size).toBe(1)
    expect(stripe.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    expect(recording.stats()).toEqual({ attempted: 2, recorded: 1, alreadyRecorded: 1, pending: 0, declined: 0, failed: 0 })
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
    expect(recording.stats()).toEqual({ attempted: 1, recorded: 0, alreadyRecorded: 0, pending: 0, declined: 0, failed: 1 })
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

describe('each off condition that leaves the joke offered warns and keeps MERCHANT_ADDRESS (#4853)', () => {
  // Review S4: with CDP not configured the joke is ABSENT, not on
  // MERCHANT_ADDRESS — that case is covered by the HTTP test in
  // stripe-recording.test.ts. Only the conditions that leave the product
  // offered belong in this table.
  const cases: Array<{ name: string; input: Partial<Parameters<typeof resolveStripeConfig>[0]> }> = [
    { name: 'only one Stripe variable set', input: { secretKeyRaw: undefined } },
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

/**
 * #4866: Stripe verifies a `transaction_verification` PaymentIntent AFTER the
 * create returns. These model what the #4854 sandbox run showed: create
 * answers 200 `processing`; Stripe later moves it to `succeeded`, or declines
 * it (`requires_payment_method` with `last_payment_error.code`
 * `payment_method_provider_decline`) — and refuses a second PaymentIntent for
 * the same transaction with `resource_already_exists`, naming the one that
 * tracks it.
 */
function verdictStripe(opts: {
  /** Statuses the PaymentIntent reports, in order: on create, then on each read. */
  statuses?: string[]
  /** What the search finds for the transaction. */
  searchHit?: { id: string; status: string; code?: string }
  /** Create refused as Stripe refuses a duplicate, naming this PaymentIntent. */
  alreadyExists?: { id: string; status: string }
} = {}) {
  const requests: StripeHttpRequest[] = []
  const statuses = [...(opts.statuses ?? ['succeeded'])]
  let current = statuses[0]!
  const intent = (id: string, status: string) =>
    status === 'requires_payment_method'
      ? { id, status, last_payment_error: { code: 'payment_method_provider_decline', message: 'The payment has invalid information.' } }
      : { id, status }
  const client: StripeHttpClient = {
    async request(request) {
      requests.push(request)
      if (request.method === 'GET' && request.path.startsWith('/v1/payment_intents/search')) {
        const hit = opts.searchHit
        return { status: 200, body: { data: hit ? [intent(hit.id, hit.status)] : [] } }
      }
      if (request.method === 'GET') {
        const id = decodeURIComponent(request.path.split('/').pop()!)
        if (opts.alreadyExists && id === opts.alreadyExists.id) return { status: 200, body: intent(id, opts.alreadyExists.status) }
        statuses.shift()
        current = statuses[0] ?? current
        return { status: 200, body: intent(id, current) }
      }
      if (opts.alreadyExists) {
        return {
          status: 400,
          body: {
            error: {
              type: 'invalid_request_error',
              code: 'resource_already_exists',
              param: 'payment_method_options[crypto][transaction_verification_options]',
              message: `Another PaymentIntent already exists for these transaction_verification_options. PaymentIntent \`${opts.alreadyExists.id}\` is already tracking this transaction.`,
            },
          },
        }
      }
      return { status: 200, body: intent('pi_verdict_1', current) }
    },
  }
  return { client, requests }
}

function verdictRecording(stripe: ReturnType<typeof verdictStripe>, lines: string[] = []) {
  return createStripeRecording(config()!, {
    http: stripe.client,
    log: (line) => lines.push(line),
    sleep: async () => {},
    verdictPollMs: 1_000,
    verdictTimeoutMs: 5_000,
  })
}

describe('the recorder reports Stripe’s verdict, not the create call’s (#4866)', () => {
  it('a PaymentIntent Stripe declines after create is reported declined, never recorded', async () => {
    const stripe = verdictStripe({ statuses: ['processing', 'processing', 'requires_payment_method'] })
    const lines: string[] = []
    const recording = verdictRecording(stripe, lines)

    const result = await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })

    expect(result).toEqual({
      status: 'declined',
      paymentIntentId: 'pi_verdict_1',
      created: true,
      declineCode: 'payment_method_provider_decline',
    })
    expect(recording.stats()).toMatchObject({ recorded: 0, declined: 1, pending: 0, failed: 0 })
    expect(lines).toEqual([
      `[stripe] submitted tx=${TX} payment_intent=pi_verdict_1`,
      `[stripe] record_declined tx=${TX} payment_intent=pi_verdict_1 code=payment_method_provider_decline`,
    ])
    // Stripe's message never reaches the log.
    for (const line of lines) expect(line).not.toContain('invalid information')
  })

  it('processing then succeeded is recorded, and only then', async () => {
    const stripe = verdictStripe({ statuses: ['processing', 'succeeded'] })
    const lines: string[] = []
    const recording = verdictRecording(stripe, lines)

    expect(await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })).toEqual({
      status: 'recorded',
      paymentIntentId: 'pi_verdict_1',
    })
    expect(lines).toEqual([
      `[stripe] submitted tx=${TX} payment_intent=pi_verdict_1`,
      `[stripe] recorded tx=${TX} payment_intent=pi_verdict_1`,
    ])
    expect(recording.stats()).toMatchObject({ recorded: 1, declined: 0, pending: 0 })
  })

  it('still processing at the bound: pending, not recorded', async () => {
    const stripe = verdictStripe({ statuses: Array(20).fill('processing') })
    const lines: string[] = []
    const recording = verdictRecording(stripe, lines)

    expect(await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })).toEqual({
      status: 'pending',
      paymentIntentId: 'pi_verdict_1',
      created: true,
    })
    // 5 s bound at 1 s intervals: five reads after the create, then it stops.
    expect(stripe.requests.filter((request) => request.path === '/v1/payment_intents/pi_verdict_1')).toHaveLength(5)
    expect(lines.at(-1)).toBe(`[stripe] record_pending tx=${TX} payment_intent=pi_verdict_1`)
    expect(recording.stats()).toMatchObject({ recorded: 0, pending: 1 })
  })

  it('a failed status read ends the wait: pending, never recorded, and the recording does not reject', async () => {
    const requests: StripeHttpRequest[] = []
    const client: StripeHttpClient = {
      async request(request) {
        requests.push(request)
        if (request.path.startsWith('/v1/payment_intents/search')) return { status: 200, body: { data: [] } }
        if (request.method === 'GET') return { status: 500, body: { error: { type: 'api_error' } } }
        return { status: 200, body: { id: 'pi_3ReadFails0001', status: 'processing' } }
      },
    }
    const recording = createStripeRecording(config()!, {
      http: client,
      log: () => {},
      sleep: async () => {},
      verdictPollMs: 1_000,
      verdictTimeoutMs: 5_000,
    })
    expect(await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })).toEqual({
      status: 'pending',
      paymentIntentId: 'pi_3ReadFails0001',
      created: true,
    })
    // One failed read, then it stops asking.
    expect(requests.filter((request) => request.path === '/v1/payment_intents/pi_3ReadFails0001')).toHaveLength(1)
    expect(recording.stats()).toMatchObject({ recorded: 0, pending: 1, failed: 0 })
  })

  it('a declined PaymentIntent the search finds is reported declined, and nothing is created', async () => {
    const stripe = verdictStripe({ searchHit: { id: 'pi_old_declined', status: 'requires_payment_method' } })
    const recording = verdictRecording(stripe)

    expect(await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })).toEqual({
      status: 'declined',
      paymentIntentId: 'pi_old_declined',
      created: false,
      declineCode: 'payment_method_provider_decline',
    })
    expect(stripe.requests.filter((request) => request.method === 'POST')).toHaveLength(0)
  })

  it('resource_already_exists: reads the PaymentIntent Stripe names instead of failing opaquely', async () => {
    const stripe = verdictStripe({ alreadyExists: { id: 'pi_3TracksItAlready9', status: 'succeeded' } })
    const lines: string[] = []
    const recording = verdictRecording(stripe, lines)

    expect(await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })).toEqual({
      status: 'already_recorded',
      paymentIntentId: 'pi_3TracksItAlready9',
    })
    expect(stripe.requests.at(-1)!.path).toBe('/v1/payment_intents/pi_3TracksItAlready9')
    for (const line of lines) expect(line).not.toContain('Another PaymentIntent')
  })
})

describe('paymentIntentState (#4866)', () => {
  it('maps Stripe statuses to a verdict', () => {
    expect(paymentIntentState({ id: 'pi_a', status: 'succeeded' })).toEqual({ id: 'pi_a', verdict: 'succeeded' })
    expect(paymentIntentState({ id: 'pi_a', status: 'processing' })).toEqual({ id: 'pi_a', verdict: 'pending' })
    expect(paymentIntentState({ id: 'pi_a' })).toEqual({ id: 'pi_a', verdict: 'pending' })
    expect(paymentIntentState({ id: 'pi_a', status: 'canceled' })).toEqual({ id: 'pi_a', verdict: 'declined' })
    expect(
      paymentIntentState({ id: 'pi_a', status: 'requires_payment_method', last_payment_error: { code: 'payment_method_provider_decline' } }),
    ).toEqual({ id: 'pi_a', verdict: 'declined', declineCode: 'payment_method_provider_decline' })
    expect(paymentIntentState({ status: 'succeeded' })).toBeUndefined()
  })

  it('never passes an unsafe decline code into a log line', () => {
    expect(
      paymentIntentState({ id: 'pi_a', status: 'requires_payment_method', last_payment_error: { code: 'x y\nz' } }),
    ).toEqual({ id: 'pi_a', verdict: 'declined' })
  })

  it('StripeApiError keeps only the PaymentIntent a resource_already_exists names', () => {
    const error = new StripeApiError(400, 'invalid_request_error', 'resource_already_exists', 'pi_abcdefgh12')
    expect(error.existingPaymentIntentId).toBe('pi_abcdefgh12')
    expect(error.message).toBe('Stripe answered 400 (invalid_request_error/resource_already_exists)')
  })
})

// #4880: the record carries the description, the receipt number, the VAT and,
// from an accepted declaration only, the buyer — the form fields sent.
describe('the PaymentIntent carries the receipt (#4880)', () => {
  const receipt = (taxDeclaration: Parameters<typeof generateInvoice>[0]['taxDeclaration'] = null) =>
    generateInvoice({
      invoiceNumber: receiptNumberForTransaction(TX),
      productId: 'joke',
      buyerAddress: '0x5555555555555555555555555555555555555555',
      payerRole: 'agent_delegate',
      receivingAddress: DEPOSIT,
      authorizationNonce: `0x${'01'.repeat(32)}`,
      txHash: TX,
      settlement: 'settled_onchain',
      taxDeclaration,
    }).json
  const DE = { jurisdiction: 'DE', taxId: 'DE123456789', taxableStatus: 'TAXABLE_PERSON', validUntil: Date.parse('2027-06-30T00:00:00Z') }
  const SE = { ...DE, jurisdiction: 'SE', taxId: 'SE559412345601' }

  async function formSent(details: Parameters<ReturnType<typeof createStripeRecording>['record']>[0]['details']) {
    const stripe = fakeStripe()
    const recording = createStripeRecording(config()!, { http: stripe.client, log: () => {} })
    await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke', details })
    return stripe.requests.find((request) => request.method === 'POST')!.form!
  }

  it('without a declaration: description, number, SE_25 and its VAT in atomic USDC — and no buyer keys at all', async () => {
    const form = await formSent(stripeDetailsFromReceipt(PRODUCTS.joke, receipt()))
    const number = receiptNumberForTransaction(TX)
    expect(form).toMatchObject({
      description: `Haven Joke — ${number}`,
      'metadata[receipt_number]': number,
      'metadata[vat_treatment]': 'SE_25',
      'metadata[vat_amount]': '2000 (USDC atomic)',
      'metadata[transaction_hash]': TX,
      'metadata[product_id]': 'joke',
    })
    expect(Object.keys(form).filter((key) => /buyer|recorded_by/.test(key))).toEqual([])
  })

  it('with a declaration from another EU country: REVERSE_CHARGE, zero VAT, and the buyer’s VAT number and country', async () => {
    const form = await formSent(stripeDetailsFromReceipt(PRODUCTS.joke, receipt(DE)))
    expect(form).toMatchObject({
      'metadata[vat_treatment]': 'REVERSE_CHARGE',
      'metadata[vat_amount]': '0 (USDC atomic)',
      'metadata[buyer_vat_nr]': 'DE123456789',
      'metadata[buyer_country]': 'DE',
    })
  })

  it('with a Swedish declaration: SE_25 and the buyer keys', async () => {
    const form = await formSent(stripeDetailsFromReceipt(PRODUCTS.joke, receipt(SE)))
    expect(form).toMatchObject({
      'metadata[vat_treatment]': 'SE_25',
      'metadata[vat_amount]': '2000 (USDC atomic)',
      'metadata[buyer_vat_nr]': 'SE559412345601',
      'metadata[buyer_country]': 'SE',
    })
  })

  it('from reconciliation: the same description and number, recorded_by, and no VAT or buyer keys', async () => {
    const form = await formSent(stripeDetailsForReconciliation(PRODUCTS.joke, TX))
    const fromReceipt = stripeDetailsForm(stripeDetailsFromReceipt(PRODUCTS.joke, receipt()))
    expect(form.description).toBe(fromReceipt.description)
    expect(form['metadata[receipt_number]']).toBe(fromReceipt['metadata[receipt_number]'])
    expect(form['metadata[recorded_by]']).toBe('reconciliation')
    expect(Object.keys(form).filter((key) => /vat|buyer/.test(key))).toEqual([])
  })

  it('stays inside Stripe’s limits: at most 50 keys, names up to 40 characters, values up to 500', async () => {
    const form = await formSent({
      ...stripeDetailsFromReceipt(PRODUCTS.joke, receipt(DE)),
      buyerVatNr: 'X'.repeat(900),
      description: 'D'.repeat(900),
    })
    const metadata = Object.keys(form).filter((key) => key.startsWith('metadata['))
    expect(metadata.length).toBeLessThanOrEqual(50)
    for (const key of metadata) expect(key.slice('metadata['.length, -1).length).toBeLessThanOrEqual(40)
    expect(form['metadata[buyer_vat_nr]']).toHaveLength(STRIPE_METADATA_VALUE_MAX)
    expect(form.description).toHaveLength(STRIPE_METADATA_VALUE_MAX)
  })

  it('leaves out a declared country or VAT number that does not have the shape of one', async () => {
    const odd = { ...DE, jurisdiction: 'Germany', taxId: 'call me <script>' }
    const form = await formSent(stripeDetailsFromReceipt(PRODUCTS.joke, receipt(odd)))
    expect(Object.keys(form).filter((key) => /buyer/.test(key))).toEqual([])
    // ...while a well-formed one is kept (the shape check can say yes).
    const kept = await formSent(stripeDetailsFromReceipt(PRODUCTS.joke, receipt(DE)))
    expect(kept['metadata[buyer_vat_nr]']).toBe('DE123456789')
  })

  it('an idempotency_error is a create that already happened: the recorder searches again instead of failing', async () => {
    let searches = 0
    const http: StripeHttpClient = {
      async request(request) {
        if (request.method === 'GET') {
          searches++
          // Stripe's search is eventually consistent: the first read misses it.
          return { status: 200, body: { data: searches > 1 ? [{ id: 'pi_3IdemAlready01', status: 'succeeded' }] : [] } }
        }
        return { status: 400, body: { error: { type: 'idempotency_error' } } }
      },
    }
    const recording = createStripeRecording(config()!, { http, log: () => {} })
    const result = await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke', details: stripeDetailsForReconciliation(PRODUCTS.joke, TX) })
    expect(result).toEqual({ status: 'already_recorded', paymentIntentId: 'pi_3IdemAlready01' })
    expect(recording.stats().failed).toBe(0)
  })

  it('an idempotency_error the second search cannot explain is still a failure', async () => {
    const http: StripeHttpClient = {
      async request(request) {
        if (request.method === 'GET') return { status: 200, body: { data: [] } }
        return { status: 400, body: { error: { type: 'idempotency_error' } } }
      },
    }
    const recording = createStripeRecording(config()!, { http, log: () => {} })
    const result = await recording.record({ txHash: TX, amountAtomic: 10_000n, productId: 'joke' })
    expect(result).toEqual({ status: 'failed', reason: 'idempotency_error' })
  })

  it('sends nothing new when the caller passes no details', async () => {
    const form = await formSent(undefined)
    expect(Object.keys(form).filter((key) => /description|receipt|vat|buyer|recorded_by/.test(key))).toEqual([])
  })
})
