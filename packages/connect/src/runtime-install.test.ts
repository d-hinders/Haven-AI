import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installRuntime, supportsLocalMcp } from './runtime-install.js'
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
    expect(codexConfig).toContain('command = "npx"')
    expect(codexConfig).toContain(signerPath)
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
    expect(signerServer).toMatchObject({ type: 'stdio', command: 'npx' })
    expect((signerServer.args as string[])).toContain('--credentials')
    expect((signerServer.args as string[])).toContain(signerPath)
    expect(JSON.stringify(commands)).not.toContain(PRIVATE_KEY)
  })

  it('never produces local_stdio or manual for any known runtime by default', async () => {
    const runtimes = [
      'claude-code', 'codex-cli', 'codex-desktop', 'cursor', 'vscode', 'vscode-insiders', 'claude-desktop',
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
    })

    expect(result.runtimeMcpMode).toBe('hosted_plus_signer')
    expect(result.hostedMcpConfigured).toBe(true)
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

function okLocalMcpProbe() {
  return vi.fn(async () => ({
    status: 'ok' as const,
    toolNames: [...MCP_RUNTIME_MANIFEST.requiredTools],
  }))
}
