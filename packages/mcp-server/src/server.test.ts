import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HavenClient, HavenSigningError } from '@haven_ai/sdk'
import { buildHostedMcpServer, createHostedHavenClient } from './server.js'

describe('createHostedHavenClient', () => {
  it('builds a keyless client (no delegate address, no signing path)', () => {
    const client = createHostedHavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    expect(client.delegateAddress).toBeUndefined()
  })

  it('cannot sign — api key alone is identity, not authority', () => {
    const client = createHostedHavenClient({ apiKey: 'sk_agent_test' })
    // No delegate key => the signing path throws, so an api-key-only caller
    // can never move funds without an edge signature.
    expect(() => client.sign('0x' + '11'.repeat(32))).toThrow(HavenSigningError)
  })
})

describe('buildHostedMcpServer', () => {
  it('connects over a transport and lists the keyless tool set', async () => {
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const server = buildHostedMcpServer(haven)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()

    expect(names).toEqual(
      [
        'haven_get_agent',
        'haven_get_allowances',
        'haven_get_payment_status',
        'haven_list_transactions',
        'haven_pay',
        'haven_submit',
        'haven_x402_authorize',
      ].sort(),
    )

    await client.close()
    await server.close()
  })
})
