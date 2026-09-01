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
        'haven_quote_mcp_tool',
        'haven_prepare_catalog_purchase',
        'haven_quote_catalog_purchase',
        'haven_pay_x402_quote',
        'haven_quote_x402',
        'haven_report_x402_outcome',
        'haven_resume_x402_payment',
        'haven_send',
        'haven_submit',
        'haven_submit_catalog_entry',
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
    expect(pay?.description?.toLowerCase()).toContain('use haven_get_allowances instead')
    expect(payX402Quote?.description?.toLowerCase()).toContain('haven_get_allowances')
    expect(receipts?.description?.toLowerCase()).toContain('use the allowance tool instead')

    await client.close()
    await server.close()
  })

  it('states the no-user-cap convention on every cap-taking surface (#1548)', async () => {
    // "Buy X" with no stated ceiling is the COMMON case, and the cap is
    // required — without a documented convention every agent improvises its
    // own number (a live run produced ~6x the price from a private
    // heuristic). The convention: quote first, cap at the live quoted amount;
    // a price rise then refuses safely and the agent re-confirms. This test
    // pins that the convention lives in FULL on the instructions (the single
    // home after the slim-descriptions pass), while each cap-taking tool's
    // description keeps a compact pointer to it, so an agent that reads
    // either surface behaves the same way.
    expect(HOSTED_INSTRUCTIONS).toContain('When the user stated NO cap')
    expect(HOSTED_INSTRUCTIONS).toContain('cap at the live quoted amount')
    expect(HOSTED_INSTRUCTIONS).toContain('Never invent headroom')
    // The failure mode is safe-by-construction, and the instructions say so.
    expect(HOSTED_INSTRUCTIONS).toMatch(/re-quote and confirm/i)

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const server = buildHostedMcpServer(haven)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']))

    for (const tool of ['haven_prepare_catalog_purchase', 'haven_pay_mcp_tool']) {
      const description = byName.get(tool) ?? ''
      expect(description).toContain('no user-stated cap')
      expect(description).toContain('cap at the quoted amount')
    }
    // The quote tool is the convention's first step, so it names its role.
    expect(byName.get('haven_quote_catalog_purchase')).toContain('the user stated no cap')

    await client.close()
    await server.close()
  })

  it('instructs the agent to branch on the signer version-mismatch refusal (#1155, #1547)', async () => {
    // The prompt half of payment skew detection. #1155 told agents to compare
    // the emitted version against the signer's initialize handshake — which
    // most agent harnesses cannot read (#1547): the observed behaviour was
    // agents "checking" by re-reading instruction prose. The signer already
    // refuses incompatible versions machine-readably (code / supported_versions
    // / received_version / fallback, #1309), so the documented protocol is now
    // sign-and-branch-on-refusal. After the slim-descriptions pass (#1591) the
    // protocol lives ONCE, on the hosted instructions — descriptions no longer
    // repeat it, and must never regress to the inspect-initialize advice.
    expect(HOSTED_INSTRUCTIONS).toContain('version-mismatch')
    expect(HOSTED_INSTRUCTIONS).toContain('supported_versions')
    expect(HOSTED_INSTRUCTIONS).toContain('npx @haven_ai/connect@alpha')
    expect(HOSTED_INSTRUCTIONS).not.toMatch(/advertises at initialize/)

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const server = buildHostedMcpServer(haven)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']))

    // #1547: no description tells the agent to inspect the signer's MCP
    // initialize result — most harnesses cannot see it. Scanned across ALL
    // descriptions so the advice cannot sneak back onto any surface.
    for (const [, description] of byName) {
      expect(description).not.toMatch(/advertises at initialize/)
    }

    // Resume re-enters signing and carries no version of its own — the signer
    // restart it already anticipates is exactly when the installed signer can
    // have changed, and the signing-time refusal is where that surfaces.
    const resume = byName.get('haven_resume_x402_payment') ?? ''
    expect(resume).toContain('an incompatible signer refuses at signing time')

    await client.close()
    await server.close()
  })

  it('keeps x402 next-tool guidance runtime-neutral (bare names in descriptions, naming note on instructions)', async () => {
    // The slim-descriptions pass (#1591) finished what the runtime-neutral
    // naming work (#1588) started: descriptions name next tools by their BARE
    // names (the signer tool comes from the response guidance at run time),
    // and the one place that explains Claude-family mcp__<server>__<tool>
    // namespacing — plus the next_tool_server/next_tool_name resolution for
    // other runtimes — is the hosted instructions.
    expect(HOSTED_INSTRUCTIONS).toContain('mcp__<server>__<tool>')
    expect(HOSTED_INSTRUCTIONS).toContain('next_tool_server')
    expect(HOSTED_INSTRUCTIONS).toContain('next_tool_name')

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const server = buildHostedMcpServer(haven)

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']))

    // No description hardcodes a Claude-family namespace — that would be
    // wrong verbatim on every non-Claude runtime (the #1588 lesson).
    for (const [name, description] of byName) {
      expect(description, `description of ${name} hardcodes an mcp__ namespace`).not.toContain(
        'mcp__',
      )
    }

    // The chain itself still travels on the descriptions, by bare name.
    expect(byName.get('haven_quote_x402')).toContain('haven_pay_x402_quote')
    expect(byName.get('haven_pay_x402_quote')).toContain('expires_at')
    // #2291: this line used to read as "the quote path names its header tool".
    // It still passes on the substring, but the sentence around it now says the
    // OPPOSITE — do NOT call that tool on this path, because the one-shot
    // returns the header inline. Asserted as the negation it now is, so the
    // test cannot go on passing for a reason it no longer means.
    expect(byName.get('haven_pay_x402_quote')).toContain('do NOT call haven_x402_sign_header')
    expect(byName.get('haven_pay_x402_quote')).toContain('payment_header')
    expect(byName.get('haven_pay_mcp_tool')).toContain('haven_settle_mcp_tool')
    expect(byName.get('haven_pay_mcp_tool')).toContain('expires_at')
    expect(byName.get('haven_pay_mcp_tool')).toContain('signer_compatibility')
    expect(byName.get('haven_submit')).toContain('haven_x402_sign_header')
    // Same inversion on the resume path (#2290 wrote the contradictory order
    // here; #2291 corrects it): the header comes from the one-shot's result.
    expect(byName.get('haven_resume_x402_payment')).toContain(
      'Do NOT pass its x402_binding to',
    )
    expect(byName.get('haven_settle_mcp_tool')).toContain('no further Haven tool is needed')
    expect(byName.get('haven_complete_mcp_tool')).toContain('no further Haven tool is needed')

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
    expect(instructions).toContain('haven_quote_mcp_tool')
    expect(instructions).toContain('haven_quote_catalog_purchase')
    expect(instructions).toContain('max_amount')
    expect(instructions).toContain('next_action')
    expect(instructions).toContain('next_tool')
    expect(instructions).toContain('next_arguments')
    expect(instructions).toContain('payment_id')
    // #2101: the instructions must NOT tell a model to branch on
    // `pending_approval`. No live rail mints it (410 on the legacy rail per
    // #1986; 403/502 at prepare on the delegation rail; `approval_requests`
    // dropped by #2055), so the old line sent agents to wait for an approval
    // that never arrives. The replacement states the decline and the general
    // unrecognised-status stop rule instead.
    expect(instructions).not.toContain('pending_approval')
    expect(instructions).toContain('declined before any money moves')
    expect(instructions).toContain('holds no approval queue')
    expect(instructions).toContain('any status you do not recognise')
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

// ── #2282: the mcp_transport case mismatch at the protocol boundary ──────────

describe('mcp_transport at the MCP protocol boundary (#2282)', () => {
  async function connectHosted() {
    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
    const server = buildHostedMcpServer(haven)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    return { client, server }
  }

  it('advertises snake_case with additionalProperties: false on both settle-leg tools', async () => {
    const { client, server } = await connectHosted()
    const { tools } = await client.listTools()

    for (const name of ['haven_settle_mcp_tool', 'haven_complete_mcp_tool']) {
      const schema = tools.find((tool) => tool.name === name)!.inputSchema as {
        properties: Record<string, any>
      }
      const transport = schema.properties.mcp_transport
      expect(transport.required).toEqual(['handshake_required', 'source'])
      expect(transport.additionalProperties).toBe(false)
      expect(Object.keys(transport.properties)).toEqual(['handshake_required', 'source'])
    }

    await client.close()
    await server.close()
  })

  it('refuses the SDK camelCase shape with a message naming the mismatch', async () => {
    // #2282's second hazard: the caller's explicit-context retry must come back
    // as something they can act on. A refusal that only says "handshake_required:
    // Required" is true and useless to a caller holding `handshakeRequired`.
    const { client, server } = await connectHosted()

    const result = (await client.callTool({
      name: 'haven_settle_mcp_tool',
      arguments: {
        payment_id: 'pay_x402',
        signature: '0x' + '11'.repeat(65),
        merchant_url: 'https://merchant.test/mcp',
        tool_name: 'buy_vpn',
        arguments: { plan: 'legacy' },
        mcp_transport: { handshakeRequired: true, source: 'path' },
        payment_header: 'eyJ4IjoxfQ==',
      },
    })) as { isError?: boolean; content: { type: string; text: string }[] }

    expect(result.isError).toBe(true)
    const text = result.content.map((part) => part.text).join('\n')
    expect(text).toContain('handshake_required')
    expect(text).toContain('handshakeRequired')
    expect(text).toContain('snake_case')

    await client.close()
    await server.close()
  })
})
