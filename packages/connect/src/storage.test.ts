import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertServerSlugAvailable,
  defaultAgentDirectory,
  preflightCredentialStorage,
  readStoredAccountAddress,
  readStoredCredentials,
  rewriteCredentialFiles,
  writeConnectOutcomeRecord,
  writeCredentialFiles,
  CONNECT_OUTCOME_FILENAME,
} from './storage.js'
import { writeFile } from 'node:fs/promises'

describe('writeCredentialFiles', () => {
  it('writes separated owner-only identity and signer credential files', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-connect-'))
    const paths = await writeCredentialFiles({
      baseDir,
      agentId: 'agent-1',
      apiKey: 'sk_agent_testsecret',
      delegateKey: `0x${'11'.repeat(32)}`,
      delegateAddress: '0x1111111111111111111111111111111111111111',
      accountAddress: '0x2222222222222222222222222222222222222222',
      chainId: 100,
      network: 'Gnosis',
      agentBudget: [{ token_symbol: 'USDC', allowance_amount: '25000000', reset_period_min: 1440 }],
      apiUrl: 'https://api.haven.example',
      hostedMcpUrl: 'https://mcp.haven.example/v1',
    })

    const identity = await readFile(paths.identityPath, 'utf8')
    const signer = await readFile(paths.signerPath, 'utf8')

    expect(identity).toContain('sk_agent_testsecret')
    expect(identity).not.toContain('delegate_key')
    expect(identity).not.toContain('1111111111111111111111111111111111111111111111111111111111111111')

    expect(signer).toContain('delegate_key')
    expect(signer).toContain('delegate_address')
    expect(signer).toContain('1111111111111111111111111111111111111111111111111111111111111111')
    expect(signer).not.toContain('sk_agent_testsecret')
    expect(identity).toContain('agent_budget')

    // Non-secret orientation file: identity + configured budget, no keys.
    const agent = await readFile(paths.agentPath, 'utf8')
    const agentJson = JSON.parse(agent)
    expect(agentJson.agent_id).toBe('agent-1')
    // #2908: the writer emits the account-vocabulary name ONLY — never the
    // pre-#2908 `safe_address` (the readers fall back to it permanently, so
    // nothing needs both in a freshly written file).
    expect(agentJson.account_address).toBe('0x2222222222222222222222222222222222222222')
    expect(agentJson).not.toHaveProperty('safe_address')
    expect(JSON.parse(identity).account_address).toBe('0x2222222222222222222222222222222222222222')
    expect(JSON.parse(signer).account_address).toBe('0x2222222222222222222222222222222222222222')
    expect(identity).not.toContain('safe_address')
    expect(signer).not.toContain('safe_address')
    expect(agentJson.network).toBe('Gnosis')
    expect(agentJson.agent_budget).toEqual([
      { token_symbol: 'USDC', allowance_amount: '25000000', reset_period_min: 1440 },
    ])
    // Must NOT carry the API key or the delegate private key.
    expect(agent).not.toContain('sk_agent_testsecret')
    expect(agent).not.toContain('delegate_key')
    expect(agent).not.toContain('1111111111111111111111111111111111111111111111111111111111111111')

    if (process.platform !== 'win32') {
      expect((await stat(paths.identityPath)).mode & 0o777).toBe(0o600)
      expect((await stat(paths.signerPath)).mode & 0o777).toBe(0o600)
      expect((await stat(paths.agentPath)).mode & 0o777).toBe(0o600)
    }
  })

  it('writes x402_binding_signer into signer.json when provided, and omits it otherwise', async () => {
    const bindingSigner = '0x3b35f00021032F6cC8ad20bd136BD945DAd04d04'

    const withBinding = await writeCredentialFiles({
      baseDir: await mkdtemp(join(tmpdir(), 'haven-connect-binding-')),
      agentId: 'agent-binding',
      apiKey: 'sk_agent_b',
      delegateKey: `0x${'22'.repeat(32)}`,
      delegateAddress: '0x2222222222222222222222222222222222222222',
      apiUrl: 'https://api.haven.example',
      hostedMcpUrl: 'https://mcp.haven.example/v1',
      x402BindingSigner: bindingSigner,
    })
    const signerWith = JSON.parse(await readFile(withBinding.signerPath, 'utf8'))
    expect(signerWith.x402_binding_signer).toBe(bindingSigner)

    const withoutBinding = await writeCredentialFiles({
      baseDir: await mkdtemp(join(tmpdir(), 'haven-connect-nobinding-')),
      agentId: 'agent-nobinding',
      apiKey: 'sk_agent_n',
      delegateKey: `0x${'33'.repeat(32)}`,
      delegateAddress: '0x3333333333333333333333333333333333333333',
      apiUrl: 'https://api.haven.example',
      hostedMcpUrl: 'https://mcp.haven.example/v1',
    })
    const signerWithout = JSON.parse(await readFile(withoutBinding.signerPath, 'utf8'))
    expect('x402_binding_signer' in signerWithout).toBe(false)
  })

  it('does not overwrite an existing credential file', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-connect-existing-'))
    const input = {
      baseDir,
      agentId: 'agent-1',
      apiKey: 'sk_agent_testsecret',
      delegateKey: `0x${'11'.repeat(32)}`,
      delegateAddress: '0x1111111111111111111111111111111111111111',
      apiUrl: 'https://api.haven.example',
      hostedMcpUrl: 'https://mcp.haven.example/v1',
    }

    await writeCredentialFiles(input)
    await expect(writeCredentialFiles(input)).rejects.toThrow(/EEXIST|exist/i)
  })

  // #1544 re-run characterization: a second setup on an already-configured
  // machine is a NEW agent id, and credential storage is per-agent — the new
  // write lands in a sibling directory and the previous agent's files stay
  // byte-identical. Nothing revokes or rewrites the old credentials locally.
  it('writes a second agent alongside the first without touching the first', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-connect-second-agent-'))
    const first = await writeCredentialFiles({
      baseDir,
      agentId: 'agent-1',
      apiKey: 'sk_agent_firstsecret',
      delegateKey: `0x${'11'.repeat(32)}`,
      delegateAddress: '0x1111111111111111111111111111111111111111',
      apiUrl: 'https://api.haven.example',
      hostedMcpUrl: 'https://mcp.haven.example/v1',
    })
    const firstIdentity = await readFile(first.identityPath, 'utf8')
    const firstSigner = await readFile(first.signerPath, 'utf8')

    const second = await writeCredentialFiles({
      baseDir,
      agentId: 'agent-2',
      apiKey: 'sk_agent_secondsecret',
      delegateKey: `0x${'22'.repeat(32)}`,
      delegateAddress: '0x2222222222222222222222222222222222222222',
      apiUrl: 'https://api.haven.example',
      hostedMcpUrl: 'https://mcp.haven.example/v1',
    })

    expect(second.directory).not.toBe(first.directory)
    // The old agent's key material is exactly as it was — present and unrotated.
    expect(await readFile(first.identityPath, 'utf8')).toBe(firstIdentity)
    expect(await readFile(first.signerPath, 'utf8')).toBe(firstSigner)
    // The new agent's files carry only the new agent's material.
    const secondSigner = await readFile(second.signerPath, 'utf8')
    expect(secondSigner).toContain('agent-2')
    expect(secondSigner).not.toContain(`0x${'11'.repeat(32)}`)
  })

  it('preflights credential storage before setup registration', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-connect-preflight-'))
    const directory = await preflightCredentialStorage({ baseDir })

    expect(directory).toBe(baseDir)
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
    }
  })
})

