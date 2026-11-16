/**
 * #4853: recording a settled joke payment in Stripe.
 *
 * The joke product is the one product Coinbase's hosted facilitator (CDP)
 * verifies and settles (#4851). In M2 its receiving address becomes a Stripe
 * deposit address, and each settled payment is recorded in Stripe as a
 * PaymentIntent in `transaction_verification` mode, keyed on the transaction
 * hash.
 *
 * Three rules shape this module:
 *
 * 1. **Recording never blocks delivery.** The payment has already settled by
 *    the time Stripe is called, so a Stripe failure — a refusal, a timeout, a
 *    network error — is logged and counted, never raised. `record()` does not
 *    reject.
 * 2. **No secret is logged.** The key goes into the `Authorization` header and
 *    nowhere else. A failure is logged as the transaction hash plus Stripe's
 *    own error `type`/`code`, never the response body or the request.
 * 3. **"Already recorded" is decided by reading Stripe, not by the idempotency
 *    key.** Stripe prunes idempotency keys after about 24 hours, so a key alone
 *    cannot answer "did this transaction get recorded?" a day later. The
 *    PaymentIntent carries the transaction hash in `metadata`, and the lookup
 *    searches for it. The idempotency key is still sent, as the epic requires:
 *    it closes the window between the lookup and the create.
 *
 * Vendor facts (docs.stripe.com/payments/machine/x402, re-read 2026-11-16):
 * the API version is `2026-05-27.preview` live and `2026-07-29.preview` in a
 * sandbox; the network name is `base` on both (a sandbox deposit address is a
 * Base Sepolia address, but the parameter stays `base`); the amount is in US
 * cents and Stripe's minimum is one cent.
 */
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { CHAIN_ID, type Product, type ProductId } from './products.js'

/** Stripe's network name for the deposit address and the PaymentIntent. */
export const STRIPE_NETWORK = 'base' as const

/** Live API version for the machine-payments preview. */
export const STRIPE_API_VERSION_LIVE = '2026-05-27.preview'
/** Sandbox API version — the dev merchant runs Base Sepolia. */
export const STRIPE_API_VERSION_SANDBOX = '2026-07-29.preview'

/** The API version follows the merchant's chain: a sandbox on Base Sepolia. */
export function stripeApiVersionForChain(chainId: number = CHAIN_ID): string {
  return chainId === 84532 ? STRIPE_API_VERSION_SANDBOX : STRIPE_API_VERSION_LIVE
}

/** USDC base units in one US cent (USDC has 6 decimals). */
export const ATOMIC_PER_CENT = 10_000n

/**
 * The PaymentIntent amount in cents, or `undefined` when the price cannot be
 * recorded at all: below one cent, or not a whole number of cents.
 *
 * Stripe's minimum is one cent, and its own sample rounds the atomic amount to
 * cents — so a price that is not a whole number of cents would be recorded for
 * an amount the buyer did not pay. The joke is 10,000 atomic (0.01 USDC, one
 * cent) precisely so this holds.
 */
export function stripeAmountCents(priceAtomic: bigint): number | undefined {
  if (priceAtomic < ATOMIC_PER_CENT) return undefined
  if (priceAtomic % ATOMIC_PER_CENT !== 0n) return undefined
  return Number(priceAtomic / ATOMIC_PER_CENT)
}

export interface StripeConfig {
  depositAddress: Address
  /**
   * #4853: the deposit address this one replaces, when the operator names it
   * (`STRIPE_PREVIOUS_DEPOSIT_ADDRESS`). A payment that already settled to it
   * is still served — the epic's invariant that a buyer whose money moved is
   * never refused. Without it, a settled retry after a change is refused.
   */
  previousDepositAddress?: Address
  /** Never logged, never returned, never put in a report. */
  secretKey: string
  apiVersion: string
  network: typeof STRIPE_NETWORK
}

export interface ResolveStripeConfigInput {
  depositAddressRaw: string | undefined
  secretKeyRaw: string | undefined
  /**
   * #4853: the deposit address being replaced, if the operator names it. A
   * payment that already settled to it is still served. Optional: without it,
   * a settled retry after a change is refused (the safe default — the payment's
   * own `payTo` is attacker-chosen and cannot be the test).
   */
  previousDepositAddressRaw?: string
  /** #4851: the joke product is offered only when CDP is configured. */
  cdpConfigured: boolean
  /**
   * Whether the CDP check applies. Default `true` — the merchant's startup
   * path. The reconciliation script runs inside the merchant's environment and
   * records what CDP already settled, so it does not need CDP itself and
   * passes `false`.
   */
  requireCdp?: boolean
  /** The price of the product Stripe records (the joke). */
  priceAtomic: bigint
  chainId?: number
  warn?: (message: string) => void
}

