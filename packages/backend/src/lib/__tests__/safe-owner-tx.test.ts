import { describe, expect, it } from 'vitest'
import {
  LastOwnerError,
  OwnerExistsError,
  OwnerNotFoundError,
  SENTINEL_OWNERS,
  assertCanRemoveOwner,
  buildAddOwnerTx,
  buildRemoveOwnerTx,
  findPrevOwner,
} from '../safe-owner-tx.js'

const SAFE = '0x1111111111111111111111111111111111111111'
const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const C = '0xcccccccccccccccccccccccccccccccccccccccc'

describe('assertCanRemoveOwner — last-owner guard', () => {
  it('rejects removing the only owner', () => {
    expect(() => assertCanRemoveOwner([A], A)).toThrow(LastOwnerError)
  })

  it('allows removing one of several owners', () => {
    expect(() => assertCanRemoveOwner([A, B], A)).not.toThrow()
  })

  it('rejects removing an address that is not an owner', () => {
    expect(() => assertCanRemoveOwner([A, B], C)).toThrow(OwnerNotFoundError)
  })

  it('matches owners case-insensitively', () => {
    expect(() => assertCanRemoveOwner([A, B], B.toLowerCase())).not.toThrow()
  })
})

describe('findPrevOwner — linked-list pointer', () => {
  it('returns the sentinel for the first owner', () => {
    expect(findPrevOwner([A, B, C], A)).toBe(SENTINEL_OWNERS)
  })

  it('returns the preceding owner for a middle owner', () => {
    expect(findPrevOwner([A, B, C], B)).toBe(A)
    expect(findPrevOwner([A, B, C], C)).toBe(B)
  })

  it('throws when the owner is absent', () => {
    expect(() => findPrevOwner([A, B], C)).toThrow(OwnerNotFoundError)
  })
})

describe('buildRemoveOwnerTx', () => {
  it('refuses to construct a removal of the last owner', () => {
    expect(() => buildRemoveOwnerTx(SAFE, [A], A)).toThrow(LastOwnerError)
  })

  it('builds a Safe self-call (to == safe, operation 0) for a valid removal', () => {
    const tx = buildRemoveOwnerTx(SAFE, [A, B], B)
    expect(tx.to.toLowerCase()).toBe(SAFE)
    expect(tx.operation).toBe(0)
    expect(tx.value).toBe('0')
    expect(tx.data.startsWith('0x')).toBe(true)
    // removeOwner selector
    expect(tx.data.slice(0, 10)).toBe('0xf8dc5dd9')
  })
})

describe('buildAddOwnerTx', () => {
  it('rejects an address that is already an owner', () => {
    expect(() => buildAddOwnerTx(SAFE, [A, B], A)).toThrow(OwnerExistsError)
  })

  it('builds a Safe self-call for a new owner', () => {
    const tx = buildAddOwnerTx(SAFE, [A], B)
    expect(tx.to.toLowerCase()).toBe(SAFE)
    expect(tx.operation).toBe(0)
    // addOwnerWithThreshold selector
    expect(tx.data.slice(0, 10)).toBe('0x0d582f13')
  })
})
