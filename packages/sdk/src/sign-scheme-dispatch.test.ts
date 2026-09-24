/**
 * #776: the SDK client picks the signing scheme from sign_data.signature_scheme,
 * so a caller never has to know which rail an account is on. Tests the dispatch
 * in isolation against the two real signers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'
import { HavenClient } from './client.js'
import { signHash, signSettlementDelegationTypedData } from './signer.js'
import { HavenSigningError } from './types.js'
import { deriveDelegateAccountAddress } from './delegate-account.js'
import { HavenTypedDataRefusedError } from './direct-payment-guard.js'
import { CAVEAT_ENFORCERS, ROOT_AUTHORITY, type SettlementChildExpectation } from './settlement-child.js'
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
  expectation?: SettlementChildExpectation,
) {
  return (
    c as unknown as { signForData(d: unknown, e?: SettlementChildExpectation): Promise<string> }
  ).signForData(signData, expectation)
}

/**
 * #3283: the fixture child re-delegated FROM this test key's own account —
 * the only child `signForData` will now sign. The real fixture's delegator is
 * a stand-in (`0x1111…`), which the new delegator check correctly refuses.
 */
const OWN_ACCOUNT = deriveDelegateAccountAddress(DELEGATE.address as `0x${string}`)
function ownChild(): typeof SETTLEMENT_PAYLOAD {
  const td = JSON.parse(JSON.stringify(SETTLEMENT_PAYLOAD)) as typeof SETTLEMENT_PAYLOAD
  td.message.delegator = OWN_ACCOUNT
  return td
}

/** What the merchant's 402 asked for — the fixture's own values, not invented ones. */
const EXPECTATION: SettlementChildExpectation = {
  merchantTo: '0x3333333333333333333333333333333333333333',
  amount: '1000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  chainId: 84532,
  redeemers: ['0x4444444444444444444444444444444444444444'],
}

