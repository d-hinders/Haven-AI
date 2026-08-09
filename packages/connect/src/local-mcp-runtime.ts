import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isSupportedNodeVersion, unsupportedNodeVersionMessage } from '@haven_ai/sdk'
import {
  MCP_RUNTIME_MANIFEST,
  mcpPackageSpec,
  sdkPackageSpec,
} from './runtime-manifest.js'

const execFileAsync = promisify(execFile)

export interface PrepareLocalMcpRuntimeInput {
  credentialDirectory: string
  identityPath: string
  signerPath: string
  homeDir?: string
  nodeVersion?: string
}

export interface PreparedLocalMcpRuntime {
  command: string
  args: string[]
  wrapperPath: string
  runtimeDirectory: string
  npmCacheDirectory: string
  cliPath: string
  messages: string[]
}

export interface LocalMcpRuntimeDeps {
  runCommand?: (command: string, args: string[]) => Promise<void>
}

/**
 * Raised when the running Node is below the floor every Haven package declares.
 *
 * The `code` is load-bearing: `runtime-install.ts` maps it to the
 * `local_stdio_mcp_unsupported_node_version` probe result, and Haven's install
 * telemetry has been recording that string since the local path shipped. Kept
 * verbatim even though the guard is no longer local-MCP-only (#1161), because
 * renaming it would silently split one condition across two codes in the
 * historical data.
 */
export class UnsupportedNodeVersionError extends Error {
  readonly code = 'local_mcp_unsupported_node_version'
  readonly nodeVersion: string
  readonly minimumNodeVersion: string

  constructor(nodeVersion: string, minimumNodeVersion: string, subject = 'Haven setup') {
    super(unsupportedNodeVersionMessage({ subject, nodeVersion, minimumNodeVersion }))
    this.name = 'UnsupportedNodeVersionError'
    this.nodeVersion = nodeVersion
    this.minimumNodeVersion = minimumNodeVersion
  }
}

