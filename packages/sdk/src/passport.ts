/**
 * L0 Agent Passport — the merchant-side verifier (#4723, epic #4718).
 *
 * ## Why this lives in the SDK
 *
 * Before this module a merchant that wanted to check a passport had to
 * re-implement `canonicalize` + `verifyMessage` from the doc snippet
 * (`docs/architecture/11-agent-passport-schema.md` § *Why a signed receipt*).
 * That canonicalization already cost one real bug: the `/1` receipt version
 * signed `controls` as `{}` because `JSON.stringify(obj, Object.keys(obj).sort())`
 * is a recursive property ALLOW-LIST, not a key ordering. A second copy of a
 * canonicalizer is the `/1` failure family, so there is exactly one copy — this
 * one — and the backend's `modules/passport/receipt.ts` delegates to it.
 *
 * ## What a check proves, and what it does not
 *
 * A successful check says: **this receipt was signed by the issuer you pinned,
 * it is unexpired, it names your chain, and it binds the address that paid.**
 * It does not say the agent is trustworthy, and it is not a payment
 * verification — the settle path never consults it. Copy that describes a
 * result must say the standing was **checked**, never "verified agent": the
 * only tier that may say *verified* is L2 (`AssuranceLevel`), which is not
 * issuable.
 *
 * ## The subject binding (#4723 spec review, blocking finding)
 *
 * The passport reference a payment carries is agent-supplied, and
 * `GET /passport/verify?uid=` looks a passport up by UID alone. A UID is public
 * on EAS, so a UID-only check lets any payer present another active agent's
 * passport and be reported as `active` — a "lent passport", and an authority
 * claim. So the lookup is by **payer address** (`?address=`), and the UID the
 * payment carried is only a hint, cross-checked against the receipt's
 * `evidenceUid`. The receipt's own `issuer` field is never trusted either: the
 * pin is a required argument.
 *
 * Which receipt field the payer must match depends on the rail, and the two
 * rails see different addresses:
 *
 * - EIP-3009: the merchant sees `authorization.from`, which is the delegate
 *   EOA → `receipt.agentEoa`.
 * - erc7710: the merchant sees `payload.delegator`, which is the Hybrid
 *   delegator → `receipt.smartAccount`. (`server.ts`'s #1472 note and
 *   `receipt.ts`'s field docs agree on this; the older `server.ts:425`
 *   comment that called the delegator the EOA was the stale one.)
 *
 * ## Advisory by construction
 *
 * `checkPassport` never throws and never refuses anything: every failure —
 * 503, 429, a timeout, a network error, a non-JSON body — collapses into
 * `unavailable`. A merchant decides what to do with the answer; the demo
 * merchant reports it and settles regardless.
 */

import { verifyMessage } from 'ethers'

/**
 * The signed payload's version. Part of what is signed.
 *
 * `/2` fixes the `/1` defect described in this module's header. `/1` was never
 * released; the version is bumped anyway so any receipt minted against it can
 * never verify.
 */
export const PASSPORT_RECEIPT_VERSION = 'haven-passport-receipt/2'

/**
 * How long `checkPassport` waits for the verifier, in milliseconds.
 *
 * 1500 ms is the same bound the SDK already puts on its own passport read
 * before an advertised `haven-passport` extension (`PASSPORT_READ_TIMEOUT_MS`
 * in `x402-funding-leg.ts`), and the same bound the backend puts on its lookup.
 * The check is advisory and runs after settlement, so a slow verifier must
 * never hold a purchase response open.
 */
export const PASSPORT_CHECK_TIMEOUT_MS = 1500

/** The agent's live standing, as the verifier answers it. */
export type PassportStanding = 'active' | 'suspended' | 'revoked' | 'unknown'

/** Progress of the on-chain anchor. Never the authority. */
export type PassportAnchorState =
  | 'not_anchored'
  | 'anchored'
  | 're_anchoring'
  | 'revocation_pending'
  | 'revoked_onchain'

/**
 * The enforced controls, as a SUMMARY — booleans and rail names only, never
 * budget amounts, recipients or balances.
 */
export interface PassportControlSummary {
  /** The account's `execution_rail`, verbatim. */
  rail: string
  /** Whether the spending policy is enforced by a contract rather than by Haven. */
  policyEnforcedOnchain: boolean
  /** Whether the agent's authority is scoped to a treasury account. */
  treasuryBound: boolean
}

