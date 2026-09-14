import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  loadCredentials,
  readAccountAddressEnv,
  readAccountAddressField,
  warnIfCredentialFilePermissive,
} from './credentials.js'

const ENV_KEYS = [
  'HAVEN_CREDENTIALS',
  'HAVEN_API_KEY',
  'HAVEN_DELEGATE_KEY',
  'HAVEN_AGENT_ID',
  'HAVEN_ACCOUNT_ADDRESS',
  'HAVEN_WALLET_ADDRESS',
  'HAVEN_SAFE_ADDRESS',
  'HAVEN_CHAIN_ID',
  'HAVEN_NETWORK',
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
      chain_id: 100,
      network: 'Gnosis',
      api_url: 'https://haven.example',
      allowance_summary: [{ token: 'USDC', amount: '25000000', resetMinutes: 1440 }],
    }))
    await chmod(file, 0o600)

    await expect(loadCredentials(file)).resolves.toEqual({
      apiKey: 'sk_agent_test',
      delegateKey: '0xdelegate',
      agentId: 'agent-1',
      accountAddress: '0xSafe',
      safeAddress: '0xSafe',
      chainId: 100,
      network: 'Gnosis',
      apiUrl: 'https://haven.example',
      allowanceSummary: [{ token: 'USDC', amount: '25000000', resetMinutes: 1440 }],
      sourcePath: file,
    })
  })

  it('loads split identity and signer credential files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-split-'))
    const identityPath = join(dir, 'identity.json')
    const signerPath = join(dir, 'signer.json')
    await writeFile(identityPath, JSON.stringify({
      api_key: 'sk_agent_split',
      agent_id: 'agent-1',
      safe_address: '0xSafe',
      chain_id: 100,
      network: 'Gnosis',
      api_url: 'https://haven.example',
      agent_budget: [{ token_symbol: 'USDC', allowance_amount: '25000000', reset_period_min: 1440 }],
    }))
    await writeFile(signerPath, JSON.stringify({
      delegate_key: '0xdelegate',
      delegate_address: '0xDelegate',
      agent_id: 'agent-1',
      safe_address: '0xsafe',
      chain_id: '100',
      network: 'gnosis',
    }))
    await chmod(identityPath, 0o600)
    await chmod(signerPath, 0o600)

    await expect(loadCredentials({ identityPath, signerPath })).resolves.toEqual({
      apiKey: 'sk_agent_split',
      delegateKey: '0xdelegate',
      agentId: 'agent-1',
      accountAddress: '0xSafe',
      safeAddress: '0xSafe',
      delegateAddress: '0xDelegate',
      chainId: 100,
      network: 'Gnosis',
      apiUrl: 'https://haven.example',
      allowanceSummary: [{ token: 'USDC', amount: '25000000', resetMinutes: 1440 }],
      sourcePath: identityPath,
      identityPath,
      signerPath,
    })
  })

  it('rejects split credential metadata mismatches without leaking raw values', async () => {
    const cases = [
      {
        label: 'agent_id',
        identity: { agent_id: 'agent-1' },
        signer: { agent_id: 'agent-2' },
        rawValues: ['agent-1', 'agent-2'],
      },
      {
        // #2908: the mismatch is labelled by the name connect now writes,
        // whichever spelling the two files happen to carry.
        label: 'account_address',
        identity: { safe_address: '0xSafeA' },
        signer: { safe_address: '0xSafeB' },
        rawValues: ['0xSafeA', '0xSafeB'],
      },
      {
        label: 'account_address',
        identity: { account_address: '0xSafeA' },
        signer: { safe_address: '0xSafeB' },
        rawValues: ['0xSafeA', '0xSafeB'],
      },
      {
        label: 'delegate_address',
        identity: { delegate_address: '0xDelegateA' },
        signer: { delegate_address: '0xDelegateB' },
        rawValues: ['0xDelegateA', '0xDelegateB'],
      },
      {
        label: 'chain_id',
        identity: { chain_id: 100 },
        signer: { chain_id: '8453' },
        rawValues: ['100', '8453'],
      },
      {
        label: 'network',
        identity: { network: 'Gnosis' },
        signer: { network: 'Base' },
        rawValues: ['Gnosis', 'Base'],
      },
    ] as const

    for (const testCase of cases) {
      const dir = await mkdtemp(join(tmpdir(), `haven-mcp-split-${testCase.label}-`))
      const identityPath = join(dir, 'identity.json')
      const signerPath = join(dir, 'signer.json')
      await writeFile(identityPath, JSON.stringify({
        api_key: 'sk_agent_split',
        agent_id: 'agent-1',
        safe_address: '0xSafe',
        chain_id: 100,
        network: 'Gnosis',
        ...testCase.identity,
      }))
      await writeFile(signerPath, JSON.stringify({
        delegate_key: '0xdelegate',
        delegate_address: '0xDelegate',
        agent_id: 'agent-1',
        safe_address: '0xsafe',
        chain_id: '100',
        network: 'gnosis',
        ...testCase.signer,
      }))
      await chmod(identityPath, 0o600)
      await chmod(signerPath, 0o600)

      let error: unknown
      try {
        await loadCredentials({ identityPath, signerPath })
      } catch (err) {
        error = err
      }

      expect(error).toBeInstanceOf(Error)
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain(`mismatched ${testCase.label} values`)
      for (const value of ['sk_agent_split', '0xdelegate', ...testCase.rawValues]) {
        expect(message).not.toContain(value)
      }
    }
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
      accountAddress: '0xSafeEnv',
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

/**
 * #2908 (naming epic #2906): every reader takes an OLD-shape and a NEW-shape
 * input. This runtime's credential shape had no `accountAddress` key before
 * this slice (the epic's review point), so both keys are asserted explicitly
 * rather than assumed from the signer's shape. File fallbacks are permanent;
 * env fallbacks are dropped at #2914.
 *
 * Mutations run by hand before the PR: dropping `account_address` from
 * `readAccountAddressField` fails the new-shape tests; dropping
 * `safe_address` fails the old-shape tests.
 */
describe('account address naming window (#2908)', () => {
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

  async function singleFile(body: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-naming-'))
    const file = join(dir, 'agent.json')
    await writeFile(file, JSON.stringify({ api_key: 'sk_agent_test', delegate_key: '0xdelegate', ...body }))
    await chmod(file, 0o600)
    return file
  }

  async function splitFiles(identity: Record<string, unknown>, signer: Record<string, unknown>) {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-naming-split-'))
    const identityPath = join(dir, 'identity.json')
    const signerPath = join(dir, 'signer.json')
    await writeFile(identityPath, JSON.stringify({ api_key: 'sk_agent_split', agent_id: 'agent-1', ...identity }))
    await writeFile(signerPath, JSON.stringify({ delegate_key: '0xdelegate', agent_id: 'agent-1', ...signer }))
    await chmod(identityPath, 0o600)
    await chmod(signerPath, 0o600)
    return { identityPath, signerPath }
  }

  it('OLD-shape single file: safe_address only — read, permanently, into BOTH keys', async () => {
    const creds = await loadCredentials(await singleFile({ safe_address: '0xOld' }))
    expect(creds.accountAddress).toBe('0xOld')
    expect(creds.safeAddress).toBe('0xOld')
  })

  it('NEW-shape single file: account_address only', async () => {
    const creds = await loadCredentials(await singleFile({ account_address: '0xNew' }))
    expect(creds.accountAddress).toBe('0xNew')
    expect(creds.safeAddress).toBe('0xNew')
  })

  it('BOTH in the single file: the new name wins', async () => {
    const creds = await loadCredentials(await singleFile({ account_address: '0xNew', safe_address: '0xOld' }))
    expect(creds.accountAddress).toBe('0xNew')
  })

  it('OLD-shape split files: safe_address in both', async () => {
    const creds = await loadCredentials(await splitFiles({ safe_address: '0xOld' }, { safe_address: '0xold' }))
    expect(creds.accountAddress).toBe('0xOld')
    expect(creds.safeAddress).toBe('0xOld')
  })

  it('NEW-shape split files: account_address in both', async () => {
    const creds = await loadCredentials(await splitFiles({ account_address: '0xNew' }, { account_address: '0xnew' }))
    expect(creds.accountAddress).toBe('0xNew')
  })

  it('MIXED split files (one rewritten, one not): the two spellings still have to agree', async () => {
    const creds = await loadCredentials(await splitFiles({ account_address: '0xSame' }, { safe_address: '0xsame' }))
    expect(creds.accountAddress).toBe('0xSame')
    await expect(
      loadCredentials(await splitFiles({ account_address: '0xOne' }, { safe_address: '0xTwo' })),
    ).rejects.toThrow('mismatched account_address')
  })

  it('the file chain is exactly account_address ?? safe_address ?? safeAddress', () => {
    expect(readAccountAddressField({ account_address: 'a', safe_address: 'b', safeAddress: 'c' })).toBe('a')
    expect(readAccountAddressField({ safe_address: 'b', safeAddress: 'c' })).toBe('b')
    expect(readAccountAddressField({ safeAddress: 'c' })).toBe('c')
    expect(readAccountAddressField({})).toBeUndefined()
  })

  it('OLD-shape env: HAVEN_SAFE_ADDRESS only', async () => {
    process.env.HAVEN_API_KEY = 'sk_agent_env'
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env'
    process.env.HAVEN_SAFE_ADDRESS = '0xOldEnv'
    const creds = await loadCredentials(undefined)
    expect(creds.accountAddress).toBe('0xOldEnv')
    expect(creds.safeAddress).toBe('0xOldEnv')
  })

  it('OLD-shape env: HAVEN_WALLET_ADDRESS only', async () => {
    process.env.HAVEN_API_KEY = 'sk_agent_env'
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env'
    process.env.HAVEN_WALLET_ADDRESS = '0xWalletEnv'
    expect((await loadCredentials(undefined)).accountAddress).toBe('0xWalletEnv')
  })

  it('NEW-shape env: HAVEN_ACCOUNT_ADDRESS only (the survivor)', async () => {
    process.env.HAVEN_API_KEY = 'sk_agent_env'
    process.env.HAVEN_DELEGATE_KEY = '0xdelegate-env'
    process.env.HAVEN_ACCOUNT_ADDRESS = '0xNewEnv'
    expect((await loadCredentials(undefined)).accountAddress).toBe('0xNewEnv')
  })

  it('the env chain is exactly HAVEN_ACCOUNT_ADDRESS ?? HAVEN_WALLET_ADDRESS ?? HAVEN_SAFE_ADDRESS', () => {
    expect(readAccountAddressEnv({ HAVEN_ACCOUNT_ADDRESS: 'a', HAVEN_WALLET_ADDRESS: 'w', HAVEN_SAFE_ADDRESS: 's' })).toBe('a')
    expect(readAccountAddressEnv({ HAVEN_WALLET_ADDRESS: 'w', HAVEN_SAFE_ADDRESS: 's' })).toBe('w')
    expect(readAccountAddressEnv({ HAVEN_SAFE_ADDRESS: 's' })).toBe('s')
    expect(readAccountAddressEnv({})).toBeUndefined()
  })
})
