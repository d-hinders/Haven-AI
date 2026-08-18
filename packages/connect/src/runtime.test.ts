import { describe, expect, it, vi } from 'vitest'
import { ConnectRequestError } from './api.js'
import type { ConnectApiClient, ConnectorStatusResponse, RegisterSetupInput, UpdateInstallStatusInput } from './api.js'
import { delegateKeyFromPrivateKey } from './key.js'
import { completionHandoffLines, failedConnectOutcome, runConnect, waitForBudgetApproval } from './runtime.js'
import type { RuntimeInstallResult } from './runtime-install.js'

const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'
// These tests assert connect's behavior, not the machine's Node version. Since
// #1161 runConnect refuses below the floor before doing anything, so every call
// site pins a supported version explicitly — otherwise the suite would pass or
// fail depending on what Node the developer happens to be running.
const SUPPORTED_NODE = '22.0.0'

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

    expect(output).toContain('1. Return to Haven and approve the budget.')
    expect(output).toContain('Approval — not restarting — unlocks Haven tools.')
    // #1542: one name for the one gate — "agent rules" never appears here.
    expect(output).not.toContain('agent rules')
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
    expect(output).not.toContain('approve the budget')
  })

  // #1542: the handoff reflects what the approval wait observed — the connector
  // must never celebrate the approval and then instruct the user to perform it.
  it('confirms instead of re-requesting approval when the budget was approved during the wait', () => {
    const output = completionHandoffLines(completedInstall('claude-code'), 'approved').join('\n')

    expect(output).toContain('the budget is already approved')
    expect(output).not.toContain('Return to Haven')
    expect(output).not.toContain('approve the budget')
    // The remaining steps renumber from 1 and stay actionable.
    expect(output).toContain('1. Start a new Claude Code session')
    expect(output).toContain('haven_get_agent')
  })

  it('keeps the full approve instruction when the wait timed out still pending', () => {
    const output = completionHandoffLines(completedInstall('claude-code'), 'pending').join('\n')

    expect(output).toContain('1. Return to Haven and approve the budget.')
  })

  it('does not ask the user to approve a setup that already ended in Haven', () => {
    const output = completionHandoffLines(completedInstall('claude-code'), 'ended').join('\n')

    expect(output).not.toContain('approve the budget')
    expect(output).toContain('start a fresh connection from the dashboard')
  })

  // #1542: the restart step explains why it survives the connector's own
  // verification — but only where a restart is genuinely required. Hot-reload
  // runtimes keep their registry copy, which already says no restart is needed.
  it.each([
    ['claude-code', 'only reads MCP config when a session starts'],
    ['claude-desktop', 'only reads MCP config at app launch'],
  ] as const)('says why %s still needs a restart after in-process verification', (runtime, why) => {
    const output = completionHandoffLines(completedInstall(runtime)).join('\n')

    expect(output).toContain('already written and verified')
    expect(output).toContain(why)
  })

  it('adds no restart rationale on hot-reload runtimes', () => {
    const output = completionHandoffLines(completedInstall('cursor')).join('\n')

    expect(output).toContain('no app restart is required')
    expect(output).not.toContain('already written and verified')
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
        getConnectorStatus: vi.fn(),
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
        getConnectorStatus: vi.fn(),
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
      getConnectorStatus: vi.fn(),
    }

    const result = await runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-connect-test',
      // The approval poll has its own suite below; keep this test focused.
      waitForApproval: false,
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
      redactPaths: true,
    })

    expect(result.agentId).toBe('agent-1')
    expect(result.outcome).toMatchObject({
      schema_version: 1,
      outcome: 'complete',
      runtime: 'claude-code',
      topology: 'local_stdio',
      configuration: { hosted_mcp: false, local_signer: true, local_mcp: true },
      approval: { required: true },
      verification: { tools: ['haven_get_agent', 'haven_get_allowances'] },
    })
    expect(JSON.stringify(result.outcome)).not.toContain(PRIVATE_KEY)
    expect(JSON.stringify(result.outcome)).not.toContain('sk_agent_supersecret')
    expect(JSON.stringify(result.outcome)).not.toContain('/tmp/haven-connect-test')
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
    expect(output).not.toContain('/tmp/haven-connect-test/agent-1')
    // The connector affirms completion so the agent knows it finished, then
    // states the approval gate explicitly before any restart instruction.
    expect(output).toContain('Haven setup on this machine is complete')
    expect(output).toContain('Approval — not restarting — unlocks Haven tools')
    expect(output).toContain('Start a new Claude Code session')
    expect(output).not.toContain('should appear in your next message')
  })

  it('builds a stable, redacted failure outcome for CLI serialization', () => {
    const result = failedConnectOutcome('codex-cli', new Error(
      'This Haven setup challenge is expired or invalid. Do not use sk_agent_supersecret at /tmp/secret',
    ))
    expect(result).toMatchObject({
      schema_version: 1,
      outcome: 'failed',
      runtime: 'codex-cli',
      error: { code: 'setup_challenge_expired_or_invalid', next_action: 'return_to_haven_for_fresh_setup' },
    })
    expect(JSON.stringify(result)).not.toContain('sk_agent_supersecret')
    expect(JSON.stringify(result)).not.toContain('/tmp/secret')
  })

  describe('unsupported Node.js (#1161)', () => {
    // The gap this closes: the floor was enforced ONLY inside local-MCP
    // installation, reached solely via `--local`. The DEFAULT topology (hosted
    // MCP + local signer) — what nearly every user runs — never touched it, so
    // a full connect on Node v23.1.0 completed "successfully", installed the
    // signer, and signed a real testnet payment. These tests cover the default
    // path specifically, because that is where the hole was.
    const OLD_NODE = '21.1.0'

    /** Every dependency that would record a side effect if the guard let go. */
    function sideEffectSpies() {
      return {
        api: {
          resolveSetup: vi.fn(),
          registerSetup: vi.fn(),
          updateInstallStatus: vi.fn(),
          getConnectorStatus: vi.fn(),
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
      }, { ...spies, nodeVersion: OLD_NODE })).rejects.toThrow(/requires Node\.js >=22\.0\.0/)

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
      }, { ...spies, nodeVersion: OLD_NODE })).rejects.toThrow(/requires Node\.js >=22\.0\.0/)
      expect(spies.api.resolveSetup).not.toHaveBeenCalled()
    })

    it('tells the user how to fix it, not just that it is broken', async () => {
      const error = await expectRejection(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'claude-code',
      }, { ...sideEffectSpies(), nodeVersion: OLD_NODE }))

      expect(error.message).toContain(OLD_NODE)
      expect(error.message).toContain('>=22.0.0')
      expect(error.message).toContain('nvm install 22')
      expect(error.message).toMatch(/agent runtime launching Haven/i)
    })

    it('does not affect a supported Node', async () => {
      // The guard must be invisible on >=22 — no behavior change for the
      // overwhelming majority of runs. The run still fails afterwards (the API
      // stubs return nothing), which is the point: it failed LATER, having got
      // past the guard and started real work.
      const spies = sideEffectSpies()
      const error = await expectRejection(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'claude-code',
      }, { ...spies, nodeVersion: '22.0.0' }))

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
      getConnectorStatus: vi.fn(),
    }

    await runConnect({
      setupToken: 'hv_setup_test_desktop',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-desktop',
      credentialsDir: '/tmp/haven-connect-test-desktop',
      waitForApproval: false,
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
    const lifecycleCalls: string[] = []
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
        lifecycleCalls.push('report-install-status')
        throw new Error('network down')
      }),
      getConnectorStatus: vi.fn(async () => {
        lifecycleCalls.push('poll-budget-approval')
        return { status: 'active', approved_budget: null }
      }),
    }

    const result = await runConnect({
      setupToken: 'hv_setup_test_telemetry',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-connect-test-telemetry',
      approvalWait: { sleep: async () => {} },
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
    // (the mock approves on the first poll, so the handoff takes its #1542
    // approved shape: confirmation, not an approve instruction)
    expect(output).toContain('Haven setup on this machine is complete')
    expect(output).toContain('the budget is already approved')
    // …and the failure is surfaced quietly rather than thrown.
    expect(output).toContain('Could not report install status to Haven')
    // A failed readiness report is non-authoritative and must not leave the
    // normal connector flow stranded before its bounded approval wait.
    expect(lifecycleCalls).toEqual(['report-install-status', 'poll-budget-approval'])
    expect(output).toContain('Budget approved 🎉')
  })
})

