/**
 * #4950: the demo merchant's Haven Sales account, and the report of each sale
 * of the product paid into it (`field_notes`, `salesAccount: true`).
 *
 * The record and the delivery are the shared core's (`buildSaleRecord`,
 * `reportSale` in `@haven_ai/merchant-payments`); this module decides only
 * what the demo merchant reports and holds what is in flight:
 *
 * - only the Sales product, only a payment `settled_onchain` (never the zero
 *   hash of `already_settled_earlier`), and once per transaction — a replayed
 *   payment header re-serves the same payment, and the dedupe drops it;
 * - fire-and-forget: `report` returns at once and never throws, so the buyer's
 *   answer and its timing do not depend on Haven;
 * - memory only, like the rest of the demo merchant's state: a restart forgets
 *   what was in flight and what was sent.
 *
 * The Sales key is passed to the core reporter and to nothing else. No log
 * line, `/healthz` block or error from here names it.
 */
import { getAddress, isAddress, type Address } from 'viem'
import {
  buildSaleRecord,
  reportSale,
  type SaleReportEvent,
  type SaleReportOutcome,
  type SaleRecord,
} from '@haven_ai/merchant-payments'
import type { InvoiceJson } from './invoice.js'
import type { Product } from './products.js'
import type { SettledPayment } from './x402.js'

export const MERCHANT_SALES_ADDRESS_ENV = 'MERCHANT_SALES_ADDRESS'
export const MERCHANT_SALES_KEY_ENV = 'MERCHANT_SALES_KEY'
/** The Sales key prefix (#4896); a value without it is not a Sales key. */
export const SALES_KEY_PREFIX = 'sk_merchant_'

export interface SalesConfig {
  /** The Haven Sales account the Sales product is paid into. */
  address: Address
  /** The Sales key. Handed to the core reporter only. */
  salesKey: string
  /** Haven's API origin (`MERCHANT_HAVEN_BASE_URL`), no trailing slash. */
  havenBaseUrl: string
}

export interface ResolveSalesConfigInput {
  addressRaw: string | undefined
  keyRaw: string | undefined
  havenBaseUrlRaw: string | undefined
  merchantAddress: Address
  /** The Stripe deposit addresses configured, current and previous. */
  stripeDepositAddresses?: ReadonlyArray<string | undefined>
  warn?: (message: string) => void
}

const OFF = 'The Haven Sales product is not offered; every other product is unaffected.'

/**
 * Reads the Sales settings. With either setting unset, or any of them unusable,
 * the Sales product is off — with a warning naming the variable, never its
 * value — and the merchant otherwise starts exactly as without them.
 */
export function resolveSalesConfig(input: ResolveSalesConfigInput): SalesConfig | undefined {
  const warn = input.warn ?? console.warn
  const addressRaw = input.addressRaw?.trim()
  const salesKey = input.keyRaw?.trim()
  if (!addressRaw || !salesKey) {
    if (addressRaw || salesKey) {
      warn(`Set BOTH ${MERCHANT_SALES_ADDRESS_ENV} and ${MERCHANT_SALES_KEY_ENV}. ${OFF}`)
    }
    return undefined
  }
  if (!isAddress(addressRaw, { strict: false }) || getAddress(addressRaw) !== addressRaw) {
    warn(`${MERCHANT_SALES_ADDRESS_ENV} is not a checksummed EVM address. ${OFF}`)
    return undefined
  }
  const address = addressRaw as Address
  if (address.toLowerCase() === input.merchantAddress.toLowerCase()) {
    warn(`${MERCHANT_SALES_ADDRESS_ENV} must not be MERCHANT_ADDRESS: the Sales account is its own account. ${OFF}`)
    return undefined
  }
  const stripe = (input.stripeDepositAddresses ?? []).map((a) => a?.trim().toLowerCase()).filter(Boolean)
  if (stripe.includes(address.toLowerCase())) {
    warn(`${MERCHANT_SALES_ADDRESS_ENV} must not be a Stripe deposit address. ${OFF}`)
    return undefined
  }
  if (!salesKey.startsWith(SALES_KEY_PREFIX)) {
    warn(`${MERCHANT_SALES_KEY_ENV} is not a Sales key (it must start with ${SALES_KEY_PREFIX}). ${OFF}`)
    return undefined
  }
  const baseRaw = input.havenBaseUrlRaw?.trim()
  if (!baseRaw) {
    warn(`The Haven Sales product reports each sale to MERCHANT_HAVEN_BASE_URL, which is unset. ${OFF}`)
    return undefined
  }
  let parsed: URL
  try {
    parsed = new URL(baseRaw)
  } catch {
    warn(`MERCHANT_HAVEN_BASE_URL is not a valid URL. ${OFF}`)
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    warn(`MERCHANT_HAVEN_BASE_URL must be http(s). ${OFF}`)
    return undefined
  }
  return { address, salesKey, havenBaseUrl: baseRaw.replace(/\/+$/, '') }
}

