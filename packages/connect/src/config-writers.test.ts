import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  hermesConfigPath,
  hermesEnvPath,
  mergeCodexToml,
  mergeHermesEnv,
  mergeCodexTomlHosted,
  mergeHermesYaml,
  mergeJsonMcpConfig,
  validateCodexToml,
  writeRuntimeConfig,
} from './config-writers.js'
import { signerPackageSpec } from './runtime-manifest.js'

const API_KEY = 'sk_agent_secret_for_config_test'
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'
const HOSTED_URL = 'https://mcp.haven.example/v1'
const IDENTITY_PATH = '/Users/example/.haven/agents/agent-1/identity.json'
const SIGNER_PATH = '/Users/example/.haven/agents/agent-1/signer.json'
const WRAPPER_PATH = '/Users/example/.haven/agents/agent-1/bin/haven-mcp'
const SIGNER_PACKAGE = signerPackageSpec()

describe('runtime config writers', () => {
  it('preserves existing JSON MCP entries and intentionally updates Haven entries', () => {
    const merged = mergeJsonMcpConfig(
      JSON.stringify({
        mcpServers: {
          existing: { command: 'node', args: ['server.js'] },
          haven: { url: 'https://old.example' },
        },
        otherSetting: true,
      }),
      'mcpServers',
      { url: HOSTED_URL, headers: { Authorization: `Bearer ${API_KEY}` } },
      { command: 'npx', args: ['-y', SIGNER_PACKAGE, '--credentials', SIGNER_PATH] },
    )

    const parsed = JSON.parse(merged) as {
      mcpServers: Record<string, { url?: string; command?: string; args?: string[]; headers?: Record<string, string> }>
      otherSetting: boolean
    }
    expect(parsed.otherSetting).toBe(true)
    expect(parsed.mcpServers.existing.command).toBe('node')
    expect(parsed.mcpServers.haven.url).toBe(HOSTED_URL)
    expect(parsed.mcpServers.haven.headers?.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(parsed.mcpServers['haven-signer'].args).toContain(SIGNER_PATH)
    expect(parsed.mcpServers['haven-signer'].args).not.toContain('--ack')
    expect(merged).not.toContain(PRIVATE_KEY)
    expect(merged).not.toMatch(/delegate_key|private_key/i)
  })

  it('preserves unrelated Codex TOML tables while replacing duplicate Haven tables', () => {
    const merged = mergeCodexToml(
      [
        'model = "gpt-5"',
        'approval_policy = "on-request"',
        '',
        '[projects."/Users/example/Haven AI"]',
        'trust_level = "trusted"',
        '',
        '[mcp_servers.other]',
        'command = "node"',
        '',
        '[mcp_servers.haven]',
        'url = "https://old.example"',
        '',
        '[mcp_servers.haven.env]',
        'HAVEN_TOKEN = "old-token"',
        '',
        '[mcp_servers.haven_signer]',
        'command = "old"',
        '',
        '[mcp_servers.haven_signer.env]',
        'HAVEN_DELEGATE_KEY = "old-key"',
      ].join('\n'),
      WRAPPER_PATH,
    )

    expect(merged).toContain('model = "gpt-5"')
    expect(merged).toContain('approval_policy = "on-request"')
    expect(merged).toContain('[projects."/Users/example/Haven AI"]')
    expect(merged).toContain('trust_level = "trusted"')
    expect(merged).toContain('[mcp_servers.other]')
    expect(merged).toContain('[mcp_servers.haven]')
    expect(merged).toContain(`command = "${WRAPPER_PATH}"`)
    expect(merged).toContain('args = []')
    expect(merged).toContain('startup_timeout_sec = 120')
    expect(merged).not.toContain(IDENTITY_PATH)
    expect(merged).not.toContain('"--identity"')
    expect(merged).not.toContain('"--ack"')
    expect(merged).not.toContain(SIGNER_PATH)
    expect(merged).not.toContain('[mcp_servers.haven_signer]')
    expect(merged).not.toContain('[mcp_servers.haven.env]')
    expect(merged).not.toContain('[mcp_servers.haven_signer.env]')
    expect(merged).not.toContain('bearer_token_env_var')
    expect(merged).not.toContain('HAVEN_TOKEN')
    expect(merged).not.toContain('HAVEN_DELEGATE_KEY')
    expect(merged).not.toContain('https://old.example')
    expect(merged).not.toContain(HOSTED_URL)
    expect(merged).not.toContain(API_KEY)
    expect(merged).not.toContain(PRIVATE_KEY)
  })

  it('escapes Codex wrapper paths and validates Haven TOML values', () => {
    const wrapperPath = '/Users/example/Haven "AI"/agent/bin/haven-mcp'
    const merged = mergeCodexToml([
      'model = "gpt-5"',
      'disabled_mcp_servers = [',
      '  "old-server",',
      ']',
      '',
    ].join('\n'), wrapperPath)

    expect(merged).toContain('disabled_mcp_servers')
    expect(merged).toContain('command = "/Users/example/Haven \\"AI\\"/agent/bin/haven-mcp"')
    expect(() => validateCodexToml('command = node\n')).toThrow(/invalid TOML/i)
  })

  it('writes hosted Codex config with hosted MCP url and signer entry by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-hosted-config-'))
    const credentialsDir = join(dir, 'agent-1')

    const result = await writeRuntimeConfig({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      identityPath: join(credentialsDir, 'identity.json'),
      signerPath: SIGNER_PATH,
      credentialDirectory: credentialsDir,
      homeDir: dir,
    })

    const toml = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    expect(result.hostedConfigured).toBe(true)
    expect(result.signerConfigured).toBe(true)
    expect(result.localMcpConfigured).toBe(false)
    expect(result.runtimeMcpMode).toBe('hosted_plus_signer')
    expect(result.errorCode).toBeUndefined()
    expect(toml).toContain('[mcp_servers.haven]')
    expect(toml).toContain(`url = "${HOSTED_URL}"`)
    expect(toml).toContain(`http_headers = { "Authorization" = "Bearer ${API_KEY}" }`)
    expect(toml).toContain('[mcp_servers.haven_signer]')
    expect(toml).toContain('command = "npx"')
    expect(toml).toContain(SIGNER_PACKAGE)
    expect(toml).toContain(SIGNER_PATH)
    expect(toml).toContain('startup_timeout_sec = 120')
    expect(toml).not.toContain(PRIVATE_KEY)
    expect(toml).not.toMatch(/delegate_key|private_key/i)
  })

  it('hosted Codex merge replaces stale Haven tables and keeps unrelated tables', () => {
    const merged = mergeCodexTomlHosted(
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.other]',
        'command = "node"',
        '',
        '[mcp_servers.haven]',
        'command = "/old/wrapper"',
        '',
        '[mcp_servers.haven_signer]',
        'command = "old"',
      ].join('\n'),
      HOSTED_URL,
      API_KEY,
      { command: '/home/u/.haven/agents/agent-1/bin/haven-signer', args: [] },
    )

    expect(merged).toContain('model = "gpt-5"')
    expect(merged).toContain('[mcp_servers.other]')
    expect(merged).toContain(`url = "${HOSTED_URL}"`)
    expect(merged).not.toContain('/old/wrapper')
    expect(merged).not.toContain('command = "old"')
    // The prepared wrapper command is written, not a runtime npx invocation.
    expect(merged).toContain('command = "/home/u/.haven/agents/agent-1/bin/haven-signer"')
    expect(merged).not.toContain('npx')
    expect(() => validateCodexToml(merged)).not.toThrow()
  })

  it('writes Codex config with local stdio MCP and no env launcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-config-'))
    const credentialsDir = join(dir, 'agent-1')

    const result = await writeRuntimeConfig({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      identityPath: join(credentialsDir, 'identity.json'),
      signerPath: SIGNER_PATH,
      credentialDirectory: credentialsDir,
      localMcpCommand: join(credentialsDir, 'bin', 'haven-mcp'),
      homeDir: dir,
      mode: 'local',
    })

    const toml = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    expect(result.hostedConfigured).toBe(false)
    expect(result.signerConfigured).toBe(true)
    expect(result.localMcpConfigured).toBe(true)
    expect(result.runtimeMcpMode).toBe('local_stdio')
    expect(result.errorCode).toBeUndefined()
    expect(result.activationCommand).toBeUndefined()
    expect(toml).toContain(`command = "${join(credentialsDir, 'bin', 'haven-mcp')}"`)
    expect(toml).toContain('args = []')
    expect(toml).toContain('startup_timeout_sec = 120')
    expect(toml).not.toContain('--identity')
    expect(toml).not.toContain(join(credentialsDir, 'identity.json'))
    expect(toml).not.toContain('--signer')
    expect(toml).not.toContain('"--ack"')
    expect(toml).not.toContain(API_KEY)
    expect(toml).not.toContain(PRIVATE_KEY)
    expect(toml).not.toContain('bearer_token_env_var')
    expect(toml).not.toContain('haven_signer')
  })

  it('writes Codex Desktop config through the same stable local MCP wrapper', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-desktop-config-'))
    const credentialsDir = join(dir, 'agent-1')

    const result = await writeRuntimeConfig({
      runtime: 'codex-desktop',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      identityPath: join(credentialsDir, 'identity.json'),
      signerPath: SIGNER_PATH,
      credentialDirectory: credentialsDir,
      localMcpCommand: join(credentialsDir, 'bin', 'haven-mcp'),
      homeDir: dir,
      mode: 'local',
    })

    const toml = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    expect(result.localMcpConfigured).toBe(true)
    expect(result.runtimeMcpMode).toBe('local_stdio')
    expect(result.target).toBe('Codex Desktop config')
    expect(toml).toContain(`command = "${join(credentialsDir, 'bin', 'haven-mcp')}"`)
    expect(toml).toContain('args = []')
    expect(toml).not.toContain('npx')
    expect(toml).not.toContain(API_KEY)
    expect(toml).not.toContain(PRIVATE_KEY)
  })

  it('merges Hermes YAML without disturbing other settings and writes owner-only config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-hermes-config-'))
    const credentialsDir = join(dir, 'agent-1')
    const target = join(dir, '.hermes', 'config.yaml')
    const envTarget = join(dir, '.hermes', '.env')
    await mkdir(join(dir, '.hermes'), { recursive: true })
    await writeFile(envTarget, '# Existing Hermes secret\nOTHER_MCP_TOKEN=keep-me\n')
    await writeFile(target, [
      'model: hermes-4',
      'agent:',
      '  max_turns: 8',
      'mcp_servers:',
      '  existing:',
      '    command: node',
      '    args: [server.js]',
      '  haven:',
      '    url: https://old.example/v1',
    ].join('\n'))

    const result = await writeRuntimeConfig({
      runtime: 'hermes',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      identityPath: join(credentialsDir, 'identity.json'),
      signerPath: SIGNER_PATH,
      credentialDirectory: credentialsDir,
      signerCommand: { command: WRAPPER_PATH, args: [] },
      homeDir: dir,
    })
    const parsed = parse(await readFile(target, 'utf8')) as {
      model: string
      agent: { max_turns: number }
      mcp_servers: Record<string, { url?: string; command?: string; args?: string[]; headers?: Record<string, string>; enabled?: boolean }>
    }

    expect(result).toMatchObject({
      hostedConfigured: true,
      signerConfigured: true,
      localMcpConfigured: false,
      runtimeMcpMode: 'hosted_plus_signer',
      target: 'Hermes Agent config',
      restartRequired: true,
    })
    expect(result.messages.join('\n')).toContain('/restart')
    expect(result.messages.join('\n')).toContain('hermes mcp list')
    expect(result.messages.join('\n')).toContain('hermes mcp test haven')
    expect(result.messages.join('\n')).toContain('hermes mcp test haven-signer')
    expect(result.messages.join('\n')).toContain('pip install mcp')
    expect(parsed.model).toBe('hermes-4')
    expect(parsed.agent.max_turns).toBe(8)
    expect(parsed.mcp_servers.existing.command).toBe('node')
    expect(parsed.mcp_servers.haven).toMatchObject({
      url: HOSTED_URL,
      headers: { Authorization: 'Bearer ${MCP_HAVEN_API_KEY}' },
      enabled: true,
    })
    expect(await readFile(target, 'utf8')).not.toContain(API_KEY)
    expect(parsed.mcp_servers.haven).not.toHaveProperty('type')
    expect(parsed.mcp_servers['haven-signer']).toEqual({ command: WRAPPER_PATH, args: [], enabled: true })
    expect((await stat(target)).mode & 0o777).toBe(0o600)
    expect(await readFile(envTarget, 'utf8')).toBe('# Existing Hermes secret\nOTHER_MCP_TOKEN=keep-me\nMCP_HAVEN_API_KEY=sk_agent_secret_for_config_test\n')
    expect((await stat(envTarget)).mode & 0o777).toBe(0o600)

    const rerun = await writeRuntimeConfig({
      runtime: 'hermes',
      hostedMcpUrl: 'https://new-mcp.haven.example/v1',
      apiKey: 'sk_agent_replaced',
      identityPath: join(credentialsDir, 'identity.json'),
      signerPath: SIGNER_PATH,
      credentialDirectory: credentialsDir,
      signerCommand: { command: WRAPPER_PATH, args: [] },
      homeDir: dir,
    })
    const rerunParsed = parse(await readFile(target, 'utf8')) as {
      mcp_servers: Record<string, { url?: string; command?: string; args?: string[]; headers?: Record<string, string>; enabled?: boolean }>
    }
    expect(rerun.changed).toBe(true)
    expect(rerunParsed.mcp_servers.existing).toEqual({ command: 'node', args: ['server.js'] })
    expect(rerunParsed.mcp_servers.haven.url).toBe('https://new-mcp.haven.example/v1')
    expect(rerunParsed.mcp_servers.haven.headers?.Authorization).toBe('Bearer ${MCP_HAVEN_API_KEY}')
    expect(rerunParsed.mcp_servers['haven-signer']).toEqual({
      command: WRAPPER_PATH,
      args: [],
      enabled: true,
    })
    expect(Object.keys(rerunParsed.mcp_servers).filter((name) => name === 'haven')).toHaveLength(1)
    expect(await readFile(envTarget, 'utf8')).toBe('# Existing Hermes secret\nOTHER_MCP_TOKEN=keep-me\nMCP_HAVEN_API_KEY=sk_agent_replaced\n')

    const unchanged = await writeRuntimeConfig({
      runtime: 'hermes',
      hostedMcpUrl: 'https://new-mcp.haven.example/v1',
      apiKey: 'sk_agent_replaced',
      identityPath: join(credentialsDir, 'identity.json'),
      signerPath: SIGNER_PATH,
      credentialDirectory: credentialsDir,
      signerCommand: { command: WRAPPER_PATH, args: [] },
      homeDir: dir,
    })
    expect(unchanged.changed).toBe(false)
  })

  it('uses HERMES_HOME when set and otherwise writes beneath the supplied home directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-hermes-home-'))
    const hermesHome = join(dir, 'custom-hermes-home')
    const previousHermesHome = process.env.HERMES_HOME
    process.env.HERMES_HOME = hermesHome
    try {
      expect(hermesConfigPath(join(dir, 'unused-home'))).toBe(join(hermesHome, 'config.yaml'))
      expect(hermesEnvPath(join(dir, 'unused-home'))).toBe(join(hermesHome, '.env'))
      const result = await writeRuntimeConfig({
        runtime: 'hermes',
        hostedMcpUrl: HOSTED_URL,
        apiKey: API_KEY,
        identityPath: join(dir, 'identity.json'),
        signerPath: SIGNER_PATH,
        credentialDirectory: dir,
        homeDir: join(dir, 'unused-home'),
      })
      expect(result.errorCode).toBeUndefined()
      await expect(readFile(join(hermesHome, 'config.yaml'), 'utf8')).resolves.toContain('mcp_servers:')
      await expect(readFile(join(hermesHome, '.env'), 'utf8')).resolves.toContain(`MCP_HAVEN_API_KEY=${API_KEY}`)
    } finally {
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME
      else process.env.HERMES_HOME = previousHermesHome
    }
  })

  it('does not overwrite a Hermes config when its YAML is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-hermes-invalid-'))
    const target = join(dir, '.hermes', 'config.yaml')
    const envTarget = join(dir, '.hermes', '.env')
    const malformed = 'mcp_servers: [Bearer sk_agent_do_not_echo\n'
    await mkdir(join(dir, '.hermes'), { recursive: true })
    await writeFile(target, malformed)
    await writeFile(envTarget, 'OTHER_MCP_TOKEN=unchanged\n')

    const result = await writeRuntimeConfig({
      runtime: 'hermes',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      identityPath: join(dir, 'identity.json'),
      signerPath: SIGNER_PATH,
      credentialDirectory: dir,
      homeDir: dir,
    })

    expect(result.errorCode).toBe('runtime_config_write_failed')
    expect(result.changed).toBe(false)
    expect(result.messages.join('\n')).not.toContain('sk_agent_do_not_echo')
    expect(result.messages.join('\n')).not.toContain(malformed)
    expect(await readFile(target, 'utf8')).toBe(malformed)
    expect(await readFile(envTarget, 'utf8')).toBe('OTHER_MCP_TOKEN=unchanged\n')
  })

  it('does not overwrite Hermes config or dotenv when the managed dotenv key is ambiguous', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-hermes-ambiguous-env-'))
    const target = join(dir, '.hermes', 'config.yaml')
    const envTarget = join(dir, '.hermes', '.env')
    const existingConfig = 'model: hermes-4\n'
    const ambiguousEnv = 'MCP_HAVEN_API_KEY # do not parse this\n'
    await mkdir(join(dir, '.hermes'), { recursive: true })
    await writeFile(target, existingConfig)
    await writeFile(envTarget, ambiguousEnv)

    const result = await writeRuntimeConfig({
      runtime: 'hermes',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      identityPath: join(dir, 'identity.json'),
      signerPath: SIGNER_PATH,
      credentialDirectory: dir,
      homeDir: dir,
    })

    expect(result.errorCode).toBe('runtime_config_write_failed')
    expect(result.messages.join('\n')).not.toContain(API_KEY)
    expect(await readFile(target, 'utf8')).toBe(existingConfig)
    expect(await readFile(envTarget, 'utf8')).toBe(ambiguousEnv)
  })

  it('rolls back both Hermes files when writing config.yaml fails after dotenv succeeds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-hermes-rollback-'))
    const target = join(dir, '.hermes', 'config.yaml')
    const envTarget = join(dir, '.hermes', '.env')
    const existingConfig = 'model: hermes-4\nmcp_servers:\n  haven:\n    url: https://old.example/v1\n'
    const existingEnv = 'MCP_HAVEN_API_KEY=sk_agent_previous\nOTHER_MCP_TOKEN=keep\n'
    await mkdir(join(dir, '.hermes'), { recursive: true })
    await writeFile(target, existingConfig)
    await writeFile(envTarget, existingEnv)

    let failConfigOnce = true
    const result = await writeRuntimeConfig({
      runtime: 'hermes',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      identityPath: join(dir, 'identity.json'),
      signerPath: SIGNER_PATH,
      credentialDirectory: dir,
      homeDir: dir,
    }, {
      writeOwnerOnlyText: async (path, value) => {
        if (path === target && failConfigOnce) {
          failConfigOnce = false
          await writeFile(path, 'partial write that must be rolled back\n')
          throw new Error('simulated config write failure')
        }
        await writeFile(path, value)
      },
    })

    expect(result.errorCode).toBe('runtime_config_write_failed')
    expect(result.messages.join('\n')).not.toContain(API_KEY)
    expect(await readFile(target, 'utf8')).toBe(existingConfig)
    expect(await readFile(envTarget, 'utf8')).toBe(existingEnv)
  })

  it('restores the Hermes dotenv and reports incomplete recovery when config writes fail permanently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-hermes-permanent-rollback-'))
    const target = join(dir, '.hermes', 'config.yaml')
    const envTarget = join(dir, '.hermes', '.env')
    const existingConfig = 'model: hermes-4\n'
    const existingEnv = 'MCP_HAVEN_API_KEY=sk_agent_previous\n'
    await mkdir(join(dir, '.hermes'), { recursive: true })
    await writeFile(target, existingConfig)
    await writeFile(envTarget, existingEnv)

    const result = await writeRuntimeConfig({
      runtime: 'hermes',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      identityPath: join(dir, 'identity.json'),
      signerPath: SIGNER_PATH,
      credentialDirectory: dir,
      homeDir: dir,
    }, {
      writeOwnerOnlyText: async (path, value) => {
        if (path === target) {
          await writeFile(path, 'partial config write\n')
          throw new Error('simulated persistent config write failure')
        }
        await writeFile(path, value)
      },
    })

    expect(result.errorCode).toBe('runtime_config_write_failed')
    expect(result.messages.join('\n')).toContain('Recovery did not complete')
    expect(result.messages.join('\n')).not.toContain('left unchanged')
    expect(result.messages.join('\n')).not.toContain(API_KEY)
    expect(await readFile(envTarget, 'utf8')).toBe(existingEnv)
    expect(await readFile(target, 'utf8')).toBe('partial config write\n')
  })

  it('merges Hermes dotenv without rewriting unrelated lines and rejects ambiguous managed syntax', () => {
    expect(mergeHermesEnv('# preserve\r\nOTHER=value\r\nMCP_HAVEN_API_KEY=old\r\nMCP_HAVEN_API_KEY=duplicate\r\n', API_KEY)).toBe(
      `# preserve\r\nOTHER=value\r\nMCP_HAVEN_API_KEY=${API_KEY}\r\n`,
    )
    expect(mergeHermesEnv('OTHER=value', API_KEY)).toBe(`OTHER=value\nMCP_HAVEN_API_KEY=${API_KEY}\n`)
    expect(() => mergeHermesEnv('MCP_HAVEN_API_KEY\n', API_KEY)).toThrow('ambiguous managed key')
    expect(() => mergeHermesEnv(null, `${API_KEY}\nsecond-line`)).toThrow('single line')
  })

  it('replaces only malformed mcp_servers sections during a Hermes YAML merge', () => {
    const merged = mergeHermesYaml('model: hermes-4\nmcp_servers: false\n', { url: HOSTED_URL }, { command: 'npx', args: [] })
    const parsed = parse(merged) as { model: string; mcp_servers: Record<string, unknown> }
    expect(parsed.model).toBe('hermes-4')
    expect(parsed.mcp_servers).toMatchObject({ haven: { url: HOSTED_URL }, 'haven-signer': { command: 'npx', args: [] } })
  })

  it('preserves unrelated Hermes YAML comments and scalar source text byte-for-byte', () => {
    const existing = [
      '# Keep this comment and these scalar spellings exactly.',
      'model: 0123',
      'release: 2026-01-01',
      'ratio: 1e3',
      'mcp_servers:',
      '  existing:',
      '    command: node',
      'agent:',
      '  prompt: "do not rewrite this"',
      '',
    ].join('\n')

    const merged = mergeHermesYaml(
      existing,
      { url: HOSTED_URL, headers: { Authorization: `Bearer ${API_KEY}` } },
      { command: WRAPPER_PATH, args: [] },
    )

    expect(merged).toContain('# Keep this comment and these scalar spellings exactly.\nmodel: 0123\nrelease: 2026-01-01\nratio: 1e3\n')
    expect(merged).toContain('agent:\n  prompt: "do not rewrite this"\n')
    expect(parse(merged)).toMatchObject({
      mcp_servers: {
        existing: { command: 'node' },
        haven: { url: HOSTED_URL },
        'haven-signer': { command: WRAPPER_PATH, args: [] },
      },
    })
  })

  it('inserts Hermes MCP servers before a terminal YAML document-end marker', () => {
    const merged = mergeHermesYaml(
      'model: hermes-4\n...\n',
      { url: HOSTED_URL },
      { command: WRAPPER_PATH, args: [] },
    )

    expect(merged).toBe([
      'model: hermes-4',
      'mcp_servers:',
      `  haven:`,
      `    url: ${HOSTED_URL}`,
      '  haven-signer:',
      `    command: ${WRAPPER_PATH}`,
      '    args: []',
      '...',
      '',
    ].join('\n'))
    expect(parse(merged)).toMatchObject({ mcp_servers: { haven: { url: HOSTED_URL } } })
  })
})
