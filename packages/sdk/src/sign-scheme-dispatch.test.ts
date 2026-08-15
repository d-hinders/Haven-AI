/**
 * #776: the SDK client picks the signing scheme from sign_data.signature_scheme,
 * so a caller never has to know which rail an account is on. Tests the dispatch
 * in isolation against the two real signers.
 */
import { describe, expect, it } from 'vitest'
import { ethers } from 'ethers'
import { HavenClient } from './client.js'
import { HavenSigningError } from './types.js'
// #1452: a REAL buildSettlementDelegation payload, not a hand-written object.
// Generated from packages/backend/src/modules/x402/x402-delegation.ts — see the
// fixture's own README note. A hand-written fixture that drifted from the
// backend's domain would let a broken signer look correct here and fail
// on-chain at redemption, which is exactly what this test exists to prevent;
// backend-side, settlement-payload-fixture.test.ts fails if the shape moves.
import SETTLEMENT_PAYLOAD from './__fixtures__/settlement-delegation-payload.json' with { type: 'json' }

const DELEGATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const DELEGATE = new ethers.Wallet(DELEGATE_KEY)
const HASH = ethers.keccak256(ethers.toUtf8Bytes('sign-scheme-dispatch'))

function client() {
  return new HavenClient({ baseUrl: 'https://example.invalid', apiKey: 'sk_test', delegateKey: DELEGATE_KEY })
}

// signForData is private — exercise it via a thin cast (unit-level intent).
function signFor(
  c: HavenClient,
  signData: { hash: string; signature_scheme?: string; typed_data?: unknown },
) {
  return (c as unknown as { signForData(d: unknown): Promise<string> }).signForData(signData)
}

describe('sign_data.signature_scheme dispatch (#776)', () => {
  it('legacy (scheme absent) -> raw ECDSA, recovers over the raw hash', async () => {
    const sig = await signFor(client(), { hash: HASH })
    expect(ethers.recoverAddress(HASH, sig).toLowerCase()).toBe(DELEGATE.address.toLowerCase())
  })

  it("'eip191_userop' throws — the session rail is retired (#881), never a guessed signature", async () => {
    await expect(
      signFor(client(), { hash: HASH, signature_scheme: 'eip191_userop' }),
    ).rejects.toThrow(/session rail is retired/)
  })

  it('an unknown scheme throws — never a guessed signature', async () => {
    await expect(signFor(client(), { hash: HASH, signature_scheme: 'ed25519_future' })).rejects.toBeInstanceOf(
      HavenSigningError,
    )
  })

  it("'eip712_delegation' signs the settlement child, recovering to the delegate", async () => {
    const sig = await signFor(client(), {
      hash: HASH,
      signature_scheme: 'eip712_delegation',
      typed_data: SETTLEMENT_PAYLOAD,
    })

    // The signature must recover over the FIXTURE's domain/types/message — not
    // over `hash`. If the dispatch quietly fell through to signHash, this is
    // the assertion that catches it.
    const types = { ...(SETTLEMENT_PAYLOAD.types as Record<string, unknown>) }
    delete types.EIP712Domain
    const recovered = ethers.verifyTypedData(
      SETTLEMENT_PAYLOAD.domain as never,
      types as never,
      SETTLEMENT_PAYLOAD.message as never,
      sig,
    )
    expect(recovered.toLowerCase()).toBe(DELEGATE.address.toLowerCase())
  })

  it("'eip712_delegation' does NOT produce the bare-hash signature", async () => {
    // Belt and braces on the branch above: a fallthrough to signHash would
    // still return a valid-looking 65-byte signature, so assert it is NOT the
    // legacy one rather than only that it recovers somewhere.
    const legacy = await signFor(client(), { hash: HASH })
    const delegated = await signFor(client(), {
      hash: HASH,
      signature_scheme: 'eip712_delegation',
      typed_data: SETTLEMENT_PAYLOAD,
    })
    expect(delegated).not.toBe(legacy)
  })

  it("'eip712_delegation' without typed_data throws — never signs the bare hash", async () => {
    // The #829 lesson: a settlement signed over the wrong payload is rejected
    // at redemption, AFTER the agent has told the merchant it paid. Refuse here.
    await expect(
      signFor(client(), { hash: HASH, signature_scheme: 'eip712_delegation' }),
    ).rejects.toThrow(/typed_data is missing/)
    await expect(
      signFor(client(), { hash: HASH, signature_scheme: 'eip712_delegation' }),
    ).rejects.toBeInstanceOf(HavenSigningError)
  })

  it("'eip712_userop' without typed_data still throws — unchanged by #1452", async () => {
    await expect(
      signFor(client(), { hash: HASH, signature_scheme: 'eip712_userop' }),
    ).rejects.toThrow(/typed_data is missing/)
  })
})
