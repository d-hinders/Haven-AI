import { vatTreatmentFor, type AcceptedTaxDeclaration, type VatRule, type VatTreatment } from './tax-declaration.js'
import type { AcceptedCheckoutDetails, CheckoutAddress } from './checkout-details.js'

// The receipt (`x-receipt-json`) and its rendered text, shared by the demo
// merchant and the paywall proxy (#4890, #4913; docs/architecture/12-merchant-kit.md §11).
//
// #1550: the receipt DOCUMENT (`InvoiceJson`) has the shape of a Swedish
// bookkeeping document. It feeds the `x-receipt-json` header and Haven's
// accounting (receipt-underlag, receipt-statement), so its KEYS and its codes
// (`SE_25`, `REVERSE_CHARGE`, `USDC`, `blockkedjeadress`, `agent_delegate*`)
// never change. #4980: its human-readable VALUES (`beskrivning`'s billing
// period, `betalningssatt`, `status`) follow `ReceiptParams.locale`, Swedish by
// default; the demo merchant passes its buyer's locale, English by default.
// Haven reads none of those values. The text render has both languages
// (`renderReceiptText`).
//
// #4890: moved from `packages/demo-merchant-mcp/src/invoice.ts`. Everything
// the demo merchant hard-coded is a parameter here: the seller, the product
// line, the chain's display name, the support contact, the VAT rule, the clock
// and the receipt number. The numbering of a payment with no transaction hash
// and the per-payment cache stay with the merchant that needs them.

/** The three settlement truths a receipt can state (#2969). */
export type ReceiptSettlementState = 'settled_onchain' | 'already_settled_earlier' | 'settlement_unknown'

/** A 0x-prefixed hex string (a transaction hash). */
export type HexString = `0x${string}`

/**
 * The seller block, as the merchant configures it. Its four named keys are a
 * contract: Haven's accounting reads `name`, `org_nr` and `moms_nr` off the
 * receipt (`packages/backend/src/modules/accounting/receipt-underlag.ts`).
 * Any further string fields (the demo merchant's `iban` and `bic`, say) are
 * carried through in the order given, before `crypto_address`.
 */
export type ReceiptSellerDetails = {
  name: string
  address: string
  org_nr: string
  moms_nr: string
} & Record<string, string>

/**
 * The seller block on a receipt: the configured details plus the address THIS
 * payment was made out to (#4850).
 */
export type InvoiceSeller = ReceiptSellerDetails & { crypto_address: string }

/** What one purchase buys, when the product has a period. */
export type ReceiptBillingPeriod = 'monthly' | 'one_time'

/**
 * The receipt's one line. `beskrivning` is `<name> — <description>`, plus the
 * billing-period suffix when `billingPeriod` is given (the demo merchant's
 * `(1 månad)` / `(engångsköp)`, #4851; `(1 month)` / `(one-time purchase)` on
 * an English receipt, #4980).
 */
export interface ReceiptLine {
  name: string
  /** The description, in the receipt's language (`ReceiptParams.locale`, #4980). */
  description: string
  /** The VAT-inclusive price in USDC base units (six decimals). */
  priceAtomic: bigint
  billingPeriod?: ReceiptBillingPeriod
}

/** The network the payment settled on, by name, in both render languages. */
export interface ReceiptNetwork {
  /** Swedish display name, e.g. `Base` or `Base Sepolia testnät`. */
  sv: string
  /** English display name, e.g. `Base` or `Base Sepolia testnet`. */
  en: string
}

/** The language of a receipt's human-readable values and of its text render. */
export type ReceiptLocale = 'sv' | 'en'

export interface ReceiptParams {
  invoiceNumber: string
  /**
   * #4980: the language of the document's human-readable VALUES — the line's
   * billing period, `betalningssatt` and `status`. Keys and codes never change.
   * Defaults to `sv`, the document as it was before #4980 (the paywall proxy
   * passes none). The caller supplies `line.description` in the same language.
   */
  locale?: ReceiptLocale
  line: ReceiptLine
  seller: ReceiptSellerDetails
  /** #4850: the address the payment was made out to. */
  receivingAddress: string
  network: ReceiptNetwork
  vatRule: VatRule
  buyerAddress: string
  /**
   * #2960: which party `buyerAddress` actually is. A merchant only observes
   * the address it verified the payment FROM: the delegate EOA on `eip3009`,
   * the delegate SMART account (`delegator`) on `erc7710`.
   */
  payerRole: 'agent_delegate' | 'agent_delegate_account'
  /**
   * #4855: the buyer's accepted tax declaration, or absent/null when there is
   * none. Display only: it changes the buyer block and the VAT treatment,
   * never the price.
   */
  taxDeclaration?: AcceptedTaxDeclaration | null
  /**
   * #4873: the checkout details the paid request carried, or absent/null when
   * it carried none (or carried one the merchant could not read). Display
   * only: it adds fields to the buyer block and never changes the price.
   */
  checkoutDetails?: AcceptedCheckoutDetails | null
  /** The wire hash; rendered only when `settlement === 'settled_onchain'`. */
  txHash: string
  /** #2969: explicit settlement truth. */
  settlement: ReceiptSettlementState
  /** The clock the receipt and due dates are read from. Defaults to now. */
  now?: Date
}

