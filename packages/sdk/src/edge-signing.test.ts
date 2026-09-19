import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { addressFromKey as ethersAddressFromKey, signHash as ethersSignHash, verifySignature as ethersVerifySignature } from './signer.js'
import { addressFromKey, signHash, verifySignature } from './edge-signing.js'
import { HavenSigningError } from './types.js'

// Throwaway well-known keys (Hardhat accounts). Never real keys.
const KEYS = [
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
]
const HASHES = [
  ethers.keccak256(ethers.toUtf8Bytes('haven-session-userop')),
  ethers.keccak256(ethers.toUtf8Bytes('x402 funding leg')),
  `0x${'00'.repeat(31)}01`,
  `0x${'ff'.repeat(32)}`,
]

describe('edge-signing (#3173) is byte-equivalent to the ethers implementation', () => {
  it('addressFromKey agrees for every key, including checksum casing', () => {
    for (const key of KEYS) expect(addressFromKey(key)).toBe(ethersAddressFromKey(key))
  })

  it('signHash produces the identical 65-byte r‖s‖v serialisation (low-s, v = 27/28) — deterministic RFC 6979', () => {
    for (const key of KEYS) {
      for (const hash of HASHES) {
        const ours = signHash(key, hash)
        expect(ours).toBe(ethersSignHash(key, hash))
        expect(ours).toMatch(/^0x[0-9a-f]{130}$/)
        expect(['1b', '1c']).toContain(ours.slice(-2))
      }
    }
  })

  it('verifySignature agrees with ethers on genuine, wrong-address, wrong-hash and garbage inputs', () => {
    const sig = signHash(KEYS[0], HASHES[0])
    const address = addressFromKey(KEYS[0])
    expect(verifySignature(HASHES[0], sig, address)).toBe(true)
    expect(verifySignature(HASHES[0], sig, address.toLowerCase())).toBe(true)
    expect(verifySignature(HASHES[0], sig, addressFromKey(KEYS[1]))).toBe(false)
    expect(verifySignature(HASHES[1], sig, address)).toBe(false)
    expect(verifySignature(HASHES[0], '0xnope', address)).toBe(false)
    expect(verifySignature(HASHES[0], `0x${'00'.repeat(65)}`, address)).toBe(false)
    // v = 0/1 (yParity form) is accepted like ethers accepts it
    const yParityForm = `${sig.slice(0, 130)}${sig.slice(-2) === '1b' ? '00' : '01'}`
    expect(verifySignature(HASHES[0], yParityForm, address)).toBe(ethersVerifySignature(HASHES[0], yParityForm, address))
    // and both implementations verify each other's signatures
    expect(ethersVerifySignature(HASHES[0], sig, address)).toBe(true)
    expect(verifySignature(HASHES[0], ethersSignHash(KEYS[0], HASHES[0]), address)).toBe(true)
  })

  it('signs the RAW hash — not valid under the EIP-191 personal-sign digest', () => {
    const sig = signHash(KEYS[0], HASHES[0])
    expect(ethers.verifyMessage(ethers.getBytes(HASHES[0]), sig).toLowerCase()).not.toBe(addressFromKey(KEYS[0]).toLowerCase())
  })

  it('refuses a malformed key with HavenSigningError, like ethers', () => {
    expect(() => addressFromKey('0x1234')).toThrow(HavenSigningError)
    expect(() => signHash('not-a-key', HASHES[0])).toThrow(HavenSigningError)
  })
})
