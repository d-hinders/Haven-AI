/**
 * The #3371 key scrub on the failover transport, driven against real local
 * HTTP stub nodes (the `rpc-transport.test.ts` harness — a mocked viem would
 * only restate the author's assumption about where viem puts the URL).
 *
 * Provider endpoint URLs carry API keys in the path or query: dRPC ships
 * `/base-sepolia/<key>` and `?dkey=<key>`, Infura `/v3/<key>`, Alchemy
 * `/v2/<key>`, QuickNode `/<key>/`. viem's request errors echo that URL in
 * `message`/`metaMessages` (its own `getUrl` strips only `user:password`) and
 * in a raw enumerable `url` own property. The transport `rpcTransport` returns
 * wraps viem's `request` and scrubs every configured endpoint's key-like
 * segments out of the error IN PLACE — class identity preserved, because viem's
 * retry logic branches on `instanceof HttpRequestError` and code, and the
 * money-path rule is that a 401 stays one attempt and an `eth_call` revert
 * stays terminal.
 *
 * Mutation check: deleting the scrub wrap (or the `scrubTransportErrorSecrets`
 * call inside it) turns every test in `the key never appears` red — the stub
 * URLs here deliberately carry the secrets on every leg, including the public
 * one, so the surfaced error always has a keyed URL to leak.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BaseError,
  createPublicClient,
  encodeErrorResult,
  erc20Abi,
  HttpRequestError,
  type Address,
  type Hex,
} from 'viem'
import { baseSepolia } from 'viem/chains'

/** A dRPC-style path key and a query key, both ≥12 chars like real vendors'. */
const SECRET_PATH = 'drpc_path_key_9f8e7d6c'
const SECRET_QUERY = 'dkey_query_secret_5a5b5c'
const SECRETS = [SECRET_PATH, SECRET_QUERY]

const endpoints = vi.hoisted(() => ({
  dedicated: '',
  fallback: '',
  sepoliaFallback: '',
  publicSepolia: '',
}))

vi.mock('../../../domain/chains.js', () => ({
  getChain: () => ({ rpcUrl: endpoints.dedicated }),
}))
vi.mock('../../../config.js', () => ({
  PUBLIC_RPC_BASE: 'https://mainnet.base.org',
  // Getters, so the legs can be local stub nodes: no test here may reach the
  // real internet.
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

// The x402 502 criterion runs the REAL `computeHybridAccountAddress`, so its
// collaborators that reach the database or pinned mainnet config are mocked at
// their module seams — the client construction and the RPC round-trip stay real.
vi.mock('../../../platform/leader-lock.js', () => ({
  runIfLeader: async (fn: () => Promise<unknown>) => fn(),
  withKeyedAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('../../../rails/delegation-contracts.js', () => ({
  DELEGATION_RAIL_CHAIN_IDS: new Set([8453, 84532]),
  getDelegationContracts: () => ({
    chainId: 84532,
    accountFactory: '0x00000000000000000000000000000000000000f1',
    eip7702StatelessDeleGator: '0x00000000000000000000000000000000000000f2',
    delegate: '0x00000000000000000000000000000000000000f3',
    erc20PeriodTransferEnforcer: '0x00000000000000000000000000000000000000f4',
    usdc: '0x00000000000000000000000000000000000000f5',
    gaslessSponsorshipPaymaster: '0x00000000000000000000000000000000000000f6',
    entryPoint: '0x00000000000000000000000000000000000000f7',
    supportedEntryPoints: ['0x00000000000000000000000000000000000000f7'],
  }),
  chainForId: () => baseSepolia,
}))

const { rpcTransport, scrubTransportErrorSecrets, secretSegments, havenShouldThrow } = await import(
  '../rpc-transport.js'
)

type Mode = 'ok' | 'http500' | 'http401' | 'http408' | 'rpcError' | 'revert' | 'hang'

interface StubNode {
  url: string
  mode: Mode
  calls: string[]
  server: Server
}

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN = '0x00000000000000000000000000000000000000bb' as Address
const BALANCE_WORD = '0x' + (1234n).toString(16).padStart(64, '0')
const REVERT_REASON = 'ERC20: insufficient balance'
/** `Error(string)` selector 0x08c379a0 + the ABI-encoded reason. */
const REVERT_DATA = encodeErrorResult({
  abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }] as const,
  errorName: 'Error',
  args: [REVERT_REASON],
}) as Hex

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
          return // never answers; the transport timeout surfaces a TimeoutError
        case 'http500':
          return json({ error: 'upstream exploded' }, 500)
        case 'http401':
          return json({ error: 'invalid provider key' }, 401)
        case 'http408':
          return json({ error: 'request timeout' }, 408)
        case 'rpcError':
          // A provider refusal that arrives as a JSON-RPC error in a 200 body.
          return json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'provider refused' } })
        case 'revert':
          return json({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: REVERT_DATA } })
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
  // Every leg carries a key — the dedicated one in the dRPC path shape, the
  // configured fallback as `?dkey=`, and even the public one in its path. An
  // error surfacing from ANY leg has a keyed URL to leak, which is what makes
  // the scrub's "derive from every leg, including the public one" testable.
  endpoints.dedicated = `${primary.url}/base-sepolia/${SECRET_PATH}`
  endpoints.sepoliaFallback = `${secondary.url}/base?dkey=${SECRET_QUERY}`
  endpoints.fallback = ''
  endpoints.publicSepolia = `${publicNode.url}/v3/${SECRET_PATH}`
})

