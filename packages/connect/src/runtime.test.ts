import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectRequestError } from './api.js'
import type { ConnectApiClient, ConnectorStatusResponse, RegisterSetupInput, UpdateInstallStatusInput } from './api.js'
import { delegateKeyFromPrivateKey } from './key.js'
import { completionHandoffLines, failedConnectOutcome, runConnect, waitForBudgetApproval } from './runtime.js'
import type { ConnectDeps } from './runtime.js'
import { CONNECT_OUTCOME_FILENAME } from './storage.js'
import { ConnectError } from './connect-error.js'
import { RUNTIME_FLAG_VALUE_LIST } from './runtime-registry.js'
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
      runtime: 'claude-code',
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
        getAgentIdentity: vi.fn(),
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
      runtime: 'claude-code',
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
        getAgentIdentity: vi.fn(),
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
      getAgentIdentity: vi.fn(),
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
          getAgentIdentity: vi.fn(),
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
    // env: {} — the test host may itself be an agent shell (CLAUDECODE=1),
    // where #1672's detection would override the explicit cursor hint.
    await expect(runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'cursor',
      localMcp: true,
    }, { nodeVersion: SUPPORTED_NODE, env: {} })).rejects.toThrow(/only available for Claude Code and Codex/)
  })

  describe('detection-first runtime resolution (#1672)', () => {
    function resolutionSpies() {
      return {
        api: {
          resolveSetup: vi.fn(),
          registerSetup: vi.fn(),
          updateInstallStatus: vi.fn(),
          getConnectorStatus: vi.fn(),
          getAgentIdentity: vi.fn(),
        } as unknown as ConnectApiClient,
        preflightStorage: vi.fn(),
        writeCredentials: vi.fn(),
        installRuntime: vi.fn(),
        generateKey: vi.fn(),
      }
    }

    it('detection overrides a contradicting --runtime hint, with a printed notice', async () => {
      const logs: string[] = []
      const spies = resolutionSpies()
      // The run still fails later (stub API returns nothing) — the assertions
      // are about what happened BEFORE that: the notice and the resolved value.
      await expectRejection(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'claude-desktop',
      }, { ...spies, nodeVersion: SUPPORTED_NODE, env: { CLAUDECODE: '1' }, log: (m) => logs.push(m) }))

      expect(spies.api.resolveSetup).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'claude-code' }))
      expect(logs.some((m) => m.includes('detected; ignoring the claude-desktop hint'))).toBe(true)
    })

    it('--runtime-force wins over detection', async () => {
      const spies = resolutionSpies()
      await expectRejection(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtimeForce: 'claude-desktop',
      }, { ...spies, nodeVersion: SUPPORTED_NODE, env: { CLAUDECODE: '1' } }))

      expect(spies.api.resolveSetup).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'claude-desktop' }))
    })

    it('refuses before any side effect when nothing is detected and no --runtime is given', async () => {
      const spies = resolutionSpies()
      await expect(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
      }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {} })).rejects.toThrow(/Could not determine the agent runtime/)

      // The #1161 discipline: refusal must not burn the setup token.
      expect(spies.api.resolveSetup).not.toHaveBeenCalled()
      expect(spies.writeCredentials).not.toHaveBeenCalled()
      expect(spies.generateKey).not.toHaveBeenCalled()
    })

    it('refuses an unknown --runtime-force value, naming the valid ones', async () => {
      const spies = resolutionSpies()
      await expect(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtimeForce: 'not-a-runtime',
      }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {} })).rejects.toThrow(/Unknown --runtime-force value "not-a-runtime"/)
      expect(spies.api.resolveSetup).not.toHaveBeenCalled()
    })

    it('an explicit --runtime in a plain terminal (no detection) still applies as given', async () => {
      const spies = resolutionSpies()
      await expectRejection(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'claude-desktop',
      }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {} }))

      expect(spies.api.resolveSetup).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'claude-desktop' }))
    })

    // #1719: every rung added below the detection rungs is a new way for the
    // connection step to fail. Each of these asserts the SAME #1161 property
    // the original refusal had — the failure happens before the setup token is
    // resolved, before a key is minted, and before a credential is written, so
    // there is no half-connected agent to recover from.
    describe('self-resolving ladder (#1719)', () => {
      function expectNothingWritten(spies: ReturnType<typeof resolutionSpies>): void {
        expect(spies.api.resolveSetup).not.toHaveBeenCalled()
        expect(spies.api.registerSetup).not.toHaveBeenCalled()
        expect(spies.generateKey).not.toHaveBeenCalled()
        expect(spies.writeCredentials).not.toHaveBeenCalled()
        expect(spies.installRuntime).not.toHaveBeenCalled()
      }

      it('asks an interactive terminal which installed client to configure', async () => {
        const spies = resolutionSpies()
        const promptRuntime = vi.fn(async () => 'claude-desktop' as const)
        await expectRejection(runConnect({
          setupToken: 'hv_setup_test',
          apiBaseUrl: 'https://api.haven.example',
          interactive: true,
        }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {}, isTty: true, promptRuntime }))

        expect(promptRuntime).toHaveBeenCalledTimes(1)
        expect(spies.api.resolveSetup).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'claude-desktop' }))
      })

      it('skips the prompt entirely when stdin is not a TTY', async () => {
        const spies = resolutionSpies()
        const promptRuntime = vi.fn(async () => 'claude-desktop' as const)
        const error = await expectRejection(runConnect({
          setupToken: 'hv_setup_test',
          apiBaseUrl: 'https://api.haven.example',
          interactive: true,
        }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {}, isTty: false, promptRuntime }))

        expect(promptRuntime).not.toHaveBeenCalled()
        expect((error as ConnectError).code).toBe('runtime_undetermined')
        expectNothingWritten(spies)
      })

      it('skips the prompt entirely for a non-interactive run', async () => {
        const spies = resolutionSpies()
        const promptRuntime = vi.fn(async () => 'claude-desktop' as const)
        const error = await expectRejection(runConnect({
          setupToken: 'hv_setup_test',
          apiBaseUrl: 'https://api.haven.example',
        }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {}, isTty: true, promptRuntime }))

        expect(promptRuntime).not.toHaveBeenCalled()
        expect((error as ConnectError).code).toBe('runtime_undetermined')
        expectNothingWritten(spies)
      })

      it('makes the no-runtime refusal actionable for the agent running it', async () => {
        const spies = resolutionSpies()
        const error = await expectRejection(runConnect({
          setupToken: 'hv_setup_test',
          apiBaseUrl: 'https://api.haven.example',
        }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {} }))

        expect(error.message).toContain('If you are an AI agent running this command')
        expect(error.message).toContain('--runtime <name>')
        expect(error.message).toContain('Do not guess')
        expect(error.message).toContain('--runtime other')
        expect(error.message).toContain('setup token is still unused')
        // #2091: the values ride structurally too — the --json contract
        // discards prose, and the backend's setup prompt only permits a retry
        // drawn from "the values that refusal lists".
        expect((error as ConnectError).details.allowedRuntimes).toEqual([
          'claude-code', 'codex-cli', 'codex-desktop', 'cursor', 'vscode',
          'vscode-insiders', 'claude-desktop', 'hermes', 'other',
        ])
      })

      it('accepts an agent self-report at hint precedence', async () => {
        const spies = resolutionSpies()
        await expectRejection(runConnect({
          setupToken: 'hv_setup_test',
          apiBaseUrl: 'https://api.haven.example',
          runtimeSelfReport: 'openclaw',
        }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {} }))

        expect(spies.api.resolveSetup).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'other' }))
      })

      it('MUTATION PROOF: an aborted prompt writes nothing at all', async () => {
        const spies = resolutionSpies()
        const error = await expectRejection(runConnect({
          setupToken: 'hv_setup_test',
          apiBaseUrl: 'https://api.haven.example',
          interactive: true,
        }, {
          ...spies,
          nodeVersion: SUPPORTED_NODE,
          env: {},
          isTty: true,
          promptRuntime: async () => {
            throw new ConnectError('runtime_prompt_aborted', 'cancelled', 'rerun_connect_and_choose_a_runtime')
          },
        }))

        expect((error as ConnectError).code).toBe('runtime_prompt_aborted')
        expectNothingWritten(spies)
      })

      it('MUTATION PROOF: an unrecognised runtime writes nothing at all', async () => {
        const spies = resolutionSpies()
        const error = await expectRejection(runConnect({
          setupToken: 'hv_setup_test',
          apiBaseUrl: 'https://api.haven.example',
          runtime: 'clawed-code',
        }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {} }))

        expect((error as ConnectError).code).toBe('runtime_unrecognized')
        expectNothingWritten(spies)
      })

      it('says so out loud when detection carried an unrecognised hint', async () => {
        const logs: string[] = []
        const spies = resolutionSpies()
        await expectRejection(runConnect({
          setupToken: 'hv_setup_test',
          apiBaseUrl: 'https://api.haven.example',
          runtime: 'clawed-code',
        }, { ...spies, nodeVersion: SUPPORTED_NODE, env: { CLAUDECODE: '1' }, log: (m) => logs.push(m) }))

        expect(logs.some((m) => m.includes('"clawed-code" is not a runtime Haven knows'))).toBe(true)
        expect(spies.api.resolveSetup).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'claude-code' }))
      })
    })
  })

  describe('failure vocabulary (#1719)', () => {
    it('reads a ConnectError code and next action instead of guessing from prose', () => {
      const outcome = failedConnectOutcome(
        undefined,
        new ConnectError('runtime_no_installed_clients', 'nothing installed', 'rerun_connect_with_explicit_runtime'),
      )

      expect(outcome.outcome).toBe('failed')
      expect(outcome.error).toEqual({
        code: 'runtime_no_installed_clients',
        next_action: 'rerun_connect_with_explicit_runtime',
        message: 'nothing installed',
      })
      expect(outcome.next_action).toBe('rerun_connect_with_explicit_runtime')
    })

    it('still classifies the older plain-Error refusals it always did', () => {
      const outcome = failedConnectOutcome(undefined, new Error('Haven Connect requires Node.js >= 22.0.0'))
      expect(outcome.error?.code).toBe('unsupported_node_version')
      // A plain Error's message stays OUT of the JSON record — only the
      // connector-authored ConnectError vocabulary is safe to serialize.
      expect(outcome.error?.message).toBeUndefined()
    })

    // #2091, the Codex field deadlock: a --json run in an undetected runtime
    // got { code, next_action } and nothing else, while the backend's setup
    // prompt only permits a retry "using one of the values that refusal
    // lists". The record must carry the values and the prose.
    it('carries allowed_runtimes and the redacted message on a runtime refusal', () => {
      const outcome = failedConnectOutcome(
        undefined,
        new ConnectError(
          'runtime_undetermined',
          'Could not determine the agent runtime. Nothing was written and the Haven setup token is still unused.',
          'rerun_connect_with_explicit_runtime',
          { allowedRuntimes: RUNTIME_FLAG_VALUE_LIST },
        ),
      )

      expect(outcome.error).toEqual({
        code: 'runtime_undetermined',
        next_action: 'rerun_connect_with_explicit_runtime',
        message: 'Could not determine the agent runtime. Nothing was written and the Haven setup token is still unused.',
        allowed_runtimes: [
          'claude-code', 'codex-cli', 'codex-desktop', 'cursor', 'vscode',
          'vscode-insiders', 'claude-desktop', 'hermes', 'other',
        ],
      })
    })

    it('redacts secrets and credential paths from a serialized ConnectError message', () => {
      const outcome = failedConnectOutcome(
        undefined,
        new ConnectError(
          'runtime_undetermined',
          'refused; saw sk_agent_supersecret near /Users/x/.haven/agents/a/signer.json',
          'rerun_connect_with_explicit_runtime',
        ),
      )
      const serialized = JSON.stringify(outcome)
      expect(serialized).not.toContain('sk_agent_supersecret')
      expect(serialized).not.toContain('signer.json')
      expect(outcome.error?.message).toContain('[credential-file-redacted]')
    })
  })

  // #2091 field follow-up: the sanctioned --runtime codex retry then failed at
  // resolveSetup on a 30-minute-expired token, and the backend's "Setup token
  // expired" wording matched neither branch of the legacy expiry regex — the
  // agent got generic connect_failed with nothing to act on. The failure mode
  // joins the ConnectError vocabulary (#1719) instead of that ladder.
  describe('dead setup token at resolveSetup (#2091)', () => {
    it.each([410, 401] as const)('classifies a %d from resolveSetup as an expired/invalid setup token', async (status) => {
      const spies = {
        api: {
          resolveSetup: vi.fn().mockRejectedValue(
            new ConnectRequestError(`Haven setup request failed: ${status === 410 ? 'Setup token expired' : 'Invalid setup token'}`, status),
          ),
          registerSetup: vi.fn(),
          updateInstallStatus: vi.fn(),
          getConnectorStatus: vi.fn(),
          getAgentIdentity: vi.fn(),
        } as unknown as ConnectApiClient,
        preflightStorage: vi.fn(),
        writeCredentials: vi.fn(),
        installRuntime: vi.fn(),
        generateKey: vi.fn(),
      }
      const error = await expectRejection(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'codex-cli',
      }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {} }))

      expect((error as ConnectError).code).toBe('setup_challenge_expired_or_invalid')
      expect((error as ConnectError).nextAction).toBe('return_to_haven_for_fresh_setup')
      expect(error.message).toContain('Return to Haven')
      expect(spies.api.registerSetup).not.toHaveBeenCalled()
      expect(spies.writeCredentials).not.toHaveBeenCalled()

      const outcome = failedConnectOutcome('codex-cli', error)
      expect(outcome.error?.code).toBe('setup_challenge_expired_or_invalid')
      expect(outcome.next_action).toBe('return_to_haven_for_fresh_setup')
    })

    it('does not swallow an unrelated request failure into the expiry verdict', async () => {
      const spies = {
        api: {
          resolveSetup: vi.fn().mockRejectedValue(
            new ConnectRequestError('Haven setup request failed: 502 Bad Gateway', 502),
          ),
          registerSetup: vi.fn(),
          updateInstallStatus: vi.fn(),
          getConnectorStatus: vi.fn(),
          getAgentIdentity: vi.fn(),
        } as unknown as ConnectApiClient,
        preflightStorage: vi.fn(),
        writeCredentials: vi.fn(),
        installRuntime: vi.fn(),
        generateKey: vi.fn(),
      }
      const error = await expectRejection(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'codex-cli',
      }, { ...spies, nodeVersion: SUPPORTED_NODE, env: {} }))

      expect(error).toBeInstanceOf(ConnectRequestError)
      expect(failedConnectOutcome('codex-cli', error).error?.code).toBe('connect_failed')
    })

    // Review finding on this PR: the token can also die in the gap between
    // resolve and register (register runs after detection, key generation and
    // any prompt — well inside the 30-minute TTL race), and the backend's 410
    // wording carries no "challenge" for the legacy register-side regex.
    it('classifies a 410 from registerSetup the same way, before any local write', async () => {
      const writeCredentials = vi.fn()
      const installRuntime = vi.fn()
      const error = await expectRejection(runConnect({
        setupToken: 'hv_setup_register_expiry',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'codex-cli',
        credentialsDir: '/tmp/haven-connect-test-register-expiry',
      }, {
        api: {
          resolveSetup: vi.fn(async () => ({
            setup_id: 'setup-8',
            status: 'awaiting_connection',
            agent: { name: 'Expiry Agent' },
            haven_wallet: { id: 'safe-1', name: 'Main Haven wallet', address: '0x2222222222222222222222222222222222222222', chain_id: 8453, network: 'Base' },
            agent_budget: [],
            hosted_mcp_url: 'https://mcp.haven.example/v1',
            challenge: { id: 'challenge-8', message: 'Haven Connect Agent 2\nsetup_id: setup-8\nchallenge: vwx', expires_at: '2099-01-01T00:00:00.000Z' },
          })),
          registerSetup: vi.fn(async () => {
            throw new ConnectRequestError('Haven setup request failed: Setup token expired', 410)
          }),
          updateInstallStatus: vi.fn(),
          getConnectorStatus: vi.fn(),
          getAgentIdentity: vi.fn(),
        } as unknown as ConnectApiClient,
        nodeVersion: SUPPORTED_NODE,
        generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
        generateApiKey: () => 'sk_agent_expirykey',
        preflightStorage: vi.fn(),
        writeCredentials,
        installRuntime,
        log: () => undefined,
      }))

      expect((error as ConnectError).code).toBe('setup_challenge_expired_or_invalid')
      expect((error as ConnectError).nextAction).toBe('return_to_haven_for_fresh_setup')
      expect(writeCredentials).not.toHaveBeenCalled()
      expect(installRuntime).not.toHaveBeenCalled()
    })
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
      getAgentIdentity: vi.fn(),
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
      getAgentIdentity: vi.fn(),
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

  // #1544 re-run characterization: re-running an already-consumed setup
  // command fails CLEANLY before any credential write or runtime-config
  // change, so a re-run can never clobber, rotate, or orphan the workspace's
  // existing local state. The backend gates BOTH resolve and register on
  // `awaiting_connection` (routes/agent-connection-setups.ts), so the common
  // re-run refusal lands at RESOLVE; the register-side refusal only occurs in
  // a concurrent-run race. Both shapes are pinned. (A fresh key pair is
  // minted in memory for a rejected register attempt; on refusal it is
  // discarded, never persisted.)
  it('a re-run of a consumed setup is refused at resolve, before any local write', async () => {
    const writeCredentials = vi.fn()
    const installRuntime = vi.fn()
    const registerSetup = vi.fn()
    await expect(runConnect({
      setupToken: 'hv_setup_test_rerun',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-connect-test-rerun',
    }, {
      api: {
        resolveSetup: vi.fn(async () => {
          throw new ConnectRequestError('Haven setup request failed: setup is not awaiting connection', 409)
        }),
        registerSetup,
        updateInstallStatus: vi.fn(),
        getConnectorStatus: vi.fn(),
        getAgentIdentity: vi.fn(),
      },
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_rerunkey',
      preflightStorage: vi.fn(async () => '/tmp/haven-connect-test-rerun'),
      writeCredentials,
      installRuntime,
      log: () => undefined,
    })).rejects.toThrow(/not awaiting connection/)

    expect(registerSetup).not.toHaveBeenCalled()
    expect(writeCredentials).not.toHaveBeenCalled()
    expect(installRuntime).not.toHaveBeenCalled()
  })

  it('a registration race on a still-pending setup also fails before any local write', async () => {
    const writeCredentials = vi.fn()
    const installRuntime = vi.fn()
    await expect(runConnect({
      setupToken: 'hv_setup_test_rerun_race',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-connect-test-rerun-race',
    }, {
      api: {
        resolveSetup: vi.fn(async () => ({
          setup_id: 'setup-7',
          status: 'awaiting_connection',
          agent: { name: 'Rerun Agent' },
          haven_wallet: { id: 'safe-1', name: 'Main Haven wallet', address: '0x2222222222222222222222222222222222222222', chain_id: 8453, network: 'Base' },
          agent_budget: [],
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          challenge: { id: 'challenge-7', message: 'Haven Connect Agent 2\nsetup_id: setup-7\nchallenge: stu', expires_at: '2099-01-01T00:00:00.000Z' },
        })),
        registerSetup: vi.fn(async () => {
          throw new ConnectRequestError('Haven setup request failed: setup already connected', 409)
        }),
        updateInstallStatus: vi.fn(),
        getConnectorStatus: vi.fn(),
        getAgentIdentity: vi.fn(),
      },
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_rerunkey2',
      preflightStorage: vi.fn(async () => '/tmp/haven-connect-test-rerun-race'),
      writeCredentials,
      installRuntime,
      log: () => undefined,
    })).rejects.toThrow(/already connected/)

    expect(writeCredentials).not.toHaveBeenCalled()
    expect(installRuntime).not.toHaveBeenCalled()
  })

  // #1543: runConnect wires installRuntime's early config-written hook to a
  // best-effort install-status report, so the dashboard can unlock approval
  // before probes and skill install finish. The final report still follows
  // and remains authoritative.
  it('runConnect sends an early install-status report when the runtime config write settles', async () => {
    const reports: UpdateInstallStatusInput[] = []
    const updateInstallStatus = vi.fn(async (_setupId: string, _apiKey: string, input: UpdateInstallStatusInput) => {
      reports.push(input)
    })
    await runConnect({
      setupToken: 'hv_setup_test_early',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-connect-test-early',
      waitForApproval: false,
    }, {
      api: {
        resolveSetup: vi.fn(async () => ({
          setup_id: 'setup-5',
          status: 'awaiting_connection',
          agent: { name: 'Early Agent' },
          haven_wallet: { id: 'safe-1', name: 'Main Haven wallet', address: '0x2222222222222222222222222222222222222222', chain_id: 8453, network: 'Base' },
          agent_budget: [],
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          challenge: { id: 'challenge-5', message: 'Haven Connect Agent 2\nsetup_id: setup-5\nchallenge: mno', expires_at: '2099-01-01T00:00:00.000Z' },
        })),
        registerSetup: vi.fn(async (input) => ({
          setup_id: 'setup-5',
          agent_id: 'agent-5',
          status: 'connected_local',
          agent_status: 'pending_approval',
          api_key_prefix: input.apiKeyPrefix,
          api_key_scope: 'setup_pending',
          delegate_address: input.delegateAddress.toLowerCase(),
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          next_action: 'return_to_haven_for_wallet_approval',
        })),
        updateInstallStatus,
        getConnectorStatus: vi.fn(),
        getAgentIdentity: vi.fn(),
      },
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_earlykey',
      preflightStorage: vi.fn(async () => '/tmp/haven-connect-test-early'),
      writeCredentials: vi.fn(async () => ({
        directory: '/tmp/haven-connect-test-early/agent-5',
        identityPath: '/tmp/haven-connect-test-early/agent-5/identity.json',
        signerPath: '/tmp/haven-connect-test-early/agent-5/signer.json',
        agentPath: '/tmp/haven-connect-test-early/agent-5/agent.json',
      })),
      installRuntime: vi.fn(async (_input, deps) => {
        // Simulate the config write settling mid-install (#1543).
        await deps?.onRuntimeConfigured?.({
          runtime: 'claude-code',
          runtimeMcpMode: 'hosted_plus_signer',
          hostedMcpConfigured: true,
          localSignerConfigured: true,
          localMcpConfigured: false,
          signerAcknowledged: true,
          restartRequired: true,
          nextUserAction: 'return_to_haven_for_wallet_approval_then_restart_agent_session',
        })
        return completedInstall('claude-code')
      }),
      log: () => undefined,
    })

    expect(updateInstallStatus).toHaveBeenCalledTimes(2)
    // The early report carries the config-write facts and the unlock keys…
    expect(reports[0]).toMatchObject({
      hostedMcpConfigured: true,
      localSignerConfigured: true,
      credentialFilesWritten: true,
      errorCode: null,
    })
    // …but no probe verdict or skill state, which do not exist yet.
    expect(reports[0].probeResult).toBeUndefined()
    expect(reports[0].skillInstalled).toBeUndefined()
    // The final report follows and is the complete, authoritative one.
    expect(reports[1].probeResult).toBeDefined()
  })

  it('runConnect survives an early install-status report failure', async () => {
    const updateInstallStatus = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined)
    const logs: string[] = []
    const result = await runConnect({
      setupToken: 'hv_setup_test_early_fail',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir: '/tmp/haven-connect-test-early-fail',
      waitForApproval: false,
    }, {
      api: {
        resolveSetup: vi.fn(async () => ({
          setup_id: 'setup-6',
          status: 'awaiting_connection',
          agent: { name: 'Early Fail Agent' },
          haven_wallet: { id: 'safe-1', name: 'Main Haven wallet', address: '0x2222222222222222222222222222222222222222', chain_id: 8453, network: 'Base' },
          agent_budget: [],
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          challenge: { id: 'challenge-6', message: 'Haven Connect Agent 2\nsetup_id: setup-6\nchallenge: pqr', expires_at: '2099-01-01T00:00:00.000Z' },
        })),
        registerSetup: vi.fn(async (input) => ({
          setup_id: 'setup-6',
          agent_id: 'agent-6',
          status: 'connected_local',
          agent_status: 'pending_approval',
          api_key_prefix: input.apiKeyPrefix,
          api_key_scope: 'setup_pending',
          delegate_address: input.delegateAddress.toLowerCase(),
          hosted_mcp_url: 'https://mcp.haven.example/v1',
          next_action: 'return_to_haven_for_wallet_approval',
        })),
        updateInstallStatus,
        getConnectorStatus: vi.fn(),
        getAgentIdentity: vi.fn(),
      },
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_earlyfail',
      preflightStorage: vi.fn(async () => '/tmp/haven-connect-test-early-fail'),
      writeCredentials: vi.fn(async () => ({
        directory: '/tmp/haven-connect-test-early-fail/agent-6',
        identityPath: '/tmp/haven-connect-test-early-fail/agent-6/identity.json',
        signerPath: '/tmp/haven-connect-test-early-fail/agent-6/signer.json',
        agentPath: '/tmp/haven-connect-test-early-fail/agent-6/agent.json',
      })),
      installRuntime: vi.fn(async (_input, deps) => {
        await deps?.onRuntimeConfigured?.({
          runtime: 'claude-code',
          runtimeMcpMode: 'hosted_plus_signer',
          hostedMcpConfigured: true,
          localSignerConfigured: true,
          localMcpConfigured: false,
          restartRequired: true,
          nextUserAction: 'return_to_haven_for_wallet_approval_then_restart_agent_session',
        })
        return completedInstall('claude-code')
      }),
      log: (message) => logs.push(message),
    })

    // A failed early report is silent (no user action exists for it), never
    // fatal, and the final report still goes out.
    expect(result.agentId).toBe('agent-6')
    expect(updateInstallStatus).toHaveBeenCalledTimes(2)
    expect(logs.join('\n')).not.toContain('network down')
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
        getAgentIdentity: vi.fn(),
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

/**
 * #1696 — --name threading end to end through runConnect: the slug reaches
 * the credential write and the runtime install (which #1695's writers key
 * their entries on), and a TAKEN slug refuses BEFORE any key is minted or
 * agent registered — connect never overwrites credentials, and failing after
 * registration would orphan a live agent.
 */
describe('--name wiring slug through runConnect (#1696)', () => {
  const SETUP = {
    setup_id: 'setup-3',
    status: 'awaiting_connection',
    agent: { name: 'Named Agent' },
    haven_wallet: { id: 'safe-1', name: 'Main Haven wallet', address: '0x2222222222222222222222222222222222222222', chain_id: 84532, network: 'Base Sepolia' },
    agent_budget: [],
    hosted_mcp_url: 'https://mcp.haven.example/v1',
    challenge: { id: 'challenge-3', message: 'sign me', expires_at: '2099-01-01T00:00:00.000Z' },
  }

  function namedApi() {
    return {
      resolveSetup: vi.fn(async () => SETUP),
      registerSetup: vi.fn(async (input: { apiKeyPrefix: string; delegateAddress: string }) => ({
        setup_id: 'setup-3',
        agent_id: 'agent-named',
        status: 'connected_local',
        agent_status: 'pending_approval',
        api_key_prefix: input.apiKeyPrefix,
        api_key_scope: 'setup_pending',
        delegate_address: input.delegateAddress.toLowerCase(),
        hosted_mcp_url: 'https://mcp.haven.example/v1',
        next_action: 'return_to_haven_for_wallet_approval',
      })),
      updateInstallStatus: vi.fn(async () => {}),
      getConnectorStatus: vi.fn(),
      getAgentIdentity: vi.fn(),
    }
  }

  const namedInstallMock = () => vi.fn(async () => ({
    runtime: 'claude-code' as const,
    runtimeMcpMode: 'hosted_plus_signer' as const,
    hostedMcpConfigured: true,
    localSignerConfigured: true,
    localMcpConfigured: false,
    probeResult: 'hosted_ok_local_signer_ready',
    restartRequired: true,
    nextUserAction: 'return_to_haven_for_wallet_approval_then_restart_agent_session',
    configTarget: 'Claude Code MCP config',
    messages: [],
  }))

  it('MUTATION PROOF: the slug reaches the credential write AND the runtime install', async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), 'haven-1696-'))
    const writeCredentials = vi.fn(async () => ({
      directory: join(credentialsDir, 'work'),
      identityPath: join(credentialsDir, 'work', 'identity.json'),
      signerPath: join(credentialsDir, 'work', 'signer.json'),
      agentPath: join(credentialsDir, 'work', 'agent.json'),
    }))
    const installRuntime = namedInstallMock()

    await runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir,
      serverName: 'work',
      waitForApproval: false,
    }, {
      api: namedApi() as never,
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_supersecret',
      preflightStorage: vi.fn(async () => credentialsDir),
      writeCredentials: writeCredentials as never,
      installRuntime: installRuntime as never,
      log: () => undefined,
      redactPaths: true,
    })

    expect(writeCredentials).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'work' }))
    expect(installRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'work' }),
      expect.anything(),
    )
  })

  it('#1878 reports the RESOLVED hosted name for a named pair, not the raw slug', async () => {
    // The dashboard renders this verbatim as the MCP config entry, so the
    // slug alone would be wrong there — a user looking for `work` in their
    // config finds nothing.
    const credentialsDir = await mkdtemp(join(tmpdir(), 'haven-1878-named-'))
    const api = namedApi()
    await runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir,
      serverName: 'work',
      waitForApproval: false,
    }, {
      api: api as never,
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_supersecret',
      preflightStorage: vi.fn(async () => credentialsDir),
      writeCredentials: vi.fn(async () => ({
        directory: join(credentialsDir, 'work'),
        identityPath: join(credentialsDir, 'work', 'identity.json'),
        signerPath: join(credentialsDir, 'work', 'signer.json'),
        agentPath: join(credentialsDir, 'work', 'agent.json'),
      })) as never,
      installRuntime: namedInstallMock() as never,
      log: () => undefined,
    })

    expect(api.registerSetup).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServerName: 'haven-work' }),
    )
  })

  it('#1878 reports the BARE pair explicitly rather than sending nothing', async () => {
    // The load-bearing one. If the unnamed pair sent nothing, "absent" on the
    // server would mean both "this is the bare pair" and "an older connector
    // said nothing" — and only the second may render as unknown. Since #1696
    // shipped --name before this, agents wired with a named pair already
    // exist with nothing recorded, so collapsing the two would mislabel
    // exactly the agents this feature is for.
    const credentialsDir = await mkdtemp(join(tmpdir(), 'haven-1878-bare-'))
    const api = namedApi()
    await runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir,
      waitForApproval: false,
    }, {
      api: api as never,
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_supersecret',
      preflightStorage: vi.fn(async () => credentialsDir),
      writeCredentials: vi.fn(async () => ({
        directory: credentialsDir,
        identityPath: join(credentialsDir, 'identity.json'),
        signerPath: join(credentialsDir, 'signer.json'),
        agentPath: join(credentialsDir, 'agent.json'),
      })) as never,
      installRuntime: namedInstallMock() as never,
      log: () => undefined,
    })

    const input = api.registerSetup.mock.calls[0][0] as { mcpServerName?: string }
    expect(input.mcpServerName).toBe('haven')
    expect(input.mcpServerName).not.toBeUndefined()
  })

  it('MUTATION PROOF: runConnect validates the slug ITSELF — a library caller cannot register an agent under a reserved name', async () => {
    // runConnect is exported (index.ts), so CLI-side validation is not the
    // boundary. Before this guard a reserved slug passed the availability
    // check, registered a LIVE agent, wrote the delegate private key to disk,
    // and only then failed inside the config writer — an orphaned agent with
    // real key material under a name --doctor does not scan.
    const credentialsDir = await mkdtemp(join(tmpdir(), 'haven-1696-reserved-'))
    const api = namedApi()
    const writeCredentials = vi.fn()

    for (const slug of ['signer', 'haven', 'Bad Slug']) {
      await expect(runConnect({
        setupToken: 'hv_setup_test',
        apiBaseUrl: 'https://api.haven.example',
        runtime: 'claude-code',
        credentialsDir,
        serverName: slug,
        waitForApproval: false,
      }, {
        api: api as never,
        nodeVersion: SUPPORTED_NODE,
        generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
        generateApiKey: () => 'sk_agent_supersecret',
        preflightStorage: vi.fn(async () => credentialsDir),
        writeCredentials: writeCredentials as never,
        installRuntime: namedInstallMock() as never,
        log: () => undefined,
        redactPaths: true,
      })).rejects.toThrow(/Invalid server name/)
    }

    expect(api.registerSetup).not.toHaveBeenCalled()
    expect(writeCredentials).not.toHaveBeenCalled()
  })

  it('MUTATION PROOF: a named FIRST run does not name its own directory as a superseded agent', async () => {
    // The superseded scan excluded by AGENT ID, but a named agent's directory
    // is its SLUG — never equal to the uuid — so a clean first run told the
    // user to revoke the agent they had just created.
    const credentialsDir = await mkdtemp(join(tmpdir(), 'haven-1696-selfscan-'))
    const directory = join(credentialsDir, 'work')
    const logs: string[] = []

    await runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir,
      serverName: 'work',
      waitForApproval: false,
    }, {
      api: namedApi() as never,
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_supersecret',
      preflightStorage: vi.fn(async () => credentialsDir),
      // Writes for real, the way the production writer does — the superseded
      // scan runs AFTER the write and must not find this directory.
      writeCredentials: vi.fn(async () => {
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'identity.json'), JSON.stringify({
          api_key: 'sk_agent_supersecret', agent_id: 'agent-named',
        }))
        return {
          directory,
          identityPath: join(directory, 'identity.json'),
          signerPath: join(directory, 'signer.json'),
          agentPath: join(directory, 'agent.json'),
        }
      }) as never,
      installRuntime: namedInstallMock() as never,
      log: (message: string) => logs.push(message),
      redactPaths: true,
    })

    const output = logs.join('\n')
    expect(output).not.toContain('Heads-up: this setup created a NEW agent')
    expect(output).not.toContain('agent-named')
  })

  it('a SECOND named run names the FIRST named agent, and only it', async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), 'haven-1696-second-'))
    const first = join(credentialsDir, 'work')
    await mkdir(first, { recursive: true })
    await writeFile(join(first, 'identity.json'), JSON.stringify({
      api_key: 'sk_agent_first', agent_id: 'agent-work',
    }))
    const second = join(credentialsDir, 'personal')
    const logs: string[] = []

    await runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir,
      serverName: 'personal',
      waitForApproval: false,
    }, {
      api: namedApi() as never,
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_supersecret',
      preflightStorage: vi.fn(async () => credentialsDir),
      writeCredentials: vi.fn(async () => {
        await mkdir(second, { recursive: true })
        await writeFile(join(second, 'identity.json'), JSON.stringify({
          api_key: 'sk_agent_second', agent_id: 'agent-personal',
        }))
        return {
          directory: second,
          identityPath: join(second, 'identity.json'),
          signerPath: join(second, 'signer.json'),
          agentPath: join(second, 'agent.json'),
        }
      }) as never,
      installRuntime: namedInstallMock() as never,
      log: (message: string) => logs.push(message),
      redactPaths: true,
    })

    const output = logs.join('\n')
    expect(output).toContain('agent-work')
    expect(output).not.toContain('agent-personal')
  })

  it('MUTATION PROOF: a TAKEN slug refuses before registration — no key minted, no agent orphaned', async () => {
    const credentialsDir = await mkdtemp(join(tmpdir(), 'haven-1696-taken-'))
    await mkdir(join(credentialsDir, 'work'), { recursive: true })
    await writeFile(join(credentialsDir, 'work', 'identity.json'), JSON.stringify({ api_key: 'sk_agent_x' }))
    const api = namedApi()
    const writeCredentials = vi.fn()

    await expect(runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir,
      serverName: 'work',
      waitForApproval: false,
    }, {
      api: api as never,
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_supersecret',
      preflightStorage: vi.fn(async () => credentialsDir),
      writeCredentials: writeCredentials as never,
      installRuntime: namedInstallMock() as never,
      log: () => undefined,
      redactPaths: true,
    })).rejects.toThrow(/already wired/)

    expect(api.registerSetup).not.toHaveBeenCalled()
    expect(writeCredentials).not.toHaveBeenCalled()
  })
})

