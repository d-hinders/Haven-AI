/**
 * L0 Agent Passport — the signed verification receipt (#974, epic #970).
 *
 * ## Why a signed artifact and not a boolean
 *
 * From external review on the epic: a bare `{ ok: true }` forces a live call to
 * Haven for every merchant decision. That is an availability coupling (Haven
 * down = merchants can't gate) and a privacy one (Haven sees every merchant's
 * traffic pattern). A **self-contained signed receipt** a merchant can cache,
 * replay, or attach to a payment flow removes both — its authenticity is
 * checkable offline, with no call back to us.
 *
 * ## The freshness problem this creates, and how it is bounded
 *
 * A cacheable receipt is BY DEFINITION potentially stale on replay: the agent
 * can be revoked a second after it was issued. Left unbounded that would
 * reintroduce exactly the "anchor says authorized, issuer says revoked" gap
 * #973 exists to close — only with the merchant's cache playing the part of the
 * lagging chain. Three things bound it, and all three are part of the artifact
 * rather than advice in a doc:
 *
 * 1. **A short, explicit TTL.** `expiresAt` is signed, so a merchant cannot
 *    extend it and an expired receipt is objectively expired rather than a
 *    matter of local policy.
 * 2. **A monotonic `standingEpoch`.** Two receipts for the same agent are
 *    ordered by it: the higher epoch reflects a newer AGENT RECORD. Without it
 *    a merchant comparing two receipts has no reliable way to tell which is
 *    newer — clock skew makes `issuedAt` unusable for that. It gives ORDERING
 *    only: a higher epoch does not mean standing changed, and an EQUAL epoch
 *    does not mean an equal receipt, because anchor state moves without it
 *    (#1015 — see the field's own doc).
 * 3. **Documented re-verification.** Cached receipts are for routine gating and
 *    rate-limiting. Re-verify before anything irreversible.
 *
 * The endpoint itself always answers from current state; caching is the
 * merchant's decision, never ours.
 *
 * ## Signing
 *
 * secp256k1 / EIP-191 (`personal_sign`) over a canonical JSON serialization.
 * Chosen because any merchant already touching x402 has viem or ethers, so
 * offline verification is `verifyMessage(...)` — no new dependency, no JWKS
 * fetch, and the issuer is identified by an address they can pin.
 *
 * The key is DEDICATED (`PASSPORT_RECEIPT_SIGNING_KEY`) and must never be the
 * relayer key. The relayer pays gas for user-authorised transactions; a receipt
 * key signs public assertions and is handed out for verification. Reusing one
 * for the other would put a key that touches value into a public, permissionless
 * role — the same rule `PASSPORT_SCHEMA_REGISTRAR_KEY` follows.
 */

import { Wallet, verifyMessage } from 'ethers'
import type { AnchorState, Standing } from './revocation.js'
import { AssuranceLevel } from './schema.js'

/**
 * How long a receipt may be replayed, in seconds.
 *
 * 300s is a deliberate choice, not a default. Shorter and caching buys a
 * merchant nothing over calling us; much longer and a revocation could go
 * unnoticed for most of a payment session — and the whole L0 pitch is that
 * revocation is live. Five minutes keeps a burst of routine gating decisions
 * on one receipt while keeping the worst-case staleness inside the window an
 * operator would notice a revoke in anyway.
 */
export const RECEIPT_TTL_SECONDS = 300

/**
 * Bumped if the signed payload's shape or its serialization ever changes. Part
 * of what is signed.
 *
 * `/2` fixes a real defect in `/1`: the canonicalizer used
 * `JSON.stringify(receipt, Object.keys(receipt).sort())`, whose array-replacer
 * form is a **recursive property allow-list**, not a key ordering. Nested keys
 * are filtered against the same top-level list, so `controls` serialized as
 * `{}` and was therefore never signed — two receipts differing only in
 * `policyEnforcedOnchain` produced byte-identical signatures. `/1` was never
 * released; the version is bumped anyway so any receipt minted against it can
 * never verify.
 */
export const RECEIPT_VERSION = 'haven-passport-receipt/2'

