import {
  buildReceipt,
  receiptNumberForTransaction,
  renderReceiptText,
  type AcceptedCheckoutDetails,
  type AcceptedTaxDeclaration,
  type InvoiceJson,
  type ReceiptSellerDetails,
  type VatRule,
} from '@haven_ai/merchant-payments'
import type { MerchantLocale, ProductId } from './products.js'
import {
  CHAIN_ID,
  DEFAULT_MERCHANT_LOCALE,
  PRODUCTS,
  networkDisplayName,
  productBillingPeriod,
  productDescription,
} from './products.js'
import type { SekRate } from './sek-rate.js'
import type { SettledPayment, SettlementState } from './x402.js'

// #1550: the invoice DOCUMENT (`InvoiceJson`) has the shape of a Swedish
// bookkeeping document — it feeds the `x-receipt-json` header and Haven's
// accounting (receipt-underlag, receipt-statement), so its keys and codes never
// change. #4980: its human-readable VALUES (the line's description and billing
// period, `betalningssatt`, `status`, and the two Stripe blocks' `status`)
// follow the buyer's display locale — English by default, Swedish with
// `locale: 'sv'`. Haven reads none of those values.
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
/**
 * The demo seller: what every receipt carries when no seller is configured.
 * #4856: a deployment that is a real seller sets `MERCHANT_SELLER_*`
 * instead (`resolveReceiptSeller`).
 */
export const DEMO_SELLER: ReceiptSellerDetails = {
  name: 'Haven Demo AB',
  address: 'Birger Jarlsgatan 57, 113 56 Stockholm',
  org_nr: '559412-3456',
  moms_nr: 'SE559412345601',
  iban: 'SE35 5000 0000 0549 1000 0003',
  bic: 'ESSESESS',
}

/** #4856: the seller variables, in the order their keys appear on the receipt. */
export const SELLER_ENV = {
  name: 'MERCHANT_SELLER_NAME',
  address: 'MERCHANT_SELLER_ADDRESS',
  org_nr: 'MERCHANT_SELLER_ORG_NR',
  moms_nr: 'MERCHANT_SELLER_MOMS_NR',
  iban: 'MERCHANT_SELLER_IBAN',
  bic: 'MERCHANT_SELLER_BIC',
} as const

const REQUIRED_SELLER_KEYS = ['name', 'address', 'org_nr', 'moms_nr'] as const

/**
 * #4856: the seller block from configuration. With no `MERCHANT_SELLER_*`
 * variable set, the demo seller, so the receipt is unchanged. With the four
 * required ones set (name, address, org_nr, moms_nr), that seller, plus
 * `iban` and `bic` only when each is set — a real seller never inherits the
 * demo's bank details. With any `MERCHANT_SELLER_*` set but one of the four
 * required ones missing (`IBAN` or `BIC` alone included), a warning naming
 * the missing variables and the demo seller: a
 * half-configured seller is a mistake, not a reason to refuse payments.
 */
export function resolveReceiptSeller(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = console.warn,
): ReceiptSellerDetails {
  const value = (key: keyof typeof SELLER_ENV) => env[SELLER_ENV[key]]?.trim() || undefined
  const anySet = (Object.keys(SELLER_ENV) as (keyof typeof SELLER_ENV)[]).some((key) => value(key))
  if (!anySet) return DEMO_SELLER
  const missing = REQUIRED_SELLER_KEYS.filter((key) => !value(key))
  if (missing.length > 0) {
    warn(
      `Seller details are incomplete: set ${missing.map((key) => SELLER_ENV[key]).join(', ')} too. ` +
        'Receipts carry the demo seller until all four of name, address, org_nr and moms_nr are set.',
    )
    return DEMO_SELLER
  }
  const seller: ReceiptSellerDetails = {
    name: value('name')!,
    address: value('address')!,
    org_nr: value('org_nr')!,
    moms_nr: value('moms_nr')!,
  }
  const iban = value('iban')
  const bic = value('bic')
  if (iban) seller.iban = iban
  if (bic) seller.bic = bic
  return seller
}

// ── Stripe reference and SEK amount (#4856) ──────────────────────────────────
//
// The receipt for a payment Stripe will record is built before Stripe is
// contacted (#4880) and the merchant never waits for Stripe (#4853), so no
// PaymentIntent ID and no Stripe SEK figure exist when it answers. The receipt
// says the reference is pending and names the receipt number and transaction
// hash to find it by in Stripe (the PaymentIntent's `receipt_number` and
// `transaction_hash` metadata), and states an indicative SEK amount with its
// rate, source and time — or says none was available. Demo merchant only: the
// shared core (`@haven_ai/merchant-payments`) does not carry these blocks.

/** #4856: the Stripe reference on the receipt; always pending at answer time. */
export interface StripeReferenceBlock {
  /** #4980: `Pending` on an English receipt. */
  status: 'Väntar' | 'Pending'
  /** The two values the PaymentIntent can be found by in Stripe. */
  sok_med: { fakturanummer: string; transaktions_hash: string }
}

