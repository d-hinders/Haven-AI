/**
 * The product lines and VAT figures a merchant states on its own receipt
 * (#4875, epic #4874) — read, never derived.
 *
 * The shape is the one the demo merchant sends in its `x-receipt-json`
 * header (`packages/demo-merchant-mcp/src/invoice.ts`, `InvoiceJson`), a
 * Swedish bookkeeping document: `rader[]`, the four totals, `momsbehandling`
 * and `valuta`. `docs/operations/merchant-receipt-shape.md` documents it field
 * by field as the shape Haven reads.
 *
 * **Strict and bounded.** A receipt either matches the shape, and every stated
 * line and total comes back, or it does not, and the answer is `null` — "not
 * stated". There is no partial read: a receipt with one malformed line yields
 * no lines at all, never the well-formed ones, because a partial list would
 * read as the whole purchase. It never throws.
 *
 * **Tolerant of additions.** Only the keys below are read. Any other key — at
 * the top level or on a line — is ignored, so a merchant that adds a field
 * (a SEK block, an order id, more seller details, a new invoice-number
 * format) is still read. Merchant-stated SEK figures in particular are NOT
 * read: the SEK value Haven books is its own, frozen at settlement.
 *
 * **Scoped.** Only top-level keys and `rader[]` are read. The buyer block
 * (`kopare`, including `kopare.deklaration.moms_nr`, the BUYER's VAT number)
 * and the seller block are never consulted here; the seller block has its own
 * reader (`sellerFromMerchantReceipt`).
 *
 * **A stated zero is stated.** A reverse-charge receipt carries
 * `moms_procent: 0` and `moms_belopp: "0"` — that is a VAT figure of zero, not
 * a missing one.
 *
 * **Who supplies it.** The receipt is relayed by the agent
 * (`POST /machine-payments/:id/merchant-receipt`), unsigned by the merchant.
 * This module reports what the receipt says; how a document labels it is
 * #4876's decision, and nothing here treats the figures as verified.
 */

/** The most lines read off one receipt; more and the receipt is not stated. */
export const RECEIPT_STATEMENT_MAX_LINES = 50
/** The longest line description read, in characters, after trimming. */
export const RECEIPT_STATEMENT_MAX_TEXT = 300
/** The longest stated currency or VAT-treatment code. */
const MAX_CODE = 32

export interface ReceiptStatementLine {
  /** `beskrivning`, trimmed, as stated. */
  description: string
  /** `antal`. */
  quantity: number
  /** `apris_exkl_moms`, a non-negative decimal string, as stated. */
  unitPriceExclVat: string
  /** `moms_procent`, 0–100. */
  vatPercent: number
  /** `moms_belopp`, a non-negative decimal string. */
  vatAmount: string
  /** `totalt_inkl_moms`, a non-negative decimal string. */
  totalInclVat: string
}

export interface ReceiptStatement {
  /** `valuta`, upper-cased — the currency every stated amount is in. */
  currency: string
  /**
   * `momsbehandling`: the MERCHANT's VAT treatment code (e.g. `SE_25`,
   * `REVERSE_CHARGE`), as stated; null when the receipt states none. Never
   * Haven's own derived treatment.
   */
  merchantVatTreatment: string | null
  lines: ReceiptStatementLine[]
  totals: {
    /** `belopp_exkl_moms`. */
    exclVat: string
    /** `moms_procent`. */
    vatPercent: number
    /** `moms_belopp`. */
    vatAmount: string
    /** `totalt_inkl_moms`. */
    inclVat: string
  }
}

/** A non-negative decimal: digits, optionally a point and more digits. */
const DECIMAL = /^\d{1,30}(\.\d{1,30})?$/
/** An upper-case code: `USDC`, `SE_25`, `REVERSE_CHARGE`. */
const CODE = /^[A-Z][A-Z0-9_]*$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function amount(value: unknown): string | null {
  return typeof value === 'string' && DECIMAL.test(value) ? value : null
}

