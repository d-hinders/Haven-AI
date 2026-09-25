import { chmod, mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadSignerCredentials,
  readAccountAddressEnv,
  readAccountAddressField,
  warnIfCredentialFilePermissive,
} from './credentials.js'

const ENV_KEYS = [
  'HAVEN_CREDENTIALS',
  'HAVEN_DELEGATE_KEY',
  'HAVEN_AGENT_ID',
  'HAVEN_ACCOUNT_ADDRESS',
  'HAVEN_WALLET_ADDRESS',
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
      accountAddress: '0xSafe',
      chainId: 100,
      network: 'Gnosis',
      x402BindingSigner: '0xBinding',
      sourcePath: file,
    })
  })

  it('loads signer credentials from environment variables', async () => {
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env'
    process.env.HAVEN_AGENT_ID = 'agent-env'
    process.env.HAVEN_ACCOUNT_ADDRESS = '0xSafeEnv'
    process.env.HAVEN_CHAIN_ID = '8453'
    process.env.HAVEN_NETWORK = 'Base'
    process.env.HAVEN_X402_BINDING_SIGNER = '0xBindingEnv'

    await expect(loadSignerCredentials(undefined)).resolves.toEqual({
      delegateKey: '0xdelegate-env',
      agentId: 'agent-env',
      accountAddress: '0xSafeEnv',
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

  it('#3172: a credential reached through a symlink is judged by its target — a link to a 0600 file stays silent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-perm-'))
    const target = join(dir, 'signer.json')
    const link = join(dir, 'signer-link.json')
    await writeFile(target, '{}')
    await chmod(target, 0o600)
    await symlink(target, link)

    const logged: string[] = []
    await warnIfCredentialFilePermissive(link, (m) => logged.push(m), 'linux')
    expect(logged).toEqual([])
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

/**
 * #2914 (naming epic #2906, phase 5 — the CONTRACTION): the credential-FILE
 * fallbacks (`safe_address` / `safeAddress`) stay PERMANENT — a file on disk
 * never rewrites itself — but the env fallbacks (`HAVEN_WALLET_ADDRESS` /
 * `HAVEN_SAFE_ADDRESS`) were window-scoped and are retired as of this
 * release: they no longer resolve an account address at all.
 *
 * Mutations run by hand before the PR: dropping `account_address` from
 * `readAccountAddressField` fails the new-shape file test; dropping
 * `safe_address` fails the old-shape file test; reintroducing either retired
 * env fallback fails the "no longer resolves" env cases below.
 */
describe('account address naming — file fallback permanent, env fallback retired (#2914)', () => {
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
      if (prev === undefined) delete process.env[key]
      else process.env[key] = prev
    }
  })

  async function fileWith(body: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'haven-signer-naming-'))
    const file = join(dir, 'signer.json')
    await writeFile(file, JSON.stringify({ delegate_key: '0xdelegate', ...body }))
    await chmod(file, 0o600)
    return file
  }

  it('OLD-shape file: safe_address only (pre-#2908 connect) — read, permanently', async () => {
    const creds = await loadSignerCredentials(await fileWith({ safe_address: '0xOld' }))
    expect(creds.accountAddress).toBe('0xOld')
  })

  it('OLD-shape file: camelCase safeAddress only — read, permanently', async () => {
    const creds = await loadSignerCredentials(await fileWith({ safeAddress: '0xOldCamel' }))
    expect(creds.accountAddress).toBe('0xOldCamel')
  })

  it('NEW-shape file: account_address only (what connect writes)', async () => {
    const creds = await loadSignerCredentials(await fileWith({ account_address: '0xNew' }))
    expect(creds.accountAddress).toBe('0xNew')
  })

  it('BOTH in the file: the new name wins', async () => {
    const creds = await loadSignerCredentials(await fileWith({ account_address: '0xNew', safe_address: '0xOld' }))
    expect(creds.accountAddress).toBe('0xNew')
  })

  it('the file chain is exactly account_address ?? safe_address ?? safeAddress', () => {
    expect(readAccountAddressField({ account_address: 'a', safe_address: 'b', safeAddress: 'c' })).toBe('a')
    expect(readAccountAddressField({ safe_address: 'b', safeAddress: 'c' })).toBe('b')
    expect(readAccountAddressField({ safeAddress: 'c' })).toBe('c')
    expect(readAccountAddressField({})).toBeUndefined()
  })

  // These two assert a REFUSAL, not an undefined result. Resolving to
  // undefined was the first cut and review caught what it cost: the sweep
  // tool passes `accountAddress` as `expectedSafe`, and an undefined
  // `expectedSafe` skips the check that a sweep's `to` matches the account in
  // the local credential. An operator who upgraded without touching env would
  // have silently lost a money-path cross-check.
  it('RETIRED env: HAVEN_SAFE_ADDRESS alone REFUSES at load, naming the replacement', async () => {
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env'
    process.env.HAVEN_SAFE_ADDRESS = '0xOldEnv'
    await expect(loadSignerCredentials(undefined)).rejects.toThrow(
      /HAVEN_SAFE_ADDRESS is retired[\s\S]*HAVEN_ACCOUNT_ADDRESS/,
    )
  })

  it('RETIRED env: HAVEN_WALLET_ADDRESS alone (the second handoff name) REFUSES at load', async () => {
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env'
    process.env.HAVEN_WALLET_ADDRESS = '0xWalletEnv'
    await expect(loadSignerCredentials(undefined)).rejects.toThrow(
      /HAVEN_WALLET_ADDRESS is retired/,
    )
  })

  it('NEW-shape env: HAVEN_ACCOUNT_ADDRESS only (the survivor)', async () => {
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env'
    process.env.HAVEN_ACCOUNT_ADDRESS = '0xNewEnv'
    expect((await loadSignerCredentials(undefined)).accountAddress).toBe('0xNewEnv')
  })

  it('HAVEN_ACCOUNT_ADDRESS is the only name read', () => {
    expect(readAccountAddressEnv({ HAVEN_ACCOUNT_ADDRESS: 'a' })).toBe('a')
    expect(readAccountAddressEnv({})).toBeUndefined()
  })

  // The retired env names are REFUSED, not ignored — the same rule the
  // backend applies to retired request names, and here the stakes are
  // higher. `accountAddress` is what the sweep tool passes as
  // `expectedSafe`, and an undefined `expectedSafe` SKIPS the check that a
  // sweep's `to` matches the account in the local credential. Ignoring these
  // would cost an operator a money-path cross-check with no signal at all.
  it('refuses a retired env name set ALONE, naming the replacement', () => {
    for (const name of ['HAVEN_WALLET_ADDRESS', 'HAVEN_SAFE_ADDRESS']) {
      expect(() => readAccountAddressEnv({ [name]: '0xabc' })).toThrow(
        /retired \(#2906\)[\s\S]*HAVEN_ACCOUNT_ADDRESS/,
      )
    }
    expect(() => readAccountAddressEnv({ HAVEN_WALLET_ADDRESS: 'w', HAVEN_SAFE_ADDRESS: 's' })).toThrow(
      /retired \(#2906\)/,
    )
  })

  it('accepts a retired name set ALONGSIDE the new one when they agree — reliance, not presence', () => {
    // A handoff or shell profile that still exports the old name next to the
    // new one is not a stale caller; refusing it would punish the operator
    // who migrated without cleaning up.
    expect(
      readAccountAddressEnv({ HAVEN_ACCOUNT_ADDRESS: '0xABC', HAVEN_SAFE_ADDRESS: '0xabc' }),
    ).toBe('0xABC')
    expect(
      readAccountAddressEnv({ HAVEN_ACCOUNT_ADDRESS: '0xabc', HAVEN_WALLET_ADDRESS: '0xabc' }),
    ).toBe('0xabc')
  })

  it('refuses a retired name that DISAGREES with HAVEN_ACCOUNT_ADDRESS', () => {
    expect(() =>
      readAccountAddressEnv({ HAVEN_ACCOUNT_ADDRESS: '0xabc', HAVEN_SAFE_ADDRESS: '0xdef' }),
    ).toThrow(/different addresses/)
  })
})
