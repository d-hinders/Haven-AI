/**
 * Passport deployment readiness (#1151).
 *
 * The bug this covers is not a crash — it is silence. Dev anchored three real
 * L0 passports while `PASSPORT_RECEIPT_SIGNING_KEY` was unset, so no merchant
 * could verify any of them, and nothing in the system said so. These tests pin
 * the four env combinations and, above all, that the half-configured one is the
 * ONE that warns: a warning that also fires when things are fine is a warning
 * operators learn to ignore.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  passportReadiness,
  logPassportReadiness,
  setReceiptSigningKey,
  isReceiptSigningConfigured,
  receiptIssuerAddress,
  PASSPORT_CHAIN_IDS,
  type PassportReadiness,
} from '../index.js'

const CHAIN = 84532
const UID = '0x' + 'ab'.repeat(32)
// A throwaway signing key — deterministic so the issuer address is assertable.
const SIGNING_KEY = '0x' + '11'.repeat(32)
const SIGNING_KEY_ADDRESS = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'

const withUid = { [`AGENT_PASSPORT_SCHEMA_UID_${CHAIN}`]: UID } as NodeJS.ProcessEnv
const withoutUid = {} as NodeJS.ProcessEnv

/** Capture what `logPassportReadiness` emitted. */
function captureWarnings(readiness: PassportReadiness) {
  const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = []
  logPassportReadiness({ warn: (obj, msg) => warnings.push({ obj, msg }) }, readiness)
  return warnings
}

afterEach(() => {
  // The signer is module state — leaving it set would leak into sibling suites.
  setReceiptSigningKey(null)
})

describe('the four configuration combinations', () => {
  it('neither → unconfigured, and silent', () => {
    const readiness = passportReadiness({
      chainIds: [CHAIN],
      env: withoutUid,
      verificationConfigured: false,
      issuerAddress: null,
    })
    expect(readiness.chains).toEqual([
      {
        chainId: CHAIN,
        issuanceConfigured: false,
        verificationConfigured: false,
        state: 'unconfigured',
      },
    ])
    expect(readiness.unverifiableChainIds).toEqual([])
    expect(captureWarnings(readiness)).toEqual([])
  })

  it('issuance only → issuance_only, and this is the one that warns', () => {
    const readiness = passportReadiness({
      chainIds: [CHAIN],
      env: withUid,
      verificationConfigured: false,
      issuerAddress: null,
    })
    expect(readiness.chains[0]?.state).toBe('issuance_only')
    expect(readiness.unverifiableChainIds).toEqual([CHAIN])

    const warnings = captureWarnings(readiness)
    expect(warnings).toHaveLength(1)
    // Naming the chain is the point — an operator has to know WHICH deployment
    // half is missing, not merely that something is off.
    expect(warnings[0]?.obj).toEqual({ chainIds: [CHAIN] })
    expect(warnings[0]?.msg).toContain(String(CHAIN))
    expect(warnings[0]?.msg).toContain('PASSPORT_RECEIPT_SIGNING_KEY')
  })

  it('verification only → verification_only, and silent', () => {
    // Legitimate: the verifier is DB-authoritative, so a deployment can answer
    // for passports it holds rows for without issuing new ones.
    const readiness = passportReadiness({
      chainIds: [CHAIN],
      env: withoutUid,
      verificationConfigured: true,
      issuerAddress: SIGNING_KEY_ADDRESS,
    })
    expect(readiness.chains[0]?.state).toBe('verification_only')
    expect(readiness.unverifiableChainIds).toEqual([])
    expect(captureWarnings(readiness)).toEqual([])
  })

  it('both → ready, and silent', () => {
    const readiness = passportReadiness({
      chainIds: [CHAIN],
      env: withUid,
      verificationConfigured: true,
      issuerAddress: SIGNING_KEY_ADDRESS,
    })
    expect(readiness.chains[0]?.state).toBe('ready')
    expect(readiness.unverifiableChainIds).toEqual([])
    expect(captureWarnings(readiness)).toEqual([])
  })

  it('stays silent when the deployment serves no passport chains at all', () => {
    const readiness = passportReadiness({
      chainIds: [],
      env: withUid,
      verificationConfigured: false,
      issuerAddress: null,
    })
    expect(readiness.chains).toEqual([])
    expect(captureWarnings(readiness)).toEqual([])
  })
})

describe('what the summary is allowed to say', () => {
  it('carries the published issuer address but never key material', () => {
    setReceiptSigningKey(SIGNING_KEY)
    const readiness = passportReadiness({ chainIds: [CHAIN], env: withUid })

    expect(readiness.verification.configured).toBe(true)
    // The issuer address is already served publicly at GET /passport/issuer for
    // merchants to pin, so repeating it here reveals nothing new.
    expect(readiness.verification.issuer).toBe(SIGNING_KEY_ADDRESS)

    const serialized = JSON.stringify(readiness).toLowerCase()
    expect(serialized).not.toContain(SIGNING_KEY.slice(2).toLowerCase())
    expect(serialized).not.toContain('11'.repeat(16))
  })

  it('never leaks the schema UID — it is operator config, not probe output', () => {
    const readiness = passportReadiness({
      chainIds: [CHAIN],
      env: withUid,
      verificationConfigured: true,
      issuerAddress: SIGNING_KEY_ADDRESS,
    })
    expect(JSON.stringify(readiness).toLowerCase()).not.toContain(UID.slice(2).toLowerCase())
  })

  it('reports issuer null when verification is off', () => {
    const readiness = passportReadiness({
      chainIds: [CHAIN],
      env: withUid,
      verificationConfigured: false,
      // Even if a stale address were passed in, an unconfigured verifier must
      // not publish an issuer to pin.
      issuerAddress: SIGNING_KEY_ADDRESS,
    })
    expect(readiness.verification).toEqual({ configured: false, issuer: null })
  })
})

describe('defaults read live configuration', () => {
  it('falls back to the passport chain set and the live signer state', () => {
    setReceiptSigningKey(SIGNING_KEY)
    expect(isReceiptSigningConfigured()).toBe(true)
    expect(receiptIssuerAddress()).toBe(SIGNING_KEY_ADDRESS)

    const readiness = passportReadiness({ env: withoutUid })
    expect(readiness.chains.map((c) => c.chainId)).toEqual([...PASSPORT_CHAIN_IDS].sort((a, b) => a - b))
    expect(readiness.verification).toEqual({ configured: true, issuer: SIGNING_KEY_ADDRESS })
  })

  it('sorts chains so the /health block is stable across restarts', () => {
    const readiness = passportReadiness({
      chainIds: [8453, 84532, 100],
      env: withoutUid,
      verificationConfigured: false,
      issuerAddress: null,
    })
    expect(readiness.chains.map((c) => c.chainId)).toEqual([100, 8453, 84532])
  })
})
