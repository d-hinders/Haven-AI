/**
 * The re-report command (#4898): `node dist/index.js report-sale <tx-hash>`.
 *
 * A sale whose record was cleared on Haven, or that was never recorded, is sent
 * again from the payment the consumed-payment store kept — the settlement's
 * transaction hash, the product, the payer, the amount and the
 * `merchantReference` the store reserved for it. The record is built and sent by
 * the shared core (`buildSaleRecord`, `reportSale`), exactly as the proxy's own
 * report is, so there is no second implementation.
 *
 * Two things the command cannot recover, and says so:
 *
 * - **The buyer's tax declaration is not stored.** The receipt is rebuilt from
 *   the transaction and the deployment's VAT rule, so a re-reported sale states
 *   the rule's default VAT treatment unless `--vat-treatment` names the one the
 *   buyer's receipt carried.
 * - **The store is locked by a running proxy** (§6: one process per
 *   `PAYMENTS_DB`). Stop the proxy, run the command, start it again.
 *
 * `--new-reference` sends the record with a fresh `sale_<ULID>` instead of the
 * one the store reserved, for a sale whose first record Haven still holds under
 * the old reference. The command prints the outcome as one JSON line and exits
 * non-zero unless Haven accepted the record. It never prints the merchant key.
 */
import {
  newMerchantReference,
  reportSale,
  type SaleRecord,
  type SaleReportOutcome,
  type VatTreatment,
} from '@haven_ai/merchant-payments'
import { ConfigError, loadConfig, type ProxyConfig } from './config.js'
import { loadProductsFile, ProductsFileError, type Product } from './products.js'
import { buildReceiptForPayment } from './receipt.js'
import { saleRecordFor } from './sales.js'
import { openSqliteConsumedPaymentStore, StoreLockedError, StorePermissionError } from './sqlite-store.js'

/** The states a payment can be in and still be re-reported: it settled. */
const SETTLED_STATES = ['settled', 'forwarding', 'delivered', 'failed', 'exhausted'] as const

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

export interface ReportSaleOptions {
  txHash: string
  /** The VAT treatment the buyer's receipt carried, when it was not the rule's default. */
  vatTreatment?: VatTreatment
  /** Send with a fresh `sale_<ULID>` instead of the reference the store reserved. */
  newReference?: boolean
  fetch?: typeof fetch
  log?: (line: string) => void
}

export interface ReportSaleResult {
  outcome: SaleReportOutcome
  record: SaleRecord
}

export class ReportSaleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReportSaleError'
  }
}

/**
 * Send one past settled call again. Opens `PAYMENTS_DB` (so the proxy must be
 * stopped), finds the payment by transaction hash, rebuilds the §5 record and
 * posts it with the core reporter's full retry policy.
 */
