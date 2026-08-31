/**
 * #2289: the outbound x402 payment header NAME.
 *
 * x402 v2 renamed the client→server payment header to `PAYMENT-SIGNATURE`;
 * `X-PAYMENT` is the v1 name. Haven read the v2 names inbound
 * (`PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`) but sent only the v1 name outbound,
 * so a strict v2 merchant never saw the header at all — on the EIP-3009 bridge
 * that means the funding leg has already moved USDC to the delegate EOA and
 * the user pays for nothing.
 *
 * Reproduced live against CoinGecko on 2026-08-31: under `X-PAYMENT` the 402
 * response is byte-identical to sending no header (x-runtime 0.0036s); under
 * `PAYMENT-SIGNATURE` the merchant decodes the payload and forwards it to its
 * facilitator (0.075s, a facilitator-validation error).
 *
 * The first block is CHARACTERIZATION (money.md): it pins the behaviour that
 * must SURVIVE the fix — every merchant retry still carries `X-PAYMENT`, still
 * overwrites a stale value, and still leaves the body and unrelated headers
 * alone. Haven's own demo merchant accepts the legacy alias, and so do the
 * merchants this has always worked against; breaking them to fix CoinGecko
 * would trade one outage for another.
 */
import { describe, expect, it, vi } from 'vitest'
import { McpMerchantTransport } from './mcp-merchant-transport.js'
import {
  X402_LEGACY_PAYMENT_HEADER_NAME,
  X402_PAYMENT_HEADER_NAME,
} from './x402.js'

const HEADER = 'signed-payment-header'
const URL_ = 'https://merchant.test/resource'

/** Capture the headers a delivery actually put on the wire. */
function transportWithCapture() {
  const seen: Headers[] = []
  const fetch = vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
    seen.push(new Headers(init.headers))
    return new Response('ok')
  })
  return { transport: new McpMerchantTransport({ fetch }), seen, fetch }
}

/**
 * A merchant that reads exactly ONE header name and 402s otherwise — the shape
 * of a real strict implementation. Haven's demo merchant accepts BOTH names
 * (`LEGACY_PAYMENT_SIGNATURE_HEADER` in demo-merchant-mcp), which is precisely
 * why no existing test could catch this: a lenient merchant passes either way.
 */
function strictMerchant(readsHeader: string) {
  return vi.fn(async (_input: string | URL | Request, init: RequestInit = {}) => {
    const value = new Headers(init.headers).get(readsHeader)
    return value === HEADER
      ? new Response('merchant result', { status: 200 })
      : new Response(JSON.stringify({ error: 'Payment required' }), { status: 402 })
  })
}

describe('x402 outbound payment header — characterization (must survive #2289)', () => {
  it('still sends the legacy X-PAYMENT name on every merchant retry', async () => {
    const { transport, seen } = transportWithCapture()
    await transport.deliverPayment(URL_, undefined, HEADER)
    expect(seen[0].get(X402_LEGACY_PAYMENT_HEADER_NAME)).toBe(HEADER)
  })

  it('still overwrites a stale legacy header rather than appending to it', async () => {
    const { transport, seen } = transportWithCapture()
    await transport.deliverPayment(URL_, { headers: { 'X-PAYMENT': 'stale' } }, HEADER)
    expect(seen[0].get(X402_LEGACY_PAYMENT_HEADER_NAME)).toBe(HEADER)
  })

  it('still leaves the request body and unrelated headers untouched', async () => {
    const { transport, seen, fetch } = transportWithCapture()
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tools/call' })
    await transport.deliverPayment(
      URL_,
      { method: 'POST', body, headers: { 'mcp-session-id': 'sess-1', accept: 'application/json' } },
      HEADER,
    )
    expect(fetch.mock.calls[0][1]!.body).toBe(body)
    expect(seen[0].get('mcp-session-id')).toBe('sess-1')
    expect(seen[0].get('accept')).toBe('application/json')
  })

  it('still satisfies a merchant that reads ONLY the legacy name', async () => {
    const fetch = strictMerchant(X402_LEGACY_PAYMENT_HEADER_NAME)
    const transport = new McpMerchantTransport({ fetch })
    const response = await transport.deliverPayment(URL_, undefined, HEADER)
    expect(response.status).toBe(200)
  })
})

describe('x402 outbound payment header — the v2 name (#2289)', () => {
  it('sends PAYMENT-SIGNATURE alongside X-PAYMENT, with identical values', async () => {
    const { transport, seen } = transportWithCapture()
    await transport.deliverPayment(URL_, undefined, HEADER)
    expect(seen[0].get(X402_PAYMENT_HEADER_NAME)).toBe(HEADER)
    expect(seen[0].get(X402_LEGACY_PAYMENT_HEADER_NAME)).toBe(HEADER)
    expect(seen[0].get(X402_PAYMENT_HEADER_NAME)).toBe(seen[0].get(X402_LEGACY_PAYMENT_HEADER_NAME))
  })

  it('satisfies a strict v2 merchant that reads ONLY PAYMENT-SIGNATURE', async () => {
    // The regression this issue exists for. Before the fix this returns 402 —
    // the same opaque 402 CoinGecko returned, and the same one it returns when
    // no header is sent at all.
    const fetch = strictMerchant(X402_PAYMENT_HEADER_NAME)
    const transport = new McpMerchantTransport({ fetch })
    const response = await transport.deliverPayment(URL_, undefined, HEADER)
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('merchant result')
  })

  it('overwrites a stale PAYMENT-SIGNATURE the same way it overwrites the legacy name', async () => {
    const { transport, seen } = transportWithCapture()
    await transport.deliverPayment(
      URL_,
      { headers: { 'PAYMENT-SIGNATURE': 'stale-v2', 'X-PAYMENT': 'stale-v1' } },
      HEADER,
    )
    expect(seen[0].get(X402_PAYMENT_HEADER_NAME)).toBe(HEADER)
    expect(seen[0].get(X402_LEGACY_PAYMENT_HEADER_NAME)).toBe(HEADER)
  })

  it('names both headers, v2 first, so the constants cannot drift from the wire', () => {
    // Pinned as literals on purpose: these two strings ARE the protocol, and a
    // constant that silently changes value is the defect this issue reports.
    expect(X402_PAYMENT_HEADER_NAME).toBe('PAYMENT-SIGNATURE')
    expect(X402_LEGACY_PAYMENT_HEADER_NAME).toBe('X-PAYMENT')
  })
})
