/**
 * The relayer's broadcast fallback, over a REAL ethers provider against a
 * local HTTP server (#2769). The fallback URL carries a provider API key, and
 * ethers embeds the request URL in a non-2xx error's message and in its
 * enumerable `info` / `request` fields — so this is proven against ethers'
 * actual error objects, not a hand-built imitation of them.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const SECRET = 'SECRETKEY0123456789abcdefSECRET'
const CHAIN_ID = 84532

let server: Server
let baseUrl = ''
let answer: (method: string, id: unknown) => { status: number; body: string } = () => ({
  status: 503,
  body: 'unavailable',
})
const methods: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      let method = '?'
      let id: unknown = null
      try {
        const parsed = JSON.parse(body) as { method?: string; id?: unknown }
        method = parsed.method ?? '?'
        id = parsed.id ?? null
      } catch {
        // not JSON — leave '?'
      }
      methods.push(method)
      const { status, body: out } = answer(method, id)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(out)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/${SECRET}`
  vi.doMock('../chain/rpc-transport.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../chain/rpc-transport.js')>()),
    secondaryRpcUrl: (chainId: number) => (chainId === CHAIN_ID ? baseUrl : ''),
  }))
})

afterEach(() => {
  methods.length = 0
})

afterAll(async () => {
  vi.doUnmock('../chain/rpc-transport.js')
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('sendRawViaFallback (#2769)', () => {
  it('a non-2xx fallback answer never carries the API key — message, fields or serialisation', async () => {
    answer = () => ({ status: 503, body: 'Service Unavailable' })
    const { sendRawViaFallback } = await import('../outbound-queue.js')

    const err = await sendRawViaFallback(CHAIN_ID, '0x02abcdef').then(
      () => {
        throw new Error('expected the fallback send to fail')
      },
      (e: unknown) => e as Error & Record<string, unknown>,
    )

    expect(err.message).toMatch(/fallback broadcast failed/)
    expect(err.message).not.toContain(SECRET)
    expect(JSON.stringify(err)).not.toContain(SECRET)
    expect(JSON.stringify(Object.getOwnPropertyNames(err).map((k) => [k, err[k]]))).not.toContain(SECRET)
    expect(err.info).toBeUndefined()
    expect(err.request).toBeUndefined()
  })

  it('a JSON-RPC refusal from the fallback keeps its code and message for classification', async () => {
    answer = (_method, id) => ({
      status: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'nonce too low' } }),
    })
    const { sendRawViaFallback } = await import('../outbound-queue.js')

    const err = (await sendRawViaFallback(CHAIN_ID, '0x02abcdef').catch((e: unknown) => e)) as Error & {
      code?: unknown
      error?: { code?: unknown; message?: string }
    }

    // ethers classifies it (NONCE_EXPIRED); both that and the raw body survive.
    expect(err.code).toBe('NONCE_EXPIRED')
    expect(err.message).toContain('nonce too low')
    expect(err.error).toEqual({ code: -32000, message: 'nonce too low' })
    expect(JSON.stringify(err)).not.toContain(SECRET)
  })

  it('an accepted send returns the node-reported hash, over the pinned network (no eth_chainId)', async () => {
    const hash = '0x' + 'ab'.repeat(32)
    answer = (_method, id) => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: hash }) })
    const { sendRawViaFallback } = await import('../outbound-queue.js')

    expect(await sendRawViaFallback(CHAIN_ID, '0x02abcdef')).toBe(hash)
    expect(methods).toEqual(['eth_sendRawTransaction'])
  })

  it('a failing fallback does not start ethers’ network-detection retry loop', async () => {
    answer = () => ({ status: 503, body: 'Service Unavailable' })
    const { sendRawViaFallback } = await import('../outbound-queue.js')

    await sendRawViaFallback(CHAIN_ID, '0x02abcdef').catch(() => undefined)
    // ethers retries detection every 1 s when the network is not pinned.
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    expect(methods.filter((m) => m === 'eth_chainId')).toEqual([])
  })
})
