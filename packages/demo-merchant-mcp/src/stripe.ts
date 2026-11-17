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
 * 4. **Stripe's verdict, not the create call's (#4866).** Stripe verifies a
 *    `transaction_verification` PaymentIntent AFTER create returns: create
 *    answers `processing`, and Stripe later moves it to `succeeded` or
 *    declines it (`requires_payment_method`, `payment_method_provider_decline`
 *    in the #4854 sandbox run). Stripe also allows ONE PaymentIntent per
 *    transaction, permanently, so a declined recording can never be retried.
 *    The recorder therefore reads the PaymentIntent's status — on the search
 *    result, and after a create until a bound — and only a `succeeded` one
 *    counts as recorded.
 * 5. **The record carries the books (#4880).** The PaymentIntent carries a
 *    `description` (product name and receipt number) and the receipt's
 *    number, VAT treatment and VAT amount, plus the buyer's declared VAT
 *    number and country when the paid request carried an accepted
 *    declaration — so an accountant can work from the Stripe export alone.
 *    The reconciliation script has no request, so it records the description
 *    and the number only, and marks itself `recorded_by=reconciliation`.
 *
 * Vendor facts (docs.stripe.com/payments/machine/x402, re-read 2026-11-16):
 * the API version is `2026-05-27.preview` live and `2026-07-29.preview` in a
 * sandbox; the network name is `base` on both (a sandbox deposit address is a
 * Base Sepolia address, but the parameter stays `base`); the amount is in US
 * cents and Stripe's minimum is one cent.
 */
import { getAddress, isAddress, type Address, type Hex } from 'viem'
import { receiptNumberForTransaction, vatAmountsAtomic, type InvoiceJson } from './invoice.js'
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
    /**
     * #4866: on `resource_already_exists`, the PaymentIntent Stripe says is
     * already tracking the transaction. Extracted narrowly (a `pi_…` ID) from
     * the error message; the message itself is never kept.
     */
    readonly existingPaymentIntentId?: string,
  ) {
    super(`Stripe answered ${status} (${type}${code ? `/${code}` : ''})`)
    this.name = 'StripeApiError'
  }
}

/** A Stripe PaymentIntent ID, and nothing around it. */
const PAYMENT_INTENT_ID_RE = /\b(pi_[A-Za-z0-9]{8,64})\b/

function stripeError(response: StripeHttpResponse): StripeApiError {
  const error = (response.body as { error?: { type?: unknown; code?: unknown; message?: unknown } } | undefined)
    ?.error
  const type = typeof error?.type === 'string' ? error.type : 'unknown'
  const code = typeof error?.code === 'string' ? error.code : undefined
  // #4866: Stripe refuses a second PaymentIntent for a transaction with
  // `resource_already_exists` and names the one already tracking it. Keep only
  // that ID — the message is read here and dropped.
  const existing =
    code === 'resource_already_exists' && typeof error?.message === 'string'
      ? PAYMENT_INTENT_ID_RE.exec(error.message)?.[1]
      : undefined
  return new StripeApiError(response.status, type, code, existing)
}

// ── Stripe's verdict ────────────────────────────────────────────────────────

/** What Stripe decided about a PaymentIntent, as far as this merchant cares. */
export type StripeVerdict = 'succeeded' | 'pending' | 'declined'

export interface PaymentIntentState {
  id: string
  verdict: StripeVerdict
  /** `last_payment_error.code` on a declined one, when it names a safe code. */
  declineCode?: string
}

/** A decline code goes into a log line, so only Stripe's own code shape passes. */
function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value) ? value : undefined
}

/**
 * #4866: a PaymentIntent object reduced to the verdict.
 *
 * - `succeeded` — Stripe verified the transaction.
 * - `requires_payment_method` or `canceled` — declined. A
 *   `transaction_verification` PaymentIntent that Stripe could not verify
 *   lands in `requires_payment_method` with `last_payment_error` (#4854).
 * - anything else, a missing status included — not decided yet. Nothing
 *   counts as recorded without Stripe saying `succeeded`.
 */
