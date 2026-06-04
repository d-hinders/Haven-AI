import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SIGNER_VERSION } from '@haven_ai/signer'
import { describe, expect, it } from 'vitest'
import {
  mergeCodexToml,
  mergeJsonMcpConfig,
  writeRuntimeConfig,
} from './config-writers.js'

const API_KEY = 'sk_agent_secret_for_config_test'
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'
const HOSTED_URL = 'https://mcp.haven.example/v1'
const SIGNER_PATH = '/Users/example/.haven/agents/agent-1/signer.json'
const SIGNER_PACKAGE = `@haven_ai/signer@${SIGNER_VERSION}`

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
        '',
        '[mcp_servers.other]',
        'command = "node"',
        '',
        '[mcp_servers.haven]',
        'url = "https://old.example"',
        '',
        '[mcp_servers.haven_signer]',
        'command = "old"',
      ].join('\n'),
      HOSTED_URL,
      SIGNER_PATH,
    )

    expect(merged).toContain('model = "gpt-5"')
    expect(merged).toContain('[mcp_servers.other]')
    expect(merged).toContain('[mcp_servers.haven]')
    expect(merged).toContain(`url = "${HOSTED_URL}"`)
    expect(merged).toContain('bearer_token_env_var = "HAVEN_TOKEN"')
    expect(merged).toContain('[mcp_servers.haven_signer]')
    expect(merged).toContain(SIGNER_PACKAGE)
    expect(merged).not.toContain('"--ack"')
    expect(merged).toContain(`"${SIGNER_PATH}"`)
    expect(merged).not.toContain('https://old.example')
    expect(merged).not.toContain(API_KEY)
    expect(merged).not.toContain(PRIVATE_KEY)
  })

  it('writes Codex config and stores the bearer in a private env file, not TOML', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-config-'))
    const credentialsDir = join(dir, 'agent-1')

    const result = await writeRuntimeConfig({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath: SIGNER_PATH,
      credentialDirectory: credentialsDir,
      homeDir: dir,
    })

    const toml = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    const env = await readFile(join(credentialsDir, 'identity.env'), 'utf8')
    const launchPath = join(credentialsDir, 'start-codex.sh')
    const launcher = await readFile(launchPath, 'utf8')
    expect(result.hostedConfigured).toBe(true)
    expect(result.signerConfigured).toBe(true)
    expect(result.errorCode).toBeUndefined()
    expect(result.activationCommand).toContain('start-codex.sh')
    expect(toml).toContain('bearer_token_env_var = "HAVEN_TOKEN"')
    expect(toml).toContain(SIGNER_PACKAGE)
    expect(toml).not.toContain('"--ack"')
    expect(toml).not.toContain(API_KEY)
    expect(env).toContain(`export HAVEN_TOKEN='${API_KEY}'`)
    expect(env).not.toContain(PRIVATE_KEY)
    expect(launcher).toContain('identity.env')
    expect(launcher).toContain('exec codex "$@"')
    expect(launcher).not.toContain(API_KEY)
    expect(launcher).not.toContain(PRIVATE_KEY)
    if (process.platform !== 'win32') {
      expect((await stat(launchPath)).mode & 0o777).toBe(0o700)
    }
  })
})