describe('slug-keyed credential directories (#1696)', () => {
  it('a NAMED agent lives at <root>/<slug>; unnamed keeps the agent-uuid path', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-storage-slug-'))
    const named = await writeCredentialFiles({ ...credentialInput(), baseDir, serverName: 'work' })
    expect(named.directory).toBe(join(baseDir, 'work'))

    const unnamed = await writeCredentialFiles({ ...credentialInput('agt_other'), baseDir })
    expect(unnamed.directory).toBe(join(baseDir, 'agt_other'))
  })

  it('MUTATION PROOF: the slug path is stable across a re-key — it never depends on a rotating credential', async () => {
    // #1700's in-place rewrite depends on this: same slug, DIFFERENT keys,
    // same directory.
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-storage-stable-'))
    const first = await writeCredentialFiles({ ...credentialInput(), baseDir, serverName: 'work' })
    const again = defaultAgentDirectory('work', baseDir)
    expect(again).toBe(first.directory)
  })

  it('assertServerSlugAvailable refuses a slug whose directory holds credentials, allows a fresh or empty one', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-storage-avail-'))
    await expect(assertServerSlugAvailable('work', baseDir)).resolves.toBeUndefined()
    await writeCredentialFiles({ ...credentialInput(), baseDir, serverName: 'work' })
    await expect(assertServerSlugAvailable('work', baseDir)).rejects.toThrow(/already wired/)
    // An empty leftover directory does not count as taken.
    await mkdir(join(baseDir, 'empty-slug'), { recursive: true })
    await expect(assertServerSlugAvailable('empty-slug', baseDir)).resolves.toBeUndefined()
  })
})

function credentialInput(agentId = 'agt_1696') {
  return {
    agentId,
    apiKey: 'sk_agent_x',
    delegateKey: '0x' + '11'.repeat(32),
    delegateAddress: '0x' + 'ab'.repeat(20),
    apiUrl: 'https://api.haven.example',
    hostedMcpUrl: 'https://mcp.haven.example/mcp',
  }
}