/**
 * #1688 — the completion heads-up. A re-run mints a NEW agent; the moment the
 * user is watching is the completion output, so that is where the superseded
 * agents are named, with the one action only the user can take.
 */
describe('superseded-agent heads-up at completion (#1688)', () => {
  const FRESH_SETUP = {
    setup_id: 'setup-2',
    status: 'awaiting_connection',
    agent: { name: 'Rerun Agent' },
    haven_wallet: { id: 'safe-1', name: 'Main Haven wallet', address: '0x2222222222222222222222222222222222222222', chain_id: 84532, network: 'Base Sepolia' },
    agent_budget: [],
    hosted_mcp_url: 'https://mcp.haven.example/v1',
    challenge: { id: 'challenge-2', message: 'sign me', expires_at: '2099-01-01T00:00:00.000Z' },
  }

  function apiFor(agentId: string) {
    return {
      resolveSetup: vi.fn(async () => FRESH_SETUP),
      registerSetup: vi.fn(async (input: { apiKeyPrefix: string; delegateAddress: string }) => ({
        setup_id: 'setup-2',
        agent_id: agentId,
        status: 'connected_local',
        agent_status: 'pending_approval',
        api_key_prefix: input.apiKeyPrefix,
        api_key_scope: 'setup_pending',
        delegate_address: input.delegateAddress.toLowerCase(),
        hosted_mcp_url: 'https://mcp.haven.example/v1',
        next_action: 'return_to_haven_for_wallet_approval',
      })),
      updateInstallStatus: vi.fn(async () => {}),
      getConnectorStatus: vi.fn(),
      getAgentIdentity: vi.fn(),
    }
  }

  const installRuntimeMock = () => vi.fn(async () => ({
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
    messages: [],
  }))

  async function runWithPriorDir(seedPrior: boolean) {
    const credentialsDir = await mkdtemp(join(tmpdir(), 'haven-1688-'))
    if (seedPrior) {
      const oldDir = join(credentialsDir, 'agent-old-uuid')
      await mkdir(oldDir, { recursive: true })
      await writeFile(join(oldDir, 'identity.json'), JSON.stringify({
        api_key: 'sk_agent_oldsecret', agent_id: 'agent-old',
      }))
    }
    const logs: string[] = []
    await runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir,
      waitForApproval: false,
    }, {
      api: apiFor('agent-new') as never,
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_supersecret',
      preflightStorage: vi.fn(async () => credentialsDir),
      writeCredentials: vi.fn(async () => ({
        directory: join(credentialsDir, 'agent-new'),
        identityPath: join(credentialsDir, 'agent-new', 'identity.json'),
        signerPath: join(credentialsDir, 'agent-new', 'signer.json'),
        agentPath: join(credentialsDir, 'agent-new', 'agent.json'),
      })),
      installRuntime: installRuntimeMock() as never,
      log: (message: string) => logs.push(message),
      redactPaths: true,
    })
    return logs.join('\n')
  }

  it('MUTATION PROOF: names the superseded agent and the revoke step when a prior dir exists', async () => {
    const output = await runWithPriorDir(true)

    expect(output).toContain('agent-old')
    expect(output).toMatch(/[Rr]evoke/)
    expect(output).toMatch(/keeps acting as them/)
    // Never the secret, never an auto-action claim.
    expect(output).not.toContain('sk_agent_oldsecret')
    expect(output).not.toMatch(/revoked (it|them) for you/)
  })

  it('REGRESSION (B1): filesystem junk under the credentials root is never named as an agent', async () => {
    // readdir returns EVERYTHING — a .DS_Store or a sync-relic must be
    // skipped, not surfaced as "revoke .DS_Store on the agent page".
    const credentialsDir = await mkdtemp(join(tmpdir(), 'haven-1688-junk-'))
    await writeFile(join(credentialsDir, '.DS_Store'), 'junk')
    await mkdir(join(credentialsDir, 'not-an-agent'), { recursive: true })
    // A REAL agent dir with corrupt identity.json IS worth naming, by dirname.
    const corrupt = join(credentialsDir, 'agent-corrupt')
    await mkdir(corrupt, { recursive: true })
    await writeFile(join(corrupt, 'identity.json'), '{not json')

    const logs: string[] = []
    await runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: 'https://api.haven.example',
      runtime: 'claude-code',
      credentialsDir,
      waitForApproval: false,
    }, {
      api: apiFor('agent-new') as never,
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => 'sk_agent_supersecret',
      preflightStorage: vi.fn(async () => credentialsDir),
      writeCredentials: vi.fn(async () => ({
        directory: join(credentialsDir, 'agent-new'),
        identityPath: join(credentialsDir, 'agent-new', 'identity.json'),
        signerPath: join(credentialsDir, 'agent-new', 'signer.json'),
        agentPath: join(credentialsDir, 'agent-new', 'agent.json'),
      })),
      installRuntime: installRuntimeMock() as never,
      log: (message: string) => logs.push(message),
      redactPaths: true,
    })
    const output = logs.join('\n')

    expect(output).not.toContain('.DS_Store')
    expect(output).not.toContain('not-an-agent')
    expect(output).toContain('agent-corrupt')
  })

  it('says nothing extra on a first-ever setup — no prior dirs, no heads-up', async () => {
    const output = await runWithPriorDir(false)
    expect(output).not.toContain('agent-old')
    expect(output).not.toMatch(/previous agent/)
  })
})