export function paymentIntentState(body: unknown): PaymentIntentState | undefined {
  const intent = body as { id?: unknown; status?: unknown; last_payment_error?: { code?: unknown } } | undefined
  if (typeof intent?.id !== 'string') return undefined
  const status = intent.status
  if (status === 'succeeded') return { id: intent.id, verdict: 'succeeded' }
  if (status === 'requires_payment_method' || status === 'canceled') {
    const declineCode = safeCode(intent.last_payment_error?.code)
    return { id: intent.id, verdict: 'declined', ...(declineCode ? { declineCode } : {}) }
  }
  return { id: intent.id, verdict: 'pending' }
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
  /**
   * PaymentIntents this process created that Stripe accepted (`succeeded`).
   * #4866: until then it counted every create, including ones Stripe was
   * still verifying or later declined.
   */
  recorded: number
  /** Payments Stripe already had a succeeded PaymentIntent for. */
  alreadyRecorded: number
  /** #4866: PaymentIntents Stripe had not decided by the bound. */
  pending: number
  /** #4866: PaymentIntents Stripe declined — permanent for that transaction. */
  declined: number
  /** Calls that ended in an error, with no verdict. */
  failed: number
}

export type StripeRecordResult =
  /** Created by this call; Stripe accepted it. */
  | { status: 'recorded'; paymentIntentId: string }
  /** Stripe already had a succeeded PaymentIntent for the transaction. */
  | { status: 'already_recorded'; paymentIntentId: string }
  /** #4866: Stripe has not decided yet. `created` — this call made it. */
  | { status: 'pending'; paymentIntentId: string; created: boolean }
  /** #4866: Stripe declined it; a second PaymentIntent is impossible. */
  | { status: 'declined'; paymentIntentId: string; created: boolean; declineCode?: string }
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
  record(params: {
    txHash: Hex
    amountAtomic: bigint
    productId: ProductId
    /** #4880: description and receipt metadata. */
    details?: StripeRecordDetails
  }): Promise<StripeRecordResult>
  /** #4866: a log line for a payment deliberately not sent to Stripe. */
  noteNotRecorded(txHash: Hex, reason: string): void
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

/**
 * #4866: how long a recording waits (sleep time, not counting the reads) for
 * Stripe's verdict after a create. Each read is itself bounded by
 * `STRIPE_CALL_TIMEOUT_MS`, so the worst case is about 20 × (3 s + 10 s). The
 * #4854 sandbox decided within about 3 s (succeeded) and 30 s (declined); the
 * merchant sleeps after about 10 minutes, so the bound sits well under that.
 */
export const STRIPE_VERDICT_TIMEOUT_MS = 60_000
/** #4866: the interval between status reads while Stripe is still deciding. */
export const STRIPE_VERDICT_POLL_MS = 3_000

/**
 * #4880: what the PaymentIntent records besides the amount and the hash.
 * Every key but the description and the number is optional; an absent key is
 * not sent, never sent empty.
 */
export interface StripeRecordDetails {
  /** Product name and receipt number, as the Dashboard and exports show it. */
  description: string
  /** The receipt's `fakturanummer`. */
  receiptNumber: string
  /** The receipt's `momsbehandling`. The reconciliation script leaves it out. */
  vatTreatment?: InvoiceJson['momsbehandling']
  /** The receipt's VAT amount, in USDC base units. */
  vatAmountAtomic?: bigint
  /** The buyer's declared VAT number, from an accepted declaration only. */
  buyerVatNr?: string
  /** The buyer's declared country (ISO 3166-1 alpha-2), from an accepted declaration only. */
  buyerCountry?: string
  /** `reconciliation` when the reconciliation script recorded it. */
  recordedBy?: 'reconciliation'
}

/** Stripe's limit on one metadata value. */
export const STRIPE_METADATA_VALUE_MAX = 500

/**
 * #4880: the form fields `details` adds to the create call. Values are cut to
 * Stripe's 500-character limit, so an unexpected value can shorten a field
 * but never turn the whole recording into a refusal.
 */