describe('waitForBudgetApproval (#1377 D)', () => {
  // Base USDC — resolvable in the shared token registry, so the celebration
  // can name a human amount instead of atomic units.
  const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
  const noSleep = async () => {}

  it('prints progress while pending and a celebratory line naming amount, token, and period on approval', async () => {
    const logs: string[] = []
    const getConnectorStatus = vi.fn<(setupId: string, apiKey: string) => Promise<ConnectorStatusResponse>>()
    getConnectorStatus
      .mockResolvedValueOnce({ status: 'pending_approval', approved_budget: null })
      .mockResolvedValueOnce({ status: 'pending_approval', approved_budget: null })
      .mockResolvedValueOnce({
        status: 'active',
        approved_budget: { token_symbol: 'USDC', token_address: BASE_USDC, amount: '25000000', reset_period_min: 1440 },
      })

    const outcome = await waitForBudgetApproval(
      { getConnectorStatus }, 'setup-1', 'sk_agent_supersecret',
      (message) => logs.push(message), { sleep: noSleep },
    )

    expect(outcome).toBe('approved')
    expect(getConnectorStatus).toHaveBeenCalledTimes(3)
    expect(getConnectorStatus).toHaveBeenCalledWith('setup-1', 'sk_agent_supersecret')
    const output = logs.join('\n')
    expect(output).toContain('waiting for you to approve the budget')
    expect(output).toContain('Budget approved 🎉 — I can now spend up to 25 USDC per day from your Haven wallet.')
  })

  // #1426: the celebration line must phrase every period the DASHBOARD offers
  // with the dashboard's own sentence words — "per 10080 minutes" next to
  // "per week" made the user do arithmetic on a reassurance message. One
  // voice, dashboard's sentence form wins ("in total" for one-time, not
  // "with no automatic reset"). One case per RESET_PERIODS value + the
  // legacy-only hourly + the arbitrary fallback.
  it.each([
    [1440, 'per day'],
    [10080, 'per week'],
    [43200, 'per month'],
    [0, 'in total'],
    [60, 'per hour'],
    [90, 'every 90 minutes'],
  ])('phrases a %i-minute reset as "%s" — matching the dashboard voice (#1426)', async (resetPeriodMin, phrase) => {
    const logs: string[] = []
    const getConnectorStatus = vi.fn(async () => ({
      status: 'active' as const,
      approved_budget: { token_symbol: 'USDC', token_address: BASE_USDC, amount: '25000000', reset_period_min: resetPeriodMin },
    }))

    await waitForBudgetApproval(
      { getConnectorStatus }, 'setup-1', 'sk_agent_supersecret',
      (message) => logs.push(message), { sleep: noSleep },
    )

    expect(logs.join('\n')).toContain(`I can now spend up to 25 USDC ${phrase} from your Haven wallet.`)
    // The raw-minutes shape must never resurface for a dashboard-offered period.
    if ([0, 1440, 10080, 43200].includes(resetPeriodMin)) {
      expect(logs.join('\n')).not.toMatch(/\d+ minutes/)
    }
  })

  // #1542: users routinely approve while the runtime install is still running.
  // The first check is immediate and precedes the announcement, so an
  // already-approved budget never produces the contradictory adjacent pair
  // "waiting for you to approve… / Budget approved 🎉".
  it('never prints the waiting line when the budget is already approved at poll start', async () => {
    const logs: string[] = []
    const getConnectorStatus = vi.fn(async () => ({
      status: 'active' as const,
      approved_budget: { token_symbol: 'USDC', token_address: BASE_USDC, amount: '3000000', reset_period_min: 1440 },
    }))
    const sleep = vi.fn(async () => {})

    const outcome = await waitForBudgetApproval(
      { getConnectorStatus }, 'setup-1', 'sk_agent_key',
      (message) => logs.push(message), { sleep },
    )

    expect(outcome).toBe('approved')
    expect(getConnectorStatus).toHaveBeenCalledTimes(1)
    // Immediate first check: no pacing sleep before it, no waiting line.
    expect(sleep).not.toHaveBeenCalled()
    const output = logs.join('\n')
    expect(output).not.toContain('waiting for you to approve')
    expect(output).toContain('Budget approved 🎉 — I can now spend up to 3 USDC per day from your Haven wallet.')
  })

  it('always terminates on its own: exits pending with guidance at the timeout bound', async () => {
    const logs: string[] = []
    const getConnectorStatus = vi.fn(async () => ({ status: 'pending_approval', approved_budget: null }))

    const outcome = await waitForBudgetApproval(
      { getConnectorStatus }, 'setup-1', 'sk_agent_key',
      (message) => logs.push(message),
      { sleep: noSleep, intervalMs: 5_000, timeoutMs: 180_000 },
    )

    expect(outcome).toBe('pending')
    // 180s / 5s = the stated bound of 36 polls, then a clean exit — never a hang.
    expect(getConnectorStatus).toHaveBeenCalledTimes(36)
    const output = logs.join('\n')
    expect(output).toContain('Still waiting for budget approval in Haven…')
    expect(output).toContain('Budget approval is still pending in Haven.')
    expect(output).toContain('haven_get_agent')
  })

  it('stops with guidance when the setup reaches a terminal status in Haven', async () => {
    const logs: string[] = []
    const getConnectorStatus = vi.fn(async () => ({ status: 'cancelled', approved_budget: null }))

    const outcome = await waitForBudgetApproval(
      { getConnectorStatus }, 'setup-1', 'sk_agent_key',
      (message) => logs.push(message), { sleep: noSleep },
    )

    expect(outcome).toBe('ended')
    expect(getConnectorStatus).toHaveBeenCalledTimes(1)
    expect(logs.join('\n')).toContain('This setup ended in Haven (cancelled)')
  })

  it('tolerates flaky polls inside the bound instead of giving up', async () => {
    const logs: string[] = []
    const getConnectorStatus = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValueOnce({
        status: 'active',
        approved_budget: { token_symbol: 'USDC', token_address: BASE_USDC, amount: '10000000', reset_period_min: 0 },
      })

    const outcome = await waitForBudgetApproval(
      { getConnectorStatus }, 'setup-1', 'sk_agent_key',
      (message) => logs.push(message), { sleep: noSleep },
    )

    expect(outcome).toBe('approved')
    // #1426: one voice with the dashboard — its sentence form says "in total".
    expect(logs.join('\n')).toContain('10 USDC in total')
  })

  it('falls back to atomic units without crashing when the token is not in the registry', async () => {
    const logs: string[] = []
    const getConnectorStatus = vi.fn(async () => ({
      status: 'active',
      approved_budget: {
        token_symbol: 'MYSTERY',
        token_address: '0x000000000000000000000000000000000000dead',
        amount: '123',
        reset_period_min: 60,
      },
    }))

    const outcome = await waitForBudgetApproval(
      { getConnectorStatus }, 'setup-1', 'sk_agent_key',
      (message) => logs.push(message), { sleep: noSleep },
    )

    expect(outcome).toBe('approved')
    expect(logs.join('\n')).toContain('123 MYSTERY (atomic units) per hour')
  })


  it('treats a 401 as a verdict — the setup was cancelled and the key revoked, not a flaky poll', async () => {
    const logs: string[] = []
    const getConnectorStatus = vi.fn()
      .mockRejectedValueOnce(new ConnectRequestError('Haven setup request failed: unauthorized', 401))

    const outcome = await waitForBudgetApproval(
      { getConnectorStatus }, 'setup-1', 'sk_agent_key',
      (message) => logs.push(message), { sleep: noSleep },
    )

    expect(outcome).toBe('ended')
    expect(getConnectorStatus).toHaveBeenCalledTimes(1)
    expect(logs.join('\n')).toContain('This setup ended in Haven')
    expect(logs.join('\n')).not.toContain('still pending')
  })

  it('treats a 404 as a verdict while still retrying genuine 5xx noise', async () => {
    const logs: string[] = []
    const getConnectorStatus = vi.fn()
      .mockRejectedValueOnce(new ConnectRequestError('Haven setup request failed: 502 Bad Gateway', 502))
      .mockRejectedValueOnce(new ConnectRequestError('Haven setup request failed: not found', 404))

    const outcome = await waitForBudgetApproval(
      { getConnectorStatus }, 'setup-1', 'sk_agent_key',
      (message) => logs.push(message), { sleep: noSleep },
    )

    expect(outcome).toBe('ended')
    expect(getConnectorStatus).toHaveBeenCalledTimes(2)
  })

  it('runConnect polls after registering by default and forwards approvalWait overrides', async () => {
    const logs: string[] = []
    const lifecycleCalls: string[] = []
    const getConnectorStatus = vi.fn(async () => {
      lifecycleCalls.push('poll-budget-approval')
      return {
        status: 'active',
        approved_budget: { token_symbol: 'USDC', token_address: BASE_USDC, amount: '25000000', reset_period_min: 1440 },
      }
    })
    await runConnect({
      setupToken: 'hv_setup_test_wait',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-connect-test-wait',
      approvalWait: { sleep: noSleep },
    }, {
      api: {
        resolveSetup: vi.fn(async () => ({
          setup_id: 'setup-4',
          status: 'awaiting_connection',
          agent: { name: 'Waiting Agent' },
          haven_wallet: { id: 'safe-1', name: 'Main Haven wallet', address: '0x2222222222222222222222222222222222222222', chain_id: 8453, network: 'Base' },
          agent_budget: [],
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          challenge: { id: 'challenge-4', message: 'Haven Connect Agent 2\nsetup_id: setup-4\nchallenge: jkl', expires_at: '2099-01-01T00:00:00.000Z' },
        })),
        registerSetup: vi.fn(async (input) => ({
          setup_id: 'setup-4',
          agent_id: 'agent-4',
          status: 'connected_local',
          agent_status: 'pending_approval',
          api_key_prefix: input.apiKeyPrefix,
          api_key_scope: 'setup_pending',
          delegate_address: input.delegateAddress.toLowerCase(),
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          next_action: 'return_to_haven_for_wallet_approval',
        })),
        updateInstallStatus: vi.fn(async () => {
          lifecycleCalls.push('report-install-status')
        }),
        getConnectorStatus,
      },
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_waitkey',
      preflightStorage: vi.fn(async () => '/tmp/haven-connect-test-wait'),
      writeCredentials: vi.fn(async () => ({
        directory: '/tmp/haven-connect-test-wait/agent-4',
        identityPath: '/tmp/haven-connect-test-wait/agent-4/identity.json',
        signerPath: '/tmp/haven-connect-test-wait/agent-4/signer.json',
        agentPath: '/tmp/haven-connect-test-wait/agent-4/agent.json',
      })),
      installRuntime: vi.fn(async () => completedInstall('claude-code')),
      log: (message) => logs.push(message),
    })

    // Polls with the REGISTERED key (the setup_pending-scoped one it just minted).
    expect(getConnectorStatus).toHaveBeenCalledWith('setup-4', 'sk_agent_waitkey')
    // The dashboard only exposes the approval controls after this report. It
    // must settle before the connector's first approval poll, or both sides
    // wait on each other until the bounded poll window ends (#1386).
    expect(lifecycleCalls).toEqual(['report-install-status', 'poll-budget-approval'])
    const output = logs.join('\n')
    expect(output).toContain('Budget approved 🎉')
    // #1542 end to end: the approval observed by the wait shapes the printed
    // next steps — an approved budget is confirmed, never re-requested, and
    // the already-over wait is never announced.
    expect(output).not.toContain('waiting for you to approve')
    expect(output).not.toContain('Return to Haven')
    expect(output).toContain('the budget is already approved')
  })
})
