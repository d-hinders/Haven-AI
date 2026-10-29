/**
 * ISO 3166-1 alpha-2 — the officially ASSIGNED code elements (#4359).
 *
 * `Intl.DisplayNames` renders the labels in the user's locale but cannot
 * enumerate codes, so the list is hard-coded here (249 entries, sorted by
 * code; the picker itself re-sorts by label). This is the ASSIGNED list —
 * not every well-formed two-letter string: the backend accepts any
 * `^[A-Z]{2}$` (`owner-company-details.md` § What is stored) and a row saved
 * outside this list ("UK", "EL", "XI", "XK") must still display, so
 * `optionsForCountry` appends such a code as its own option labelled with
 * the code itself and it round-trips unchanged.
 */

// ISO 3166-1 alpha-2, officially assigned (2026-10 cut). Verified count 249.
const ASSIGNED_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const

export type CountryOption = { value: string; label: string }

const displayNames = new Intl.DisplayNames(undefined, { type: 'region' })
const CODE_SET = new Set<string>(ASSIGNED_CODES)

/** `Intl.DisplayNames` falls back to the code itself for anything it cannot name. */
export function countryLabel(code: string): string {
  return displayNames.of(code.toUpperCase()) ?? code.toUpperCase()
}

/**
 * The picker's options: every assigned code, labelled in the user's locale
 * and sorted by label — plus, when the SAVED country is not in the list, one
 * extra option for it labelled with the raw code so the stored value stays
 * selectable and round-trips unchanged (#4359).
 */
export function countryOptions(savedCountry: string | null | undefined): CountryOption[] {
  const options: CountryOption[] = ASSIGNED_CODES.map((code) => ({ value: code, label: countryLabel(code) }))
  options.sort((a, b) => a.label.localeCompare(b.label))
  const saved = savedCountry?.toUpperCase() ?? ''
  if (saved !== '' && !CODE_SET.has(saved)) {
    // Sorted by label like the rest — the code IS its label, so it lands
    // among the labels that start with those letters, deterministically.
    options.push({ value: saved, label: saved })
    options.sort((a, b) => a.label.localeCompare(b.label))
  }
  return options
}
