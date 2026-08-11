import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverMerchantMcpUrl, sameUrl, MERCHANT_DISCOVERY_PATHS, DISCOVERY_MAX_BYTES } from './merchant-discovery.js'

// #1301: the moved-to-SDK counterpart of the #1271 discovery helper's own
// unit coverage. The end-to-end contract (#1271's five ported cases) lives
// in packages/mcp-server/src/tools.test.ts (unmodified) and
// packages/mcp/src/tools.test.ts (ported #1301); these tests pin the
// standalone helper's byte-identical bounds directly.

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('discoverMerchantMcpUrl (#1271/#1301)', () => {
  it('fetches only the two fixed same-origin paths, in order', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url)
      return new Response(JSON.stringify({}), { status: 404 })
    })

    const result = await discoverMerchantMcpUrl('http://merchant.test/')

    expect(result).toBeNull()
    expect(requested).toEqual([
      `http://merchant.test${MERCHANT_DISCOVERY_PATHS[0]}`,
      `http://merchant.test${MERCHANT_DISCOVERY_PATHS[1]}`,
    ])
  })

  it('accepts a same-origin mcp_url', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ mcp_url: 'http://merchant.test/mcp' }), { status: 200 }),
    )

    const result = await discoverMerchantMcpUrl('http://merchant.test/')
    expect(result).toBe('http://merchant.test/mcp')
  })

  it('REFUSES an off-origin mcp_url without ever fetching it (SSRF bound)', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url)
      return new Response(JSON.stringify({ mcp_url: 'http://evil.example/mcp' }), { status: 200 })
    })

    const result = await discoverMerchantMcpUrl('http://merchant.test/')

    expect(result).toBeNull()
    expect(requested.some((u) => u.includes('evil.example'))).toBe(false)
    // Both fixed paths were still tried — off-origin rejection doesn't short-circuit the scan.
    expect(requested).toHaveLength(2)
  })

  it('rejects a document over the size cap via Content-Length before reading the body', async () => {
    let textCalls = 0
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ mcp_url: 'http://merchant.test/mcp' }), {
        status: 200,
        headers: { 'content-length': String(DISCOVERY_MAX_BYTES + 1) },
      }),
    )
    // Wrap to observe whether .text() would even be reached — spy on Response.prototype.text
    const originalText = Response.prototype.text
    Response.prototype.text = async function (this: Response) {
      textCalls++
      return originalText.call(this)
    }
    try {
      const result = await discoverMerchantMcpUrl('http://merchant.test/')
      expect(result).toBeNull()
      expect(textCalls).toBe(0)
    } finally {
      Response.prototype.text = originalText
    }
  })

  it('rejects a document over the size cap by body length when Content-Length is absent', async () => {
    const oversized = 'x'.repeat(DISCOVERY_MAX_BYTES + 1)
    vi.stubGlobal('fetch', async () => new Response(oversized, { status: 200 }))

    const result = await discoverMerchantMcpUrl('http://merchant.test/')
    expect(result).toBeNull()
  })

  it('an unparseable (non-JSON) document never matches', async () => {
    vi.stubGlobal('fetch', async () => new Response('not json at all', { status: 200 }))

    const result = await discoverMerchantMcpUrl('http://merchant.test/')
    expect(result).toBeNull()
  })

  it('a document missing mcp_url never matches', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ name: 'Some Merchant' }), { status: 200 }))

    const result = await discoverMerchantMcpUrl('http://merchant.test/')
    expect(result).toBeNull()
  })

  it('an unparseable input URL returns null without fetching', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await discoverMerchantMcpUrl('not-a-url')
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('passes redirect: error and a bounded timeout signal on every request', async () => {
    const inits: RequestInit[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      inits.push(init)
      return new Response(JSON.stringify({}), { status: 404 })
    })

    await discoverMerchantMcpUrl('http://merchant.test/')

    expect(inits).toHaveLength(2)
    for (const init of inits) {
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
  })

  it('a network error on one path falls through to the next, not a thrown error', async () => {
    let call = 0
    vi.stubGlobal('fetch', async (url: string) => {
      call++
      if (call === 1) throw new Error('network down')
      return new Response(JSON.stringify({ mcp_url: 'http://merchant.test/mcp' }), { status: 200 })
    })

    const result = await discoverMerchantMcpUrl('http://merchant.test/')
    expect(result).toBe('http://merchant.test/mcp')
  })
})

describe('sameUrl (#1271/#1301)', () => {
  it('trailing-slash echoes compare equal', () => {
    expect(sameUrl('http://merchant.test', 'http://merchant.test/')).toBe(true)
    expect(sameUrl('http://merchant.test/mcp/', 'http://merchant.test/mcp')).toBe(true)
  })

  it('different paths compare unequal', () => {
    expect(sameUrl('http://merchant.test/', 'http://merchant.test/mcp')).toBe(false)
  })

  it('different origins compare unequal', () => {
    expect(sameUrl('http://merchant.test/mcp', 'http://evil.example/mcp')).toBe(false)
  })

  it('unparseable URLs never compare equal, even to each other', () => {
    expect(sameUrl('not-a-url', 'not-a-url')).toBe(false)
    expect(sameUrl('not-a-url', 'http://merchant.test/')).toBe(false)
  })
})
