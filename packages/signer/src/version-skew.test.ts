import { describe, it, expect } from 'vitest'
import { hashTypedData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { buildX402ExpectedMessage, buildSweepAuthorizationMessage } from '@haven_ai/sdk'
import {
  assertSupportedBindingVersion,
  createEdgeSigner,
  SUPPORTED_SWEEP_BINDING_VERSIONS,
  SUPPORTED_X402_EXPECTED_VERSIONS,
} from './core.js'
import { createToolHandlers } from './tools.js'

/**
 * #1143 — a signer one release behind the backend must say so.
 *
 * The reported failure was not a signing bug: nothing was ever going to be
 * signed. It was a *diagnosis* bug. The tool schema pinned `auth.version` to a
 * literal, so the MCP server rejected the call before any Haven code ran, and
 * the agent received `Invalid literal value, expected 1 at
 * x402_expected.auth.version` — a string that names neither the cause nor the
 * fix, and which nothing in Haven wrote.
 *
 * These tests hold two properties together, and the second is the one that keeps
 * the first honest:
 *
 *  1. an unknown version produces a named, actionable Haven error;
 *  2. an unknown version is still never signed.
 */

// Well-known test keys (Hardhat accounts). Never used for real funds.
const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
const BINDING_SIGNER = privateKeyToAccount(BINDING_KEY).address
const FUNDING_HASH = '0x' + 'cd'.repeat(32)

/** One past this signer's ceiling — the skew a future context bump will create. */
const UNKNOWN_X402_VERSION = Math.max(...SUPPORTED_X402_EXPECTED_VERSIONS) + 1
const UNKNOWN_SWEEP_VERSION = Math.max(...SUPPORTED_SWEEP_BINDING_VERSIONS) + 1

const PAYMENT_REQUIRED = {
  x402Version: 1,
  resource: { url: 'https://merchant.test/paid', description: 'paid data' },
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      amount: '1000000',
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // Base USDC
      payTo: '0x000000000000000000000000000000000000dEaD',
      maxTimeoutSeconds: 60,
    },
  ],
}

const EXPECTED_BASE = {
  paymentId: 'pay_x402',
  payloadHash: FUNDING_HASH,
  resourceUrl: PAYMENT_REQUIRED.resource.url,
  merchantTo: PAYMENT_REQUIRED.accepts[0].payTo,
  amount: PAYMENT_REQUIRED.accepts[0].amount,
  asset: PAYMENT_REQUIRED.accepts[0].asset,
  network: PAYMENT_REQUIRED.accepts[0].network,
  expiresAt: '2099-01-01T00:00:00.000Z',
}

/**
 * A context whose binding message and signature are entirely VALID — only the
 * announced version is unknown. That isolates the property under test: this is
 * genuine Haven output from a newer backend, not a forgery.
 */
async function expectedWithVersion(
  version: number,
  overrides: Partial<typeof EXPECTED_BASE> & { typedDataHash?: string } = {},
) {
  const context = { ...EXPECTED_BASE, ...overrides }
  const message = buildX402ExpectedMessage(context)
  const account = privateKeyToAccount(BINDING_KEY)
  return {
    ...context,
    auth: {
      version,
      message,
      signature: await account.signMessage({ message }),
      signer: account.address,
    },
  }
}

describe('assertSupportedBindingVersion (#1143)', () => {
  it('reproduces the reported case: a v2 context against a signer supporting only {1}', () => {
    // The literal incident of 2026-08-06. This signer now knows v2, so the live
    // path can no longer produce it — pinning the supported set is the only way
    // to keep the reported case itself under test.
    let error: Error | undefined
    try {
      assertSupportedBindingVersion(2, [1], 'x402 expected context')
    } catch (err) {
      error = err as Error
    }
    expect(error).toBeDefined()
    const message = error!.message
    // The three things the old Zod string failed to say.
    expect(message).toContain('version 2') // what arrived
    expect(message).toContain('up to 1') // what this signer supports
    expect(message).toContain('@haven_ai/signer') // the fix
    expect(message).not.toMatch(/Invalid literal value/)
  })

  it('tells an agent not to "fix" the version by rewriting it', () => {
    // The reported agent got this right unaided and asked a human instead. The
    // error should not depend on that judgement: the version is inside the
    // Haven-signed message, so editing it invalidates the signature.
    expect(() => assertSupportedBindingVersion(2, [1], 'x402 expected context')).toThrow(
      /invalidates\s+the signature/,
    )
  })

  it('accepts every version in the supported set', () => {
    for (const version of SUPPORTED_X402_EXPECTED_VERSIONS) {
      expect(() =>
        assertSupportedBindingVersion(version, SUPPORTED_X402_EXPECTED_VERSIONS, 'x402 expected context'),
      ).not.toThrow()
    }
  })

  it('names a version below the supported floor without claiming an update fixes it', () => {
    // A retired version is the opposite skew — updating the signer cannot help,
    // so the message must not tell the operator to update.
    let error: Error | undefined
    try {
      assertSupportedBindingVersion(1, [2, 3], 'x402 expected context')
    } catch (err) {
      error = err as Error
    }
    expect(error?.message).toContain('Unsupported x402 expected context version 1')
    expect(error?.message).toContain('2, 3')
    expect(error?.message).not.toMatch(/out of date/)
  })
})

