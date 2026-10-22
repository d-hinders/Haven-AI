/**
 * #4257: redirects on the NO-POLICY transport path (the SDK default, the local
 * MCP, connect and every embedder that sets no `merchantEgress`), exercised
 * end to end against two real loopback servers. Two ports on 127.0.0.1 are
 * two origins, which is exactly the boundary under test. The mock-fetch
 * cases for the same rules live in `merchant-egress.test.ts`.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { McpMerchantTransport } from './mcp-merchant-transport.js'

interface Seen {
  origin: 'a' | 'b'
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  body: string
}

const seen: Seen[] = []
const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>()
let servers: http.Server[] = []
let A = ''
let B = ''

function listen(origin: 'a' | 'b'): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        seen.push({ origin, method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
        const route = routes.get(`${origin} ${req.url}`)
        if (route) return route(req, res)
        res.end(`${origin}-final`)
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
}

function redirect(status: number, location: string) {
  return (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(status, { location })
    res.end()
  }
}

const CALLER_HEADERS = {
  Authorization: 'Bearer merchant-a-token',
  Cookie: 'session=a',
  'X-Api-Key': 'merchant-a-key',
  Accept: 'application/json',
  'User-Agent': 'haven-test',
  'x402-wallet': '0x0000000000000000000000000000000000000001',
}

const transport = () => new McpMerchantTransport({ merchantTimeout: 10_000 })
const at = (origin: 'a' | 'b') => seen.filter((s) => s.origin === origin)

beforeAll(async () => {
  A = await listen('a')
  B = await listen('b')
})

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))
  servers = []
})

beforeEach(() => {
  seen.length = 0
  routes.clear()
})

describe('no-policy transport — redirect characterization (#4257)', () => {
  it('a same-origin GET redirect carries every caller header', async () => {
    routes.set('a /start', redirect(302, '/next'))
    const response = await transport().fetch(`${A}/start`, { headers: CALLER_HEADERS })
    expect(await response.text()).toBe('a-final')
    expect(seen.map((s) => s.path)).toEqual(['/start', '/next'])
    expect(seen[1].headers).toMatchObject({
      authorization: 'Bearer merchant-a-token',
      cookie: 'session=a',
      'x-api-key': 'merchant-a-key',
    })
  })

  it('a same-origin 307 re-sends the POST with its body and headers', async () => {
    routes.set('a /start', redirect(307, '/next'))
    await transport().fetch(`${A}/start`, {
      method: 'POST',
      headers: { ...CALLER_HEADERS, 'Content-Type': 'application/json' },
      body: '{"x":1}',
    })
    expect(seen[1]).toMatchObject({ method: 'POST', path: '/next', body: '{"x":1}' })
    expect(seen[1].headers).toMatchObject({ 'x-api-key': 'merchant-a-key', 'content-type': 'application/json' })
  })

  it('a same-origin 303 turns the POST into a GET with no body and no body headers', async () => {
    routes.set('a /start', redirect(303, '/next'))
    await transport().fetch(`${A}/start`, {
      method: 'POST',
      headers: { ...CALLER_HEADERS, 'Content-Type': 'application/json' },
      body: '{"x":1}',
    })
    expect(seen[1]).toMatchObject({ method: 'GET', path: '/next', body: '' })
    expect(seen[1].headers['content-type']).toBeUndefined()
    expect(seen[1].headers['x-api-key']).toBe('merchant-a-key')
  })

  it("a caller's redirect: 'manual' still gets the 3xx back unfollowed", async () => {
    routes.set('a /start', redirect(302, `${B}/next`))
    const response = await transport().fetch(`${A}/start`, { redirect: 'manual', headers: CALLER_HEADERS })
    expect(response.status).toBe(302)
    expect(at('b')).toHaveLength(0)
  })

  it("a caller's redirect: 'error' still rejects on the 3xx", async () => {
    routes.set('a /start', redirect(302, `${B}/next`))
    await expect(transport().fetch(`${A}/start`, { redirect: 'error' })).rejects.toThrow()
    expect(at('b')).toHaveLength(0)
  })

  it('a redirect with no Location is the answer, returned as-is', async () => {
    routes.set('a /start', (_req, res) => {
      res.writeHead(302)
      res.end()
    })
    const response = await transport().fetch(`${A}/start`)
    expect(response.status).toBe(302)
  })

  it('follows 20 redirects and refuses the 21st, as the platform does', async () => {
    for (let i = 0; i < 21; i += 1) routes.set(`a /h${i}`, redirect(302, `/h${i + 1}`))
    await expect(transport().fetch(`${A}/h1`)).resolves.toMatchObject({ status: 200 })
    await expect(transport().fetch(`${A}/h0`)).rejects.toThrow()
  })
})

describe('no-policy transport — a cross-origin hop keeps credentials at their origin (#4257)', () => {
  it('a cross-origin GET hop carries only the allow-listed headers', async () => {
    routes.set('a /start', redirect(302, `${B}/next`))
    const response = await transport().fetch(`${A}/start`, { headers: CALLER_HEADERS })
    expect(await response.text()).toBe('b-final')
    expect(at('a')[0].headers['x-api-key']).toBe('merchant-a-key')
    const sent = at('b')[0].headers
    expect(sent['x-api-key']).toBeUndefined()
    expect(sent.authorization).toBeUndefined()
    expect(sent.cookie).toBeUndefined()
    expect(sent).toMatchObject({
      accept: 'application/json',
      'user-agent': 'haven-test',
      'x402-wallet': '0x0000000000000000000000000000000000000001',
    })
  })

  it('a paid GET never delivers its payment headers to a cross-origin redirect target', async () => {
    routes.set('a /paid', redirect(302, `${B}/elsewhere`))
    await transport().deliverPayment(`${A}/paid`, { headers: { 'X-Api-Key': 'merchant-a-key' } }, 'signed-for-a')
    const sent = at('b')[0].headers
    expect(sent['payment-signature']).toBeUndefined()
    expect(sent['x-payment']).toBeUndefined()
    expect(sent['x-api-key']).toBeUndefined()
  })

  it('a 303 that crosses origin follows as a GET with the headers reduced', async () => {
    routes.set('a /start', redirect(303, `${B}/next`))
    await transport().fetch(`${A}/start`, { method: 'POST', headers: CALLER_HEADERS, body: '{"x":1}' })
    expect(at('b')[0]).toMatchObject({ method: 'GET', body: '' })
    expect(at('b')[0].headers['x-api-key']).toBeUndefined()
  })

  it('a 307 that would re-send the body to another origin is refused before connecting there', async () => {
    routes.set('a /start', redirect(307, `${B}/next`))
    await expect(
      transport().fetch(`${A}/start`, { method: 'POST', headers: CALLER_HEADERS, body: '{"payment":"signed-for-a"}' }),
    ).rejects.toMatchObject({ refusal: 'redirect_cross_origin_body', beforeRequest: false })
    expect(at('a')).toHaveLength(1)
    expect(at('b')).toHaveLength(0)
  })

  it('once stripped, a later hop back to the first origin does not regain them', async () => {
    routes.set('a /start', redirect(302, `${B}/x`))
    routes.set('b /x', redirect(302, `${A}/back`))
    await transport().fetch(`${A}/start`, { headers: CALLER_HEADERS })
    const back = at('a').find((s) => s.path === '/back')
    expect(back?.headers['x-api-key']).toBeUndefined()
    expect(back?.headers.authorization).toBeUndefined()
  })
})