/**
 * Resolve the Stripe configuration from the environment's two values.
 *
 * Both are required together, and Stripe is off — with a warning, never a
 * refusal to start — when:
 * - only one of the two is set;
 * - CDP is not configured (the joke product is not offered at all, #4851);
 * - the product's price is below one cent or not a whole number of cents;
 * - the deposit address is not a 20-byte hex address.
 *
 * With neither value set, Stripe is simply off and nothing is said — the same
 * shape as the CDP credentials (#4851) and the passport check (#4723). Every
 * warning names the variables, never their values.
 */
export function resolveStripeConfig(input: ResolveStripeConfigInput): StripeConfig | undefined {
  const warn = input.warn ?? console.warn
  const depositAddressRaw = input.depositAddressRaw?.trim()
  const secretKeyRaw = input.secretKeyRaw?.trim()

  if (!depositAddressRaw && !secretKeyRaw) return undefined

  if (!depositAddressRaw || !secretKeyRaw) {
    warn(
      'Stripe recording is disabled: set BOTH STRIPE_DEPOSIT_ADDRESS and STRIPE_SECRET_KEY. ' +
        'The joke product keeps MERCHANT_ADDRESS until both are set; every other product is unaffected.',
    )
    return undefined
  }

  if ((input.requireCdp ?? true) && !input.cdpConfigured) {
    warn(
      'Stripe recording is disabled: Coinbase facilitator (CDP) settlement is not configured. ' +
        'The joke product is not offered; every other product is unaffected.',
    )
    return undefined
  }

  if (stripeAmountCents(input.priceAtomic) === undefined) {
    warn(
      `Stripe recording is disabled: the recorded product's price (${input.priceAtomic} atomic USDC) is not ` +
        'a whole number of cents of at least one cent. The joke product keeps MERCHANT_ADDRESS.',
    )
    return undefined
  }

  if (!isAddress(depositAddressRaw)) {
    warn(
      'STRIPE_DEPOSIT_ADDRESS is not a 0x-prefixed 20-byte address. Stripe recording is disabled; ' +
        'the joke product keeps MERCHANT_ADDRESS.',
    )
    return undefined
  }

  // #4853: the address being replaced, if the operator names it. A payment that
  // already settled to it is still served. A bad or identical value is ignored
  // with a warning — it must never take Stripe down.
  let previousDepositAddress: Address | undefined
  const previousRaw = input.previousDepositAddressRaw?.trim()
  if (previousRaw) {
    if (!isAddress(previousRaw)) {
      warn(
        'STRIPE_PREVIOUS_DEPOSIT_ADDRESS is not a 0x-prefixed 20-byte address. It is ignored; ' +
          'a payment that settled to it will be refused.',
      )
    } else if (getAddress(previousRaw) !== getAddress(depositAddressRaw)) {
      previousDepositAddress = getAddress(previousRaw)
    }
  }

  return {
    depositAddress: getAddress(depositAddressRaw),
    ...(previousDepositAddress ? { previousDepositAddress } : {}),
    secretKey: secretKeyRaw,
    apiVersion: stripeApiVersionForChain(input.chainId ?? CHAIN_ID),
    network: STRIPE_NETWORK,
  }
}

// ── Stripe HTTP ─────────────────────────────────────────────────────────────

export interface StripeHttpRequest {
  method: 'GET' | 'POST'
  /** Path plus query, e.g. `/v1/payment_intents`. */
  path: string
  apiVersion: string
  secretKey: string
  /** Already-bracketed form fields, e.g. `payment_method_data[type]`. */
  form?: Record<string, string>
  idempotencyKey?: string
}

export interface StripeHttpResponse {
  status: number
  body: unknown
}

/** The narrow slice of Stripe this merchant uses. Tests pass a fake. */
export interface StripeHttpClient {
  request(request: StripeHttpRequest): Promise<StripeHttpResponse>
}

/**
 * A Stripe refusal, reduced to what is safe to log: the HTTP status and
 * Stripe's own `type`/`code`. The response body is deliberately NOT kept — it
 * can echo the request, and the request carries the key in its header.
 */
export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string | undefined,
  ) {
    super(`Stripe answered ${status} (${type}${code ? `/${code}` : ''})`)
    this.name = 'StripeApiError'
  }
}