/** Client over the helper, all legs keyed local stubs. */
function clientFor(
  opts?: { timeout?: number; retryCount?: number; retryDelay?: number; dedicatedOnly?: boolean },
) {
  const { retryDelay, dedicatedOnly, ...transportOpts } = opts ?? {}
  return createPublicClient({
    chain: baseSepolia,
    transport: rpcTransport(84532, { ...transportOpts, ...(dedicatedOnly ? { dedicatedOnly } : {}) }),
    ...(retryDelay === undefined ? {} : { retryDelay }),
  })
}

// ── the leak scanner ──────────────────────────────────────────────────────────

/** Walks the `.cause` chain, loop-safe. */
function errorTree(err: unknown): unknown[] {
  const out: unknown[] = []
  const seen = new Set<unknown>()
  let cur: unknown = err
  while (cur !== null && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    out.push(cur)
    cur = (cur as { cause?: unknown }).cause
  }
  return out
}

/** Fails when a secret appears in the value or anywhere inside it. */
function assertNoSecret(value: unknown, where: string): void {
  if (typeof value === 'string') {
    for (const secret of SECRETS) {
      expect(value.includes(secret), `${where} contains ${secret}: ${value.slice(0, 200)}`).toBe(
        false,
      )
    }
    return
  }
  if (value === null || typeof value !== 'object') return // bigint/number/boolean carry no URL
  for (const [key, member] of Object.entries(value)) assertNoSecret(member, `${where}.${key}`)
}

/**
 * The #3371 acceptance scan: `JSON.stringify(err)`, and the value of EVERY
 * own property (enumerable or not, `stack` included) of every object down the
 * `.cause` chain.
 */
function expectNoSecretAnywhere(err: unknown): void {
  expect(typeof err).toBe('object')
  const tree = errorTree(err)
  expect(tree.length).toBeGreaterThan(0)
  for (const node of tree) {
    for (const key of Object.getOwnPropertyNames(node)) {
      assertNoSecret((node as Record<string, unknown>)[key], key)
    }
    const serialize = (value: unknown): string =>
      JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    assertNoSecret(serialize(node), 'JSON.stringify')
  }
  const serialize = (value: unknown): string =>
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  assertNoSecret(serialize(tree.map((n) => serialize(n))), 'serialized tree')
}