/**
 * The enforced controls, as a SUMMARY.
 *
 * Booleans and rail names only — never budget amounts, recipients, balances, or
 * anything naming the owner. A merchant needs to know an agent is governed, not
 * how much it may spend; disclosing that would leak the owner's treasury policy
 * to every merchant the agent touches. Minimal disclosure is the default and
 * there is deliberately no flag here that widens it.
 */
export interface ControlSummary {
  /**
   * The account's `execution_rail`, verbatim from `user_safes`. The CHECK
   * domain is `delegation | allowance_module | session_key` (migration 041);
   * only `delegation` is live (#1440, #834). Never `'allowance'` — that value
   * was documented for years and is not one the column can hold (#2110).
   */
  rail: string
  /** Whether the spending policy is enforced by a contract rather than by Haven. */
  policyEnforcedOnchain: boolean
  /** Whether the agent's authority is scoped to a treasury account. */
  treasuryBound: boolean
}

/** The payload that is signed. Field order here is NOT the canonical order. */
export interface PassportReceipt {
  version: string
  /** Haven, identified by the signing address a merchant can pin. */
  issuer: string
  /** Haven's opaque agent id. Not PII and not a wallet. */
  agentId: string
  /** The delegate EOA — what a merchant sees on an EIP-3009 header. */
  agentEoa: string | null
  /** The Hybrid delegator — what a merchant sees in erc7710 redemption. */
  smartAccount: string | null
  assuranceLevel: AssuranceLevel
  /** THE answer. Never derived from the chain — see revocation.ts. */
  standing: Standing
  /** The anchor's progress, for transparency. Never the authority. */
  anchor: AnchorState
  /** The EAS attestation UID — the evidence pointer, not the decision. */
  evidenceUid: string | null
  chainId: number | null
  controls: ControlSummary | null
  /**
   * Monotonic marker of the last change to this agent's RECORD, in ms.
   * Strictly comparable across receipts; `issuedAt` is not, because clocks skew.
   *
   * Do NOT read a change here as "standing changed" (#1015). It is sourced from
   * `agents.updated_at`, which moves whenever a statement explicitly sets it —
   * a rename or a key rotation do; an agent's `last_seen_at` touch does NOT.
   * (There is no trigger on the column; the first version of this comment said
   * "any write", which was itself false.) The name is historical; the guarantee
   * is ORDERING, not causation.
   *
   * What merchants rely on holds and errs safe: **every writer of
   * `agents.status` also sets `updated_at`** — audited, and pinned by
   * `agent-status-epoch.test.ts` so the next writer cannot quietly break it.
   * Given that, of two receipts the one reflecting a revoke always carries the
   * higher epoch. It does NOT mean a merchant holding one cached receipt can
   * detect a revoke — `expiresAt` and re-verification bound that, not this.
   *
   * NOT covered: anchor progress. `anchor`, `evidenceUid`, `agentEoa` and
   * `smartAccount` come from `agent_passports`, which does not touch
   * `agents.updated_at`, so a passport can go not_anchored → anchored with the
   * epoch unchanged. Equal epoch does not mean equal receipt.
   *
   * `0` is the sentinel for a row with no timestamp. It sorts below every real
   * epoch, so two epoch-0 receipts are mutually incomparable — the ordering
   * guarantee degrades rather than lying.
   *
   * A dedicated `standing_changed_at` column would make the stronger reading
   * true. Deliberately deferred (#1015): it is a migration, and no integrator
   * has asked. Revisit when one does.
   */
  standingEpoch: number
  issuedAt: number
  expiresAt: number
}

export interface SignedPassportReceipt {
  receipt: PassportReceipt
  /** EIP-191 signature over `canonicalize(receipt)`. */
  signature: string
}

