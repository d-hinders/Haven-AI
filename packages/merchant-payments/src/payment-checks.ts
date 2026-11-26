/**
 * The checks a merchant makes on an x402 payment before it is sent for
 * verification or settlement, shared by the demo merchant and the paywall
 * proxy (#4890; docs/architecture/12-merchant-kit.md §6).
 *
 * Moved from `packages/demo-merchant-mcp/src/x402.ts`. The chain and the USDC
 * contract are a parameter (`PaymentAsset`); nothing here reads the
 * environment. The error classes are defined once, here, and every consumer
 * re-exports these: an `instanceof PaymentError` must hold across packages.
 */
import { getAddress, isAddress, verifyTypedData, type Address, type Hex } from 'viem'
import { decodePaymentSignatureHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { CDP_MAX_AUTHORIZATION_WINDOW_SECONDS } from './cdp.js'

/** The settlement scheme named by `extra.assetTransferMethod: "erc7710"`. */
export const ERC7710_TRANSFER_METHOD = 'erc7710'

/** The chain and the USDC contract a merchant accepts payment in. */
export interface PaymentAsset {
  chainId: number
  /** `eip155:${chainId}` */
  network: `eip155:${number}`
  usdcAddress: Address
  usdcDomainName: string
  usdcDomainVersion: string
}

/** Advertised `maxTimeoutSeconds`. */
export const MAX_TIMEOUT_SECONDS = 300
// #1279: accepted forward-validity slack beyond the advertised timeout. Covers
// clock skew plus client settlement margins (Haven's SDK signs
// clamped-timeout + 300 s forward, #1256) without accepting year-long windows.
export const MAX_WINDOW_SLACK_SECONDS = 900
export const NONCE_RE = /^0x[0-9a-fA-F]{64}$/
export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/
export const ZERO_TX_HASH = `0x${'0'.repeat(64)}` as Hex

export const TRANSFER_WITH_AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export interface Eip3009Authorization {
  from: string
  to: string
  value: string
  validAfter: string
  validBefore: string
  nonce: string
}

/**
 * #4851: machine-readable codes for the CDP path's refusals, sent as
 * `reason_code` on the 402 next to the prose. Additive: every other refusal
 * carries none, exactly as before.
 * - `facilitator_refused`: final. Coinbase's facilitator refused the payment
 *   at verification (including its sanctions and risk screening), or the
 *   chain shows the authorization consumed by something other than this
 *   payment (cancelled, or its nonce spent elsewhere). Nothing is
 *   delivered; retrying the same header will not help.
 * - `facilitator_retryable`: nothing moved, as far as the merchant can tell.
 *   Retry the SAME header; it is checked against the chain again, so it
 *   settles at most once.
 */
export type DecisionReasonCode = 'facilitator_refused' | 'facilitator_retryable'

/**
 * #4989: the refusal code a merchant answers with when a payment does not
 * match its quote (`payment_mismatch`) or is not a payment at all
 * (`payment_invalid`). Carried on the error so a merchant reads a code
 * instead of matching on the message text.
 */
export type PaymentErrorCode = 'payment_mismatch' | 'payment_invalid'

/**
 * #4989: what a refusal names beyond its message, so an agent can act on it
 * without parsing prose. Every field is optional and additive: the message
 * stays byte-identical, so a consumer that only reads `message` is unaffected.
 */
export interface PaymentErrorDetails {
  /** The refusal code the merchant answers with. */
  code?: PaymentErrorCode
  /**
   * The field the payment got wrong, as a dotted path into the payment
   * payload (`accepted.amount`, `payload.authorization.nonce`).
   */
  field?: string
  /** What would be accepted: the quoted value, or the list of accepted values. */
  expected?: unknown
  /** What to do next, in words. */
  next?: string
}

export class PaymentError extends Error {
  /** #4989: the refusal code, when the error is a mismatch with the quote or an invalid payment. */
  readonly code?: PaymentErrorCode
  /** #4989: the field the payment got wrong, as a dotted path into the payment payload. */
  readonly field?: string
  /** #4989: what would be accepted. */
  readonly expected?: unknown
  /** #4989: what to do next, in words. */
  readonly next?: string

  constructor(
    message: string,
    /** #4851: present only on the CDP path's refusals — see `DecisionReasonCode`. */
    readonly reasonCode?: DecisionReasonCode,
    /** #4989: the machine-readable extras this refusal carries. */
    details: PaymentErrorDetails = {},
  ) {
    super(message)
    this.name = 'PaymentError'
    this.code = details.code
    this.field = details.field
    this.expected = details.expected
    this.next = details.next
  }
}

/**
 * A settlement transaction was MINED AND REVERTED — a definitive on-chain
 * outcome, unlike a transient failure to fetch the receipt (#1278). The
 * processor clears the settlement attempt on this signal so a replay of the
 * same payment header RESUBMITS instead of re-confirming the dead hash
 * forever. Safe to resubmit: the revert is proven, and EIP-3009 nonce
 * uniqueness (or delegation state, on the erc7710 rail) makes an accidental
 * double-submit revert harmlessly on-chain.
 */
export class SettlementRevertedError extends PaymentError {}

/**
 * The payment's on-chain authority was ALREADY consumed — the purchase
 * settled, and this is a duplicate submission of it. Raised for a used
 * EIP-3009 nonce (#1519) and for an exhausted ERC-7710 settlement child
 * (#1515); both are the chain remembering what the merchant's in-memory maps
 * forget across a restart.
 *
 * A `PaymentError` subclass so it is reported as a decision rather than a
 * merchant fault, and distinct so `settleOnce` can treat it as the success it
 * describes instead of a refusal: a buyer whose money already reached the
 * merchant must not be told the payment failed.
 */
export class AuthorizationAlreadyUsedError extends PaymentError {
  constructor(
    message: string,
    /**
     * #4851: the transaction that used the authorization, when the CDP path
     * recovered it from USDC's events. Absent, the receipt says the reference
     * is unavailable (`already_settled_earlier`).
     */
    readonly txHash?: Hex,
  ) {
    super(message)
  }
}

/**
 * The revert's own words are capped so the next-action sentence that follows
 * stays inside the hosted relay's 500-character window even for a 400-character
 * reason (the relay-window tests in the demo merchant's erc7710.test.ts).
 */
const REVERT_REASON_MAX = 120
/** A control character can JSON-escape to six characters (\uXXXX); flatten everything outside printable ASCII first so the 120-character cap survives JSON.stringify. */
export function clampReason(reason: string): string {
  return reason.replace(/[^\x20-\x7e]/g, ' ').slice(0, REVERT_REASON_MAX)
}

/** #4851: a CDP verification refusal, with Coinbase's reason when it gave one. */
export function cdpVerificationRefused(invalidReason: string | undefined, invalidMessage: string | undefined): PaymentError {
  const reason = clampReason([invalidReason, invalidMessage].filter(Boolean).join(': ') || 'no reason given')
  return new PaymentError(
    `Coinbase's facilitator refused this payment at verification (${reason}). Nothing settled and nothing is ` +
      'delivered. Do not retry this payment.',
    'facilitator_refused',
  )
}

/** Class and message only — for the server log, never for a response body. */
export function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

export function sameAddress(a: string, b: string): boolean {
  return isAddress(a) && isAddress(b) && getAddress(a).toLowerCase() === getAddress(b).toLowerCase()
}

/** A JSON object, not an array and not a class instance. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function decodePayment(header: string): PaymentPayload {
  try {
    return decodePaymentSignatureHeader(header)
  } catch {
    throw new PaymentError('Invalid payment header: could not decode base64/JSON x402 payload')
  }
}

export function paymentMethod(accepted: PaymentRequirements): string {
  const method = accepted.extra?.assetTransferMethod
  if (method === undefined) return 'eip3009'
  if (typeof method !== 'string') throw new PaymentError('Invalid payment header: assetTransferMethod must be a string')
  return method
}

/** The fields a payment's `accepted` option is compared on, in the order a refusal names them. */
const QUOTED_OPTION_FIELDS = ['method', 'scheme', 'network', 'amount', 'maxTimeoutSeconds', 'payTo', 'asset'] as const
type QuotedOptionField = (typeof QUOTED_OPTION_FIELDS)[number]

/** The dotted path into the payment payload for one compared field. */
function quotedOptionPath(field: QuotedOptionField): string {
  return field === 'method' ? 'accepted.extra.assetTransferMethod' : `accepted.${field}`
}

/** The quoted value for one compared field, as the refusal's `expected`. */
function quotedOptionValue(option: PaymentRequirements, field: QuotedOptionField): unknown {
  return field === 'method' ? paymentMethod(option) : option[field]
}

/** The first compared field on which `accepted` differs from `quoted`, or undefined when none does. */
function firstDifferingField(quoted: PaymentRequirements, accepted: PaymentRequirements): QuotedOptionField | undefined {
  for (const field of QUOTED_OPTION_FIELDS) {
    if (field === 'payTo' || field === 'asset') {
      if (!sameAddress(quoted[field], accepted[field])) return field
    } else if (quotedOptionValue(quoted, field) !== quotedOptionValue(accepted, field)) {
      return field
    }
  }
  return undefined
}

/**
 * #4989: the refusal for a payment whose `accepted` option matches no quoted
 * option. The message is unchanged; the field is named only when the payment
 * could have meant exactly one quoted option — when the challenge advertises
 * several rails (the demo merchant advertises erc7710 and eip3009) and none
 * shares the payment's method, scheme and network, naming a field would be a
 * guess.
 */
function quotedOptionMismatch(accepted: PaymentRequirements, paymentRequired: PaymentRequired): PaymentError {
  const method = paymentMethod(accepted)
  const sameRail = paymentRequired.accepts.filter(
    (candidate) =>
      paymentMethod(candidate) === method &&
      candidate.scheme === accepted.scheme &&
      candidate.network === accepted.network,
  )
  // One option on the payment's rail: name the field that differs. A challenge
  // with a single option has no ambiguity at all, so the method, scheme and
  // network are named there too.
  const candidate = sameRail.length === 1 ? sameRail[0] : paymentRequired.accepts.length === 1 ? paymentRequired.accepts[0] : undefined
  const field = candidate ? firstDifferingField(candidate, accepted) : undefined
  if (!candidate || field === undefined) {
    return new PaymentError('Payment accepted option does not match a quoted settlement method', undefined, {
      code: 'payment_mismatch',
    })
  }
  return new PaymentError('Payment accepted option does not match a quoted settlement method', undefined, {
    code: 'payment_mismatch',
    field: quotedOptionPath(field),
    expected: quotedOptionValue(candidate, field),
    next: `Send the quoted option's ${field} in ${quotedOptionPath(field)}; the challenge lists it.`,
  })
}

export function selectQuotedPaymentOption(accepted: PaymentRequirements, paymentRequired: PaymentRequired): PaymentRequirements {
  const method = paymentMethod(accepted)
  const option = paymentRequired.accepts.find(
    (candidate) =>
      paymentMethod(candidate) === method &&
      candidate.scheme === accepted.scheme &&
      candidate.network === accepted.network &&
      candidate.amount === accepted.amount &&
      candidate.maxTimeoutSeconds === accepted.maxTimeoutSeconds &&
      sameAddress(candidate.payTo, accepted.payTo) &&
      sameAddress(candidate.asset, accepted.asset),
  )
  if (!option) throw quotedOptionMismatch(accepted, paymentRequired)
  return option
}

export function parseExactEvmPayload(payload: unknown): {
  authorization: Eip3009Authorization
  signature: Hex
} {
  // #4989: a header that decodes to JSON without the payload object used to
  // read `.authorization` on `undefined` — a TypeError, answered with the
  // generic "could not be read" sentence. It is a payment refusal, and it
  // names the field.
  if (!isPlainRecord(payload)) {
    throw new PaymentError('Invalid payment header: missing the payload object', undefined, {
      code: 'payment_invalid',
      field: 'payload',
      next: 'Send the x402 payment payload under "payload", with an EIP-3009 authorization and its signature.',
    })
  }
  const authorization = payload.authorization as Partial<Eip3009Authorization> | undefined
  const signature = payload.signature
  if (!authorization || typeof authorization !== 'object') {
    throw new PaymentError('Invalid payment header: missing EIP-3009 authorization', undefined, {
      code: 'payment_invalid',
      field: 'payload.authorization',
      next: 'Send the EIP-3009 authorization under payload.authorization.',
    })
  }
  if (typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw new PaymentError('Invalid payment header: missing EIP-3009 signature', undefined, {
      code: 'payment_invalid',
      field: 'payload.signature',
      next: 'Send the payer\'s EIP-3009 signature under payload.signature, as a 0x-prefixed hex string.',
    })
  }
  for (const field of ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const) {
    if (typeof authorization[field] !== 'string' || authorization[field] === '') {
      throw new PaymentError(`Invalid payment authorization field: ${field}`, undefined, {
        code: 'payment_invalid',
        field: `payload.authorization.${field}`,
        next: `Send payload.authorization.${field} as a non-empty string.`,
      })
    }
  }
  return { authorization: authorization as Eip3009Authorization, signature: signature as Hex }
}

export function assertPaymentOptionMatches(
  accepted: PaymentRequirements,
  expected: PaymentRequirements,
  merchantAddress: Address,
  expectedAmount: bigint,
  method: string,
  asset: PaymentAsset,
): void {
  // #4989: every refusal here is a mismatch with the quote, so it carries the
  // code and the field it names. The messages are unchanged. One throw keeps
  // `payment_invalid`: the USDC domain-metadata refusal's message never matched
  // the pre-#4989 `localCheckError` regex, so its code was `payment_invalid`,
  // and the issue scopes the code migration to the sites that regex matched.
  const mismatch = (
    message: string,
    field: string,
    expectedValue: unknown,
    next: string,
    code: PaymentErrorCode = 'payment_mismatch',
  ): PaymentError => new PaymentError(message, undefined, { code, field, expected: expectedValue, next })
  if (accepted.scheme !== 'exact') {
    throw mismatch(`Unsupported x402 scheme: ${accepted.scheme}`, 'accepted.scheme', 'exact', 'Send the quoted option unchanged in accepted.')
  }
  if (accepted.network !== asset.network) {
    throw mismatch(`Unsupported x402 network: ${accepted.network}`, 'accepted.network', asset.network, 'Send the quoted option unchanged in accepted.')
  }
  if (accepted.amount !== expectedAmount.toString()) {
    throw mismatch(
      `Payment amount does not match: expected ${expectedAmount}, got ${accepted.amount}`,
      'accepted.amount',
      expectedAmount.toString(),
      'Sign the authorization for the quoted amount.',
    )
  }
  if (accepted.amount !== expected.amount) {
    throw mismatch('Payment accepted option does not match the quoted amount', 'accepted.amount', expected.amount, 'Send the quoted option unchanged in accepted.')
  }
  if (!sameAddress(accepted.payTo, merchantAddress) || !sameAddress(accepted.payTo, expected.payTo)) {
    throw mismatch('Payment accepted option does not match merchant recipient', 'accepted.payTo', expected.payTo, 'Send the quoted option unchanged in accepted.')
  }
  if (!sameAddress(accepted.asset, asset.usdcAddress) || !sameAddress(accepted.asset, expected.asset)) {
    throw mismatch('Payment accepted option does not match Base USDC', 'accepted.asset', expected.asset, 'Send the quoted option unchanged in accepted.')
  }
  if (accepted.maxTimeoutSeconds !== expected.maxTimeoutSeconds) {
    throw mismatch('Payment accepted option does not match timeout', 'accepted.maxTimeoutSeconds', expected.maxTimeoutSeconds, 'Send the quoted option unchanged in accepted.')
  }
  if (method === ERC7710_TRANSFER_METHOD) {
    if (accepted.extra?.assetTransferMethod !== ERC7710_TRANSFER_METHOD) {
      throw mismatch(
        'Payment accepted option does not echo assetTransferMethod erc7710',
        'accepted.extra.assetTransferMethod',
        ERC7710_TRANSFER_METHOD,
        'Echo the challenge\'s extra.assetTransferMethod in accepted.extra.',
      )
    }
  } else if (method === 'eip3009') {
    const acceptedMethod = accepted.extra?.assetTransferMethod
    if (acceptedMethod !== undefined && acceptedMethod !== 'eip3009') {
      throw mismatch(
        'Payment accepted option does not echo assetTransferMethod eip3009',
        'accepted.extra.assetTransferMethod',
        'eip3009',
        'Echo the challenge\'s extra.assetTransferMethod in accepted.extra.',
      )
    }
    if (
      (accepted.extra?.name ?? null) !== asset.usdcDomainName ||
      (accepted.extra?.version ?? null) !== asset.usdcDomainVersion
    ) {
      throw mismatch(
        'Payment accepted option is missing the expected USDC domain metadata',
        'accepted.extra',
        { name: asset.usdcDomainName, version: asset.usdcDomainVersion },
        'Echo the challenge\'s extra.name and extra.version in accepted.extra.',
        'payment_invalid',
      )
    }
  } else {
    throw mismatch(
      `Unsupported x402 assetTransferMethod: ${method}`,
      'accepted.extra.assetTransferMethod',
      [ERC7710_TRANSFER_METHOD, 'eip3009'],
      'Send one of the settlement methods the challenge advertises.',
    )
  }
}

export function assertResourceMatches(payload: PaymentPayload, paymentRequired: PaymentRequired): void {
  if (!payload.resource) return
  if (payload.resource.url !== paymentRequired.resource.url) {
    throw new PaymentError('Payment resource does not match quoted resource', undefined, {
      code: 'payment_mismatch',
      field: 'resource.url',
      expected: paymentRequired.resource.url,
      next: 'Send the challenge\'s resource.url in the payment payload.',
    })
  }
}

/**
 * #2361: enforce the x402 v2 extensions-echo rule — "the client must include
 * at least the info received; it may append additional info but cannot delete
 * or overwrite existing info." A payment that drops the challenge's
 * `extensions` is refused, with a message that names the rule rather than the
 * bare 400 the live facilitator that motivated this gives (#2360).
 *
 * The version cross-check fires on every payload (this merchant only issues
 * v2 challenges, so a mismatch is a refusal, never an exemption); the echo
 * rule itself then applies when the challenge advertises extensions. This is
 * the check that stops the QA harness validating Haven-against-Haven: a
 * Haven client that stops echoing fails HERE, on Sepolia, instead of at the
 * first strict mainnet facilitator.
 */
export function assertExtensionsEchoed(payload: PaymentPayload, paymentRequired: PaymentRequired): void {
  // Reviewer finding on #2361: without this cross-check, a payload that
  // merely DECLARES `x402Version: 1` skipped the echo rule entirely — this
  // merchant only ever issues v2 challenges and has no v1 verification path,
  // so a version mismatch is a refusal, never an exemption. The gate exists
  // to catch Haven-client regressions before a strict mainnet facilitator
  // does; a client bug that drops the echo AND misreports the version must
  // not sail through.
  if (payload.x402Version !== paymentRequired.x402Version) {
    throw new PaymentError(
      `Payment x402Version ${String(payload.x402Version)} does not match the challenge's ${String(paymentRequired.x402Version)}`,
      undefined,
      {
        code: 'payment_mismatch',
        field: 'x402Version',
        expected: paymentRequired.x402Version,
        next: 'Send the challenge\'s x402Version in the payment payload.',
      },
    )
  }
  const advertised = (paymentRequired as { extensions?: unknown }).extensions
  if (!advertised || typeof advertised !== 'object' || Array.isArray(advertised)) return
  const echoed = (payload as { extensions?: unknown }).extensions
  if (!echoed || typeof echoed !== 'object' || Array.isArray(echoed)) {
    throw new PaymentError(
      'Payment must echo the challenge\'s extensions object (x402 v2 extensions echo rule)',
      undefined,
      {
        code: 'payment_mismatch',
        field: 'extensions',
        expected: advertised,
        next: 'Echo the challenge\'s extensions object in the payment payload, unmodified.',
      },
    )
  }
  if (!objectContainsSubset(advertised as Record<string, unknown>, echoed as Record<string, unknown>)) {
    throw new PaymentError(
      'Payment extensions must include the challenge\'s extensions unmodified (x402 v2: append-only, never delete or overwrite)',
      undefined,
      {
        code: 'payment_mismatch',
        field: 'extensions',
        expected: advertised,
        next: 'Echo the challenge\'s extensions object in the payment payload, unmodified.',
      },
    )
  }
}

/** Every key/value in `subset` present and deep-equal in `superset`; extra keys in `superset` are allowed. */
export function objectContainsSubset(subset: Record<string, unknown>, superset: Record<string, unknown>): boolean {
  return Object.entries(subset).every(([key, value]) => {
    if (!(key in superset)) return false
    const other = superset[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return !!other && typeof other === 'object' && !Array.isArray(other) &&
        objectContainsSubset(value as Record<string, unknown>, other as Record<string, unknown>)
    }
    return JSON.stringify(value) === JSON.stringify(other)
  })
}

export function parseBigIntField(value: string, field: string): bigint {
  try {
    return BigInt(value)
  } catch {
    throw new PaymentError(`Invalid payment authorization field: ${field}`)
  }
}

/**
 * Review of #4851: refuse, before any chain read or CDP call, a window the
 * recovery search could not cover in full — see
 * `CDP_MAX_AUTHORIZATION_WINDOW_SECONDS`.
 */
export function assertCdpWindowSearchable(authorization: Pick<Eip3009Authorization, 'validAfter' | 'validBefore'>): void {
  if (BigInt(authorization.validBefore) - BigInt(authorization.validAfter) > BigInt(CDP_MAX_AUTHORIZATION_WINDOW_SECONDS)) {
    throw new PaymentError(
      `Payment authorization validity window is longer than ${CDP_MAX_AUTHORIZATION_WINDOW_SECONDS} s ` +
        '(validBefore - validAfter); sign it with a validAfter close to now.',
    )
  }
}

export async function verifyAuthorization(
  authorization: Eip3009Authorization,
  signature: Hex,
  merchantAddress: Address,
  expectedAmount: bigint,
  asset: PaymentAsset,
  /** #4851: the CDP path defers an expired authorization to a chain read
   *  instead of refusing it here; every other check still applies.
   *  `nowSec` is for tests: the clock, in unix seconds. */
  opts: { allowExpired?: boolean; nowSec?: bigint } = {},
): Promise<{ expired: boolean }> {
  const nowSec = opts.nowSec ?? BigInt(Math.floor(Date.now() / 1000))
  const validBefore = parseBigIntField(authorization.validBefore, 'validBefore')
  const validAfter = parseBigIntField(authorization.validAfter, 'validAfter')
  const value = parseBigIntField(authorization.value, 'value')

  if (!isAddress(authorization.from)) throw new PaymentError('Payment payer address is invalid')
  if (!isAddress(authorization.to)) throw new PaymentError('Payment recipient address is invalid')
  if (!NONCE_RE.test(authorization.nonce)) throw new PaymentError('Payment nonce must be 32 bytes')
  // EIP-3009 on-chain semantics: valid iff validAfter < now < validBefore.
  // validBefore = 0 therefore means NEVER valid — the old special case read
  // it as "no expiry", the exact opposite of what the chain would do (#1279).
  const expired = nowSec >= validBefore
  if (expired && !opts.allowExpired) throw new PaymentError('Payment authorization has expired')
  if (nowSec < validAfter) throw new PaymentError('Payment authorization is not valid yet')
  // Nit companion (#1279): the signed window must not exceed what the quote
  // advertised by more than a generous slack — a years-long authorization
  // only risks the BUYER, but accepting one silently makes maxTimeoutSeconds
  // a lie. Slack covers clock skew and client-side signing margins (the
  // Haven SDK adds a settlement margin on top of the advertised timeout).
  const advertisedWindow = BigInt(MAX_TIMEOUT_SECONDS + MAX_WINDOW_SLACK_SECONDS)
  if (validBefore - nowSec > advertisedWindow) {
    throw new PaymentError(
      'Payment authorization validity window is far longer than the quoted maxTimeoutSeconds',
    )
  }
  if (!sameAddress(authorization.to, merchantAddress)) {
    throw new PaymentError('Payment is not addressed to this merchant', undefined, {
      code: 'payment_mismatch',
      field: 'payload.authorization.to',
      expected: merchantAddress,
      next: 'Sign the authorization with the challenge\'s payTo as its recipient.',
    })
  }
  if (value !== expectedAmount) {
    throw new PaymentError(`Payment amount does not match: expected ${expectedAmount}, got ${value}`, undefined, {
      code: 'payment_mismatch',
      field: 'payload.authorization.value',
      expected: expectedAmount.toString(),
      next: 'Sign the authorization for the quoted amount.',
    })
  }

  let valid = false
  try {
    valid = await verifyTypedData({
      address: getAddress(authorization.from),
      domain: {
        name: asset.usdcDomainName,
        version: asset.usdcDomainVersion,
        chainId: asset.chainId,
        verifyingContract: asset.usdcAddress,
      },
      types: TRANSFER_WITH_AUTH_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: getAddress(authorization.from),
        to: getAddress(authorization.to),
        value,
        validAfter,
        validBefore,
        nonce: authorization.nonce as Hex,
      },
      signature,
    })
  } catch {
    valid = false
  }
  if (!valid) throw new PaymentError('Invalid EIP-3009 signature')
  return { expired }
}
