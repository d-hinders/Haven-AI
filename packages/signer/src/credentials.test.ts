import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSignerCredentials, warnIfCredentialFilePermissive } from './credentials.js'

const ENV_KEYS = [
  'HAVEN_CREDENTIALS',
  'HAVEN_DELEGATE_KEY',
  'HAVEN_AGENT_ID',
  'HAVEN_SAFE_ADDRESS',
  'HAVEN_CHAIN_ID',
  'HAVEN_NETWORK',
  'HAVEN_X402_BINDING_SIGNER',
] as const

describe('loadSignerCredentials', () => {
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

  it('loads signer credentials from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-credentials-'))
    const file = join(dir, 'signer.json')
    await writeFile(file, JSON.stringify({
      delegate_key: '0xdelegate',
      agent_id: 'agent-1',
      safe_address: '0xSafe',
      chain_id: '100',
      network: 'Gnosis',
      x402_binding_signer: '0xBinding',
    }))
    await chmod(file, 0o600)

    await expect(loadSignerCredentials(file)).resolves.toEqual({
      delegateKey: '0xdelegate',
      agentId: 'agent-1',
      safeAddress: '0xSafe',
      chainId: 100,
      network: 'Gnosis',
      x402BindingSigner: '0xBinding',
      sourcePath: file,
    })
  })

  it('loads signer credentials from environment variables', async () => {
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env'
    process.env.HAVEN_AGENT_ID = 'agent-env'
    process.env.HAVEN_SAFE_ADDRESS = '0xSafeEnv'
    process.env.HAVEN_CHAIN_ID = '8453'
    process.env.HAVEN_NETWORK = 'Base'
    process.env.HAVEN_X402_BINDING_SIGNER = '0xBindingEnv'

    await expect(loadSignerCredentials(undefined)).resolves.toEqual({
      delegateKey: '0xdelegate-env',
      agentId: 'agent-env',
      safeAddress: '0xSafeEnv',
      chainId: 8453,
      network: 'Base',
      x402BindingSigner: '0xBindingEnv',
    })
  })

  it('rejects malformed file chain_id values without leaking key material', async () => {
    const cases: unknown[] = ['1e2', '100.5', '-1', '0', '', 'base', 100.5, -1, 0, {}, []]

    for (const chainId of cases) {
      const dir = await mkdtemp(join(tmpdir(), 'haven-signer-bad-chain-'))
      const file = join(dir, 'signer.json')
      await writeFile(file, JSON.stringify({
        delegate_key: '0xdelegate-secret',
        chain_id: chainId,
      }))
      await chmod(file, 0o600)

      let error: unknown
      try {
        await loadSignerCredentials(file)
      } catch (err) {
        error = err
      }

      expect(error).toBeInstanceOf(Error)
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('chain_id must be a positive integer')
      expect(message).not.toContain('0xdelegate-secret')
      const rawValue = String(chainId)
      if (rawValue) expect(message).not.toContain(rawValue)
    }
  })

  it('rejects malformed HAVEN_CHAIN_ID values without leaking key material', async () => {
    const cases = ['1e2', '100.5', '-1', '0', '', 'base']

    for (const chainId of cases) {
      process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env-secret'
      process.env.HAVEN_CHAIN_ID = chainId

      let error: unknown
      try {
        await loadSignerCredentials(undefined)
      } catch (err) {
        error = err
      }

      expect(error).toBeInstanceOf(Error)
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('HAVEN_CHAIN_ID must be a positive integer')
      expect(message).not.toContain('0xdelegate-env-secret')
      if (chainId) expect(message).not.toContain(chainId)
    }
  })

  it('throws a useful error when no delegate key is configured', async () => {
    await expect(loadSignerCredentials(undefined)).rejects.toThrow(/HAVEN_DELEGATE_KEY|HAVEN_CREDENTIALS/)
  })
})

describe('warnIfCredentialFilePermissive', () => {
  it('stays silent when the file is owner-only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-perm-'))
    const file = join(dir, 'signer.json')
    await writeFile(file, '{}')
    await chmod(file, 0o600)

    const logged: string[] = []
    await warnIfCredentialFilePermissive(file, (m) => logged.push(m), 'linux')
    expect(logged).toEqual([])
  })

  it('warns when the file is readable beyond the owner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-perm-'))
    const file = join(dir, 'signer.json')
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
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-perm-'))
    const file = join(dir, 'signer.json')
    await writeFile(file, '{}')
    await chmod(file, 0o644)

    const logged: string[] = []
    await warnIfCredentialFilePermissive(file, (m) => logged.push(m), 'win32')
    expect(logged).toEqual([])
  })
})
