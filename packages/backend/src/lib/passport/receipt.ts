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
 *    strictly comparable: the higher epoch reflects newer state. Without it a
 *    merchant replaying a cached receipt has no way to know a newer one exists
 *    — and clock skew makes `issuedAt` alone unreliable for that.
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

/** Bumped if the signed payload's shape ever changes. Part of what is signed. */
export const RECEIPT_VERSION = 'haven-passport-receipt/1'

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
  /** The rail whose primitive holds the policy: 'delegation' or 'allowance'. */
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
   * Monotonic marker of when this agent's standing last changed, in ms.
   * Strictly comparable across receipts; `issuedAt` is not, because clocks skew.
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
 * Deterministic serialization — sorted keys, no whitespace.
 *
 * The signature is over a STRING, so a verifier that re-serializes differently
 * gets a different digest and rejects a perfectly good receipt. Sorting the
 * keys makes the bytes reproducible from the parsed object alone, which is what
 * lets a merchant verify without keeping our exact wire ordering.
 */
export function canonicalize(receipt: PassportReceipt): string {
  return JSON.stringify(receipt, Object.keys(receipt).sort())
}

let signerKey: string | null = null

/**
 * Configure the receipt signing key. Injectable so tests never need a real key
 * and so `index.ts` stays the only place that reads the environment.
 */
export function setReceiptSigningKey(privateKey: string | null): void {
  signerKey = privateKey && privateKey.trim() ? privateKey.trim() : null
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
