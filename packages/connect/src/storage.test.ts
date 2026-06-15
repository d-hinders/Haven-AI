import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { preflightCredentialStorage, writeCredentialFiles } from './storage.js'

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

    if (process.platform !== 'win32') {
      expect((await stat(paths.identityPath)).mode & 0o777).toBe(0o600)
      expect((await stat(paths.signerPath)).mode & 0o777).toBe(0o600)
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

  it('preflights credential storage before setup registration', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'haven-connect-preflight-'))
    const directory = await preflightCredentialStorage({ baseDir })

    expect(directory).toBe(baseDir)
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
    }
  })
})