// ── the key never appears (#3371) ─────────────────────────────────────────────

describe('the key never appears in a surfaced transport error (#3371)', () => {
  // dedicatedOnly: ONE keyed leg, so the surfaced error is that leg's own —
  // the exact error text that reaches logs, `agent_passports.last_error` and
  // the `/x402/authorize` 502 `details` through `err.message` — and so a
  // healthy secondary cannot answer around the failing one.
  for (const [label, mode] of [
    ['an HTTP 500', 'http500'],
    ['a JSON-RPC error in a 200 body', 'rpcError'],
  ] as const) {
    it(`${label} from a keyed endpoint leaves no trace of the key`, async () => {
      primary.mode = mode
      const client = clientFor({ retryCount: 0, dedicatedOnly: true })
      const err = await client.getCode({ address: ACCOUNT }).then(
        () => null,
        (e) => e,
      )
      expect(err).toBeInstanceOf(Error)
      expectNoSecretAnywhere(err)
      // The stub really was the keyed URL's failure, not a silent success.
      expect(primary.calls).toEqual(['eth_getCode'])
    })
  }

  it('a timeout on a keyed endpoint leaves no trace of the key', async () => {
    primary.mode = 'hang'
    const client = clientFor({ timeout: 150, retryCount: 0, dedicatedOnly: true })
    const err = await client.getCode({ address: ACCOUNT }).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expectNoSecretAnywhere(err)
    expect(primary.calls).toEqual(['eth_getCode'])
  })

  it('an error surfaced from the PUBLIC leg (all legs failing) leaves no trace of the key', async () => {
    // fallback() rethrows the LAST leg's error; with every leg failing and the
    // public URL itself keyed (`/v3/<key>`), the surfaced error still carried
    // a key before the scrub — the "every leg, including the public one" case.
    for (const n of [primary, secondary, publicNode]) n.mode = 'http500'
    const client = clientFor({ retryCount: 0 })
    const err = await client.getCode({ address: ACCOUNT }).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expectNoSecretAnywhere(err)
  })

  it('the error stays classified: HttpRequestError keeps its status, the revert keeps its code', async () => {
    // The scrub must be an in-place mutation, never a rebuild: viem's retry
    // logic branches on `instanceof HttpRequestError` and on `code`.
    primary.mode = 'http500'
    const client = clientFor({ retryCount: 0, dedicatedOnly: true })
    const err = await client.getCode({ address: ACCOUNT }).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(HttpRequestError)
    expect((err as HttpRequestError).status).toBe(500)
    expectNoSecretAnywhere(err)

    primary.mode = 'rpcError'
    const rpcErr = await client.getCode({ address: ACCOUNT }).then(
      () => null,
      (e) => e,
    )
    expect(rpcErr).toBeInstanceOf(BaseError)
    expectNoSecretAnywhere(rpcErr)
  })

  it('a real computeHybridAccountAddress over a keyed transport answers the redacted 502 details shape', async () => {
    // The `/x402/authorize` 502 boundary (delegation-authorize.ts builds
    // `details` as `redactVendorSecrets(err.message)`): the provisioning path
    // rides the SAME `rpcTransport` this module returns. Two halves:
    //
    // 1. The derivation itself is LOCAL — `toMetaMaskSmartAccount` needs no
    //    RPC with a watch-only owner — so a failing chain answers the same
    //    address, and the 502's details carry no key because the handler never
    //    sees an RPC error at all on this leg. Pinned, not assumed: all three
    //    keyed legs are failing while it answers.
    // 2. The error TEXT the 502 would carry comes from the same client
    //    construction (createPublicClient over rpcTransport(84532)) that the
    //    provisioning path builds — exercised against the failing keyed legs
    //    and scanned for the secrets. The fixed `redactVendorSecrets` patterns
    //    deliberately miss the dRPC/Infura shapes; the transport scrub is what
    //    removes the key.
    const { computeHybridAccountAddress } = await import('../../../rails/hybrid-provisioning.js')
    const { redactVendorSecrets } = await import('../../../rails/execution-rail.js')
    for (const n of [primary, secondary, publicNode]) n.mode = 'http500'
    const addr = await computeHybridAccountAddress(84532, { ownerAddress: ACCOUNT })
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/)

    const client = createPublicClient({
      chain: baseSepolia,
      transport: rpcTransport(84532),
    })
    const err = await client.getCode({ address: ACCOUNT }).then(
      () => null,
      (e) => e as Error,
    )
    expect(err).toBeInstanceOf(Error)
    // The 502 body's `details`, exactly as the handler builds it.
    const details = redactVendorSecrets(err instanceof Error ? err.message : String(err))
    expectNoSecretAnywhere(err)
    assertNoSecret(details, '502 details')
    expect(details).toContain('HTTP request failed.')
  })
})