describe('x402 funding under an unknown expected-context version (#1143)', () => {
  it('refuses the bare-hash path with the actionable error, and signs nothing', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedWithVersion(UNKNOWN_X402_VERSION)
    expect(() => signer.signX402FundingHash(FUNDING_HASH, expected)).toThrow(
      new RegExp(`supports x402 expected context versions up to ${Math.max(
        ...SUPPORTED_X402_EXPECTED_VERSIONS,
      )}, and Haven sent version ${UNKNOWN_X402_VERSION}`),
    )
  })

  it('reports the version, not a downstream symptom', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedWithVersion(UNKNOWN_X402_VERSION)
    // Regression guard on ORDERING: the old code would have reached the
    // recomputed-message comparison and blamed the binding, which is the exact
    // mis-diagnosis the stale docs table recorded.
    expect(() => signer.signX402FundingHash(FUNDING_HASH, expected)).not.toThrow(
      /authentication message is invalid/,
    )
  })

  it('refuses the typed-data path too', async () => {
    const typedData = {
      domain: { chainId: 84532, name: 'HybridDeleGator', version: '1' },
      types: { Payload: [{ name: 'sender', type: 'address' }] },
      primaryType: 'Payload',
      message: { sender: '0x98ffBf30459a98FD80fAce18f519967769641F76' },
    }
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const expected = await expectedWithVersion(UNKNOWN_X402_VERSION, {
      typedDataHash: hashTypedData(typedData as Parameters<typeof hashTypedData>[0]),
    })
    await expect(
      signer.signX402FundingTypedData(typedData as never, expected),
    ).rejects.toThrow(/out of date/)
  })
})

describe('sweep binding under an unknown version (#1143)', () => {
  const AUTHORIZATION = {
    from: '0x000000000000000000000000000000000000bEEF',
    to: '0x000000000000000000000000000000000000cAfe',
    value: '1000000',
    validAfter: '0',
    validBefore: '99999999999',
    nonce: '0x' + '11'.repeat(32),
    token: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    chainId: 8453,
  }

  it('refuses an unknown sweep binding version with the actionable error', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const message = buildSweepAuthorizationMessage(AUTHORIZATION)
    const account = privateKeyToAccount(BINDING_KEY)
    await expect(
      signer.signSweepAuthorization({
        authorization: AUTHORIZATION,
        expectedAuth: {
          version: UNKNOWN_SWEEP_VERSION,
          message,
          signature: await account.signMessage({ message }),
          signer: account.address,
        },
      }),
    ).rejects.toThrow(
      new RegExp(`sweep authorization binding versions up to ${Math.max(
        ...SUPPORTED_SWEEP_BINDING_VERSIONS,
      )}, and Haven sent version ${UNKNOWN_SWEEP_VERSION}`),
    )
  })

  it('does not blame the authorization when only the version is unknown', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const message = buildSweepAuthorizationMessage(AUTHORIZATION)
    const account = privateKeyToAccount(BINDING_KEY)
    const failure = await signer
      .signSweepAuthorization({
        authorization: AUTHORIZATION,
        expectedAuth: {
          version: UNKNOWN_SWEEP_VERSION,
          message,
          signature: await account.signMessage({ message }),
          signer: account.address,
        },
      })
      .catch((err: Error) => err)
    expect((failure as Error).message).not.toMatch(/does not match the authorization/)
  })
})

/**
 * The boundary that actually produced the reported string. The schema is
 * validated by the MCP server before the handler runs, so a literal `version`
 * there meant no Haven error could ever be reached — widening the schema is what
 * makes the tests above observable to an agent.
 */
describe('tool boundary surfaces the skew instead of a Zod string (#1143)', () => {
  it('returns a SIGNING_ERROR naming the fix, not INVALID_INPUT', async () => {
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const handlers = createToolHandlers(signer)
    const expected = await expectedWithVersion(UNKNOWN_X402_VERSION)
    const result = await handlers.haven_sign_x402({
      payload_hash: FUNDING_HASH,
      payment_required: PAYMENT_REQUIRED,
      x402_expected: {
        payment_id: expected.paymentId,
        payload_hash: expected.payloadHash,
        resource_url: expected.resourceUrl,
        merchant_to: expected.merchantTo,
        amount: expected.amount,
        asset: expected.asset,
        network: expected.network,
        expires_at: expected.expiresAt,
        auth: expected.auth,
      },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    // Not the schema boundary: an unknown version is now a Haven diagnosis.
    expect(result.code).toBe('SIGNING_ERROR')
    expect(result.code).not.toBe('INVALID_INPUT')
    expect(result.message).toMatch(/out of date/)
    expect(result.message).toContain('@haven_ai/signer')
  })

  it('still rejects a structurally invalid version at the schema boundary', async () => {
    // Widening the version is not the same as removing validation: a
    // non-numeric or nonsensical version is still an input error.
    const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
    const handlers = createToolHandlers(signer)
    const expected = await expectedWithVersion(1)
    const result = await handlers.haven_sign_x402({
      payload_hash: FUNDING_HASH,
      payment_required: PAYMENT_REQUIRED,
      x402_expected: {
        payment_id: expected.paymentId,
        payload_hash: expected.payloadHash,
        resource_url: expected.resourceUrl,
        merchant_to: expected.merchantTo,
        amount: expected.amount,
        asset: expected.asset,
        network: expected.network,
        expires_at: expected.expiresAt,
        auth: { ...expected.auth, version: 'two' as unknown as number },
      },
    })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.code).toBe('INVALID_INPUT')
  })
})
