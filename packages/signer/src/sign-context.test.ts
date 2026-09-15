import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadHavenIdentity,
  fetchX402SignContext,
  HavenSignContextError,
  SIGN_CONTEXT_TIMEOUT_MS,
} from './sign-context.js'

const IDENTITY = { api_key: 'sk_agent_test_1263', api_url: 'https://haven.test/' }

describe('loadHavenIdentity (#1263)', () => {
  it('reads identity.json next to the signer credential file and strips trailing slash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-sign-ctx-'))
    try {
      await writeFile(join(dir, 'identity.json'), JSON.stringify(IDENTITY))
      const identity = await loadHavenIdentity(join(dir, 'signer.json'))
      expect(identity).toEqual({ apiKey: 'sk_agent_test_1263', apiUrl: 'https://haven.test' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns null — never throws — for missing/partial identity or no path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-sign-ctx-'))
    try {
      expect(await loadHavenIdentity(undefined)).toBeNull()
      expect(await loadHavenIdentity(join(dir, 'signer.json'))).toBeNull()
      await writeFile(join(dir, 'identity.json'), JSON.stringify({ api_key: 'sk_x' }))
      expect(await loadHavenIdentity(join(dir, 'signer.json'))).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('fetchX402SignContext (#1263)', () => {
  const identity = { apiKey: 'sk_agent_test_1263', apiUrl: 'https://haven.test' }

  it('GETs the sign-context with the bearer credential and returns the exact payload', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url)
      seenAuth = (init?.headers as Record<string, string>).Authorization
      return new Response(
        JSON.stringify({
          payment_id: 'pay_1263',
          sign_data: { hash: '0x' + 'ab'.repeat(32), typed_data: { primaryType: 'X' } },
          x402_expected: { payment_id: 'pay_1263' },
        }),
        { status: 200 },
      )
    }) as typeof fetch
    const ctx = await fetchX402SignContext(identity, 'pay_1263', fetchImpl)
    expect(seenUrl).toBe('https://haven.test/x402/pay_1263/sign-context')
    expect(seenAuth).toBe('Bearer sk_agent_test_1263')
    expect(ctx.payloadHash).toBe('0x' + 'ab'.repeat(32))
    expect(ctx.typedData).toEqual({ primaryType: 'X' })
  })

  // #2985: the fetch is bounded. A fetchImpl that only ever settles when its
  // signal aborts stands in for a hung backend; without the signal this test
  // hangs past vitest's own timeout, which is the red we want.
  it('aborts a hung sign-context fetch and names the timeout and the typed_data_b64 fallback (#2985)', async () => {
    let sawSignal = false
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return // no signal → never settles → the test times out
        sawSignal = true
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })),
        )
      })) as typeof fetch
    await expect(fetchX402SignContext(identity, 'pay_hung', fetchImpl, 20)).rejects.toThrow(
      /within 20 ms.*typed_data_b64/s,
    )
    expect(sawSignal).toBe(true)
  }, 2_000)

  it('a body read that stalls past the timeout names the timeout, not a malformed response (#2985 review)', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })),
            )
          }),
      } as unknown as Response)) as typeof fetch
    await expect(fetchX402SignContext(identity, 'pay_stall', fetchImpl, 20)).rejects.toThrow(
      /within 20 ms.*typed_data_b64/s,
    )
  }, 2_000)

  it('the default timeout is exported and sane — long enough for a read, short enough to leave the window (#2985)', () => {
    expect(SIGN_CONTEXT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
    expect(SIGN_CONTEXT_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })

  it('maps a 410 to an error naming the re-quote step', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'Payment window expired' }), { status: 410 })) as typeof fetch
    await expect(fetchX402SignContext(identity, 'pay_x', fetchImpl)).rejects.toThrow(
      /expired.*idempotency key/is,
    )
  })

  it('carries payment_required when present, null when absent or malformed (#1355)', async () => {
    const base = {
      payment_id: 'pay_1355',
      sign_data: { hash: '0x' + 'ab'.repeat(32), typed_data: { primaryType: 'X' } },
      x402_expected: { payment_id: 'pay_1355' },
    }
    const withBlob = (async () =>
      new Response(
        JSON.stringify({ ...base, payment_required: { accepts: [{ scheme: 'exact' }] } }),
        { status: 200 },
      )) as typeof fetch
    expect((await fetchX402SignContext(identity, 'pay_1355', withBlob)).paymentRequired).toEqual({
      accepts: [{ scheme: 'exact' }],
    })

    const without = (async () => new Response(JSON.stringify(base), { status: 200 })) as typeof fetch
    expect((await fetchX402SignContext(identity, 'pay_1355', without)).paymentRequired).toBeNull()

    // An array or scalar is not a PaymentRequired — null, never a crash.
    const malformed = (async () =>
      new Response(JSON.stringify({ ...base, payment_required: [1, 2] }), { status: 200 })) as typeof fetch
    expect((await fetchX402SignContext(identity, 'pay_1355', malformed)).paymentRequired).toBeNull()
  })

  it('refuses a response missing the signing payload, naming the fallback', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ payment_id: 'pay_x' }), { status: 200 })) as typeof fetch
    await expect(fetchX402SignContext(identity, 'pay_x', fetchImpl)).rejects.toThrow(
      /typed_data_b64/,
    )
  })
})