describe('writeConnectOutcomeRecord (#2173)', () => {
  it('writes the record pretty-printed, owner-only, at the documented filename', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haven-outcome-record-'))
    const outcome = { schema_version: 1, outcome: 'complete', superseded_agent_ids: [] }

    const path = await writeConnectOutcomeRecord(directory, outcome)

    expect(path).toBe(join(directory, CONNECT_OUTCOME_FILENAME))
    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw)).toEqual(outcome)
    // Pretty-printed and newline-terminated: a human recovering a lost stream
    // reads this file directly as often as a parser does.
    expect(raw).toBe(`${JSON.stringify(outcome, null, 2)}\n`)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('replaces an earlier record rather than refusing like a credential file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haven-outcome-record-'))
    await writeConnectOutcomeRecord(directory, { outcome: 'failed' })

    const path = await writeConnectOutcomeRecord(directory, { outcome: 'complete' })

    // A stale verdict left in place is exactly what this file exists to
    // prevent, so `assertDoesNotExist` would be the wrong guard here.
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ outcome: 'complete' })
  })

  it('reports a directory it cannot write into instead of failing silently', async () => {
    const directory = join(await mkdtemp(join(tmpdir(), 'haven-outcome-record-')), 'does-not-exist')

    // The swallow is the caller's contract (runConnect), never this writer's —
    // a silent no-op here would make an injected failing writer untestable.
    await expect(writeConnectOutcomeRecord(directory, { outcome: 'complete' })).rejects.toThrow()
  })
})

/**
 * #2908 (naming epic #2906): the stored-credential reader takes an OLD-shape
 * set (`safe_address`, written before this release) and a NEW-shape set
 * (`account_address`, written by this release). The old fallback is
 * permanent. Mutations run by hand: dropping `account_address` from
 * `readStoredAccountAddress` fails the new-shape test; dropping
 * `safe_address` fails the old-shape test.
 */
describe('readStoredCredentials — account address naming window (#2908)', () => {
  const ADDRESS = '0x3333333333333333333333333333333333333333'
  async function seed(identityExtra: Record<string, unknown>, agentExtra: Record<string, unknown> = {}) {
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-connect-naming-'))
    const directory = defaultAgentDirectory('agent-1', baseDir)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'identity.json'), JSON.stringify({
      api_key: 'sk_agent_x', agent_id: 'agent-1', api_url: 'https://api.haven.example',
      hosted_mcp_url: 'https://api.haven.example/mcp', ...identityExtra,
    }))
    await writeFile(join(directory, 'agent.json'), JSON.stringify({ agent_id: 'agent-1', ...agentExtra }))
    await writeFile(join(directory, 'signer.json'), JSON.stringify({ delegate_key: '0xkey', agent_id: 'agent-1' }))
    return baseDir
  }

  it('OLD shape: safe_address only — read, and reported as the old key', async () => {
    const stored = await readStoredCredentials(undefined, 'agent-1', await seed({ safe_address: ADDRESS }))
    expect(stored.accountAddress).toBe(ADDRESS)
    expect(stored.accountAddressKey).toBe('safe_address')
  })

  it('NEW shape: account_address only', async () => {
    const stored = await readStoredCredentials(undefined, 'agent-1', await seed({ account_address: ADDRESS }))
    expect(stored.accountAddress).toBe(ADDRESS)
    expect(stored.accountAddressKey).toBe('account_address')
  })

  it('BOTH: the new name wins', async () => {
    const stored = await readStoredCredentials(undefined, 'agent-1', await seed({ account_address: ADDRESS, safe_address: '0xold' }))
    expect(stored.accountAddress).toBe(ADDRESS)
    expect(stored.accountAddressKey).toBe('account_address')
  })

  it('the chain is account_address (identity, agent) then safe_address (identity, agent)', () => {
    expect(readStoredAccountAddress({ account_address: 'a' }, { account_address: 'b', safe_address: 'c' })).toEqual({ accountAddress: 'a', accountAddressKey: 'account_address' })
    expect(readStoredAccountAddress({}, { account_address: 'b' })).toEqual({ accountAddress: 'b', accountAddressKey: 'account_address' })
    expect(readStoredAccountAddress({ safe_address: 'c' }, { safe_address: 'd' })).toEqual({ accountAddress: 'c', accountAddressKey: 'safe_address' })
    expect(readStoredAccountAddress({}, { safe_address: 'd' })).toEqual({ accountAddress: 'd', accountAddressKey: 'safe_address' })
    expect(readStoredAccountAddress({}, {})).toEqual({})
  })

  it('a re-key rewrite of an OLD-shape set writes the NEW name only', async () => {
    const baseDir = await seed({ safe_address: ADDRESS })
    const stored = await readStoredCredentials(undefined, 'agent-1', baseDir)
    await rewriteCredentialFiles({
      baseDir, agentId: 'agent-1', apiKey: 'sk_agent_y', delegateKey: `0x${'22'.repeat(32)}`,
      delegateAddress: '0x1111111111111111111111111111111111111111', accountAddress: stored.accountAddress,
      apiUrl: stored.apiUrl, hostedMcpUrl: stored.hostedMcpUrl,
    })
    const after = await readStoredCredentials(undefined, 'agent-1', baseDir)
    expect(after.accountAddress).toBe(ADDRESS)
    expect(after.accountAddressKey).toBe('account_address')
  })
})
