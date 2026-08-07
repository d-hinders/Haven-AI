import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { buildSweepAuthorizationMessage, type SweepAuthorization } from '@haven_ai/sdk'
import {
  buildSweepAuthorization,
  recoverSweepSigner,
  signSweepExpectedContext,
  generateSweepNonce,
} from '../sweep.js'

// Hardhat accounts — never used for real funds.
const DELEGATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DELEGATE = privateKeyToAccount(DELEGATE_KEY)
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING = privateKeyToAccount(BINDING_KEY)
const SAFE = '0x000000000000000000000000000000000000dEaD'

describe('buildSweepAuthorization', () => {
  it('targets the Safe, pays the full balance, and expires ~5 min out', () => {
    const auth = buildSweepAuthorization({
      delegateAddress: DELEGATE.address,
      safeAddress: SAFE,
      chainId: 8453,
      valueAtomic: 40000n,
      nowSec: 1_000_000,
    })
    expect(auth.from).toBe(DELEGATE.address)
    expect(auth.to).toBe(SAFE)
    expect(auth.value).toBe('40000')
    expect(auth.validAfter).toBe('0')
    expect(auth.validBefore).toBe('1000300')
    expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('generates unique nonces', () => {
    expect(generateSweepNonce()).not.toBe(generateSweepNonce())
  })
})

describe('recoverSweepSigner', () => {
  it('recovers the delegate from a viem-signed authorization (signer ↔ backend)', async () => {
    const auth: SweepAuthorization = buildSweepAuthorization({
      delegateAddress: DELEGATE.address,
      safeAddress: SAFE,
      chainId: 8453,
      valueAtomic: 40000n,
    })
    // Sign the way the edge signer does (viem typed-data).
    const signature = await DELEGATE.signTypedData({
      domain: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract: auth.token as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
    })
    expect(recoverSweepSigner(auth, signature).toLowerCase()).toBe(DELEGATE.address.toLowerCase())
  })
})

describe('signSweepExpectedContext', () => {
  const prevKey = process.env.X402_BINDING_PRIVATE_KEY
  beforeAll(() => {
    process.env.X402_BINDING_PRIVATE_KEY = BINDING_KEY
  })
  afterAll(() => {
    if (prevKey === undefined) delete process.env.X402_BINDING_PRIVATE_KEY
    else process.env.X402_BINDING_PRIVATE_KEY = prevKey
  })

  it('binds the authorization with the dedicated key and the signer can re-derive it', async () => {
    const auth = buildSweepAuthorization({
      delegateAddress: DELEGATE.address,
      safeAddress: SAFE,
      chainId: 8453,
      valueAtomic: 40000n,
    })
    const expected = await signSweepExpectedContext(auth)
    expect(expected.signer.toLowerCase()).toBe(BINDING.address.toLowerCase())
    expect(expected.message).toBe(buildSweepAuthorizationMessage(auth))
  })
})
