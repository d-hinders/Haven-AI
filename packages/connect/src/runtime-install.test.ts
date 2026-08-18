import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { installRuntime, supportsLocalMcp, type EarlyRuntimeConfigReport } from './runtime-install.js'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'

const API_KEY = 'sk_agent_secret_for_runtime_test'
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'
const HOSTED_URL = 'https://mcp.haven.example/v1'

describe('installRuntime', () => {
  it('prepares Codex local MCP config and acknowledgement for normal restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-install-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
      localMcp: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareLocalMcpRuntime: fakePrepareLocalMcpRuntime(),
      probeLocalMcpTools: okLocalMcpProbe(),
    })

    const codexConfig = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    const ack = await readFile(`${identityPath}.ack.json`, 'utf8')

    expect(result.runtimeMcpMode).toBe('local_stdio')
    expect(result.hostedMcpConfigured).toBe(false)
    expect(result.localSignerConfigured).toBe(true)
    expect(result.localMcpConfigured).toBe(true)
    expect(result.localMcpAcknowledged).toBe(true)
    expect(result.restartRequired).toBe(true)
    expect(result.nextUserAction).toBe('return_to_haven_for_wallet_approval_then_restart_codex')
    expect(result.activationCommand).toBeUndefined()
    expect(result.errorCode).toBeUndefined()
    expect(codexConfig).toContain(`command = "${join(credentialDirectory, 'bin', 'haven-mcp')}"`)
    expect(codexConfig).toContain('args = []')
    expect(codexConfig).toContain('startup_timeout_sec = 120')
    expect(codexConfig).not.toContain('--identity')
    expect(codexConfig).not.toContain(identityPath)
    expect(codexConfig).not.toContain('--signer')
    expect(codexConfig).not.toContain('"--ack"')
    expect(codexConfig).not.toContain('bearer_token_env_var')
    expect(codexConfig).not.toContain('haven_signer')
    expect(codexConfig).not.toContain(API_KEY)
    expect(codexConfig).not.toContain(PRIVATE_KEY)
    expect(ack).toContain('"ack"')
    // Restart guidance lives only in runConnect's printNextSteps now — the Codex
    // writer must not re-inject it (it previously did, contradicting that copy).
    expect(result.messages.join('\n')).not.toContain('should appear')
    expect(result.messages.join('\n')).not.toMatch(/restart/i)
    expect(result.messages.join('\n')).not.toContain(API_KEY)
    expect(result.messages.join('\n')).not.toContain(PRIVATE_KEY)
  })

  it('treats Codex Desktop as restart-ready with the same local MCP config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-desktop-install-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-desktop',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
      localMcp: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareLocalMcpRuntime: fakePrepareLocalMcpRuntime(),
      probeLocalMcpTools: okLocalMcpProbe(),
    })

    const codexConfig = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    expect(result.runtime).toBe('codex-desktop')
    expect(result.runtimeMcpMode).toBe('local_stdio')
    expect(result.localMcpConfigured).toBe(true)
    expect(result.nextUserAction).toBe('return_to_haven_for_wallet_approval_then_restart_codex')
    expect(codexConfig).toContain(`command = "${join(credentialDirectory, 'bin', 'haven-mcp')}"`)
    expect(codexConfig).not.toContain('npx')
    expect(codexConfig).not.toContain(API_KEY)
    expect(codexConfig).not.toContain(PRIVATE_KEY)
  })

  it('does not report local MCP as configured when acknowledgement is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-no-ack-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      localMcp: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareLocalMcpRuntime: fakePrepareLocalMcpRuntime(),
      probeLocalMcpTools: okLocalMcpProbe(),
    })

    expect(result.hostedMcpConfigured).toBe(false)
    expect(result.localSignerConfigured).toBe(false)
    expect(result.localMcpConfigured).toBe(false)
    expect(result.localMcpAcknowledged).toBe(false)
    expect(result.errorCode).toBe('local_mcp_ack_required')
  })

  it('configures Claude Code with local MCP and no Authorization header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-claude-install-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)
    const commands: Array<{ command: string; args: string[] }> = []
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args })
    })

    const result = await installRuntime({
      runtime: 'claude-code',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
      localMcp: true,
    }, {
      homeDir: dir,
      runCommand,
      fetch: okToolsFetch(),
      prepareLocalMcpRuntime: fakePrepareLocalMcpRuntime(),
      probeLocalMcpTools: okLocalMcpProbe(),
    })

    expect(result.hostedMcpConfigured).toBe(false)
    expect(result.localSignerConfigured).toBe(true)
    expect(result.localMcpConfigured).toBe(true)
    expect(result.localMcpAcknowledged).toBe(true)
    expect(result.nextUserAction).toBe('return_to_haven_for_wallet_approval_then_restart_claude_code')
    expect(commands[0]).toMatchObject({
      command: 'claude',
      args: [
        'mcp',
        'add-json',
        'haven',
        JSON.stringify({
          type: 'stdio',
          command: join(credentialDirectory, 'bin', 'haven-mcp'),
          args: [],
          env: {},
        }),
        '--scope',
        'user',
      ],
    })
    expect(commands[1]).toMatchObject({
      command: 'claude',
      args: ['mcp', 'remove', 'haven-signer'],
    })
    expect(commands[2]).toMatchObject({
      command: 'claude',
      args: ['mcp', 'get', 'haven'],
    })
    expect(result.messages.join('\n')).toContain('Verified Claude Code MCP entry.')
    // Restart/approval guidance is owned solely by runConnect's printNextSteps.
    // The config writer must not inject its own (previously contradicting) copy.
    expect(result.messages.join('\n')).not.toContain('should appear')
    expect(result.messages.join('\n')).not.toMatch(/restart/i)
    expect(JSON.stringify(commands)).not.toContain('Authorization')
    expect(JSON.stringify(commands)).not.toContain(API_KEY)
    expect(JSON.stringify(commands)).not.toContain(PRIVATE_KEY)
  })

  it('reports local MCP runtime install failures without marking restart-ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-runtime-install-fail-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
      localMcp: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareLocalMcpRuntime: vi.fn(async () => {
        throw new Error('npm cache could not install package')
      }),
      probeLocalMcpTools: okLocalMcpProbe(),
    })

    expect(result.localMcpConfigured).toBe(false)
    expect(result.localSignerConfigured).toBe(false)
    expect(result.errorCode).toBe('local_mcp_runtime_install_failed')
    expect(result.probeResult).toBe('local_stdio_mcp_runtime_install_failed')
    expect(result.nextUserAction).toBe('return_to_haven_for_wallet_approval_then_finish_runtime_setup')
    expect(result.messages.join('\n')).toContain('Could not prepare local Haven MCP runtime')
    expect(result.messages.join('\n')).not.toContain(API_KEY)
    expect(result.messages.join('\n')).not.toContain(PRIVATE_KEY)
  })

  it('reports unsupported Node versions before runtime config is written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-node-fail-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
      localMcp: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareLocalMcpRuntime: vi.fn(async () => {
        const err = new Error('Node.js 18.19.0 is not supported. Haven local MCP requires Node.js >=20.0.0.')
        Object.assign(err, { code: 'local_mcp_unsupported_node_version' })
        throw err
      }),
      probeLocalMcpTools: okLocalMcpProbe(),
    })

    expect(result.localMcpConfigured).toBe(false)
    expect(result.errorCode).toBe('local_mcp_unsupported_node_version')
    expect(result.probeResult).toBe('local_stdio_mcp_unsupported_node_version')
    expect(result.messages.join('\n')).toContain('requires Node.js >=20.0.0')
  })

  it('does not report local MCP as configured when the wrapper handshake fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-probe-fail-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
      localMcp: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareLocalMcpRuntime: fakePrepareLocalMcpRuntime(),
      probeLocalMcpTools: vi.fn(async () => ({ status: 'missing_tools' as const, toolNames: ['haven_get_agent'] })),
    })

    expect(result.localSignerConfigured).toBe(false)
    expect(result.localMcpConfigured).toBe(false)
    expect(result.errorCode).toBe('local_mcp_probe_missing_tools')
    expect(result.probeResult).toBe('local_stdio_mcp_missing_tools')
    expect(result.messages.join('\n')).toContain('Local Haven MCP handshake failed: missing_tools.')
  })

  it('gives custom "other" runtimes a secret-free, file-referenced setup message', async () => {
    // The connector cannot auto-config a custom runtime, so it must hand back
    // actionable, secret-free guidance: name the on-disk credential files and
    // the signer/MCP commands that read them, and never echo the raw keys
    // (which would land in the custom agent's context/logs).
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-other-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'other',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
    })

    expect(result.runtime).toBe('other')
    expect(result.errorCode).toBe('manual_runtime_setup_required')
    const msg = result.messages.join('\n')
    expect(msg).toContain(identityPath)
    expect(msg).toContain(signerPath)
    expect(msg).toContain('npx -y @haven_ai/signer')
    expect(msg).toContain('npx -y @haven_ai/mcp')
    expect(msg).not.toContain(API_KEY)
    expect(msg).not.toContain(PRIVATE_KEY)
  })
})

