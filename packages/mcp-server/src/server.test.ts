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
        'haven_get_resume_state',
        'haven_list_receipts',
        'haven_pay',
        'haven_pay_mcp_tool',
        'haven_pay_mpp_challenge',
        'haven_pay_x402_quote',
        'haven_quote_mpp',
        'haven_quote_x402',
        'haven_resume_mpp_payment',
        'haven_resume_x402_payment',
        'haven_send',
        'haven_submit',
      ].sort(),
    )

    await client.close()
    await server.close()
  })

  it('publishes allowance routing guidance for budget questions', async () => {
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const server = buildHostedMcpServer(haven)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    const allowances = tools.find((tool) => tool.name === 'haven_get_allowances')
    const pay = tools.find((tool) => tool.name === 'haven_pay')
    const payX402Quote = tools.find((tool) => tool.name === 'haven_pay_x402_quote')
    const receipts = tools.find((tool) => tool.name === 'haven_list_receipts')

    expect(allowances?.description?.toLowerCase()).toContain('what can i spend')
    expect(allowances?.description?.toLowerCase()).toContain('remaining budget')
    expect(pay?.description?.toLowerCase()).toContain('call haven_get_allowances instead')
    expect(payX402Quote?.description?.toLowerCase()).toContain('call haven_get_allowances')
    expect(receipts?.description?.toLowerCase()).toContain('use the allowance tool instead')

    await client.close()
    await server.close()
  })
})