export async function reportSaleAgain(
  config: ProxyConfig,
  products: readonly Product[],
  options: ReportSaleOptions,
): Promise<ReportSaleResult> {
  const settings = config.sales
  if (!settings) {
    throw new ReportSaleError('HAVEN_MERCHANT_KEY is not set: there is no Haven account to report the sale to.')
  }
  if (!TX_HASH_RE.test(options.txHash)) {
    throw new ReportSaleError('The transaction hash must be 0x followed by 64 hex characters.')
  }

  const store = openSqliteConsumedPaymentStore(config.paymentsDb, {
    takeoverAfterMs: config.upstreamTimeoutMs + 30_000,
  })
  try {
    const payment = await store.findByTxHash(options.txHash)
    if (!payment) {
      throw new ReportSaleError(
        `PAYMENTS_DB has no payment with transaction hash ${options.txHash}. The store is the record of what settled; a payment it never saw cannot be reported.`,
      )
    }
    if (!SETTLED_STATES.includes(payment.state as (typeof SETTLED_STATES)[number])) {
      throw new ReportSaleError(
        `The payment with transaction hash ${options.txHash} has not settled (its state is "${payment.state}"). Nothing is reported.`,
      )
    }
    if (!payment.txHash || !payment.settledAt) {
      throw new ReportSaleError(`The payment with transaction hash ${options.txHash} has no settlement recorded.`)
    }

    const product = products.find((candidate) => candidate.id === payment.productId)
    if (!product && config.receipt !== undefined) {
      throw new ReportSaleError(
        `The products file no longer has product "${payment.productId}", so the receipt the buyer got cannot be rebuilt. Restore the product entry and run the command again.`,
      )
    }

    // The receipt is rebuilt from the transaction and the deployment's rule; the
    // buyer's declaration is not stored, so `--vat-treatment` is how a
    // reverse-charge receipt is stated again.
    const receipt =
      config.receipt !== undefined && product !== undefined
        ? buildReceiptForPayment({
            settings: config.receipt,
            product,
            settledAmountAtomic: BigInt(payment.amount),
            chain: config.chain,
            payTo: config.payTo,
            payer: payment.payer,
            txHash: payment.txHash,
            settledAt: payment.settledAt,
          })
        : undefined

    const record = saleRecordFor(
      {
        ...payment,
        merchantReference: options.newReference === true ? newMerchantReference() : payment.merchantReference,
      },
      product ?? { id: payment.productId },
      receipt !== undefined && options.vatTreatment !== undefined
        ? { fakturanummer: receipt.fakturanummer, momsbehandling: options.vatTreatment }
        : receipt,
      config.chain.chainId,
    )

    const outcome = await reportSale({
      havenBaseUrl: settings.havenBaseUrl,
      salesKey: settings.merchantKey,
      record,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      log: (event, fields) => options.log?.(`${event} ${JSON.stringify(fields)}`),
    })
    if (outcome.outcome === 'accepted') await store.markSaleReported(payment.key)
    return { outcome, record }
  } finally {
    store.close()
  }
}

/** The command's arguments: one transaction hash, and the two optional flags. */
export function parseReportSaleArgs(args: readonly string[]): ReportSaleOptions {
  let txHash: string | undefined
  let vatTreatment: VatTreatment | undefined
  let newReference = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--new-reference') {
      newReference = true
    } else if (arg === '--vat-treatment') {
      const value = args[index + 1]
      if (value !== 'SE_25' && value !== 'REVERSE_CHARGE') {
        throw new ReportSaleError('--vat-treatment must be SE_25 or REVERSE_CHARGE.')
      }
      vatTreatment = value
      index += 1
    } else if (arg.startsWith('--')) {
      throw new ReportSaleError(`Unknown option "${arg}".`)
    } else if (txHash === undefined) {
      txHash = arg
    } else {
      throw new ReportSaleError('Give one transaction hash.')
    }
  }
  if (txHash === undefined) throw new ReportSaleError('Give the transaction hash of the settled call to report again.')
  return { txHash, ...(vatTreatment !== undefined ? { vatTreatment } : {}), ...(newReference ? { newReference } : {}) }
}

/**
 * `node dist/index.js report-sale <tx-hash> [--vat-treatment SE_25|REVERSE_CHARGE] [--new-reference]`.
 * Prints one JSON line and returns the process exit code.
 */
export async function runReportSaleCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  try {
    const options = parseReportSaleArgs(args)
    const config = loadConfig(env)
    const products = loadProductsFile(config.productsFile)
    const { outcome, record } = await reportSaleAgain(config, products, options)
    console.log(
      JSON.stringify({
        outcome: outcome.outcome,
        status: outcome.status,
        code: outcome.outcome === 'accepted' ? null : outcome.code,
        attempts: outcome.attempts,
        tx_hash: record.tx_hash,
        merchant_reference: record.merchant_reference,
      }),
    )
    return outcome.outcome === 'accepted' ? 0 : 1
  } catch (err) {
    if (err instanceof ReportSaleError || err instanceof ConfigError || err instanceof ProductsFileError) {
      console.error(err.message)
    } else if (err instanceof StoreLockedError || err instanceof StorePermissionError) {
      console.error(err.message)
    } else {
      // The class only: a driver or network message is not ours to print next to a key.
      console.error(`The sale could not be reported (${err instanceof Error ? err.name : 'UnknownError'}).`)
    }
    return 1
  }
}
