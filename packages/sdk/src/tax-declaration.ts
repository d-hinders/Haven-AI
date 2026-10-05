import { hashTypedData } from 'viem'
import { createHash } from 'node:crypto'
import { addressFromKey, signHash, verifySignature } from './edge-signing.js'
import { chainIdForNetwork } from './settlement-child.js'
import { HavenSigningError } from './types.js'

/**
 * The x402 buyer-side tax declaration (#3427, wg-tax #5 §2.2
 * `buyer-side-tax-declaration.md`).
 *
 * The agent's own payment key — the same delegate EOA that signs the
 * EIP-3009 payment authorization — signs the §2.1 declaration content, and
 * the signed declaration travels to the SELLER ONLY, as
 * `X-Tax-Declaration: <base64url(JSON)>` on the paid merchant retry
 * (`MerchantCompletion.retryRequest`). It never reaches Haven or any
 * facilitator, and it is never part of the payment payload.
 *
 * Why this lives on the edge (`docs/architecture/07-edge-signer.md`, #3283's
 * shared-guard rule): the declaration MUST be signed by the key that signs
 * the payment authorization (§2.2), and on the EIP-3009 bridge that key is
 * held by this local SDK process. The builder therefore lives in
 * `@haven_ai/sdk/edge` beside the other signing guards, and every property
 * the threat model requires is enforced HERE, not by callers:
 *
 * - The EIP-712 typed data is built LOCALLY from the §2.1 fields. Typed data
 *   is never accepted from Haven — the wire content is validated to exactly
 *   the five §2.1 fields, and anything else (including a `principalId` or
 *   `principalAttributionHash` arriving pre-set) is REFUSED, never stripped
 *   and continued. A polluted declaration aborts the payment loudly rather
 *   than being silently laundered into a signature.
 * - `principalId = did:pkh:<CAIP-2 network>:<delegate EOA>` — the chain
 *   comes from the ACCEPTED payment option's `network` (§6.6.5 Equality),
 *   never from configuration. An alias (`base`) is resolved through the same
 *   `chainIdForNetwork` map the settlement child uses; a network with no
 *   chain id refuses, so an unknown chain cannot mint a mis-scoped
 *   principal.
 * - `principalAttributionHash = "sha-256:<hex>"` over the JCS-canonical bytes
 *   of `{ principalId }` (§6.6.2, §6.6.5 Effect).
 *
 * Residual accepted by the owner (issue threat model, 2026-09-28): Haven
 * supplies `jurisdiction`, `taxableStatus` and `taxId`, so a compromised
 * Haven could produce a declaration with a wrong VAT number. Nothing moves
 * funds, the seller checks the VAT number in VIES, and the values are the
 * owner's own onboarding data. The SDK logs the `taxId` it signs (stderr, so
 * an MCP stdio session's JSON-RPC framing on stdout is untouched).
 */

/**
 * PROVISIONAL EIP-712 domain (wg-tax PR #5 §2.2: the domain and types
 * "remain to be defined"). No chainId and no salt: the declaration is
 * portable across the settlement networks a seller may accept, and the
 * principal is already chain-scoped by `principalId`. Recorded in the PR
 * body for the working group; changing these constants changes every
 * signature produced, so they are pinned by the fixed-vector tests.
 */
export const TAX_DECLARATION_DOMAIN = { name: 'x402 Tax Declaration', version: '1' } as const

/** The declaration's EIP-712 primary type name. */
export const TAX_DECLARATION_PRIMARY_TYPE = 'TaxDeclaration'

/**
 * PROVISIONAL typed-data types for the signed §2.1 declaration plus the two
 * locally computed principal fields. Field order here is the ABI encoding
 * order of every signature produced by this module.
 */
export const TAX_DECLARATION_TYPES = {
  TaxDeclaration: [
    { name: 'version', type: 'string' },
    { name: 'jurisdiction', type: 'string' },
    { name: 'taxableStatus', type: 'string' },
    { name: 'taxId', type: 'string' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'principalId', type: 'string' },
    { name: 'principalAttributionHash', type: 'string' },
  ],
} as const

/** The x402 header this module's output is serialised into. */
export const X_TAX_DECLARATION_HEADER = 'X-Tax-Declaration'

/**
 * The §2.1 unsigned content exactly as `#3426`'s content endpoint emits it
 * (`GET /agents/:id/tax-declaration`, `{ available: true, declaration }`).
 */
