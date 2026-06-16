import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem'
import {
  buildSweepAuthorizationMessage,
  buildSweepTypedData,
  SWEEP_BASE_CHAIN_ID,
  SWEEP_BASE_USDC_ADDRESS,
  type SweepAuthorization,
  type SweepExpectedAuth,
} from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'

/** Recover the EIP-712 signer of a sweep authorization (viem). */
async function recoverSweepAddress(auth: SweepAuthorization, signature: string): Promise<string> {
  const td = buildSweepTypedData(auth)
  return recoverTypedDataAddress({
    domain: { ...td.domain, verifyingContract: td.domain.verifyingContract as `0x${string}` },
    types: td.types,
    primaryType: td.primaryType,
    message: {
      ...td.message,
      from: td.message.from as `0x${string}`,
      to: td.message.to as `0x${string}`,
      nonce: td.message.nonce as `0x${string}`,
    },
    signature: signature as `0x${string}`,
  })
}

// Hardhat accounts #0 and #1 — never used for real funds.
const DELEGATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DELEGATE = privateKeyToAccount(DELEGATE_KEY).address
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_ACCOUNT = privateKeyToAccount(BINDING_KEY)
const BINDING_SIGNER = BINDING_ACCOUNT.address
const SAFE = '0x000000000000000000000000000000000000dEaD'

function baseAuthorization(overrides: Partial<SweepAuthorization> = {}): SweepAuthorization {
  return {
    from: DELEGATE,
    to: SAFE,
    value: '40000',
    validAfter: '0',
    validBefore: '2000000000',
    nonce: '0x' + 'ab'.repeat(32),
    token: SWEEP_BASE_USDC_ADDRESS,
    chainId: SWEEP_BASE_CHAIN_ID,
    ...overrides,
  }
}

/** Build a valid Haven binding the way the backend does (EIP-191 signMessage). */
async function bindingFor(auth: SweepAuthorization): Promise<SweepExpectedAuth> {
  const message = buildSweepAuthorizationMessage(auth)
  return {
    version: 1,
    message,
    signature: await BINDING_ACCOUNT.signMessage({ message }),
    signer: BINDING_SIGNER,
  }
}

describe('signSweepAuthorization', () => {
  it('signs a Haven-bound authorization and returns a delegate-recoverable signature', async () => {
    const signer = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const auth = baseAuthorization()
    const { signature } = await signer.signSweepAuthorization({
      authorization: auth,
      expectedAuth: await bindingFor(auth),
      expectedSafe: SAFE,
    })
    const recovered = await recoverSweepAddress(auth, signature)
    expect(recovered.toLowerCase()).toBe(DELEGATE.toLowerCase())
  })

  it('rejects a binding signed by an untrusted key', async () => {
    const signer = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const auth = baseAuthorization()
    const rogue = privateKeyToAccount(
      '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    )
    const message = buildSweepAuthorizationMessage(auth)
    await expect(
      signer.signSweepAuthorization({
        authorization: auth,
        expectedAuth: {
          version: 1,
          message,
          signature: await rogue.signMessage({ message }),
          signer: rogue.address,
        },
      }),
    ).rejects.toThrow(/not signed by the configured Haven signer/)
  })

  it('rejects when `from` is not the delegate address', async () => {
    const signer = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const auth = baseAuthorization({ from: '0x000000000000000000000000000000000000bEEF' })
    await expect(
      signer.signSweepAuthorization({ authorization: auth, expectedAuth: await bindingFor(auth) }),
    ).rejects.toThrow(/`from` does not match this delegate/)
  })

  it('rejects when `to` does not match the credential Safe', async () => {
    const signer = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const auth = baseAuthorization({ to: '0x000000000000000000000000000000000000bEEF' })
    await expect(
      signer.signSweepAuthorization({
        authorization: auth,
        expectedAuth: await bindingFor(auth),
        expectedSafe: SAFE,
      }),
    ).rejects.toThrow(/`to` does not match the Safe/)
  })

  it('rejects a binding whose message does not match the authorization', async () => {
    const signer = createEdgeSigner(DELEGATE_KEY, { x402BindingSigner: BINDING_SIGNER })
    const auth = baseAuthorization()
    // Bind a different value than the authorization being signed.
    const binding = await bindingFor(baseAuthorization({ value: '99999' }))
    await expect(
      signer.signSweepAuthorization({ authorization: auth, expectedAuth: binding }),
    ).rejects.toThrow(/does not match the authorization/)
  })

  it('rejects when no binding verifier is configured', async () => {
    const signer = createEdgeSigner(DELEGATE_KEY)
    const auth = baseAuthorization()
    await expect(
      signer.signSweepAuthorization({ authorization: auth, expectedAuth: await bindingFor(auth) }),
    ).rejects.toThrow(/verifier is not configured/)
  })
})