// ── retry behaviour is pinned (with the default retryCount) ──────────────────

describe('retry behaviour survives the scrub (default retryCount)', () => {
  it('an HTTP 401 is requested once per leg — never retried', async () => {
    for (const n of [primary, secondary, publicNode]) n.mode = 'http401'
    const client = clientFor({ retryDelay: 1 })
    await expect(client.getCode({ address: ACCOUNT })).rejects.toThrow()
    // With classification intact, 401 is terminal: one client-level attempt,
    // walked across the three legs by the fallback. A rebuild would turn the
    // error into a retryable UnknownRpcError — 4 passes × 3 legs.
    expect(primary.calls).toEqual(['eth_getCode'])
    expect(secondary.calls).toEqual(['eth_getCode'])
    expect(publicNode.calls).toEqual(['eth_getCode'])
  })

  it('an eth_call revert is requested once, terminal, and still decodes its reason', async () => {
    primary.mode = 'revert'
    const client = clientFor({ retryDelay: 1 })
    // erc20Abi alone has no revertable shapes, so a revert would decode to a
    // generic message; adding the canonical `Error(string)` selector is what
    // lets viem decode the provider's revert data back to the reason.
    const err = await client
      .readContract({
        address: TOKEN,
        abi: [...erc20Abi, { type: 'error', name: 'Error', inputs: [{ type: 'string' }] }] as const,
        functionName: 'balanceOf',
        args: [ACCOUNT],
      })
      .then(
        () => null,
        (e) => e as Error,
      )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain(REVERT_REASON)
    expect(primary.calls).toEqual(['eth_call'])
    expect(secondary.calls).toEqual([])
    // Terminality is decided at the TRANSPORT layer, on viem's raw error
    // (RpcRequestError, code 3) — the same instance the scrub mutated — before
    // readContract wraps it for the caller. Pin `havenShouldThrow` on a real
    // shaped error, and pin the caller-visible fact separately: the fallback
    // never moved (above) and the client never retried (one call total).
    const transportErr = Object.assign(new Error('execution reverted: ' + REVERT_REASON), {
      code: 3,
    })
    expect(havenShouldThrow(transportErr)).toBe(true)
    expect(havenShouldThrow(err as Error)).toBe(false) // the action-level wrapper is not the transport's
  })

  it('a 408 is still retried by the client', async () => {
    primary.mode = 'http408'
    const client = clientFor({ dedicatedOnly: true, retryDelay: 1 })
    await expect(client.getCode({ address: ACCOUNT })).rejects.toThrow()
    expect(primary.calls).toEqual(['eth_getCode', 'eth_getCode', 'eth_getCode', 'eth_getCode'])
  })

  it('a 5xx is still retried by the client', async () => {
    primary.mode = 'http500'
    const client = clientFor({ dedicatedOnly: true, retryDelay: 1 })
    await expect(client.getCode({ address: ACCOUNT })).rejects.toThrow()
    expect(primary.calls).toEqual(['eth_getCode', 'eth_getCode', 'eth_getCode', 'eth_getCode'])
  })
})

