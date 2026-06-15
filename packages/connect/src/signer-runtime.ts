import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { MCP_RUNTIME_MANIFEST, sdkPackageSpec, signerPackageSpec } from './runtime-manifest.js'

const execFileAsync = promisify(execFile)

export interface PrepareSignerRuntimeInput {
  credentialDirectory: string
  signerPath: string
  homeDir?: string
}

export interface PreparedSignerRuntime {
  /** Absolute command to register as the signer MCP `command`. */
  command: string
  /** Args to register alongside `command` (credentials are baked into the wrapper). */
  args: string[]
  wrapperPath: string
  runtimeDirectory: string
  npmCacheDirectory: string
  cliPath: string
  messages: string[]
}

export interface SignerRuntimeDeps {
  runCommand?: (command: string, args: string[]) => Promise<void>
}

/**
 * Pre-install the edge signer into a version-pinned, connector-managed
 * directory and write a stable wrapper that launches it with an absolute Node
 * path. The signer MCP is then registered as `command: <wrapper>` instead of a
 * runtime `npx -y @haven_ai/signer@…` invocation.
 *
 * Why: launching the signer via bare `npx` at every MCP spawn made it depend on
 * the PATH/environment the agent runtime hands the stdio subprocess, which is
 * not the user's interactive shell — the failure mode that left `haven-signer`
 * stuck at "Failed to connect" while the hosted HTTP server connected fine. The
 * local MCP topology already avoids this with the same pre-install + wrapper
 * pattern (see prepareLocalMcpRuntime); this brings the default hosted+signer
 * topology to parity. Version stays pinned (no unpinned `npm i -g`), and the
 * wrapper lives under ~/.haven so the reset flow already cleans it up.
 */
export async function prepareSignerRuntime(
  input: PrepareSignerRuntimeInput,
  deps: SignerRuntimeDeps = {},
): Promise<PreparedSignerRuntime> {
  const homeDir = input.homeDir ?? homedir()
  const runtimeDirectory = resolve(homeDir, '.haven', 'signer-runtime', MCP_RUNTIME_MANIFEST.signerVersion)
  const npmCacheDirectory = resolve(homeDir, '.haven', 'npm-cache')
  const cliPath = join(runtimeDirectory, 'node_modules', '@haven_ai', 'signer', 'dist', 'cli.js')
  const messages: string[] = []

  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  await chmod(runtimeDirectory, 0o700).catch(() => undefined)
  await mkdir(npmCacheDirectory, { recursive: true, mode: 0o700 })
  await chmod(npmCacheDirectory, 0o700).catch(() => undefined)

  if (await installedRuntimeMatches(runtimeDirectory, cliPath)) {
    messages.push(`Using existing local Haven signer runtime ${signerPackageSpec()}.`)
  } else {
    await installRuntimePackages(runtimeDirectory, npmCacheDirectory, deps.runCommand)
    messages.push(`Installed local Haven signer runtime ${signerPackageSpec()}.`)
  }

  await assertFileExists(cliPath, 'local Haven signer CLI')

  // .mjs so the wrapper is unambiguously ESM when the runtime exec's it via the
  // shebang — Node < 20.10 has no automatic module detection, and there is no
  // package.json with "type":"module" under ~/.haven to disambiguate otherwise.
  const wrapperPath = join(input.credentialDirectory, 'bin', 'haven-signer.mjs')
  await writeWrapper({ wrapperPath, cliPath, signerPath: input.signerPath })

  await writeRuntimeSidecar({
    path: join(input.credentialDirectory, 'signer-runtime.json'),
    wrapperPath,
    runtimeDirectory,
    npmCacheDirectory,
    cliPath,
  })

  messages.push(`Prepared stable local Haven signer wrapper: ${wrapperPath}`)

  return {
    command: wrapperPath,
    args: [],
    wrapperPath,
    runtimeDirectory,
    npmCacheDirectory,
    cliPath,
    messages,
  }
}

async function installRuntimePackages(
  runtimeDirectory: string,
  npmCacheDirectory: string,
  runCommand: ((command: string, args: string[]) => Promise<void>) | undefined,
): Promise<void> {
  const args = [
    'install',
    '--prefix',
    runtimeDirectory,
    '--cache',
    npmCacheDirectory,
    '--no-audit',
    '--no-fund',
    '--omit=dev',
    signerPackageSpec(),
    sdkPackageSpec(),
  ]
  try {
    if (runCommand) await runCommand('npm', args)
    else await execFileAsync('npm', args, { timeout: 120_000, maxBuffer: 1024 * 1024 })
  } catch (err) {
    throw new Error(
      `Could not install local Haven signer runtime ${signerPackageSpec()}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

async function installedRuntimeMatches(runtimeDirectory: string, cliPath: string): Promise<boolean> {
  try {
    await assertFileExists(cliPath, 'local Haven signer CLI')
    const [signerPackage, sdkPackage] = await Promise.all([
      readPackageJson(join(runtimeDirectory, 'node_modules', '@haven_ai', 'signer', 'package.json')),
      readPackageJson(join(runtimeDirectory, 'node_modules', '@haven_ai', 'sdk', 'package.json')),
    ])
    return signerPackage.version === MCP_RUNTIME_MANIFEST.signerVersion &&
      sdkPackage.version === MCP_RUNTIME_MANIFEST.sdkVersion
  } catch {
    return false
  }
}

async function readPackageJson(path: string): Promise<{ version?: string }> {
  return JSON.parse(await readFile(path, 'utf8')) as { version?: string }
}

async function writeWrapper(input: {
  wrapperPath: string
  cliPath: string
  signerPath: string
}): Promise<void> {
  await mkdir(dirname(input.wrapperPath), { recursive: true, mode: 0o700 })
  await chmod(dirname(input.wrapperPath), 0o700).catch(() => undefined)
  const source = [
    '#!/usr/bin/env node',
    "import { spawn } from 'node:child_process'",
    '',
    `const cliPath = ${JSON.stringify(input.cliPath)}`,
    `const signerPath = ${JSON.stringify(input.signerPath)}`,
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
  ].join('\n')
  await writeFile(input.wrapperPath, source, { mode: 0o700 })
  await chmod(input.wrapperPath, 0o700).catch(() => undefined)
}

async function writeRuntimeSidecar(input: {
  path: string
  wrapperPath: string
  runtimeDirectory: string
  npmCacheDirectory: string
  cliPath: string
}): Promise<void> {
  const value = {
    signer_package: MCP_RUNTIME_MANIFEST.signerPackage,
    signer_version: MCP_RUNTIME_MANIFEST.signerVersion,
    sdk_package: MCP_RUNTIME_MANIFEST.sdkPackage,
    sdk_version: MCP_RUNTIME_MANIFEST.sdkVersion,
    wrapper_path: input.wrapperPath,
    runtime_directory: input.runtimeDirectory,
    npm_cache_directory: input.npmCacheDirectory,
    cli_path: input.cliPath,
  }
  await writeFile(input.path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(input.path, 0o600).catch(() => undefined)
}

async function assertFileExists(path: string, label: string): Promise<void> {
  try {
    await access(path)
  } catch {
    throw new Error(`Missing ${label}: ${path}`)
  }
}
