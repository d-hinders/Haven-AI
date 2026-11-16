import {
  principalAttributionHash,
  verifyTaxDeclarationSignature,
  type SignedTaxDeclaration,
} from '@haven_ai/sdk/edge'

/**
 * #4855: the buyer's signed tax declaration, as the demo merchant reads it off
 * a paid request, and the VAT treatment it implies.
 *
 * The declaration is DISPLAY ONLY. It never gates a purchase: every failure —
 * a missing header, a malformed payload, a bad signature, a signer that is not
 * the payer, a principal naming another chain, a stale attribution hash, an
 * expired `validUntil` — is treated as "no declaration", and the purchase
 * proceeds exactly as it would have without one. The merchant applies a
 * display rule; it does not compute, assert or file tax.
 *
 * The wire shape is the SDK's (`packages/sdk/src/tax-declaration.ts`): the
 * seven §2.1 fields plus `signature`, base64url(JSON) in the
 * `X-Tax-Declaration` header. The merchant re-derives the EIP-712 digest from
 * the SDK's own domain/types through `verifyTaxDeclarationSignature`, so the
 * signing rule cannot drift between buyer and seller.
 */

/** The header a paid request may carry. */
export const X_TAX_DECLARATION_HEADER = 'X-Tax-Declaration'

/**
 * The two treatments this demo merchant displays. `SE_25` is Swedish VAT at
 * 25% taken out of the price; `REVERSE_CHARGE` is the EU intra-business case
 * where the buyer accounts for the VAT and the price is shown net.
 *
 * A non-EU treatment is deliberately NOT built: a Haven buyer only ever sends
 * a declaration for an EU VAT number, so there is no third branch to display.
 */
export const VAT_TREATMENTS = ['SE_25', 'REVERSE_CHARGE'] as const
export type VatTreatment = (typeof VAT_TREATMENTS)[number]

/**
 * What the receipt shows of an accepted declaration. The declaration carries
 * no company name and no organisation number, so the buyer block shows only
 * what is there: the declared country, the VAT number, the status, and the
 * validity bound.
 */
export interface AcceptedTaxDeclaration {
  /** ISO 3166-1 alpha-2 country code, as declared. */
  jurisdiction: string
  /** The buyer's VAT number, as declared. */
  taxId: string
  /** The §2.1 closed enumeration, e.g. `TAXABLE_PERSON`. */
  taxableStatus: string
  /** Integer milliseconds — the declaration's validity bound. */
  validUntil: number
}

/**
 * EU member states, ISO 3166-1 alpha-2. Greece is `GR` here (the ISO code);
 * `EL` is the VAT-number prefix, not the jurisdiction the declaration carries.
 */
const EU_JURISDICTIONS = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE',
])

const STRING_FIELDS = [
  'version',
  'jurisdiction',
  'taxableStatus',
  'taxId',
  'principalId',
  'principalAttributionHash',
] as const

/**
 * Decode the header value. `null` for anything that is not base64url(JSON) —
 * a header the merchant cannot read is a header it does not have.
 */
function decodeHeader(header: string): unknown {
  try {
    return JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * The exact signed shape, or `null`. Extra fields are ignored (the EIP-712
 * encoder only reads the declared types), but every declared field must be
 * present and well-typed before anything is verified — `BigInt(validUntil)`
 * inside the verifier would otherwise throw on a float or a string.
 */
function asSignedDeclaration(
  value: unknown,
): { declaration: SignedTaxDeclaration; signature: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const field of STRING_FIELDS) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) return null
  }
  if (
    typeof record.validUntil !== 'number' ||
    !Number.isInteger(record.validUntil) ||
    record.validUntil <= 0
  ) {
    return null
  }
  if (typeof record.signature !== 'string' || record.signature.length === 0) return null
  return {
    declaration: {
      version: record.version as string,
      jurisdiction: record.jurisdiction as string,
      taxableStatus: record.taxableStatus as string,
      taxId: record.taxId as string,
      validUntil: record.validUntil,
      principalId: record.principalId as string,
      principalAttributionHash: record.principalAttributionHash as string,
    },
    signature: record.signature,
  }
}

/**
 * `principalId` must name THIS payer on THIS payment's network:
 * `did:pkh:eip155:<chainId>:<payer>`. The address is compared
 * case-insensitively (EIP-55 checksum casing is not a semantic difference);
 * the chain id is not — a principal scoped to another chain is a different
 * principal.
 */
function principalNamesPayer(principalId: string, payer: string, chainId: number): boolean {
  const prefix = `did:pkh:eip155:${chainId}:`
  if (!principalId.startsWith(prefix)) return false
  return principalId.slice(prefix.length).toLowerCase() === payer.toLowerCase()
}

/**
 * Read and verify the declaration a paid request carried.
 *
 * Returns the four display fields only when ALL of these hold, and `null`
 * otherwise:
 *
 * - the signature verifies and recovers to `payer` — the payment's
 *   `authorization.from`, i.e. the key that signed the payment itself;
 * - `principalId` is that payer on `chainId`;
 * - `principalAttributionHash` recomputes from `principalId`;
 * - `validUntil` is in the future.
 *
 * Never throws: a declaration is display data, and a malformed one must not
 * turn a settled purchase into an error.
 */
export function acceptTaxDeclaration(params: {
  /** The raw `X-Tax-Declaration` header value, if the request carried one. */
  header: string | undefined
  /** The payment's payer (`SettledPayment.from` / `authorization.from`). */
  payer: string
  /** The payment's chain id — the network the principal must name. */
  chainId: number
  /** Injectable clock for tests; defaults to `Date.now()`. */
  now?: number
}): AcceptedTaxDeclaration | null {
  if (!params.header) return null
  try {
    const parsed = asSignedDeclaration(decodeHeader(params.header))
    if (!parsed) return null
    const { declaration, signature } = parsed
    if (declaration.validUntil <= (params.now ?? Date.now())) return null
    if (!principalNamesPayer(declaration.principalId, params.payer, params.chainId)) return null
    if (declaration.principalAttributionHash !== principalAttributionHash(declaration.principalId)) {
      return null
    }
    if (!verifyTaxDeclarationSignature(declaration, signature, params.payer)) return null
    return {
      jurisdiction: declaration.jurisdiction,
      taxId: declaration.taxId,
      taxableStatus: declaration.taxableStatus,
      validUntil: declaration.validUntil,
    }
  } catch {
    return null
  }
}

/**
 * The display treatment for a Swedish seller of an electronic service:
 * `SE_25` when the declared country is Sweden or there is no accepted
 * declaration, `REVERSE_CHARGE` when it is another EU country.
 *
 * A non-EU jurisdiction falls back to `SE_25`: no non-EU treatment is built,
 * and a Haven buyer only ever sends a declaration for an EU VAT number.
 */
export function vatTreatmentFor(declaration: AcceptedTaxDeclaration | null): VatTreatment {
  if (!declaration) return 'SE_25'
  const country = declaration.jurisdiction.trim().toUpperCase()
  if (country === 'SE') return 'SE_25'
  return EU_JURISDICTIONS.has(country) ? 'REVERSE_CHARGE' : 'SE_25'
}
