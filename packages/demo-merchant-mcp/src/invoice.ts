import type { MerchantLocale, ProductId } from './products.js'
import { PRODUCTS, formatUsdc } from './products.js'
import type { SettledPayment, SettlementState } from './x402.js'

// #1550: the invoice DOCUMENT (`InvoiceJson` + its Swedish text render) is a
// Swedish bookkeeping artifact by design — it feeds the `x-receipt-json`
// header and downstream accounting fixtures (Fortnox / receipt-underlag), so
// the display-locale switch never touches it: keys, values, and `beskrivning`
// stay Swedish regardless of the buyer-facing locale. Only the human-readable
// render gains an English variant, via `renderInvoiceText`.

// ── Merchant identity ────────────────────────────────────────────────────────
const MERCHANT = {
  name: 'Haven Demo AB',
  address: 'Birger Jarlsgatan 57, 113 56 Stockholm',
  org_nr: '559412-3456',
  moms_nr: 'SE559412345601',
  iban: 'SE35 5000 0000 0549 1000 0003',
  bic: 'ESSESESS',
  /** USDC on Base — our merchant wallet */
  crypto_address: process.env.MERCHANT_ADDRESS ?? '0x0000000000000000000000000000000000000000',
}

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
    return `FAK-${year}-${String(invoiceSeq).padStart(5, '0')}`
  }
}

const nextInvoiceNumber = createInvoiceNumberer()

/** Luhn-based check digit for Swedish OCR. */
function luhnCheck(digits: string): number {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = parseInt(digits[i], 10)
    if (double) d *= 2
    if (d > 9) d -= 9
    sum += d
    double = !double
  }
  return (10 - (sum % 10)) % 10
}