function stripeError(response: StripeHttpResponse): StripeApiError {
  const error = (response.body as { error?: { type?: unknown; code?: unknown } } | undefined)?.error
  const type = typeof error?.type === 'string' ? error.type : 'unknown'
  const code = typeof error?.code === 'string' ? error.code : undefined
  return new StripeApiError(response.status, type, code)
}

/** Stripe's form encoding: keys are already bracketed, values are escaped. */
export function encodeStripeForm(form: Record<string, string>): string {
  return Object.entries(form)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}

export function createStripeHttpClient(fetchImpl: typeof fetch = fetch): StripeHttpClient {
  return {
    async request(request) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${request.secretKey}`,
        'Stripe-Version': request.apiVersion,
      }
      let body: string | undefined
      if (request.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        body = encodeStripeForm(request.form)
      }
      if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey
      const response = await fetchImpl(`https://api.stripe.com${request.path}`, {
        method: request.method,
        headers,
        body,
      })
      const text = await response.text()
      let parsed: unknown
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {
        parsed = undefined
      }
      return { status: response.status, body: parsed }
    },
  }
}

// ── Recording ───────────────────────────────────────────────────────────────

export interface StripeRecordStats {
  /** Every `record()` call, whatever its outcome. */
  attempted: number
  /** PaymentIntents this process created. */
  recorded: number
  /** Payments Stripe already had a PaymentIntent for. */
  alreadyRecorded: number
  /** Calls that ended without a PaymentIntent. */
  failed: number
}

export type StripeRecordResult =
  | { status: 'recorded'; paymentIntentId: string }
  | { status: 'already_recorded'; paymentIntentId: string }
  | { status: 'failed'; reason: string }

export interface StripeRecording {
  depositAddress: Address
  /** #4853: the deposit address this one replaces, when the operator names it. */
  previousDepositAddress?: Address
  apiVersion: string
  network: typeof STRIPE_NETWORK
  /**
   * Record one settled payment. Never rejects: a Stripe failure is logged and
   * counted, and the goods are delivered regardless.
   */
  record(params: { txHash: Hex; amountAtomic: bigint; productId: ProductId }): Promise<StripeRecordResult>
  /** Resolves once every recording started so far has finished. Tests only. */
  flush(): Promise<void>
  stats(): StripeRecordStats
}

/** The merchant's own bound on a Stripe call. */
export const STRIPE_CALL_TIMEOUT_MS = 10_000

