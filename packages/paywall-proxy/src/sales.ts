/**
 * The proxy's sales reporting (#4898; docs/architecture/12-merchant-kit.md §5,
 * §12): after a call is settled, one sale record is sent to Haven's
 * `POST /merchant/sales` (#4897) with the merchant's Sales key.
 *
 * The record builder and the sender are the shared core's (`buildSaleRecord`,
 * `reportSale` in `@haven_ai/merchant-payments`, #4950) — this module is the
 * proxy's consumer of them and decides only what the proxy adds:
 *
 * - **one record per payment**, built from the consumed-payment store's record
 *   (the settlement's transaction hash, the product, the payer, the amount and
 *   the `merchantReference` the store reserved for the payment) and from the
 *   receipt the buyer got, when the deployment issues one;
 * - **fire-and-forget**: `report` returns at once and never throws, so the
 *   buyer's answer and its timing do not depend on Haven — accepted, refused,
 *   slow or unreachable;
 * - **the outbox** (`sales-outbox.ts`): a record the core reporter gave up on,
 *   or one Haven answered 429 to, is queued for a later resend; any other 4xx is
 *   a refusal, logged once by the core reporter and never resent;
 * - **`saleReported`** in the store is set when Haven accepts, so a payment is
 *   never reported twice.
 *
 * The Sales key is handed to the core reporter and to nothing else. No log line,
 * outcome or error from here carries it; the proxy's log redactor and response
 * redactor are given it as a secret as well (`config.ts`).
 */
import type { Address, Hex } from 'viem'
import {
  buildSaleRecord,
  describeError,
  reportSale,
  type ConsumedPaymentRecord,
  type InvoiceJson,
  type SaleRecord,
  type SaleReportOutcome,
} from '@haven_ai/merchant-payments'
import type { LogFn } from './log.js'
import type { Product } from './products.js'
import type { SalesOutbox } from './sales-outbox.js'
import type { SqliteConsumedPaymentStore } from './sqlite-store.js'

/** The Sales key's prefix (#4896); a value without it is not a Sales key. */
export const SALES_KEY_PREFIX = 'sk_merchant_'

/** §5, §12: what the proxy needs to report a sale. Present only when reporting is on. */
export interface SalesSettings {
  /** Haven's API origin, e.g. `https://api.haven.example`; the reporter appends `/merchant/sales`. */
  havenBaseUrl: string
  /** The merchant's Sales key. Handed to the core reporter only. */
  merchantKey: string
  /** The persistent outbox file (`SALES_OUTBOX`). */
  outboxPath: string
}

/** What the startup log says about sales reporting. */
export type SalesStatus = 'on' | 'off (no HAVEN_MERCHANT_KEY)'

/**
 * The §5 record for one settled payment. `receipt_number` and `vat_treatment`
 * come from the receipt the buyer got and are left out when the deployment
 * issues none (§5: absent, never `null`).
 */
export function saleRecordFor(
  record: Pick<ConsumedPaymentRecord, 'txHash' | 'payer' | 'amount' | 'merchantReference'>,
  product: Pick<Product, 'id' | 'name'>,
  receipt: Pick<InvoiceJson, 'fakturanummer' | 'momsbehandling'> | undefined,
  chainId: number,
): SaleRecord {
  if (!record.txHash) throw new Error('a settled payment has a transaction hash')
  return buildSaleRecord({
    txHash: record.txHash as Hex,
    chainId,
    productId: product.id,
    // §5: the products file's name when it has one, otherwise the id.
    productName: product.name ?? product.id,
    amount: BigInt(record.amount),
    payer: record.payer as Address,
    merchantReference: record.merchantReference,
    ...(receipt !== undefined
      ? { receiptNumber: receipt.fakturanummer, vatTreatment: receipt.momsbehandling }
      : {}),
  })
}

export interface SalesStats {
  /** Reports sent and not yet ended. */
  pending: number
  /** Accepted by Haven (201, or 200 for an identical resend). */
  reported: number
  /** Refused by Haven: logged, never resent. */
  refused: number
  /** Queued in the outbox for a later resend. */
  queued: number
}

export interface SalesReporter {
  /**
   * Reports a settled payment, once. Returns at once and never throws: the
   * buyer's answer never waits on Haven.
   */
  report(record: ConsumedPaymentRecord, product: Pick<Product, 'id' | 'name'>, receipt?: InvoiceJson): void
  stats(): SalesStats
  /** Resolves when every report in flight has ended (tests and shutdown). */
  idle(): Promise<void>
  /** How many records the outbox is holding. */
  outboxDepth(): number
}

export interface SalesReporterDeps {
  settings: SalesSettings
  chainId: number
  store: Pick<SqliteConsumedPaymentStore, 'markSaleReported'>
  outbox: SalesOutbox
  log: LogFn
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  retryDelaysMs?: readonly number[]
  attemptTimeoutMs?: number
}

export function createSalesReporter(deps: SalesReporterDeps): SalesReporter {
  const { settings, chainId, store, outbox, log } = deps
  // A payment whose report is in flight is not reported again.
  const inFlight = new Map<string, Promise<void>>()
  const counts = { reported: 0, refused: 0, queued: 0 }

  async function deliver(key: string, sale: SaleRecord): Promise<void> {
    try {
      const outcome: SaleReportOutcome = await reportSale({
        havenBaseUrl: settings.havenBaseUrl,
        salesKey: settings.merchantKey,
        record: sale,
        ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
        ...(deps.retryDelaysMs !== undefined ? { retryDelaysMs: deps.retryDelaysMs } : {}),
        ...(deps.attemptTimeoutMs !== undefined ? { attemptTimeoutMs: deps.attemptTimeoutMs } : {}),
        log: (event, fields) => log(event, fields),
      })
      if (outcome.outcome === 'accepted') {
        await store.markSaleReported(key)
        counts.reported += 1
        return
      }
      // A 429 is the route's rate limit, not a judgement on the record: it is
      // "could not be sent", so the outbox takes it. Every other 4xx is a
      // refusal and resending it changes nothing.
      if (outcome.outcome === 'gave_up' || (outcome.outcome === 'refused' && outcome.status === 429)) {
        await outbox.add(key, sale, outcome)
        counts.queued += 1
        return
      }
      counts.refused += 1
    } catch (err) {
      // `reportSale` never throws; this guards the store and the outbox, and
      // names the error's class only.
      log('sales_report_skipped', { key, error: describeError(err) })
    }
  }

  return {
    report(record, product, receipt) {
      try {
        if (record.saleReported) return
        if (!record.txHash || !record.settledAt) return
        if (inFlight.has(record.key)) return
        const sale = saleRecordFor(record, product, receipt, chainId)
        const run = deliver(record.key, sale).finally(() => {
          inFlight.delete(record.key)
        })
        inFlight.set(record.key, run)
      } catch (err) {
        // A report is never a reason to fail a call that has settled.
        log('sales_report_skipped', { key: record.key, error: describeError(err) })
      }
    },

    stats: () => ({ pending: inFlight.size, ...counts }),

    idle: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()])
    },

    outboxDepth: () => outbox.depth(),
  }
}
