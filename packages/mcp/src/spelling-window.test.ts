/**
 * The `idempotencyKey` -> `idempotency_key` deprecation window (#2366) is
 * CLOSED (#3411). This file used to prove the window — both spellings
 * accepted, the old one warned on. It now proves the removal: the legacy
 * spelling is refused, not silently dropped.
 *
 * The two Haven MCP surfaces spell the same argument differently: this local
 * package took `idempotencyKey`, the hosted server takes `idempotency_key`.
 * #2348 made the hosted side REFUSE the local spelling rather than strip it
 * silently, because a stripped idempotency key means a retry is a second
 * spend. This package now does the same: `idempotencyKey` stays DECLARED in
 * every schema (so the MCP SDK's default `z.object` strip mode never drops it
 * before the handler runs — the #2348 failure) and is REFUSED by name with
 * `IDEMPOTENCY_KEY_RENAMED`, before anything is contacted or spent.
 *
 * **Over the real client -> InMemoryTransport -> server path, never the handler
 * directly.** The MCP SDK strips keys the schema does not declare BEFORE a
 * handler runs, so a handler-level test cannot tell a declared argument from an
 * undeclared one — it would pass either way. That is #2312's lesson and the
 * reason `server.test.ts`'s `readToolByName(...).handler({})` style is not used
 * here.
 */
import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { HavenClient } from '@haven_ai/sdk'
import { buildMcpServer } from './server.js'
import { createToolHandlers, toolSchemas } from './tools.js'

/** A HavenClient stub that records what each SDK entry point was actually handed. */
function stubHaven() {
  const seen: {
    pay: Array<Record<string, unknown>>
    fetch: Array<{ url: string; opts: Record<string, unknown> | undefined }>
    quoteX402: Array<{ url: string; opts: Record<string, unknown> | undefined }>
  } = { pay: [], fetch: [], quoteX402: [] }
  const okResponse = () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const haven = {
    pay: vi.fn(async (req: Record<string, unknown>) => {
      seen.pay.push(req)
      return { paymentId: 'pay_1', status: 'executed', txHash: '0xabc' }
    }),
    fetch: vi.fn(async (url: string, _init: RequestInit | undefined, opts: Record<string, unknown> | undefined) => {
      seen.fetch.push({ url, opts })
      return okResponse()
    }),
    quoteX402: vi.fn(async (url: string, _init: RequestInit | undefined, opts: Record<string, unknown> | undefined) => {
      seen.quoteX402.push({ url, opts })
      return { paymentRequired: {} }
    }),
    payX402Quote: vi.fn(async (_quote: unknown, opts: Record<string, unknown> | undefined) => {
      seen.pay.push({ ...opts, __via: 'payX402Quote' })
      return okResponse()
    }),
    withRequestContext: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
    // #3303: the dispatch wrapper reads the backend's update hint after every tool.
    clientUpdate: () => undefined,
  } as unknown as HavenClient
  return { haven, seen }
}

async function callTool(haven: HavenClient, name: string, args: Record<string, unknown>) {
  const server = buildMcpServer(haven)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  try {
    return await client.callTool({ name, arguments: args })
  } finally {
    await client.close()
  }
}

const BASE = { asset: 'USDC', recipient: '0xabc', amount: '1' }

