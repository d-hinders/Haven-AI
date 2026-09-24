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
 * no signature, no audit entry — mirroring the caller-supplied-typed-data
 * case `server.test.ts` covers for the corrupted-in-transit failure mode.
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENTRY_POINT_V07,
  PACKED_USER_OPERATION_FIELDS,
  packedUserOperationHash,
} from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'
import { createToolHandlers } from './tools.js'
import { SUPPORTED_DIRECT_SIGN_CONTEXT_VERSIONS } from './sign-context.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const IDENTITY = { apiKey: 'sk_agent_test_3271', apiUrl: 'https://haven.test' }

function buildDirectUserOp(overrides: { sender?: `0x${string}` } = {}) {
  const sender = overrides.sender ?? `0x${'11'.repeat(20)}`
  const typedData = {
    domain: { name: 'HybridDeleGator', version: '1', chainId: 84532, verifyingContract: sender },
    types: { PackedUserOperation: PACKED_USER_OPERATION_FIELDS.map((field) => ({ ...field })) },
    primaryType: 'PackedUserOperation' as const,
    message: {
      sender,
      nonce: '0',
      initCode: '0x' as const,
      callData: '0x' as const,
      accountGasLimits: `0x${'00'.repeat(32)}` as const,
      preVerificationGas: '0',
      gasFees: `0x${'00'.repeat(32)}` as const,
      paymasterAndData: '0x' as const,
      entryPoint: ENTRY_POINT_V07 as `0x${string}`,
    },
  }
  return { typedData, payloadHash: packedUserOperationHash(typedData) }
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
