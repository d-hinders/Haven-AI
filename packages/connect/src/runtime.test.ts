import { describe, expect, it, vi } from 'vitest'
import type { ConnectApiClient, RegisterSetupInput, UpdateInstallStatusInput } from './api.js'
import { delegateKeyFromPrivateKey } from './key.js'
import { runConnect } from './runtime.js'

const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'

describe('runConnect', () => {
  it('generates a local key, registers only the public address, stores credentials, and redacts output', async () => {
    const logs: string[] = []
    const registerInputs: RegisterSetupInput[] = []
    const installInputs: UpdateInstallStatusInput[] = []
    const installRuntime = vi.fn(async () => ({
      runtime: 'claude-code' as const,
      runtimeMcpMode: 'local_stdio' as const,
      hostedMcpConfigured: false,
      localSignerConfigured: true,
      localMcpConfigured: true,
      localMcpAcknowledged: true,
      probeResult: 'local_stdio_mcp_ready',
      restartRequired: true,
      nextUserAction: 'return_to_haven_for_wallet_approval_then_restart_agent_session',
      configTarget: 'Claude Code MCP config',
      messages: ['Updated local Haven MCP entry with Claude Code.'],
    }))
    const api: ConnectApiClient = {
      resolveSetup: vi.fn(async () => ({
        setup_id: 'setup-1',
        status: 'awaiting_connection',
        agent: { name: 'Research Agent', description: 'Pays for research APIs' },
        haven_wallet: {
          id: 'safe-1',
          name: 'Main Haven wallet',
          address: '0x2222222222222222222222222222222222222222',
          chain_id: 100,
          network: 'Gnosis',
        },
        agent_budget: [{
          token_address: '0x3333333333333333333333333333333333333333',
          token_symbol: 'USDC.e',
          allowance_amount: '25000000',
          reset_period_min: 1440,
        }],
        hosted_mcp_url: 'https://mcp.haven.example/v1',
        challenge: {
          id: 'challenge-1',
          message: 'Haven Connect Agent 2\nsetup_id: setup-1\nchallenge: abc',
          expires_at: '2099-01-01T00:00:00.000Z',
        },
      })),
      registerSetup: vi.fn(async (input) => {
        registerInputs.push(input)
        return {
          setup_id: 'setup-1',
          agent_id: 'agent-1',
          status: 'connected_local',
          agent_status: 'pending_approval',
          api_key_prefix: input.apiKeyPrefix,
          api_key_scope: 'setup_pending',
          delegate_address: input.delegateAddress.toLowerCase(),
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          next_action: 'return_to_haven_for_wallet_approval',
        }
      }),
      updateInstallStatus: vi.fn(async (_setupId, _apiKey, input) => {
        installInputs.push(input)
      }),
    }

    const result = await runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-connect-test',
    }, {
      api,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_supersecret',
      preflightStorage: vi.fn(async () => '/tmp/haven-connect-test'),
      writeCredentials: vi.fn(async (input) => {
        expect(input.apiKey).toBe('sk_agent_supersecret')
        expect(input.delegateKey).toBe(PRIVATE_KEY)
        expect(input.delegateAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
        expect(input.agentBudget).toEqual([{
          token_symbol: 'USDC.e',
          allowance_amount: '25000000',
          reset_period_min: 1440,
        }])
        return {
          directory: '/tmp/haven-connect-test/agent-1',
          identityPath: '/tmp/haven-connect-test/agent-1/identity.json',
          signerPath: '/tmp/haven-connect-test/agent-1/signer.json',
        }
      }),
      installRuntime,
      log: (message) => logs.push(message),
    })

    expect(result.agentId).toBe('agent-1')
    expect(registerInputs).toHaveLength(1)
    expect(registerInputs[0].delegateAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(registerInputs[0].proofSignature).toMatch(/^0x[0-9a-fA-F]+$/)
    expect(registerInputs[0].apiKeyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(registerInputs[0].apiKeyPrefix).toBe('sk_agent_sup')
    expect(JSON.stringify(registerInputs[0])).not.toContain(PRIVATE_KEY)
    expect(JSON.stringify(registerInputs[0])).not.toContain('sk_agent_supersecret')
    expect(JSON.stringify(registerInputs[0])).not.toMatch(/delegate_key|private_key|privateKey/)
    expect(installInputs[0]).toMatchObject({
      runtimeMcpMode: 'local_stdio',
      hostedMcpConfigured: false,
      localSignerConfigured: true,
      localMcpConfigured: true,
      localMcpAcknowledged: true,
      credentialFilesWritten: true,
      probeResult: 'local_stdio_mcp_ready',
      nextUserAction: 'return_to_haven_for_wallet_approval_then_restart_agent_session',
    })
    expect(installRuntime).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'sk_agent_supersecret',
      hostedMcpUrl: 'https://mcp.haven.example/v1',
      identityPath: '/tmp/haven-connect-test/agent-1/identity.json',
      signerPath: '/tmp/haven-connect-test/agent-1/signer.json',
    }))

    const output = logs.join('\n')
    expect(output).toContain('Fetched Haven setup for Research Agent')
    expect(output).toContain('Registered signing address with Haven')
    expect(output).not.toContain(PRIVATE_KEY)
    expect(output).not.toContain('sk_agent_supersecret')
  })
})