/** #4856: the SEK amount on the receipt. Never Stripe's own figure. */
export type SekAmountBlock =
  | {
      tillganglig: true
      /** SEK, two decimals. */
      belopp: string
      /** SEK per 1 USDC. */
      kurs: string
      kalla: SekRate['source']
      /** ISO time the rate was read. */
      tidpunkt: string
    }
  | { tillganglig: false; status: SekUnavailableStatus }

/** #4856, #4980: the SEK block's status when no rate was available, per locale. */
export type SekUnavailableStatus = 'Ej tillgängligt vid köptillfället' | 'Not available at the time of purchase'

const SEK_UNAVAILABLE: Record<MerchantLocale, SekUnavailableStatus> = {
  sv: 'Ej tillgängligt vid köptillfället',
  en: 'Not available at the time of purchase',
}

const STRIPE_PENDING: Record<MerchantLocale, StripeReferenceBlock['status']> = { sv: 'Väntar', en: 'Pending' }

/** The demo merchant's receipt: the core document plus the #4856 blocks. */
export type DemoInvoiceJson = InvoiceJson & {
  stripe_referens?: StripeReferenceBlock
  belopp_sek?: SekAmountBlock
}

export interface DemoInvoice {
  json: DemoInvoiceJson
  text: string
}

/** #4856: what the caller knows about Stripe when the receipt is built. */
export interface StripeReceiptContext {
  /** The fresh cached rate, or `undefined` when none is available. */
  sekRate: SekRate | undefined
}

/** SEK for an atomic USDC amount at `rate`, two decimals. */
export function sekAmountText(priceAtomic: bigint, rate: number): string {
  return ((Number(priceAtomic) / 1_000_000) * rate).toFixed(2)
}

function sekAmountBlock(priceAtomic: bigint, sekRate: SekRate | undefined, locale: MerchantLocale): SekAmountBlock {
  if (!sekRate) return { tillganglig: false, status: SEK_UNAVAILABLE[locale] }
  return {
    tillganglig: true,
    belopp: sekAmountText(priceAtomic, sekRate.rate),
    kurs: String(Number(sekRate.rate.toFixed(6))),
    kalla: sekRate.source,
    tidpunkt: sekRate.fetchedAt.toISOString(),
  }
}

function stripeSectionsText(inv: DemoInvoiceJson, locale: MerchantLocale): string {
  let out = ''
  const ref = inv.stripe_referens
  if (ref) {
    out +=
      locale === 'sv'
        ? `STRIPE-REFERENS\n` +
          `  Väntar — betalningen skickas till Stripe efter köpet.\n` +
          `  Sök med fakturanummer: ${ref.sok_med.fakturanummer}\n` +
          `  eller transaktions-hash: ${ref.sok_med.transaktions_hash}\n\n`
        : `STRIPE REFERENCE\n` +
          `  Pending — the payment is sent to Stripe after the purchase.\n` +
          `  Find it by receipt number: ${ref.sok_med.fakturanummer}\n` +
          `  or transaction hash: ${ref.sok_med.transaktions_hash}\n\n`
  }
  const sek = inv.belopp_sek
  if (sek) {
    out += locale === 'sv' ? `BELOPP I SEK (indikativt, inte Stripes belopp)\n` : `AMOUNT IN SEK (indicative, not Stripe's figure)\n`
    out += sek.tillganglig
      ? locale === 'sv'
        ? `  ${sek.belopp} SEK — kurs ${sek.kurs} SEK/USDC (${sek.kalla}, ${sek.tidpunkt})\n\n`
        : `  ${sek.belopp} SEK — rate ${sek.kurs} SEK/USDC (${sek.kalla}, ${sek.tidpunkt})\n\n`
      : locale === 'sv'
        ? `  Ej tillgängligt vid köptillfället.\n\n`
        : `  Not available at the time of purchase.\n\n`
  }
  return out
}

const RULE = '═'.repeat(60)

/**
 * Insert the #4856 sections before the receipt text's closing frame (the
 * thank-you box). Returns the text unchanged when the receipt has neither
 * block, so every other receipt keeps its exact bytes.
 */
function withStripeSections(text: string, inv: DemoInvoiceJson, locale: MerchantLocale): string {
  const sections = stripeSectionsText(inv, locale)
  if (!sections) return text
  const closing = text.lastIndexOf(RULE, text.lastIndexOf(RULE) - 1)
  if (closing < 0) return text + sections
  return text.slice(0, closing) + sections + text.slice(closing)
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
  /**
   * #4873: the checkout details the paid request carried, or absent/null when
   * it carried none. Display only: it adds fields to the buyer block.
   */
  checkoutDetails?: AcceptedCheckoutDetails | null
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
  /** #4856: the configured seller; defaults to the demo seller. */
  seller?: ReceiptSellerDetails
  /**
   * #4980: the language of the document's human-readable values and of
   * `text`. Defaults to `DEFAULT_MERCHANT_LOCALE` (`en`). Keys and codes are
   * the same in both.
   */
  locale?: MerchantLocale
  /**
   * #4856: present only when Stripe will record this payment
   * (`stripeRecordingDecision` answers `record`). Then, and only for a payment
   * settled on chain, the receipt carries the pending Stripe reference and the
   * SEK amount. Absent, the receipt is exactly the core document.
   */
  stripe?: StripeReceiptContext
}