export interface Invoice {
  /** Structured data for bookkeeping / accounting systems (Swedish keys) */
  json: InvoiceJson
  /** Human-readable receipt text */
  text: string
}

export interface InvoiceJson {
  fakturanummer: string
  fakturadatum: string
  forfallodatum: string
  ocr_nummer: string
  saljare: InvoiceSeller
  kopare: {
    identifierare: string
    typ: 'blockkedjeadress'
    /**
     * #2960, additive: which party `identifierare` is. Never read by the
     * Swedish render (#1550); the English render uses it to avoid calling a
     * delegate address "the buyer".
     */
    roll: 'agent_delegate' | 'agent_delegate_account'
    /**
     * #4855: present ONLY when the merchant accepted a signed declaration.
     * The declaration carries no company name and no organisation number,
     * so this block shows only what it does carry.
     */
    deklaration?: BuyerDeclaration
    /**
     * #4873: present ONLY when the paid request carried checkout details.
     *
     * The names are the wire names `docs/architecture/13-checkout-details.md`
     * §2 fixes (`receipt_email`, `billing_address`, `shipping_address`) and no
     * slice renames them, so a merchant that later adopts the compliance-fields
     * extension reads the same names off this receipt. The address shape is
     * that extension's `buyer.address` shape (EN 16931 BG-8).
     */
    receipt_email?: string
    billing_address?: CheckoutAddress
    shipping_address?: CheckoutAddress
  }
  rader: InvoiceRow[]
  belopp_exkl_moms: string
  moms_procent: number
  moms_belopp: string
  totalt_inkl_moms: string
  /**
   * #4855: the display treatment the amounts above follow. Display only: the
   * merchant applies the rule, it does not compute or file tax.
   */
  momsbehandling: VatTreatment
  valuta: 'USDC'
  /**
   * `Kryptovaluta (USDC på <network>)`; mainnet is exactly `... på Base)` (#1550, #3834).
   * #4980: `Cryptocurrency (USDC on <network>)` on an English receipt.
   */
  betalningssatt: `Kryptovaluta (USDC på ${string})` | `Cryptocurrency (USDC on ${string})`
  /** #2969: `null` on both non-settled states, never the zero hash. */
  blockkedje_referens: string | null
  /** #2969: 'Betald' / 'Paid' only for `settlement === 'settled_onchain'`. */
  status: ReceiptStatusSv | ReceiptStatusEn
}

/** #2969: the three Swedish status values, one per settlement state. */
export type ReceiptStatusSv =
  | 'Betald'
  | 'Betald i tidigare transaktion — referens saknas'
  | 'Levererad — ej bekräftad på kedjan'
/** #4980: the same three, on an English receipt. */
export type ReceiptStatusEn =
  | 'Paid'
  | 'Paid in an earlier transaction — reference unavailable'
  | 'Delivered — not confirmed on-chain'

/**
 * #4855: the buyer block's declaration fields. Swedish keys, like the rest of
 * the bookkeeping document (#1550).
 */
export interface BuyerDeclaration {
  /** Declared country, ISO 3166-1 alpha-2. */
  land: string
  /** The buyer's VAT number. */
  moms_nr: string
  /** The declared taxable status, e.g. `TAXABLE_PERSON`. */
  status: string
  /** ISO date the declaration is valid until. */
  giltig_till: string
}

export interface InvoiceRow {
  beskrivning: string
  antal: number
  apris_exkl_moms: string
  moms_procent: number
  moms_belopp: string
  totalt_inkl_moms: string
}

/** #4880: how many decimal digits of the transaction hash the number carries. */
export const RECEIPT_NUMBER_DIGITS = 16

