import type { ProductId } from './products.js'
import { PRODUCTS, formatUsdc } from './products.js'

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

// In-memory invoice counter — resets on restart (fine for demo).
let invoiceSeq = 1000

function nextInvoiceNumber(): string {
  invoiceSeq++
  const year = new Date().getFullYear()
  return `FAK-${year}-${String(invoiceSeq).padStart(5, '0')}`
}

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
  /** EIP-3009 authorization nonce (hex bytes32) */
  authorizationNonce: string
  /** Tx hash if settled, otherwise undefined */
  txHash?: string
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
  }
  rader: InvoiceRow[]
  belopp_exkl_moms: string
  moms_procent: number
  moms_belopp: string
  totalt_inkl_moms: string
  valuta: 'USDC'
  betalningssatt: 'Kryptovaluta (USDC på Base)'
  blockkedje_referens: string
  status: 'Betald'
}

interface InvoiceRow {
  beskrivning: string
  antal: number
  apris_exkl_moms: string
  moms_procent: number
  moms_belopp: string
  totalt_inkl_moms: string
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

  const blockRef = params.txHash
    ? `Tx: ${params.txHash}`
    : `EIP-3009 nonce: ${params.authorizationNonce}`

  const ocr = generateOcr(params.invoiceNumber)

  const row: InvoiceRow = {
    beskrivning: `${product.name} — ${product.description} (1 månad)`,
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
    },
    rader: [row],
    belopp_exkl_moms: formatUsdc(exklMoms),
    moms_procent: 25,
    moms_belopp: formatUsdc(momsBelopp),
    totalt_inkl_moms: formatUsdc(totalInclMoms),
    valuta: 'USDC',
    betalningssatt: 'Kryptovaluta (USDC på Base)',
    blockkedje_referens: blockRef,
    status: 'Betald',
  }

  const text = buildInvoiceText(json, product.name)

  return { json, text }
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

BLOCKKEDJEREFERENS
  ${inv.blockkedje_referens}

  Status: ${inv.status}

════════════════════════════════════════════════════════════
  Tack för ditt köp av ${productName}!
  Frågor: support@haven.xyz
════════════════════════════════════════════════════════════
`.trimStart()
}

export { nextInvoiceNumber }