export async function prepareLocalMcpRuntime(
  input: PrepareLocalMcpRuntimeInput,
  deps: LocalMcpRuntimeDeps = {},
): Promise<PreparedLocalMcpRuntime> {
  assertSupportedNodeVersion(input.nodeVersion)

  const homeDir = input.homeDir ?? homedir()
  const runtimeDirectory = resolve(homeDir, '.haven', 'mcp-runtime', MCP_RUNTIME_MANIFEST.mcpVersion)
  const npmCacheDirectory = resolve(homeDir, '.haven', 'npm-cache')
  const cliPath = join(runtimeDirectory, 'node_modules', '@haven_ai', 'mcp', 'dist', 'cli.js')
  const messages: string[] = []

  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  await chmod(runtimeDirectory, 0o700).catch(() => undefined)
  await mkdir(npmCacheDirectory, { recursive: true, mode: 0o700 })
  await chmod(npmCacheDirectory, 0o700).catch(() => undefined)

  if (await installedRuntimeMatches(runtimeDirectory, cliPath)) {
    messages.push(`Using existing local Haven MCP runtime ${mcpPackageSpec()}.`)
  } else {
    await installRuntimePackages(runtimeDirectory, npmCacheDirectory, deps.runCommand)
    messages.push(`Installed local Haven MCP runtime ${mcpPackageSpec()}.`)
  }

  await assertFileExists(cliPath, 'local Haven MCP CLI')

  const wrapperPath = join(input.credentialDirectory, 'bin', 'haven-mcp')
  await writeWrapper({
    wrapperPath,
    cliPath,
    identityPath: input.identityPath,
    signerPath: input.signerPath,
  })

  await writeRuntimeSidecar({
    path: join(input.credentialDirectory, 'mcp-runtime.json'),
    wrapperPath,
    runtimeDirectory,
    npmCacheDirectory,
    cliPath,
  })

  messages.push(`Prepared stable local Haven MCP wrapper: ${wrapperPath}`)

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

/**
 * Refuse to proceed on an unsupported Node.
 *
 * Called from BOTH connect paths since #1161: `runConnect` runs it before any
 * side effect on the default (hosted MCP + local signer) topology, and
 * `prepareLocalMcpRuntime` keeps its own call for the `--local` path. It used to
 * exist only on the latter — the path almost nobody takes — so the documented
 * floor was enforced where it mattered least.
 */
export function assertSupportedNodeVersion(
  nodeVersion = process.versions.node,
  minimumNodeVersion = MCP_RUNTIME_MANIFEST.minimumNodeVersion,
  subject = 'Haven setup',
): void {
  if (!isSupportedNodeVersion(nodeVersion, minimumNodeVersion)) {
    throw new UnsupportedNodeVersionError(nodeVersion, minimumNodeVersion, subject)
  }
}

async function installRuntimePackages(
  runtimeDirectory: string,
  npmCacheDirectory: string,
  runCommand: ((command: string, args: string[]) => Promise<void>) | undefined,
): Promise<void> {
  // Mirrors prepareSignerRuntime's installRuntimePackages: fast path reuses the
  // default npm cache (warmed by npx) with --prefer-offline so the mcp + sdk
  // tarballs are not re-downloaded; fall back to the isolated Haven-owned cache
  // if the default cache is broken or root-owned (see docs/operations/
  // mcp-runtime-compatibility.md).
  const baseArgs = [
    'install',
    '--prefix',
    runtimeDirectory,
    '--no-audit',
    '--no-fund',
    '--omit=dev',
    '--prefer-offline',
    mcpPackageSpec(),
    sdkPackageSpec(),
  ]
  const run = async (args: string[]): Promise<void> => {
    if (runCommand) await runCommand('npm', args)
    else await execFileAsync('npm', args, { timeout: 120_000, maxBuffer: 1024 * 1024 })
  }

  try {
    await run(baseArgs)
  } catch {
    try {
      await run([...baseArgs, '--cache', npmCacheDirectory])
    } catch (err) {
      throw new Error(`Could not install local Haven MCP runtime ${mcpPackageSpec()}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

async function installedRuntimeMatches(runtimeDirectory: string, cliPath: string): Promise<boolean> {
  try {
    await assertFileExists(cliPath, 'local Haven MCP CLI')
    const [mcpPackage, sdkPackage] = await Promise.all([
      readPackageJson(join(runtimeDirectory, 'node_modules', '@haven_ai', 'mcp', 'package.json')),
      readPackageJson(join(runtimeDirectory, 'node_modules', '@haven_ai', 'sdk', 'package.json')),
    ])
    return mcpPackage.version === MCP_RUNTIME_MANIFEST.mcpVersion &&
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
  identityPath: string
  signerPath: string
}): Promise<void> {
  await mkdir(dirname(input.wrapperPath), { recursive: true, mode: 0o700 })
  await chmod(dirname(input.wrapperPath), 0o700).catch(() => undefined)
  const source = [
    '#!/usr/bin/env node',
    "import { spawn } from 'node:child_process'",
    '',
    `const cliPath = ${JSON.stringify(input.cliPath)}`,
    `const identityPath = ${JSON.stringify(input.identityPath)}`,
    `const signerPath = ${JSON.stringify(input.signerPath)}`,
    '',
    "const child = spawn(process.execPath, [cliPath, '--identity', identityPath, '--signer', signerPath, ...process.argv.slice(2)], {",
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
    mcp_package: MCP_RUNTIME_MANIFEST.mcpPackage,
    mcp_version: MCP_RUNTIME_MANIFEST.mcpVersion,
    sdk_package: MCP_RUNTIME_MANIFEST.sdkPackage,
    sdk_version: MCP_RUNTIME_MANIFEST.sdkVersion,
    minimum_node_version: MCP_RUNTIME_MANIFEST.minimumNodeVersion,
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
