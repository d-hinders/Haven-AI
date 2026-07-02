import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { addressFromKey, signHash, signUserOpHashForSession } from './signer.js'
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

describe('signUserOpHashForSession — EIP-191 (session-key rail)', () => {
  it('recovers via the EIP-191 personal-sign digest (what OwnableValidator checks)', async () => {
    const sig = await signUserOpHashForSession(PRIVATE_KEY, HASH)
    expect(ethers.verifyMessage(ethers.getBytes(HASH), sig).toLowerCase()).toBe(
      ADDRESS.toLowerCase(),
    )
  })

  it('is distinct from the raw-ECDSA signature — the two rails cannot be confused (#731)', async () => {
    const sessionSig = await signUserOpHashForSession(PRIVATE_KEY, HASH)
    const rawSig = signHash(PRIVATE_KEY, HASH)
    expect(sessionSig).not.toBe(rawSig)
    // Recovering the session signature as if it were raw ECDSA yields the wrong
    // address — exactly the SIG_VALIDATION_FAILED failure mode if the AllowanceModule
    // path is used for a session UserOp.
    expect(ethers.recoverAddress(HASH, sessionSig).toLowerCase()).not.toBe(ADDRESS.toLowerCase())
  })

  it('throws HavenSigningError on an invalid key', async () => {
    await expect(signUserOpHashForSession('not-a-key', HASH)).rejects.toBeInstanceOf(
      HavenSigningError,
    )
  })
})
