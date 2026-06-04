import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIGNER_VERSION } from '@haven_ai/signer'
import { describe, expect, it, vi } from 'vitest'
import { installRuntime } from './runtime-install.js'

const API_KEY = 'sk_agent_secret_for_runtime_test'
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'
const HOSTED_URL = 'https://mcp.haven.example/v1'
const SIGNER_PACKAGE = `@haven_ai/signer@${SIGNER_VERSION}`

describe('installRuntime', () => {
  it('prepares Codex config, signer acknowledgement, and a private launcher command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-install-'))
    const credentialDirectory = join(dir, 'agent-1')
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath: join(credentialDirectory, 'identity.json'),
      credentialDirectory,
      ackSigner: true,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
    })

    const codexConfig = await readFile(join(dir, '.codex', 'config.toml'), 'utf8')
    const envFile = await readFile(join(credentialDirectory, 'identity.env'), 'utf8')
    const launcher = await readFile(join(credentialDirectory, 'start-codex.sh'), 'utf8')
    const ack = await readFile(`${signerPath}.signer-ack.json`, 'utf8')

    expect(result.hostedMcpConfigured).toBe(true)
    expect(result.localSignerConfigured).toBe(true)
    expect(result.signerAcknowledged).toBe(true)
    expect(result.restartRequired).toBe(true)
    expect(result.nextUserAction).toBe('return_to_haven_for_wallet_approval_then_restart_codex_with_haven_env')
    expect(result.activationCommand).toContain('start-codex.sh')
    expect(result.errorCode).toBeUndefined()
    expect(codexConfig).toContain('bearer_token_env_var = "HAVEN_TOKEN"')
    expect(codexConfig).toContain(SIGNER_PACKAGE)
    expect(codexConfig).not.toContain('"--ack"')
    expect(codexConfig).not.toContain(API_KEY)
    expect(codexConfig).not.toContain(PRIVATE_KEY)
    expect(envFile).toContain(`export HAVEN_TOKEN='${API_KEY}'`)
    expect(launcher).toContain('identity.env')
    expect(launcher).toContain('exec codex "$@"')
    expect(launcher).not.toContain(API_KEY)
    expect(ack).toContain('"ack"')
    expect(result.messages.join('\n')).not.toContain(API_KEY)
    expect(result.messages.join('\n')).not.toContain(PRIVATE_KEY)
  })

  it('does not report the local signer as configured when acknowledgement is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-codex-no-ack-'))
    const credentialDirectory = join(dir, 'agent-1')
    const signerPath = await writeSignerCredential(credentialDirectory)

    const result = await installRuntime({
      runtime: 'codex-cli',
      hostedMcpUrl: HOSTED_URL,
      apiKey: API_KEY,
      signerPath,
      identityPath: join(credentialDirectory, 'identity.json'),
      credentialDirectory,
    }, {
      homeDir: dir,
      fetch: okToolsFetch(),
    })

    expect(result.hostedMcpConfigured).toBe(true)
    expect(result.localSignerConfigured).toBe(false)
    expect(result.signerAcknowledged).toBe(false)
    expect(result.errorCode).toBe('local_signer_ack_required')
  })

  it('configures Claude Code with a separated local signer command and signer acknowledgement', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-connect-claude-install-'))
    const credentialDirectory = join(dir, 'agent-1')
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
      identityPath: join(credentialDirectory, 'identity.json'),
      credentialDirectory,
      ackSigner: true,
    }, {
      runCommand,
      fetch: okToolsFetch(),
    })

    expect(result.hostedMcpConfigured).toBe(true)
    expect(result.localSignerConfigured).toBe(true)
    expect(result.signerAcknowledged).toBe(true)
    expect(result.nextUserAction).toBe('return_to_haven_for_wallet_approval_then_restart_claude_code')
    expect(commands[0]).toMatchObject({
      command: 'claude',
      args: ['mcp', 'add', '--transport', 'http', 'haven', HOSTED_URL, '--header', `Authorization: Bearer ${API_KEY}`],
    })
    expect(commands[1]).toMatchObject({
      command: 'claude',
      args: ['mcp', 'add', 'haven-signer', '--', 'npx', '-y', SIGNER_PACKAGE, '--credentials', signerPath],
    })
  })
})

async function writeSignerCredential(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  const signerPath = join(directory, 'signer.json')
  await writeFile(
    signerPath,
    JSON.stringify({
      delegate_key: PRIVATE_KEY,
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
