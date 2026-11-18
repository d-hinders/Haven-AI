/**
 * The receipt the proxy returns with a paid call
 * (docs/architecture/12-merchant-kit.md §11, #4913).
 *
 * The proxy defines NO VAT computation, NO receipt-number derivation and NO
 * declaration verification: every one of those is the shared core's
 * (`@haven_ai/merchant-payments`, #4890). This module only assembles the
 * parameters the core's `buildReceipt` takes — the deployment's seller and VAT
 * rule, the products-file line, the settled payment — and encodes the result
 * for the `x-receipt-json` header.
 *
 * The receipt is the JSON document only. A proxy has no carrier for the
 * rendered text: the response body is the upstream API's goods. A reader that
 * wants the text renders it from the header with the core's
 * `renderReceiptText`.
 */
import {
  acceptTaxDeclaration,
  buildReceipt,
  receiptNumberForTransaction,
  type HexString,
  type InvoiceJson,
  type ReceiptSellerDetails,
  type VatRule,
} from '@haven_ai/merchant-payments'
import type { ProxyChain } from './chains.js'
import type { Product } from './products.js'

/**
 * The most the receipt may be, decoded. The SDK drops a header longer than
 * `ceil(64 KiB * 4 / 3)` and the backend refuses a receipt over 64 KiB decoded
 * (`packages/sdk/src/merchant-completion.ts`), so the proxy never sends one.
 */
export const MAX_RECEIPT_JSON_BYTES = 64 * 1024

/**
 * The deployment's receipt settings, present only when a VAT rule is
 * configured (§11). The merchant decides its own tax treatment: the proxy
 * applies the rule it is given and makes no tax decision of its own.
 */
export interface ReceiptSettings {
  vatRule: VatRule
  seller: ReceiptSellerDetails
  /**
   * The merchant's own support contact. The proxy sends the JSON only, which
   * carries no support line; a reader that renders the text from the header
   * prints this, never Haven's.
   */
  supportContact: string
}

export interface ReceiptParams {
  settings: ReceiptSettings
  /** The products-file entry the payment bought. */
  product: Product
  chain: ProxyChain
  /** The address the payment was made out to (`PAY_TO`). */
  payTo: string
  /** The payer the proxy verified the payment from. */
  payer: string
  /** The settlement transaction hash the consumed-payment store recorded. */
  txHash: string
  /** The payment's `settledAt` in the consumed-payment store. */
  settledAt: string
  /** The raw `X-Tax-Declaration` header, if the request carried one. */
  taxDeclarationHeader?: string
  /** The clock the declaration's validity is checked against; defaults to `Date.now()`. */
  now?: number
}

/**
 * Build the receipt document for one settled payment. The receipt number comes
 * from the transaction hash alone, so the same settled transaction yields the
 * same receipt after a restart and on a retry.
 */
export function buildReceiptForPayment(params: ReceiptParams): InvoiceJson {
  // Display only: a declaration that fails any check is treated as absent and
  // never refuses the purchase (§11).
  const taxDeclaration = acceptTaxDeclaration({
    header: params.taxDeclarationHeader,
    payer: params.payer,
    chainId: params.chain.chainId,
    ...(params.now !== undefined ? { now: params.now } : {}),
  })
  const settledAt = new Date(params.settledAt)
  return buildReceipt({
    invoiceNumber: receiptNumberForTransaction(params.txHash as HexString),
    // §11: `<name> — <description>` (the `id` when there is no name), and no
    // billing period for a per-call product.
    line: {
      name: params.product.name ?? params.product.id,
      description: params.product.description,
      priceAtomic: params.product.price,
    },
    seller: params.settings.seller,
    receivingAddress: params.payTo,
    network: params.chain.receiptNetwork,
    vatRule: params.settings.vatRule,
    buyerAddress: params.payer,
    // The proxy settles EIP-3009 only, so the payer it verified is the
    // agent's delegate address (§5).
    payerRole: 'agent_delegate',
    taxDeclaration,
    txHash: params.txHash,
    settlement: 'settled_onchain',
    // §11: the receipt's dates are the payment's, so a retry on a later day
    // gives the same receipt.
    ...(Number.isNaN(settledAt.getTime()) ? {} : { now: settledAt }),
  })
}

/**
 * The `x-receipt-json` header value: the receipt's JSON, base64-encoded so the
 * header stays ASCII-safe. Throws when the document is over the limit the SDK
 * and the backend enforce; the caller leaves the header out and logs it.
 */
export function encodeReceiptHeader(json: InvoiceJson): string {
  const text = JSON.stringify(json)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_RECEIPT_JSON_BYTES) {
    throw new Error(`the receipt is ${bytes} bytes; the limit is ${MAX_RECEIPT_JSON_BYTES}`)
  }
  return Buffer.from(text, 'utf8').toString('base64')
}