function generateOcr(invoiceNumber: string): string {
  // Use numeric part of invoice number as OCR base
  const base = invoiceNumber.replace(/\D/g, '')
  const check = luhnCheck(base)
  return `${base}${check}`
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export interface InvoiceParams {
  invoiceNumber: string
  productId: ProductId
  buyerAddress: string
  /**
   * #2960: which party `buyerAddress` actually is. The merchant only ever
   * observes the address it verified the payment FROM — the delegate EOA on
   * `eip3009`, the delegate SMART account (`delegator`) on `erc7710` — never
   * the owner's treasury account, which is not knowable merchant-side (it
   * never appears in the x402 payload on either scheme). This is what
   * carries that distinction onto the invoice instead of an unqualified
   * "buyer".
   */
  payerRole: 'agent_delegate' | 'agent_delegate_account'
  /** EIP-3009 authorization nonce (hex bytes32) */
  authorizationNonce: string
  /** The wire hash — rendered only when `settlement === 'settled_onchain'`
   *  (the zero hash on the two non-settled states, never printed). */
  txHash: string
  /** #2969: explicit settlement truth — see `SettlementState`. */
  settlement: SettlementState
}

export interface Invoice {
  /** Structured data optimised for Swedish bookkeeping / accounting systems */
  json: InvoiceJson
  /** Human-readable Swedish invoice text */
  text: string
}

export interface InvoiceJson {
  fakturanummer: string
  fakturadatum: string
  forfallodatum: string
  ocr_nummer: string
  saljare: typeof MERCHANT
  kopare: {
    identifierare: string
    typ: 'blockkedjeadress'
    /**
     * #2960, additive — which party `identifierare` is (see
     * `InvoiceParams.payerRole`). Never read by `buildInvoiceText` (the
     * Swedish render stays byte-for-byte per #1550); the English render
     * uses it to avoid calling a delegate address "the buyer".
     */
    roll: 'agent_delegate' | 'agent_delegate_account'
  }
  rader: InvoiceRow[]
  belopp_exkl_moms: string
  moms_procent: number
  moms_belopp: string
  totalt_inkl_moms: string
  valuta: 'USDC'
  betalningssatt: 'Kryptovaluta (USDC på Base)'
  /**
   * #2969: `null` on both non-settled states — never the zero hash. Only
   * `settlement === 'settled_onchain'` carries a real transaction reference.
   */
  blockkedje_referens: string | null
  /**
   * #2969: 'Betald' only for `settlement === 'settled_onchain'`. The other
   * two `SettlementState`s each get their own honest status — 'already
   * settled earlier, no reference' is distinct from 'delivered, unconfirmed'.
   */
  status: 'Betald' | 'Betald i tidigare transaktion — referens saknas' | 'Levererad — ej bekräftad på kedjan'
}

interface InvoiceRow {
  beskrivning: string
  antal: number
  apris_exkl_moms: string
  moms_procent: number
  moms_belopp: string
  totalt_inkl_moms: string
}

const STATUS_BY_SETTLEMENT: Record<SettlementState, InvoiceJson['status']> = {
  settled_onchain: 'Betald',
  already_settled_earlier: 'Betald i tidigare transaktion — referens saknas',
  settlement_unknown: 'Levererad — ej bekräftad på kedjan',
}

export function generateInvoice(params: InvoiceParams): Invoice {
  const product = PRODUCTS[params.productId]
  const today = new Date()
  const dueDate = new Date(today)
  dueDate.setDate(dueDate.getDate() + 30)

  const totalInclMoms = product.price_usdc
  // VAT is 25%; price_usdc is VAT-inclusive for simplicity
  // exkl. moms = inkl. moms / 1.25
  const exklMoms = (totalInclMoms * 100n) / 125n
  const momsBelopp = totalInclMoms - exklMoms

  // #2969: only a REAL on-chain settlement gets a reference. Both non-settled
  // states get `null` — never the zero hash, and never a fallback nonce
  // dressed up as a reference for a transaction that may not exist at all
  // (`already_settled_earlier` names no hash this process observed).
  const blockRef = params.settlement === 'settled_onchain' ? `Tx: ${params.txHash}` : null

  const ocr = generateOcr(params.invoiceNumber)

  const row: InvoiceRow = {
    // Always the SWEDISH description — this is the bookkeeping document, not
    // the display surface (#1550, see module comment).
    beskrivning: `${product.name} — ${product.description_sv} (1 månad)`,
    antal: 1,
    apris_exkl_moms: formatUsdc(exklMoms),
    moms_procent: 25,
    moms_belopp: formatUsdc(momsBelopp),
    totalt_inkl_moms: formatUsdc(totalInclMoms),
  }

  const json: InvoiceJson = {
    fakturanummer: params.invoiceNumber,
    fakturadatum: isoDate(today),
    forfallodatum: isoDate(dueDate),
    ocr_nummer: ocr,
    saljare: MERCHANT,
    kopare: {
      identifierare: params.buyerAddress,
      typ: 'blockkedjeadress',
      roll: params.payerRole,
    },
    rader: [row],
    belopp_exkl_moms: formatUsdc(exklMoms),
    moms_procent: 25,
    moms_belopp: formatUsdc(momsBelopp),
    totalt_inkl_moms: formatUsdc(totalInclMoms),
    valuta: 'USDC',
    betalningssatt: 'Kryptovaluta (USDC på Base)',
    blockkedje_referens: blockRef,
    status: STATUS_BY_SETTLEMENT[params.settlement],
  }

  const text = buildInvoiceText(json, product.name)

  return { json, text }
}

/**
 * #2969: the blockchain reference section is present only when there is a
 * real one to show (`settlement === 'settled_onchain'`). Printing the zero
 * hash for the other two states was the bug this issue exists to fix — the
 * fix is to say nothing rather than print a fake reference, so the section
 * (heading + value + trailing blank line) is omitted entirely when
 * `blockkedje_referens` is `null`.
 */
function blockchainReferenceSection(inv: InvoiceJson, heading: string): string {
  if (inv.blockkedje_referens === null) return ''
  return `${heading}\n  ${inv.blockkedje_referens}\n\n`
}

function buildInvoiceText(inv: InvoiceJson, productName: string): string {
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
────────────────────────────────────────────────────────────

  Valuta:           ${inv.valuta}
  Betalningssätt:   ${inv.betalningssatt}
  Mottagaradress:   ${inv.saljare.crypto_address}

${blockchainReferenceSection(inv, 'BLOCKKEDJEREFERENS')}  Status: ${inv.status}

════════════════════════════════════════════════════════════
  Tack för ditt köp av ${productName}!
  Frågor: support@haven.xyz
════════════════════════════════════════════════════════════
`.trimStart()
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
): string {
  return locale === 'sv' ? buildInvoiceText(inv, productName) : buildInvoiceTextEn(inv, productName)
}

const STATUS_EN: Record<InvoiceJson['status'], string> = {
  Betald: 'Paid',
  'Betald i tidigare transaktion — referens saknas': 'Paid in an earlier transaction — reference unavailable',
  'Levererad — ej bekräftad på kedjan': 'Delivered — not confirmed on-chain',
}

function buildInvoiceTextEn(inv: InvoiceJson, productName: string): string {
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
────────────────────────────────────────────────────────────

  Currency:          ${inv.valuta}
  Payment method:    Cryptocurrency (USDC on Base)
  Recipient address: ${inv.saljare.crypto_address}

${blockchainReferenceSection(inv, 'BLOCKCHAIN REFERENCE')}  Status: ${STATUS_EN[inv.status]}

════════════════════════════════════════════════════════════
  Thank you for purchasing ${productName}!
  Questions: support@haven.xyz
════════════════════════════════════════════════════════════
`.trimStart()
}

export { nextInvoiceNumber }

// ── Per-payment invoice cache (#956) ─────────────────────────────────────────
//
// The invoice is now needed in TWO places for the same settled payment: the
// HTTP layer sets it as the machine-readable `x-receipt-json` response header
// (so a paying agent can capture the merchant's own receipt), and the MCP tool
// handler renders it in the confirmation text. One generation per payment
// keeps the two identical — and repeat tool calls replay the same invoice.
const invoicesByPayment = new WeakMap<SettledPayment, Invoice>()

export function invoiceForPayment(payment: SettledPayment, productId: ProductId): Invoice {
  const cached = invoicesByPayment.get(payment)
  if (cached) return cached
  const invoice = generateInvoice({
    invoiceNumber: nextInvoiceNumber(),
    productId,
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
