/**
 * The failover RPC transport (#3255), driven against real local HTTP stub
 * nodes, not a mocked viem: what is under test is how viem's `fallback()` and
 * `http()` treat a quota refusal, a JSON-RPC error inside HTTP 200 and a
 * revert, and a mocked transport would only restate the author's assumption.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicClient, erc20Abi, http, type Address } from 'viem'
import { baseSepolia } from 'viem/chains'

const endpoints = vi.hoisted(() => ({
  dedicated: '',
  fallback: '',
  sepoliaFallback: '',
  publicSepolia: 'https://sepolia.base.org',
}))

vi.mock('../../../domain/chains.js', () => ({
  getChain: () => ({ rpcUrl: endpoints.dedicated }),
}))
vi.mock('../../../config.js', () => ({
  PUBLIC_RPC_BASE: 'https://mainnet.base.org',
  // A getter, so the public leg can be a local stub node: no test here may
  // reach the real internet.
  get PUBLIC_RPC_BASE_SEPOLIA() {
    return endpoints.publicSepolia
  },
  config: {
    get rpcUrlBaseFallback() {
      return endpoints.fallback
    },
    get rpcUrlBaseSepoliaFallback() {
      return endpoints.sepoliaFallback
    },
  },
}))

const { rpcEndpoints, rpcTransport, havenShouldThrow } = await import('../rpc-transport.js')

type Mode = 'ok' | 'http429' | 'rpc429in200' | 'revert' | 'revertCode3Only' | 'hang'

interface StubNode {
  url: string
  mode: Mode
  calls: string[]
  server: Server
}

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN = '0x00000000000000000000000000000000000000bb' as Address
const BALANCE_WORD = '0x' + (1234n).toString(16).padStart(64, '0')

function answer(id: unknown, method: string): unknown {
  if (method === 'eth_chainId') return '0x14a34'
  if (method === 'eth_getCode') return '0x6080'
  if (method === 'eth_call') return BALANCE_WORD
  if (method === 'eth_getTransactionCount') return '0x7'
  return null
}

async function startNode(mode: Mode): Promise<StubNode> {
  const node = { mode, calls: [] as string[] } as StubNode
  node.server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string }
      node.calls.push(method)
      const json = (payload: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      switch (node.mode) {
        case 'hang':
          return // never answers
        case 'http429':
          return json({ error: 'Monthly capacity limit exceeded' }, 429)
        case 'rpc429in200':
          // The exact shape of an exhausted Alchemy quota is unverified, so
          // pin the case where it arrives as a JSON-RPC error with HTTP 200.
          return json({ jsonrpc: '2.0', id, error: { code: 429, message: 'Monthly capacity limit exceeded' } })
        case 'revert':
          return json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } })
        case 'revertCode3Only':
          // A provider that phrases a revert without the standard message.
          return json({ jsonrpc: '2.0', id, error: { code: 3, message: 'VM Exception while processing' } })
        default:
          return json({ jsonrpc: '2.0', id, result: answer(id, method) })
      }
    })
  })
  await new Promise<void>((resolve) => node.server.listen(0, '127.0.0.1', resolve))
  node.url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`
  return node
}

let primary: StubNode
let secondary: StubNode
let publicNode: StubNode

beforeAll(async () => {
  primary = await startNode('ok')
  secondary = await startNode('ok')
  publicNode = await startNode('ok')
})

afterAll(async () => {
  const nodes = [primary, secondary, publicNode]
  for (const n of nodes) n.server.closeAllConnections()
  await Promise.all(nodes.map((n) => new Promise((r) => n.server.close(r))))
})

beforeEach(() => {
  for (const n of [primary, secondary, publicNode]) {
    n.calls = []
    n.mode = 'ok'
  }
  endpoints.dedicated = primary.url
  endpoints.fallback = ''
  endpoints.sepoliaFallback = secondary.url
  endpoints.publicSepolia = publicNode.url
})

/** Client over the helper: dedicated → secondary → public, all local stubs. */
function clientFor(opts?: { timeout?: number; retryCount?: number }) {
  return createPublicClient({ chain: baseSepolia, transport: rpcTransport(84532, opts) })
}

describe('rpcEndpoints — order and de-duplication (#3255)', () => {
  it('orders dedicated, then the configured fallback, then the public node', () => {
    endpoints.publicSepolia = 'https://sepolia.base.org'
    endpoints.dedicated = 'https://dedicated.example'
    endpoints.sepoliaFallback = 'https://second.example'
    expect(rpcEndpoints(84532)).toEqual([
      'https://dedicated.example',
      'https://second.example',
      'https://sepolia.base.org',
    ])
  })

  it('does not list the public node twice when the dedicated variable is unset', () => {
    // config.ts resolves an unset RPC_URL_BASE_SEPOLIA to the public node.
    endpoints.publicSepolia = 'https://sepolia.base.org'
    endpoints.dedicated = 'https://sepolia.base.org'
    endpoints.sepoliaFallback = ''
    expect(rpcEndpoints(84532)).toEqual(['https://sepolia.base.org'])
  })

  it('uses the mainnet public node and fallback for Base', () => {
    endpoints.dedicated = 'https://dedicated.example'
    endpoints.fallback = 'https://second-mainnet.example'
    expect(rpcEndpoints(8453)).toEqual([
      'https://dedicated.example',
      'https://second-mainnet.example',
      'https://mainnet.base.org',
    ])
  })

  it('gives a chain with no public node here just its dedicated endpoint', () => {
    endpoints.dedicated = 'https://rpc.gnosischain.com'
    expect(rpcEndpoints(100)).toEqual(['https://rpc.gnosischain.com'])
  })
})

