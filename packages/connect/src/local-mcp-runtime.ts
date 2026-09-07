import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isSupportedNodeVersion, unsupportedNodeVersionMessage } from '@haven_ai/sdk'
import { SIGNER_INSTALL_HEARTBEAT_MS, SIGNER_INSTALL_TIMEOUT_MS } from './signer-runtime.js'
import {
  MCP_RUNTIME_MANIFEST,
  mcpPackageSpec,
  sdkPackageSpec,
} from './runtime-manifest.js'
import {
  describeRuntimeSpecOverride,
  overrideApplies,
  resolveRuntimeSpecOverride,
  runtimeSpecOverrideDirectoryKey,
  runtimeSpecOverrideNotice,
  type RuntimeSpecOverride,
  type RuntimeSpecOverrideRecord,
} from './runtime-spec-override.js'

const execFileAsync = promisify(execFile)

export interface PrepareLocalMcpRuntimeInput {
  credentialDirectory: string
  identityPath: string
  signerPath: string
  homeDir?: string
  nodeVersion?: string
  /** #1696: wiring slug, recorded in the sidecar for per-agent inventory (#1697). */
  serverName?: string
}

export interface PreparedLocalMcpRuntime {
  command: string
  args: string[]
  wrapperPath: string
  runtimeDirectory: string
  npmCacheDirectory: string
  cliPath: string
  messages: string[]
  /** #2424: present only when the install ran under a runtime-spec override. */
  runtimeSpecOverride?: RuntimeSpecOverrideRecord
}

