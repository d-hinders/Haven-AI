/**
 * The 2026-09-26 incident: an ethers v6 HTTP error from the relayer's
 * PRIMARY provider printed the full RPC URL, provider API key included —
 * `FetchResponse.assertOk()` (ethers `utils/fetch.js`) embeds the request
 * URL in both the thrown error's MESSAGE and its enumerable `info` fields,
 * and `newEthersProvider`'s primary construction had no defence: only the
 * FALLBACK send's failure was rebuilt from safe fields
 * (`fallbackSendError`/`secretSegments`, #3323/#2769), and only at its one
 * call site (`sendRawViaFallback` in `outbound-queue.ts`).
 *
 * This proves the fix lives one layer down, in the provider `relayer.ts`
 * constructs (`ScrubbingJsonRpcProvider`), against a REAL ethers provider
 * talking to a local HTTP server whose URL carries a key — not a hand-built
 * imitation of ethers' error shape — and for BOTH providers `relayer.ts`
 * builds: the primary (`getProvider`, via a mocked `getChain`) and the
 * fallback (`getFallbackBroadcastProvider`, via a mocked `secondaryRpcUrl`,
 * mirroring `outbound-fallback-send.test.ts`). Calling `.send()` directly —
 * not `sendRawViaFallback` — shows the scrub protects every caller of either
 * provider, not only that one wrapper.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const SECRET = 'SECRETKEY0123456789abcdefSECRET'
const CHAIN_ID = 84532

let server: Server
let baseUrl = ''
/** Per-method answer, keyed by JSON-RPC `method`; `eth_chainId` must
 * succeed so ethers' one-time network detection (`staticNetwork: true`,
 * no network pinned on the primary) does not stall the send under test. */
let answer: (method: string, id: unknown) => { status: number; body: string } = (_method, id) => ({
  status: 200,
  body: JSON.stringify({ jsonrpc: '2.0', id, result: `0x${CHAIN_ID.toString(16)}` }),
})

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
      const { status, body: out } = answer(method, id)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(out)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/${SECRET}`
  vi.doMock('../../domain/chains.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../domain/chains.js')>()
    return {
      ...real,
      // Only this suite's CHAIN_ID is ever requested here; a real chain
      // config carries many more fields, but `newEthersProvider` only
      // reads `.rpcUrl`.
      getChain: (chainId: number) =>
        chainId === CHAIN_ID ? ({ rpcUrl: baseUrl } as ReturnType<typeof real.getChain>) : real.getChain(chainId),
    }
  })
  vi.doMock('../chain/rpc-transport.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../chain/rpc-transport.js')>()),
    secondaryRpcUrl: (chainId: number) => (chainId === CHAIN_ID ? baseUrl : ''),
  }))
})

afterAll(async () => {
  vi.doUnmock('../../domain/chains.js')
  vi.doUnmock('../chain/rpc-transport.js')
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

afterEach(() => {
  vi.resetModules()
})

describe('every ethers provider relayer.ts builds scrubs its own URL out of an error (2026-09-26)', () => {
  it('the PRIMARY provider: a non-2xx answer never carries the API key — message, own properties or serialisation', async () => {
    answer = (method, id) => {
      if (method === 'eth_chainId') {
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: `0x${CHAIN_ID.toString(16)}` }) }
      }
      // Mirrors the dRPC 408 timeout body shape from the incident report.
      return { status: 408, body: 'Request Timeout' }
    }
    const { getProvider } = await import('../relayer.js')
    const provider = getProvider(CHAIN_ID)

    const err = (await provider
      .send('eth_getBalance', ['0x0000000000000000000000000000000000000000', 'latest'])
      .then(
        () => {
          throw new Error('expected the primary send to fail')
        },
        (e: unknown) => e as Error & Record<string, unknown>,
      )) as Error & Record<string, unknown>

    expect(err.message).not.toContain(SECRET)
    expect(err.message).not.toContain(baseUrl)
    expect(JSON.stringify(err)).not.toContain(SECRET)
    expect(JSON.stringify(Object.getOwnPropertyNames(err).map((k) => [k, err[k]]))).not.toContain(SECRET)
    expect(err.request).toBeUndefined()
    expect(err.response).toBeUndefined()
    // SERVER_ERROR classification survives the rebuild.
    expect(err.code).toBe('SERVER_ERROR')
  })

  it('the FALLBACK provider: a non-2xx answer never carries the API key, called directly (not through sendRawViaFallback)', async () => {
    answer = () => ({ status: 503, body: 'Service Unavailable' })
    const { getFallbackBroadcastProvider } = await import('../relayer.js')
    const provider = getFallbackBroadcastProvider(CHAIN_ID)
    expect(provider).not.toBeNull()

    const err = (await provider!.send('eth_sendRawTransaction', ['0x02abcdef']).then(
      () => {
        throw new Error('expected the fallback send to fail')
      },
      (e: unknown) => e as Error & Record<string, unknown>,
    )) as Error & Record<string, unknown>

    expect(err.message).not.toContain(SECRET)
    expect(JSON.stringify(err)).not.toContain(SECRET)
    expect(JSON.stringify(Object.getOwnPropertyNames(err).map((k) => [k, err[k]]))).not.toContain(SECRET)
    expect(err.request).toBeUndefined()
    expect(err.response).toBeUndefined()
    expect(err.code).toBe('SERVER_ERROR')
  })

  it('a JSON-RPC error body surviving the rebuild keeps its message for classification (e.g. isPendingTagRefusal)', async () => {
    // A JSON-RPC-level refusal (HTTP 200, error in the body) never reaches
    // `_send`'s throw path at all — ethers classifies it later, from the
    // body alone — so this is unaffected by the scrub either way. Proven
    // here so a future change to the override cannot silently start
    // swallowing or mangling it.
    answer = (method, id) => {
      if (method === 'eth_chainId') {
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: `0x${CHAIN_ID.toString(16)}` }) }
      }
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'nonce too low' } }) }
    }
    const { getProvider } = await import('../relayer.js')
    const provider = getProvider(CHAIN_ID)

    const err = (await provider
      .send('eth_sendRawTransaction', ['0x02abcdef'])
      .catch((e: unknown) => e)) as Error & { code?: unknown }

    expect(err.code).toBe('NONCE_EXPIRED')
    expect(err.message).toContain('nonce too low')
  })
})
