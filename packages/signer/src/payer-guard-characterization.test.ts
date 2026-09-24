/**
 * CHARACTERIZATION, captured before #1690 changes anything (money-path rule,
 * CLAUDE.md): exactly how a v1 and a v2 expected context sign TODAY, on a
 * signer that knows nothing about payer identity.
 *
 * #1690 adds a payer-identity field (expected-context v3) and a signing-time
 * refusal when the quote's payer is not this signer's delegate. Every test in
 * this file must stay green through that change — a v1/v2 context carries no
 * payer claim, and refusing or perturbing it would force-upgrade every
 * backend and break every deployed signer contract at once. The exact v1/v2
 * message bytes are separately locked in
 * `packages/sdk/src/x402-expected-message.test.ts`; what is locked HERE is
 * the SIGNING behaviour those bytes produce.
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { hashTypedData } from 'viem'
import { buildX402ExpectedMessage } from '@haven_ai/sdk'
import { createEdgeSigner, SUPPORTED_X402_EXPECTED_VERSIONS } from './core.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const FUNDING_HASH = '0x' + 'cd'.repeat(32)

const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address

const BASE = {
  paymentId: 'pay_char_1690',
  payloadHash: FUNDING_HASH,
  resourceUrl: 'https://merchant.test/paid',
  merchantTo: '0x000000000000000000000000000000000000dEaD',
  amount: '40000',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  network: 'base',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

const TYPED_DATA = {
  domain: { name: 'HavenChar', version: '1', chainId: 8453 },
  types: { Payload: [{ name: 'hash', type: 'bytes32' }] },
  primaryType: 'Payload',
  message: { hash: FUNDING_HASH },
}

async function signedContext(overrides: Record<string, unknown> = {}) {
  const context = { ...BASE, ...overrides }
  const message = buildX402ExpectedMessage(context as never)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...context,
    auth: {
      version: ((context as { typedDataHash?: string }).typedDataHash ? 2 : 1) as 1 | 2,
      message,
      signature: await account.signMessage({ message }),
      signer: account.address,
    },
  }
}

describe('pre-#1690 characterization: payer-less contexts sign', () => {
  // #3272 (criterion 8, owner decision 2026-09-24): v1 (hash-mode) is retired
  // outright — an unrelated, later, deliberate change from the #1690 payer
  // guard this file characterizes. The v1 test that used to live here is now
  // exactly the criterion-8 refusal test (`version-skew.test.ts` and
  // `core.test.ts` pin it); what remains true of THIS file's property is that
  // a payer-LESS (v2) context still signs, with or without local agent
  // identity configured.
  it('a v2 (typed-data-mode) context with NO payer identity signs successfully', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const typedDataHash = hashTypedData(TYPED_DATA as never)
    const expected = await signedContext({ typedDataHash })

    const result = await signer.signX402FundingTypedData(TYPED_DATA as never, expected as never)

    expect(result.signature).toMatch(/^0x/)
  })

  it('the same v2 context signs on a signer that HAS a local agent identity configured', async () => {
    // After #1690 the signer may know its own agent id. Knowing who it is must
    // never make it refuse a context that claims nothing — v2 carries no
    // payer, so there is nothing to mismatch.
    const signer = createEdgeSigner(TEST_KEY, {
      x402BindingSigner: BINDING_SIGNER,
      // Unknown option today — createEdgeSigner must tolerate it (it does:
      // options is a bag), and honour it after #1690.
      ...( { agentId: 'agent-local' } as object),
    })
    const typedDataHash = hashTypedData(TYPED_DATA as never)
    const expected = await signedContext({ typedDataHash })

    const result = await signer.signX402FundingTypedData(TYPED_DATA as never, expected as never)
    expect(result.signature).toMatch(/^0x/)
  })

  it('claims [2, 3] — v1 retired by #3272 (unrelated to the #1690 v3 widening this file characterizes)', () => {
    // Written as [1, 2] in the characterization commit, widened to [1, 2, 3]
    // by #1690, and narrowed to [2, 3] by #3272 (criterion 8) — each a
    // visible, deliberate edit in its own diff rather than a side effect
    // nobody reviewed.
    expect([...SUPPORTED_X402_EXPECTED_VERSIONS]).toEqual([2, 3])
  })
})