describe('transport errors fall through to the next endpoint (#3255)', () => {
  for (const mode of ['http429', 'rpc429in200'] as const) {
    it(`${mode}: a contract read, getCode and a nonce read succeed via the next node`, async () => {
      primary.mode = mode
      const client = clientFor()

      const balance = await client.readContract({
        address: TOKEN,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [ACCOUNT],
      })
      expect(balance).toBe(1234n)
      expect(await client.getCode({ address: ACCOUNT })).toBe('0x6080')
      expect(await client.getTransactionCount({ address: ACCOUNT })).toBe(7)

      expect(secondary.calls).toEqual(['eth_call', 'eth_getCode', 'eth_getTransactionCount'])
      expect(publicNode.calls).toEqual([])
      // Characterization of the deliberate behaviour change: inside fallback()
      // each leg runs with retryCount 0, so the quota-dead primary is asked
      // ONCE per request, not four times, before the next node answers.
      expect(primary.calls).toEqual(['eth_call', 'eth_getCode', 'eth_getTransactionCount'])
    })
  }

  it('characterization: a plain same-URL http() transport retried the dead node and never moved', async () => {
    // What every backend client did before #3255: four attempts at one URL.
    primary.mode = 'http429'
    const plain = createPublicClient({
      chain: baseSepolia,
      transport: http(primary.url, { retryDelay: 1 }),
    })
    await expect(plain.getCode({ address: ACCOUNT })).rejects.toThrow()
    expect(primary.calls).toEqual(['eth_getCode', 'eth_getCode', 'eth_getCode', 'eth_getCode'])
    expect(secondary.calls).toEqual([])
  })

  it('a healthy primary answers alone — the fallback is never contacted', async () => {
    const client = clientFor()
    await client.getCode({ address: ACCOUNT })
    expect(primary.calls).toEqual(['eth_getCode'])
    expect(secondary.calls).toEqual([])
  })
})

describe('an eth_call revert is terminal — never asked of the next node (#3255)', () => {
  for (const mode of ['revert', 'revertCode3Only'] as const) {
    it(`${mode}: the first node's revert surfaces and the second node gets no call`, async () => {
      primary.mode = mode
      const client = clientFor({ retryCount: 0 })
      await expect(
        client.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [ACCOUNT] }),
      ).rejects.toThrow()
      expect(primary.calls).toEqual(['eth_call'])
      expect(secondary.calls).toEqual([])
    })
  }

  it('havenShouldThrow wraps viem’s default and adds JSON-RPC code 3', () => {
    const revertMessage = Object.assign(new Error('execution reverted: nope'), { code: -32000 })
    const code3 = Object.assign(new Error('VM Exception while processing'), { code: 3 })
    const quota = Object.assign(new Error('Monthly capacity limit exceeded'), { code: 429 })
    expect(havenShouldThrow(revertMessage)).toBe(true)
    expect(havenShouldThrow(code3)).toBe(true)
    expect(havenShouldThrow(quota)).toBe(false)
    expect(havenShouldThrow(new Error('fetch failed'))).toBe(false)
  })
})

describe('dedicatedOnly — no failover for a read that is not fail-safe (#3255)', () => {
  it('a failing dedicated endpoint fails the read; no other node is asked', async () => {
    primary.mode = 'http429'
    const client = createPublicClient({
      chain: baseSepolia,
      transport: rpcTransport(84532, { dedicatedOnly: true, retryCount: 0 }),
    })
    await expect(client.getCode({ address: ACCOUNT })).rejects.toThrow()
    expect(primary.calls).toEqual(['eth_getCode'])
    expect(secondary.calls).toEqual([])
    expect(publicNode.calls).toEqual([])
  })
})

describe('per-caller timeout and retryCount (#3255)', () => {
  it('a hanging leg times out after the per-leg timeout and the next leg answers', async () => {
    primary.mode = 'hang'
    const client = clientFor({ timeout: 150, retryCount: 0 })
    const started = Date.now()
    expect(await client.getCode({ address: ACCOUNT })).toBe('0x6080')
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(140)
    expect(elapsed).toBeLessThan(1_000)
    expect(secondary.calls).toEqual(['eth_getCode'])
  })

  it('with every leg hanging, retryCount 0 bounds the call at legs × timeout', async () => {
    for (const n of [primary, secondary, publicNode]) n.mode = 'hang'
    const client = clientFor({ timeout: 150, retryCount: 0 })
    const legs = rpcEndpoints(84532).length
    expect(legs).toBe(3)
    const started = Date.now()
    await expect(client.getCode({ address: ACCOUNT })).rejects.toThrow()
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(legs * 150 - 30)
    expect(elapsed).toBeLessThan(legs * 150 + 500)
    // Each leg asked exactly once: no per-leg retries, no whole-chain retry.
    for (const n of [primary, secondary, publicNode]) expect(n.calls).toEqual(['eth_getCode'])
  })

  it('the whole-chain retryCount re-walks the legs when every one fails', async () => {
    for (const n of [primary, secondary, publicNode]) n.mode = 'http429'
    const client = createPublicClient({
      chain: baseSepolia,
      transport: rpcTransport(84532, { retryCount: 1 }),
    })
    await expect(client.getCode({ address: ACCOUNT })).rejects.toThrow()
    for (const n of [primary, secondary, publicNode]) expect(n.calls).toEqual(['eth_getCode', 'eth_getCode'])
  })
})
