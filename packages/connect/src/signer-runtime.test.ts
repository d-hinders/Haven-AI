import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { prepareSignerRuntime } from './signer-runtime.js'
import { MCP_RUNTIME_MANIFEST, sdkPackageSpec, signerPackageSpec } from './runtime-manifest.js'
import { runtimeSpecOverrideDirectoryKey } from './runtime-spec-override.js'

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

describe('sidecar slug recording (#1696)', () => {
  it('records server_name for a NAMED pair and omits it for the bare pair — byte-compat', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-signer-runtime-slug-'))
    const credentialDirectory = join(homeDir, '.haven', 'agents', 'work')
    await mkdir(credentialDirectory, { recursive: true })
    const signerPath = join(credentialDirectory, 'signer.json')
    await writeFile(signerPath, '{}')
    const runCommand = vi.fn(async () => {
      const cliPath = signerNodeModule(homeDir, 'signer', 'dist', 'cli.js')
      await mkdir(join(cliPath, '..'), { recursive: true })
      await writeFile(cliPath, 'console.log("signer")\n', 'utf8')
      await writePackage(signerNodeModule(homeDir, 'signer', 'package.json'), PINNED_SIGNER_VERSION)
      await writePackage(signerNodeModule(homeDir, 'sdk', 'package.json'), PINNED_SDK_VERSION)
    })

    await prepareSignerRuntime({ credentialDirectory, signerPath, homeDir, serverName: 'work' }, { runCommand })
    const named = JSON.parse(await readFile(join(credentialDirectory, 'signer-runtime.json'), 'utf8'))
    expect(named.server_name).toBe('work')

    const bareDir = join(homeDir, '.haven', 'agents', 'agt-bare')
    await mkdir(bareDir, { recursive: true })
    const bareSigner = join(bareDir, 'signer.json')
    await writeFile(bareSigner, '{}')
    await prepareSignerRuntime({ credentialDirectory: bareDir, signerPath: bareSigner, homeDir }, { runCommand })
    const bare = JSON.parse(await readFile(join(bareDir, 'signer-runtime.json'), 'utf8'))
    expect('server_name' in bare).toBe(false)
  })
})

// ── #2424: local runtime-spec override ─────────────────────────────────────

/** Materialise a signer+sdk layout at whatever `--prefix` npm was handed. */
function layoutAtPrefix(signerVersion: string, sdkVersion: string) {
  return vi.fn(async (_command: string, args: string[]) => {
    const prefix = args[args.indexOf('--prefix') + 1]!
    const cliPath = join(prefix, 'node_modules', '@haven_ai', 'signer', 'dist', 'cli.js')
    await mkdir(join(cliPath, '..'), { recursive: true })
    await writeFile(cliPath, 'console.log("signer")\n', 'utf8')
    await writePackage(join(prefix, 'node_modules', '@haven_ai', 'signer', 'package.json'), signerVersion)
    await writePackage(join(prefix, 'node_modules', '@haven_ai', 'sdk', 'package.json'), sdkVersion)
  })
}

async function freshHome(prefix: string) {
  const homeDir = await mkdtemp(join(tmpdir(), prefix))
  const credentialDirectory = join(homeDir, '.haven', 'agents', 'agent-1')
  const signerPath = join(credentialDirectory, 'signer.json')
  await mkdir(credentialDirectory, { recursive: true })
  await writeFile(signerPath, JSON.stringify({ delegate_key: PRIVATE_KEY }), 'utf8')
  return { homeDir, credentialDirectory, signerPath }
}

