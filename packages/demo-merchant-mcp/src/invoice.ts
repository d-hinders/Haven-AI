import {
  buildReceipt,
  receiptNumberForTransaction,
  renderReceiptText,
  type AcceptedTaxDeclaration,
  type Invoice,
  type InvoiceJson,
  type VatRule,
} from '@haven_ai/merchant-payments'
import type { MerchantLocale, ProductId } from './products.js'
import { CHAIN_ID, PRODUCTS, networkDisplayName, productBillingPeriod } from './products.js'
import type { SettledPayment, SettlementState } from './x402.js'

// #1550: the invoice DOCUMENT (`InvoiceJson` + its Swedish text render) is a
// Swedish bookkeeping artifact by design — it feeds the `x-receipt-json`
// header and downstream accounting fixtures (Fortnox / receipt-underlag), so
// the display-locale switch never touches it: keys, values, and `beskrivning`
// stay Swedish regardless of the buyer-facing locale. Only the human-readable
// render gains an English variant, via `renderInvoiceText`.
//
// #4890: the receipt builder, its rendered text, the receipt number, the VAT
// amounts and the declaration check live in `@haven_ai/merchant-payments`,
// shared with the paywall proxy. This module keeps what is the DEMO
// merchant's: its seller, its product table, its support contact, its VAT
// rule, the counter for payments with no transaction hash, and the
// per-payment cache.

export {
  RECEIPT_NUMBER_DIGITS,
  receiptNumberForTransaction,
  vatAmountsAtomic,
  type BuyerDeclaration,
  type Invoice,
  type InvoiceJson,
} from '@haven_ai/merchant-payments'

// ── Merchant identity ────────────────────────────────────────────────────────
const MERCHANT_IDENTITY = {
  name: 'Haven Demo AB',
  address: 'Birger Jarlsgatan 57, 113 56 Stockholm',
  org_nr: '559412-3456',
  moms_nr: 'SE559412345601',
  iban: 'SE35 5000 0000 0549 1000 0003',
  bic: 'ESSESESS',
}

/**
 * The seller block. Its keys are a contract: Haven's accounting reads
 * `name`, `org_nr` and `moms_nr` off the receipt
 * (`packages/backend/src/modules/accounting/receipt-underlag.ts`).
 * #4875: so are the line and total keys — `rader[]` (`beskrivning`, `antal`,
 * `apris_exkl_moms`, `moms_procent`, `moms_belopp`, `totalt_inkl_moms`),
 * `belopp_exkl_moms`, `moms_procent`, `moms_belopp`, `totalt_inkl_moms`,
 * `momsbehandling` and `valuta`
 * (`packages/backend/src/modules/accounting/receipt-statement.ts`,
 * `docs/operations/merchant-receipt-shape.md`). `invoice.test.ts` pins them.
 */
export type { InvoiceSeller } from '@haven_ai/merchant-payments'

/**
 * Invoice numbering. The demo merchant has no store, so the counter is
 * seeded from the clock at startup and incremented per invoice. #2988: the
 * seed is MILLISECONDS — a seconds seed collided after a restart whenever
 * more invoices had been issued than seconds had elapsed since the previous
 * start (a 100-invoice QA run, then a redeploy 30 s later, re-issued 70
 * existing numbers — and, via `generateOcr`, 70 existing OCRs). A
 * millisecond seed needs more than 1 000 invoices per second before a
 * restart to collide. A persisted counter is still deliberately not used:
 * this merchant is a demo with no database, and the accounting feed keys on
 * the payment id, not on this number.
 */
export function createInvoiceNumberer(seedMs: number = Date.now()): () => string {
  let invoiceSeq = seedMs
  return () => {
    invoiceSeq++
    const year = new Date().getFullYear()
    return `FAK-${year}-${invoiceSeq}`
  }
}

const nextInvoiceNumber = createInvoiceNumberer()

/** The demo merchant's support contact, printed on the receipt text. */
const SUPPORT_CONTACT = 'support@haven.xyz'

/**
 * The demo merchant's VAT rule: a Swedish seller of an electronic service,
 * with EU reverse charge for an accepted declaration (#4855).
 */
const VAT_RULE: VatRule = 'SE_25_WITH_EU_REVERSE_CHARGE'