/**
 * Deterministic serialization — every key sorted, at every depth, no whitespace.
 *
 * The signature is over a STRING, so a verifier that re-serializes differently
 * gets a different digest and rejects a perfectly good receipt. Sorting the
 * keys makes the bytes reproducible from the parsed object alone, which is what
 * lets a merchant verify without keeping our exact wire ordering.
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
export function canonicalize(receipt: PassportReceipt): string {
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
      `passport receipt: cannot canonicalize a ${value.constructor?.name ?? 'non-plain'} value — ` +
        'it would serialize as {} and be excluded from the signature. Use a primitive.',
    )
  }
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key])
  return out
}

let signerKey: string | null = null

/**
 * Configure the receipt signing key. Injectable so tests never need a real key
 * and so `index.ts` stays the only place that reads the environment.
 *
 * `forbiddenKeys` is a real backstop, not a formality. "Two signers, neither
 * able to spend" is enforced statically by a non-custody invariant test — but
 * that test reads source text, so it cannot see that an operator pasted the
 * RELAYER key into `PASSPORT_RECEIPT_SIGNING_KEY`. That single copy-paste
 * collapses the two roles back into one and puts a key that pays gas for
 * user-authorised transactions into a public, permissionless signing role
 * whose address Haven then PUBLISHES. It must fail at boot, loudly, rather
 * than pass green tests.
 */
export function setReceiptSigningKey(
  privateKey: string | null,
  forbiddenKeys: ReadonlyArray<string | null | undefined> = [],
): void {
  const key = privateKey && privateKey.trim() ? privateKey.trim() : null
  // Cleared BEFORE validating, so a rejected configuration can never leave an
  // earlier signer active. At boot the throw is fatal anyway; this matters for
  // any later re-configuration, where "the new key was refused" must not mean
  // "the old one silently kept signing".
  signerKey = null
  if (key && forbiddenKeys.some((k) => k && sameKey(k, key))) {
    throw new Error(
      'PASSPORT_RECEIPT_SIGNING_KEY must not be the relayer key: its address is published ' +
        'for merchants to pin, and the relayer pays gas for user-authorised transactions.',
    )
  }
  signerKey = key
}

/**
 * Do two env values denote the SAME private key?
 *
 * Compared on the key's VALUE, not its text. The threat is an operator pasting
 * one key into two variables, and a paste routinely differs in casing or the
 * `0x` prefix while being cryptographically identical — a text comparison would
 * wave exactly the mistake it exists to catch straight through.
 */
function sameKey(a: string, b: string): boolean {
  const normalize = (k: string) => k.trim().toLowerCase().replace(/^0x/, '')
  return normalize(a) === normalize(b)
}

export function isReceiptSigningConfigured(): boolean {
  return signerKey !== null
}

/**
 * The issuer address merchants pin. Null when signing is unconfigured — the
 * caller is expected to fail closed rather than serve an unsigned receipt.
 */
export function receiptIssuerAddress(): string | null {
  if (!signerKey) return null
  try {
    return new Wallet(signerKey).address
  } catch {
    return null
  }
}

/**
 * Sign a receipt.
 *
 * Throws when unconfigured rather than returning an unsigned artifact. An
 * unsigned "receipt" is indistinguishable from a forged one to anything that
 * does not carefully check for a missing field, and something eventually will
 * not — so the shape must not exist at all.
 */
export async function signReceipt(receipt: PassportReceipt): Promise<SignedPassportReceipt> {
  if (!signerKey) {
    throw new Error('passport receipt signing is not configured (PASSPORT_RECEIPT_SIGNING_KEY)')
  }
  const signature = await new Wallet(signerKey).signMessage(canonicalize(receipt))
  return { receipt, signature }
}

/**
 * Verify a receipt offline. Exported so Haven's own tests check exactly what a
 * merchant would run — a verification path only we can execute proves nothing.
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
 */
export type ReceiptVerification =
  | { valid: true; issuer: string }
  | {
      valid: false
      reason: 'not_signed_by_issuer' | 'malformed_signature' | 'expired' | 'unsupported_version'
    }

export function verifyReceipt(
  signed: SignedPassportReceipt,
  expectedIssuer: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ReceiptVerification {
  if (signed.receipt.version !== RECEIPT_VERSION) {
    return { valid: false, reason: 'unsupported_version' }
  }
  let recovered: string
  try {
    recovered = verifyMessage(canonicalize(signed.receipt), signed.signature)
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
