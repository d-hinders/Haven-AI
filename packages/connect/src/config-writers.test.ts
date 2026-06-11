import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  mergeCodexToml,
  mergeCodexTomlHosted,
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
      SIGNER_PATH,
    )

    expect(merged).toContain('model = "gpt-5"')
    expect(merged).toContain('[mcp_servers.other]')
    expect(merged).toContain(`url = "${HOSTED_URL}"`)
    expect(merged).not.toContain('/old/wrapper')
    expect(merged).not.toContain('command = "old"')
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
})
