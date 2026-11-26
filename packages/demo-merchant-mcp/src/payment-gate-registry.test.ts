/**
 * #5069: the HTTP payment gate and the tools the MCP server registers come from
 * one registry, and a tool the gate does not know fails closed.
 *
 * Before #5069 the gate was a hand-kept switch over tool names, separate from
 * the tool registrations in `server.ts`. A buy tool registered without a gate
 * entry got no HTTP 402: the call went straight to its handler, which only the
 * handler's own in-band "payment required" check stopped.
 */
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const handlerCalls = vi.hoisted(() => ({ count: 0 }))

// A buy tool registered on the MCP server with no product in the registry —
// the shape #5069 found on a branch that added `buy_philip`. Its handler
// counts calls, so the test can assert the gate stopped the call before it.
vi.mock('./server.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./server.js')>()
  return {
    ...original,
    buildMerchantMcpServer: (...args: Parameters<typeof original.buildMerchantMcpServer>) => {
      const server = original.buildMerchantMcpServer(...args)
      server.tool('buy_unpriced', 'A buy tool with no product in the registry.', async () => {
        handlerCalls.count += 1
        return { content: [{ type: 'text' as const, text: 'delivered' }] }
      })
      return server
    },
  }
})

import { createDemoMerchantServer } from './http.js'
import {
  FREE_TOOL_NAMES,
  PRODUCTS,
  paidToolNames,
  productForToolCall,
  productToolArgs,
} from './products.js'
import { createX402PaymentProcessor, type SettlementClient } from './x402.js'

const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const TX_HASH = `0x${'ef'.repeat(32)}` as const

let servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
  handlerCalls.count = 0
})

async function startServer() {
  const settlementClient: SettlementClient = {
    submit: vi.fn<SettlementClient['submit']>().mockResolvedValue(TX_HASH),
    waitForReceipt: vi.fn<SettlementClient['waitForReceipt']>().mockResolvedValue(undefined),
  }
  const server = createDemoMerchantServer({
    merchantAddress: MERCHANT,
    baseUrl: 'http://127.0.0.1:0',
    paymentProcessor: createX402PaymentProcessor(settlementClient),
    settlementClient,
    readinessCacheMs: 0,
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server port')
  return { url: `http://127.0.0.1:${address.port}/mcp` }
}

async function postMcp(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  })
}

function toolCall(name: string, args: Record<string, unknown> = {}, id = 7) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

describe('#5069: the payment gate fails closed on a tool it does not know', () => {
  it('refuses an unpaid call to a registered buy tool with no product, before its handler runs', async () => {
    const { url } = await startServer()
    // The tool really is registered on the MCP server.
    const tools = await (await postMcp(url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).text()
    expect(tools).toContain('buy_unpriced')

    const res = await postMcp(url, toolCall('buy_unpriced'))
    // The SDK's own unknown-tool shape: 200 with an isError result, never a 404
    // (Streamable HTTP's "session not found").
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { content: [{ type: 'text', text: 'MCP error -32602: Tool buy_unpriced not found' }], isError: true },
    })
    expect(handlerCalls.count).toBe(0)
  })

  it('refuses a batch that carries a tools/call, before any handler runs', async () => {
    const { url } = await startServer()
    for (const name of ['buy_unpriced', 'buy_vpn']) {
      const res = await postMcp(url, [toolCall(name, name === 'buy_vpn' ? { plan: 'basic' } : {})])
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32600)
    }
    expect(handlerCalls.count).toBe(0)
  })

  it('answers a notification to an unknown tool as before: nothing runs', async () => {
    const { url } = await startServer()
    const res = await postMcp(url, { jsonrpc: '2.0', method: 'tools/call', params: { name: 'buy_unpriced', arguments: {} } })
    // The transport's answer to a notification: 202, no body — not the
    // gate's isError result, which is only for a request that has an id.
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
    expect(handlerCalls.count).toBe(0)
  })

  it('still quotes a 402 for every buy tool the registry knows', async () => {
    const { url } = await startServer()
    for (const product of [PRODUCTS.vpn_basic, PRODUCTS.storage_50gb]) {
      const { toolName, argumentName, argumentValue } = productToolArgs(product)
      const res = await postMcp(url, toolCall(toolName, argumentName ? { [argumentName]: argumentValue } : {}))
      expect(res.status).toBe(402)
    }
  })

  it('still serves the free tool without payment', async () => {
    const { url } = await startServer()
    const res = await postMcp(url, toolCall('list_products'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('vpn_basic')
  })
})

describe('#5069: one registry for the gate and the tool surface', () => {
  it('resolves every product from its own buy-tool call', () => {
    for (const product of Object.values(PRODUCTS)) {
      const { toolName, argumentName, argumentValue } = productToolArgs(product)
      const args = argumentName ? { [argumentName]: argumentValue } : {}
      expect(productForToolCall(toolName, args)?.id).toBe(product.id)
    }
  })

  it('resolves no product for arguments that select none', () => {
    expect(productForToolCall('buy_vpn', { plan: 'platinum' })).toBeUndefined()
    expect(productForToolCall('buy_vpn', {})).toBeUndefined()
    expect(productForToolCall('buy_unpriced', {})).toBeUndefined()
  })

  it('knows every tool name server.ts registers, so none reaches the server ungated', () => {
    // Source-level, so a tool registered only under a configuration flag
    // (buy_joke, buy_field_notes) is covered as well as the default set.
    const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    const registered = [...source.matchAll(/\.(?:tool|registerTool)\(\s*['"`]([^'"`]+)['"`]/g)].map((match) => match[1])
    expect(registered.length).toBeGreaterThanOrEqual(5)
    const known = new Set([...FREE_TOOL_NAMES, ...paidToolNames()])
    expect(registered.filter((name) => !known.has(name))).toEqual([])
  })
})
