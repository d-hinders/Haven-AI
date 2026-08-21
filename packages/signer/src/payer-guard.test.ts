/**
 * #1690 — the payer-identity guard. The characterization suite proves v1/v2
 * behaviour survived; THIS file proves what v3 adds:
 *
 *   - a verified payer claim that is not this signer's delegate REFUSES, with
 *     a message that IS the diagnosis (both agent ids, both delegates, the
 *     stale-host remedy);
 *   - the claim lives inside the Haven-signed message, so stripping or
 *     tampering it breaks the binding — forging "this quote is yours" is not
 *     possible without Haven's key;
 *   - version skew is still checked FIRST, so a future-version context with a
 *     payer mismatch reports the version, never the symptom.
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { hashTypedData } from 'viem'
import { buildX402ExpectedMessage } from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const FUNDING_HASH = '0x' + 'cd'.repeat(32)
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address

/** The #1681 field shapes: the OLD agent's delegate, stamped into the quote. */
const OTHER_DELEGATE = '0xF278a857b981Ab00e2ad00cE0BdC595d05f1AB69'
const OTHER_AGENT = '4f67d16e'
const LOCAL_AGENT = '0a9fda23'

const BASE = {
  paymentId: 'pay_guard_1690',
  payloadHash: FUNDING_HASH,
  resourceUrl: 'https://merchant.test/paid',
  merchantTo: '0x000000000000000000000000000000000000dEaD',
  amount: '40000',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  network: 'base',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

const TYPED_DATA = {
  domain: { name: 'HavenGuard', version: '1', chainId: 8453 },
  types: { Payload: [{ name: 'hash', type: 'bytes32' }] },
  primaryType: 'Payload',
  message: { hash: FUNDING_HASH },
}

async function signedContext(overrides: Record<string, unknown> = {}, versionOverride?: number) {
  const context = { ...BASE, ...overrides }
  const message = buildX402ExpectedMessage(context as never)
  const account = privateKeyToAccount(BINDING_KEY)
  const derived = (context as { payerDelegate?: string }).payerDelegate
    ? 3
    : (context as { typedDataHash?: string }).typedDataHash
      ? 2
      : 1
  return {
    ...context,
    auth: {
      version: versionOverride ?? derived,
      message,
      signature: await account.signMessage({ message }),
      signer: account.address,
    },
  }
}

function localSigner() {
  return createEdgeSigner(TEST_KEY, {
    x402BindingSigner: BINDING_SIGNER,
    agentId: LOCAL_AGENT,
  })
}

describe('the payer-mismatch refusal (#1690)', () => {
  it("MUTATION PROOF: refuses another agent's quote, and the message IS the diagnosis", async () => {
    const signer = localSigner()
    const expected = await signedContext({
      payerDelegate: OTHER_DELEGATE,
      payerAgentId: OTHER_AGENT,
    })

    let thrown: Error | null = null
    try {
      signer.signX402FundingHash(FUNDING_HASH, expected as never)
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown).not.toBeNull()
    // Both identities, both delegates, the cause, the remedy — everything the
    // #1681 operator reconstructed by hand across three layers.
    expect(thrown!.message).toContain(OTHER_AGENT)
    expect(thrown!.message).toContain(OTHER_DELEGATE)
    expect(thrown!.message).toContain(LOCAL_AGENT)
    expect(thrown!.message).toContain(signer.delegateAddress)
    expect(thrown!.message).toMatch(/stale credentials/i)
    expect(thrown!.message).toMatch(/Nothing was signed/)
    expect(thrown!.message).toMatch(/[Rr]estart the host/)
  })

  it('refuses on the typed-data path too — the guard covers both modes', async () => {
    const signer = localSigner()
    const typedDataHash = hashTypedData(TYPED_DATA as never)
    const expected = await signedContext({
      typedDataHash,
      payerDelegate: OTHER_DELEGATE,
      payerAgentId: OTHER_AGENT,
    })

    await expect(
      signer.signX402FundingTypedData(TYPED_DATA as never, expected as never),
    ).rejects.toThrow(/DIFFERENT agent/)
  })

  it('a v3 context FOR this delegate signs, in hash mode (legacy-rail v3)', async () => {
    const signer = localSigner()
    const expected = await signedContext({ payerDelegate: signer.delegateAddress })

    const result = signer.signX402FundingHash(FUNDING_HASH, expected as never)
    expect(result.signature).toMatch(/^0x/)
  })

  it('the delegate comparison is case-blind — checksum casing cannot split identity', async () => {
    const signer = localSigner()
    const expected = await signedContext({
      payerDelegate: signer.delegateAddress.toUpperCase().replace('0X', '0x'),
    })

    expect(() => signer.signX402FundingHash(FUNDING_HASH, expected as never)).not.toThrow()
  })

  it('an unknown local agent id degrades the MESSAGE, never the guard', async () => {
    // The bare-delegateKey path has no credential file and no agent id. The
    // guard still refuses on addresses; the diagnosis just names less.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await signedContext({ payerDelegate: OTHER_DELEGATE })

    expect(() => signer.signX402FundingHash(FUNDING_HASH, expected as never)).toThrow(/unknown/)
  })
})

describe('the claim is inside the Haven-signed message — forgery breaks the binding', () => {
  it('MUTATION PROOF: STRIPPING payerDelegate from a signed v3 context fails the binding, not the guard', async () => {
    // A stale host that deleted the field to slip past the guard gets a
    // binding failure: the recomputed message no longer matches what Haven
    // signed. This is why the field must live INSIDE the signed message.
    const signer = localSigner()
    const expected = await signedContext({ payerDelegate: OTHER_DELEGATE })
    const stripped = { ...expected } as Record<string, unknown>
    delete stripped.payerDelegate

    expect(() => signer.signX402FundingHash(FUNDING_HASH, stripped as never)).toThrow(
      /authentication message is invalid/,
    )
  })

  it('TAMPERING the payer to match this signer fails the binding too', async () => {
    const signer = localSigner()
    const expected = await signedContext({ payerDelegate: OTHER_DELEGATE })
    const tampered = { ...expected, payerDelegate: signer.delegateAddress }

    expect(() => signer.signX402FundingHash(FUNDING_HASH, tampered as never)).toThrow(
      /authentication message is invalid/,
    )
  })

  it('a payer-carrying context stamped auth.version 2 is refused — the version is contents-derived', async () => {
    const signer = localSigner()
    const expected = await signedContext({ payerDelegate: signer.delegateAddress }, 2)

    expect(() => signer.signX402FundingHash(FUNDING_HASH, expected as never)).toThrow(
      /authentication message is invalid/,
    )
  })
})

describe('ordering: version skew is still diagnosed first', () => {
  it('a future-version context with a payer MISMATCH reports the version, not the mismatch', async () => {
    // The #1143 lesson: under an unknown version every content check is a
    // symptom, and reporting one as the cause sends the operator after the
    // wrong string. The payer guard must not jump that queue.
    const signer = localSigner()
    const expected = await signedContext({ payerDelegate: OTHER_DELEGATE }, 99)

    expect(() => signer.signX402FundingHash(FUNDING_HASH, expected as never)).toThrow(
      /out of date|versions up to/,
    )
  })
})