export interface TaxDeclarationContent {
  /** §2.1 version discriminator, e.g. `x402-tax-1`. */
  version: string
  /** ISO 3166-1 alpha-2 country code. */
  jurisdiction: string
  /** §2.1's closed enumeration, e.g. `TAXABLE_PERSON`. */
  taxableStatus: string
  /** The owner's VAT number, normalised by the backend. */
  taxId: string
  /** Integer milliseconds — the declaration's validity bound. */
  validUntil: number
}

/** The signed declaration object carried (base64url-encoded) in the header. */
export interface SignedTaxDeclaration extends TaxDeclarationContent {
  /** `did:pkh:<CAIP-2 network>:<delegate EOA>` — computed locally. */
  principalId: string
  /** `sha-256:<hex>` over the JCS bytes of `{ principalId }`. */
  principalAttributionHash: string
}

export interface SignedTaxDeclarationResult {
  declaration: SignedTaxDeclaration
  /** EIP-712 signature (65-byte `r‖s‖v`, 27/28) over the typed declaration. */
  signature: string
}

/**
 * The strict §2.1 content validator, run before anything is signed.
 *
 * Returns the five known fields. A payload carrying a `principalId` or
 * `principalAttributionHash` — the two fields only the LOCAL builder may set
 * — is refused with `TAX_DECLARATION_FIELD_REFUSED`, never laundered. An
 * extra field, a wrong type, or a missing field is refused the same way:
 * the signed shape is what THIS module builds, and anything else arriving
 * from Haven is an attempt to widen it.
 *
 * Mutation proofs (each refusal, with its test): removing the
 * principal-field check lets a Haven-supplied principal reach the signature
 * (`refuses content that arrives with a principalId/principalAttributionHash
 * set`); removing the exact-fields check lets an extra field change the
 * signed bytes (`refuses content with fields beyond the §2.1 five`).
 */
function validateContent(content: unknown): TaxDeclarationContent {
  if (typeof content !== 'object' || content === null || Array.isArray(content)) {
    throw new HavenSigningError('Tax declaration content must be an object.')
  }
  const record = content as Record<string, unknown>
  for (const field of ['principalId', 'principalAttributionHash'] as const) {
    if (record[field] !== undefined) {
      throw new TaxDeclarationRefusedError(
        `Tax declaration content arrives with ${field} already set; that field is computed locally ` +
          'from the delegate key and the accepted payment option, never accepted from Haven.',
      )
    }
  }
  const allowed = new Set(['version', 'jurisdiction', 'taxableStatus', 'taxId', 'validUntil'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new TaxDeclarationRefusedError(
        `Tax declaration content carries an unknown field '${key}'; the signed shape is built locally ` +
          'from the §2.1 fields only.',
      )
    }
  }
  const strings = ['version', 'jurisdiction', 'taxableStatus', 'taxId'] as const
  for (const key of strings) {
    if (typeof record[key] !== 'string' || (record[key] as string).length === 0) {
      throw new TaxDeclarationRefusedError(
        `Tax declaration content field '${key}' must be a non-empty string.`,
      )
    }
  }
  if (
    typeof record.validUntil !== 'number' ||
    !Number.isInteger(record.validUntil) ||
    record.validUntil <= 0
  ) {
    throw new TaxDeclarationRefusedError(
      "Tax declaration content field 'validUntil' must be a positive integer (milliseconds).",
    )
  }
  return {
    version: record.version as string,
    jurisdiction: record.jurisdiction as string,
    taxableStatus: record.taxableStatus as string,
    taxId: record.taxId as string,
    validUntil: record.validUntil,
  }
}

/**
 * JCS (RFC 8785) canonical bytes for the `{ principalId }` attribution
 * object. RFC 8785 sorts object keys by UTF-16 code units and serialises
 * string values exactly as ECMAScript's `JSON.stringify` does, so for an
 * all-string-keyed object the canonical form is `JSON.stringify` over the
 * sorted keys. The sort is a no-op for this single-key shape but is written
 * out so the claim "JCS bytes" is implemented, not inherited from a
 * coincidence of one key.
 */
function jcsCanonicalBytes(value: Record<string, string>): string {
  const keys = Object.keys(value).sort()
  const members = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`)
  return `{${members.join(',')}}`
}

/** `sha-256:<hex>` over the UTF-8 JCS bytes of `{ principalId }` (§6.6.2). */
export function principalAttributionHash(principalId: string): string {
  const canonical = jcsCanonicalBytes({ principalId })
  const hex = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return `sha-256:${hex}`
}

/**
 * `did:pkh:<CAIP-2 network>:<address>` from the accepted option's `network`.
 *
 * The chain comes from the settlement's network — a `eip155:<n>` value passes
 * through verbatim, the x402 aliases (`base`, `base-sepolia`) resolve through
 * the same `chainIdForNetwork` map the settlement child uses, and anything
 * else refuses: a network this SDK cannot name cannot produce a principal
 * that names its own chain.
 */
export function taxPrincipalId(network: string, delegateAddress: string): string {
  if (network.startsWith('eip155:')) {
    return `did:pkh:${network}:${delegateAddress}`
  }
  const chainId = chainIdForNetwork(network)
  if (chainId === undefined) {
    throw new TaxDeclarationRefusedError(
      `The accepted payment option's network '${network}' is not a CAIP-2 eip155 chain this SDK ` +
        'can name; refusing to build a tax principal without the settlement network.',
    )
  }
  return `did:pkh:eip155:${chainId}:${delegateAddress}`
}

