/**
 * #776: the SDK client picks the signing scheme from sign_data.signature_scheme,
 * so a caller never has to know which rail an account is on. Tests the dispatch
 * in isolation against the two real signers.
 */
import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { HavenClient } from './client.js'
import { HavenSigningError } from './types.js'

const DELEGATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const DELEGATE = new ethers.Wallet(DELEGATE_KEY)
const HASH = ethers.keccak256(ethers.toUtf8Bytes('sign-scheme-dispatch'))

function client() {
  return new HavenClient({ baseUrl: 'https://example.invalid', apiKey: 'sk_test', delegateKey: DELEGATE_KEY })
}

// signForData is private — exercise it via a thin cast (unit-level intent).
function signFor(c: HavenClient, signData: { hash: string; signature_scheme?: string }) {
  return (c as unknown as { signForData(d: unknown): Promise<string> }).signForData(signData)
}

describe('sign_data.signature_scheme dispatch (#776)', () => {
  it('legacy (scheme absent) -> raw ECDSA, recovers over the raw hash', async () => {
    const sig = await signFor(client(), { hash: HASH })
    expect(ethers.recoverAddress(HASH, sig).toLowerCase()).toBe(DELEGATE.address.toLowerCase())
  })

  it("'eip191_userop' -> EIP-191, recovers over the personal-sign digest", async () => {
    const sig = await signFor(client(), { hash: HASH, signature_scheme: 'eip191_userop' })
    expect(ethers.verifyMessage(ethers.getBytes(HASH), sig).toLowerCase()).toBe(
      DELEGATE.address.toLowerCase(),
    )
    // and is NOT a valid raw-ECDSA signature (the two rails stay distinct)
    expect(ethers.recoverAddress(HASH, sig).toLowerCase()).not.toBe(DELEGATE.address.toLowerCase())
  })

  it('the two schemes produce different signatures for the same hash', async () => {
    const c = client()
    const legacy = await signFor(c, { hash: HASH })
    const session = await signFor(c, { hash: HASH, signature_scheme: 'eip191_userop' })
    expect(legacy).not.toBe(session)
  })

  it('an unknown scheme throws — never a guessed signature', async () => {
    await expect(signFor(client(), { hash: HASH, signature_scheme: 'ed25519_future' })).rejects.toBeInstanceOf(
      HavenSigningError,
    )
  })
})