// ── the helper itself ────────────────────────────────────────────────────────

describe('secretSegments — the vendor URL shapes (#3371)', () => {
  it.each([
    ['dRPC path', `https://rpc.drpc.example/base-sepolia/${SECRET_PATH}`, SECRET_PATH],
    ['dRPC query', `https://rpc.drpc.example/base?dkey=${SECRET_QUERY}`, SECRET_QUERY],
    ['Infura path', `https://mainnet.infura.io/v3/${SECRET_PATH}`, SECRET_PATH],
    ['Alchemy path', `https://base-mainnet.g.alchemy.com/v2/${SECRET_PATH}`, SECRET_PATH],
    ['QuickNode path', `https://api.example.quiknode.pro/${SECRET_PATH}/`, SECRET_PATH],
    ['URL fragment', `https://rpc.example/base#${SECRET_QUERY}`, SECRET_QUERY],
  ])('%s segment is derived from the configured URL', (_label, url, secret) => {
    expect(secretSegments(url)).toContain(secret)
  })

  it('keeps short and credential-shaped parts out of the secret list', () => {
    // `https:` and the `user:pass` basic-auth segment both carry a `:` and
    // `base` is under 12 chars — none is ever mistaken for a key. Path and
    // query segments are what real vendors use.
    expect(secretSegments('https://user:pass@host/base')).toEqual([])
  })
})

describe('scrubTransportErrorSecrets — in-place, chain-deep (#3371)', () => {
  it('mutates the viem error instance in place and preserves class identity', () => {
    const url = `https://rpc.drpc.example/base-sepolia/${SECRET_PATH}`
    const err = new HttpRequestError({
      status: 500,
      url,
      body: { method: 'eth_getCode' },
      details: `upstream exploded for ${SECRET_PATH}`,
      headers: new Headers(),
    })
    const before = err
    const returned = scrubTransportErrorSecrets(err, [url])
    expect(returned).toBe(before)
    expect(err).toBeInstanceOf(HttpRequestError)
    expect(err.status).toBe(500)
    expect(err.url).not.toContain(SECRET_PATH)
    expect(err.details).not.toContain(SECRET_PATH)
    expect(err.message).not.toContain(SECRET_PATH)
    expect(err.stack).not.toContain(SECRET_PATH)
    for (const meta of err.metaMessages ?? []) expect(meta).not.toContain(SECRET_PATH)
    // Still reads as a keyed-URL failure afterwards, just without the key.
    expect(err.message).toContain('<redacted>')
  })

  it('scrubs nested object/array own properties and walks the .cause chain', () => {
    const urlA = `https://a.example/v3/${SECRET_PATH}`
    const urlB = `https://b.example/base?dkey=${SECRET_QUERY}`
    const leaf = Object.assign(new Error(`leaf says ${SECRET_QUERY}`), {
      url: urlB,
      nested: { body: [`id ${SECRET_PATH}`, { deep: SECRET_QUERY }] },
    })
    const err = Object.assign(new Error(`wrapped: ${SECRET_PATH}`), {
      url: urlA,
      cause: leaf,
      table: { status: 500, tags: [SECRET_PATH, 7n] },
    })
    scrubTransportErrorSecrets(err, [urlA, urlB])
    expectNoSecretAnywhere(err)
    expect(err.message).toContain('<redacted>')
    expect(leaf.message).toContain('<redacted>')
    expect((leaf.nested.body[1] as { deep: string }).deep).toBe('<redacted>')
  })

  it('leaves text untouched when no endpoint carries a key-like segment', () => {
    const err = new Error('plain failure')
    scrubTransportErrorSecrets(err, ['https://sepolia.base.org'])
    expect(err.message).toBe('plain failure')
  })
})
