import { describe, expect, it } from 'vitest'
import {
  assertSecureX402RetryTarget,
  HavenInsecureRetryTargetError,
  INSECURE_RETRY_TARGET_CODE,
  isSecureX402RetryTarget,
  resolveX402RetryTarget,
} from './x402-retry-target.js'
import { McpMerchantTransport } from './mcp-merchant-transport.js'

/**
 * #3097 — the paid retry's target and whether it may be sent at all. The
 * Ampersend sandbox declares `http://` in its challenge for a resource served
 * over https; a client that adopted the declaration sent PAYMENT-SIGNATURE in
 * clear on the first hop (308 → https after). These pins are the rule.
 */
describe('resolveX402RetryTarget', () => {
  it('prefers the URL the caller quoted and reports the merchant disagreeing', () => {
    expect(
      resolveX402RetryTarget({
        requestUrl: 'https://services.sandbox.ampersend.ai/api/fact',
        resourceUrl: 'http://services.sandbox.ampersend.ai/api/fact',
      }),
    ).toEqual({
      url: 'https://services.sandbox.ampersend.ai/api/fact',
      source: 'request',
      resourceUrlDiffersFromRequest: true,
    })
  })

  it('falls back to the merchant declaration only when the caller named nothing', () => {
    expect(resolveX402RetryTarget({ requestUrl: undefined, resourceUrl: 'https://m.example.com/x' })).toEqual({
      url: 'https://m.example.com/x',
      source: 'resource',
      resourceUrlDiffersFromRequest: false,
    })
    expect(resolveX402RetryTarget({ requestUrl: '  ', resourceUrl: 'https://m.example.com/x' }).source).toBe('resource')
  })

  it('does not flag a declaration that equals the request', () => {
    expect(
      resolveX402RetryTarget({ requestUrl: 'https://m.example.com/x', resourceUrl: 'https://m.example.com/x' })
        .resourceUrlDiffersFromRequest,
    ).toBe(false)
  })
})

describe('isSecureX402RetryTarget', () => {
  it('accepts https anywhere', () => {
    expect(isSecureX402RetryTarget('https://services.sandbox.ampersend.ai/api/fact')).toBe(true)
    expect(isSecureX402RetryTarget('https://merchant.com/paid')).toBe(true)
  })

  it('refuses a public http target — the case the Ampersend sandbox declares', () => {
    expect(isSecureX402RetryTarget('http://services.sandbox.ampersend.ai/api/fact')).toBe(false)
    expect(isSecureX402RetryTarget('http://merchant.com/paid')).toBe(false)
    expect(isSecureX402RetryTarget('http://10.0.0.5/paid')).toBe(false)
  })

  it('allows http only where it cannot leave the machine or the test bench', () => {
    expect(isSecureX402RetryTarget('http://localhost:4020/mcp')).toBe(true)
    expect(isSecureX402RetryTarget('http://127.0.0.1:4020/mcp')).toBe(true)
    expect(isSecureX402RetryTarget('http://[::1]:4020/mcp')).toBe(true)
    expect(isSecureX402RetryTarget('http://merchant.test/paid')).toBe(true)
    expect(isSecureX402RetryTarget('http://merchant.example/paid')).toBe(true)
    expect(isSecureX402RetryTarget('http://api.localhost/x')).toBe(true)
  })

  it('refuses anything that is not http(s) or not a URL', () => {
    expect(isSecureX402RetryTarget('ftp://merchant.com/x')).toBe(false)
    expect(isSecureX402RetryTarget('not a url')).toBe(false)
  })
})

describe('assertSecureX402RetryTarget', () => {
  it('throws the typed error with the code and the offending URL', () => {
    expect(() => assertSecureX402RetryTarget('https://merchant.com/paid')).not.toThrow()
    let caught: unknown
    try {
      assertSecureX402RetryTarget('http://merchant.com/paid')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(HavenInsecureRetryTargetError)
    const e = caught as HavenInsecureRetryTargetError
    expect(e.code).toBe(INSECURE_RETRY_TARGET_CODE)
    expect(e.statusCode).toBe(400)
    expect(e.url).toBe('http://merchant.com/paid')
    expect(e.message).toContain('https')
  })
})

describe('MerchantTransport.deliverPayment — the one seam every paid retry crosses', () => {
  it('never sends a payment header to a public http target', async () => {
    const calls: string[] = []
    const transport = new McpMerchantTransport({
      fetch: async (url: string | URL | Request) => {
        calls.push(String(url))
        return new Response('{}', { status: 200 })
      },
    })
    await expect(
      transport.deliverPayment('http://merchant.com/paid', undefined, 'signed-header'),
    ).rejects.toBeInstanceOf(HavenInsecureRetryTargetError)
    expect(calls).toEqual([])
  })

  it('still delivers to https and to a reserved test host', async () => {
    const calls: string[] = []
    const transport = new McpMerchantTransport({
      fetch: async (url: string | URL | Request) => {
        calls.push(String(url))
        return new Response('{}', { status: 200 })
      },
    })
    await transport.deliverPayment('https://merchant.com/paid', undefined, 'signed-header')
    await transport.deliverPayment('http://merchant.test/paid', undefined, 'signed-header')
    expect(calls).toEqual(['https://merchant.com/paid', 'http://merchant.test/paid'])
  })
})