/**
 * #4880: the receipt number of a payment settled on-chain, derived from its
 * settlement transaction hash alone: `FAK-` and the hash modulo 10^16 as
 * sixteen decimal digits, zero-padded.
 *
 * The same transaction always yields the same number, after a restart and in
 * a reconciliation script that has the hash and nothing else. No date is part
 * of it: the merchant knows the hash when it answers but not the block's
 * timestamp. Sixteen digits keep the OCR reference (digits plus a Luhn digit)
 * at 17 digits, inside the 25 a Swedish OCR allows.
 */
export function receiptNumberForTransaction(txHash: HexString): string {
  const digits = (BigInt(txHash) % 10n ** BigInt(RECEIPT_NUMBER_DIGITS)).toString().padStart(RECEIPT_NUMBER_DIGITS, '0')
  return `FAK-${digits}`
}

/**
 * The VAT split of a VAT-inclusive price, in USDC base units. #4880: shared
 * with the demo merchant's Stripe record, so its `vat_amount` is the
 * receipt's VAT amount, never a second computation.
 */
export function vatAmountsAtomic(
  priceAtomic: bigint,
  treatment: VatTreatment,
): { exclVat: bigint; vat: bigint; vatPercent: number } {
  // #4855: under `REVERSE_CHARGE` the full price is the net amount, the VAT
  // rate is 0 and the VAT amount is zero (owner decision, 2026-11-16). Under
  // `SE_25` the price is VAT-inclusive: exkl. moms = inkl. moms / 1.25.
  if (treatment === 'REVERSE_CHARGE') return { exclVat: priceAtomic, vat: 0n, vatPercent: 0 }
  const exclVat = (priceAtomic * 100n) / 125n
  return { exclVat, vat: priceAtomic - exclVat, vatPercent: 25 }
}

/**
 * USDC base units as a decimal string at full six-decimal precision, trailing
 * zeros stripped (`500n` → `0.0005`). Pure bigint math (#1279). The same
 * formatting as the demo merchant's `formatUsdc`, which the receipt used.
 */
