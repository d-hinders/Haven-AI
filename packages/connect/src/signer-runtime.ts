import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { MCP_RUNTIME_MANIFEST, sdkPackageSpec, signerPackageSpec } from './runtime-manifest.js'
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

export interface PrepareSignerRuntimeInput {
  credentialDirectory: string
  signerPath: string
  homeDir?: string
  /** #1696: wiring slug, recorded in the sidecar for per-agent inventory (#1697). */
  serverName?: string
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
  /** #2424: present only when the install ran under a runtime-spec override. */
  runtimeSpecOverride?: RuntimeSpecOverrideRecord
}

export interface SignerRuntimeDeps {
  runCommand?: (command: string, args: string[]) => Promise<void>
  /** Heartbeats during the (possibly minutes-long) npm install (#1586). */
  onProgress?: (message: string) => void
  /**
   * #2424: where `HAVEN_SIGNER_SPEC` / `HAVEN_SDK_SPEC` are read from.
   * Defaults to `process.env`; injected so tests can prove both that an
   * override is honoured and that its absence changes nothing.
   */
  env?: NodeJS.ProcessEnv
}

/**
 * Honest budget for a COLD-cache install over a slow link (#1586). The old
 * 120s budget was exactly what broke the 2026-08-18 Codex Desktop setup: a
 * 6+ minute cold install was killed at 2 minutes, the failure fell back to
 * npx silently, and the resulting config structurally could not start.
 */
export const SIGNER_INSTALL_TIMEOUT_MS = 600_000

/** How often the console hears from a long install instead of going silent. */
export const SIGNER_INSTALL_HEARTBEAT_MS = 15_000

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
  // #2424: resolved BEFORE any directory is created or npm is invoked, so a
  // malformed variable is refused with nothing on disk to clean up.
  const override = resolveSignerRuntimeOverride(deps.env ?? process.env)
  const signerSpec = override?.signer ?? signerPackageSpec()
  const sdkSpec = override?.sdk ?? sdkPackageSpec()
  const resolvedSpecs = [signerSpec, sdkSpec]
  const overrideRecord: RuntimeSpecOverrideRecord | undefined = override
    ? { specs: override, resolved_specs: resolvedSpecs, directory_key: runtimeSpecOverrideDirectoryKey(resolvedSpecs) }
    : undefined
  const runtimeDirectory = resolve(
    homeDir,
    '.haven',
    'signer-runtime',
    overrideRecord ? overrideRecord.directory_key : MCP_RUNTIME_MANIFEST.signerVersion,
  )
  const npmCacheDirectory = resolve(homeDir, '.haven', 'npm-cache')
  const cliPath = join(runtimeDirectory, 'node_modules', '@haven_ai', 'signer', 'dist', 'cli.js')
  const messages: string[] = []

  if (override) {
    messages.push(...runtimeSpecOverrideNotice(
      'signer runtime',
      override,
      { signer: signerPackageSpec(), sdk: sdkPackageSpec() },
      runtimeDirectory,
    ))
  }

  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  await chmod(runtimeDirectory, 0o700).catch(() => undefined)
  await mkdir(npmCacheDirectory, { recursive: true, mode: 0o700 })
  await chmod(npmCacheDirectory, 0o700).catch(() => undefined)

  if (override) {
    // Never reused: a rebuilt `file:` package must not be shadowed by a
    // version check that cannot tell two local builds apart.
    await installRuntimePackages(runtimeDirectory, npmCacheDirectory, resolvedSpecs, deps)
    messages.push(`Installed local Haven signer runtime from override (${resolvedSpecs.join(' ')}).`)
  } else if (await installedRuntimeMatches(runtimeDirectory, cliPath)) {
    messages.push(`Using existing local Haven signer runtime ${signerPackageSpec()}.`)
  } else {
    await installRuntimePackages(runtimeDirectory, npmCacheDirectory, resolvedSpecs, deps)
    messages.push(`Installed local Haven signer runtime ${signerPackageSpec()}.`)
  }

  await assertFileExists(cliPath, 'local Haven signer CLI')
  // Under an override the manifest is not the truth about what is installed;
  // the sidecar records what npm actually laid down so `--doctor` can compare
  // the directory against the run that wrote it.
  const installedVersions = override ? await readInstalledVersions(runtimeDirectory) : undefined

  // .mjs so the wrapper is unambiguously ESM when the runtime exec's it via the
  // shebang — Node < 20.10 has no automatic module detection, and there is no
  // package.json with "type":"module" under ~/.haven to disambiguate otherwise.
  const wrapperPath = join(input.credentialDirectory, 'bin', 'haven-signer.mjs')
  await writeWrapper({
    wrapperPath,
    cliPath,
    signerPath: input.signerPath,
    overrideComment: override ? describeRuntimeSpecOverride(override) : undefined,
  })

  await writeRuntimeSidecar({
    path: join(input.credentialDirectory, 'signer-runtime.json'),
    wrapperPath,
    runtimeDirectory,
    npmCacheDirectory,
    cliPath,
    serverName: input.serverName,
    override: overrideRecord,
    installedVersions,
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
    ...(overrideRecord ? { runtimeSpecOverride: overrideRecord } : {}),
  }
}

/**
 * The signer runtime's slice of the override: `signer` and `sdk`. A lone
 * `HAVEN_MCP_SPEC` belongs to the `--local` MCP runtime and must not turn this
 * install into an override one.
 */
function resolveSignerRuntimeOverride(env: NodeJS.ProcessEnv): RuntimeSpecOverride | undefined {
  const override = resolveRuntimeSpecOverride(env)
  if (!overrideApplies(override, ['signer', 'sdk'])) return undefined
  const { signer, sdk } = override
  return { ...(signer !== undefined ? { signer } : {}), ...(sdk !== undefined ? { sdk } : {}) }
}

