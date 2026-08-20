/**
 * What must stay TRUE across the decomposition (#1620, closing epic #1613).
 *
 * The modules are meant to be isolated in what they own and identical in what
 * they share. Isolation is guarded next door in `x402-module-boundaries.test.ts`;
 * this file guards the other half — that a per-request header, a configured
 * timeout, and the identity of the Haven transport do not quietly diverge once
 * a protocol lives in its own file.
 *
 * The failure this prevents is specific and would be silent: a module that
 * built its own transport instead of taking the client's would still pass
 * every functional test, while dropping the caller's `withRequestContext`
 * headers and its configured timeout on the floor for that protocol only.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { HavenClient } from './client.js'
import { HavenApiTransport } from './haven-api-transport.js'

const DELEGATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

/**
 * Modules holding the transport directly. `delegateSweep` keeps its options
 * bag rather than destructuring it, so it is reached one level down — a
 * difference in style, not in the instance it holds, which is the point.
 */
const TRANSPORT_HOLDERS = ['accountReads'] as const
const OPTIONS_BAG_HOLDERS = ['delegateSweep'] as const

/** Every module that reaches Haven through the facade's `post` closure. */
const POST_DELEGATES = ['fundingLeg', 'erc7710', 'merchantCompletion'] as const

function client(over: Record<string, unknown> = {}): HavenClient {
  return new HavenClient({
    apiKey: 'sk_agent_test',
    baseUrl: 'https://haven.test',
    delegateKey: DELEGATE_KEY,
    ...over,
  })
}

function internals(haven: HavenClient): Record<string, { transport?: unknown; post?: unknown }> {
  return haven as unknown as Record<string, { transport?: unknown; post?: unknown }>
}

describe('cross-protocol contracts (#1620)', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('every module shares ONE transport instance — not a copy of its config', () => {
    const haven = client()
    const parts = internals(haven)
    const transport = parts.havenApi as unknown as HavenApiTransport

    expect(transport).toBeInstanceOf(HavenApiTransport)

    // Identity, not equality. Two transports built from the same config would
    // behave identically until someone set a per-request header on one of
    // them — which is exactly the divergence this pins.
    for (const holder of TRANSPORT_HOLDERS) {
      expect(parts[holder], `${holder} is missing`).toBeDefined()
      expect(parts[holder].transport, `${holder} holds its own transport`).toBe(transport)
    }
    for (const holder of OPTIONS_BAG_HOLDERS) {
      const bag = (parts[holder] as unknown as { options?: { transport?: unknown } }).options
      expect(bag?.transport, `${holder} holds its own transport`).toBe(transport)
    }
    for (const holder of POST_DELEGATES) {
      expect(parts[holder], `${holder} is missing`).toBeDefined()
      // These take a closure over the facade's own `post`, so they cannot
      // hold a transport of their own by construction.
      expect(typeof parts[holder].post).toBe('function')
      expect(parts[holder].transport).toBeUndefined()
    }
  })

  it('MUTATION PROOF: a withRequestContext header reaches EVERY protocol', async () => {
    // Give any module a transport of its own and its request loses this
    // header while the others keep it — a divergence no functional test would
    // notice, because the call still succeeds.
    const seen: Array<{ path: string; trace: string | null }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({
        path: new URL(url).pathname,
        trace: new Headers(init.headers).get('x-trace-id'),
      })
      return new Response(JSON.stringify({ payment_id: 'pay_1', payment_header: 'hdr' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const haven = client()
    const parts = internals(haven)

    await haven.withRequestContext({ 'x-trace-id': 'trace-42' }, async () => {
      // One call per protocol module, each through its own entry point.
      await (parts.fundingLeg as unknown as {
        post: <T>(p: string, b: Record<string, unknown>) => Promise<T>
      }).post('/x402', {})
      await (parts.erc7710 as unknown as {
        post: <T>(p: string, b: Record<string, unknown>) => Promise<T>
      }).post('/x402/pay_1/settle', {})
      await (parts.merchantCompletion as unknown as {
        post: <T>(p: string, b: Record<string, unknown>) => Promise<T>
      }).post('/machine-payments/evidence', {})
      await (parts.accountReads as unknown as {
        transport: { get: <T>(p: string) => Promise<T> }
      }).transport.get('/agents/me')
    })

    expect(seen).toHaveLength(4)
    for (const call of seen) {
      expect(call.trace, `${call.path} lost the request context header`).toBe('trace-42')
    }
  })

  it('the configured request timeout is the transport\'s, so it is every protocol\'s', async () => {
    // Assert on the SIGNAL the module's request carries rather than on a
    // stalled fetch: a module wired to its own transport would still abort
    // eventually, just on the wrong deadline, and a test that waits for a
    // hang reports "Test timed out" instead of naming the missing wiring.
    let aborted = false
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      expect(init.signal, 'the request carries no abort signal').toBeDefined()
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('aborted'))
        })
      })
    })

    const haven = client({ requestTimeout: 25 })
    const parts = internals(haven)

    const request = (parts.fundingLeg as unknown as {
      post: <T>(p: string, b: Record<string, unknown>) => Promise<T>
    }).post('/x402', {}).then(
      () => 'resolved' as const,
      () => 'aborted' as const,
    )
    // Raced rather than awaited: a module ignoring the configured 25ms would
    // otherwise hang until vitest's own timeout, and "Test timed out" does not
    // tell the next reader that the timeout wiring is what broke.
    const outcome = await Promise.race([
      request,
      new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), 500)),
    ])

    expect(outcome, 'the module request ignored the configured 25ms deadline').toBe('aborted')
    expect(aborted, 'the request aborted without its signal firing').toBe(true)
  })

  it('the 3009 receipt cache is owned by exactly one module', () => {
    // Two protocols sharing a cache keyed by an EIP-3009 authorization's
    // expiry is the shape #1521 came from. The erc7710 path mints no
    // authorization, so it must have nothing to cache.
    const parts = internals(client()) as unknown as Record<string, Record<string, unknown>>

    expect(typeof parts.fundingLeg.cachedReceipt).toBe('function')
    expect(parts.erc7710.cachedReceipt).toBeUndefined()
    expect(parts.merchantCompletion.cachedReceipt).toBeUndefined()
    // And the facade no longer holds one at all (#1618).
    expect(parts.x402ReceiptCache).toBeUndefined()
  })

  it('the facade owns dedup, and only dedup, of the shared in-flight state', () => {
    // The in-flight map stayed on the facade when the receipt cache moved,
    // because dedup spans an authorize call rather than belonging to it.
    const parts = internals(client()) as unknown as Record<string, unknown>
    expect(parts.inFlightX402).toBeInstanceOf(Map)
  })
})