export function stripeDetailsForm(details: StripeRecordDetails | undefined): Record<string, string> {
  if (!details) return {}
  const clip = (value: string) => value.slice(0, STRIPE_METADATA_VALUE_MAX)
  const form: Record<string, string> = {
    description: clip(details.description),
    'metadata[receipt_number]': clip(details.receiptNumber),
  }
  if (details.vatTreatment) form['metadata[vat_treatment]'] = details.vatTreatment
  if (details.vatAmountAtomic !== undefined) form['metadata[vat_amount]'] = `${details.vatAmountAtomic} (USDC atomic)`
  if (details.buyerVatNr) form['metadata[buyer_vat_nr]'] = clip(details.buyerVatNr)
  if (details.buyerCountry) form['metadata[buyer_country]'] = clip(details.buyerCountry)
  if (details.recordedBy) form['metadata[recorded_by]'] = details.recordedBy
  return form
}

/**
 * #4880: the shape of a VAT number Stripe may record: a two-letter prefix and
 * 2–13 letters or digits (the EU forms run from 8 to 12 characters after the
 * prefix). A shape, not a validity check.
 */
const VAT_NUMBER_SHAPE = /^[A-Z]{2}[A-Z0-9]{2,13}$/

/** #4880: the description both recorders send: product name and receipt number. */
export function stripeDescription(product: Pick<Product, 'name'>, receiptNumber: string): string {
  return `${product.name} — ${receiptNumber}`
}

/**
 * #4880: the record of a payment the merchant served, read off the receipt it
 * returned — the same number, treatment and VAT amount, and the buyer keys
 * only when the receipt carries an accepted declaration.
 */
export function stripeDetailsFromReceipt(
  product: Pick<Product, 'name' | 'price_usdc'>,
  receipt: InvoiceJson,
): StripeRecordDetails {
  const declaration = receipt.kopare.deklaration
  // #4880: the declaration's fields are what the payer signed, checked by
  // #4855 for presence, not shape. Only a two-letter country and a VAT-number
  // shape are recorded in Stripe; anything else is left out rather than sent.
  const buyerCountry = declaration && /^[A-Z]{2}$/.test(declaration.land) ? declaration.land : undefined
  const buyerVatNr = declaration && VAT_NUMBER_SHAPE.test(declaration.moms_nr) ? declaration.moms_nr : undefined
  return {
    description: stripeDescription(product, receipt.fakturanummer),
    receiptNumber: receipt.fakturanummer,
    vatTreatment: receipt.momsbehandling,
    vatAmountAtomic: vatAmountsAtomic(product.price_usdc, receipt.momsbehandling).vat,
    ...(buyerVatNr ? { buyerVatNr } : {}),
    ...(buyerCountry ? { buyerCountry } : {}),
  }
}

/**
 * #4880: the record the reconciliation script makes. It has the transaction
 * and nothing from the request, so no VAT treatment and no buyer: a
 * reverse-charge sale is never recorded as a 25% sale.
 */
export function stripeDetailsForReconciliation(
  product: Pick<Product, 'name'>,
  txHash: Hex,
): StripeRecordDetails {
  const receiptNumber = receiptNumberForTransaction(txHash)
  return { description: stripeDescription(product, receiptNumber), receiptNumber, recordedBy: 'reconciliation' }
}

export interface CreateStripeRecordingOptions {
  http?: StripeHttpClient
  /** Structured log sink. Defaults to `console.log`. */
  log?: (line: string) => void
  /** Upper bound on one Stripe call, ms. Default `STRIPE_CALL_TIMEOUT_MS`. */
  timeoutMs?: number
  /** #4866: how long to wait for the verdict after a create. Default `STRIPE_VERDICT_TIMEOUT_MS`. */
  verdictTimeoutMs?: number
  /** #4866: interval between status reads. Default `STRIPE_VERDICT_POLL_MS`. */
  verdictPollMs?: number
  /** Test seam for the wait between status reads. */
  sleep?: (ms: number) => Promise<void>
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
  const verdictTimeoutMs = options.verdictTimeoutMs ?? STRIPE_VERDICT_TIMEOUT_MS
  const verdictPollMs = options.verdictPollMs ?? STRIPE_VERDICT_POLL_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const stats: StripeRecordStats = {
    attempted: 0,
    recorded: 0,
    alreadyRecorded: 0,
    pending: 0,
    declined: 0,
    failed: 0,
  }
  const inFlight = new Set<Promise<unknown>>()

