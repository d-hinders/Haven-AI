/**
 * The sale reporter (#4950; docs/architecture/12-merchant-kit.md §5): the one
 * implementation that builds a sale record and posts it to Haven's
 * `POST /merchant/sales` (#4897) with the merchant's Sales key.
 *
 * Two consumers: the demo merchant (#4950) and, with #4898, the paywall proxy. Like
 * the rest of this package it reads no environment variable: the Haven base
 * URL and the Sales key are arguments.
 *
 * Delivery (§5 *Delivery*): one record per payment, at-least-once. A 5xx, a
 * timeout or a network failure, and the route's one retry answer — 425
 * `transaction_not_visible` (the transaction has fewer than the confirmations
 * Haven needs) — are resent after 1 s, 4 s and 16 s, never sooner than the
 * answer's `Retry-After`. Any other 4xx is a refusal: logged once, never
 * resent. What happens after the last retry is the caller's (#4898 gives the
 * proxy an outbox; the demo merchant forgets).
 *
 * The Sales key is sent in the `Authorization` header and nowhere else: no log
 * line, no outcome and no error this module produces carries it.
 */
import type { Address, Hex } from 'viem'
import type { VatTreatment } from './tax-declaration.js'

/** The one sale-record version Haven reads (#4897). */
export const SALE_RECORD_VERSION = 1

/** §5: the VAT treatment a record may state — the receipt's own. */
export type SaleVatTreatment = VatTreatment

/**
 * The sale record (§5), as sent. Optional fields are absent, never `null`:
 * Haven's schema is closed and types each one.
 */
export interface SaleRecord {
  version: typeof SALE_RECORD_VERSION
  tx_hash: Hex
  chain: `eip155:${number}`
  product_id: string
  product_name?: string
  /** Whole atomic USDC units, as a decimal string. */
  amount: string
  payer: Address
  merchant_reference: string
  receipt_number?: string
  vat_treatment?: SaleVatTreatment
}

export interface SaleRecordInput {
  txHash: Hex
  chainId: number
  productId: string
  productName?: string
  /** Atomic USDC units: the product's price. */
  amount: bigint
  payer: Address
  merchantReference: string
  receiptNumber?: string
  vatTreatment?: SaleVatTreatment
}

/** Builds the §5 record. `tx_hash` is lower-case, as §5 states. */
export function buildSaleRecord(input: SaleRecordInput): SaleRecord {
  if (input.amount < 0n) throw new Error('A sale amount cannot be negative')
  return {
    version: SALE_RECORD_VERSION,
    tx_hash: input.txHash.toLowerCase() as Hex,
    chain: `eip155:${input.chainId}`,
    product_id: input.productId,
    ...(input.productName !== undefined ? { product_name: input.productName } : {}),
    amount: input.amount.toString(),
    payer: input.payer,
    merchant_reference: input.merchantReference,
    ...(input.receiptNumber !== undefined ? { receipt_number: input.receiptNumber } : {}),
    ...(input.vatTreatment !== undefined ? { vat_treatment: input.vatTreatment } : {}),
  }
}

/** §5 *Delivery*: the waits before the second, third and fourth attempt. */
export const SALE_REPORT_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 16_000]

/** One attempt's limit before it counts as a timeout and is retried. */
export const SALE_REPORT_ATTEMPT_TIMEOUT_MS = 10_000

/** A `Retry-After` longer than this is capped, so one answer cannot park a report. */
export const SALE_REPORT_MAX_RETRY_AFTER_MS = 60_000

/** The route's one retry answer (#4897). */
export const SALE_NOT_VISIBLE_STATUS = 425
export const SALE_NOT_VISIBLE_CODE = 'transaction_not_visible'

/** What became of one report. Carries no key; of the answer, only its status and error code. */
export type SaleReportOutcome =
  | { outcome: 'accepted'; status: number; attempts: number }
  | { outcome: 'refused'; status: number; code: string | null; attempts: number }
  | {
      outcome: 'gave_up'
      /** The last answer's status, or `null` when the last attempt got none. */
      status: number | null
      code: string | null
      attempts: number
    }

export type SaleReportEvent =
  | 'sales_report_accepted'
  | 'sales_report_retry'
  | 'sales_report_refused'
  | 'sales_report_gave_up'

export type SaleReportLogger = (event: SaleReportEvent, fields: Record<string, string | number | null>) => void

