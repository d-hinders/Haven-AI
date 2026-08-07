import { describe, it, expect, beforeEach } from 'vitest'
import { AbiCoder, Interface } from 'ethers'
import { buildAttestCall, encodeClaim } from '../attestation.js'
import { getEasDeployment, AssuranceLevel, PASSPORT_SCHEMA } from '../index.js'
import type { PassportClaim } from '../issuance.js'

/**
 * These tests exist because `attestation.ts` CLAIMS them in its own docstring
 * ("a test asserts the target is the pinned EAS address and the value is zero,
 * so a future edit that pointed this at a token contract would fail loudly").
 * It shipped without them in the first draft of #972 — a safety claim in a
 * comment is worth nothing unless something enforces it. This is the only
 * module that submits a transaction with the gas-only relayer.
 */

const UID = '0x' + 'ab'.repeat(32)
const EOA = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SMART = '0x2222222222222222222222222222222222222222'
const TREASURY = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const claim: PassportClaim = {
  agentEoa: EOA,
  smartAccount: SMART,
  treasury: TREASURY,
  assuranceLevel: AssuranceLevel.L0,
  policyUri: 'haven:agent:abc',
  issuedAt: 1_700_000_000,
  expiresAt: 0,
}

beforeEach(() => {
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = UID
})

describe('non-custody: the transaction shape', () => {
  it('targets the PINNED EAS contract and nothing else', () => {
    const call = buildAttestCall(84532, claim)
    expect(call.to).toBe(getEasDeployment(84532).eas)
  })

  it('carries ZERO value — an attestation moves no funds', () => {
    expect(buildAttestCall(84532, claim).value).toBe(0n)
  })

  it('encodes attest() with value 0 in the inner request too', () => {
    // A non-zero inner `value` would make EAS forward ETH to a resolver.
    const call = buildAttestCall(84532, claim)
    const iface = new Interface([
      'function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data)) external payable returns (bytes32)',
    ])
    const [request] = iface.decodeFunctionData('attest', call.data)
    expect(request.data.value).toBe(0n)
    expect(request.schema).toBe(UID)
    // Revocable: live revocation is the core L0 claim (#973).
    expect(request.data.revocable).toBe(true)
    // The agent EOA is the subject — what a merchant looks up.
    expect(request.data.recipient.toLowerCase()).toBe(EOA.toLowerCase())
  })

  it('refuses to build against an unpinned chain', () => {
    expect(() => buildAttestCall(8453, claim)).toThrow(/no pinned EAS deployment/)
  })

  it('refuses to build when the schema is unregistered', () => {
    delete process.env.AGENT_PASSPORT_SCHEMA_UID_84532
    expect(() => buildAttestCall(84532, claim)).toThrow(/has not been registered/)
  })
})

describe('claim encoding matches PASSPORT_SCHEMA', () => {
  it('encodes fields in SCHEMA ORDER — a reorder silently corrupts every passport', () => {
    // The schema string is positional. Decoding with types derived from
    // PASSPORT_SCHEMA itself is what makes this test catch a divergence.
    const types = PASSPORT_SCHEMA.split(',').map((f) => f.trim().split(/\s+/)[0])
    const decoded = AbiCoder.defaultAbiCoder().decode(types, encodeClaim(claim))
    expect(decoded[0].toLowerCase()).toBe(EOA.toLowerCase()) // agentEoa
    expect(decoded[1].toLowerCase()).toBe(SMART.toLowerCase()) // smartAccount
    expect(decoded[2].toLowerCase()).toBe(TREASURY.toLowerCase()) // treasury
    expect(Number(decoded[3])).toBe(0) // assuranceLevel — L0
    expect(decoded[4]).toBe('haven:agent:abc') // policyUri
    expect(Number(decoded[5])).toBe(1_700_000_000) // issuedAt
    expect(Number(decoded[6])).toBe(0) // expiresAt
  })

  it('round-trips the zero-address sentinel for an EOA-only agent', () => {
    const zero = '0x0000000000000000000000000000000000000000'
    const types = PASSPORT_SCHEMA.split(',').map((f) => f.trim().split(/\s+/)[0])
    const decoded = AbiCoder.defaultAbiCoder().decode(
      types,
      encodeClaim({ ...claim, smartAccount: zero }),
    )
    expect(decoded[1]).toBe(zero)
  })

  it('the encoder covers exactly the number of fields the schema declares', () => {
    // Guards the failure mode where a field is added to PASSPORT_SCHEMA but not
    // to encodeClaim (or vice versa) — the encoding would silently shift.
    const fieldCount = PASSPORT_SCHEMA.split(',').length
    const types = PASSPORT_SCHEMA.split(',').map((f) => f.trim().split(/\s+/)[0])
    expect(() => AbiCoder.defaultAbiCoder().decode(types, encodeClaim(claim))).not.toThrow()
    expect(fieldCount).toBe(7)
  })
})
