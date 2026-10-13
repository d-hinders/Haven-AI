import { describe, expect, it, vi } from 'vitest'
import { createConnectApiClient } from './api.js'

describe('createConnectApiClient', () => {
  it('registers only public signing address and proof, never private key material', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        setup_id: 'setup-1',
        agent_id: 'agent-1',
        status: 'connected_local',
        agent_status: 'pending_approval',
        api_key_prefix: 'sk_agent_ret',
        api_key_scope: 'setup_pending',
        delegate_address: '0x1111111111111111111111111111111111111111',
        hosted_mcp_url: 'https://mcp.haven.example/v1',
        next_action: 'return_to_haven_for_wallet_approval',
      }), { status: 201 })
    }) as unknown as typeof fetch

    const api = createConnectApiClient('https://api.haven.example', fetchImpl)
    await api.registerSetup({
      setupToken: 'hv_setup_test',
      connectorVersion: '0.1.0',
      challengeId: 'challenge-1',
      delegateAddress: '0x1111111111111111111111111111111111111111',
      proofSignature: '0xproof',
      apiKeyHash: 'a'.repeat(64),
      apiKeyPrefix: 'sk_agent_abc',
      runtime: 'claude-code',
    })

    const body = String(calls[0].init.body)
    expect(calls[0].url).toBe('https://api.haven.example/agent-connection-setups/register')
    expect(body).toContain('delegate_address')
    expect(body).toContain('proof_signature')
    expect(body).toContain('api_key_hash')
    expect(body).not.toContain('api_key":"')
    expect(body).not.toMatch(/delegate_key|delegatePrivateKey|private_key|privateKey/)
    expect(body).not.toContain('0x' + '11'.repeat(32))
  })

  it('sends the pending API key only as an Authorization header for install status', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch

    const api = createConnectApiClient('https://api.haven.example/', fetchImpl)
    await api.updateInstallStatus('setup-1', 'sk_agent_secret', {
      connectorVersion: '0.1.0',
      runtimeMcpMode: 'local_stdio',
      hostedMcpConfigured: false,
      localSignerConfigured: true,
      localMcpConfigured: true,
      credentialFilesWritten: true,
      localMcpAcknowledged: true,
      activationCommandAvailable: true,
      probeResult: 'local_stdio_mcp_ready',
      restartRequired: true,
      nextUserAction: 'return_to_haven_for_wallet_approval',
    })

    expect(calls[0].url).toBe('https://api.haven.example/agent-connection-setups/setup-1/install-status')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk_agent_secret')
    expect(String(calls[0].init.body)).not.toContain('sk_agent_secret')
    expect(String(calls[0].init.body)).toContain('credential_files_written')
    expect(String(calls[0].init.body)).toContain('runtime_mcp_mode')
    expect(String(calls[0].init.body)).toContain('local_mcp_configured')
    expect(String(calls[0].init.body)).toContain('local_mcp_acknowledged')
    expect(String(calls[0].init.body)).toContain('activation_command_available')
  })

  it('says nothing about superseded agents when it has nothing to say (#2561)', async () => {
    // Four states, not three. A list, `[]` and `null` are all CLAIMS the report
    // makes; ABSENT means "this report says nothing", which the backend's jsonb
    // merge honours by leaving the key alone.
    //
    // The client collapsed `undefined` into `null`, so the early
    // config-written ping — sent before the scan has even started — asserted
    // "the scan could not run" on every connect run. Inert while the complete
    // report overwrote it seconds later, and a landmine for the first caller
    // that relied on absence meaning unchanged.
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as unknown as typeof fetch
    const api = createConnectApiClient('https://api.haven.example/', fetchImpl)

    const base = {
      connectorVersion: '0.1.0',
      hostedMcpConfigured: false,
      localSignerConfigured: true,
      restartRequired: false,
      nextUserAction: 'return_to_haven_for_wallet_approval',
    }

    // Omitted → the key is absent from the wire entirely.
    await api.updateInstallStatus('setup-1', 'sk_agent_secret', base)
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty('superseded_agent_ids')

    // Each of the three real states travels as itself.
    await api.updateInstallStatus('setup-1', 'sk_agent_secret', { ...base, supersededAgentIds: null })
    expect(JSON.parse(String(calls[1].init.body)).superseded_agent_ids).toBeNull()

    await api.updateInstallStatus('setup-1', 'sk_agent_secret', { ...base, supersededAgentIds: [] })
    expect(JSON.parse(String(calls[2].init.body)).superseded_agent_ids).toEqual([])

    await api.updateInstallStatus('setup-1', 'sk_agent_secret', {
      ...base,
      supersededAgentIds: ['agt_old'],
    })
    expect(JSON.parse(String(calls[3].init.body)).superseded_agent_ids).toEqual(['agt_old'])
  })

  it('#1878 serializes mcpServerName onto the wire as snake_case mcp_server_name', async () => {
    // The one seam the runtime tests cannot see: they assert what is handed to
    // a MOCKED api.registerSetup, which is the camelCase side. This asserts the
    // actual HTTP body — a camelCase→snake_case mapping is exactly the kind of
    // line that silently typos, and the backend would then store NULL forever
    // with every test still green.
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        setup_id: 'setup-1',
        agent_id: 'agent-1',
        status: 'connected_local',
        agent_status: 'pending_approval',
        api_key_prefix: 'sk_agent_ret',
        api_key_scope: 'setup_pending',
        delegate_address: '0x1111111111111111111111111111111111111111',
        hosted_mcp_url: 'https://mcp.haven.example/v1',
        next_action: 'return_to_haven_for_wallet_approval',
      }), { status: 201 })
    }) as unknown as typeof fetch

    const api = createConnectApiClient('https://api.haven.example', fetchImpl)
    await api.registerSetup({
      setupToken: 'hv_setup_test',
      connectorVersion: '0.1.0',
      challengeId: 'challenge-1',
      delegateAddress: '0x1111111111111111111111111111111111111111',
      proofSignature: '0xproof',
      apiKeyHash: 'a'.repeat(64),
      apiKeyPrefix: 'sk_agent_abc',
      runtime: 'claude-code',
      mcpServerName: 'haven-research',
    })

    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      mcp_server_name: 'haven-research',
    })
  })

  describe('reportRetiredAgents (#3772)', () => {
    const IDS = ['11111111-2222-4333-8444-555555555555']

    it('posts the ids with the new agent key as a Bearer header only', async () => {
      const calls: Array<{ url: string; init: RequestInit }> = []
      const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ setup_id: 'setup 1', recorded_agent_ids: IDS }), { status: 200 })
      }) as unknown as typeof fetch
      const api = createConnectApiClient('https://api.haven.example/', fetchImpl)

      await expect(api.reportRetiredAgents!({ setupId: 'setup 1', apiKey: 'sk_agent_new', retiredAgentIds: IDS }))
        .resolves.toEqual({ recordedAgentIds: IDS })

      expect(calls[0].url).toBe('https://api.haven.example/agent-connection-setups/setup%201/retired-agents')
      expect(calls[0].init.method).toBe('POST')
      expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk_agent_new')
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ retired_agent_ids: IDS })
      expect(String(calls[0].init.body)).not.toContain('sk_agent_new')
    })

    it('an older backend (404) returns null without throwing', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })) as unknown as typeof fetch
      const api = createConnectApiClient('https://api.haven.example', fetchImpl)
      await expect(api.reportRetiredAgents!({ setupId: 's', apiKey: 'k', retiredAgentIds: IDS })).resolves.toBeNull()
    })

    it.each([401, 500])('a %i is thrown for the caller to log', async (status) => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status })) as unknown as typeof fetch
      const api = createConnectApiClient('https://api.haven.example', fetchImpl)
      await expect(api.reportRetiredAgents!({ setupId: 's', apiKey: 'k', retiredAgentIds: IDS })).rejects.toMatchObject({ status })
    })
  })

})
