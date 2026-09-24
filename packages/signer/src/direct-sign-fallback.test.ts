/**
 * #3271: `haven_sign` falls back from the x402 sign-context fetch to the
 * direct-payment one when the backend refuses the x402 fetch with its 409
 * `sign_context_unavailable` — the shape this payment_id names a direct
 * payment, not an x402 intent. `haven_sign_x402` never does: a direct
 * payment has no x402 context to fund a merchant retry with.
 *
 * Also covers the #3271 binding-mismatch structured refusal reached through
 * this fetch path: a fetched direct sign-context whose typed data does not
 * recompute to its own payload_hash is refused with USEROP_BINDING_MISMATCH,
 * no signature, no audit entry. The caller-relayed case (the #3271
 * reproduction itself) and a fetched non-UserOp shape are covered at the end
 * of this file.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { createEdgeSigner } from './core.js'
import { createToolHandlers } from './tools.js'
import { SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS } from './sign-context.js'
import { buildBoundDirectUserOp } from './test-support/direct-userop.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_DELEGATE_ADDRESS = privateKeyToAccount(TEST_KEY).address
const IDENTITY = { apiKey: 'sk_agent_test_3271', apiUrl: 'https://haven.test' }

/**
 * #3272: a real-shaped, BOUND UserOp for TEST_KEY's own delegate account — the
 * toy fixture this file used (sender `0x1111…1111`, empty `callData`) is
 * refused by the #3272 allowlist for BOTH reasons (wrong account, and no
 * redeemDelegations call), which would mask which #3271 property each test
 * below actually exercises.
 */
function buildDirectUserOp(overrides: { sender?: `0x${string}` } = {}) {
  return buildBoundDirectUserOp({ delegate: TEST_DELEGATE_ADDRESS, ...overrides })
}

function fetchImplFor(
  routes: Partial<Record<'x402' | 'direct', () => Response>>,
): typeof fetch {
  return (async (url: unknown) => {
    const path = String(url)
    if (path.includes('/x402/')) return routes.x402!()
    if (path.includes('/payments/')) return routes.direct!()
    throw new Error(`unexpected fetch: ${path}`)
  }) as typeof fetch
}

function x402Unavailable(): Response {
  return new Response(
    JSON.stringify({ error: 'not an x402 payment', error_code: 'sign_context_unavailable' }),
    { status: 409 },
  )
}

describe('haven_sign falls back to the direct-payment sign-context (#3271)', () => {
  it('signs the fetched PackedUserOperation after the x402 fetch refuses with 409 sign_context_unavailable', async () => {
    const { typedData, payloadHash } = buildDirectUserOp()
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY), {
      signContext: {
        loadIdentity: async () => IDENTITY,
        fetchImpl: fetchImplFor({
          x402: x402Unavailable,
          direct: () =>
            new Response(
              JSON.stringify({
                payment_id: 'pay_direct',
                status: 'pending_signature',
                direct_sign_context_version: SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS[0],
                sign_data: { hash: payloadHash, signature_scheme: 'eip712_userop', typed_data: typedData },
              }),
              { status: 200 },
            ),
        }),
      },
    })

    const result = await handlers.haven_sign({ payment_id: 'pay_direct' })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error('expected success')
    expect((result.data as { signature: string }).signature).toMatch(/^0x[0-9a-f]+$/)
  })

  it('refuses when the caller-supplied payload_hash does not match the fetched one', async () => {
    const { typedData, payloadHash } = buildDirectUserOp()
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY), {
      signContext: {
        loadIdentity: async () => IDENTITY,
        fetchImpl: fetchImplFor({
          x402: x402Unavailable,
          direct: () =>
            new Response(
              JSON.stringify({
                payment_id: 'pay_direct',
                status: 'pending_signature',
                direct_sign_context_version: SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS[0],
                sign_data: { hash: payloadHash, signature_scheme: 'eip712_userop', typed_data: typedData },
              }),
              { status: 200 },
            ),
        }),
      },
    })

    const result = await handlers.haven_sign({
      payment_id: 'pay_direct',
      payload_hash: `0x${'ee'.repeat(32)}`,
    })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.message).toMatch(/does not match the signing context/)
  })
})