/** The fixture's expiry is a fixed timestamp (2026-08-27); freeze the clock inside its window. */
const FIXTURE_EXPIRY_SEC = 0x6a80709b
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime((FIXTURE_EXPIRY_SEC - 60) * 1000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('sign_data.signature_scheme dispatch (#776)', () => {
  // The legacy AllowanceModule rail — raw ECDSA over the bare hash when no
  // scheme was present — is retired (#2850, epic #1440). Every live sign_data
  // emitter sets `signature_scheme` and the backend spec makes it required, so
  // an absent scheme is now a malformed payload: it is REJECTED, never signed
  // on a guessed scheme.
  it('scheme ABSENT is rejected — the legacy bare-hash rail is retired (#2850), never a guessed signature', async () => {
    await expect(signFor(client(), { hash: HASH })).rejects.toThrow(/signature_scheme is required/)
    await expect(signFor(client(), { hash: HASH })).rejects.toBeInstanceOf(HavenSigningError)
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
    const child = ownChild()
    const sig = await signFor(
      client(),
      { hash: HASH, signature_scheme: 'eip712_delegation', typed_data: child },
      EXPECTATION,
    )

    // The signature must recover over the CHILD's domain/types/message — not
    // over `hash`. If the dispatch quietly fell through to signHash, this is
    // the assertion that catches it.
    const types = { ...(child.types as Record<string, unknown>) }
    delete types.EIP712Domain
    const recovered = ethers.verifyTypedData(child.domain as never, types as never, child.message as never, sig)
    expect(recovered.toLowerCase()).toBe(DELEGATE.address.toLowerCase())
    // …and it is exactly the settlement primitive's signature over that child.
    expect(sig).toBe(await signSettlementDelegationTypedData(DELEGATE_KEY, child as never))
  })

  it("'eip712_delegation' produces the exact expected signature (golden value)", async () => {
    // Review finding on #1452: recovering the signature over the SAME fixture
    // it was made from is self-referential — it proves the signer is internally
    // consistent, not that it signed the right thing. A hand-corrupted fixture
    // would still recover to the delegate.
    //
    // This is the independent anchor: the EIP-712 digest and signature for this
    // fixture under this test key, computed once with ethers and pinned here.
    // Any change to the fixture's domain, types, primaryType, message OR to how
    // the SDK signs moves both numbers.
    const EXPECTED_DIGEST =
      '0x6ff8c0bfa640d21f732187a70c4143029adaebb5065286d17d05316f94b3d458'
    const EXPECTED_SIGNATURE =
      '0x52da4962aead8b69e321fbf0fa9e566312d2a9ba327da94529030f0d00c9db4d' +
      '61933895500986fbcdffd0c04b355f4cbac15df202b9639e6d6d9257a25f49531c'

    const types = { ...(SETTLEMENT_PAYLOAD.types as Record<string, unknown>) }
    delete types.EIP712Domain
    expect(
      ethers.TypedDataEncoder.hash(
        SETTLEMENT_PAYLOAD.domain as never,
        types as never,
        SETTLEMENT_PAYLOAD.message as never,
      ),
    ).toBe(EXPECTED_DIGEST)

    // #3283: signForData now signs only a child delegated by this key's own
    // account, which the real fixture (delegator `0x1111…`) is not, so the
    // golden anchor pins the settlement primitive signForData dispatches to
    // (asserted equal to it in the test above) over the unchanged fixture.
    const sig = await signSettlementDelegationTypedData(DELEGATE_KEY, SETTLEMENT_PAYLOAD as never)
    expect(sig).toBe(EXPECTED_SIGNATURE)
  })

  it("'eip712_delegation' through signForData produces the exact expected signature over the own-account child (golden value, #3283)", async () => {
    // The end-to-end anchor for the dispatch path the test above reaches only
    // by equality with the primitive: digest and signature for ownChild()
    // under this key, computed once with ethers (independently of the SDK's
    // viem signer, which agreed) and pinned here.
    const EXPECTED_DIGEST = '0x0e3948f2f898994805ed052d9995be8cd36f434a8fe56214cee2596497c30025'
    const EXPECTED_SIGNATURE =
      '0xa73e91c21fe2895598a00cf14d7d20057282dc5bfeb62910162017c94849a8f4' +
      '6a0285ff545f668f2e63867fedecb730814ef452cb40c9031e922ee3f96089141c'
    const child = ownChild()
    const types = { ...(child.types as Record<string, unknown>) }
    delete types.EIP712Domain
    expect(ethers.TypedDataEncoder.hash(child.domain as never, types as never, child.message as never)).toBe(
      EXPECTED_DIGEST,
    )
    const sig = await signFor(
      client(),
      { hash: HASH, signature_scheme: 'eip712_delegation', typed_data: child },
      EXPECTATION,
    )
    expect(sig).toBe(EXPECTED_SIGNATURE)
  })

  it("'eip712_delegation' does NOT produce the bare-hash signature", async () => {
    // Belt and braces on the branch above: a fallthrough to the bare hash
    // would still return a valid-looking 65-byte signature, so assert it is
    // NOT the raw-ECDSA one (computed here with the live EIP-3009 signer)
    // rather than only that it recovers somewhere.
    const bare = signHash(DELEGATE_KEY, HASH)
    const delegated = await signFor(
      client(),
      { hash: HASH, signature_scheme: 'eip712_delegation', typed_data: ownChild() },
      EXPECTATION,
    )
    expect(delegated).not.toBe(bare)
  })

  // ── #3283 (epic #3284): the child is verified before it is signed ─────────

  it("'eip712_delegation' without an independent expectation is refused — nothing to verify it against", async () => {
    const attempt = () =>
      signFor(client(), { hash: HASH, signature_scheme: 'eip712_delegation', typed_data: ownChild() })
    await expect(attempt()).rejects.toBeInstanceOf(HavenTypedDataRefusedError)
    await expect(attempt()).rejects.toThrow(/without an independent expectation/)
  })

  it('refuses a ROOT-authority, caveat-free child delegated by the agent\'s own account (capture test)', async () => {
    // The capture the issue names: a root grant from the agent's account, no
    // caveats — whoever redeems it acts as that account. Today it signs.
    const td = ownChild()
    td.message.authority = ROOT_AUTHORITY
    td.message.caveats = []
    const attempt = () =>
      signFor(client(), { hash: HASH, signature_scheme: 'eip712_delegation', typed_data: td }, EXPECTATION)
    await expect(attempt()).rejects.toThrow(/ROOT delegation/)
    await expect(attempt()).rejects.toBeInstanceOf(HavenTypedDataRefusedError)
    await expect(attempt()).rejects.toMatchObject({ code: 'TYPED_DATA_NOT_ALLOWED' })
  })

  it('refuses a ROOT-authority child even when every caveat matches the 402', async () => {
    const td = ownChild()
    td.message.authority = ROOT_AUTHORITY
    await expect(
      signFor(client(), { hash: HASH, signature_scheme: 'eip712_delegation', typed_data: td }, EXPECTATION),
    ).rejects.toThrow(/ROOT delegation/)
  })

  it("refuses a child delegated by an account other than this key's own", async () => {
    // The unmodified fixture: delegator 0x1111…, not this key's derived account.
    await expect(
      signFor(
        client(),
        { hash: HASH, signature_scheme: 'eip712_delegation', typed_data: SETTLEMENT_PAYLOAD },
        EXPECTATION,
      ),
    ).rejects.toThrow(/delegated by an account other than this agent's own/)
  })

  it("refuses a child that pays someone other than the merchant's 402 payTo", async () => {
    await expect(
      signFor(
        client(),
        { hash: HASH, signature_scheme: 'eip712_delegation', typed_data: ownChild() },
        { ...EXPECTATION, merchantTo: '0x9999999999999999999999999999999999999999' },
      ),
    ).rejects.toThrow(/pays a different address/)
  })

  it('refuses a child redeemable by facilitators the merchant did not advertise', async () => {
    await expect(
      signFor(
        client(),
        { hash: HASH, signature_scheme: 'eip712_delegation', typed_data: ownChild() },
        { ...EXPECTATION, redeemers: ['0x5555555555555555555555555555555555555555'] },
      ),
    ).rejects.toThrow(/different facilitators/)
  })

  it('refuses a child with no facilitator pin when the merchant advertised facilitators', async () => {
    const td = ownChild()
    td.message.caveats = td.message.caveats.filter(
      (c) => c.enforcer.toLowerCase() !== CAVEAT_ENFORCERS.redeemer.toLowerCase(),
    )
    await expect(
      signFor(client(), { hash: HASH, signature_scheme: 'eip712_delegation', typed_data: td }, EXPECTATION),
    ).rejects.toThrow(/no facilitator pin/)
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