// #2173: the terminal outcome has to survive a caller that stopped watching
// the stream. Two halves — what the record SAYS (the hosted endpoint and the
// superseded agents, both previously stderr-prose or nothing at all) and where
// it LIVES (a file beside the credentials it describes).
describe('runConnect terminal outcome record (#2173)', () => {
  const HOSTED_MCP_URL = 'https://mcp.haven.example/v1'
  const API_BASE_URL = 'https://api.haven.example'
  const AGENT_API_KEY = 'sk_agent_supersecret'

  function outcomeApi(): ConnectApiClient {
    return {
      resolveSetup: vi.fn(async () => ({
        setup_id: 'setup-1',
        status: 'awaiting_connection',
        agent: { name: 'Research Agent' },
        haven_wallet: {
          id: 'safe-1',
          name: 'Main Haven wallet',
          address: '0x2222222222222222222222222222222222222222',
          chain_id: 8453,
          network: 'Base',
        },
        agent_budget: [],
        hosted_mcp_url: HOSTED_MCP_URL,
        challenge: {
          id: 'challenge-1',
          message: 'Haven Connect Agent 2\nsetup_id: setup-1',
          expires_at: '2099-01-01T00:00:00.000Z',
        },
      })),
      registerSetup: vi.fn(async (input: RegisterSetupInput) => ({
        setup_id: 'setup-1',
        agent_id: 'agent-1',
        status: 'connected_local',
        agent_status: 'active',
        api_key_prefix: input.apiKeyPrefix,
        api_key_scope: 'setup_pending',
        delegate_address: input.delegateAddress.toLowerCase(),
        hosted_mcp_url: HOSTED_MCP_URL,
        next_action: 'activate_runtime',
      })),
      updateInstallStatus: vi.fn(async () => undefined),
      getConnectorStatus: vi.fn(),
      getAgentIdentity: vi.fn(),
    }
  }

  /**
   * A `writeCredentials` stand-in that really creates the agent directory, so
   * the production outcome writer has somewhere real to write and the #1688
   * scan has something real to read. Only the credential CONTENTS are faked.
   */
  function credentialWriter(root: string) {
    return async () => {
      const directory = join(root, 'agent-1')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'identity.json'), JSON.stringify({ agent_id: 'agent-1' }))
      return {
        directory,
        identityPath: join(directory, 'identity.json'),
        signerPath: join(directory, 'signer.json'),
        agentPath: join(directory, 'agent.json'),
      }
    }
  }

  async function runInto(root: string, overrides: Partial<ConnectDeps> = {}) {
    return runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: API_BASE_URL,
      runtime: 'claude-code',
      credentialsDir: root,
      waitForApproval: false,
    }, {
      api: outcomeApi(),
      nodeVersion: SUPPORTED_NODE,
      generateKey: () => delegateKeyFromPrivateKey(PRIVATE_KEY),
      generateApiKey: () => AGENT_API_KEY,
      preflightStorage: vi.fn(async () => root),
      writeCredentials: credentialWriter(root),
      installRuntime: vi.fn(async () => completedInstall('claude-code')),
      log: () => undefined,
      ...overrides,
    })
  }

  async function readRecord(root: string): Promise<unknown> {
    return JSON.parse(await readFile(join(root, 'agent-1', CONNECT_OUTCOME_FILENAME), 'utf8'))
  }

  it('reports the hosted MCP endpoint, which is deliberately not the --api backend URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-outcome-'))

    const { outcome } = await runInto(root)

    expect(outcome.hosted_mcp_url).toBe(HOSTED_MCP_URL)
    // The whole point of the field: a caller comparing the two used to read
    // this intentional topology as an environment mismatch.
    expect(outcome.hosted_mcp_url).not.toBe(API_BASE_URL)
  })

  it('reports an empty superseded list on a clean first run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-outcome-'))

    const { outcome } = await runInto(root)

    expect(outcome.superseded_agent_ids).toEqual([])
  })

  it('names the agents this run superseded, excluding by directory rather than id (#1696)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-outcome-'))
    // A previous run's directory, and a named (slug-keyed) one whose directory
    // name can never equal its agent id — the #1696 case an id comparison
    // would misreport as superseded.
    await mkdir(join(root, 'agent-0'), { recursive: true })
    await writeFile(join(root, 'agent-0', 'identity.json'), JSON.stringify({ agent_id: 'agent-0' }))
    await mkdir(join(root, 'research'), { recursive: true })
    await writeFile(join(root, 'research', 'identity.json'), JSON.stringify({ agent_id: 'agent-named' }))

    const logs: string[] = []
    const { outcome } = await runInto(root, { log: (message) => logs.push(message) })

    expect([...(outcome.superseded_agent_ids ?? [])].sort()).toEqual(['agent-0', 'agent-named'])
    // The agent this run just created is never named as superseded.
    expect(outcome.superseded_agent_ids).not.toContain('agent-1')
    // The #1688 stderr heads-up is now fed from the same list, so it must
    // still name the same agents — the field is additive to that prose, not a
    // replacement for it.
    const headsUp = logs.join('\n')
    expect(headsUp).toContain('this setup created a NEW agent')
    // Each id separately: readdir order is not guaranteed, so asserting the
    // joined string would be an ordering flake rather than a guard.
    expect(headsUp).toContain('agent-0')
    expect(headsUp).toContain('agent-named')
  })

  it('persists the emitted outcome verbatim, pretty-printed, beside the credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-outcome-'))

    const { outcome } = await runInto(root)

    const path = join(root, 'agent-1', CONNECT_OUTCOME_FILENAME)
    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw)).toEqual(JSON.parse(JSON.stringify(outcome)))
    expect(raw).toContain('\n  "schema_version": 1')
    // Secret-free by construction, asserted rather than assumed: this file is
    // the one Connect artifact a caller is told to read back and paste around.
    expect(raw).not.toContain(AGENT_API_KEY)
    expect(raw).not.toContain(PRIVATE_KEY)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('keeps the credential directory out of the emitted outcome even though the record lives there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-outcome-'))

    const { outcome } = await runInto(root)

    expect(JSON.stringify(outcome)).not.toContain(root)
  })

  it('records an action_required outcome too, not only complete and failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-outcome-'))

    // A manual runtime finishes the run without finishing the setup. It is
    // neither of the two shapes the prose reaches for first, and it is the one
    // a caller most needs to read back: the remaining steps are all manual.
    const { outcome } = await runInto(root, {
      installRuntime: vi.fn(async () => ({
        ...completedInstall('other'),
        runtimeMcpMode: 'manual' as const,
        hostedMcpConfigured: false,
        localSignerConfigured: false,
        errorCode: 'manual_runtime_setup_required',
      })),
    })

    expect(outcome.outcome).toBe('action_required')
    expect(await readRecord(root)).toMatchObject({
      outcome: 'action_required',
      error: { code: 'manual_runtime_setup_required' },
    })
  })

  it('completes the setup when the record write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-outcome-'))
    const writeOutcomeRecord = vi.fn(async () => {
      throw new Error('EROFS: read-only file system')
    })

    const { outcome } = await runInto(root, { writeOutcomeRecord })

    expect(writeOutcomeRecord).toHaveBeenCalledTimes(1)
    expect(outcome.outcome).toBe('complete')
  })

  it('persists the failure outcome once a credential directory exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-outcome-'))

    await expectRejection(runInto(root, {
      installRuntime: vi.fn(async () => {
        throw new ConnectError('probe_failed', 'The MCP probe did not answer.', 'rerun_connect')
      }),
    }))

    expect(await readRecord(root)).toMatchObject({
      schema_version: 1,
      outcome: 'failed',
      error: { code: 'probe_failed' },
    })
  })

  it('writes no record for a refusal that happens before any credentials exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'haven-outcome-'))
    const writeOutcomeRecord = vi.fn(async () => join(root, CONNECT_OUTCOME_FILENAME))

    const error = await expectRejection(runConnect({
      setupToken: 'hv_setup_test',
      apiBaseUrl: API_BASE_URL,
      credentialsDir: root,
      waitForApproval: false,
    }, {
      api: outcomeApi(),
      nodeVersion: SUPPORTED_NODE,
      env: {},
      isTty: false,
      log: () => undefined,
      writeOutcomeRecord,
    }))

    expect((error as ConnectError).code).toBe('runtime_undetermined')
    expect(writeOutcomeRecord).not.toHaveBeenCalled()
  })
})