export interface LocalMcpRuntimeDeps {
  runCommand?: (command: string, args: string[]) => Promise<void>
  /** Install progress heartbeat, mirrored from the signer runtime (#1586/#1593). */
  onProgress?: (message: string) => void
  /** #2424: where `HAVEN_MCP_SPEC` / `HAVEN_SDK_SPEC` are read from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
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
  // #2424: mirrors prepareSignerRuntime — resolved before any side effect, a
  // hash-keyed directory under an override, never reused, printed loudly.
  const override = resolveLocalMcpRuntimeOverride(deps.env ?? process.env)
  const mcpSpec = override?.mcp ?? mcpPackageSpec()
  const sdkSpec = override?.sdk ?? sdkPackageSpec()
  const resolvedSpecs = [mcpSpec, sdkSpec]
  const overrideRecord: RuntimeSpecOverrideRecord | undefined = override
    ? { specs: override, resolved_specs: resolvedSpecs, directory_key: runtimeSpecOverrideDirectoryKey(resolvedSpecs) }
    : undefined
  const runtimeDirectory = resolve(
    homeDir,
    '.haven',
    'mcp-runtime',
    overrideRecord ? overrideRecord.directory_key : MCP_RUNTIME_MANIFEST.mcpVersion,
  )
  const npmCacheDirectory = resolve(homeDir, '.haven', 'npm-cache')
  const cliPath = join(runtimeDirectory, 'node_modules', '@haven_ai', 'mcp', 'dist', 'cli.js')
  const messages: string[] = []

  if (override) {
    messages.push(...runtimeSpecOverrideNotice(
      'MCP runtime',
      override,
      { mcp: mcpPackageSpec(), sdk: sdkPackageSpec() },
      runtimeDirectory,
    ))
  }

  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  await chmod(runtimeDirectory, 0o700).catch(() => undefined)
  await mkdir(npmCacheDirectory, { recursive: true, mode: 0o700 })
  await chmod(npmCacheDirectory, 0o700).catch(() => undefined)

  if (override) {
    await installRuntimePackages(runtimeDirectory, npmCacheDirectory, resolvedSpecs, deps)
    messages.push(`Installed local Haven MCP runtime from override (${resolvedSpecs.join(' ')}).`)
  } else if (await installedRuntimeMatches(runtimeDirectory, cliPath)) {
    messages.push(`Using existing local Haven MCP runtime ${mcpPackageSpec()}.`)
  } else {
    await installRuntimePackages(runtimeDirectory, npmCacheDirectory, resolvedSpecs, deps)
    messages.push(`Installed local Haven MCP runtime ${mcpPackageSpec()}.`)
  }

  await assertFileExists(cliPath, 'local Haven MCP CLI')
  const installedVersions = override ? await readInstalledVersions(runtimeDirectory) : undefined

  const wrapperPath = join(input.credentialDirectory, 'bin', 'haven-mcp')
  await writeWrapper({
    wrapperPath,
    cliPath,
    identityPath: input.identityPath,
    signerPath: input.signerPath,
    overrideComment: override ? describeRuntimeSpecOverride(override) : undefined,
  })

  await writeRuntimeSidecar({
    path: join(input.credentialDirectory, 'mcp-runtime.json'),
    wrapperPath,
    runtimeDirectory,
    npmCacheDirectory,
    cliPath,
    serverName: input.serverName,
    override: overrideRecord,
    installedVersions,
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
    ...(overrideRecord ? { runtimeSpecOverride: overrideRecord } : {}),
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

/** The `--local` runtime's slice of the override: `mcp` and `sdk`; a lone `HAVEN_SIGNER_SPEC` is not its business. */
function resolveLocalMcpRuntimeOverride(env: NodeJS.ProcessEnv): RuntimeSpecOverride | undefined {
  const override = resolveRuntimeSpecOverride(env)
  if (!overrideApplies(override, ['mcp', 'sdk'])) return undefined
  const { mcp, sdk } = override
  return { ...(mcp !== undefined ? { mcp } : {}), ...(sdk !== undefined ? { sdk } : {}) }
}

async function installRuntimePackages(
  runtimeDirectory: string,
  npmCacheDirectory: string,
  packageSpecs: readonly string[],
  deps: LocalMcpRuntimeDeps,
): Promise<void> {
  const { runCommand, onProgress } = deps
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
    ...packageSpecs,
  ]
  const run = async (args: string[]): Promise<void> => {
    // Heartbeat while npm works, and the same honest budget as the signer
    // install: a cold-cache install can legitimately exceed the old 120s
    // timeout, and a silent console reads as a hang (#1586/#1593).
    const startedAt = Date.now()
    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      onProgress?.(`Still installing the local Haven MCP runtime… (${seconds}s — a cold cache can take several minutes)`)
    }, SIGNER_INSTALL_HEARTBEAT_MS)
    heartbeat.unref?.()
    try {
      if (runCommand) await runCommand('npm', args)
      else await execFileAsync('npm', args, { timeout: SIGNER_INSTALL_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
    } finally {
      clearInterval(heartbeat)
    }
  }

  try {
    await run(baseArgs)
  } catch {
    try {
      await run([...baseArgs, '--cache', npmCacheDirectory])
    } catch (err) {
      throw new Error(`Could not install local Haven MCP runtime ${packageSpecs.join(' ')}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

async function installedRuntimeMatches(runtimeDirectory: string, cliPath: string): Promise<boolean> {
  try {
    await assertFileExists(cliPath, 'local Haven MCP CLI')
    const installed = await readInstalledVersions(runtimeDirectory)
    return installed.mcpVersion === MCP_RUNTIME_MANIFEST.mcpVersion &&
      installed.sdkVersion === MCP_RUNTIME_MANIFEST.sdkVersion
  } catch {
    return false
  }
}

async function readInstalledVersions(runtimeDirectory: string): Promise<{ mcpVersion: string; sdkVersion: string }> {
  const [mcpPackage, sdkPackage] = await Promise.all([
    readPackageJson(join(runtimeDirectory, 'node_modules', '@haven_ai', 'mcp', 'package.json')),
    readPackageJson(join(runtimeDirectory, 'node_modules', '@haven_ai', 'sdk', 'package.json')),
  ])
  return { mcpVersion: mcpPackage.version ?? '', sdkVersion: sdkPackage.version ?? '' }
}

async function readPackageJson(path: string): Promise<{ version?: string }> {
  return JSON.parse(await readFile(path, 'utf8')) as { version?: string }
}

async function writeWrapper(input: {
  wrapperPath: string
  cliPath: string
  identityPath: string
  signerPath: string
  /** #2424: present only under an override. */
  overrideComment?: string
}): Promise<void> {
  await mkdir(dirname(input.wrapperPath), { recursive: true, mode: 0o700 })
  await chmod(dirname(input.wrapperPath), 0o700).catch(() => undefined)
  const source = [
    '#!/usr/bin/env node',
    ...(input.overrideComment
      ? [`// HAVEN RUNTIME SPEC OVERRIDE (#2424): ${input.overrideComment} — this wrapper launches a NON-pinned MCP build.`]
      : []),
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
  serverName?: string
  override?: RuntimeSpecOverrideRecord
  installedVersions?: { mcpVersion: string; sdkVersion: string }
}): Promise<void> {
  const value = {
    ...(input.serverName ? { server_name: input.serverName } : {}),
    mcp_package: MCP_RUNTIME_MANIFEST.mcpPackage,
    mcp_version: input.installedVersions?.mcpVersion ?? MCP_RUNTIME_MANIFEST.mcpVersion,
    sdk_package: MCP_RUNTIME_MANIFEST.sdkPackage,
    sdk_version: input.installedVersions?.sdkVersion ?? MCP_RUNTIME_MANIFEST.sdkVersion,
    minimum_node_version: MCP_RUNTIME_MANIFEST.minimumNodeVersion,
    wrapper_path: input.wrapperPath,
    runtime_directory: input.runtimeDirectory,
    npm_cache_directory: input.npmCacheDirectory,
    cli_path: input.cliPath,
    ...(input.override ? { runtime_spec_override: input.override } : {}),
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
