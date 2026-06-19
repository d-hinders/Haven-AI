/**
 * VAT handling for bookkeeping export (epic #462, P3 #466).
 *
 * Agent spend is overwhelmingly foreign API/service purchases, which under
 * Swedish rules are reverse charge (omvänd skattskyldighet): the buyer self-
 * accounts both output and input VAT, which net to zero cash but must both be
 * booked for the VAT return. We use the EU-services BAS accounts as the default;
 * EU-vs-non-EU precision needs supplier country (not yet in the catalog), so the
 * treatment stays flagged and reviewable — the accountant confirms.
 */
export const REVERSE_CHARGE_VAT_RATE = 0.25

/** Purchase of services from another EU country, 25% (BAS). */
export const REVERSE_CHARGE_PURCHASE_ACCOUNT = '4535'
/** Output VAT, reverse charge, 25% (BAS). */
export const REVERSE_CHARGE_OUTPUT_VAT_ACCOUNT = '2614'
/** Calculated input VAT on foreign acquisitions (BAS). */
export const REVERSE_CHARGE_INPUT_VAT_ACCOUNT = '2645'

export const VAT_ACCOUNT_NAMES: Record<string, string> = {
  '4535': 'Inköp av tjänster annat EU-land, 25%',
  '2614': 'Utgående moms omvänd skattskyldighet, 25%',
  '2645': 'Beräknad ingående moms på förvärv från utlandet',
}

/** Reverse-charge VAT amount for a net base, rounded to öre. */
export function reverseChargeVat(baseSek: number): number {
  return Math.round(baseSek * REVERSE_CHARGE_VAT_RATE * 100) / 100
}