function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
}

function code(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toUpperCase()
  return trimmed.length > 0 && trimmed.length <= MAX_CODE && CODE.test(trimmed) ? trimmed : null
}

function line(value: unknown): ReceiptStatementLine | null {
  if (!isRecord(value)) return null
  const raw = value.beskrivning
  if (typeof raw !== 'string') return null
  const description = raw.trim()
  if (description.length === 0 || description.length > RECEIPT_STATEMENT_MAX_TEXT || CONTROL.test(description)) {
    return null
  }
  const quantity = value.antal
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) return null
  const unitPriceExclVat = amount(value.apris_exkl_moms)
  const vatPercent = percent(value.moms_procent)
  const vatAmount = amount(value.moms_belopp)
  const totalInclVat = amount(value.totalt_inkl_moms)
  if (unitPriceExclVat === null || vatPercent === null || vatAmount === null || totalInclVat === null) return null
  return { description, quantity, unitPriceExclVat, vatPercent, vatAmount, totalInclVat }
}

/**
 * The receipt's stated lines and VAT figures, or `null` when it states none
 * that can be read — no receipt, a receipt without `rader`, or any part of the
 * shape malformed. Never throws.
 */
export function receiptStatementFrom(inlineJson: unknown): ReceiptStatement | null {
  try {
    if (!isRecord(inlineJson)) return null
    const rader = inlineJson.rader
    if (!Array.isArray(rader) || rader.length === 0 || rader.length > RECEIPT_STATEMENT_MAX_LINES) return null
    const lines: ReceiptStatementLine[] = []
    for (const raw of rader) {
      const parsed = line(raw)
      if (parsed === null) return null
      lines.push(parsed)
    }
    const currency = code(inlineJson.valuta)
    const exclVat = amount(inlineJson.belopp_exkl_moms)
    const vatPercent = percent(inlineJson.moms_procent)
    const vatAmount = amount(inlineJson.moms_belopp)
    const inclVat = amount(inlineJson.totalt_inkl_moms)
    if (currency === null || exclVat === null || vatPercent === null || vatAmount === null || inclVat === null) {
      return null
    }
    // Absent is fine (a merchant may state no treatment); present and
    // malformed is a malformed receipt.
    let merchantVatTreatment: string | null = null
    if (inlineJson.momsbehandling !== undefined && inlineJson.momsbehandling !== null) {
      merchantVatTreatment = code(inlineJson.momsbehandling)
      if (merchantVatTreatment === null) return null
    }
    return { currency, merchantVatTreatment, lines, totals: { exclVat, vatPercent, vatAmount, inclVat } }
  } catch {
    // A hostile getter or a proxy: a document that cannot be read is not stated.
    return null
  }
}

/** A non-negative decimal string as a fixed-point bigint at 30 places. */
function toFixed30(value: string): bigint | null {
  if (!DECIMAL.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(30, '0'))
}

/**
 * How the stated total compares with the amount Haven settled (#4875). It is
 * compared ONLY when the receipt's currency is the settled token — a SEK or
 * EUR total says nothing about a USDC transfer. The amount booked is always
 * Haven's settled amount; this only says whether the receipt agrees.
 */
export type ReceiptTotalCheck = 'matches' | 'differs' | 'not_comparable'

export function compareStatedTotal(
  statement: Pick<ReceiptStatement, 'currency' | 'totals'>,
  settledToken: string | null,
  settledAmountHuman: string | null,
): ReceiptTotalCheck {
  if (settledToken === null || settledAmountHuman === null) return 'not_comparable'
  if (statement.currency !== settledToken.trim().toUpperCase()) return 'not_comparable'
  const stated = toFixed30(statement.totals.inclVat)
  const settled = toFixed30(settledAmountHuman.trim())
  if (stated === null || settled === null) return 'not_comparable'
  return stated === settled ? 'matches' : 'differs'
}
