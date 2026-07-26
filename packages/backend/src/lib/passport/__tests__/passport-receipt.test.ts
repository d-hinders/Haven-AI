import { describe, it, expect, beforeEach } from 'vitest'
import { Wallet, verifyMessage } from 'ethers'
import {
  canonicalize,
  signReceipt,
  verifyReceipt,
  setReceiptSigningKey,
  receiptIssuerAddress,
  isReceiptSigningConfigured,
  RECEIPT_TTL_SECONDS,
  RECEIPT_VERSION,
  type PassportReceipt,
} from '../receipt.js'
import { AssuranceLevel } from '../schema.js'

/**
 * The receipt is the artifact a merchant trusts WITHOUT calling Haven, so these
 * tests deliberately verify it the way a merchant would — through ethers'
 * `verifyMessage` against a pinned address, not through a Haven-only helper. A
 * verification path only we can run proves nothing about the integration.
 */

const SIGNER = Wallet.createRandom()
const OTHER = Wallet.createRandom()
const EOA = '0x15179876c595922999c2d5dc7c23cc7711fe799a'

function receipt(overrides: Partial<PassportReceipt> = {}): PassportReceipt {
  const now = Math.floor(Date.now() / 1000)
  return {
    version: RECEIPT_VERSION,
    issuer: SIGNER.address,
    agentId: 'agt_1',
    agentEoa: EOA,
    smartAccount: null,
    assuranceLevel: AssuranceLevel.L0,
    standing: 'active',
    anchor: 'anchored',
    evidenceUid: '0x' + 'ab'.repeat(32),
    chainId: 84532,
    controls: { rail: 'delegation', policyEnforcedOnchain: true, treasuryBound: true },
    standingEpoch: 1_700_000_000_000,
    issuedAt: now,
    expiresAt: now + RECEIPT_TTL_SECONDS,
    ...overrides,
  }
}

beforeEach(() => {
  setReceiptSigningKey(SIGNER.privateKey)
})

describe('offline verification — the whole point of a signed receipt', () => {
  it('a merchant verifies with plain ethers against a PINNED address', async () => {
    const signed = await signReceipt(receipt())
    // Exactly the five lines a merchant runs. No Haven call, no Haven code.
    const recovered = verifyMessage(canonicalize(signed.receipt), signed.signature)
    expect(recovered.toLowerCase()).toBe(SIGNER.address.toLowerCase())
  })

  it('canonicalization is ORDER-INDEPENDENT — a reordered object still verifies', async () => {
    // A merchant that parses JSON and re-serializes has no reason to preserve
    // our key order. If the digest depended on it, every such merchant would
    // reject perfectly good receipts and conclude Haven was forging them.
    const signed = await signReceipt(receipt())
    const shuffled = Object.fromEntries(
      Object.entries(signed.receipt).reverse(),
    ) as unknown as PassportReceipt
    expect(canonicalize(shuffled)).toBe(canonicalize(signed.receipt))
    expect(verifyReceipt({ ...signed, receipt: shuffled }, SIGNER.address).valid).toBe(true)
  })

  it('REJECTS a tampered standing — the field that decides the merchant’s answer', async () => {
    const signed = await signReceipt(receipt({ standing: 'revoked' }))
    const forged = { ...signed, receipt: { ...signed.receipt, standing: 'active' as const } }
    // Reported as "not signed by the issuer you pinned" rather than as
    // "tampered": recovery yields SOME address for any payload, so the two are
    // cryptographically indistinguishable and the API must not pretend otherwise.
    expect(verifyReceipt(forged, SIGNER.address)).toEqual({
      valid: false,
      reason: 'not_signed_by_issuer',
    })
  })

  it('REJECTS an extended expiry — a merchant cannot widen its own freshness window', async () => {
    const signed = await signReceipt(receipt())
    const forged = {
      ...signed,
      receipt: { ...signed.receipt, expiresAt: signed.receipt.expiresAt + 86_400 },
    }
    expect(verifyReceipt(forged, SIGNER.address).valid).toBe(false)
  })

  it('rejects a receipt signed by a key the merchant did not pin', async () => {
    setReceiptSigningKey(OTHER.privateKey)
    const signed = await signReceipt(receipt({ issuer: OTHER.address }))
    // Distinguishable from "expired", which is the one distinction that
    // changes what a merchant should do: re-fetch vs. treat as an attack.
    expect(verifyReceipt(signed, SIGNER.address)).toEqual({
      valid: false,
      reason: 'not_signed_by_issuer',
    })
  })

  it('reports a forged EXPIRED receipt as unauthentic, not as expired', async () => {
    // Order matters: reporting a forgery as merely stale invites the merchant
    // to retry rather than to treat it as an attack.
    const signed = await signReceipt(receipt())
    const forged = { ...signed, receipt: { ...signed.receipt, agentId: 'agt_other' } }
    const later = signed.receipt.expiresAt + 10
    expect(verifyReceipt(forged, SIGNER.address, later)).toEqual({
      valid: false,
      reason: 'not_signed_by_issuer',
    })
  })
})

describe('freshness is signed, not advisory', () => {
  it('expires exactly at the TTL boundary', async () => {
    const signed = await signReceipt(receipt())
    const { expiresAt } = signed.receipt
    expect(verifyReceipt(signed, SIGNER.address, expiresAt).valid).toBe(true)
    expect(verifyReceipt(signed, SIGNER.address, expiresAt + 1)).toEqual({
      valid: false,
      reason: 'expired',
    })
  })

  it('the TTL is short enough that a revoke cannot hide behind a cache for long', () => {
    // A deliberate bound, asserted so raising it becomes a visible decision:
    // the L0 pitch is LIVE revocation, and a long-lived cacheable receipt is
    // the one way to quietly undo that.
    expect(RECEIPT_TTL_SECONDS).toBeLessThanOrEqual(600)
    expect(RECEIPT_TTL_SECONDS).toBeGreaterThan(0)
  })

  it('rejects a receipt from a future payload version', async () => {
    const signed = await signReceipt(receipt())
    const bumped = { ...signed, receipt: { ...signed.receipt, version: 'haven-passport-receipt/2' } }
    expect(verifyReceipt(bumped, SIGNER.address)).toEqual({
      valid: false,
      reason: 'unsupported_version',
    })
  })
})

describe('fail-closed when signing is unconfigured', () => {
  it('THROWS rather than returning an unsigned receipt', async () => {
    setReceiptSigningKey(null)
    expect(isReceiptSigningConfigured()).toBe(false)
    expect(receiptIssuerAddress()).toBeNull()
    // An unsigned "receipt" is indistinguishable from a forged one to anything
    // that does not check for a missing field — so the shape must not exist.
    await expect(signReceipt(receipt())).rejects.toThrow(/not configured/)
  })

  it('treats a blank key as unconfigured, not as a key', async () => {
    setReceiptSigningKey('   ')
    expect(isReceiptSigningConfigured()).toBe(false)
  })
})