export function formatUsdcAtomic(units: bigint): string {
  const negative = units < 0n
  const abs = negative ? -units : units
  const whole = abs / 1_000_000n
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/**
 * Luhn (modulus 10) check digit to APPEND to `base`.
 *
 * #3422: the digit is computed before it exists, so the RIGHTMOST digit of
 * the base is the first one doubled. The validating form of the same
 * algorithm starts one position further left, because there the rightmost
 * digit is the check digit itself.
 */
function luhnCheckDigit(base: string): number {
  let sum = 0
  let double = true
  for (let i = base.length - 1; i >= 0; i--) {
    let d = parseInt(base[i], 10)
    if (double) d *= 2
    if (d > 9) d -= 9
    sum += d
    double = !double
  }
  return (10 - (sum % 10)) % 10
}

/** The OCR reference: the receipt number's digits plus a Luhn check digit. */
export function generateOcr(invoiceNumber: string): string {
  const base = invoiceNumber.replace(/\D/g, '')
  return `${base}${luhnCheckDigit(base)}`
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

const STATUS_SV: Record<ReceiptSettlementState, ReceiptStatusSv> = {
  settled_onchain: 'Betald',
  already_settled_earlier: 'Betald i tidigare transaktion — referens saknas',
  settlement_unknown: 'Levererad — ej bekräftad på kedjan',
}

const STATUS_BY_SETTLEMENT: Record<ReceiptLocale, Record<ReceiptSettlementState, InvoiceJson['status']>> = {
  sv: STATUS_SV,
  en: {
    settled_onchain: 'Paid',
    already_settled_earlier: 'Paid in an earlier transaction — reference unavailable',
    settlement_unknown: 'Delivered — not confirmed on-chain',
  },
}

const BILLING_PERIOD: Record<ReceiptLocale, Record<ReceiptBillingPeriod, string>> = {
  sv: { monthly: '1 månad', one_time: 'engångsköp' },
  en: { monthly: '1 month', one_time: 'one-time purchase' },
}

/** The receipt's line text: `<name> — <description>`, plus the period when given. */
export function receiptLineText(line: ReceiptLine, locale: ReceiptLocale = 'sv'): string {
  const base = `${line.name} — ${line.description}`
  return line.billingPeriod ? `${base} (${BILLING_PERIOD[locale][line.billingPeriod]})` : base
}

/** Build the receipt document for one settled payment. */
export function buildReceipt(params: ReceiptParams): InvoiceJson {
  const locale: ReceiptLocale = params.locale ?? 'sv'
  const today = params.now ? new Date(params.now.getTime()) : new Date()
  const dueDate = new Date(today)
  dueDate.setDate(dueDate.getDate() + 30)

  // #4855: the treatment is display-only and never changes the price.
  const declaration = params.taxDeclaration ?? null
  const treatment = vatTreatmentFor(declaration, params.vatRule)
  // #4873: display-only too, and absent when the request carried none.
  const checkout = params.checkoutDetails ?? null

  const totalInclMoms = params.line.priceAtomic
  const { exclVat: exklMoms, vat: momsBelopp, vatPercent: momsProcent } = vatAmountsAtomic(totalInclMoms, treatment)

  // #2969: only a REAL on-chain settlement gets a reference. Both non-settled
  // states get `null`, never the zero hash.
  const blockRef = params.settlement === 'settled_onchain' ? `Tx: ${params.txHash}` : null

  const row: InvoiceRow = {
    beskrivning: receiptLineText(params.line, locale),
    antal: 1,
    apris_exkl_moms: formatUsdcAtomic(exklMoms),
    moms_procent: momsProcent,
    moms_belopp: formatUsdcAtomic(momsBelopp),
    totalt_inkl_moms: formatUsdcAtomic(totalInclMoms),
  }

  return {
    fakturanummer: params.invoiceNumber,
    fakturadatum: isoDate(today),
    forfallodatum: isoDate(dueDate),
    ocr_nummer: generateOcr(params.invoiceNumber),
    saljare: { ...params.seller, crypto_address: params.receivingAddress },
    kopare: {
      identifierare: params.buyerAddress,
      typ: 'blockkedjeadress',
      roll: params.payerRole,
      // #4855: absent when there is no accepted declaration, so a receipt
      // without one keeps its exact shape.
      ...(declaration ? { deklaration: buyerDeclarationBlock(declaration) } : {}),
      // #4873: absent when the paid request carried no checkout details, so a
      // receipt without them keeps its exact shape.
      ...(checkout?.receiptEmail ? { receipt_email: checkout.receiptEmail } : {}),
      ...(checkout?.billingAddress ? { billing_address: checkout.billingAddress } : {}),
      ...(checkout?.shippingAddress ? { shipping_address: checkout.shippingAddress } : {}),
    },
    rader: [row],
    belopp_exkl_moms: formatUsdcAtomic(exklMoms),
    moms_procent: momsProcent,
    moms_belopp: formatUsdcAtomic(momsBelopp),
    totalt_inkl_moms: formatUsdcAtomic(totalInclMoms),
    momsbehandling: treatment,
    valuta: 'USDC',
    betalningssatt:
      locale === 'sv' ? `Kryptovaluta (USDC på ${params.network.sv})` : `Cryptocurrency (USDC on ${params.network.en})`,
    blockkedje_referens: blockRef,
    status: STATUS_BY_SETTLEMENT[locale][params.settlement],
  }
}

/** #4855: the four declaration fields the buyer block shows. */
function buyerDeclarationBlock(declaration: AcceptedTaxDeclaration): BuyerDeclaration {
  return {
    land: declaration.jurisdiction,
    moms_nr: declaration.taxId,
    status: declaration.taxableStatus,
    giltig_till: isoDate(new Date(declaration.validUntil)),
  }
}

/** What the rendered text needs beyond the document itself. */
export interface ReceiptTextOptions {
  /** The product name in the closing thank-you line. */
  productName: string
  locale: ReceiptLocale
  /**
   * The network, the same value the receipt was built with. The Swedish
   * render reads `betalningssatt`; the English render names `network.en`.
   */
  network: ReceiptNetwork
  /** Where the buyer asks questions; printed on the last line. */
  supportContact: string
}

/**
 * Locale-aware human-readable render of the SAME `InvoiceJson` (#1550). This
 * chooses the language of the headings and labels around the document's
 * values; the values are in the language the document was built in (#4980).
 * `sv` is the classic FAKTURA render.
 */
export function renderReceiptText(inv: InvoiceJson, opts: ReceiptTextOptions): string {
  return opts.locale === 'sv'
    ? buildReceiptTextSv(inv, opts.productName, opts.supportContact)
    : buildReceiptTextEn(inv, opts.productName, opts.network.en, opts.supportContact)
}

/**
 * #2969: the blockchain reference section is present only when there is a
 * real one to show; the heading, value and trailing blank line are omitted
 * entirely when `blockkedje_referens` is `null`.
 */
function blockchainReferenceSection(inv: InvoiceJson, heading: string): string {
  if (inv.blockkedje_referens === null) return ''
  return `${heading}\n  ${inv.blockkedje_referens}\n\n`
}

function buildReceiptTextSv(inv: InvoiceJson, productName: string, supportContact: string): string {
  const row = inv.rader[0]
  return `
════════════════════════════════════════════════════════════
                         FAKTURA
════════════════════════════════════════════════════════════

SÄLJARE
  ${inv.saljare.name}
  ${inv.saljare.address}
  Org.nr:       ${inv.saljare.org_nr}
  Momsreg.nr:   ${inv.saljare.moms_nr}

KÖPARE
  Blockkedjeadress: ${inv.kopare.identifierare}
${buyerCheckoutLinesSv(inv)}${buyerDeclarationLinesSv(inv)}
────────────────────────────────────────────────────────────
  Fakturanummer:   ${inv.fakturanummer}
  Fakturadatum:    ${inv.fakturadatum}
  Förfallodatum:   ${inv.forfallodatum}
  OCR-nummer:      ${inv.ocr_nummer}
────────────────────────────────────────────────────────────

TJÄNSTER

  ${row.beskrivning}
  Antal: ${row.antal}  Á-pris exkl. moms: ${row.apris_exkl_moms} USDC

────────────────────────────────────────────────────────────
  Belopp exkl. moms:   ${inv.belopp_exkl_moms} USDC
  Moms ${inv.moms_procent}%:              ${inv.moms_belopp} USDC
  TOTALT inkl. moms:   ${inv.totalt_inkl_moms} USDC
${reverseChargeLinesSv(inv)}────────────────────────────────────────────────────────────

  Valuta:           ${inv.valuta}
  Betalningssätt:   ${inv.betalningssatt}
  Mottagaradress:   ${inv.saljare.crypto_address}

${blockchainReferenceSection(inv, 'BLOCKKEDJEREFERENS')}  Status: ${inv.status}

════════════════════════════════════════════════════════════
  Tack för ditt köp av ${productName}!
  Frågor: ${supportContact}
════════════════════════════════════════════════════════════
`.trimStart()
}

/**
 * #4873: the checkout-details lines, Swedish render. Empty when the paid
 * request carried none, so every other receipt keeps its exact bytes.
 */
function buyerCheckoutLinesSv(inv: InvoiceJson): string {
  const k = inv.kopare
  let out = ''
  if (k.receipt_email) out += `  E-post:           ${k.receipt_email}\n`
  if (k.billing_address) out += `  Fakturaadress:\n${addressLines(k.billing_address, '    ')}`
  if (k.shipping_address) out += `  Leveransadress:\n${addressLines(k.shipping_address, '    ')}`
  return out
}

/** #4873: the checkout-details lines, English render. Empty when none. */
function buyerCheckoutLinesEn(inv: InvoiceJson): string {
  const k = inv.kopare
  let out = ''
  if (k.receipt_email) out += `  Email: ${k.receipt_email}\n`
  if (k.billing_address) out += `  Billing address:\n${addressLines(k.billing_address, '    ')}`
  if (k.shipping_address) out += `  Shipping address:\n${addressLines(k.shipping_address, '    ')}`
  return out
}

/**
 * #4873: one address, one line per member, in the order §2 documents. An
 * absent optional member prints nothing; the postal code and the city share a
 * line, as an address is written.
 */
function addressLines(address: CheckoutAddress, indent: string): string {
  const lines = [address.line1, address.line2, address.line3].filter((line): line is string => Boolean(line))
  lines.push([address.postCode, address.city].filter((part): part is string => Boolean(part)).join(' '))
  if (address.subdivision) lines.push(address.subdivision)
  lines.push(address.country)
  return lines.map((line) => `${indent}${line}\n`).join('')
}

/** #4855: the declaration lines, Swedish render. Empty without a declaration. */
function buyerDeclarationLinesSv(inv: InvoiceJson): string {
  const d = inv.kopare.deklaration
  if (!d) return ''
  return (
    `  Land:             ${d.land}\n` +
    `  Momsreg.nr:       ${d.moms_nr}\n` +
    `  Status:           ${d.status}\n` +
    `  Deklaration giltig till: ${d.giltig_till}\n`
  )
}

/** #4855: the reverse-charge note, Swedish render. Names BOTH VAT numbers. */
function reverseChargeLinesSv(inv: InvoiceJson): string {
  const d = inv.kopare.deklaration
  if (inv.momsbehandling !== 'REVERSE_CHARGE' || !d) return ''
  return (
    `  Omvänd betalningsskyldighet (reverse charge) — köparen redovisar momsen.\n` +
    `  Säljarens momsreg.nr: ${inv.saljare.moms_nr}\n` +
    `  Köparens momsreg.nr: ${d.moms_nr}\n`
  )
}

/**
 * The English render's status line. #4980: an English document's status is
 * already English and prints as it is; a Swedish one is translated, as
 * before.
 */
const STATUS_EN: Record<InvoiceJson['status'], ReceiptStatusEn> = {
  Betald: 'Paid',
  'Betald i tidigare transaktion — referens saknas': 'Paid in an earlier transaction — reference unavailable',
  'Levererad — ej bekräftad på kedjan': 'Delivered — not confirmed on-chain',
  Paid: 'Paid',
  'Paid in an earlier transaction — reference unavailable': 'Paid in an earlier transaction — reference unavailable',
  'Delivered — not confirmed on-chain': 'Delivered — not confirmed on-chain',
}

function buildReceiptTextEn(inv: InvoiceJson, productName: string, networkEn: string, supportContact: string): string {
  const row = inv.rader[0]
  return `
════════════════════════════════════════════════════════════
                         INVOICE
════════════════════════════════════════════════════════════

SELLER
  ${inv.saljare.name}
  ${inv.saljare.address}
  Org. no:      ${inv.saljare.org_nr}
  VAT reg. no:  ${inv.saljare.moms_nr}

PAYER
  Blockchain address: ${inv.kopare.identifierare}
  Role: ${inv.kopare.roll === 'agent_delegate_account' ? 'agent delegate account (erc7710 delegator) — paid on behalf of an owner treasury account not visible to this merchant' : 'agent delegate address (eip3009)'}
${buyerCheckoutLinesEn(inv)}${buyerDeclarationLinesEn(inv)}
────────────────────────────────────────────────────────────
  Invoice number:  ${inv.fakturanummer}
  Invoice date:    ${inv.fakturadatum}
  Due date:        ${inv.forfallodatum}
  OCR number:      ${inv.ocr_nummer}
────────────────────────────────────────────────────────────

SERVICES

  ${row.beskrivning}
  Quantity: ${row.antal}  Unit price excl. VAT: ${row.apris_exkl_moms} USDC

────────────────────────────────────────────────────────────
  Amount excl. VAT:    ${inv.belopp_exkl_moms} USDC
  VAT ${inv.moms_procent}%:             ${inv.moms_belopp} USDC
  TOTAL incl. VAT:     ${inv.totalt_inkl_moms} USDC
${reverseChargeLinesEn(inv)}────────────────────────────────────────────────────────────

  Currency:          ${inv.valuta}
  Payment method:    Cryptocurrency (USDC on ${networkEn})
  Recipient address: ${inv.saljare.crypto_address}

${blockchainReferenceSection(inv, 'BLOCKCHAIN REFERENCE')}  Status: ${STATUS_EN[inv.status]}

════════════════════════════════════════════════════════════
  Thank you for purchasing ${productName}!
  Questions: ${supportContact}
════════════════════════════════════════════════════════════
`.trimStart()
}

/** #4855: the declaration lines, English render. Empty without a declaration. */
function buyerDeclarationLinesEn(inv: InvoiceJson): string {
  const d = inv.kopare.deklaration
  if (!d) return ''
  return (
    `  Country: ${d.land}\n` +
    `  VAT reg. no: ${d.moms_nr}\n` +
    `  Status: ${d.status}\n` +
    `  Declaration valid until: ${d.giltig_till}\n`
  )
}

/** #4855: the reverse-charge note, English render. Names BOTH VAT numbers. */
function reverseChargeLinesEn(inv: InvoiceJson): string {
  const d = inv.kopare.deklaration
  if (inv.momsbehandling !== 'REVERSE_CHARGE' || !d) return ''
  return (
    `  Reverse charge — the buyer accounts for the VAT.\n` +
    `  Seller VAT reg. no: ${inv.saljare.moms_nr}\n` +
    `  Buyer VAT reg. no: ${d.moms_nr}\n`
  )
}