describe('idempotency-key spelling removal (#3411, closing the #2366 window)', () => {
  it('accepts the current spelling `idempotency_key` and carries it', async () => {
    const { haven, seen } = stubHaven()
    await callTool(haven, 'haven_send', { ...BASE, idempotency_key: 'snake-1' })
    expect(seen.pay[0]?.idempotencyKey).toBe('snake-1')
  })

  it('REFUSES the legacy `idempotencyKey` — nothing contacted or spent', async () => {
    const { haven, seen } = stubHaven()
    const res = await callTool(haven, 'haven_send', { ...BASE, idempotencyKey: 'camel-1' })
    expect(JSON.stringify(res)).toMatch(/IDEMPOTENCY_KEY_RENAMED/)
    expect(JSON.stringify(res)).toMatch(/idempotency_key/)
    expect(seen.pay).toHaveLength(0)
  })

  it('REFUSES both spellings together, not just conflicting ones', async () => {
    const { haven, seen } = stubHaven()
    const res = await callTool(haven, 'haven_send', {
      ...BASE,
      idempotencyKey: 'camel-1',
      idempotency_key: 'snake-1',
    })
    expect(JSON.stringify(res)).toMatch(/IDEMPOTENCY_KEY_RENAMED/)
    expect(seen.pay).toHaveLength(0)
  })

  it('REFUSES both spellings even when they agree — the legacy name alone is enough', async () => {
    const { haven, seen } = stubHaven()
    const res = await callTool(haven, 'haven_send', { ...BASE, idempotencyKey: 'same', idempotency_key: 'same' })
    expect(JSON.stringify(res)).toMatch(/IDEMPOTENCY_KEY_RENAMED/)
    expect(seen.pay).toHaveLength(0)
  })

  it('sends no key at all when neither is given', async () => {
    const { haven, seen } = stubHaven()
    await callTool(haven, 'haven_send', BASE)
    expect(seen.pay[0]?.idempotencyKey).toBeUndefined()
  })

  it('the refusal message does not repeat the "every other Haven wire contract" claim', async () => {
    // The SDK's published LLM tool schemas and REST /x402/authorize still use
    // idempotencyKey (out of scope here) — the message must not overclaim.
    const { haven } = stubHaven()
    const res = await callTool(haven, 'haven_send', { ...BASE, idempotencyKey: 'camel-1' })
    expect(JSON.stringify(res)).not.toMatch(/every other Haven wire contract/)
  })

  /**
   * Every tool that declares the pair is actually WIRED to the refusal.
   *
   * `haven_send` above proves the mechanism. It does not prove the other four
   * refuse it too — an unwired tool is invisible, because it would keep
   * reading `args.idempotencyKey` directly and the legacy spelling would keep
   * working silently there. Twice already a mutation survived because a
   * per-call-site choice was pinned nowhere; this is that lesson applied
   * before the review finds it.
   *
   * The refusal is the probe, and it is the cheap one: it fires before
   * anything is contacted, so no client stub behaviour is needed beyond
   * asserting nothing was called.
   */
  const WIRED: Array<[string, Record<string, unknown>]> = [
    ['haven_send', { asset: 'USDC', recipient: '0xabc', amount: '1' }],
    ['haven_pay_mcp_tool', { merchant_url: 'https://m.test/mcp', tool_name: 't' }],
    ['haven_quote_x402', { url: 'https://m.test/paid' }],
    ['haven_pay_x402_quote', { quote: { paymentRequired: {} } }],
    ['haven_pay_x402', { url: 'https://m.test/paid' }],
  ]

  it.each(WIRED)('%s refuses the legacy spelling — proving it is wired', async (name, base) => {
    const { haven, seen } = stubHaven()
    const res = await callTool(haven, name, { ...base, idempotencyKey: 'camel-1' })
    expect(JSON.stringify(res), name).toMatch(/IDEMPOTENCY_KEY_RENAMED/)
    expect(seen.pay, name).toHaveLength(0)
    expect(seen.fetch, name).toHaveLength(0)
    expect(seen.quoteX402, name).toHaveLength(0)
  })

  it('every tool that takes the key declares BOTH spellings (the old one to refuse it by name)', () => {
    // The schema half. `idempotencyKey` must stay declared — deleting it would
    // let the MCP SDK's default strip mode drop it before the handler ever
    // ran, recreating the #2348 silent-drop double-spend instead of refusing
    // by name.
    for (const [name] of WIRED) {
      const shape = toolSchemas[name as keyof typeof toolSchemas]
      expect(Object.keys(shape), name).toContain('idempotency_key')
      expect(Object.keys(shape), name).toContain('idempotencyKey')
    }
  })

  /**
   * The snake_case key reaches the SDK call on EVERY tool that takes it, not
   * just `haven_send` (#3411 regression — before this PR only `haven_send`
   * pinned that the carrier actually reaches the SDK).
   */
  it('haven_send forwards idempotency_key to haven.pay', async () => {
    const { haven, seen } = stubHaven()
    await callTool(haven, 'haven_send', { ...BASE, idempotency_key: 'snake-1' })
    expect(seen.pay[0]?.idempotencyKey).toBe('snake-1')
  })

  it('haven_pay_mcp_tool forwards idempotency_key to haven.fetch', async () => {
    const { haven, seen } = stubHaven()
    await callTool(haven, 'haven_pay_mcp_tool', {
      merchant_url: 'https://m.test/mcp',
      tool_name: 't',
      idempotency_key: 'snake-1',
    })
    expect(seen.fetch[0]?.opts?.idempotencyKey).toBe('snake-1')
  })

  it('haven_quote_x402 forwards idempotency_key to haven.quoteX402', async () => {
    const { haven, seen } = stubHaven()
    await callTool(haven, 'haven_quote_x402', { url: 'https://m.test/paid', idempotency_key: 'snake-1' })
    expect(seen.quoteX402[0]?.opts?.idempotencyKey).toBe('snake-1')
  })

  it('haven_pay_x402_quote forwards idempotency_key to haven.payX402Quote', async () => {
    const { haven, seen } = stubHaven()
    await callTool(haven, 'haven_pay_x402_quote', {
      quote: { paymentRequired: {} },
      idempotency_key: 'snake-1',
    })
    expect(seen.pay[0]?.idempotencyKey).toBe('snake-1')
  })

  it('haven_pay_x402 forwards idempotency_key to haven.fetch', async () => {
    const { haven, seen } = stubHaven()
    await callTool(haven, 'haven_pay_x402', { url: 'https://m.test/paid', idempotency_key: 'snake-1' })
    expect(seen.fetch[0]?.opts?.idempotencyKey).toBe('snake-1')
  })

  /**
   * A schema rejection is a structured failure on the DIRECT-HANDLER path (#2366).
   *
   * `preflight` moved `objectInput` inside a try/catch for all five tools, and
   * for three of them that changed the response shape — a change this PR first
   * described as preservation, which it was not (haven-reviewer, who ran base
   * and head side by side rather than reading them).
   *
   * The distinction is the part worth pinning, and it is not the obvious one:
   *
   * - **Through the MCP client**, nothing changed and nothing could. The SDK
   *   validates against the registered schema before a handler runs and returns
   *   its own `-32602 Invalid arguments`, identically before and after. My first
   *   version of this test asserted through the transport and failed on all
   *   four tools for that reason — the instrument could not see the thing it
   *   was pointed at.
   * - **Through `createToolHandlers` directly** — an exported entry point, and
   *   the one the hosted server's own suite calls "the direct-embedder path" —
   *   `haven_quote_x402`, `haven_pay_x402_quote` and `haven_pay_x402` used to
   *   THROW a raw ZodError out of the handler, while `haven_send` and
   *   `haven_pay_mcp_tool` already returned `{ success: false, code, message }`.
   *   All five are structured now.
   *
   * That is an improvement rather than an accident, and it was untested for
   * exactly the three tools whose behaviour changed — the two that were already
   * structured are the two that had tests, which is why nobody noticed.
   */
  const SCHEMA_REJECTS = [
    ['haven_quote_x402', { url: 'not-a-url' }],
    ['haven_pay_x402', { url: 'not-a-url' }],
    ['haven_pay_x402_quote', { quote: {}, idempotency_key: 42 }],
    ['haven_send', { asset: 'DOGE', recipient: '0xabc', amount: '1' }],
    ['haven_pay_mcp_tool', { merchant_url: 'not-a-url', tool_name: 't' }],
  ] as const

  it.each(SCHEMA_REJECTS)('%s rejects bad input as a structured failure, never a throw', async (name, args) => {
    const { haven, seen } = stubHaven()
    const handlers = createToolHandlers(haven)
    const result = await handlers[name as keyof typeof handlers](args)
    // The shape, not the wording: a caller branches on `code`.
    expect(result, name).toMatchObject({ success: false })
    expect((result as { code?: string }).code, name).toBeTruthy()
    // And nothing was contacted.
    expect(seen.pay, name).toHaveLength(0)
    expect(seen.fetch, name).toHaveLength(0)
    expect(seen.quoteX402, name).toHaveLength(0)
  })
})
