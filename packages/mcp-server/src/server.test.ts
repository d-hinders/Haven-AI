import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HavenClient, HavenSigningError } from '@haven_ai/sdk'
import {
  buildHostedMcpServer,
  createHostedHavenClient,
  HOSTED_INSTRUCTIONS,
  HOSTED_SERVER_VERSION,
} from './server.js'

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
        'haven_discover_tools',
        'haven_get_agent',
        'haven_get_allowances',
        'haven_get_payment_status',
        'haven_get_resume_state',
        'haven_list_receipts',
        'haven_verify_receipt',
        'haven_complete_mcp_tool',
        'haven_settle_mcp_tool',
        'haven_pay',
        'haven_pay_mcp_tool',
        'haven_prepare_catalog_purchase',
        'haven_pay_x402_quote',
        'haven_quote_x402',
        'haven_resume_x402_payment',
        'haven_send',
        'haven_submit',
        'haven_sweep_delegate',
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

  it('instructs the agent to compare expected-context versions before signing (#1155)', async () => {
    // The prompt half of pre-payment skew detection. The quote result carries
    // the number; the description is what tells the agent to look at it, and to
    // stop rather than sign when it falls outside what the local signer
    // advertises at its own initialize handshake.
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const server = buildHostedMcpServer(haven)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']))

    for (const tool of ['haven_pay_x402_quote', 'haven_pay_mcp_tool']) {
      const description = byName.get(tool) ?? ''
      expect(description).toContain('signer_compatibility.x402_expected_context_version')
      expect(description).toContain('haven/signer-compatibility')
      // Same fix as #1143, so both surfaces tell the user the same thing.
      expect(description).toContain('npx @haven_ai/connect@alpha')
      expect(description).toContain('STOP before signing')
    }

    // Resume re-enters signing and carries no version of its own, so it prompts
    // a re-check of the original quote's — the signer restart it already
    // anticipates is exactly when the installed signer can have changed.
    const resume = byName.get('haven_resume_x402_payment') ?? ''
    expect(resume).toContain('haven/signer-compatibility')
    expect(resume).toContain('npx @haven_ai/connect@alpha')
    expect(resume).toContain('STOP before signing')

    await client.close()
    await server.close()
  })

  it('publishes x402 next-tool guidance with explicit MCP namespaces', async () => {
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const server = buildHostedMcpServer(haven)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']))

    expect(byName.get('haven_quote_x402')).toContain('Next: call mcp__haven__haven_pay_x402_quote')
    expect(byName.get('haven_pay_x402_quote')).toContain(
      'Next: call mcp__haven-signer__haven_sign',
    )
    expect(byName.get('haven_pay_x402_quote')).toContain('expires_at')
    expect(byName.get('haven_pay_mcp_tool')).toContain(
      'Next: call mcp__haven-signer__haven_sign_x402',
    )
    expect(byName.get('haven_pay_mcp_tool')).toContain('mcp__haven__haven_settle_mcp_tool')
    expect(byName.get('haven_pay_mcp_tool')).toContain('expires_at')
    expect(byName.get('haven_pay_mcp_tool')).toContain('x402_expected')
    expect(byName.get('haven_submit')).toContain('mcp__haven-signer__haven_x402_sign_header')
    expect(byName.get('haven_resume_x402_payment')).toContain(
      'Next: call mcp__haven-signer__haven_x402_sign_header',
    )
    expect(byName.get('haven_settle_mcp_tool')).toContain(
      'Next: no further Haven tool is needed on success',
    )
    expect(byName.get('haven_complete_mcp_tool')).toContain(
      'Next: no further Haven tool is needed on success',
    )

    await client.close()
    await server.close()
  })

  it('advertises the hosted critical-path instructions at initialize', async () => {
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const server = buildHostedMcpServer(haven)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const instructions = client.getInstructions()
    expect(instructions).toBe(HOSTED_INSTRUCTIONS)
    expect(instructions).toContain('haven_get_agent')
    expect(instructions).toContain('haven_prepare_catalog_purchase')
    expect(instructions).toContain('max_amount')
    expect(instructions).toContain('next_action')
    expect(instructions).toContain('next_tool')
    expect(instructions).toContain('next_arguments')
    expect(instructions).toContain('payment_id')
    expect(instructions).toContain('pending_approval')
    expect(instructions).toContain('safe_to_continue')
    expect(instructions).toContain('never holds keys')

    await client.close()
    await server.close()
  })

  it('never carries a version literal in the hosted instructions (drift guard)', () => {
    // Nothing in HOSTED_INSTRUCTIONS should need a version bump to stay true —
    // if it does, that content belongs in a per-tool description instead.
    // A protocol name like x402 is allowed — it never drifts. A semver-shaped
    // literal or the package's own version constant would.
    expect(HOSTED_INSTRUCTIONS).not.toMatch(/\d+\.\d+\.\d+/)
    expect(HOSTED_INSTRUCTIONS).not.toContain(HOSTED_SERVER_VERSION)
  })
})