export interface ReportSaleOptions {
  /** Haven's API origin, e.g. `https://api.example`; a trailing slash is fine. */
  havenBaseUrl: string
  /** The merchant's Sales key (`sk_merchant_…`). Sent as the bearer token only. */
  salesKey: string
  record: SaleRecord
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  log?: SaleReportLogger
  retryDelaysMs?: readonly number[]
  attemptTimeoutMs?: number
}

/** The URL a record is posted to. */
export function saleReportUrl(havenBaseUrl: string): string {
  return `${havenBaseUrl.replace(/\/+$/, '')}/merchant/sales`
}

type Attempt =
  | { kind: 'answer'; status: number; code: string | null; retryAfterMs: number | null }
  | { kind: 'no_answer'; errorName: string }

async function attemptOnce(opts: ReportSaleOptions, doFetch: typeof fetch, timeoutMs: number): Promise<Attempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(saleReportUrl(opts.havenBaseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.salesKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(opts.record),
      signal: controller.signal,
    })
    let code: string | null = null
    let retryAfterSeconds: number | null = null
    if (response.status >= 400) {
      try {
        const body = (await response.json()) as Record<string, unknown>
        const raw = typeof body.error_code === 'string' ? body.error_code : typeof body.error === 'string' ? body.error : null
        // Haven's codes are short identifiers; anything else is not logged as one.
        if (raw !== null && /^[A-Za-z0-9_.-]{1,64}$/.test(raw)) code = raw
        if (typeof body.retry_after_seconds === 'number') retryAfterSeconds = body.retry_after_seconds
      } catch {
        // A body that is not JSON leaves the code unknown; the status decides.
      }
    }
    const header = Number(response.headers.get('retry-after'))
    if (Number.isFinite(header) && header > 0) retryAfterSeconds = header
    return {
      kind: 'answer',
      status: response.status,
      code,
      retryAfterMs: retryAfterSeconds !== null && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : null,
    }
  } catch (err) {
    // The error's class only: a transport error's message is not ours to print.
    const errorName = controller.signal.aborted ? 'Timeout' : err instanceof Error && err.name ? err.name : 'UnknownError'
    return { kind: 'no_answer', errorName }
  } finally {
    clearTimeout(timer)
  }
}

function isRetryable(attempt: Attempt): boolean {
  if (attempt.kind === 'no_answer') return true
  if (attempt.status >= 500) return true
  return attempt.status === SALE_NOT_VISIBLE_STATUS
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Posts one sale record, retrying per §5. Never throws: every end is an
 * outcome, and every outcome is logged once with the record's `tx_hash` and
 * `merchant_reference` (never the key).
 */
export async function reportSale(opts: ReportSaleOptions): Promise<SaleReportOutcome> {
  const doFetch = opts.fetch ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const log = opts.log ?? (() => {})
  const delays = opts.retryDelaysMs ?? SALE_REPORT_RETRY_DELAYS_MS
  const timeoutMs = opts.attemptTimeoutMs ?? SALE_REPORT_ATTEMPT_TIMEOUT_MS
  const ids = { tx_hash: opts.record.tx_hash, merchant_reference: opts.record.merchant_reference }

  let attempts = 0
  for (;;) {
    attempts += 1
    const attempt = await attemptOnce(opts, doFetch, timeoutMs)
    if (attempt.kind === 'answer' && attempt.status >= 200 && attempt.status < 300) {
      log('sales_report_accepted', { ...ids, status: attempt.status, attempts })
      return { outcome: 'accepted', status: attempt.status, attempts }
    }
    const status = attempt.kind === 'answer' ? attempt.status : null
    const code = attempt.kind === 'answer' ? attempt.code : null
    if (!isRetryable(attempt)) {
      log('sales_report_refused', { ...ids, status, code, attempts })
      return { outcome: 'refused', status: status as number, code, attempts }
    }
    const wait = delays[attempts - 1]
    if (wait === undefined) {
      log('sales_report_gave_up', {
        ...ids,
        status,
        code: attempt.kind === 'answer' ? code : attempt.errorName,
        attempts,
      })
      return { outcome: 'gave_up', status, code, attempts }
    }
    const retryAfter = attempt.kind === 'answer' ? attempt.retryAfterMs : null
    const delayMs = Math.max(wait, Math.min(retryAfter ?? 0, SALE_REPORT_MAX_RETRY_AFTER_MS))
    log('sales_report_retry', {
      ...ids,
      status,
      code: attempt.kind === 'answer' ? code : attempt.errorName,
      attempts,
      delay_ms: delayMs,
    })
    await sleep(delayMs)
  }
}
