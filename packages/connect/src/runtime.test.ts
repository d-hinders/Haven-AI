import { describe, expect, it, vi } from 'vitest'
import type { ConnectApiClient, RegisterSetupInput, UpdateInstallStatusInput } from './api.js'
import { delegateKeyFromPrivateKey } from './key.js'
import { completionHandoffLines, runConnect } from './runtime.js'
import type { RuntimeInstallResult } from './runtime-install.js'

const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'
// These tests assert connect's behavior, not the machine's Node version. Since
// #1161 runConnect refuses below the floor before doing anything, so every call
// site pins a supported version explicitly — otherwise the suite would pass or
// fail depending on what Node the developer happens to be running.
const SUPPORTED_NODE = '24.0.0'

function completedInstall(runtime: RuntimeInstallResult['runtime']): RuntimeInstallResult {
  return {
    runtime,
    runtimeMcpMode: 'hosted_plus_signer',
    hostedMcpConfigured: true,
    localSignerConfigured: true,
    localMcpConfigured: false,
    probeResult: 'hosted_ok_local_signer_ready',
    restartRequired: runtime !== 'cursor' && runtime !== 'vscode',
    nextUserAction: 'return_to_haven_for_wallet_approval',
    messages: [],
  }
}

/** Await a promise expected to reject, returning the Error for assertions. */
async function expectRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the promise to reject, but it resolved')
}

