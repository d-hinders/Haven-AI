/**
 * The `idempotencyKey` -> `idempotency_key` deprecation window (#2366 part 1).
 *
 * The two Haven MCP surfaces spell the same argument differently: this local
 * package takes `idempotencyKey`, the hosted server takes `idempotency_key`,
 * which is the convention every other Haven wire contract uses. #2348 made the
 * hosted side REFUSE the local spelling rather than strip it silently, because
 * a stripped idempotency key means a retry is a second spend. Refusing is the
 * on-ramp; one spelling is the destination, and this is the window (owner
 * decision 2026-09-06: accept both, warn on the old, drop it later).
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
import { toolSchemas } from './tools.js'

/** A HavenClient stub that records what `pay` was actually handed. */
function stubHaven() {
  const seen: Array<Record<string, unknown>> = []
  const haven = {
    pay: vi.fn(async (req: Record<string, unknown>) => {
      seen.push(req)
      return { paymentId: 'pay_1', status: 'executed', txHash: '0xabc' }
    }),
    withRequestContext: async (_ctx: unknown, run: () => Promise<unknown>) => run(),
  } as unknown as HavenClient
  return { haven, seen }
}

async function callSend(haven: HavenClient, args: Record<string, unknown>) {
  const server = buildMcpServer(haven)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  try {
    return await client.callTool({ name: 'haven_send', arguments: args })
  } finally {
    await client.close()
  }
}

const BASE = { asset: 'USDC', recipient: '0xabc', amount: '1' }

describe('idempotency-key spelling window (#2366)', () => {
  it('accepts the hosted spelling `idempotency_key` and carries it', async () => {
    const { haven, seen } = stubHaven()
    await callSend(haven, { ...BASE, idempotency_key: 'snake-1' })
    expect(seen[0]?.idempotencyKey).toBe('snake-1')
  })

  it('still accepts the legacy `idempotencyKey`, because installed callers send it', async () => {
    // The whole point of a window: a published package cannot break its
    // callers on the release that introduces the new name.
    const { haven, seen } = stubHaven()
    await callSend(haven, { ...BASE, idempotencyKey: 'camel-1' })
    expect(seen[0]?.idempotencyKey).toBe('camel-1')
  })

  it('warns on the legacy spelling, and does not warn on the new one', async () => {
    // The warning is what makes this a WINDOW rather than a permanent
    // divergence — without it nothing ever tells a caller to move.
    const { haven } = stubHaven()
    const legacy = await callSend(haven, { ...BASE, idempotencyKey: 'camel-1' })
    expect(JSON.stringify(legacy)).toMatch(/idempotency_key/)
    expect(JSON.stringify(legacy)).toMatch(/deprecated/i)

    const { haven: h2 } = stubHaven()
    const current = await callSend(h2, { ...BASE, idempotency_key: 'snake-1' })
    expect(JSON.stringify(current)).not.toMatch(/deprecated/i)
  })

  it('REFUSES both spellings with different values rather than picking one', async () => {
    // Picking either would be Haven deciding which replay scope the caller
    // meant. On a payment argument, guessing wrong turns a retry into a second
    // spend — the exact failure #2348 measured when the key was dropped.
    const { haven, seen } = stubHaven()
    const res = await callSend(haven, {
      ...BASE,
      idempotencyKey: 'camel-1',
      idempotency_key: 'snake-1',
    })
    expect(JSON.stringify(res)).toMatch(/AMBIGUOUS_IDEMPOTENCY_KEY/)
    // Nothing was attempted.
    expect(seen).toHaveLength(0)
  })

  it('accepts both spellings when they AGREE, since nothing is ambiguous', async () => {
    const { haven, seen } = stubHaven()
    await callSend(haven, { ...BASE, idempotencyKey: 'same', idempotency_key: 'same' })
    expect(seen[0]?.idempotencyKey).toBe('same')
  })

  it('sends no key at all when neither is given', async () => {
    const { haven, seen } = stubHaven()
    await callSend(haven, BASE)
    expect(seen[0]?.idempotencyKey).toBeUndefined()
  })

  /**
   * Every tool that declares the pair is actually WIRED to the resolver.
   *
   * `haven_send` above proves the mechanism. It does not prove the other four
   * use it — and an unwired tool is invisible, because the legacy spelling
   * keeps working there and the new one is silently dropped, which is the
   * pre-#2366 behaviour this change exists to end. Twice today a mutation
   * survived because a per-call-site choice was pinned nowhere; this is that
   * lesson applied before the review finds it.
   *
   * The ambiguity refusal is the probe, and it is the cheap one: it fires
   * before anything is contacted, so no client stub is needed. A tool that
   * still reads `args.idempotencyKey` directly cannot produce it.
   */
  const WIRED: Array<[string, Record<string, unknown>]> = [
    ['haven_send', { asset: 'USDC', recipient: '0xabc', amount: '1' }],
    ['haven_pay_mcp_tool', { merchant_url: 'https://m.test/mcp', tool_name: 't' }],
    ['haven_quote_x402', { url: 'https://m.test/paid' }],
    ['haven_pay_x402_quote', { quote: { paymentRequired: {} } }],
    ['haven_pay_x402', { url: 'https://m.test/paid' }],
  ]

  it.each(WIRED)('%s refuses conflicting spellings — proving it is wired', async (name, base) => {
    const { haven } = stubHaven()
    const server = buildMcpServer(haven)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
    await Promise.all([server.connect(st), client.connect(ct)])
    try {
      const res = await client.callTool({
        name,
        arguments: { ...base, idempotencyKey: 'a', idempotency_key: 'b' },
      })
      expect(JSON.stringify(res), name).toMatch(/AMBIGUOUS_IDEMPOTENCY_KEY/)
    } finally {
      await client.close()
    }
  })

  it('every tool that takes the key declares BOTH spellings', () => {
    // The schema half. A tool wired to the resolver but not declaring
    // `idempotency_key` would have the new name stripped by the SDK before the
    // handler ran (#2312), so the wiring would be real and useless.
    for (const [name] of WIRED) {
      const shape = toolSchemas[name as keyof typeof toolSchemas]
      expect(Object.keys(shape), name).toContain('idempotency_key')
      expect(Object.keys(shape), name).toContain('idempotencyKey')
    }
  })
})