/**
 * #3001: every throw site in `fetchX402SignContext` is a `HavenSignContextError`
 * carrying a stable `code` / `fallback` / `next_action` — not just prose inside
 * a generic `HavenSigningError`. `instanceof HavenSigningError` must still hold
 * (nothing in the codebase catches the narrower class specifically today).
 */
describe('fetchX402SignContext throws HavenSignContextError with a structured refusal (#3001)', () => {
  const identity = { apiKey: 'sk_agent_test_3001', apiUrl: 'https://haven.test' }

  async function caught(fetchImpl: typeof fetch, timeoutMs?: number): Promise<HavenSignContextError> {
    const err = await fetchX402SignContext(identity, 'pay_3001', fetchImpl, timeoutMs).catch(
      (e: unknown) => e,
    )
    if (!(err instanceof HavenSignContextError)) {
      throw new Error(`expected a HavenSignContextError, got ${String(err)}`)
    }
    return err
  }

  it('SIGN_CONTEXT_TIMEOUT on an aborted request', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
        )
      })) as typeof fetch
    const err = await caught(fetchImpl, 20)
    expect(err.code).toBe('SIGN_CONTEXT_TIMEOUT')
    expect(err.fallback).toBe('typed_data_b64')
    expect(err.next_action).toBe('stop_and_tell_user')
    expect(err.http_status).toBeUndefined()
    expect(err).toBeInstanceOf(Error)
  }, 2_000)

  it('SIGN_CONTEXT_TIMEOUT on a stalled body read', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })),
            )
          }),
      } as unknown as Response)) as typeof fetch
    const err = await caught(fetchImpl, 20)
    expect(err.code).toBe('SIGN_CONTEXT_TIMEOUT')
    expect(err.fallback).toBe('typed_data_b64')
    expect(err.next_action).toBe('stop_and_tell_user')
  }, 2_000)

  it('SIGN_CONTEXT_UNREACHABLE on a network error', async () => {
    const fetchImpl = (async () => {
      throw new Error('getaddrinfo ENOTFOUND haven.test')
    }) as typeof fetch
    const err = await caught(fetchImpl)
    expect(err.code).toBe('SIGN_CONTEXT_UNREACHABLE')
    expect(err.fallback).toBe('typed_data_b64')
    expect(err.next_action).toBe('stop_and_tell_user')
    expect(err.http_status).toBeUndefined()
  })

  it('SIGN_CONTEXT_REFUSED with http_status on a 410', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'Payment window expired', error_code: 'expired' }), { status: 410 })) as typeof fetch
    const err = await caught(fetchImpl)
    expect(err.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(err.http_status).toBe(410)
    expect(err.backend_error_code).toBe('expired')
    expect(err.fallback).toBeUndefined()
    expect(err.next_action).toBe('payment_window_expired')
    expect(err.retry_with_new_quote).toBe(true)
  })

  it('SIGN_CONTEXT_REFUSED with http_status on a 404', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as typeof fetch
    const err = await caught(fetchImpl)
    expect(err.code).toBe('SIGN_CONTEXT_REFUSED')
    expect(err.http_status).toBe(404)
    expect(err.fallback).toBeUndefined()
    expect(err.next_action).toBe('stop_and_tell_user')
  })

  it('SIGN_CONTEXT_MALFORMED on a response missing the signing payload', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ payment_id: 'pay_3001' }), { status: 200 })) as typeof fetch
    const err = await caught(fetchImpl)
    expect(err.code).toBe('SIGN_CONTEXT_MALFORMED')
    expect(err.fallback).toBe('typed_data_b64')
    expect(err.next_action).toBe('stop_and_tell_user')
    expect(err.http_status).toBeUndefined()
  })
})