describe('runConnect', () => {
  it.each([
    ['codex-cli', 'codex resume --last'],
    ['codex-desktop', 'Quit and reopen Codex Desktop'],
    ['claude-code', 'Start a new Claude Code session'],
    ['claude-desktop', 'Quit and reopen Claude Desktop'],
    ['hermes', 'Hermes Gateway, run `/restart`'],
    ['cursor', 'hot-reload'],
    ['other', 'manual MCP setup'],
  ] as const)('prints the approval, activation, and read-only verification handoff for %s', (runtime, activation) => {
    const output = completionHandoffLines(completedInstall(runtime)).join('\n')

    expect(output).toContain('1. Return to Haven and approve the agent rules.')
    expect(output).toContain('Approval — not restarting — unlocks Haven tools.')
    expect(output).toContain(activation)
    expect(output).toContain('haven_get_agent')
    expect(output).toContain('haven_get_allowances')
    expect(output).toMatch(/Do not sign, fund, or create a payment/i)
    expect(output).not.toContain(PRIVATE_KEY)
    expect(output).not.toContain('sk_agent_supersecret')
  })

  it('gives every incomplete runtime installation one safe retry path', () => {
    const output = completionHandoffLines({
      ...completedInstall('hermes'),
      errorCode: 'runtime_config_write_failed',
    }).join('\n')

    expect(output).toContain('return to Haven for a fresh connection')
    expect(output).toContain('Do not manually edit runtime config')
    expect(output).toContain('paste credentials into prompts, logs, or config')
    expect(output).not.toContain('approve the agent rules')
  })

  it('keeps the manual runtime path actionable after credential setup', () => {
    const output = completionHandoffLines({
      ...completedInstall('other'),
      runtimeMcpMode: 'manual',
      hostedMcpConfigured: false,
      localSignerConfigured: false,
      errorCode: 'manual_runtime_setup_required',
    }).join('\n')

    expect(output).toContain('Finish the manual MCP setup using the secret-free file references printed above')
    expect(output).toContain('haven_get_agent')
    expect(output).not.toContain('fresh connection')
  })

  it('stops before writing credentials when the setup challenge is already expired', async () => {
    const writeCredentials = vi.fn()
    const error = await expectRejection(runConnect({
      setupToken: 'hv_setup_test_expired',
      apiBaseUrl: 'https://api.haven.example',
    }, {
      nodeVersion: SUPPORTED_NODE,
      api: {
        resolveSetup: vi.fn(async () => ({
          setup_id: 'setup-expired',
          status: 'awaiting_connection',
          agent: { name: 'Expired Agent' },
          haven_wallet: { id: 'safe-1', name: 'Main Haven wallet', address: '0x2222222222222222222222222222222222222222', chain_id: 100, network: 'Gnosis' },
          agent_budget: [],
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          challenge: { id: 'challenge-expired', message: 'expired', expires_at: '2000-01-01T00:00:00.000Z' },
        })),
        registerSetup: vi.fn(),
        updateInstallStatus: vi.fn(),
      },
      writeCredentials,
    }))

    expect(error.message).toContain('Return to Haven, start a fresh connection, and rerun Connect')
    expect(writeCredentials).not.toHaveBeenCalled()
  })

  it('fails closed before registration when the setup challenge expiry is malformed', async () => {
    const registerSetup = vi.fn()
    await expect(runConnect({
      setupToken: 'hv_setup_test_invalid_expiry',
      apiBaseUrl: 'https://api.haven.example',
    }, {
      nodeVersion: SUPPORTED_NODE,
      api: {
        resolveSetup: vi.fn(async () => ({
          setup_id: 'setup-invalid', status: 'awaiting_connection', agent: { name: 'Invalid Agent' },
          haven_wallet: { id: 'safe-1', name: 'Main Haven wallet', address: '0x2222222222222222222222222222222222222222', chain_id: 100, network: 'Gnosis' },
          agent_budget: [], hosted_mcp_url: 'https://mcp.haven.example/v1',
          challenge: { id: 'challenge-invalid', message: 'invalid', expires_at: 'not-a-date' },
        })),
        registerSetup,
        updateInstallStatus: vi.fn(),
      },
    })).rejects.toThrow(/expired or invalid/)
    expect(registerSetup).not.toHaveBeenCalled()
  })

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
      // Pinned so the #1161 Node floor cannot make this test host-dependent.
      nodeVersion: SUPPORTED_NODE,
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
          agentPath: '/tmp/haven-connect-test/agent-1/agent.json',
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
    expect(installRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'sk_agent_supersecret',
        hostedMcpUrl: 'https://mcp.haven.example/v1',
        identityPath: '/tmp/haven-connect-test/agent-1/identity.json',
        signerPath: '/tmp/haven-connect-test/agent-1/signer.json',
      }),
      // Progress callback is threaded through so the long install/probe steps
      // emit live heartbeats instead of going silent.
      expect.objectContaining({ onProgress: expect.any(Function) }),
    )

    const output = logs.join('\n')
    expect(output).toContain('Fetched Haven setup for Research Agent')
    expect(output).toContain('Registered signing address with Haven')
    expect(output).not.toContain(PRIVATE_KEY)
    expect(output).not.toContain('sk_agent_supersecret')
    // The connector affirms completion so the agent knows it finished, then
    // states the approval gate explicitly before any restart instruction.
    expect(output).toContain('Haven setup on this machine is complete')
    expect(output).toContain('Approval — not restarting — unlocks Haven tools')
    expect(output).toContain('Start a new Claude Code session')
    expect(output).not.toContain('should appear in your next message')
  })

  describe('unsupported Node.js (#1161)', () => {
    // The gap this closes: the floor was enforced ONLY inside local-MCP
    // installation, reached solely via `--local`. The DEFAULT topology (hosted
    // MCP + local signer) — what nearly every user runs — never touched it, so
    // a full connect on Node v23.1.0 completed "successfully", installed the
    // signer, and signed a real testnet payment. These tests cover the default
    // path specifically, because that is where the hole was.
    const OLD_NODE = '23.1.0'

    /** Every dependency that would record a side effect if the guard let go. */
    function sideEffectSpies() {
      return {
        api: {
          resolveSetup: vi.fn(),
          registerSetup: vi.fn(),
          updateInstallStatus: vi.fn(),
        } as unknown as ConnectApiClient,
        preflightStorage: vi.fn(),
        writeCredentials: vi.fn(),
        installRuntime: vi.fn(),
        generateKey: vi.fn(),
      }
    }

    it('refuses on the DEFAULT path before any side effect', async () => {
      const spies = sideEffectSpies()

      await expect(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'claude-code',
        // No localMcp — this is the default hosted MCP + local signer topology.
      }, { ...spies, nodeVersion: OLD_NODE })).rejects.toThrow(/requires Node\.js >=24\.0\.0/)

      // Nothing may have happened yet: no setup token resolved or consumed, no
      // agent registered, no key minted, no credential written. A failed
      // precondition must not strand a half-created agent or burn a one-shot
      // token (the #1129 discipline).
      expect(spies.api.resolveSetup).not.toHaveBeenCalled()
      expect(spies.api.registerSetup).not.toHaveBeenCalled()
      expect(spies.api.updateInstallStatus).not.toHaveBeenCalled()
      expect(spies.preflightStorage).not.toHaveBeenCalled()
      expect(spies.writeCredentials).not.toHaveBeenCalled()
      expect(spies.installRuntime).not.toHaveBeenCalled()
      expect(spies.generateKey).not.toHaveBeenCalled()
    })

    it('refuses before the --local topology check, so every path is covered', async () => {
      // Ordering matters: the Node floor is a property of the machine, not of
      // the chosen topology, so it must not sit behind a flag-specific branch —
      // that is precisely the mistake being fixed.
      const spies = sideEffectSpies()
      await expect(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'claude-code',
        localMcp: true,
      }, { ...spies, nodeVersion: OLD_NODE })).rejects.toThrow(/requires Node\.js >=24\.0\.0/)
      expect(spies.api.resolveSetup).not.toHaveBeenCalled()
    })

    it('tells the user how to fix it, not just that it is broken', async () => {
      const error = await expectRejection(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'claude-code',
      }, { ...sideEffectSpies(), nodeVersion: OLD_NODE }))

      expect(error.message).toContain(OLD_NODE)
      expect(error.message).toContain('>=24.0.0')
      expect(error.message).toContain('nvm install 24')
      expect(error.message).toMatch(/agent runtime launching Haven/i)
    })

    it('does not affect a supported Node', async () => {
      // The guard must be invisible on >=24 — no behavior change for the
      // overwhelming majority of runs. The run still fails afterwards (the API
      // stubs return nothing), which is the point: it failed LATER, having got
      // past the guard and started real work.
      const spies = sideEffectSpies()
      const error = await expectRejection(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'claude-code',
      }, { ...spies, nodeVersion: '24.0.0' }))

      expect(error.message).not.toMatch(/Node\.js/)
      expect(spies.api.resolveSetup).toHaveBeenCalled()
    })
  })

  it('rejects --local on runtimes that do not support local MCP', async () => {
    await expect(runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'cursor',
      localMcp: true,
    }, { nodeVersion: SUPPORTED_NODE })).rejects.toThrow(/only available for Claude Code and Codex/)
  })

  it('uses the hard-restart copy on desktop GUI runtimes', async () => {
    // Desktop GUI runtimes (Claude Desktop, Codex Desktop) really do need a
    // restart — the MCP server is bound to app launch. The softened copy
    // ("should appear in your next message") is misleading there.
    const logs: string[] = []
    const installRuntime = vi.fn(async () => ({
      runtime: 'claude-desktop' as const,
      runtimeMcpMode: 'local_stdio' as const,
      hostedMcpConfigured: false,
      localSignerConfigured: true,
      localMcpConfigured: true,
      localMcpAcknowledged: true,
      probeResult: 'local_stdio_mcp_ready',
      restartRequired: true,
      nextUserAction: 'return_to_haven_for_wallet_approval_then_restart_app',
      configTarget: 'Claude Desktop MCP config',
      messages: ['Updated Haven MCP entries in Claude Desktop MCP config.'],
    }))
    const api: ConnectApiClient = {
      resolveSetup: vi.fn(async () => ({
        setup_id: 'setup-2',
        status: 'awaiting_connection',
        agent: { name: 'Desktop Agent', description: 'Pays for APIs from a desktop app' },
        haven_wallet: {
          id: 'safe-1',
          name: 'Main Haven wallet',
          address: '0x2222222222222222222222222222222222222222',
          chain_id: 100,
          network: 'Gnosis',
        },
        agent_budget: [],
        hosted_mcp_url: 'https://mcp.haven.example/v1',
        challenge: {
          id: 'challenge-2',
          message: 'Haven Connect Agent 2\nsetup_id: setup-2\nchallenge: def',
          expires_at: '2099-01-01T00:00:00.000Z',
        },
      })),
      registerSetup: vi.fn(async (input) => ({
        setup_id: 'setup-2',
        agent_id: 'agent-2',
        status: 'connected_local',
        agent_status: 'pending_approval',
        api_key_prefix: input.apiKeyPrefix,
        api_key_scope: 'setup_pending',
        delegate_address: input.delegateAddress.toLowerCase(),
        hosted_mcp_url: 'https://mcp.haven.example/v1',
        next_action: 'return_to_haven_for_wallet_approval',
      })),
      updateInstallStatus: vi.fn(async () => undefined),
    }

    await runConnect({
      setupToken: 'hv_setup_test_desktop',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-desktop',
      credentialsDir: '/tmp/haven-connect-test-desktop',
    }, {
      api,
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_desktop',
      preflightStorage: vi.fn(async () => '/tmp/haven-connect-test-desktop'),
      writeCredentials: vi.fn(async () => ({
        directory: '/tmp/haven-connect-test-desktop/agent-2',
        identityPath: '/tmp/haven-connect-test-desktop/agent-2/identity.json',
        signerPath: '/tmp/haven-connect-test-desktop/agent-2/signer.json',
        agentPath: '/tmp/haven-connect-test-desktop/agent-2/agent.json',
      })),
      installRuntime,
      log: (message) => logs.push(message),
    })

    const output = logs.join('\n')
    expect(output).toContain('Quit and reopen Claude Desktop')
    expect(output).not.toContain('should appear in your next message')
  })

  it('still reports completion when the install-status telemetry call fails', async () => {
    // The status report is best-effort and must not gate the user-facing
    // "you're done + next steps" output, nor make runConnect reject.
    const logs: string[] = []
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
        setup_id: 'setup-3',
        status: 'awaiting_connection',
        agent: { name: 'Telemetry Agent', description: 'Pays for APIs' },
        haven_wallet: {
          id: 'safe-1',
          name: 'Main Haven wallet',
          address: '0x2222222222222222222222222222222222222222',
          chain_id: 100,
          network: 'Gnosis',
        },
        agent_budget: [],
        hosted_mcp_url: 'https://mcp.haven.example/v1',
        challenge: {
          id: 'challenge-3',
          message: 'Haven Connect Agent 2\nsetup_id: setup-3\nchallenge: ghi',
          expires_at: '2099-01-01T00:00:00.000Z',
        },
      })),
      registerSetup: vi.fn(async (input) => ({
        setup_id: 'setup-3',
        agent_id: 'agent-3',
        status: 'connected_local',
        agent_status: 'pending_approval',
        api_key_prefix: input.apiKeyPrefix,
        api_key_scope: 'setup_pending',
        delegate_address: input.delegateAddress.toLowerCase(),
        hosted_mcp_url: 'https://mcp.haven.example/v1',
        next_action: 'return_to_haven_for_wallet_approval',
      })),
      updateInstallStatus: vi.fn(async () => {
        throw new Error('network down')
      }),
    }

    const result = await runConnect({
      setupToken: 'hv_setup_test_telemetry',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-connect-test-telemetry',
    }, {
      api,
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_telemetry',
      preflightStorage: vi.fn(async () => '/tmp/haven-connect-test-telemetry'),
      writeCredentials: vi.fn(async () => ({
        directory: '/tmp/haven-connect-test-telemetry/agent-3',
        identityPath: '/tmp/haven-connect-test-telemetry/agent-3/identity.json',
        signerPath: '/tmp/haven-connect-test-telemetry/agent-3/signer.json',
        agentPath: '/tmp/haven-connect-test-telemetry/agent-3/agent.json',
      })),
      installRuntime,
      log: (message) => logs.push(message),
    })

    expect(result.agentId).toBe('agent-3')
    const output = logs.join('\n')
    // Completion + next-steps still printed despite the telemetry failure…
    expect(output).toContain('Haven setup on this machine is complete')
    expect(output).toContain('Approval — not restarting — unlocks Haven tools')
    // …and the failure is surfaced quietly rather than thrown.
    expect(output).toContain('Could not report install status to Haven')
  })
})
