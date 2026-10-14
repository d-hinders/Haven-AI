/**
 * #3816 — the hosted contract fingerprint's own guards.
 *
 * The property that makes the fingerprint USABLE as a stale-list detector is
 * not "it exists" but "it is exactly what tools/list advertises, and nothing
 * else": recomputed from a real `tools/list` over the wire it must equal the
 * boot-time constant, it must move when any advertised schema or description
 * moves, and it must not depend on process state (fresh module loads agree).
 * The echo-refusal test pins the companion guarantee: the fingerprint is not a
 * field any tool accepts, so an agent echoing it back is refused rather than
 * stripped.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HavenClient } from '@haven_ai/sdk'
import {
  computeContractFingerprint,
  hostedToolAdvertisement,
  HOSTED_CONTRACT_FINGERPRINT,
} from './contract-fingerprint.js'
import { buildHostedMcpServer, HOSTED_INSTRUCTIONS } from './server.js'
import { STRICT_INPUT_TOOLS, toolSchemas, type HostedToolName } from './tools.js'

const allAdverts = () =>
  (Object.keys(toolSchemas) as HostedToolName[]).map(hostedToolAdvertisement)

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    async () =>
      ({
        ok: false,
        status: 401,
        headers: new Headers(),
        json: async () => ({}),
        text: async () => '{}',
      }) as unknown as Response,
  )
})
afterEach(() => vi.unstubAllGlobals())

async function wireTools() {
  const haven = new HavenClient({ apiKey: '«reda...…»', baseUrl: 'http://haven.test' })
  const server = buildHostedMcpServer(haven)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'fingerprint-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const { tools } = await client.listTools()
  return { client, server, tools }
}

describe('#3816 hosted contract fingerprint', () => {
  it('is 16 hex — the short-hash convention', () => {
    expect(HOSTED_CONTRACT_FINGERPRINT).toMatch(/^[0-9a-f]{16}$/)
  })

  it('equals the hash recomputed from a REAL tools/list over the transport', async () => {
    const { client, server, tools } = await wireTools()
    const fromWire = computeContractFingerprint(
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      })),
    )
    expect(fromWire).toBe(HOSTED_CONTRACT_FINGERPRINT)
    await client.close()
    await server.close()
  })

  it('is identical across fresh module loads, not merely two computations', async () => {
    vi.resetModules()
    const fresh = await import('./contract-fingerprint.js')
    expect(fresh.HOSTED_CONTRACT_FINGERPRINT).toBe(HOSTED_CONTRACT_FINGERPRINT)
  })

  it('changes when a tool description changes', () => {
    const mutated = allAdverts().map((t) =>
      t.name === 'haven_get_agent' ? { ...t, description: `${t.description} extra sentence.` } : t,
    )
    expect(computeContractFingerprint(mutated)).not.toBe(HOSTED_CONTRACT_FINGERPRINT)
  })

  it('changes when an advertised input schema changes', () => {
    const mutated = allAdverts().map((t) =>
      t.name === 'haven_get_payment_status'
        ? {
            ...t,
            inputSchema: {
              ...(t.inputSchema as Record<string, unknown>),
              new_field: { type: 'string' },
            },
          }
        : t,
    )
    expect(computeContractFingerprint(mutated)).not.toBe(HOSTED_CONTRACT_FINGERPRINT)
  })

  it('is carried in HOSTED_INSTRUCTIONS (what a pre-deploy client loaded)', () => {
    expect(HOSTED_INSTRUCTIONS).toContain(`Contract fingerprint ${HOSTED_CONTRACT_FINGERPRINT}`)
  })

  it('is never a declared argument, and a strict tool refuses it echoed', async () => {
    for (const name of Object.keys(toolSchemas) as HostedToolName[]) {
      expect(Object.keys(toolSchemas[name]), name).not.toContain('contract_fingerprint')
    }
    // An agent echoing the fingerprint into a hosted call is refused by the
    // SDK's strict validation before any handler runs — nothing is read.
    const haven = new HavenClient({ apiKey: '«reda...…»', baseUrl: 'http://haven.test' })
    const server = buildHostedMcpServer(haven)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'echo-test', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const strictTool = Object.keys(STRICT_INPUT_TOOLS)[0] as keyof typeof STRICT_INPUT_TOOLS
    const result = (await client.callTool({
      name: strictTool,
      arguments: { contract_fingerprint: HOSTED_CONTRACT_FINGERPRINT },
    })) as { isError?: boolean; content?: { text?: string }[] }
    const text = result.content?.map((c) => c.text ?? '').join('\n') ?? ''
    expect(result.isError).toBe(true)
    expect(text).toContain('contract_fingerprint')
    expect(text).toContain('stale')
    await client.close()
    await server.close()
  })
})