async function installRuntimePackages(
  runtimeDirectory: string,
  npmCacheDirectory: string,
  packageSpecs: readonly string[],
  deps: SignerRuntimeDeps,
): Promise<void> {
  const { runCommand, onProgress } = deps
  // Fast path: install against the user's default npm cache with
  // `--prefer-offline`. `npx @haven_ai/connect` just downloaded the signer + sdk
  // tarballs (plus their closure) into that cache moments earlier, so this
  // resolves from disk instead of re-fetching over the network — the single
  // biggest avoidable cost in cold setup.
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
    // Heartbeat while npm works: a cold install can legitimately take
    // minutes, and a silent console reads as a hang (#1586).
    const startedAt = Date.now()
    const heartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      onProgress?.(`Still installing the local Haven signer runtime… (${seconds}s — a cold cache can take several minutes)`)
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
    // Fallback: the default `~/.npm` can be corrupted or root-owned (a real,
    // documented failure mode — see docs/operations/mcp-runtime-compatibility.md).
    // Retry against the isolated Haven-owned cache so a broken global cache can't
    // break agent setup. This path may hit the network; that is the acceptable
    // cost of recovering from an unusable default cache.
    try {
      await run([...baseArgs, '--cache', npmCacheDirectory])
    } catch (err) {
      throw new Error(
        `Could not install local Haven signer runtime ${packageSpecs.join(' ')}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

export async function installedRuntimeMatches(runtimeDirectory: string, cliPath: string): Promise<boolean> {
  return installedRuntimeMatchesVersions(runtimeDirectory, cliPath, {
    signerVersion: MCP_RUNTIME_MANIFEST.signerVersion,
    sdkVersion: MCP_RUNTIME_MANIFEST.sdkVersion,
  })
}

/**
 * #2424: the same check against an explicit pair of versions. `--doctor`
 * uses it for an override install, where the reference is the sidecar's
 * record of what npm laid down rather than the manifest pin.
 */
export async function installedRuntimeMatchesVersions(
  runtimeDirectory: string,
  cliPath: string,
  expected: { signerVersion: string; sdkVersion: string },
): Promise<boolean> {
  try {
    await assertFileExists(cliPath, 'local Haven signer CLI')
    const installed = await readInstalledVersions(runtimeDirectory)
    return installed.signerVersion === expected.signerVersion && installed.sdkVersion === expected.sdkVersion
  } catch {
    return false
  }
}

async function readInstalledVersions(runtimeDirectory: string): Promise<{ signerVersion: string; sdkVersion: string }> {
  const [signerPackage, sdkPackage] = await Promise.all([
    readPackageJson(join(runtimeDirectory, 'node_modules', '@haven_ai', 'signer', 'package.json')),
    readPackageJson(join(runtimeDirectory, 'node_modules', '@haven_ai', 'sdk', 'package.json')),
  ])
  return { signerVersion: signerPackage.version ?? '', sdkVersion: sdkPackage.version ?? '' }
}

async function readPackageJson(path: string): Promise<{ version?: string }> {
  return JSON.parse(await readFile(path, 'utf8')) as { version?: string }
}

async function writeWrapper(input: {
  wrapperPath: string
  cliPath: string
  signerPath: string
  /** #2424: present only under an override; the wrapper says so to whoever opens it. */
  overrideComment?: string
}): Promise<void> {
  await mkdir(dirname(input.wrapperPath), { recursive: true, mode: 0o700 })
  await chmod(dirname(input.wrapperPath), 0o700).catch(() => undefined)
  const source = [
    '#!/usr/bin/env node',
    ...(input.overrideComment
      ? [`// HAVEN RUNTIME SPEC OVERRIDE (#2424): ${input.overrideComment} — this wrapper launches a NON-pinned signer build.`]
      : []),
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

/** The sidecar `prepareSignerRuntime` writes next to the credentials (#1589). */
export interface SignerRuntimeSidecar {
  /** #1696: present when this credential dir belongs to a NAMED pair. */
  server_name?: string
  signer_package: string
  signer_version: string
  sdk_package: string
  sdk_version: string
  wrapper_path: string
  runtime_directory: string
  npm_cache_directory: string
  cli_path: string
  /**
   * #2424: present ONLY when the install ran under `HAVEN_SIGNER_SPEC` /
   * `HAVEN_SDK_SPEC`. Then `signer_version` / `sdk_version` above are what
   * npm actually installed (read back from the package.json files), not the
   * manifest pins, and `--doctor` reports the override as a finding.
   */
  runtime_spec_override?: RuntimeSpecOverrideRecord
}

export async function readRuntimeSidecar(credentialDirectory: string): Promise<SignerRuntimeSidecar | null> {
  try {
    return JSON.parse(
      await readFile(join(credentialDirectory, 'signer-runtime.json'), 'utf8'),
    ) as SignerRuntimeSidecar
  } catch {
    return null
  }
}

async function writeRuntimeSidecar(input: {
  path: string
  wrapperPath: string
  runtimeDirectory: string
  npmCacheDirectory: string
  cliPath: string
  serverName?: string
  override?: RuntimeSpecOverrideRecord
  installedVersions?: { signerVersion: string; sdkVersion: string }
}): Promise<void> {
  const value = {
    ...(input.serverName ? { server_name: input.serverName } : {}),
    signer_package: MCP_RUNTIME_MANIFEST.signerPackage,
    signer_version: input.installedVersions?.signerVersion ?? MCP_RUNTIME_MANIFEST.signerVersion,
    sdk_package: MCP_RUNTIME_MANIFEST.sdkPackage,
    sdk_version: input.installedVersions?.sdkVersion ?? MCP_RUNTIME_MANIFEST.sdkVersion,
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
