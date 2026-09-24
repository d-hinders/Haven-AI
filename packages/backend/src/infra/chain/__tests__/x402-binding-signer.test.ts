import { afterEach, describe, expect, it, vi } from 'vitest'
import { signX402ExpectedContext } from '../x402-binding-signer.js'
import type { X402ExpectedContext } from '@haven_ai/sdk'

/**
 * #3272 (owner decision): Haven's x402 expected-context v1 — a bare-hash
 * binding format inherited from the retired Safe rail, with no typed-data
 * commitment — is dropped. The signer accepts only versions [2, 3]. This
 * suite pins `signX402ExpectedContext` itself: it can no longer emit version
 * 1, whether or not a caller manages to reach it without `typedDataHash`
 * (a v1-shaped call cannot even type-check against the exported signature,
 * but the runtime refusal below covers a caller that bypasses that with a
 * type assertion, as a plain-JS caller could).
 *
 * The three backend call sites (`delegation-authorize.ts`'s EIP-3009
 * funding leg and erc7710 settlement leg, and `replay.ts`'s idempotent-
 * replay/sign-context rebuild) are pinned separately, against the real
 * builders, in `routes/__tests__/x402-delegation.test.ts`
 * (`x402_expected_auth.version`/`x402_expected.auth.version` assertions).
 */
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'

const BASE_CONTEXT: X402ExpectedContext = {
  paymentId: 'pay-1',
  payloadHash: `0x${'11'.repeat(32)}`,
  resourceUrl: 'https://merchant.example/resource',
  merchantTo: `0x${'22'.repeat(20)}`,
  amount: '100000',
  asset: `0x${'33'.repeat(20)}`,
  network: 'eip155:84532',
}

describe('signX402ExpectedContext (#3272 — v1 retired, only [2, 3] emitted)', () => {
  afterEach(() => {
    delete process.env.X402_BINDING_PRIVATE_KEY
  })

  it('emits version 2 when typedDataHash is present and no payer identity is carried', async () => {
    process.env.X402_BINDING_PRIVATE_KEY = PRIVATE_KEY
    const result = await signX402ExpectedContext({
      ...BASE_CONTEXT,
      typedDataHash: `0x${'44'.repeat(32)}`,
    })
    expect(result.version).toBe(2)
    expect(result.signature).toMatch(/^0x/)
    expect(result.signer).toMatch(/^0x/)
    expect(result.message).toContain('"typedDataHash"')
  })

  it('emits version 3 when typedDataHash AND the payer identity are both present', async () => {
    process.env.X402_BINDING_PRIVATE_KEY = PRIVATE_KEY
    const result = await signX402ExpectedContext({
      ...BASE_CONTEXT,
      typedDataHash: `0x${'44'.repeat(32)}`,
      payerDelegate: `0x${'55'.repeat(20)}`,
      payerAgentId: 'agent-1',
    })
    expect(result.version).toBe(3)
  })

  it('never emits version 1: a context reaching in without typedDataHash is REFUSED, not silently downgraded', async () => {
    process.env.X402_BINDING_PRIVATE_KEY = PRIVATE_KEY
    // The exported type requires `typedDataHash`, so a v1-shaped call cannot
    // type-check — this cast simulates a caller that bypasses that (a plain
    // JS caller, or `as` at a call site), which is exactly the case the
    // runtime refusal below exists to cover.
    const v1Shaped = { ...BASE_CONTEXT } as unknown as Parameters<typeof signX402ExpectedContext>[0]
    await expect(signX402ExpectedContext(v1Shaped)).rejects.toThrow(
      /requires typedDataHash.*retired/is,
    )
  })

  it('refuses an empty-string typedDataHash the same way (falsy, not merely absent)', async () => {
    process.env.X402_BINDING_PRIVATE_KEY = PRIVATE_KEY
    const emptyHash = { ...BASE_CONTEXT, typedDataHash: '' } as unknown as Parameters<
      typeof signX402ExpectedContext
    >[0]
    await expect(signX402ExpectedContext(emptyHash)).rejects.toThrow(/requires typedDataHash/)
  })

  it('still refuses to load without X402_BINDING_PRIVATE_KEY, even with a valid v2 context', async () => {
    delete process.env.X402_BINDING_PRIVATE_KEY
    await expect(
      signX402ExpectedContext({ ...BASE_CONTEXT, typedDataHash: `0x${'44'.repeat(32)}` }),
    ).rejects.toThrow(/X402_BINDING_PRIVATE_KEY/)
  })
})
