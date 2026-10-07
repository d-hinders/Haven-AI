import { HavenSigningError, AgentPaymentNextAction, type NextStep } from '@haven_ai/sdk/edge'
import { signerRefusalStep } from './next-step.js'

/**
 * #3728: x402 Sign-In-With-X (SIWX) for the delegate EOA — phase 1.
 *
 * The signer answers a merchant's `sign-in-with-x` challenge (CAIP-122, the
 * EVM message format is EIP-4361) with a signature from the delegate key. The
 * invariant that makes this safe on a key that also authorises payments:
 *
 * 1. The signer composes the EIP-4361 message ITSELF, from challenge fields
 *    that have passed the grammar validation below — it never signs a
 *    caller-supplied message, hash or byte string. The address in the message
 *    is read from the key, never from the challenge.
 * 2. Every relayed field is checked against EIP-4361 grammar (single line, a
 *    valid authority / absolute URI, an alphanumeric nonce), so no line break
 *    can be smuggled through a relayed field into the composed message. A
 *    composed message therefore always begins with
 *    `<domain> wants you to sign in with your Ethereum account:` and can
 *    neither equal nor parse as Haven's other EIP-191 message formats (the
 *    connect setup proof `Haven Connect Agent 2…`, the receipt-drop
 *    `haven:receipt-drop…`) — no cross-protocol replay into Haven.
 * 3. The signed domain and URI are pinned to the URL the agent is actually
 *    calling, so a signature minted for one merchant is worthless at another.
 *
 * Composition is a byte-exact template of the reference client's message
 * builder — `@x402/extensions/sign-in-with-x` `createSIWxMessage`, which goes
 * through `@signinwithethereum/siwe`'s `SiweMessage.prepareMessage()` — pinned
 * byte-for-byte by `siwx.test.ts` against `@x402/extensions` at the pinned
 * devDependency version. viem's `createSiweMessage` was rejected as the
 * composer: it routes `issuedAt`/`expirationTime` through `Date.toISOString()`,
 * which rewrites the challenge's exact string (e.g. `…T11:00:00Z` becomes
 * `…T11:00:00.000Z`) and breaks byte-identity with what the verifier rebuilds.
 */

export const SIWX_REFUSED = 'SIWX_REFUSED' as const

/**
 * Structured refusal for a `haven_sign_siwx` call whose challenge fails any
 * check below. Modelled on `HavenBareHashRefusedError` (#3169): a named code,
 * a `next_action`, a typed next step. No signature is produced and no audit
 * entry is written — the tool refuses before anything is signed.
 */
export class HavenSiwxRefusedError extends HavenSigningError {
  declare readonly code: typeof SIWX_REFUSED
  readonly next_action = AgentPaymentNextAction.StopAndTellUser
  readonly step: NextStep

  constructor(message: string) {
    super(message)
    ;(this as { code: string }).code = SIWX_REFUSED
    this.name = 'HavenSiwxRefusedError'
    this.step = signerRefusalStep({
      nextAction: AgentPaymentNextAction.StopAndTellUser,
      nextTool: null,
      nextToolOmittedReason:
        'check the 402 sign-in-with-x challenge and the URL against the refusal above, then call haven_sign_siwx again with corrected inputs — a challenge that fails validation is never signed',
    })
  }
}

/**
 * The spec's default challenge max age (docs.x402.org/extensions/sign-in-with-x,
 * `validateSIWxMessage` `maxAge` default). Pinned as the bound the signer
 * enforces: `expirationTime` must be in the future and at most this far away,
 * with the clock-skew tolerance below.
 */
export const SIWX_MAX_AGE_SECONDS = 300

/**
 * Pinned clock-skew tolerance (#3728 review fold): Bitrefill's window is
 * exactly 5 minutes, so a local clock a few seconds behind would otherwise
 * false-refuse valid challenges. Applied to BOTH edges — a challenge is
 * accepted while `expirationTime` is within this tolerance of now, and the
 * window bound reads `now + maxAge + tolerance`.
 */
