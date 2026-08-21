import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertServerSlugAvailable, defaultAgentDirectory, preflightCredentialStorage, writeCredentialFiles } from './storage.js'

describe('writeCredentialFiles', () => {
  it('writes separated owner-only identity and signer credential files', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-connect-'))
    const paths = await writeCredentialFiles({
      baseDir,
      agentId: 'agent-1',
      apiKey: 'sk_agent_testsecret',
      delegateKey: `0x${'11'.repeat(32)}`,
      delegateAddress: '0x1111111111111111111111111111111111111111',
      safeAddress: '0x2222222222222222222222222222222222222222',
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
    expect(agentJson.safe_address).toBe('0x2222222222222222222222222222222222222222')
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
