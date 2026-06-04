import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertSupportedNodeVersion, prepareLocalMcpRuntime } from './local-mcp-runtime.js'
import { mcpPackageSpec, sdkPackageSpec } from './runtime-manifest.js'

const API_KEY = 'sk_agent_secret_for_local_runtime_test'
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'

describe('prepareLocalMcpRuntime', () => {
  it('requires the manifest minimum Node version before installing', () => {
    expect(() => assertSupportedNodeVersion('20.0.0')).not.toThrow()
    expect(() => assertSupportedNodeVersion('18.19.0')).toThrow(/requires Node\.js >=20\.0\.0/)
  })

  it('installs through a Haven-owned npm cache and writes a stable non-secret wrapper', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-local-mcp-home-'))
    const credentialDirectory = join(homeDir, '.haven', 'agents', 'agent-1')
    const identityPath = join(credentialDirectory, 'identity.json')
    const signerPath = join(credentialDirectory, 'signer.json')
    const runCommand = vi.fn(async () => {
      const cliPath = join(homeDir, '.haven', 'mcp-runtime', '0.1.3-alpha', 'node_modules', '@haven_ai', 'mcp', 'dist', 'cli.js')
      await mkdir(join(cliPath, '..'), { recursive: true })
      await writeFile(cliPath, 'console.log("mcp")\n', 'utf8')
      await writePackage(join(homeDir, '.haven', 'mcp-runtime', '0.1.3-alpha', 'node_modules', '@haven_ai', 'mcp', 'package.json'), '0.1.3-alpha')
      await writePackage(join(homeDir, '.haven', 'mcp-runtime', '0.1.3-alpha', 'node_modules', '@haven_ai', 'sdk', 'package.json'), '0.1.6')
    })

    await mkdir(credentialDirectory, { recursive: true })
    await writeFile(identityPath, JSON.stringify({ api_key: API_KEY }), 'utf8')
    await writeFile(signerPath, JSON.stringify({ delegate_key: PRIVATE_KEY }), 'utf8')
    await chmod(identityPath, 0o600)
    await chmod(signerPath, 0o600)

    const result = await prepareLocalMcpRuntime({
      credentialDirectory,
      identityPath,
      signerPath,
      homeDir,
    }, { runCommand })

    expect(runCommand).toHaveBeenCalledWith('npm', expect.arrayContaining([
      'install',
      '--cache',
      join(homeDir, '.haven', 'npm-cache'),
      mcpPackageSpec(),
      sdkPackageSpec(),
    ]))
    expect(result.command).toBe(join(credentialDirectory, 'bin', 'haven-mcp'))
    expect(result.args).toEqual([])

    const wrapper = await readFile(result.wrapperPath, 'utf8')
    const sidecar = await readFile(join(credentialDirectory, 'mcp-runtime.json'), 'utf8')
    expect(wrapper).toContain(result.cliPath)
    expect(wrapper).toContain(identityPath)
    expect(wrapper).toContain(signerPath)
    expect(wrapper).not.toContain(API_KEY)
    expect(wrapper).not.toContain(PRIVATE_KEY)
    expect(sidecar).not.toContain(API_KEY)
    expect(sidecar).not.toContain(PRIVATE_KEY)
  })

  it('reinstalls when the cached local runtime does not match the pinned manifest', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-local-mcp-stale-home-'))
    const credentialDirectory = join(homeDir, '.haven', 'agents', 'agent-1')
    const identityPath = join(credentialDirectory, 'identity.json')
    const signerPath = join(credentialDirectory, 'signer.json')
    const staleCliPath = join(homeDir, '.haven', 'mcp-runtime', '0.1.3-alpha', 'node_modules', '@haven_ai', 'mcp', 'dist', 'cli.js')
    await mkdir(join(staleCliPath, '..'), { recursive: true })
    await writeFile(staleCliPath, 'console.log("stale")\n', 'utf8')
    await writePackage(join(homeDir, '.haven', 'mcp-runtime', '0.1.3-alpha', 'node_modules', '@haven_ai', 'mcp', 'package.json'), '0.1.3-alpha')
    await writePackage(join(homeDir, '.haven', 'mcp-runtime', '0.1.3-alpha', 'node_modules', '@haven_ai', 'sdk', 'package.json'), '0.0.0')
    await mkdir(credentialDirectory, { recursive: true })
    await writeFile(identityPath, JSON.stringify({ api_key: API_KEY }), 'utf8')
    await writeFile(signerPath, JSON.stringify({ delegate_key: PRIVATE_KEY }), 'utf8')

    const runCommand = vi.fn(async () => {
      await writePackage(join(homeDir, '.haven', 'mcp-runtime', '0.1.3-alpha', 'node_modules', '@haven_ai', 'sdk', 'package.json'), '0.1.6')
    })

    const result = await prepareLocalMcpRuntime({
      credentialDirectory,
      identityPath,
      signerPath,
      homeDir,
    }, { runCommand })

    expect(runCommand).toHaveBeenCalled()
    expect(result.messages.join('\n')).toContain('Installed local Haven MCP runtime')
  })
})

async function writePackage(path: string, version: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify({ version })}\n`, 'utf8')
}
