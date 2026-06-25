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
/** Purchase of services from outside the EU (BAS). */
export const REVERSE_CHARGE_PURCHASE_ACCOUNT_NON_EU = '4537'
/** Output VAT, reverse charge, 25% (BAS). */
export const REVERSE_CHARGE_OUTPUT_VAT_ACCOUNT = '2614'
/** Calculated input VAT on foreign acquisitions (BAS). */
export const REVERSE_CHARGE_INPUT_VAT_ACCOUNT = '2645'

export const VAT_ACCOUNT_NAMES: Record<string, string> = {
  '4535': 'Inköp av tjänster annat EU-land, 25%',
  '4537': 'Inköp av tjänster utanför EU',
  '2614': 'Utgående moms omvänd skattskyldighet, 25%',
  '2645': 'Beräknad ingående moms på förvärv från utlandet',
}

/** The seller's home country for VAT purposes. */
export const HOME_COUNTRY = 'SE'

/** EU member states (ISO 3166-1 alpha-2), excluding SE (the home country). */
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES',
])

function normalizeCountry(country: string | null | undefined): string | null {
  if (!country) return null
  const c = country.trim().toUpperCase()
  return c.length === 2 ? c : null
}

/**
 * VAT treatment for a supplier country (#466):
 * - SE → standard (domestic; the export flags it for the accountant rather than
 *   guessing an inclusive rate).
 * - any other / unknown → reverse charge (the dominant agent-spend case).
 */
export function vatTreatmentForCountry(
  country: string | null | undefined,
): 'standard' | 'reverse_charge' {
  return normalizeCountry(country) === HOME_COUNTRY ? 'standard' : 'reverse_charge'
}

/**
 * The BAS purchase account for a reverse-charge entry: EU vs outside-EU. Unknown
 * country defaults to the EU account (the flagged default) so behaviour is
 * unchanged until country data is populated.
 */
export function reverseChargePurchaseAccount(country: string | null | undefined): string {
  const c = normalizeCountry(country)
  if (c && !EU_COUNTRIES.has(c) && c !== HOME_COUNTRY) {
    return REVERSE_CHARGE_PURCHASE_ACCOUNT_NON_EU
  }
  return REVERSE_CHARGE_PURCHASE_ACCOUNT
}

/** Reverse-charge VAT amount for a net base, rounded to öre. */
export function reverseChargeVat(baseSek: number): number {
  return Math.round(baseSek * REVERSE_CHARGE_VAT_RATE * 100) / 100
}
