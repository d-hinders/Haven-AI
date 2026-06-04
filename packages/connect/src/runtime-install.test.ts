import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_VERSION } from '@haven_ai/mcp'
import { describe, expect, it, vi } from 'vitest'
import { installRuntime } from './runtime-install.js'

const API_KEY = 'sk_agent_secret_for_runtime_test'
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'
const HOSTED_URL = 'https://mcp.haven.example/v1'
const MCP_PACKAGE = `@haven_ai/mcp@${MCP_VERSION}`

describe('installRuntime', () => {
  it('prepares Codex local MCP config and acknowledgement for normal restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-install-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
    })

    const codexConfig = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    const ack = await readFile(`${identityPath}.ack.json`, 'utf8')

    expect(result.runtimeMcpMode).toBe('local_stdio')
    expect(result.hostedMcpConfigured).toBe(false)
    expect(result.localSignerConfigured).toBe(true)
    expect(result.localMcpConfigured).toBe(true)
    expect(result.localMcpAcknowledged).toBe(true)
    expect(result.restartRequired).toBe(true)
    expect(result.nextUserAction).toBe('return_to_haven_for_wallet_approval_then_restart_codex')
    expect(result.activationCommand).toBeUndefined()
    expect(result.errorCode).toBeUndefined()
    expect(codexConfig).toContain(MCP_PACKAGE)
    expect(codexConfig).toContain('--identity')
    expect(codexConfig).toContain(identityPath)
    expect(codexConfig).toContain('--signer')
    expect(codexConfig).not.toContain('"--ack"')
    expect(codexConfig).not.toContain('bearer_token_env_var')
    expect(codexConfig).not.toContain('haven_signer')
    expect(codexConfig).not.toContain(API_KEY)
    expect(codexConfig).not.toContain(PRIVATE_KEY)
    expect(ack).toContain('"ack"')
    expect(result.messages.join('\n')).not.toContain(API_KEY)
    expect(result.messages.join('\n')).not.toContain(PRIVATE_KEY)
  })

  it('does not report local MCP as configured when acknowledgement is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-no-ack-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
    })

    expect(result.hostedMcpConfigured).toBe(false)
    expect(result.localSignerConfigured).toBe(false)
    expect(result.localMcpConfigured).toBe(false)
    expect(result.localMcpAcknowledged).toBe(false)
    expect(result.errorCode).toBe('local_mcp_ack_required')
  })

  it('configures Claude Code with local MCP and no Authorization header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-claude-install-'))
    const credentialDirectory = join(dir, 'agent-1')
    const identityPath = await writeIdentityCredential(credentialDirectory)
    const signerPath = await writeSignerCredential(credentialDirectory)
    const commands: Array<{ command: string; args: string[] }> = []
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      commands.push({ command, args })
    })

    const result = await installRuntime({
      runtime: 'claude-code',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath,
      credentialDirectory,
      ackLocalTools: true,
    }, {
      runCommand,
      fetch: okToolsFetch(),
    })

    expect(result.hostedMcpConfigured).toBe(false)
    expect(result.localSignerConfigured).toBe(true)
    expect(result.localMcpConfigured).toBe(true)
    expect(result.localMcpAcknowledged).toBe(true)
    expect(result.nextUserAction).toBe('return_to_haven_for_wallet_approval_then_restart_claude_code')
    expect(commands[0]).toMatchObject({
      command: 'claude',
      args: ['mcp', 'add', 'haven', '--', 'npx', '-y', MCP_PACKAGE, '--identity', identityPath, '--signer', signerPath],
    })
    expect(commands[1]).toMatchObject({
      command: 'claude',
      args: ['mcp', 'remove', 'haven-signer'],
    })
    expect(JSON.stringify(commands)).not.toContain('Authorization')
    expect(JSON.stringify(commands)).not.toContain(API_KEY)
  })
})

async function writeIdentityCredential(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const identityPath = join(directory, 'identity.json')
  await writeFile(
    identityPath,
    JSON.stringify({
      api_key: API_KEY,
      agent_id: 'agent-1',
      safe_address: '0x2222222222222222222222222222222222222222',
      chain_id: 100,
      network: 'Gnosis',
      api_url: 'https://api.haven.example',
      agent_budget: [{ token_symbol: 'USDC', allowance_amount: '25000000', reset_period_min: 1440 }],
    }, null, 2),
    'utf8',
  )
  await chmod(identityPath, 0o600)
  return identityPath
}

async function writeSignerCredential(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const signerPath = join(directory, 'signer.json')
  await writeFile(
    signerPath,
    JSON.stringify({
      delegate_key: PRIVATE_KEY,
      delegate_address: '0x0E8F9364fE8a316d00aD5AFD6D09993c764B45d1',
      agent_id: 'agent-1',
      safe_address: '0x2222222222222222222222222222222222222222',
      chain_id: 100,
      network: 'Gnosis',
    }, null, 2),
    'utf8',
  )
  await chmod(signerPath, 0o600)
  return signerPath
}

function okToolsFetch(): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'haven_get_agent' }] },
    }), { status: 200 }),
  ) as unknown as typeof fetch
}