describe('haven_sign_x402 never falls back to the direct-payment sign-context (#3271)', () => {
  it('surfaces the 409 sign_context_unavailable refusal unchanged instead of fetching /payments/:id/sign-context', async () => {
    let directFetchCalled = false
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY), {
      signContext: {
        loadIdentity: async () => IDENTITY,
        fetchImpl: fetchImplFor({
          x402: x402Unavailable,
          direct: () => {
            directFetchCalled = true
            return new Response('{}', { status: 200 })
          },
        }),
      },
    })

    const result = await handlers.haven_sign_x402({ payment_id: 'pay_direct' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.backend_error_code).toBe('sign_context_unavailable')
    expect(directFetchCalled).toBe(false)
  })
})

describe('the #3271 binding check refuses a fetched direct sign-context whose typed data is corrupted', () => {
  it('USEROP_BINDING_MISMATCH: no signature, no audit entry', async () => {
    const { typedData, payloadHash } = buildDirectUserOp()
    // Corrupt the fetched typed data after the hash was computed — the
    // #3271 failure mode: the bytes arrived altered.
    const corrupted = { ...typedData, message: { ...typedData.message, callData: `0x${'ff'.repeat(4)}` } }

    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-direct-binding-'))
    const auditPath = join(dir, 'audit.jsonl')
    try {
      const signer = createEdgeSigner(TEST_KEY)
      const handlers = createToolHandlers(signer, {
        audit: { auditPath, delegateAddress: signer.delegateAddress },
        signContext: {
          loadIdentity: async () => IDENTITY,
          fetchImpl: fetchImplFor({
            x402: x402Unavailable,
            direct: () =>
              new Response(
                JSON.stringify({
                  payment_id: 'pay_direct',
                  status: 'pending_signature',
                  direct_sign_context_version: SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS[0],
                  sign_data: { hash: payloadHash, signature_scheme: 'eip712_userop', typed_data: corrupted },
                }),
                { status: 200 },
              ),
          }),
        },
      })

      const result = await handlers.haven_sign({ payment_id: 'pay_direct' })
      expect(result.success).toBe(false)
      if (result.success) throw new Error('expected failure')
      expect(result.code).toBe('USEROP_BINDING_MISMATCH')
      expect(result.next_action).toBe('stop_and_tell_user')
      expect('signature' in result).toBe(false)

      await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Runs `haven_sign` with an audit log and asserts the #3271 refusal shape:
 * `USEROP_BINDING_MISMATCH`, no signature, and nothing written to the audit.
 */
async function expectBindingRefusal(
  args: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'haven-signer-direct-binding-'))
  const auditPath = join(dir, 'audit.jsonl')
  try {
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = createToolHandlers(signer, {
      audit: { auditPath, delegateAddress: signer.delegateAddress },
      ...(fetchImpl ? { signContext: { loadIdentity: async () => IDENTITY, fetchImpl } } : {}),
    })
    const result = await handlers.haven_sign(args as Parameters<typeof handlers.haven_sign>[0])
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.code).toBe('USEROP_BINDING_MISMATCH')
    expect('signature' in result).toBe(false)
    await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('the #3271 binding check on a fetched non-UserOp shape', () => {
  it('refuses a fetched eip712_userop context whose typed data is not a PackedUserOperation', async () => {
    const permit = {
      domain: { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: `0x${'22'.repeat(20)}` },
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'value', type: 'uint256' }] },
      primaryType: 'Permit',
      message: { owner: `0x${'33'.repeat(20)}`, value: '1000000' },
    }
    await expectBindingRefusal(
      { payment_id: 'pay_direct_permit' },
      fetchImplFor({
        x402: x402Unavailable,
        direct: () =>
          new Response(
            JSON.stringify({
              payment_id: 'pay_direct_permit',
              status: 'pending_signature',
              direct_sign_context_version: SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS[0],
              sign_data: { hash: `0x${'44'.repeat(32)}`, signature_scheme: 'eip712_userop', typed_data: permit },
            }),
            { status: 200 },
          ),
      }),
    )
  })
})

// Criteria 3 and 7: the RELAY branch — the exact #3271 reproduction, where
// the agent hand-copied the payload — runs the same check as the fetch.
describe('the #3271 binding check on a caller-relayed direct payload', () => {
  it('refuses a relayed typed_data with one callData byte flipped', async () => {
    const { typedData, payloadHash } = buildDirectUserOp()
    const corrupted = { ...typedData, message: { ...typedData.message, callData: '0x00' } }
    await expectBindingRefusal({ payload_hash: payloadHash, typed_data: corrupted })
  })

  it('refuses a relayed typed_data_b64 with a corrupted domain.verifyingContract', async () => {
    const { typedData, payloadHash } = buildDirectUserOp()
    const corrupted = { ...typedData, domain: { ...typedData.domain, verifyingContract: `0x${'de'.repeat(20)}` } }
    await expectBindingRefusal({
      payload_hash: payloadHash,
      typed_data_b64: Buffer.from(JSON.stringify(corrupted)).toString('base64'),
    })
  })

  it('still signs an unaltered relayed payload (positive control)', async () => {
    const { typedData, payloadHash } = buildDirectUserOp()
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = createToolHandlers(signer)
    const result = await handlers.haven_sign({
      payload_hash: payloadHash,
      typed_data_b64: Buffer.from(JSON.stringify(typedData)).toString('base64'),
    })
    expect(result.success).toBe(true)
  })
})

// Review round 1: a direct-fetch refusal must name DIRECT remedies — there is
// no quote tool to re-run, and the payment result carries the relay fields.
describe('direct sign-context refusals name direct-payment remedies (#3271)', () => {
  function handlersWith(direct: () => Response, x402: () => Response = x402Unavailable) {
    const signer = createEdgeSigner(TEST_KEY)
    return createToolHandlers(signer, {
      signContext: { loadIdentity: async () => IDENTITY, fetchImpl: fetchImplFor({ x402, direct }) },
    })
  }

  it('a 404 from the direct route (old backend, or not this agent\'s payment) points at the typed_data_b64 relay', async () => {
    const result = await handlersWith(
      () => new Response(JSON.stringify({ message: 'Route GET:/payments/x/sign-context not found' }), { status: 404 }),
    ).haven_sign({ payment_id: 'pay_old_backend' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect((result as { fallback?: string }).fallback).toBe('typed_data_b64')
    expect(result.message).toMatch(/typed_data_b64/)
    expect(JSON.stringify(result)).not.toMatch(/quote/)
  })

  it('a 410 from the direct route says to re-send the payment, never to re-run a quote', async () => {
    const result = await handlersWith(
      () => new Response(JSON.stringify({ error: 'Payment window expired', error_code: 'expired' }), { status: 410 }),
    ).haven_sign({ payment_id: 'pay_expired' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.next_action).toBe('payment_window_expired')
    expect('retry_with_new_quote' in result).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(/quote/)
    expect(JSON.stringify(result)).toMatch(/haven_send \/ haven_pay/)
  })

  it('a bare 410 from the direct route (a retired-rail tombstone) stops and tells the user, never "re-send"', async () => {
    const result = await handlersWith(
      () => new Response(JSON.stringify({ error: 'This rail is retired' }), { status: 410 }),
    ).haven_sign({ payment_id: 'pay_retired' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.next_action).toBe('stop_and_tell_user')
    expect((result as { next_tool?: string }).next_tool).toBe('mcp__haven__haven_get_payment_status')
    expect((result as { next_arguments?: unknown }).next_arguments).toEqual({ payment_id: 'pay_retired' })
    expect('retry_with_new_quote' in result).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(/quote|same idempotency_key/)
  })

  it('a transport failure on the direct fetch names the typed_data_b64 relay, never a quote re-run', async () => {
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = createToolHandlers(signer, {
      signContext: {
        loadIdentity: async () => IDENTITY,
        fetchImpl: (async (url: unknown) => {
          if (String(url).includes('/x402/')) return x402Unavailable()
          throw new TypeError('fetch failed')
        }) as typeof fetch,
      },
    })
    const result = await handlers.haven_sign({ payment_id: 'pay_unreachable' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.code).toBe('SIGN_CONTEXT_UNREACHABLE')
    expect((result as { next_tool_omitted_reason?: string }).next_tool_omitted_reason).toMatch(/typed_data_b64 from the haven_send \/ haven_pay result/)
    expect(JSON.stringify(result)).not.toMatch(/quote/)
  })

  it('an x402 row the x402 route cannot serve keeps the x402 refusal instead of the direct route\'s', async () => {
    const x402Refusal = () =>
      new Response(
        JSON.stringify({ error: 'legacy-rail x402 intent has no stored signing payload', error_code: 'sign_context_unavailable' }),
        { status: 409 },
      )
    const directRefusal = () =>
      new Response(
        JSON.stringify({ error: 'This is an x402/machine payment intent', error_code: 'sign_context_unavailable' }),
        { status: 409 },
      )
    const result = await handlersWith(directRefusal, x402Refusal).haven_sign({ payment_id: 'pay_legacy_x402' })
    expect(result.success).toBe(false)
    if (result.success) throw new Error('expected failure')
    expect(result.message).toMatch(/legacy-rail x402 intent/)
  })
})