/**
 * Build the EIP-712 typed data for the §2.1 content LOCALLY, set the two
 * principal fields, and sign with the delegate key.
 *
 * The caller passes the raw content from `#3426`'s endpoint (parsed JSON) —
 * `validateContent` refuses anything beyond the five §2.1 fields before any
 * principal is computed or any byte is signed. The signature recovers to the
 * delegate EOA (pinned by the sign+recover test), which is the §2.2
 * requirement: the declaration signer is the payment authorizer.
 */
export function buildSignedTaxDeclaration(input: {
  /** The UNSIGNED §2.1 content from #3426's endpoint — `declaration` field of the response. */
  content: unknown
  /** The ACCEPTED payment option's network — the only chain source (§6.6.5). */
  network: string
  /** The agent's delegate key — the same key that signs the EIP-3009 authorization. */
  delegateKey: string
}): SignedTaxDeclarationResult {
  const content = validateContent(input.content)
  const principalId = taxPrincipalId(input.network, addressFromKeyForTax(input.delegateKey))
  const attributionHash = principalAttributionHash(principalId)
  const declaration: SignedTaxDeclaration = { ...content, principalId, principalAttributionHash: attributionHash }

  // The wire JSON carries `validUntil` as a number (§2.1: integer
  // milliseconds); the EIP-712 encoding widens it to the `uint256` bigint.
  const message = { ...declaration, validUntil: BigInt(declaration.validUntil) }
  const digest = hashTypedData({
    domain: TAX_DECLARATION_DOMAIN,
    types: TAX_DECLARATION_TYPES,
    primaryType: TAX_DECLARATION_PRIMARY_TYPE,
    message,
  })
  const signature = signHash(input.delegateKey, digest)
  return { declaration, signature }
}

/**
 * Recompute the EIP-712 digest for a signed declaration and check the
 * signature recovers to `expectedAddress` — the seller-side verification
 * this SDK runs on itself in tests, kept next to the builder so the digest
 * rule cannot drift from the signing one.
 */
export function verifyTaxDeclarationSignature(
  declaration: SignedTaxDeclaration,
  signature: string,
  expectedAddress: string,
): boolean {
  const message = { ...declaration, validUntil: BigInt(declaration.validUntil) }
  const digest = hashTypedData({
    domain: TAX_DECLARATION_DOMAIN,
    types: TAX_DECLARATION_TYPES,
    primaryType: TAX_DECLARATION_PRIMARY_TYPE,
    message,
  })
  return verifySignature(digest, signature, expectedAddress)
}

/**
 * The base64url(JSON) header value for the paid merchant retry. The JSON is
 * the signed declaration object with the `signature` field alongside — one
 * object, so the seller decodes, re-derives the digest from the known
 * provisional domain/types, and recovers the signer.
 */
export function encodeTaxDeclarationHeader(result: SignedTaxDeclarationResult): string {
  const json = JSON.stringify({ ...result.declaration, signature: result.signature })
  return base64Url(json)
}

function base64Url(value: string): string {
  const standard = typeof Buffer !== 'undefined'
    ? Buffer.from(value, 'utf8').toString('base64')
    : btoa(String.fromCharCode(...new TextEncoder().encode(value)))
  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function addressFromKeyForTax(delegateKey: string): string {
  try {
    return addressFromKey(delegateKey)
  } catch (err) {
    throw new HavenSigningError(
      `Invalid delegate key for tax declaration signing: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * A refused declaration: the content was not exactly the locally built shape
 * (a pre-set principal field, an unknown field, a malformed value) or the
 * settlement network could not be named. Extends `HavenSigningError` so the
 * existing signing-error handling catches it; the `code` lets callers tell
 * the refusal apart from a key problem.
 */
export class TaxDeclarationRefusedError extends HavenSigningError {
  readonly code = 'TAX_DECLARATION_REFUSED'
  constructor(message: string) {
    super(message)
    this.name = 'TaxDeclarationRefusedError'
  }
}