describe('installRuntime hosted default topology', () => {
  it('writes hosted MCP + signer for Codex by default (no opt-in)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-hosted-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareSignerRuntime: fakePrepareSignerRuntime(),
    })

    const codexConfig = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')

    expect(result.runtimeMcpMode).toBe('hosted_plus_signer')
    expect(result.hostedMcpConfigured).toBe(true)
    expect(result.localSignerConfigured).toBe(true)
    expect(result.localMcpConfigured).toBe(false)
    expect(result.errorCode).toBeUndefined()
    expect(result.nextUserAction).toBe('return_to_haven_for_wallet_approval_then_restart_codex')
    expect(codexConfig).toContain('[mcp_servers.haven]')
    expect(codexConfig).toContain(`url = "${HOSTED_URL}"`)
    expect(codexConfig).toContain(`http_headers = { "Authorization" = "Bearer ${API_KEY}" }`)
    expect(codexConfig).toContain('[mcp_servers.haven_signer]')
    // Signer is launched via the prepared absolute wrapper, not runtime npx.
    expect(codexConfig).toContain(`command = "${signerWrapperPath(credentialDirectory)}"`)
    expect(codexConfig).not.toContain('npx')
    expect(codexConfig).not.toContain(PRIVATE_KEY)
  })

  it.each(['unauthorized', 'network_error', 'bad_response'] as const)(
    'does not report hosted MCP setup complete when its probe returns %s',
    async (status) => {
      const dir = await mkdtemp(join(tmpdir(), `haven-connect-hosted-probe-${status}-`))
      const credentialDirectory = join(dir, 'agent-1')
      const identityPath = await writeIdentityCredential(credentialDirectory)
      const signerPath = await writeSignerCredential(credentialDirectory)
      const fetch = status === 'network_error'
        ? vi.fn(async () => { throw new Error('offline') }) as unknown as typeof globalThis.fetch
        : vi.fn(async () => new Response(status === 'unauthorized' ? '' : 'not MCP', { status: status === 'unauthorized' ? 401 : 502 })) as unknown as typeof globalThis.fetch

      const result = await installRuntime({
        runtime: 'codex-cli', hostedMcpUrl: HOSTED_URL, apiKey: API_KEY,
        signerPath, identityPath, credentialDirectory, ackLocalTools: true,
      }, { homeDir: dir, fetch, prepareSignerRuntime: fakePrepareSignerRuntime() })

      expect(result.hostedMcpConfigured).toBe(false)
      expect(result.errorCode).toBe(`hosted_mcp_probe_${status}`)
      expect(result.messages.join('\n')).toContain(`Hosted Haven MCP probe failed: ${status}.`)
    },
  )

  it('falls back to npx (non-fatal) and flags signerRuntimePrepared=false when signer prep fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-signer-prepfail-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareSignerRuntime: vi.fn(async () => {
        throw new Error('npm registry unreachable')
      }),
    })

    const codexConfig = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')

    // Degrades gracefully: still hosted+signer, but observably on the npx path.
    expect(result.runtimeMcpMode).toBe('hosted_plus_signer')
    expect(result.signerRuntimePrepared).toBe(false)
    expect(codexConfig).toContain('command = "npx"')
    expect(codexConfig).toContain(signerPath)
    expect(result.messages.join('\n')).toContain('falling back to npx launch')
    expect(codexConfig).not.toContain(PRIVATE_KEY)
  })

  it('writes hosted MCP + signer for Claude Code by default (no opt-in)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-claude-hosted-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)
    const commands: Array<{ command: string; args: string[] }> = []
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args })
    })

    const result = await installRuntime({
      runtime: 'claude-code',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
    }, {
      homeDir: dir,
      runCommand,
      fetch: okToolsFetch(),
      prepareSignerRuntime: fakePrepareSignerRuntime(),
    })

    const skill = await readFile(join(dir, '.claude', 'skills', 'haven-pay', 'SKILL.md'), 'utf8')
    expect(result.skillInstalled).toBe(true)
    expect(skill).toContain('name: haven-pay')
    expect(skill).toContain('haven_get_agent')
    expect(skill).not.toContain(API_KEY)
    expect(skill).not.toContain(PRIVATE_KEY)

    expect(result.runtimeMcpMode).toBe('hosted_plus_signer')
    expect(result.hostedMcpConfigured).toBe(true)
    expect(result.localSignerConfigured).toBe(true)
    expect(result.localMcpConfigured).toBe(false)
    expect(result.errorCode).toBeUndefined()
    expect(result.nextUserAction).toBe('return_to_haven_for_wallet_approval_then_restart_claude_code')

    const addCalls = commands.filter((c) => c.args[1] === 'add-json')
    expect(addCalls).toHaveLength(2)
    const hostedAdd = addCalls.find((c) => c.args[2] === 'haven')
    const signerAdd = addCalls.find((c) => c.args[2] === 'haven-signer')
    expect(hostedAdd).toBeDefined()
    expect(signerAdd).toBeDefined()
    const hostedServer = JSON.parse(hostedAdd!.args[3]) as Record<string, unknown>
    expect(hostedServer).toMatchObject({
      type: 'http',
      url: HOSTED_URL,
      headers: { Authorization: `Bearer ${API_KEY}` },
    })
    const signerServer = JSON.parse(signerAdd!.args[3]) as Record<string, unknown>
    // Signer launches via the prepared absolute wrapper (creds baked in), not npx.
    expect(signerServer).toMatchObject({
      type: 'stdio',
      command: signerWrapperPath(credentialDirectory),
      args: [],
    })
    expect(JSON.stringify(commands)).not.toContain(PRIVATE_KEY)
  })

  it('never produces local_stdio or manual for any known runtime by default', async () => {
    const runtimes = [
      'claude-code', 'codex-cli', 'codex-desktop', 'cursor', 'vscode', 'vscode-insiders', 'claude-desktop', 'hermes',
    ] as const
    for (const runtime of runtimes) {
      const dir = await mkdtemp(join(tmpdir(), `haven-connect-default-${runtime}-`))
      const credentialDirectory = join(dir, 'agent-1')
      const identityPath = await writeIdentityCredential(credentialDirectory)
      const signerPath = await writeSignerCredential(credentialDirectory)

      const result = await installRuntime({
        runtime,
        hostedMcpUrl: HOSTED_URL,
        apiKey: API_KEY,
        signerPath,
        identityPath,
        credentialDirectory,
        ackLocalTools: true,
      }, {
        homeDir: dir,
        fetch: okToolsFetch(),
        runCommand: vi.fn(async () => undefined),
        prepareSignerRuntime: fakePrepareSignerRuntime(),
      })

      expect(result.runtimeMcpMode, runtime).toBe('hosted_plus_signer')
      expect(result.hostedMcpConfigured, runtime).toBe(true)
      expect(result.localSignerConfigured, runtime).toBe(true)
      expect(result.localMcpConfigured, runtime).toBe(false)
    }
  })

  it('limits local MCP support to Claude Code and Codex', () => {
    expect(supportsLocalMcp('claude-code')).toBe(true)
    expect(supportsLocalMcp('codex-cli')).toBe(true)
    expect(supportsLocalMcp('codex-desktop')).toBe(true)
    expect(supportsLocalMcp('cursor')).toBe(false)
    expect(supportsLocalMcp('vscode')).toBe(false)
    expect(supportsLocalMcp('vscode-insiders')).toBe(false)
    expect(supportsLocalMcp('claude-desktop')).toBe(false)
    expect(supportsLocalMcp('hermes')).toBe(false)
    expect(supportsLocalMcp('other')).toBe(false)
  })

  it('ignores the local opt-in on runtimes that do not support local MCP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-cursor-localflag-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'cursor',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
      localMcp: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareSignerRuntime: fakePrepareSignerRuntime(),
    })

    expect(result.runtimeMcpMode).toBe('hosted_plus_signer')
    expect(result.hostedMcpConfigured).toBe(true)
  })

  // #1543: the dashboard's approval unlock reads only config/consent facts, so
  // they are reported the moment the config write settles — before the network
  // probes and skill install, whose tail approval does not depend on.
  it('fires the early config-written report after the write and before the probes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-early-report-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)
    const order: string[] = []
    const probeFetch = vi.fn(async () => {
      order.push('probe')
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'haven_get_agent' }] },
      }), { status: 200 })
    }) as unknown as typeof fetch
    let early: EarlyRuntimeConfigReport | undefined
    const onRuntimeConfigured = vi.fn(async (report: EarlyRuntimeConfigReport) => {
      early = report
      order.push('early-report')
    })

    const result = await installRuntime({
      runtime: 'cursor',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
    }, {
      homeDir: dir,
      fetch: probeFetch,
      prepareSignerRuntime: fakePrepareSignerRuntime(),
      onRuntimeConfigured,
    })

    expect(onRuntimeConfigured).toHaveBeenCalledTimes(1)
    expect(order[0]).toBe('early-report')
    expect(order).toContain('probe')
    // The early booleans carry the unlock keys' semantics minus probe verdicts.
    expect(early).toMatchObject({
      runtime: 'cursor',
      runtimeMcpMode: 'hosted_plus_signer',
      hostedMcpConfigured: true,
      localSignerConfigured: true,
      localMcpConfigured: false,
    })
    expect(early?.errorCode).toBeUndefined()
    // The early projection agrees with the final report on the shared facts.
    expect(early?.nextUserAction).toBe(result.nextUserAction)
    expect(early?.restartRequired).toBe(result.restartRequired)
  })

  // Reviewer finding on #1543: the local_stdio early-boolean formula must not
  // silently diverge from the final report's — pin it on a real local install.
  it('fires the early report with local_stdio semantics on a local MCP install', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-early-report-local-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)
    let early: EarlyRuntimeConfigReport | undefined
    const onRuntimeConfigured = vi.fn(async (report: EarlyRuntimeConfigReport) => {
      early = report
    })

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
      localMcp: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareLocalMcpRuntime: fakePrepareLocalMcpRuntime(),
      probeLocalMcpTools: okLocalMcpProbe(),
      onRuntimeConfigured,
    })

    expect(onRuntimeConfigured).toHaveBeenCalledTimes(1)
    expect(early).toMatchObject({
      runtime: 'codex-cli',
      runtimeMcpMode: 'local_stdio',
      hostedMcpConfigured: false,
      localSignerConfigured: true,
      localMcpConfigured: true,
      localMcpAcknowledged: true,
    })
    // The early projection agrees with the final report's unlock keys.
    expect(early?.localMcpConfigured).toBe(result.localMcpConfigured)
    expect(early?.localSignerConfigured).toBe(result.localSignerConfigured)
  })

  it('does not fire the early report when local runtime preparation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-early-report-prep-fail-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)
    const onRuntimeConfigured = vi.fn()

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
      localMcp: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareLocalMcpRuntime: vi.fn(async () => {
        throw new Error('npm cache could not install package')
      }),
      probeLocalMcpTools: okLocalMcpProbe(),
      onRuntimeConfigured,
    })

    // No config write happened, so there is nothing configured to report.
    expect(result.errorCode).toBe('local_mcp_runtime_install_failed')
    expect(onRuntimeConfigured).not.toHaveBeenCalled()
  })

  it('never fails the install when the early report throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-early-report-throw-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'cursor',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareSignerRuntime: fakePrepareSignerRuntime(),
      onRuntimeConfigured: vi.fn(async () => {
        throw new Error('report endpoint down')
      }),
    })

    expect(result.errorCode).toBeUndefined()
    expect(result.hostedMcpConfigured).toBe(true)
  })

  it('does not fire the early report on the manual runtime path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-early-report-manual-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)
    const onRuntimeConfigured = vi.fn()

    const result = await installRuntime({
      runtime: 'other',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackSigner: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      onRuntimeConfigured,
    })

    // No config was written, so there is nothing configured to report early;
    // the caller's final report carries the manual-setup state.
    expect(result.errorCode).toBe('manual_runtime_setup_required')
    expect(onRuntimeConfigured).not.toHaveBeenCalled()
  })

  // #1332: guidance-surface parity — setup on each runtime with a documented
  // instruction mechanism leaves the agent the guidance that runtime can
  // consume, with the same secret-free canonical substance everywhere.
  it('installs the skill guidance into Codex global AGENTS.md during setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-skill-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareSignerRuntime: fakePrepareSignerRuntime(),
    })

    expect(result.skillInstalled).toBe(true)
    const agentsMd = await readFile(join(dir, '.codex', 'AGENTS.md'), 'utf8')
    expect(agentsMd).toContain('managed by @haven_ai/connect')
    expect(agentsMd).toContain('haven_get_agent')
    expect(agentsMd).not.toContain(API_KEY)
    expect(agentsMd).not.toContain(PRIVATE_KEY)
  })

  it('installs the SKILL.md into the Hermes skills folder during setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-hermes-skill-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)
    // The parallel Hermes CONFIG write resolves its home from the real
    // process.env (config-writers' hermesHomePath), so clear it for the test's
    // duration — otherwise a developer shell with HERMES_HOME set would make
    // this test write outside its temp dir.
    const savedHermesHome = process.env.HERMES_HOME
    delete process.env.HERMES_HOME
    onTestFinished(() => {
      if (savedHermesHome === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = savedHermesHome
    })

    const result = await installRuntime({
      runtime: 'hermes',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
    }, {
      homeDir: dir,
      env: {},
      fetch: okToolsFetch(),
      prepareSignerRuntime: fakePrepareSignerRuntime(),
    })

    expect(result.skillInstalled).toBe(true)
    const skill = await readFile(join(dir, '.hermes', 'skills', 'haven-pay', 'SKILL.md'), 'utf8')
    expect(skill).toContain('name: haven-pay')
    expect(skill).toContain('haven_get_agent')
    expect(skill).not.toContain(API_KEY)
    expect(skill).not.toContain(PRIVATE_KEY)
  })

  it('does not write any guidance file for runtimes without a documented mechanism', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-cursor-noskill-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'cursor',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
      prepareSignerRuntime: fakePrepareSignerRuntime(),
    })

    expect(result.skillInstalled).toBeUndefined()
  })
})

