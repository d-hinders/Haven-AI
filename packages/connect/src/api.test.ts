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
      hostedMcpConfigured: false,
      localSignerConfigured: false,
      credentialFilesWritten: true,
      probeResult: 'credential_files_written',
      restartRequired: true,
      nextUserAction: 'return_to_haven_for_wallet_approval',
    })

    expect(calls[0].url).toBe('https://api.haven.example/agent-connection-setups/setup-1/install-status')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk_agent_secret')
    expect(String(calls[0].init.body)).not.toContain('sk_agent_secret')
    expect(String(calls[0].init.body)).toContain('credential_files_written')
  })
})
