import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { prepareSignerRuntime } from './signer-runtime.js'
import { MCP_RUNTIME_MANIFEST, sdkPackageSpec, signerPackageSpec } from './runtime-manifest.js'

const execFileAsync = promisify(execFile)

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
    const runCommand = vi.fn(async (_command: string, _args: string[]) => {
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

    // Fast path: install against the default npm cache (warmed by npx) with
    // --prefer-offline so the tarballs are reused, not re-downloaded.
    expect(runCommand).toHaveBeenCalledTimes(1)
    const installArgs = runCommand.mock.calls[0]![1]
    expect(installArgs).toEqual(expect.arrayContaining([
      'install',
      '--prefer-offline',
      signerPackageSpec(),
      sdkPackageSpec(),
    ]))
    // Common path must not pin the isolated Haven cache — that's the fallback only.
    expect(installArgs).not.toContain('--cache')
    // Registered command is the absolute wrapper, not a runtime npx invocation.
    expect(result.command).toBe(join(credentialDirectory, 'bin', 'haven-signer.mjs'))
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

  it('the generated wrapper is directly executable and forwards --credentials + extra args to the CLI', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-signer-runtime-exec-'))
    const credentialDirectory = join(homeDir, '.haven', 'agents', 'agent-1')
    const signerPath = join(credentialDirectory, 'signer.json')
    await mkdir(credentialDirectory, { recursive: true })
    await writeFile(signerPath, JSON.stringify({ delegate_key: PRIVATE_KEY }), 'utf8')

    // Stand in for the signer CLI: echo the argv the wrapper hands it.
    const runCommand = vi.fn(async () => {
      const cliPath = signerNodeModule(homeDir, 'signer', 'dist', 'cli.js')
      await mkdir(join(cliPath, '..'), { recursive: true })
      await writeFile(cliPath, 'console.log(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
      await writePackage(signerNodeModule(homeDir, 'signer', 'package.json'), PINNED_SIGNER_VERSION)
      await writePackage(signerNodeModule(homeDir, 'sdk', 'package.json'), PINNED_SDK_VERSION)
    })

    const result = await prepareSignerRuntime({ credentialDirectory, signerPath, homeDir }, { runCommand })

    // Exec the wrapper directly (relying on its shebang + exec bit), the way an
    // agent runtime spawns an MCP stdio command — not via `node <wrapper>`.
    const { stdout } = await execFileAsync(result.command, ['--extra-flag'], { timeout: 15_000 })
    const forwarded = JSON.parse(stdout.trim()) as string[]
    expect(forwarded).toEqual(['--credentials', signerPath, '--extra-flag'])
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

  it('falls back to the isolated Haven npm cache when the default cache install fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-signer-runtime-fallback-'))
    const credentialDirectory = join(homeDir, '.haven', 'agents', 'agent-1')
    const signerPath = join(credentialDirectory, 'signer.json')
    await mkdir(credentialDirectory, { recursive: true })
    await writeFile(signerPath, JSON.stringify({ delegate_key: PRIVATE_KEY }), 'utf8')

    // First attempt (default cache, no --cache) fails as if ~/.npm were broken or
    // root-owned; the fallback attempt against ~/.haven/npm-cache succeeds and
    // lays down the runtime.
    const runCommand = vi.fn(async (_cmd: string, args: string[]) => {
      if (!args.includes('--cache')) {
        throw new Error('EACCES: permission denied, mkdir \'/root/.npm\'')
      }
      const cliPath = signerNodeModule(homeDir, 'signer', 'dist', 'cli.js')
      await mkdir(join(cliPath, '..'), { recursive: true })
      await writeFile(cliPath, 'console.log("signer")\n', 'utf8')
      await writePackage(signerNodeModule(homeDir, 'signer', 'package.json'), PINNED_SIGNER_VERSION)
      await writePackage(signerNodeModule(homeDir, 'sdk', 'package.json'), PINNED_SDK_VERSION)
    })

    const result = await prepareSignerRuntime({ credentialDirectory, signerPath, homeDir }, { runCommand })

    expect(runCommand).toHaveBeenCalledTimes(2)
    expect(runCommand.mock.calls[1]![1]).toEqual(expect.arrayContaining([
      '--cache',
      join(homeDir, '.haven', 'npm-cache'),
    ]))
    expect(result.command).toBe(join(credentialDirectory, 'bin', 'haven-signer.mjs'))
  })
})
