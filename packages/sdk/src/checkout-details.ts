/**
 * Checkout details on the paid x402 request (#4872, epic #4868): the pure half.
 *
 * The design is `docs/architecture/13-checkout-details.md`. A merchant asks in
 * its payment challenge, under `extensions["haven-checkout-details"]`, for any
 * of `receipt_email`, `billing_address` and `shipping_address`, each marked
 * required or optional. Haven answers on the PAID request with one header,
 * `X-Checkout-Details: <base64url(UTF-8 JSON), no padding>`, carrying only the
 * fields asked for. The answer is unsigned (§3), never merged into the echoed
 * `extensions` entry (which reaches the facilitator), and bounded by a
 * 1,536-byte budget (§3).
 *
 * This module decides, without any I/O:
 * - what the merchant asked for (an unreadable request is NO request, §2);
 * - which of the owner's stored fields go into the answer, in the merchant's
 *   order, within the budget;
 * - which required fields cannot be shared, and why;
 * - whether the paid request's header block would stay under 16 KB.
 *
 * Values are personal data. Nothing here logs; the one log line the wire half
 * writes names fields, sizes and the outcome, never a value.
 */

import { encodeBase64Json } from './base64.js'
import type { X402PaymentOption, X402PaymentRequired } from './types.js'

/** The challenge's extension key (§2). */
export const CHECKOUT_DETAILS_EXTENSION = 'haven-checkout-details'

/** The paid request's answer header (§3). */
export const X_CHECKOUT_DETAILS_HEADER = 'X-Checkout-Details'

/** The answer's budget: the encoded header value, excluding name and separator (§3). */
export const CHECKOUT_DETAILS_BUDGET_BYTES = 1536

/** Node's default `maxHeaderSize`, the transport's 16 KB header ceiling (§3). */
export const HEADER_BLOCK_CEILING_BYTES = 16384

/** The three field names, in their canonical order (§2). No slice renames them. */
export const CHECKOUT_DETAIL_FIELDS = ['receipt_email', 'billing_address', 'shipping_address'] as const
export type CheckoutDetailField = (typeof CHECKOUT_DETAIL_FIELDS)[number]

/** The address shape (§2), the compliance-fields `buyer.address` shape. */
export interface CheckoutAddress {
  line1: string
  line2?: string
  line3?: string
  city: string
  postCode?: string
  subdivision?: string
  country: string
}

/** What the agent's read returns when details are available (#4871). Absent fields are omitted. */
export interface CheckoutDetailsValues {
  receipt_email?: string
  billing_address?: CheckoutAddress
  shipping_address?: CheckoutAddress
}

/** One requested field, in the merchant's order. */
export interface CheckoutDetailsRequestedField {
  name: CheckoutDetailField
  required: boolean
}

/** A readable request: at least one known field. */
export interface CheckoutDetailsRequest {
  fields: CheckoutDetailsRequestedField[]
}

const FIELD_SET: ReadonlySet<string> = new Set(CHECKOUT_DETAIL_FIELDS)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the merchant's request from a challenge's `extensions` (§2 *Reading the
 * request*). The request is untrusted input:
 * - a missing entry, or any malformed one (not an object, no `info`, a
 *   `version` other than `1`, `fields` not an object, a field that is not an
 *   object, `required` not a boolean) is NO request: `null`;
 * - an unknown field name is ignored, never guessed at;
 * - a request that names only unknown fields is no request either.
 *
 * `null` means the paid request is exactly today's: nothing is read from
 * Haven, nothing is attached and nothing is refused.
 */
export function parseCheckoutDetailsRequest(extensions: unknown): CheckoutDetailsRequest | null {
  if (!isRecord(extensions)) return null
  const entry = extensions[CHECKOUT_DETAILS_EXTENSION]
  if (entry === undefined) return null
  if (!isRecord(entry)) return null
  const info = entry.info
  if (!isRecord(info)) return null
  if (info.version !== 1) return null
  const fields = info.fields
  if (!isRecord(fields)) return null
  const requested: CheckoutDetailsRequestedField[] = []
  for (const [name, spec] of Object.entries(fields)) {
    // A malformed field makes the whole entry unreadable (§2), checked BEFORE
    // the unknown-name skip so an unknown-but-malformed field is not a way to
    // smuggle a half-read request through.
    if (!isRecord(spec) || typeof spec.required !== 'boolean') return null
    if (!FIELD_SET.has(name)) continue
    requested.push({ name: name as CheckoutDetailField, required: spec.required })
  }
  return requested.length > 0 ? { fields: requested } : null
}

