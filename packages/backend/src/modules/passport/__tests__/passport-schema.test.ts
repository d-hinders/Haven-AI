import { describe, it, expect } from 'vitest'
import {
  PASSPORT_SCHEMA,
  PASSPORT_SCHEMA_REVOCABLE,
  PASSPORT_CHAIN_IDS,
  AssuranceLevel,
  ISSUABLE_ASSURANCE_LEVELS,
  getEasDeployment,
  getPassportSchemaUid,
  isPassportConfigured,
  NO_SMART_ACCOUNT,
  buildAddressBinding,
  encodeAddressBinding,
  decodeAddressBinding,
  bindingMatches,
} from '../index.js'

const EOA = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SMART = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const UID = '0x' + 'ab'.repeat(32)

describe('schema definition', () => {
  it('binds both agent addresses, EOA first', () => {
    // Field ORDER is part of the UID — a reorder silently orphans every
    // passport already attested. Pinned deliberately.
    expect(PASSPORT_SCHEMA).toBe(
      'address agentEoa,address smartAccount,address treasury,uint8 assuranceLevel,' +
        'string policyUri,uint64 issuedAt,uint64 expiresAt',
    )
  })

  it('is registered revocable — live revocation is the core L0 claim', () => {
    expect(PASSPORT_SCHEMA_REVOCABLE).toBe(true)
  })

  it('carries no PII field', () => {
    // L0 attests governance, not identity. Anything person-shaped stays
    // off-chain behind Haven's API (#971 acceptance).
    for (const banned of ['name', 'email', 'phone', 'address ', 'dob', 'country', 'kyc']) {
      expect(PASSPORT_SCHEMA.toLowerCase()).not.toContain(banned.toLowerCase() + ' ')
    }
    expect(PASSPORT_SCHEMA).not.toMatch(/email|phone|kyc|passport ?number|nationalId/i)
  })

  it('only L0 is issuable; L1 and L2 are defined but inactive', () => {
    expect(ISSUABLE_ASSURANCE_LEVELS.has(AssuranceLevel.L0)).toBe(true)
    expect(ISSUABLE_ASSURANCE_LEVELS.has(AssuranceLevel.L1)).toBe(false)
    expect(ISSUABLE_ASSURANCE_LEVELS.has(AssuranceLevel.L2)).toBe(false)
    // uint8 encoded, so later tiers slot in with no schema change.
    expect(AssuranceLevel.L0).toBe(0)
  })
})