  /**
   * The PaymentIntent Stripe already holds for this transaction, if any, with
   * its verdict.
   *
   * A read, not the idempotency key: Stripe prunes keys after about 24 hours,
   * so the key cannot answer this a day later. The restricted key therefore
   * needs read access to PaymentIntents as well as create (see the README).
   * #4866: the search returns full PaymentIntent objects, so the status comes
   * with it — no second request.
   */
  async function findRecorded(txHash: Hex): Promise<PaymentIntentState | undefined> {
    const query = `metadata['${STRIPE_TX_HASH_METADATA_KEY}']:'${txHash.toLowerCase()}'`
    const response = await http.request({
      method: 'GET',
      path: `/v1/payment_intents/search?query=${encodeURIComponent(query)}&limit=1`,
      apiVersion: config.apiVersion,
      secretKey: config.secretKey,
    })
    if (response.status !== 200) throw stripeError(response)
    const data = (response.body as { data?: unknown[] } | undefined)?.data
    return Array.isArray(data) ? paymentIntentState(data[0]) : undefined
  }

  /** #4866: one PaymentIntent's current verdict. */
  async function readPaymentIntent(id: string): Promise<PaymentIntentState> {
    const response = await http.request({
      method: 'GET',
      path: `/v1/payment_intents/${encodeURIComponent(id)}`,
      apiVersion: config.apiVersion,
      secretKey: config.secretKey,
    })
    if (response.status !== 200) throw stripeError(response)
    const state = paymentIntentState(response.body)
    if (!state) throw new StripeApiError(response.status, 'malformed_response', undefined)
    return state
  }