/** The challenge's request, or `null` (no or unreadable request). */
export function checkoutDetailsRequestOf(paymentRequired: Pick<X402PaymentRequired, 'extensions'>): CheckoutDetailsRequest | null {
  return parseCheckoutDetailsRequest(paymentRequired.extensions)
}

/** The base64url, no-padding encoding of the tax declaration (§3). */
function base64UrlJson(value: unknown): string {
  const json = JSON.stringify(value)
  const standard = typeof Buffer !== 'undefined'
    ? Buffer.from(json, 'utf8').toString('base64')
    : btoa(String.fromCharCode(...new TextEncoder().encode(json)))
  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Why a required field could not be shared. */
export type CheckoutDetailsRefusalReason =
  /** The owner has not turned sharing on for this agent. */
  | 'not_shared'
  /** The deployment has checkout details off; the owner cannot turn sharing on. */
  | 'feature_disabled'
  /** Sharing is on, but the owner has not saved this field. */
  | 'not_stored'
  /** The answer, or the paid request's header block, would exceed its limit. */
  | 'over_budget'
  /** Haven's read of the details failed (a network error, a 5xx, an off-contract body). */
  | 'unreadable'
  /** Haven's backend has no agent read at all (a 404: older than #4871). */
  | 'backend_unsupported'

/** What the answer builder decided for one challenge. */
export type CheckoutDetailsDecision =
  /** No (readable) request: today's paid request, nothing read. */
  | { kind: 'none' }
  /** Send this header (or nothing, when no asked field could be shared). */
  | {
      kind: 'answer'
      header: string | undefined
      sentFields: CheckoutDetailField[]
      /** Optional fields that could not be shared, and why (field names only). */
      omitted: Array<{ name: CheckoutDetailField; reason: CheckoutDetailsRefusalReason }>
    }
  /** A required field cannot be shared: stop before paying. */
  | { kind: 'refuse'; missingFields: CheckoutDetailField[]; reason: CheckoutDetailsRefusalReason }

/** The state of the agent's details read, as the wire half resolved it. */
export type CheckoutDetailsAvailability =
  | { available: true; values: CheckoutDetailsValues }
  | { available: false; reason: Exclude<CheckoutDetailsRefusalReason, 'over_budget'> }

/**
 * Build the answer for one request from the read's result (§3, §5).
 *
 * Fields are added in the MERCHANT's order. A field the owner has not saved,
 * or every field when the read says details are unavailable, is missing: a
 * missing required field refuses, a missing optional one is omitted. A field
 * that would take the encoded answer over the budget is likewise missing for
 * `over_budget`. The refusal names every required field that could not be
 * shared and the first reason in the merchant's order.
 */
export function decideCheckoutDetails(
  request: CheckoutDetailsRequest | null,
  availability: CheckoutDetailsAvailability,
  budget: number = CHECKOUT_DETAILS_BUDGET_BYTES,
): CheckoutDetailsDecision {
  if (request === null) return { kind: 'none' }
  const missingRequired: Array<{ name: CheckoutDetailField; reason: CheckoutDetailsRefusalReason }> = []
  const omitted: Array<{ name: CheckoutDetailField; reason: CheckoutDetailsRefusalReason }> = []
  const answer: Record<string, unknown> = { version: 1 }
  const sentFields: CheckoutDetailField[] = []

  for (const field of request.fields) {
    let reason: CheckoutDetailsRefusalReason | null = null
    if (!availability.available) {
      reason = availability.reason
    } else {
      const value = availability.values[field.name]
      if (value === undefined) {
        reason = 'not_stored'
      } else {
        const candidate = { ...answer, [field.name]: value }
        if (base64UrlJson(candidate).length > budget) {
          reason = 'over_budget'
        } else {
          answer[field.name] = value
          sentFields.push(field.name)
        }
      }
    }
    if (reason !== null) (field.required ? missingRequired : omitted).push({ name: field.name, reason })
  }

  if (missingRequired.length > 0) {
    return { kind: 'refuse', missingFields: missingRequired.map((m) => m.name), reason: missingRequired[0].reason }
  }
  return {
    kind: 'answer',
    header: sentFields.length > 0 ? base64UrlJson(answer) : undefined,
    sentFields,
    omitted,
  }
}

/**
 * The size of the paid request's header block BEFORE the payment is
 * authorised (§3 *The size check*). The payment header's only unknown part is
 * the signature payload, whose size is bounded per scheme; everything else —
 * `resource`, `accepted` and the echoed `extensions` — is in the challenge.
 *
 * Conservative on purpose: the payload allowance is the larger fixture of the
 * design's measurement (the erc7710 fixture's payload for erc7710, an
 * EIP-3009 authorization otherwise) and the other headers are counted at
 * 1 KB, so an estimate under the ceiling is a block under the ceiling.
 */
const EIP3009_PAYLOAD_ALLOWANCE = {
  signature: `0x${'ab'.repeat(65)}`,
  authorization: {
    from: `0x${'12'.repeat(20)}`,
    to: `0x${'12'.repeat(20)}`,
    value: '1'.repeat(78),
    validAfter: '0',
    validBefore: '9'.repeat(20),
    nonce: `0x${'cd'.repeat(32)}`,
  },
}
/** The erc7710 payload's JSON size allowance: a delegation chain is far larger than an EIP-3009 authorization. */
const ERC7710_PAYLOAD_ALLOWANCE_BYTES = 6144
const OTHER_HEADERS_ALLOWANCE_BYTES = 1024
const PAYMENT_HEADER_NAME_BYTES = 'PAYMENT-SIGNATURE: \r\n'.length
const ANSWER_HEADER_NAME_BYTES = `${X_CHECKOUT_DETAILS_HEADER}: \r\n`.length

export function estimatePaidHeaderBlockBytes(input: {
  paymentRequired: Pick<X402PaymentRequired, 'resource' | 'extensions' | 'x402Version'>
  accepted: X402PaymentOption
  isErc7710: boolean
  answerHeader: string | undefined
}): number {
  const envelope = {
    x402Version: input.paymentRequired.x402Version ?? 2,
    resource: input.paymentRequired.resource,
    accepted: input.accepted,
    payload: input.isErc7710 ? { allowance: 'x'.repeat(ERC7710_PAYLOAD_ALLOWANCE_BYTES) } : EIP3009_PAYLOAD_ALLOWANCE,
    ...(input.paymentRequired.extensions ? { extensions: input.paymentRequired.extensions } : {}),
  }
  const paymentHeaderBytes = encodeBase64Json(envelope).length + PAYMENT_HEADER_NAME_BYTES
  const answerBytes = input.answerHeader ? input.answerHeader.length + ANSWER_HEADER_NAME_BYTES : 0
  return paymentHeaderBytes + answerBytes + OTHER_HEADERS_ALLOWANCE_BYTES
}

/** The ACTUAL block's size at the paid request (the safety net): the real payment header plus the answer. */
export function actualPaidHeaderBlockBytes(paymentHeader: string, answerHeader: string | undefined): number {
  return (
    paymentHeader.length +
    PAYMENT_HEADER_NAME_BYTES +
    (answerHeader ? answerHeader.length + ANSWER_HEADER_NAME_BYTES : 0) +
    OTHER_HEADERS_ALLOWANCE_BYTES
  )
}

/**
 * Apply the block check to a decision (§3): an answer that would push the
 * block over 16 KB is not sent. With a required field among those sent, that
 * is a refusal before payment (`over_budget`); otherwise the answer is dropped
 * and the purchase proceeds.
 */
export function withinHeaderBlock(
  decision: CheckoutDetailsDecision,
  request: CheckoutDetailsRequest | null,
  blockBytes: (answerHeader: string | undefined) => number,
): CheckoutDetailsDecision {
  if (decision.kind !== 'answer' || decision.header === undefined) return decision
  if (blockBytes(decision.header) <= HEADER_BLOCK_CEILING_BYTES) return decision
  const requiredSent = decision.sentFields.filter((name) => request?.fields.find((f) => f.name === name)?.required)
  if (requiredSent.length > 0) return { kind: 'refuse', missingFields: requiredSent, reason: 'over_budget' }
  return {
    kind: 'answer',
    header: undefined,
    sentFields: [],
    omitted: [...decision.omitted, ...decision.sentFields.map((name) => ({ name, reason: 'over_budget' as const }))],
  }
}

/**
 * The ONE attach site for the answer header on the paid request: set when an
 * answer exists, and a stale value the caller's own `init` might carry is
 * DELETED otherwise — the tax header's rule (`withTaxDeclarationHeader`). The
 * header is attached AFTER any captured-request snapshot, so it never lands
 * in a resume state, a Haven-API body or the payment payload.
 */
export function withCheckoutDetailsHeader(init: RequestInit | undefined, header: string | undefined): RequestInit {
  if (!header) {
    if (init?.headers && new Headers(init.headers).has(X_CHECKOUT_DETAILS_HEADER)) {
      const headers = new Headers(init.headers)
      headers.delete(X_CHECKOUT_DETAILS_HEADER)
      return { ...init, headers }
    }
    return init ?? {}
  }
  const headers = new Headers(init?.headers)
  headers.set(X_CHECKOUT_DETAILS_HEADER, header)
  return { ...init, headers }
}