describe('EAS deployment pinning', () => {
  it('serves Base Sepolia only — mainnet rides with the #908 gate', () => {
    expect([...PASSPORT_CHAIN_IDS]).toEqual([84532])
    expect(PASSPORT_CHAIN_IDS.has(8453)).toBe(false)
  })

  it('refuses an unpinned chain rather than defaulting', () => {
    expect(() => getEasDeployment(8453)).toThrow(/no pinned EAS deployment for chain 8453/)
    expect(() => getEasDeployment(100)).toThrow(/no pinned EAS deployment/)
  })

  it('exposes both EAS contracts for a pinned chain', () => {
    const d = getEasDeployment(84532)
    expect(d.schemaRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(d.eas).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(d.schemaRegistry).not.toBe(d.eas)
  })
})

describe('schema UID resolution — fail-closed', () => {
  it('throws when the schema has not been registered', () => {
    expect(() => getPassportSchemaUid(84532, {})).toThrow(/has not been registered/)
  })

  it('throws on a malformed UID rather than attesting against garbage', () => {
    expect(() => getPassportSchemaUid(84532, { AGENT_PASSPORT_SCHEMA_UID_84532: '0xdeadbeef' }))
      .toThrow(/not a 32-byte hex UID/)
  })

  it('rejects an unsupported chain before it reads config', () => {
    expect(() => getPassportSchemaUid(8453, { AGENT_PASSPORT_SCHEMA_UID_8453: UID }))
      .toThrow(/no pinned EAS deployment/)
  })

  it('returns the UID when properly configured', () => {
    expect(getPassportSchemaUid(84532, { AGENT_PASSPORT_SCHEMA_UID_84532: UID })).toBe(UID)
  })

  it('isPassportConfigured never throws', () => {
    expect(isPassportConfigured(84532, {})).toBe(false)
    expect(isPassportConfigured(8453, {})).toBe(false)
    expect(isPassportConfigured(84532, { AGENT_PASSPORT_SCHEMA_UID_84532: UID })).toBe(true)
  })
})

describe('address binding', () => {
  it('a legacy/import-only agent (EOA only) produces a valid passport', () => {
    // #971 acceptance: agents with nothing but a delegate address must work.
    const b = buildAddressBinding({ delegateAddress: EOA })
    expect(b.agentEoa).toBe(EOA)
    expect(b.smartAccount).toBeNull()
    expect(encodeAddressBinding(b).smartAccount).toBe(NO_SMART_ACCOUNT)
  })

  it('a delegation-rail agent binds both addresses', () => {
    const b = buildAddressBinding({ delegateAddress: EOA, smartAccountAddress: SMART })
    expect(b.smartAccount).toBe(SMART)
    expect(encodeAddressBinding(b)).toEqual({ agentEoa: EOA, smartAccount: SMART })
  })

  it('requires a well-formed EOA', () => {
    expect(() => buildAddressBinding({ delegateAddress: null })).toThrow(/required/)
    expect(() => buildAddressBinding({ delegateAddress: 'not-an-address' })).toThrow(/required/)
    expect(() => buildAddressBinding({ delegateAddress: NO_SMART_ACCOUNT }))
      .toThrow(/must not be the zero address/)
  })

  it('treats a zero smart account as ABSENT, never as a real value', () => {
    // Accepting it as real would make an EOA-only agent look delegation-rail.
    const b = buildAddressBinding({ delegateAddress: EOA, smartAccountAddress: NO_SMART_ACCOUNT })
    expect(b.smartAccount).toBeNull()
  })

  it('round-trips through encode/decode', () => {
    for (const smartAccountAddress of [SMART, null]) {
      const b = buildAddressBinding({ delegateAddress: EOA, smartAccountAddress })
      expect(decodeAddressBinding(encodeAddressBinding(b))).toEqual(b)
    }
  })
})

describe('bindingMatches — the verifier contract (#974)', () => {
  const dual = buildAddressBinding({ delegateAddress: EOA, smartAccountAddress: SMART })
  const eoaOnly = buildAddressBinding({ delegateAddress: EOA })

  it('EITHER bound address resolves to the same passport', () => {
    // #946 made settlement a per-payment choice: a merchant sees the EOA on the
    // 3009 leg and the smart account on erc7710. Both must verify.
    expect(bindingMatches(dual, EOA)).toBe(true)
    expect(bindingMatches(dual, SMART)).toBe(true)
  })

  it('is case-insensitive (merchants send lowercase and checksummed alike)', () => {
    expect(bindingMatches(dual, EOA.toLowerCase())).toBe(true)
    expect(bindingMatches(dual, SMART.toUpperCase().replace('0X', '0x'))).toBe(true)
  })

  it('NEVER resolves by the zero address', () => {
    // The sharp edge: address(0) is the encoding for "no smart account". If it
    // matched, every EOA-only agent would collide on it and a merchant querying
    // a junk address would be handed someone else's passport.
    expect(bindingMatches(eoaOnly, NO_SMART_ACCOUNT)).toBe(false)
    expect(bindingMatches(dual, NO_SMART_ACCOUNT)).toBe(false)
  })

  it('does not match an unrelated or malformed address, and never throws', () => {
    expect(bindingMatches(dual, '0x' + '9'.repeat(40))).toBe(false)
    for (const junk of [null, undefined, '', 'nope', 123, {}, '0x123']) {
      expect(bindingMatches(dual, junk)).toBe(false)
    }
  })

  it('an EOA-only passport does not match some other agent smart account', () => {
    expect(bindingMatches(eoaOnly, SMART)).toBe(false)
  })
})
