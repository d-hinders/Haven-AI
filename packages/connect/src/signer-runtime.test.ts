import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareSignerRuntime } from './signer-runtime.js'
import { MCP_RUNTIME_MANIFEST, sdkPackageSpec, signerPackageSpec } from './runtime-manifest.js'

// Pull the pinned versions from the manifest so a release bump can't silently
// desync this test from the layout prepareSignerRuntime installs.
const PINNED_SIGNER_VERSION = MCP_RUNTIME_MANIFEST.signerVersion
const PINNED_SDK_VERSION = MCP_RUNTIME_MANIFEST.sdkVersion
const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'

function signerNodeModule(homeDir: string, ...segments: string[]): string {
  return join(homeDir, '.haven', 'signer-runtime', PINNED_SIGNER_VERSION, 'node_modules', '@haven_ai', ...segments)
}

async function writePackage(path: string, version: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ version }), 'utf8')
}

describe('prepareSignerRuntime', () => {
  it('installs through a Haven-owned npm cache and writes a stable wrapper that bakes in the credentials', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-signer-runtime-home-'))
    const credentialDirectory = join(homeDir, '.haven', 'agents', 'agent-1')
    const signerPath = join(credentialDirectory, 'signer.json')
    const runCommand = vi.fn(async () => {
      const cliPath = signerNodeModule(homeDir, 'signer', 'dist', 'cli.js')
      await mkdir(join(cliPath, '..'), { recursive: true })
      await writeFile(cliPath, 'console.log("signer")\n', 'utf8')
      await writePackage(signerNodeModule(homeDir, 'signer', 'package.json'), PINNED_SIGNER_VERSION)
      await writePackage(signerNodeModule(homeDir, 'sdk', 'package.json'), PINNED_SDK_VERSION)
    })

    await mkdir(credentialDirectory, { recursive: true })
    await writeFile(signerPath, JSON.stringify({ delegate_key: PRIVATE_KEY }), 'utf8')
    await chmod(signerPath, 0o600)

    const result = await prepareSignerRuntime({ credentialDirectory, signerPath, homeDir }, { runCommand })

    expect(runCommand).toHaveBeenCalledWith('npm', expect.arrayContaining([
      'install',
      '--cache',
      join(homeDir, '.haven', 'npm-cache'),
      signerPackageSpec(),
      sdkPackageSpec(),
    ]))
    // Registered command is the absolute wrapper, not a runtime npx invocation.
    expect(result.command).toBe(join(credentialDirectory, 'bin', 'haven-signer'))
    expect(result.args).toEqual([])

    const wrapper = await readFile(result.wrapperPath, 'utf8')
    expect(wrapper).toContain(result.cliPath)
    expect(wrapper).toContain(signerPath)
    expect(wrapper).toContain('--credentials')
    expect(wrapper).not.toContain('npx')
    // The wrapper holds only paths — never the delegate key.
    expect(wrapper).not.toContain(PRIVATE_KEY)

    const sidecar = await readFile(join(credentialDirectory, 'signer-runtime.json'), 'utf8')
    expect(sidecar).toContain(PINNED_SIGNER_VERSION)
    expect(sidecar).not.toContain(PRIVATE_KEY)
  })

  it('reuses the cached runtime when the pinned versions already match', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-signer-runtime-cache-'))
    const credentialDirectory = join(homeDir, '.haven', 'agents', 'agent-1')
    const signerPath = join(credentialDirectory, 'signer.json')
    await mkdir(credentialDirectory, { recursive: true })
    await writeFile(signerPath, JSON.stringify({ delegate_key: PRIVATE_KEY }), 'utf8')

    const cliPath = signerNodeModule(homeDir, 'signer', 'dist', 'cli.js')
    await mkdir(join(cliPath, '..'), { recursive: true })
    await writeFile(cliPath, 'console.log("signer")\n', 'utf8')
    await writePackage(signerNodeModule(homeDir, 'signer', 'package.json'), PINNED_SIGNER_VERSION)
    await writePackage(signerNodeModule(homeDir, 'sdk', 'package.json'), PINNED_SDK_VERSION)

    const runCommand = vi.fn(async () => undefined)
    const result = await prepareSignerRuntime({ credentialDirectory, signerPath, homeDir }, { runCommand })

    expect(runCommand).not.toHaveBeenCalled()
    expect(result.messages.join('\n')).toContain('Using existing local Haven signer runtime')
  })
})