/**
 * The record for one settled sale. `receipt_number` and `vat_treatment` are
 * read off the receipt the merchant returned (`fakturanummer`,
 * `momsbehandling`), the same way `stripeDetailsFromReceipt` reads them.
 */
export function saleRecordFor(
  product: Pick<Product, 'id' | 'name' | 'price_usdc'>,
  payment: Pick<SettledPayment, 'txHash' | 'from' | 'merchantReference'>,
  receipt: Pick<InvoiceJson, 'fakturanummer' | 'momsbehandling'>,
  chainId: number,
): SaleRecord {
  return buildSaleRecord({
    txHash: payment.txHash,
    chainId,
    productId: product.id,
    productName: product.name,
    amount: product.price_usdc,
    payer: payment.from,
    merchantReference: payment.merchantReference,
    receiptNumber: receipt.fakturanummer,
    vatTreatment: receipt.momsbehandling,
  })
}

export interface SalesReportingStats {
  /** Reports sent and not yet ended. */
  pending: number
  /** Accepted by Haven (201, or 200 for an identical resend). */
  reported: number
  /** Refused by Haven: logged, never resent. */
  refused: number
  /** Still not accepted after the last retry. */
  gaveUp: number
}

export interface SalesReporting {
  /** The Sales account, the Sales product's receiving address. */
  address: Address
  /**
   * Reports a settled payment if it is a new on-chain sale of the Sales
   * product. Returns at once and never throws.
   */
  report(product: Product, payment: SettledPayment, receipt: InvoiceJson): void
  stats(): SalesReportingStats
  /** Resolves when every report in flight has ended (tests and shutdown). */
  idle(): Promise<void>
}

export interface SalesReportingDeps {
  chainId: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  retryDelaysMs?: readonly number[]
  attemptTimeoutMs?: number
  /** Where a log line goes; never handed the key. */
  log?: (line: string) => void
}

const LOG_PREFIX = '[sales]'

function renderLine(event: SaleReportEvent, fields: Record<string, string | number | null>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
  return `${LOG_PREFIX} ${event} ${parts.join(' ')}`
}

export function createSalesReporting(config: SalesConfig, deps: SalesReportingDeps): SalesReporting {
  const log = deps.log ?? ((line: string) => console.log(line))
  // Per-transaction dedupe: a hash is held from the first report onward, so a
  // replayed payment header never sends a second record.
  const seen = new Set<string>()
  const inFlight = new Set<Promise<void>>()
  const counts = { reported: 0, refused: 0, gaveUp: 0 }

  function tally(outcome: SaleReportOutcome): void {
    if (outcome.outcome === 'accepted') counts.reported += 1
    else if (outcome.outcome === 'refused') counts.refused += 1
    else counts.gaveUp += 1
  }

  function report(product: Product, payment: SettledPayment, receipt: InvoiceJson): void {
    try {
      if (!product.salesAccount || product.id !== payment.productId) return
      if (payment.settlement !== 'settled_onchain') return
      const key = payment.txHash.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      const record = saleRecordFor(product, payment, receipt, deps.chainId)
      const run = reportSale({
        havenBaseUrl: config.havenBaseUrl,
        salesKey: config.salesKey,
        record,
        fetch: deps.fetch,
        sleep: deps.sleep,
        retryDelaysMs: deps.retryDelaysMs,
        attemptTimeoutMs: deps.attemptTimeoutMs,
        log: (event, fields) => log(renderLine(event, fields)),
      })
        .then(tally)
        .catch((err: unknown) => {
          // `reportSale` never throws; this is a guard, and names the class only.
          counts.gaveUp += 1
          log(`${LOG_PREFIX} sales_report_gave_up tx_hash=${key} error=${err instanceof Error ? err.name : 'UnknownError'}`)
        })
        .finally(() => {
          inFlight.delete(run)
        })
      inFlight.add(run)
    } catch (err) {
      // A report is never a reason to fail a purchase that has settled.
      log(`${LOG_PREFIX} sales_report_skipped error=${err instanceof Error ? err.name : 'UnknownError'}`)
    }
  }

  return {
    address: config.address,
    report,
    stats: () => ({ pending: inFlight.size, ...counts }),
    idle: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    },
  }
}
