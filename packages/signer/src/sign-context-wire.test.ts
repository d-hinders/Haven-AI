/**
 * #3001: the WIRE shape of a sign-context refusal, one level up from
 * `sign-context.test.ts` — through `createToolHandlers` / `haven_sign`, the
 * same path an MCP client actually calls. Before this, every refusal here
 * ({@link HavenSignContextError}'s four codes) reached the wire as
 * `{ success: false, code: 'SIGNING_ERROR', message }` — mutation-proved
 * below by asserting the CODE, not just failure.
 *
 * The API key from the identity fixture must never appear in a serialised
 * failure — the signer's one network capability is an authenticated read,
 * and the credential that authenticates it must not leak into an error an
 * agent (or its transcript) might echo back.
 */
import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { createEdgeSigner } from './core.js'
import { createToolHandlers, type ToolFailure } from './tools.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const BINDING_SIGNER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d',
).address
const API_KEY = 'sk_agent_test_3001_super_secret'
const IDENTITY = { apiKey: API_KEY, apiUrl: 'https://haven.test' }

function handlersWithFetch(fetchImpl: typeof fetch) {
  const signer = createEdgeSigner(TEST_KEY, { x402BindingSigner: BINDING_SIGNER })
  return createToolHandlers(signer, {
    signContext: { loadIdentity: async () => IDENTITY, fetchImpl },
  })
}

async function refusal(fetchImpl: typeof fetch): Promise<ToolFailure> {
  const handlers = handlersWithFetch(fetchImpl)
  const result = await handlers.haven_sign({ payment_id: 'pay_3001' })
  expect(result.success).toBe(false)
  if (result.success) throw new Error('expected failure')
  return result
}

describe('sign-context refusals reach the wire with code/fallback/next_action, not generic SIGNING_ERROR (#3001)', () => {
  it('SIGN_CONTEXT_TIMEOUT', async () => {
    // Names the same `err.name === 'TimeoutError'` branch a real
    // `AbortSignal.timeout()` firing would — without waiting out the real
    // `SIGN_CONTEXT_TIMEOUT_MS` (15s; that wait is covered directly in
    // sign-context.test.ts using an injected short timeoutMs).
    const fetchImpl = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      })
    }) as typeof fetch
    const result = await refusal(fetchImpl)
    expect(result.code).toBe('SIGN_CONTEXT_TIMEOUT')
    expect(result.fallback).toBe('typed_data_b64')
    expect(result.next_action).toBe('stop_and_tell_user')
    expect(result.http_status).toBeUndefined()
  })

  it('SIGN_CONTEXT_UNREACHABLE', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND haven.test')
    }) as typeof fetch
    const result = await refusal(fetchImpl)
    expect(result.code).toBe('SIGN_CONTEXT_UNREACHABLE')
    expect(result.fallback).toBe('typed_data_b64')
    expect(result.next_action).toBe('stop_and_tell_user')
    expect(result.http_status).toBeUndefined()
  })

  it('SIGN_CONTEXT_REFUSED (410) carries the http_status', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'Payment window expired' }), { status: 410 })) as typeof fetch
    const result = await refusal(fetchImpl)
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.http_status).toBe(410)
    expect(result.fallback).toBe('typed_data_b64')
    expect(result.next_action).toBe('stop_and_tell_user')
  })

  it('SIGN_CONTEXT_REFUSED (404) carries the http_status', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as typeof fetch
    const result = await refusal(fetchImpl)
    expect(result.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(result.http_status).toBe(404)
    expect(result.fallback).toBe('typed_data_b64')
    expect(result.next_action).toBe('stop_and_tell_user')
  })

  it('SIGN_CONTEXT_MALFORMED', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ payment_id: 'pay_3001' }), { status: 200 })) as typeof fetch
    const result = await refusal(fetchImpl)
    expect(result.code).toBe('SIGN_CONTEXT_MALFORMED')
    expect(result.fallback).toBe('typed_data_b64')
    expect(result.next_action).toBe('stop_and_tell_user')
    expect(result.http_status).toBeUndefined()
  })

  it('never leaks the identity api key into the serialised failure, across every code', async () => {
    const cases: Array<typeof fetch> = [
      (async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), {
          name: 'TimeoutError',
        })
      }) as typeof fetch,
      (async () => {
        throw new Error('getaddrinfo ENOTFOUND haven.test')
      }) as typeof fetch,
      (async () => new Response(JSON.stringify({ error: 'gone' }), { status: 410 })) as typeof fetch,
      (async () => new Response(JSON.stringify({ error: 'missing' }), { status: 404 })) as typeof fetch,
      (async () => new Response(JSON.stringify({ payment_id: 'pay_3001' }), { status: 200 })) as typeof fetch,
    ]
    for (const fetchImpl of cases) {
      const result = await refusal(fetchImpl)
      const serialised = JSON.stringify(result)
      expect(serialised).not.toContain(API_KEY)
    }
  })
})