/** The payload that is signed. Field order here is NOT the canonical order. */
export interface PassportReceipt {
  version: string
  /** Haven, identified by the signing address a merchant pins. */
  issuer: string
  /** Haven's opaque agent id. Not PII and not a wallet. */
  agentId: string
  /** The delegate EOA — what a merchant sees on an EIP-3009 header. */
  agentEoa: string | null
  /** The Hybrid delegator — what a merchant sees in erc7710 redemption. */
  smartAccount: string | null
  /** `AssuranceLevel` as a number; only `0` (L0) is issuable today. */
  assuranceLevel: number
  /** THE answer. Never derived from the chain. */
  standing: PassportStanding
  /** The anchor's progress, for transparency. Never the authority. */
  anchor: PassportAnchorState
  /** The EAS attestation UID — the evidence pointer, not the decision. */
  evidenceUid: string | null
  chainId: number | null
  controls: PassportControlSummary | null
  /** Monotonic marker of the last change to this agent's RECORD, in ms. */
  standingEpoch: number
  issuedAt: number
  expiresAt: number
}

export interface SignedPassportReceipt {
  receipt: PassportReceipt
  /** EIP-191 signature over `canonicalizePassportReceipt(receipt)`. */
  signature: string
}

/**
 * Deterministic serialization — every key sorted, at every depth, no whitespace.
 *
 * The signature is over a STRING, so a verifier that re-serializes differently
 * gets a different digest and rejects a perfectly good receipt. Sorting the
 * keys makes the bytes reproducible from the parsed object alone, which is what
 * lets a merchant verify without keeping Haven's exact wire ordering.
 *
 * ## Do not "simplify" this to `JSON.stringify(obj, Object.keys(obj).sort())`
 *
 * That was the first implementation and it was a security hole. The array form
 * of `JSON.stringify`'s replacer is a **recursive property allow-list**, not a
 * key ordering: nested objects have their keys filtered against the same
 * top-level array. `controls`'s keys are not top-level names, so it serialized
 * as `{}` — and the field the whole receipt is about (`policyEnforcedOnchain`)
 * was excluded from the signed bytes entirely. Two receipts differing only in
 * their control summary signed identically, so anyone could flip an ungoverned
 * agent to `policyEnforcedOnchain: true` and the documented offline check
 * would still pass.
 *
 * Rebuilding the object explicitly is the point: it is the only form where
 * "what is signed" equals "what is in the object", which is the property a
 * merchant is relying on.
 */
export function canonicalizePassportReceipt(receipt: PassportReceipt): string {
  return JSON.stringify(sortDeep(receipt))
}

/**
 * Rebuild `value` with every object's keys in sorted order, recursively.
 *
 * Refuses anything that is not a plain object, array, or JSON primitive. That
 * guard is the same lesson as the bug above, applied forward: a `Date` (or a
 * `Map`, or a class instance) is `typeof 'object'` with NO own enumerable keys,
 * so it would serialize as `{}` and drop out of the signature silently —
 * exactly how `controls` became forgeable. No receipt field is a `Date` today;
 * this makes the day someone adds one a loud failure rather than a quiet hole.
 *
 * `Array.prototype.sort()` with no comparator is UTF-16 code-unit ordering,
 * which the spec fixes — not locale-sensitive, so the bytes are reproducible in
 * any language a merchant verifies from.
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value === null || typeof value !== 'object') return value
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `passport receipt: cannot canonicalize a ${(value as { constructor?: { name?: string } }).constructor?.name ?? 'non-plain'} value — ` +
        'it would serialize as {} and be excluded from the signature. Use a primitive.',
    )
  }
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key])
  return out
}

/**
 * The backend's own `verifyReceipt` vocabulary, unchanged — a merchant that
 * already handles these reasons keeps handling them.
 */
export type PassportSignatureReason =
  | 'not_signed_by_issuer'
  | 'malformed_signature'
  | 'expired'
  | 'unsupported_version'

export type PassportSignatureVerification =
  | { valid: true; issuer: string }
  | { valid: false; reason: PassportSignatureReason }

/**
 * Verify a signed receipt offline against a PINNED issuer.
 *
 * ## Why there is no separate "tampered" reason
 *
 * secp256k1 recovery always yields *an* address. A modified payload recovers a
 * different one, which is indistinguishable from a receipt legitimately signed
 * by somebody else — the cryptography cannot tell those apart, and an API that
 * claimed to would be asserting something it cannot know. So both collapse into
 * `not_signed_by_issuer`: **this was not signed by the key you pinned**, which
 * is the only true statement and, conveniently, the only one a merchant needs.
 *
 * `expired` is kept separate because it calls for a genuinely different
 * response — re-fetch, rather than treat as an attack.
 *
 * Synchronous, because `ethers`' `verifyMessage` is. The backend's
 * `verifyReceipt` is sync and called synchronously in ~15 test sites, so the
 * SDK side is the one that stays sync; only `checkPassport` is async, and only
 * because it fetches.
 */
