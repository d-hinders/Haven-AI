import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { acknowledgeLocalMcpConsent } from './local-mcp-consent.js'
import { prepareLocalMcpRuntime } from './local-mcp-runtime.js'
import { probeLocalMcpTools } from './probes.js'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'

const execFileAsync = promisify(execFile)
const runSmoke = process.env.HAVEN_CONNECT_PACKAGE_SMOKE === '1'
const describeSmoke = runSmoke ? describe : describe.skip

describeSmoke('published package smoke', () => {
  it('handshakes through a stable wrapper backed by packed MCP and SDK artifacts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'haven-connect-package-smoke-'))
    const packDir = join(tempDir, 'packs')
    const packCacheDir = join(tempDir, 'pack-npm-cache')
    const homeDir = join(tempDir, 'home')
    const credentialDirectory = join(homeDir, '.haven', 'agents', 'agent-1')
    const identityPath = join(credentialDirectory, 'identity.json')
    const signerPath = join(credentialDirectory, 'signer.json')
    await mkdir(packDir, { recursive: true })
    await mkdir(packCacheDir, { recursive: true, mode: 0o700 })
    await mkdir(join(homeDir, '.npm'), { recursive: true, mode: 0o700 })
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 })

    const sdkTarball = await npmPack(packageDir('sdk'), packDir, packCacheDir)
    const mcpTarball = await npmPack(packageDir('mcp'), packDir, packCacheDir)
    await installPackedRuntimeFromTarballs(homeDir, sdkTarball, mcpTarball)

    await writeJson(identityPath, {
      api_key: 'sk_agent_package_smoke',
      agent_id: 'agent-1',
      safe_address: '0x2222222222222222222222222222222222222222',
      chain_id: 8453,
      network: 'Base',
      api_url: 'https://api.haven.example',
      agent_budget: [{
        token_symbol: 'USDC',
        allowance_amount: '25000000',
        reset_period_min: 1440,
      }],
    })
    await writeJson(signerPath, {
      delegate_key: '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38',
      delegate_address: '0x0E8F9364fE8a316d00aD5AFD6D09993c764B45d1',
      agent_id: 'agent-1',
      safe_address: '0x2222222222222222222222222222222222222222',
      chain_id: 8453,
      network: 'Base',
    })

    const acknowledgement = await acknowledgeLocalMcpConsent(identityPath, signerPath, () => undefined)
    expect(acknowledgement.acknowledged).toBe(true)

    const runtime = await prepareLocalMcpRuntime({
      credentialDirectory,
      identityPath,
      signerPath,
      homeDir,
    }, {
      runCommand: async () => {
        throw new Error('prepareLocalMcpRuntime should reuse the packed runtime installed by this smoke test')
      },
    })

    expect(runtime.command).toBe(join(credentialDirectory, 'bin', 'haven-mcp'))
    expect(runtime.args).toEqual([])
    expect(runtime.npmCacheDirectory).toBe(join(homeDir, '.haven', 'npm-cache'))
    const wrapper = await readFile(runtime.wrapperPath, 'utf8')
    expect(wrapper).toContain(runtime.cliPath)
    expect(wrapper).not.toContain('sk_agent_package_smoke')
    expect(wrapper).not.toContain('0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38')

    const probe = await probeLocalMcpTools(
      runtime.command,
      runtime.args,
      MCP_RUNTIME_MANIFEST.requiredTools,
      20_000,
    )
    expect(probe.status).toBe('ok')
  }, 120_000)
})

function packageDir(name: 'sdk' | 'mcp'): string {
  return fileURLToPath(new URL(`../../${name}/`, import.meta.url))
}

async function npmPack(packageDirectory: string, packDirectory: string, cacheDirectory: string): Promise<string> {
  const { stdout } = await execFileAsync('npm', [
    'pack',
    '--pack-destination',
    packDirectory,
    '--cache',
    cacheDirectory,
  ], {
    cwd: packageDirectory,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  })
  return join(packDirectory, stdout.trim().split(/\r?\n/).at(-1) ?? '')
}

async function installPackedRuntimeFromTarballs(homeDir: string, sdkTarball: string, mcpTarball: string): Promise<void> {
  const runtimeDirectory = join(homeDir, '.haven', 'mcp-runtime', MCP_RUNTIME_MANIFEST.mcpVersion)
  const runtimeNodeModules = join(runtimeDirectory, 'node_modules')
  await extractPackageTarball(sdkTarball, join(runtimeNodeModules, '@haven_ai', 'sdk'))
  await extractPackageTarball(mcpTarball, join(runtimeNodeModules, '@haven_ai', 'mcp'))
  for (const dependency of ['@modelcontextprotocol', 'ethers', 'viem', 'x402', 'zod']) {
    await linkWorkspaceDependency(runtimeNodeModules, dependency)
  }
}

async function extractPackageTarball(tarball: string, destination: string): Promise<void> {
  const extractDir = `${destination}.extract`
  await rm(extractDir, { recursive: true, force: true })
  await mkdir(extractDir, { recursive: true })
  await mkdir(dirname(destination), { recursive: true })
  await execFileAsync('tar', ['-xzf', tarball, '-C', extractDir], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
  await rm(destination, { recursive: true, force: true })
  await rename(join(extractDir, 'package'), destination)
  await rm(extractDir, { recursive: true, force: true })
}

async function linkWorkspaceDependency(runtimeNodeModules: string, dependency: string): Promise<void> {
  const source = workspaceNodeModule(dependency)
  const destination = join(runtimeNodeModules, ...dependency.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  await rm(destination, { recursive: true, force: true })
  await symlink(source, destination, 'dir')
}

function workspaceNodeModule(dependency: string): string {
  return fileURLToPath(new URL(`../../../node_modules/${dependency}/`, import.meta.url))
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => undefined)
}