  async function createPaymentIntent(params: {
    txHash: Hex
    cents: number
    productId: ProductId
    details?: StripeRecordDetails
  }): Promise<PaymentIntentState> {
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
        // #4880: description, receipt number, VAT and buyer keys.
        ...stripeDetailsForm(params.details),
      },
      // The epic's idempotency key. It closes the window between the lookup
      // above and this create; it is not what decides "already recorded".
      idempotencyKey: params.txHash,
    })
    if (response.status !== 200) throw stripeError(response)
    const state = paymentIntentState(response.body)
    if (!state) throw new StripeApiError(response.status, 'malformed_response', undefined)
    return state
  }

  /**
   * #4866: read a still-undecided PaymentIntent until Stripe decides or the
   * bound passes. A failed read ends the wait — the verdict stays `pending`,
   * and the reconciliation script reads it again later.
   */
  async function awaitVerdict(state: PaymentIntentState): Promise<PaymentIntentState> {
    let current = state
    let waited = 0
    while (current.verdict === 'pending' && waited < verdictTimeoutMs) {
      await sleep(verdictPollMs)
      waited += verdictPollMs
      try {
        current = await withTimeout(timeoutMs, () => readPaymentIntent(current.id))
      } catch {
        break
      }
    }
    return current
  }

  /** Count, log and shape a verdict. `created` — this call made the PaymentIntent. */
  function settle(txHash: Hex, state: PaymentIntentState, created: boolean): StripeRecordResult {
    if (state.verdict === 'succeeded') {
      if (created) {
        stats.recorded++
        log(`[stripe] recorded tx=${txHash} payment_intent=${state.id}`)
        return { status: 'recorded', paymentIntentId: state.id }
      }
      stats.alreadyRecorded++
      return { status: 'already_recorded', paymentIntentId: state.id }
    }
    if (state.verdict === 'declined') {
      stats.declined++
      log(
        `[stripe] record_declined tx=${txHash} payment_intent=${state.id}` +
          (state.declineCode ? ` code=${state.declineCode}` : ''),
      )
      return {
        status: 'declined',
        paymentIntentId: state.id,
        created,
        ...(state.declineCode ? { declineCode: state.declineCode } : {}),
      }
    }
    stats.pending++
    log(`[stripe] record_pending tx=${txHash} payment_intent=${state.id}`)
    return { status: 'pending', paymentIntentId: state.id, created }
  }

  async function recordOnce(params: {
    txHash: Hex
    amountAtomic: bigint
    productId: ProductId
    details?: StripeRecordDetails
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
      if (existing) return settle(params.txHash, await awaitVerdict(existing), false)
      let created: PaymentIntentState
      try {
        created = await withTimeout(timeoutMs, () => createPaymentIntent({ ...params, cents }))
      } catch (err) {
        // #4866: a PaymentIntent already tracks this transaction, but the
        // search missed it — its metadata does not name the hash, or Stripe's
        // search (eventually consistent) has not indexed it yet. Read the one
        // Stripe named instead of reporting an opaque failure.
        if (err instanceof StripeApiError && err.existingPaymentIntentId) {
          const id = err.existingPaymentIntentId
          const state = await withTimeout(timeoutMs, () => readPaymentIntent(id))
          return settle(params.txHash, await awaitVerdict(state), false)
        }
        // #4880: the idempotency key is the hash, but the parameters now
        // differ between recorders (the merchant sends VAT and buyer keys,
        // reconciliation does not; two requests can carry different
        // declarations). Within the key's ~24 h Stripe answers a repeat with
        // `idempotency_error` — meaning a create for this transaction already
        // happened, which the search missed (it is eventually consistent).
        // Search again rather than report a PaymentIntent that exists as a
        // failure.
        if (err instanceof StripeApiError && err.type === 'idempotency_error') {
          const found = await withTimeout(timeoutMs, () => findRecorded(params.txHash))
          if (found) return settle(params.txHash, await awaitVerdict(found), false)
        }
        throw err
      }
      log(`[stripe] submitted tx=${params.txHash} payment_intent=${created.id}`)
      return settle(params.txHash, await awaitVerdict(created), true)
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
    noteNotRecorded(txHash, reason) {
      log(`[stripe] not_recorded tx=${txHash} reason=${reason}`)
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
 * Which payments are sent is `stripeRecordingDecision`, shared with the
 * receipt (#4856) so the receipt says "pending in Stripe" exactly when a
 * record is sent.
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
 *
 * #4866: only a payment to the CURRENT deposit address is sent. A payment
 * recovered after an address change paid the previous address
 * (`STRIPE_PREVIOUS_DEPOSIT_ADDRESS`, served through
 * `recoverCdpPaymentAfterQuoteChange`); Stripe declines a transaction that did
 * not pay the deposit address (#4854), and the decline is permanent for that
 * transaction. It is logged as `[stripe] not_recorded … reason=paid_other_address`
 * instead.
 */
export function recordStripePayment(
  recording: StripeRecording | undefined,
  product: Product,
  payment: { productId: ProductId; settlement: string; txHash: Hex; value: bigint; to: Address },
  /** #4880: the receipt the merchant returned for this payment. */
  receipt?: InvoiceJson,
): void {
  const decision = stripeRecordingDecision(recording, product, payment)
  if (decision === 'none') return
  if (decision === 'paid_other_address') {
    recording!.noteNotRecorded(payment.txHash, 'paid_other_address')
    return
  }
  void recording!
    .record({
      txHash: payment.txHash,
      amountAtomic: payment.value,
      productId: payment.productId,
      ...(receipt ? { details: stripeDetailsFromReceipt(product, receipt) } : {}),
    })
    .catch(() => {})
}

/**
 * #4856: whether Stripe will record this payment — the one rule both the
 * recording (`recordStripePayment`) and the receipt read, so the receipt says
 * the Stripe reference is pending exactly when a record is sent.
 *
 * - `record`: Stripe is on, the product is Stripe-recorded, the payment
 *   settled on chain and paid the current deposit address.
 * - `paid_other_address`: as above, but it paid another address (#4866) — not
 *   sent, logged as `not_recorded`.
 * - `none`: anything else; nothing is sent.
 */
export function stripeRecordingDecision(
  recording: Pick<StripeRecording, 'depositAddress'> | undefined,
  product: Pick<Product, 'stripeRecording'>,
  payment: { settlement: string; to: Address },
): 'record' | 'paid_other_address' | 'none' {
  if (!recording) return 'none'
  if (!product.stripeRecording) return 'none'
  if (payment.settlement !== 'settled_onchain') return 'none'
  if (getAddress(payment.to) !== getAddress(recording.depositAddress)) return 'paid_other_address'
  return 'record'
}
