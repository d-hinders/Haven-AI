import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
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

export class UnsupportedNodeVersionError extends Error {
  readonly code = 'local_mcp_unsupported_node_version'

  constructor(nodeVersion: string, minimumNodeVersion: string) {
    super(`Node.js ${nodeVersion} is not supported. Haven local MCP requires Node.js >=${minimumNodeVersion}.`)
    this.name = 'UnsupportedNodeVersionError'
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

export function assertSupportedNodeVersion(
  nodeVersion = process.versions.node,
  minimumNodeVersion = MCP_RUNTIME_MANIFEST.minimumNodeVersion,
): void {
  if (compareNodeVersions(nodeVersion, minimumNodeVersion) < 0) {
    throw new UnsupportedNodeVersionError(nodeVersion, minimumNodeVersion)
  }
}

function compareNodeVersions(left: string, right: string): number {
  const leftParts = parseNodeVersion(left)
  const rightParts = parseNodeVersion(right)
  for (let i = 0; i < 3; i += 1) {
    if (leftParts[i] !== rightParts[i]) return leftParts[i] > rightParts[i] ? 1 : -1
  }
  return 0
}

function parseNodeVersion(value: string): [number, number, number] {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!match) return [0, 0, 0]
  return [
    Number(match[1] ?? 0),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0),
  ]
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
    mcpPackageSpec(),
    sdkPackageSpec(),
  ]
  try {
    if (runCommand) await runCommand('npm', args)
    else await execFileAsync('npm', args, { timeout: 120_000, maxBuffer: 1024 * 1024 })
  } catch (err) {
    throw new Error(`Could not install local Haven MCP runtime ${mcpPackageSpec()}: ${err instanceof Error ? err.message : String(err)}`)
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