/** The merchant gave up waiting for Stripe. The outcome is unknown. */
export class StripeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Stripe did not answer within ${timeoutMs} ms`)
    this.name = 'StripeTimeoutError'
  }
}

async function withTimeout<T>(timeoutMs: number, call: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StripeTimeoutError(timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([call(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface CreateStripeRecordingOptions {
  http?: StripeHttpClient
  /** Structured log sink. Defaults to `console.log`. */
  log?: (line: string) => void
  /** Upper bound on one record (lookup + create), ms. Default `STRIPE_CALL_TIMEOUT_MS`. */
  timeoutMs?: number
}

/** The metadata key the transaction hash is stored under, and searched by. */
export const STRIPE_TX_HASH_METADATA_KEY = 'transaction_hash'

export function createStripeRecording(
  config: StripeConfig,
  options: CreateStripeRecordingOptions = {},
): StripeRecording {
  const http = options.http ?? createStripeHttpClient()
  const log = options.log ?? ((line: string) => console.log(line))
  const timeoutMs = options.timeoutMs ?? STRIPE_CALL_TIMEOUT_MS
  const stats: StripeRecordStats = { attempted: 0, recorded: 0, alreadyRecorded: 0, failed: 0 }
  const inFlight = new Set<Promise<unknown>>()

  /**
   * The PaymentIntent Stripe already holds for this transaction, if any.
   *
   * A read, not the idempotency key: Stripe prunes keys after about 24 hours,
   * so the key cannot answer this a day later. The restricted key therefore
   * needs read access to PaymentIntents as well as create (see the README).
   */
  async function findRecorded(txHash: Hex): Promise<string | undefined> {
    const query = `metadata['${STRIPE_TX_HASH_METADATA_KEY}']:'${txHash.toLowerCase()}'`
    const response = await http.request({
      method: 'GET',
      path: `/v1/payment_intents/search?query=${encodeURIComponent(query)}&limit=1`,
      apiVersion: config.apiVersion,
      secretKey: config.secretKey,
    })
    if (response.status !== 200) throw stripeError(response)
    const data = (response.body as { data?: Array<{ id?: unknown }> } | undefined)?.data
    const id = Array.isArray(data) ? data[0]?.id : undefined
    return typeof id === 'string' ? id : undefined
  }

  async function createPaymentIntent(params: {
    txHash: Hex
    cents: number
    productId: ProductId
  }): Promise<string> {
    const response = await http.request({
      method: 'POST',
      path: '/v1/payment_intents',
      apiVersion: config.apiVersion,
      secretKey: config.secretKey,
      // The epic's parameters, re-checked against Stripe's page on 2026-11-16.
      form: {
        amount: String(params.cents),
        currency: 'usd',
        confirm: 'true',
        'payment_method_data[type]': 'crypto',
        'allowed_payment_method_types[0]': 'crypto',
        'payment_method_options[crypto][mode]': 'transaction_verification',
        'payment_method_options[crypto][transaction_verification_options][network]': config.network,
        'payment_method_options[crypto][transaction_verification_options][transaction_hash]': params.txHash,
        [`metadata[${STRIPE_TX_HASH_METADATA_KEY}]`]: params.txHash.toLowerCase(),
        'metadata[product_id]': params.productId,
      },
      // The epic's idempotency key. It closes the window between the lookup
      // above and this create; it is not what decides "already recorded".
      idempotencyKey: params.txHash,
    })
    if (response.status !== 200) throw stripeError(response)
    const id = (response.body as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string') throw new StripeApiError(response.status, 'malformed_response', undefined)
    return id
  }

  async function recordOnce(params: {
    txHash: Hex
    amountAtomic: bigint
    productId: ProductId
  }): Promise<StripeRecordResult> {
    stats.attempted++
    const cents = stripeAmountCents(params.amountAtomic)
    if (cents === undefined) {
      stats.failed++
      log(`[stripe] record_failed tx=${params.txHash} reason=amount_not_whole_cents`)
      return { status: 'failed', reason: 'amount_not_whole_cents' }
    }
    try {
      const existing = await withTimeout(timeoutMs, () => findRecorded(params.txHash))
      if (existing) {
        stats.alreadyRecorded++
        return { status: 'already_recorded', paymentIntentId: existing }
      }
      const paymentIntentId = await withTimeout(timeoutMs, () =>
        createPaymentIntent({ ...params, cents }),
      )
      stats.recorded++
      log(`[stripe] recorded tx=${params.txHash} payment_intent=${paymentIntentId}`)
      return { status: 'recorded', paymentIntentId }
    } catch (err) {
      stats.failed++
      // The class and Stripe's own type/code only. Never the message: a Stripe
      // error body can echo the request, and the request carries the key.
      const reason =
        err instanceof StripeApiError
          ? `${err.type}${err.code ? `/${err.code}` : ''}`
          : err instanceof Error
            ? err.name
            : 'UnknownError'
      log(`[stripe] record_failed tx=${params.txHash} reason=${reason}`)
      return { status: 'failed', reason }
    }
  }

  return {
    depositAddress: config.depositAddress,
    ...(config.previousDepositAddress ? { previousDepositAddress: config.previousDepositAddress } : {}),
    apiVersion: config.apiVersion,
    network: config.network,
    record(params) {
      const promise = recordOnce(params)
      inFlight.add(promise)
      void promise.finally(() => inFlight.delete(promise))
      return promise
    },
    async flush() {
      while (inFlight.size > 0) await Promise.all([...inFlight])
    },
    stats() {
      return { ...stats }
    },
  }
}

/**
 * #4853: record a settled payment, if this product is the one Stripe records.
 *
 * Fire-and-forget on purpose. The payment has already settled, so the goods
 * are owed whatever Stripe answers; awaiting the call would put a third party
 * between the buyer and what they paid for. A failure is logged as
 * `[stripe] record_failed tx=<hash>` (the durable signal an operator greps
 * for) and counted in `/healthz`.
 *
 * A payment served through recovery without a transaction hash (#4851) has
 * nothing to key a PaymentIntent on, so nothing is recorded here — the
 * reconciliation script picks it up from the chain.
 */
export function recordStripePayment(
  recording: StripeRecording | undefined,
  product: Product,
  payment: { productId: ProductId; settlement: string; txHash: Hex; value: bigint },
): void {
  if (!recording) return
  if (!product.stripeRecording) return
  if (payment.settlement !== 'settled_onchain') return
  void recording
    .record({ txHash: payment.txHash, amountAtomic: payment.value, productId: payment.productId })
    .catch(() => {})
}