describe('runtime-spec override — characterization: no override changes NOTHING (#2424)', () => {
  // The cell the epic asks for by name: a production install with no
  // HAVEN_*_SPEC set is byte-for-byte what it was before the override
  // existed. Every assertion here is EXACT (toEqual / toBe on whole values),
  // never arrayContaining, so any default that sneaks into the resolved
  // specs, the directory, the sidecar or the wrapper turns this red.
  it('install args, runtime directory, sidecar and wrapper are exactly the pre-#2424 shapes', async () => {
    const { homeDir, credentialDirectory, signerPath } = await freshHome('haven-signer-runtime-noop-')
    const runCommand = layoutAtPrefix(PINNED_SIGNER_VERSION, PINNED_SDK_VERSION)

    // `env: {}` — explicitly nothing set. (A second run below proves the
    // default, process.env, is read the same way.)
    const result = await prepareSignerRuntime({ credentialDirectory, signerPath, homeDir }, { runCommand, env: {} })

    const runtimeDirectory = join(homeDir, '.haven', 'signer-runtime', PINNED_SIGNER_VERSION)
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(runCommand.mock.calls[0]![1]).toEqual([
      'install',
      '--prefix',
      runtimeDirectory,
      '--no-audit',
      '--no-fund',
      '--omit=dev',
      '--prefer-offline',
      `@haven_ai/signer@${PINNED_SIGNER_VERSION}`,
      `@haven_ai/sdk@${PINNED_SDK_VERSION}`,
    ])
    expect(result.runtimeDirectory).toBe(runtimeDirectory)
    expect(result.cliPath).toBe(join(runtimeDirectory, 'node_modules', '@haven_ai', 'signer', 'dist', 'cli.js'))

    const sidecar = JSON.parse(await readFile(join(credentialDirectory, 'signer-runtime.json'), 'utf8'))
    expect(sidecar).toEqual({
      signer_package: '@haven_ai/signer',
      signer_version: PINNED_SIGNER_VERSION,
      sdk_package: '@haven_ai/sdk',
      sdk_version: PINNED_SDK_VERSION,
      wrapper_path: join(credentialDirectory, 'bin', 'haven-signer.mjs'),
      runtime_directory: runtimeDirectory,
      npm_cache_directory: join(homeDir, '.haven', 'npm-cache'),
      cli_path: result.cliPath,
    })

    const wrapper = await readFile(result.wrapperPath, 'utf8')
    expect(wrapper).toBe([
      '#!/usr/bin/env node',
      "import { spawn } from 'node:child_process'",
      '',
      `const cliPath = ${JSON.stringify(result.cliPath)}`,
      `const signerPath = ${JSON.stringify(signerPath)}`,
      '',
      "const child = spawn(process.execPath, [cliPath, '--credentials', signerPath, ...process.argv.slice(2)], {",
      "  stdio: 'inherit',",
      '})',
      '',
      "child.on('exit', (code, signal) => {",
      '  if (signal) process.kill(process.pid, signal)',
      '  else process.exit(code ?? 1)',
      '})',
      '',
    ].join('\n'))

    expect(result.messages).toEqual([
      `Installed local Haven signer runtime @haven_ai/signer@${PINNED_SIGNER_VERSION}.`,
      `Prepared stable local Haven signer wrapper: ${result.wrapperPath}`,
    ])
  })

  it('an unrelated variable in the environment is not an override either', async () => {
    const { homeDir, credentialDirectory, signerPath } = await freshHome('haven-signer-runtime-noop-env-')
    const runCommand = layoutAtPrefix(PINNED_SIGNER_VERSION, PINNED_SDK_VERSION)
    const result = await prepareSignerRuntime(
      { credentialDirectory, signerPath, homeDir },
      { runCommand, env: { HAVEN_CONNECTOR_CHANNEL: 'dev', HAVEN_MCP_SPEC: 'file:/only-the-local-mcp-runtime-cares' } },
    )
    expect(result.runtimeDirectory).toBe(join(homeDir, '.haven', 'signer-runtime', PINNED_SIGNER_VERSION))
    expect(runCommand.mock.calls[0]![1].slice(-2)).toEqual([signerPackageSpec(), sdkPackageSpec()])
    expect(result.messages.join('\n')).not.toContain('OVERRIDE')
    const sidecar = JSON.parse(await readFile(join(credentialDirectory, 'signer-runtime.json'), 'utf8'))
    expect('runtime_spec_override' in sidecar).toBe(false)
  })
})