export function verifyPassportReceiptSignature(
  signed: SignedPassportReceipt,
  expectedIssuer: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): PassportSignatureVerification {
  if (signed.receipt.version !== PASSPORT_RECEIPT_VERSION) {
    return { valid: false, reason: 'unsupported_version' }
  }
  let recovered: string
  try {
    recovered = verifyMessage(canonicalizePassportReceipt(signed.receipt), signed.signature)
  } catch {
    // Structurally invalid — not a signature at all, so nothing was recovered.
    return { valid: false, reason: 'malformed_signature' }
  }
  if (recovered.toLowerCase() !== expectedIssuer.toLowerCase()) {
    return { valid: false, reason: 'not_signed_by_issuer' }
  }
  // Checked AFTER authenticity, deliberately. An expired receipt that also
  // fails authentication is a forgery, and reporting it as merely "expired"
  // would invite a merchant to retry rather than treat it as an attack.
  if (nowSeconds > signed.receipt.expiresAt) {
    return { valid: false, reason: 'expired' }
  }
  return { valid: true, issuer: recovered }
}

/**
 * Every reason a merchant-side check can answer with.
 *
 * The first four are the backend's `verifyReceipt` vocabulary; the next three
 * are the verifier's own `found: false` answers; `subject_mismatch` is this
 * module's binding check; `unavailable` is the wrapper's catch-all.
 */
export type PassportCheckReason =
  | PassportSignatureReason
  | 'not_active'
  | 'no_passport'
  | 'unsupported_assurance_level'
  | 'subject_mismatch'
  | 'unavailable'

/**
 * The answer both helpers return.
 *
 * `standing` is non-null only when the receipt is trustworthy — authentic,
 * unexpired, chain-matched and subject-matched. `not_active` is the one
 * failure that still carries a standing: the receipt is authentic, the answer
 * is simply "not active". Every other failure reports `standing: null`, so a
 * caller can never mistake an unverified artifact for a standing.
 */
export interface PassportCheckResult {
  ok: boolean
  standing: PassportStanding | null
  reason: PassportCheckReason | null
  /** ISO 8601 timestamp of when the check ran. */
  checked_at: string
}

/** The body `GET /passport/verify` answers with. */
export type PassportVerifyBody =
  | { found: false; reason?: string }
  | { found: true; receipt: PassportReceipt; signature: string }

/**
 * The `haven-passport` reference a payment carried (#4722).
 *
 * Both fields are `unknown` on purpose: they arrive from an agent-supplied
 * extension, so they are validated here rather than trusted by the type system.
 */
export interface PassportReference {
  attestation_uid?: unknown
  chain_id?: unknown
}

