import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertSupportedNodeVersion, prepareLocalMcpRuntime } from './local-mcp-runtime.js'
import { MCP_RUNTIME_MANIFEST, mcpPackageSpec, sdkPackageSpec } from './runtime-manifest.js'

// Use the manifest's pinned MCP version everywhere we mock the install layout,
// so a version bump in runtime-manifest.ts (or in @haven_ai/mcp's MCP_VERSION
// constant that it imports) does NOT silently break this test. Hardcoding the
// literal here previously meant the test passed against a stale version on
// disk and only broke at publish time on the next bump — exactly the failure
// mode that surfaced when bumping for the agent-feedback slice release.
const PINNED_MCP_VERSION = MCP_RUNTIME_MANIFEST.mcpVersion
const PINNED_SDK_VERSION = MCP_RUNTIME_MANIFEST.sdkVersion

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
    const runCommand = vi.fn(async (_command: string, _args: string[]) => {
      const cliPath = join(homeDir, '.haven', 'mcp-runtime', PINNED_MCP_VERSION, 'node_modules', '@haven_ai', 'mcp', 'dist', 'cli.js')
      await mkdir(join(cliPath, '..'), { recursive: true })
      await writeFile(cliPath, 'console.log("mcp")\n', 'utf8')
      await writePackage(join(homeDir, '.haven', 'mcp-runtime', PINNED_MCP_VERSION, 'node_modules', '@haven_ai', 'mcp', 'package.json'), PINNED_MCP_VERSION)
      await writePackage(join(homeDir, '.haven', 'mcp-runtime', PINNED_MCP_VERSION, 'node_modules', '@haven_ai', 'sdk', 'package.json'), PINNED_SDK_VERSION)
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

    // Fast path: default npm cache (warmed by npx) with --prefer-offline, no
    // isolated --cache pin — that's reserved for the broken-cache fallback.
    expect(runCommand).toHaveBeenCalledTimes(1)
    const installArgs = runCommand.mock.calls[0]![1]
    expect(installArgs).toEqual(expect.arrayContaining([
      'install',
      '--prefer-offline',
      mcpPackageSpec(),
      sdkPackageSpec(),
    ]))
    expect(installArgs).not.toContain('--cache')
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
    const staleCliPath = join(homeDir, '.haven', 'mcp-runtime', PINNED_MCP_VERSION, 'node_modules', '@haven_ai', 'mcp', 'dist', 'cli.js')
    await mkdir(join(staleCliPath, '..'), { recursive: true })
    await writeFile(staleCliPath, 'console.log("stale")\n', 'utf8')
    await writePackage(join(homeDir, '.haven', 'mcp-runtime', PINNED_MCP_VERSION, 'node_modules', '@haven_ai', 'mcp', 'package.json'), PINNED_MCP_VERSION)
    await writePackage(join(homeDir, '.haven', 'mcp-runtime', PINNED_MCP_VERSION, 'node_modules', '@haven_ai', 'sdk', 'package.json'), '0.0.0')
    await mkdir(credentialDirectory, { recursive: true })
    await writeFile(identityPath, JSON.stringify({ api_key: API_KEY }), 'utf8')
    await writeFile(signerPath, JSON.stringify({ delegate_key: PRIVATE_KEY }), 'utf8')

    const runCommand = vi.fn(async () => {
      await writePackage(join(homeDir, '.haven', 'mcp-runtime', PINNED_MCP_VERSION, 'node_modules', '@haven_ai', 'sdk', 'package.json'), PINNED_SDK_VERSION)
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

  it('falls back to the isolated Haven npm cache when the default cache install fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-local-mcp-fallback-'))
    const credentialDirectory = join(homeDir, '.haven', 'agents', 'agent-1')
    const identityPath = join(credentialDirectory, 'identity.json')
    const signerPath = join(credentialDirectory, 'signer.json')
    await mkdir(credentialDirectory, { recursive: true })
    await writeFile(identityPath, JSON.stringify({ api_key: API_KEY }), 'utf8')
    await writeFile(signerPath, JSON.stringify({ delegate_key: PRIVATE_KEY }), 'utf8')

    const runtimeRoot = join(homeDir, '.haven', 'mcp-runtime', PINNED_MCP_VERSION, 'node_modules', '@haven_ai')
    // First attempt (default cache, no --cache) fails as if ~/.npm were broken or
    // root-owned; the fallback against ~/.haven/npm-cache succeeds.
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (!args.includes('--cache')) {
        throw new Error('EACCES: permission denied, mkdir \'/root/.npm\'')
      }
      const cliPath = join(runtimeRoot, 'mcp', 'dist', 'cli.js')
      await mkdir(join(cliPath, '..'), { recursive: true })
      await writeFile(cliPath, 'console.log("mcp")\n', 'utf8')
      await writePackage(join(runtimeRoot, 'mcp', 'package.json'), PINNED_MCP_VERSION)
      await writePackage(join(runtimeRoot, 'sdk', 'package.json'), PINNED_SDK_VERSION)
    })

    const result = await prepareLocalMcpRuntime({
      credentialDirectory,
      identityPath,
      signerPath,
      homeDir,
    }, { runCommand })

    expect(runCommand).toHaveBeenCalledTimes(2)
    expect(runCommand.mock.calls[1]![1]).toEqual(expect.arrayContaining([
      '--cache',
      join(homeDir, '.haven', 'npm-cache'),
    ]))
    expect(result.command).toBe(join(credentialDirectory, 'bin', 'haven-mcp'))
  })
})

async function writePackage(path: string, version: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify({ version })}\n`, 'utf8')
}