export function generateInvoice(params: InvoiceParams): DemoInvoice {
  const product = PRODUCTS[params.productId]
  const chainId = params.chainId ?? CHAIN_ID
  const network = { sv: networkDisplayName(chainId, 'sv'), en: networkDisplayName(chainId, 'en') }
  const locale = params.locale ?? DEFAULT_MERCHANT_LOCALE
  const json: InvoiceJson = buildReceipt({
    invoiceNumber: params.invoiceNumber,
    // #4980: the description in the receipt's language. #4851: a one-time
    // product is not a month of anything.
    locale,
    line: {
      name: product.name,
      description: productDescription(product, locale),
      priceAtomic: product.price_usdc,
      billingPeriod: productBillingPeriod(product),
    },
    seller: params.seller ?? DEMO_SELLER,
    receivingAddress: params.receivingAddress,
    network,
    vatRule: VAT_RULE,
    buyerAddress: params.buyerAddress,
    payerRole: params.payerRole,
    taxDeclaration: params.taxDeclaration ?? null,
    checkoutDetails: params.checkoutDetails ?? null,
    txHash: params.txHash,
    settlement: params.settlement,
    now: params.now,
  })
  // #4856: the Stripe reference needs the hash it is found by, so it is added
  // only for a payment settled on chain (the only kind Stripe records).
  const demoJson: DemoInvoiceJson =
    params.stripe && params.settlement === 'settled_onchain'
      ? {
          ...json,
          stripe_referens: {
            status: STRIPE_PENDING[locale],
            sok_med: { fakturanummer: json.fakturanummer, transaktions_hash: params.txHash },
          },
          belopp_sek: sekAmountBlock(product.price_usdc, params.stripe.sekRate, locale),
        }
      : json
  const text = renderReceiptText(demoJson, {
    productName: product.name,
    locale,
    network,
    supportContact: SUPPORT_CONTACT,
  })
  return { json: demoJson, text: withStripeSections(text, demoJson, locale) }
}

/**
 * Locale-aware human-readable render of the SAME `InvoiceJson` (#1550). This
 * chooses the language of the headings and labels around its values; the
 * values are in the language the document was built in (#4980), which is the
 * locale of the call that paid. `en` is the demo default; `sv` on a Swedish
 * document reproduces the classic FAKTURA render byte-for-byte.
 */
export function renderInvoiceText(
  inv: DemoInvoiceJson,
  productName: string,
  locale: MerchantLocale,
  chainId: number = CHAIN_ID,
): string {
  return withStripeSections(renderReceiptText(inv, {
    productName,
    locale,
    // The Swedish render reads the network from the document itself, so only
    // the English render looks the chain up, exactly as before the move.
    network: { sv: '', en: locale === 'sv' ? '' : networkDisplayName(chainId, 'en') },
    supportContact: SUPPORT_CONTACT,
  }), inv, locale)
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
//
// #4856: so are `seller` and `stripe`. The HTTP layer builds the invoice
// first (before the MCP handler runs) and passes both; the handler's later
// call replays the cached invoice.
//
// #4980: and `locale`: the document's values are in the language of the call
// that paid (the HTTP layer reads it from the tool call's arguments). A later
// call for the same payment in the other locale replays that document under
// its own headings.
const invoicesByPayment = new WeakMap<SettledPayment, DemoInvoice>()

export function invoiceForPayment(
  payment: SettledPayment,
  productId: ProductId,
  opts: {
    receivingAddress: string
    chainId?: number
    taxDeclaration?: AcceptedTaxDeclaration | null
    /** #4873: the checkout details the paid request carried, if any. */
    checkoutDetails?: AcceptedCheckoutDetails | null
    seller?: ReceiptSellerDetails
    stripe?: StripeReceiptContext
    /** #4980: the language of the document's values; defaults to `en`. */
    locale?: MerchantLocale
  },
): DemoInvoice {
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
    checkoutDetails: opts.checkoutDetails ?? null,
    buyerAddress: payment.from,
    // #2960: `payment.from` is the delegate EOA on `eip3009` and the
    // delegate SMART account (`delegator`) on `erc7710` — see
    // `verifyEip3009Payment`/`verifyErc7710Payment` in `x402.ts`.
    payerRole: payment.settlementMethod === 'erc7710' ? 'agent_delegate_account' : 'agent_delegate',
    authorizationNonce: payment.nonce,
    txHash: payment.txHash,
    settlement: payment.settlement,
    seller: opts.seller,
    stripe: opts.stripe,
    locale: opts.locale,
  })
  invoicesByPayment.set(payment, invoice)
  return invoice
}
