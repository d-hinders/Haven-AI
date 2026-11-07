/**
 * #4723 (epic #4718): the cross-check between what Haven SIGNS and what a
 * merchant VERIFIES.
 *
 * This test lives in the backend because the SDK cannot import the backend: the
 * backend signs with `signReceipt`, and the SDK's `verifyPassportReceipt` — the
 * exact function a merchant calls — verifies. If the canonicalization drifts,
 * this fails. That is the whole point: with one canonicalizer, a sign+verify
 * pair inside the SDK would stay self-consistent through a reordering or a
 * serialization change and still break every merchant using the documented
 * snippet.
 *
 * The golden vectors below are LITERALS. They are the only thing that catches a
 * change that is self-consistent on both sides.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { Wallet } from 'ethers'
import {
  canonicalizePassportReceipt,
  verifyPassportReceipt,
  verifyPassportReceiptSignature,
  PASSPORT_RECEIPT_VERSION,
} from '@haven_ai/sdk'
import {
  canonicalize,
  signReceipt,
  verifyReceipt,
  setReceiptSigningKey,
  RECEIPT_VERSION,
  type PassportReceipt,
} from '../receipt.js'
import { AssuranceLevel } from '../schema.js'

const SIGNER = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const OTHER = new Wallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a')
const EOA = '0x15179876c595922999c2d5dc7c23cc7711fe799a'
const SMART = '0x9999999999999999999999999999999999999999'
const UID = `0x${'ab'.repeat(32)}`
const CHAIN_ID = 84532
const NOW = 1_800_000_000

function receipt(overrides: Partial<PassportReceipt> = {}): PassportReceipt {
  return {
    version: RECEIPT_VERSION,
    issuer: SIGNER.address,
    agentId: 'agt_1',
    agentEoa: EOA,
    smartAccount: SMART,
    assuranceLevel: AssuranceLevel.L0,
    standing: 'active',
    anchor: 'anchored',
    evidenceUid: UID,
    chainId: CHAIN_ID,
    controls: { rail: 'delegation', policyEnforcedOnchain: true, treasuryBound: true },
    standingEpoch: 1_700_000_000_000,
    issuedAt: NOW - 10,
    expiresAt: NOW + 290,
    ...overrides,
  }
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    issuer: SIGNER.address,
    payer: EOA,
    chainId: CHAIN_ID,
    nowSeconds: NOW,
    ...overrides,
  }
}

beforeEach(() => {
  setReceiptSigningKey(SIGNER.privateKey)
})

describe('the SDK verifies what the backend signs', () => {
  it('a receipt signed by signReceipt verifies through the merchant helper', async () => {
    const signed = await signReceipt(receipt())
    expect(verifyPassportReceipt({ found: true, ...signed }, options())).toMatchObject({
      ok: true,
      standing: 'active',
      reason: null,
    })
  })

  it('a mutated controls.policyEnforcedOnchain is not_signed_by_issuer', async () => {
    const signed = await signReceipt(receipt())
    const forged = {
      found: true as const,
      receipt: { ...signed.receipt, controls: { ...signed.receipt.controls!, policyEnforcedOnchain: false } },
      signature: signed.signature,
    }
    expect(verifyPassportReceipt(forged, options())).toMatchObject({
      ok: false,
      standing: null,
      reason: 'not_signed_by_issuer',
    })
  })

  it('an expired receipt is expired', async () => {
    const signed = await signReceipt(receipt())
    expect(verifyPassportReceipt({ found: true, ...signed }, options({ nowSeconds: NOW + 1000 }))).toMatchObject({
      ok: false,
      reason: 'expired',
    })
  })

  it('a non-active standing is not_active', async () => {
    const signed = await signReceipt(receipt({ standing: 'suspended' }))
    expect(verifyPassportReceipt({ found: true, ...signed }, options())).toMatchObject({
      ok: false,
      standing: 'suspended',
      reason: 'not_active',
    })
  })

  it('the receipt’s own issuer as the pin is not_signed_by_issuer', async () => {
    const signed = await signReceipt(receipt())
    // The pin is an ARGUMENT. Passing the receipt's own `issuer` is the
    // circular mistake the doc warns about; here it is simply a wrong pin.
    expect(verifyPassportReceipt({ found: true, ...signed }, options({ issuer: OTHER.address }))).toMatchObject({
      ok: false,
      reason: 'not_signed_by_issuer',
    })
  })

  it('the backend’s verifyReceipt and the SDK’s signature verifier agree', async () => {
    const signed = await signReceipt(receipt())
    expect(verifyReceipt(signed, SIGNER.address, NOW)).toEqual(
      verifyPassportReceiptSignature(signed, SIGNER.address, NOW),
    )
  })
})

describe('one canonicalizer, pinned by literals', () => {
  it('the backend delegates to the SDK rather than keeping a copy', () => {
    expect(canonicalize(receipt())).toBe(canonicalizePassportReceipt(receipt()))
  })

  it('the version constant is the SDK’s', () => {
    expect(RECEIPT_VERSION).toBe(PASSPORT_RECEIPT_VERSION)
  })

  it('produces the pinned canonical string', () => {
    expect(canonicalize(receipt())).toBe(CANONICAL_VECTOR)
  })

  it('agrees with the documented snippet implementation', () => {
    const canon = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(canon)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.keys(v as Record<string, unknown>)
                .sort()
                .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
            )
          : v
    expect(JSON.stringify(canon(receipt()))).toBe(canonicalize(receipt()))
  })
})

// Filled from a real run of the fixture above; see the vector test.
const CANONICAL_VECTOR = `{"agentEoa":"0x15179876c595922999c2d5dc7c23cc7711fe799a","agentId":"agt_1","anchor":"anchored","assuranceLevel":0,"chainId":84532,"controls":{"policyEnforcedOnchain":true,"rail":"delegation","treasuryBound":true},"evidenceUid":"0xabababababababababababababababababababababababababababababababab","expiresAt":1800000290,"issuedAt":1799999990,"issuer":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8","smartAccount":"0x9999999999999999999999999999999999999999","standing":"active","standingEpoch":1700000000000,"version":"haven-passport-receipt/2"}`
