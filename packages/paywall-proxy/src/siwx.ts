/**
 * The `SIGN-IN-WITH-X` proof a re-presented payment needs
 * (docs/architecture/12-merchant-kit.md §6). After settlement the full EIP-3009
 * authorization is public in the transaction's calldata, so the payment header
 * alone authorizes no forward beyond the reserving request's own first one. A
 * further forward needs a CAIP-122 sign-in (the EVM message format is
 * EIP-4361) signed by the record's payer over a challenge this proxy issued.
 *
 * The proxy composes the message ITSELF from the challenge it issued and the
 * address in the proof, and recovers the signer from the signature. It never
 * verifies a message the buyer supplies, so no field the buyer controls can
 * change what was signed except the address, which must be the payer's.
 *
 * Composition is a byte-exact template of the reference message builder
 * (`@x402/extensions/sign-in-with-x` `createSIWxMessage`, through
 * `@signinwithethereum/siwe`'s `prepareMessage()`), which is the same template
 * Haven's signer uses (`packages/signer/src/siwx.ts`, `composeSiwxMessage`),
 * pinned against the reference by `siwx.test.ts`. The challenge carries none of
 * the optional fields (statement, notBefore, requestId, resources), so the
 * template here has none either, and a proof that names one is refused.
 */
import { getAddress, isAddress, isHex, recoverMessageAddress, type Address, type Hex } from 'viem'

/** How long a challenge nonce lives. Haven's signer refuses a window longer than 300 s. */
export const SIWX_NONCE_LIFETIME_MS = 300_000
/** A live nonce is issued again unchanged while at least this much of it remains; after that a fresh one replaces it. */
export const SIWX_REISSUE_MIN_REMAINING_MS = 60_000

export const SIWX_VERSION = '1'

/** One payment key's live challenge nonce, as the nonce table holds it. */
export interface SiwxNonce {
  nonce: string
  issuedAt: string
  expirationTime: string
  expiresMs: number
}

/** What one challenge binds: the origin and resource the buyer is calling, the chain, and the key's nonce. */
export interface SiwxChallengeFields {
  domain: string
  uri: string
  chainId: number
  nonce: SiwxNonce
}

/** The challenge, in the `{ info, supportedChains }` form Haven's signer accepts (§6 "The challenge"). */
export interface SiwxChallenge {
  info: {
    domain: string
    uri: string
    version: string
    nonce: string
    issuedAt: string
    expirationTime: string
  }
  supportedChains: { chainId: string; type: 'eip191' }[]
}

/** The origin a challenge is bound to, from the request's resource URL. */
export function siwxBinding(resourceUrl: string): { domain: string; uri: string } {
  const url = new URL(resourceUrl)
  return { domain: url.host, uri: `${url.origin}${url.pathname}` }
}

export function buildSiwxChallenge(fields: SiwxChallengeFields): SiwxChallenge {
  return {
    info: {
      domain: fields.domain,
      uri: fields.uri,
      version: SIWX_VERSION,
      nonce: fields.nonce.nonce,
      issuedAt: fields.nonce.issuedAt,
      expirationTime: fields.nonce.expirationTime,
    },
    supportedChains: [{ chainId: `eip155:${fields.chainId}`, type: 'eip191' }],
  }
}

/** The EIP-4361 message for a challenge this proxy issued, signed by `address`. */
export function composeSiwxMessage(fields: SiwxChallengeFields, address: string): string {
  const head = `${fields.domain} wants you to sign in with your Ethereum account:\n${address}\n\n`
  const suffix = [
    `URI: ${fields.uri}`,
    `Version: ${SIWX_VERSION}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce.nonce}`,
    `Issued At: ${fields.nonce.issuedAt}`,
    `Expiration Time: ${fields.nonce.expirationTime}`,
  ].join('\n')
  return `${head}\n${suffix}`
}

export type SiwxProofCheck =
  | { ok: true; nonce: string }
  | { ok: false; reason: SiwxRefusal }

export type SiwxRefusal =
  | 'unreadable'
  | 'no_live_nonce'
  | 'nonce_mismatch'
  | 'expired'
  | 'field_mismatch'
  | 'not_the_payer'
  | 'bad_signature'

const OPTIONAL_FIELDS = ['statement', 'notBefore', 'requestId', 'resources'] as const

function decodeProof(header: string): Record<string, unknown> | null {
  if (header.length > 8192) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Check a `SIGN-IN-WITH-X` header against the key's live nonce and the
 * request's binding. `ok` means the payer signed this proxy's challenge; it
 * does not retire the nonce, which the caller does as one conditional update
 * once it holds an upstream slot (§6: retiring the nonce is the acceptance
 * point).
 */
export async function checkSiwxProof(params: {
  header: string
  binding: { domain: string; uri: string }
  chainId: number
  /** The key's live nonce, or null when it has none (never issued, retired or expired). */
  live: SiwxNonce | null
  payer: Address
  nowMs: number
}): Promise<SiwxProofCheck> {
  const proof = decodeProof(params.header)
  if (!proof) return { ok: false, reason: 'unreadable' }
  const { live } = params
  if (!live) return { ok: false, reason: 'no_live_nonce' }
  if (proof.nonce !== live.nonce) return { ok: false, reason: 'nonce_mismatch' }
  if (params.nowMs >= live.expiresMs) return { ok: false, reason: 'expired' }

  const fieldsMatch =
    proof.domain === params.binding.domain &&
    proof.uri === params.binding.uri &&
    proof.version === SIWX_VERSION &&
    proof.chainId === `eip155:${params.chainId}` &&
    (proof.type === undefined || proof.type === 'eip191') &&
    proof.issuedAt === live.issuedAt &&
    proof.expirationTime === live.expirationTime &&
    OPTIONAL_FIELDS.every((name) => proof[name] === undefined)
  if (!fieldsMatch) return { ok: false, reason: 'field_mismatch' }

  const { address, signature } = proof
  if (typeof address !== 'string' || !isAddress(address, { strict: false })) return { ok: false, reason: 'unreadable' }
  if (getAddress(address.toLowerCase()) !== getAddress(params.payer)) return { ok: false, reason: 'not_the_payer' }
  if (typeof signature !== 'string' || !isHex(signature)) return { ok: false, reason: 'unreadable' }

  const message = composeSiwxMessage({ ...params.binding, chainId: params.chainId, nonce: live }, address)
  let recovered: Address
  try {
    recovered = await recoverMessageAddress({ message, signature: signature as Hex })
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  if (getAddress(recovered) !== getAddress(params.payer)) return { ok: false, reason: 'bad_signature' }
  return { ok: true, nonce: live.nonce }
}