export interface PassportVerifyOptions {
  /**
   * The issuer address pinned once from `GET /passport/issuer`. REQUIRED —
   * never taken from the receipt's own `issuer` field, which would be circular.
   */
  issuer: string
  /** The address that paid: EIP-3009 `authorization.from`, or the erc7710 `delegator`. */
  payer: string
  /**
   * Which rail the payment used. Omitted, either bound address matches — both
   * are the same agent's addresses, bound by the attestation.
   */
  rail?: 'eip3009' | 'erc7710'
  /** The merchant's chain id. The receipt must name it. */
  chainId: number
  /** The reference the payment carried, if any. Cross-checked as a hint. */
  reference?: PassportReference | null
  /** Current time in seconds. Injectable for tests. */
  nowSeconds?: number
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const UID_RE = /^0x[0-9a-fA-F]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function checkedAtIso(nowSeconds: number | undefined): string {
  return new Date((nowSeconds ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
}

function failure(reason: PassportCheckReason, checkedAt: string, standing: PassportStanding | null = null): PassportCheckResult {
  return { ok: false, standing, reason, checked_at: checkedAt }
}

/**
 * Verify a `GET /passport/verify` body against a pinned issuer and a payer.
 *
 * Pure and synchronous: no network, no clock beyond `nowSeconds`. Throws a
 * `TypeError` when a REQUIRED option is malformed (a bad pin is a programming
 * error, not a verification outcome); every other input — including a body
 * that is not a body at all — returns a `PassportCheckResult`.
 *
 * The checks run in this order, and the order is the contract:
 *
 * 1. `found: false` → the verifier's own reason (`no_passport` /
 *    `unsupported_assurance_level`).
 * 2. signature against the pin → `unsupported_version` / `malformed_signature` /
 *    `not_signed_by_issuer` / `expired`.
 * 3. `receipt.chainId === chainId` → `subject_mismatch`.
 * 4. the payer is bound by the receipt → `subject_mismatch`.
 * 5. the carried reference agrees with the receipt → `subject_mismatch`.
 * 6. `standing === 'active'` → `not_active`.
 *
 * Chain and reference mismatches collapse into `subject_mismatch` rather than
 * growing the vocabulary: the presented reference does not describe a passport
 * for THIS payment, which is the same statement the payer check makes.
 */
export function verifyPassportReceipt(body: unknown, options: PassportVerifyOptions): PassportCheckResult {
  if (!ADDRESS_RE.test(options.issuer)) {
    throw new TypeError('passport verify: `issuer` must be a 0x-prefixed 20-byte address')
  }
  if (!ADDRESS_RE.test(options.payer)) {
    throw new TypeError('passport verify: `payer` must be a 0x-prefixed 20-byte address')
  }
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) {
    throw new TypeError('passport verify: `chainId` must be a positive integer')
  }

  const checkedAt = checkedAtIso(options.nowSeconds)

  if (!isRecord(body)) return failure('unavailable', checkedAt)

  if (body.found === false) {
    return failure(body.reason === 'unsupported_assurance_level' ? 'unsupported_assurance_level' : 'no_passport', checkedAt)
  }
  if (body.found !== true) return failure('unavailable', checkedAt)
  if (!isRecord(body.receipt)) return failure('unavailable', checkedAt)
  if (typeof body.signature !== 'string') return failure('malformed_signature', checkedAt)

  const receipt = body.receipt as unknown as PassportReceipt
  const signature = verifyPassportReceiptSignature(
    { receipt, signature: body.signature },
    options.issuer,
    options.nowSeconds,
  )
  if (!signature.valid) return failure(signature.reason, checkedAt)

  if (receipt.chainId !== options.chainId) return failure('subject_mismatch', checkedAt)

  const payer = options.payer.toLowerCase()
  const candidates =
    options.rail === 'eip3009'
      ? [receipt.agentEoa]
      : options.rail === 'erc7710'
        ? [receipt.smartAccount]
        : [receipt.agentEoa, receipt.smartAccount]
  if (!candidates.some((address) => typeof address === 'string' && address.toLowerCase() === payer)) {
    return failure('subject_mismatch', checkedAt)
  }

  if (options.reference) {
    if (options.reference.chain_id !== options.chainId) return failure('subject_mismatch', checkedAt)
    const uid = options.reference.attestation_uid
    if (typeof uid !== 'string' || !UID_RE.test(uid)) return failure('subject_mismatch', checkedAt)
    // The UID is a HINT: the address binding above is the authority. It is
    // still cross-checked, because a payment that names agent B's UID while
    // agent A pays is exactly the "lent passport" shape this module exists to
    // refuse — and it must never come back as a standing.
    if (receipt.evidenceUid !== null && receipt.evidenceUid.toLowerCase() !== uid.toLowerCase()) {
      return failure('subject_mismatch', checkedAt)
    }
  }

  if (receipt.standing !== 'active') {
    return failure('not_active', checkedAt, receipt.standing)
  }

  return { ok: true, standing: 'active', reason: null, checked_at: checkedAt }
}

export interface CheckPassportOptions extends PassportVerifyOptions {
  /** Haven base URL, e.g. `https://api.haven.dev`. Required. */
  baseUrl: string
  /** Timeout in milliseconds. Defaults to `PASSPORT_CHECK_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Injectable `fetch` for tests. */
  fetch?: typeof fetch
}

/**
 * Fetch a passport from Haven and verify it. The wrapper a merchant calls.
 *
 * Looks the passport up by **payer address**, never by the UID the payment
 * carried — see this module's header for why. The UID is cross-checked against
 * the receipt afterwards.
 *
 * Never throws and never refuses: a 503, a 429, a 400, any other non-200, a
 * timeout, a network error and a non-JSON body all answer `unavailable`. That
 * is deliberate — the check is advisory, and a merchant that turned an
 * unavailable verifier into a refusal would be handing Haven an availability
 * veto over its own revenue.
 *
 * No caching. The receipt is designed to be cached for its TTL, but that is
 * the CALLER's decision: a wrapper that cached would hide a revocation for as
 * long as its cache lived, and the caller is the one that knows whether the
 * next action is reversible.
 */
export async function checkPassport(options: CheckPassportOptions): Promise<PassportCheckResult> {
  // One clock read for the whole check, so `checked_at` cannot disagree with
  // the expiry decision the verifier makes a few milliseconds later.
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const checkedAt = checkedAtIso(nowSeconds)
  const unavailable = failure('unavailable', checkedAt)
  try {
    const base = options.baseUrl.replace(/\/+$/, '')
    const url = `${base}/passport/verify?address=${encodeURIComponent(options.payer)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PASSPORT_CHECK_TIMEOUT_MS)
    try {
      const response = await (options.fetch ?? fetch)(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      if (response.status !== 200) return unavailable
      const body: unknown = await response.json()
      return verifyPassportReceipt(body, { ...options, nowSeconds })
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return unavailable
  }
}
