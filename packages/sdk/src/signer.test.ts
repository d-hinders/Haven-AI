import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { addressFromKey, signHash } from './signer.js'
import { HavenSigningError } from './types.js'

// Throwaway well-known test key (Hardhat account #1). Never a real key.
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const ADDRESS = addressFromKey(PRIVATE_KEY)
const HASH = ethers.keccak256(ethers.toUtf8Bytes('haven-session-userop'))

describe('signHash — raw ECDSA (AllowanceModule rail)', () => {
  it('recovers via raw ecrecover over the hash', () => {
    const sig = signHash(PRIVATE_KEY, HASH)
    expect(ethers.recoverAddress(HASH, sig).toLowerCase()).toBe(ADDRESS.toLowerCase())
  })

  it('is NOT valid under the EIP-191 personal-sign digest', () => {
    const sig = signHash(PRIVATE_KEY, HASH)
    expect(ethers.verifyMessage(ethers.getBytes(HASH), sig).toLowerCase()).not.toBe(
      ADDRESS.toLowerCase(),
    )
  })
})

// signUserOpHashForSession (EIP-191, session rail) was REMOVED in #881 — the
// session rail is retired (#834) and the backend refuses its intents with 410.
// The client-side dispatch regression lives in client.test.ts.
