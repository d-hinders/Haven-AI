import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadCredentials, warnIfCredentialFilePermissive } from './credentials.js'

const ENV_KEYS = [
  'HAVEN_CREDENTIALS',
  'HAVEN_API_KEY',
  'HAVEN_DELEGATE_KEY',
  'HAVEN_AGENT_ID',
  'HAVEN_SAFE_ADDRESS',
  'HAVEN_API_URL',
] as const

describe('loadCredentials', () => {
  const originalEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    originalEnv.clear()
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const prev = originalEnv.get(key)
      if (prev === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = prev
      }
    }
  })

  it('loads snake_case Haven credential files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-'))
    const file = join(dir, 'agent.json')
    await writeFile(file, JSON.stringify({
      api_key: 'sk_agent_test',
      delegate_key: '0xdelegate',
      agent_id: 'agent-1',
      safe_address: '0xSafe',
      api_url: 'https://haven.example',
    }))
    await chmod(file, 0o600)

    await expect(loadCredentials(file)).resolves.toEqual({
      apiKey: 'sk_agent_test',
      delegateKey: '0xdelegate',
      agentId: 'agent-1',
      safeAddress: '0xSafe',
      apiUrl: 'https://haven.example',
      sourcePath: file,
    })
  })

  it('returns sourcePath when the file path comes from HAVEN_CREDENTIALS', async () => {
    // Regression for PR #176 review P3: the consent gate needs the
    // resolved file path so --ack can locate a sidecar regardless of
    // whether the path came from --credentials or HAVEN_CREDENTIALS.
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-'))
    const file = join(dir, 'agent.json')
    await writeFile(file, JSON.stringify({ api_key: 'sk', delegate_key: '0x' }))
    await chmod(file, 0o600)

    process.env.HAVEN_CREDENTIALS = file
    const creds = await loadCredentials()
    expect(creds.sourcePath).toBe(file)
  })

  it('omits sourcePath when credentials come from inline env vars', async () => {
    process.env.HAVEN_API_KEY = 'sk'
    process.env.HAVEN_DELEGATE_KEY = '0x'
    const creds = await loadCredentials(undefined)
    expect(creds.sourcePath).toBeUndefined()
  })

  it('refuses to start without a delegate key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-'))
    const file = join(dir, 'agent.json')
    await writeFile(file, JSON.stringify({ api_key: 'sk_agent_test' }))
    await chmod(file, 0o600)

    await expect(loadCredentials(file)).rejects.toThrow('delegate_key')
  })

  it('loads credentials from HAVEN_API_KEY + HAVEN_DELEGATE_KEY env vars when no file is given', async () => {
    process.env.HAVEN_API_KEY = 'sk_agent_env'
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env'
    process.env.HAVEN_AGENT_ID = 'agent-env'
    process.env.HAVEN_SAFE_ADDRESS = '0xSafeEnv'
    process.env.HAVEN_API_URL = 'https://haven.env.example'

    await expect(loadCredentials(undefined)).resolves.toEqual({
      apiKey: 'sk_agent_env',
      delegateKey: '0xdelegate-env',
      agentId: 'agent-env',
      safeAddress: '0xSafeEnv',
      apiUrl: 'https://haven.env.example',
      sourcePath: undefined,
    })
  })

  it('rejects partial env-var credentials', async () => {
    process.env.HAVEN_API_KEY = 'sk_agent_env'
    // HAVEN_DELEGATE_KEY missing on purpose

    await expect(loadCredentials(undefined)).rejects.toThrow('HAVEN_DELEGATE_KEY')

    delete process.env.HAVEN_API_KEY
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-only'

    await expect(loadCredentials(undefined)).rejects.toThrow('HAVEN_API_KEY')
  })

  it('prefers an explicit path over inline env vars', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-'))
    const file = join(dir, 'agent.json')
    await writeFile(file, JSON.stringify({
      api_key: 'sk_agent_file',
      delegate_key: '0xdelegate-file',
    }))
    await chmod(file, 0o600)
    process.env.HAVEN_API_KEY = 'sk_agent_env'
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env'

    const creds = await loadCredentials(file)
    expect(creds.apiKey).toBe('sk_agent_file')
    expect(creds.delegateKey).toBe('0xdelegate-file')
  })

  it('throws a useful error when nothing is configured', async () => {
    await expect(loadCredentials(undefined)).rejects.toThrow(/HAVEN_CREDENTIALS|HAVEN_API_KEY/)
  })
})

describe('warnIfCredentialFilePermissive', () => {
  it('stays silent when the file is owner-only (0600)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-perm-'))
    const file = join(dir, 'agent.json')
    await writeFile(file, '{}')
    await chmod(file, 0o600)

    const logged: string[] = []
    await warnIfCredentialFilePermissive(file, (m) => logged.push(m), 'linux')
    expect(logged).toEqual([])
  })

  it('warns when the file is readable by group or world', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-perm-'))
    const file = join(dir, 'agent.json')
    await writeFile(file, '{}')
    await chmod(file, 0o644)

    const logged: string[] = []
    await warnIfCredentialFilePermissive(file, (m) => logged.push(m), 'linux')
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(file)
    expect(logged[0]).toMatch(/chmod 600/)
    expect(logged[0]).toMatch(/0644/)
  })

  it('skips the check on Windows where mode bits do not map cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-perm-'))
    const file = join(dir, 'agent.json')
    await writeFile(file, '{}')
    await chmod(file, 0o644)

    const logged: string[] = []
    await warnIfCredentialFilePermissive(file, (m) => logged.push(m), 'win32')
    expect(logged).toEqual([])
  })

  it('silently ignores stat failures', async () => {
    const logged: string[] = []
    await warnIfCredentialFilePermissive('/nonexistent/path/agent.json', (m) => logged.push(m), 'linux')
    expect(logged).toEqual([])
  })
})