export interface InvoiceParams {
  /** Merchant chain for the payment-method text; defaults to `CHAIN_ID`. */
  chainId?: number
  invoiceNumber: string
  productId: ProductId
  buyerAddress: string
  /**
   * #2960: which party `buyerAddress` actually is. The merchant only ever
   * observes the address it verified the payment FROM — the delegate EOA on
   * `eip3009`, the delegate SMART account (`delegator`) on `erc7710` — never
   * the owner's treasury account, which is not knowable merchant-side.
   */
  payerRole: 'agent_delegate' | 'agent_delegate_account'
  /** #4850: the purchased product's receiving address (`productReceivingAddress`). */
  receivingAddress: string
  /**
   * #4855: the buyer's accepted tax declaration, or absent/null when the
   * request carried none (or carried one the merchant refused). Display only.
   */
  taxDeclaration?: AcceptedTaxDeclaration | null
  /** EIP-3009 authorization nonce (hex bytes32) */
  authorizationNonce: string
  /** The wire hash — rendered only when `settlement === 'settled_onchain'`. */
  txHash: string
  /** #2969: explicit settlement truth — see `SettlementState`. */
  settlement: SettlementState
  /**
   * #4890: the clock the invoice and due dates are read from. Defaults to
   * now; a test injects it to reproduce a receipt byte for byte.
   */
  now?: Date
}

export function generateInvoice(params: InvoiceParams): Invoice {
  const product = PRODUCTS[params.productId]
  const chainId = params.chainId ?? CHAIN_ID
  const network = { sv: networkDisplayName(chainId, 'sv'), en: networkDisplayName(chainId, 'en') }
  const json: InvoiceJson = buildReceipt({
    invoiceNumber: params.invoiceNumber,
    // Always the SWEDISH description (#1550). #4851: a one-time product is
    // not a month of anything.
    line: {
      name: product.name,
      description: product.description_sv,
      priceAtomic: product.price_usdc,
      billingPeriod: productBillingPeriod(product),
    },
    seller: MERCHANT_IDENTITY,
    receivingAddress: params.receivingAddress,
    network,
    vatRule: VAT_RULE,
    buyerAddress: params.buyerAddress,
    payerRole: params.payerRole,
    taxDeclaration: params.taxDeclaration ?? null,
    txHash: params.txHash,
    settlement: params.settlement,
    now: params.now,
  })
  const text = renderReceiptText(json, {
    productName: product.name,
    locale: 'sv',
    network,
    supportContact: SUPPORT_CONTACT,
  })
  return { json, text }
}

/**
 * Locale-aware human-readable render of the SAME `InvoiceJson` (#1550). The
 * underlying document stays Swedish (see the module comment); this only
 * chooses the language of the headings and labels around its values. `en` is
 * the demo default; `sv` reproduces the classic FAKTURA render byte-for-byte.
 */
export function renderInvoiceText(
  inv: InvoiceJson,
  productName: string,
  locale: MerchantLocale,
  chainId: number = CHAIN_ID,
): string {
  return renderReceiptText(inv, {
    productName,
    locale,
    // The Swedish render reads the network from the document itself, so only
    // the English render looks the chain up, exactly as before the move.
    network: { sv: '', en: locale === 'sv' ? '' : networkDisplayName(chainId, 'en') },
    supportContact: SUPPORT_CONTACT,
  })
}

export { nextInvoiceNumber }

// ── Per-payment invoice cache (#956) ─────────────────────────────────────────
//
// The invoice is now needed in TWO places for the same settled payment: the
// HTTP layer sets it as the machine-readable `x-receipt-json` response header
// (so a paying agent can capture the merchant's own receipt), and the MCP tool
// handler renders it in the confirmation text. One generation per payment
// keeps the two identical — and repeat tool calls replay the same invoice.
//
// #4850: keyed by payment alone, so every caller must pass the SAME
// `receivingAddress` for a payment — the purchased product's
// (`productReceivingAddress`). Whichever caller runs first fixes the invoice.
const invoicesByPayment = new WeakMap<SettledPayment, Invoice>()

export function invoiceForPayment(
  payment: SettledPayment,
  productId: ProductId,
  opts: { receivingAddress: string; chainId?: number; taxDeclaration?: AcceptedTaxDeclaration | null },
): Invoice {
  const cached = invoicesByPayment.get(payment)
  if (cached) return cached
  const invoice = generateInvoice({
    // #4880: a payment settled on-chain is numbered from its transaction hash,
    // so the number is stable and the reconciliation script reproduces it.
    // Any other payment has no hash to key on and keeps the counter.
    invoiceNumber:
      payment.settlement === 'settled_onchain' ? receiptNumberForTransaction(payment.txHash) : nextInvoiceNumber(),
    productId,
    chainId: opts.chainId,
    receivingAddress: opts.receivingAddress,
    // #4855: the declaration the paid request carried, already verified
    // against this payment's payer. Display only.
    taxDeclaration: opts.taxDeclaration ?? null,
    buyerAddress: payment.from,
    // #2960: `payment.from` is the delegate EOA on `eip3009` and the
    // delegate SMART account (`delegator`) on `erc7710` — see
    // `verifyEip3009Payment`/`verifyErc7710Payment` in `x402.ts`.
    payerRole: payment.settlementMethod === 'erc7710' ? 'agent_delegate_account' : 'agent_delegate',
    authorizationNonce: payment.nonce,
    txHash: payment.txHash,
    settlement: payment.settlement,
  })
  invoicesByPayment.set(payment, invoice)
  return invoice
}