async function writeIdentityCredential(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const identityPath = join(directory, 'identity.json')
  await writeFile(
    identityPath,
    JSON.stringify({
      api_key: API_KEY,
      agent_id: 'agent-1',
      safe_address: '0x2222222222222222222222222222222222222222',
      chain_id: 100,
      network: 'Gnosis',
      api_url: 'https://api.haven.example',
      agent_budget: [{ token_symbol: 'USDC', allowance_amount: '25000000', reset_period_min: 1440 }],
    }, null, 2),
    'utf8',
  )
  await chmod(identityPath, 0o600)
  return identityPath
}

async function writeSignerCredential(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const signerPath = join(directory, 'signer.json')
  await writeFile(
    signerPath,
    JSON.stringify({
      delegate_key: PRIVATE_KEY,
      delegate_address: '0x0E8F9364fE8a316d00aD5AFD6D09993c764B45d1',
      agent_id: 'agent-1',
      safe_address: '0x2222222222222222222222222222222222222222',
      chain_id: 100,
      network: 'Gnosis',
    }, null, 2),
    'utf8',
  )
  await chmod(signerPath, 0o600)
  return signerPath
}

function okToolsFetch(): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'haven_get_agent' }] },
    }), { status: 200 }),
  ) as unknown as typeof fetch
}