describe('runtime-spec override — active (#2424)', () => {
  it('HAVEN_SIGNER_SPEC=file:… installs that spec into a hash-keyed directory, loudly, and records it', async () => {
    const { homeDir, credentialDirectory, signerPath } = await freshHome('haven-signer-runtime-override-')
    const runCommand = layoutAtPrefix('0.0.0-local', PINNED_SDK_VERSION)
    const env = { HAVEN_SIGNER_SPEC: 'file:/abs/path/packages/signer' }

    const result = await prepareSignerRuntime({ credentialDirectory, signerPath, homeDir }, { runCommand, env })

    const expectedKey = runtimeSpecOverrideDirectoryKey(['file:/abs/path/packages/signer', sdkPackageSpec()])
    const runtimeDirectory = join(homeDir, '.haven', 'signer-runtime', expectedKey)
    expect(result.runtimeDirectory).toBe(runtimeDirectory)
    // The pinned directory is not what got written.
    expect(result.runtimeDirectory).not.toContain(PINNED_SIGNER_VERSION)

    const installArgs = runCommand.mock.calls[0]![1]
    expect(installArgs).toEqual([
      'install', '--prefix', runtimeDirectory, '--no-audit', '--no-fund', '--omit=dev', '--prefer-offline',
      'file:/abs/path/packages/signer',
      sdkPackageSpec(),
    ])
    expect(installArgs).not.toContain(signerPackageSpec())

    // Setup output: loud, first, names the variable and the pin it replaced.
    expect(result.messages[0]).toContain('RUNTIME SPEC OVERRIDE ACTIVE')
    expect(result.messages.join('\n')).toContain(`HAVEN_SIGNER_SPEC=file:/abs/path/packages/signer (instead of ${signerPackageSpec()})`)
    expect(result.messages.join('\n')).toContain(runtimeDirectory)
    expect(result.messages.join('\n')).toContain('Installed local Haven signer runtime from override')

    // Sidecar: records the override AND what npm actually laid down.
    const sidecar = JSON.parse(await readFile(join(credentialDirectory, 'signer-runtime.json'), 'utf8'))
    expect(sidecar.runtime_spec_override).toEqual({
      specs: { signer: 'file:/abs/path/packages/signer' },
      resolved_specs: ['file:/abs/path/packages/signer', sdkPackageSpec()],
      directory_key: expectedKey,
    })
    expect(sidecar.signer_version).toBe('0.0.0-local')
    expect(sidecar.sdk_version).toBe(PINNED_SDK_VERSION)
    expect(sidecar.runtime_directory).toBe(runtimeDirectory)

    // Wrapper: says so in a comment, still launches the override CLI, still no secret.
    const wrapper = await readFile(result.wrapperPath, 'utf8')
    expect(wrapper).toContain('// HAVEN RUNTIME SPEC OVERRIDE (#2424): HAVEN_SIGNER_SPEC=file:/abs/path/packages/signer')
    expect(wrapper).toContain(result.cliPath)
    expect(wrapper).not.toContain(PRIVATE_KEY)
  })

  it('an override install is never reused from an earlier run, and the pinned directory is never touched', async () => {
    const { homeDir, credentialDirectory, signerPath } = await freshHome('haven-signer-runtime-override-reuse-')
    const env = { HAVEN_SIGNER_SPEC: 'file:/abs/signer' }
    const runCommand = layoutAtPrefix('0.0.0-local', PINNED_SDK_VERSION)
    await prepareSignerRuntime({ credentialDirectory, signerPath, homeDir }, { runCommand, env })
    await prepareSignerRuntime({ credentialDirectory, signerPath, homeDir }, { runCommand, env })
    // Two runs, two installs — a rebuilt file: package must not be shadowed.
    expect(runCommand).toHaveBeenCalledTimes(2)
    // Nothing under the pinned directory name.
    await expect(readFile(join(homeDir, '.haven', 'signer-runtime', PINNED_SIGNER_VERSION, 'node_modules', '@haven_ai', 'signer', 'package.json'), 'utf8'))
      .rejects.toThrow()
  })

  it('HAVEN_SDK_SPEC alone also overrides the signer runtime (it installs the SDK too)', async () => {
    const { homeDir, credentialDirectory, signerPath } = await freshHome('haven-signer-runtime-override-sdk-')
    const runCommand = layoutAtPrefix(PINNED_SIGNER_VERSION, '0.0.0-local')
    const result = await prepareSignerRuntime(
      { credentialDirectory, signerPath, homeDir },
      { runCommand, env: { HAVEN_SDK_SPEC: '/abs/haven_ai-sdk-0.0.0.tgz' } },
    )
    expect(runCommand.mock.calls[0]![1].slice(-2)).toEqual([signerPackageSpec(), '/abs/haven_ai-sdk-0.0.0.tgz'])
    expect(result.runtimeDirectory).toBe(join(
      homeDir, '.haven', 'signer-runtime',
      runtimeSpecOverrideDirectoryKey([signerPackageSpec(), '/abs/haven_ai-sdk-0.0.0.tgz']),
    ))
  })

  it.each([
    ['empty', ''],
    ['whitespace', '  '],
    ['shell metacharacter', 'file:/abs;rm'],
  ])('a %s HAVEN_SIGNER_SPEC is refused BEFORE npm runs, naming the variable, with nothing written', async (_label, value) => {
    const { homeDir, credentialDirectory, signerPath } = await freshHome('haven-signer-runtime-override-bad-')
    const runCommand = vi.fn(async () => undefined)
    await expect(prepareSignerRuntime(
      { credentialDirectory, signerPath, homeDir },
      { runCommand, env: { HAVEN_SIGNER_SPEC: value } },
    )).rejects.toThrow(/HAVEN_SIGNER_SPEC/)
    expect(runCommand).not.toHaveBeenCalled()
    await expect(readFile(join(credentialDirectory, 'signer-runtime.json'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(credentialDirectory, 'bin', 'haven-signer.mjs'), 'utf8')).rejects.toThrow()
  })
})
