import type { AccountingEntry } from './accounting-entry.js'
import { DEFAULT_SETTLEMENT_ACCOUNT, basAccountForCategory } from './bas-accounts.js'
import {
  REVERSE_CHARGE_INPUT_VAT_ACCOUNT,
  REVERSE_CHARGE_OUTPUT_VAT_ACCOUNT,
  reverseChargePurchaseAccount,
  reverseChargeVat,
} from './vat.js'

/**
 * Double-entry booking lines for one accounting entry (epic #462, P3 #466).
 *
 * The single source of truth for how a settled payment is booked — shared by
 * the SIE exporter and the Fortnox voucher mapper so they can never diverge.
 * Lines always balance (sum of debit === sum of credit).
 */
export interface BookingLine {
  account: string
  debit: number
  credit: number
}

/**
 * Build balanced booking lines. Returns null when the entry has no book-time
 * SEK value (unbookable).
 *
 * - reverse_charge (default, foreign suppliers): debit the EU-services purchase
 *   account + cash credit, plus self-accounted output/input VAT (net zero cash).
 * - standard/none: debit the category expense account + cash credit. VAT is not
 *   split here (we lack the domestic rate / inclusive flag) — left for the
 *   accountant; the treatment is flagged on the entry.
 */
export function buildBookingLines(entry: AccountingEntry): BookingLine[] | null {
  if (entry.amountSek == null) return null
  const amount = Number(entry.amountSek)
  if (!Number.isFinite(amount)) return null

  const settlement = DEFAULT_SETTLEMENT_ACCOUNT

  if (entry.vatTreatment === 'reverse_charge') {
    const vat = reverseChargeVat(amount)
    const purchaseAccount = entry.account ?? reverseChargePurchaseAccount(entry.counterparty.country)
    return [
      { account: purchaseAccount, debit: amount, credit: 0 },
      { account: settlement, debit: 0, credit: amount },
      { account: REVERSE_CHARGE_INPUT_VAT_ACCOUNT, debit: vat, credit: 0 },
      { account: REVERSE_CHARGE_OUTPUT_VAT_ACCOUNT, debit: 0, credit: vat },
    ]
  }

  return [
    { account: entry.account ?? basAccountForCategory(entry.category), debit: amount, credit: 0 },
    { account: settlement, debit: 0, credit: amount },
  ]
}