function fakePrepareLocalMcpRuntime() {
  return vi.fn(async (input: { credentialDirectory: string }) => {
    const wrapperPath = join(input.credentialDirectory, 'bin', 'haven-mcp')
    return {
      command: wrapperPath,
      args: [],
      wrapperPath,
      runtimeDirectory: join(input.credentialDirectory, '..', '..', 'mcp-runtime', MCP_RUNTIME_MANIFEST.mcpVersion),
      npmCacheDirectory: join(input.credentialDirectory, '..', '..', 'npm-cache'),
      cliPath: join(input.credentialDirectory, '..', '..', 'mcp-runtime', MCP_RUNTIME_MANIFEST.mcpVersion, 'node_modules', '@haven_ai', 'mcp', 'dist', 'cli.js'),
      messages: ['Prepared stable local Haven MCP wrapper.'],
    }
  })
}

function signerWrapperPath(credentialDirectory: string): string {
  return join(credentialDirectory, 'bin', 'haven-signer.mjs')
}

function fakePrepareSignerRuntime() {
  return vi.fn(async (input: { credentialDirectory: string }) => {
    const wrapperPath = signerWrapperPath(input.credentialDirectory)
    return {
      command: wrapperPath,
      args: [],
      wrapperPath,
      runtimeDirectory: join(input.credentialDirectory, '..', '..', 'signer-runtime', MCP_RUNTIME_MANIFEST.signerVersion),
      npmCacheDirectory: join(input.credentialDirectory, '..', '..', 'npm-cache'),
      cliPath: join(input.credentialDirectory, '..', '..', 'signer-runtime', MCP_RUNTIME_MANIFEST.signerVersion, 'node_modules', '@haven_ai', 'signer', 'dist', 'cli.js'),
      messages: ['Prepared stable local Haven signer wrapper.'],
    }
  })
}

function okLocalMcpProbe() {
  return vi.fn(async () => ({
    status: 'ok' as const,
    toolNames: [...MCP_RUNTIME_MANIFEST.requiredTools],
  }))
}