export const SIWX_CLOCK_SKEW_SECONDS = 30

/** The CAIP-122 / SIWE version this signer composes. A future version is a new message grammar — fail closed. */
const SIWX_VERSION = '1'

function refuse(message: string): never {
  throw new HavenSiwxRefusedError(message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(info: Record<string, unknown>, name: string): string | undefined {
  const value = info[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    refuse(`The sign-in-with-x challenge field "${name}" must be a string.`)
  }
  return value
}

/** A relayed field is written into the composed message as-is — a line break in it would smuggle a new line into the EIP-4361 message. */
function assertSingleLine(value: string, name: string): void {
  if (/[\n\r]/.test(value)) {
    refuse(`The sign-in-with-x challenge field "${name}" contains a line break; EIP-4361 fields are single-line. Refusing — a line break could smuggle an attacker-chosen line into the signed message.`)
  }
}

export interface SiwxChainEntry {
  chainId?: unknown
  type?: unknown
}

export interface ValidatedSiwxChallenge {
  domain: string
  uri: string
  version: string
  nonce: string
  issuedAt: string
  expirationTime: string
  statement?: string
  notBefore?: string
  requestId?: string
  resources?: string[]
  /** `eip155:<chainId>` of the credential chain, as matched in `supportedChains`. */
  chainIdCaip2: string
  /** The numeric chain id the EIP-4361 `Chain ID:` line carries. */
  numericChainId: number
}

/**
 * Validate the merchant's `sign-in-with-x` challenge against the URL being
 * called and this signer's credential chain. Accepts BOTH shapes the field
 * arrives in: the 402 extension object (`extensions['sign-in-with-x']` —
 * `{ info, supportedChains, schema? }`) and the flattened info object the
 * reference client builds (`{ ...info, chainId, type, supportedChains? }`).
 * Unknown keys inside the challenge are ignored, not refused: the extension
 * may grow fields, and only the fields relayed into the message matter.
 */
export function validateSiwxChallenge(input: {
  url: string
  challenge: unknown
  /** The credential chain id (Base 8453 prod, Base Sepolia 84532 dev/QA); undefined when the credential carries none. */
  chainId: number | undefined
  now?: Date
}): ValidatedSiwxChallenge {
  const { url, challenge, chainId } = input
  const now = input.now ?? new Date()

  if (typeof url !== 'string' || url.length === 0) {
    refuse('url is required: the URL the agent is calling, so the signature is bound to that origin.')
  }
  let urlObj: URL
  try {
    urlObj = new URL(url)
  } catch {
    refuse('url is not a valid absolute URL.')
  }
  if (urlObj.protocol !== 'https:') {
    refuse(
      `url must be https — this signer never signs a sign-in bound to a plain-HTTP origin (got '${urlObj.protocol}//').`,
    )
  }

  if (!isPlainObject(challenge)) {
    refuse('challenge must be the sign-in-with-x object from the merchant 402 (extensions["sign-in-with-x"]).')
  }
  const hasWrapper = isPlainObject(challenge.info)
  const info = hasWrapper ? (challenge.info as Record<string, unknown>) : challenge
  const supportedChains = hasWrapper ? challenge.supportedChains : challenge.supportedChains

  // --- Grammar of every field relayed into the composed message. -----------

  const domain = stringField(info, 'domain')
  if (domain === undefined) refuse('The sign-in-with-x challenge carries no domain.')
  assertSingleLine(domain, 'domain')
  if (/\s/.test(domain)) {
    refuse('The sign-in-with-x challenge domain is not a valid authority (contains whitespace).')
  }
  // Pinned case handling: compare lowercased, as written — no punycode
  // conversion on either side. A unicode-domain challenge against a punycode
  // URL host (or vice versa) is a mismatch and is refused.
  if (domain.toLowerCase() !== urlObj.host.toLowerCase()) {
    refuse(
      `The challenge domain '${domain}' does not match the host of the URL being called ('${urlObj.host}'). A sign-in is only valid for the origin that issued it.`,
    )
  }

  const uri = stringField(info, 'uri')
  if (uri === undefined) refuse('The sign-in-with-x challenge carries no uri.')
  assertSingleLine(uri, 'uri')
  let uriObj: URL
  try {
    uriObj = new URL(uri)
  } catch {
    refuse('The sign-in-with-x challenge uri is not a valid absolute URI.')
  }
  if (
    uriObj.protocol !== urlObj.protocol ||
    uriObj.host.toLowerCase() !== urlObj.host.toLowerCase()
  ) {
    refuse(
      `The challenge resource uri origin ('${uriObj.protocol}//${uriObj.host}') does not match the origin of the URL being called ('${urlObj.protocol}//${urlObj.host}').`,
    )
  }

  const version = stringField(info, 'version')
  if (version === undefined) {
    refuse('The sign-in-with-x challenge carries no version; this signer composes CAIP-122 version 1 only.')
  }
  if (version !== SIWX_VERSION) {
    refuse(
      `The sign-in-with-x challenge version is '${version}'; this signer composes version '${SIWX_VERSION}' only. Update @haven_ai/signer if the spec has moved on.`,
    )
  }

  const nonce = stringField(info, 'nonce')
  if (nonce === undefined) {
    refuse('The sign-in-with-x challenge carries no nonce — refusing: the nonce is what makes the sign-in single-use.')
  }
  if (!/^[A-Za-z0-9]{8,}$/.test(nonce)) {
    refuse('The sign-in-with-x challenge nonce fails the EIP-4361 grammar (alphanumeric, at least 8 characters).')
  }

  const issuedAt = stringField(info, 'issuedAt')
  if (issuedAt === undefined) refuse('The sign-in-with-x challenge carries no issuedAt timestamp.')
  assertSingleLine(issuedAt, 'issuedAt')
  if (Number.isNaN(Date.parse(issuedAt))) {
    refuse('The sign-in-with-x challenge issuedAt is not a parseable timestamp.')
  }

  const expirationTime = stringField(info, 'expirationTime')
  if (expirationTime === undefined) {
    refuse(
      'The sign-in-with-x challenge carries no absolute expirationTime. A relative expirationSeconds is not accepted by this signer — only a challenge with an absolute expiry window the signer can bound is signed.',
    )
  }
  assertSingleLine(expirationTime, 'expirationTime')
  const expiresAtMs = Date.parse(expirationTime)
  if (Number.isNaN(expiresAtMs)) {
    refuse('The sign-in-with-x challenge expirationTime is not a parseable timestamp.')
  }
  if (expiresAtMs < now.getTime() - SIWX_CLOCK_SKEW_SECONDS * 1000) {
    refuse('The sign-in-with-x challenge has already expired (expirationTime is in the past, beyond the clock-skew tolerance). Nothing was signed.')
  }
  if (expiresAtMs - now.getTime() > (SIWX_MAX_AGE_SECONDS + SIWX_CLOCK_SKEW_SECONDS) * 1000) {
    refuse(
      `The sign-in-with-x challenge expiry window is longer than the spec's ${SIWX_MAX_AGE_SECONDS}-second max age (beyond the clock-skew tolerance). Refusing to sign a long-lived challenge.`,
    )
  }

  const statement = stringField(info, 'statement')
  if (statement !== undefined) assertSingleLine(statement, 'statement')

  const notBefore = stringField(info, 'notBefore')
  if (notBefore !== undefined) {
    assertSingleLine(notBefore, 'notBefore')
    if (Number.isNaN(Date.parse(notBefore))) {
      refuse('The sign-in-with-x challenge notBefore is not a parseable timestamp.')
    }
  }

  const requestId = stringField(info, 'requestId')
  if (requestId !== undefined) assertSingleLine(requestId, 'requestId')

  let resources: string[] | undefined
  if (info.resources !== undefined) {
    if (!Array.isArray(info.resources) || info.resources.some((r) => typeof r !== 'string')) {
      refuse('The sign-in-with-x challenge resources must be an array of URI strings.')
    }
    for (const resource of info.resources as string[]) {
      assertSingleLine(resource, 'resources[]')
      try {
        new URL(resource)
      } catch {
        refuse(`The sign-in-with-x challenge resources entry '${resource}' is not a valid absolute URI.`)
      }
    }
    resources = info.resources as string[]
  }

  // --- Chain support: the credential chain must be offered, eip191. --------

  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    refuse(
      'This signer credential carries no chain id, so the signer cannot check the challenge against the chain its delegate key pays on. Re-run the connector to refresh the credential.',
    )
  }
  const chainIdCaip2 = `eip155:${chainId}`
  if (!Array.isArray(supportedChains) || supportedChains.length === 0) {
    refuse('The sign-in-with-x challenge carries no supportedChains array.')
  }
  const matched = (supportedChains as SiwxChainEntry[]).some(
    (entry) =>
      isPlainObject(entry) &&
      typeof entry.chainId === 'string' &&
      entry.chainId.toLowerCase() === chainIdCaip2 &&
      entry.type === 'eip191',
  )
  if (!matched) {
    refuse(
      `The challenge's supportedChains does not offer the credential chain ${chainIdCaip2} with an eip191 signature type — the delegate EOA cannot answer this challenge.`,
    )
  }

  return {
    domain,
    uri,
    version,
    nonce,
    issuedAt,
    expirationTime,
    statement,
    notBefore,
    requestId,
    resources,
    chainIdCaip2,
    numericChainId: chainId,
  }
}

/**
 * Compose the EIP-4361 message. BYTE-EXACT template of
 * `@signinwithethereum/siwe`'s `SiweMessage.prepareMessage()` — the builder
 * `@x402/extensions` uses — pinned by `siwx.test.ts`. Field values must have
 * passed `validateSiwxChallenge` first: they are written in as-is.
 */
export function composeSiwxMessage(
  fields: ValidatedSiwxChallenge,
  /** The delegate address — read from the key by the caller, never from the challenge. */
  address: string,
): string {
  const suffixLines = [
    `URI: ${fields.uri}`,
    `Version: ${fields.version ?? SIWX_VERSION}`,
    `Chain ID: ${fields.numericChainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  ]
  if (fields.expirationTime !== undefined) suffixLines.push(`Expiration Time: ${fields.expirationTime}`)
  if (fields.notBefore !== undefined) suffixLines.push(`Not Before: ${fields.notBefore}`)
  if (fields.requestId !== undefined) suffixLines.push(`Request ID: ${fields.requestId}`)
  if (fields.resources !== undefined) {
    suffixLines.push(['Resources:', ...fields.resources.map((r) => `- ${r}`)].join('\n'))
  }

  let head = [`${fields.domain} wants you to sign in with your Ethereum account:`, address].join('\n')
  if (fields.statement === undefined) {
    head += '\n\n'
  } else {
    head = [head, fields.statement].join('\n\n') + '\n'
  }
  return [head, suffixLines.join('\n')].join('\n')
}

/**
 * The header payload: base64 JSON of the decomposed fields, in the reference
 * client's key order (`createSIWxPayload`) — the server parses the JSON, so
 * the order is cosmetic, but byte-identical output to the reference is the
 * cheapest way to prove the shape. `undefined` fields drop out of
 * `JSON.stringify`, exactly as in the reference.
 */
export function buildSiwxPayload(
  fields: ValidatedSiwxChallenge,
  address: string,
  signature: string,
): Record<string, unknown> {
  return {
    domain: fields.domain,
    address,
    statement: fields.statement,
    uri: fields.uri,
    version: fields.version ?? SIWX_VERSION,
    chainId: fields.chainIdCaip2,
    type: 'eip191',
    nonce: fields.nonce,
    issuedAt: fields.issuedAt,
    expirationTime: fields.expirationTime,
    notBefore: fields.notBefore,
    requestId: fields.requestId,
    resources: fields.resources,
    signature,
  }
}

/** The finished `SIGN-IN-WITH-X` header value. */
export function encodeSiwxHeader(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}
