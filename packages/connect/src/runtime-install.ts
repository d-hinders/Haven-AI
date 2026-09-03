import { execFile } from 'node:child_process'
import { connectorRerunCommand } from '@haven_ai/sdk'
import { promisify } from 'node:util'
import { writeRuntimeConfig, type RuntimeMcpMode, type RuntimeConfigWriteResult } from './config-writers.js'
import { serverNamesFor } from './server-names.js'
import {
  acknowledgeLocalMcpConsent,
  getLocalMcpConsentStatus,
  type LocalMcpConsentStatus,
} from './local-mcp-consent.js'
import {
  probeHostedMcpTools,
  probeLocalMcpTools,
  probeLocalSignerCredential,
  type LocalMcpProbeResult,
  type LocalMcpProbeStatus,
} from './probes.js'
import {
  prepareLocalMcpRuntime,
  type PreparedLocalMcpRuntime,
  type PrepareLocalMcpRuntimeInput,
} from './local-mcp-runtime.js'
import {
  prepareSignerRuntime,
  type PreparedSignerRuntime,
  type PrepareSignerRuntimeInput,
} from './signer-runtime.js'
import { MCP_RUNTIME_MANIFEST, mcpPackageSpec, signerPackageSpec } from './runtime-manifest.js'
import { installSkillForRuntime } from './skill-install.js'
import { normalizeRuntime, restartRequiredForRuntime, runtimeProfile, type RuntimeId } from './runtime-registry.js'
import {
  acknowledgeLocalSignerConsent,
  getLocalSignerConsentStatus,
  type LocalSignerConsentStatus,
} from './signer-consent.js'

const execFileAsync = promisify(execFile)

export interface RuntimeInstallInput {
  runtime?: string
  hostedMcpUrl: string
  apiKey: string
  signerPath: string
  identityPath: string
  credentialDirectory: string
  environmentLabel?: string
  ackSigner?: boolean
  ackLocalTools?: boolean
  /**
   * Explicit opt-in to the local-stdio MCP topology (zero hosted dependency).
   * Default is hosted MCP + local signer for every runtime; local MCP is only
   * used when this is true and the runtime supports it.
   */
  localMcp?: boolean
  /**
   * #1695: wiring slug for a NAMED MCP pair (haven-<slug> /
   * haven-signer-<slug>). Absent = the bare pair, unchanged from today.
   */
  serverName?: string
}

export interface RuntimeInstallResult {
  runtime: RuntimeId
  runtimeMcpMode: RuntimeMcpMode
  hostedMcpConfigured: boolean
  localSignerConfigured: boolean
  localMcpConfigured: boolean
  probeResult: string
  restartRequired: boolean
  nextUserAction: string
  errorCode?: string
  configTarget?: string
  runtimeVersion?: string
  signerAcknowledged?: boolean
  localMcpAcknowledged?: boolean
  activationCommand?: string
  skillInstalled?: boolean
  /**
   * Hosted topology only: true when the signer was pre-installed and registered
   * via its absolute wrapper, false when prep failed and it fell back to the
   * fragile runtime-`npx` launch. Undefined for local/manual topologies that
   * do not run the signer as a separate MCP. Lets callers/tests detect the
   * silent npx fallback instead of treating every write as fully healthy.
   */
  signerRuntimePrepared?: boolean
  messages: string[]
}

/**
 * The config-write snapshot handed to `onRuntimeConfigured` (#1543). The
 * booleans mirror the semantics of the FINAL report's unlock keys minus the
 * probe verdicts: "configured" here means the config write succeeded, the
 * required consent is acknowledged, and the signer credential exists on disk
 * (a local fs check) — not that a handshake has verified it. A later probe
 * failure refines the final report and sets its errorCode; the dashboard's
 * unlock condition accepts either state.
 */
export interface EarlyRuntimeConfigReport {
  runtime: RuntimeId
  runtimeMcpMode: RuntimeMcpMode
  hostedMcpConfigured: boolean
  localSignerConfigured: boolean
  localMcpConfigured: boolean
  signerAcknowledged?: boolean
  localMcpAcknowledged?: boolean
  restartRequired: boolean
  nextUserAction: string
  errorCode?: string
}

export interface RuntimeInstallDeps {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  fetch?: typeof fetch
  /**
   * Optional live progress callback. installRuntime's slowest steps (signer
   * pre-install, runtime config write, MCP handshake probes) otherwise emit
   * nothing until the caller flushes the collected `messages` after this
   * returns — leaving the console silent through the longest part of setup.
   * When provided, a few lightweight heartbeat lines are emitted as they run.
   */
  onProgress?: (message: string) => void
  /**
   * #1543: invoked once, the moment the runtime MCP config write has settled —
   * BEFORE the network probes and the skill install. The dashboard withholds
   * its budget-approval controls until an install-status report shows the
   * runtime configured, and the final report only lands after the entire
   * install; gating approval on that tail made the user wait on work approval
   * does not depend on. The snapshot carries the config-write facts (no probe
   * verdicts, no skill state); the caller's complete report remains
   * authoritative and overwrites these keys. Best-effort by contract: a
   * throwing callback is swallowed and never fails the install.
   */
  onRuntimeConfigured?: (report: EarlyRuntimeConfigReport) => Promise<void> | void
  runCommand?: (command: string, args: string[]) => Promise<void>
  prepareLocalMcpRuntime?: (input: PrepareLocalMcpRuntimeInput) => Promise<PreparedLocalMcpRuntime>
  prepareSignerRuntime?: (input: PrepareSignerRuntimeInput) => Promise<PreparedSignerRuntime>
  probeSignerTools?: (
    command: string,
    args: string[],
    requiredTools: readonly string[],
  ) => Promise<LocalMcpProbeResult>
  probeLocalMcpTools?: (
    command: string,
    args: string[],
    requiredTools: readonly string[],
  ) => Promise<LocalMcpProbeResult>
}

export async function installRuntime(
  input: RuntimeInstallInput,
  deps: RuntimeInstallDeps = {},
): Promise<RuntimeInstallResult> {
  const runtime = normalizeRuntime(input.runtime, deps.env)
  const profile = runtimeProfile(runtime, deps.env)
  const progress = deps.onProgress ?? (() => undefined)
  const localRuntime = input.localMcp === true && supportsLocalMcp(runtime)
  const consentMessages: string[] = []
  const localMcpConsent = localRuntime
    ? await resolveLocalMcpConsent(input, consentMessages)
    : undefined
  const signerConsent = localRuntime
    ? undefined
    : await resolveSignerConsent(input, consentMessages)

  if (runtime === 'other') {
    const signerCredentialReady = await probeLocalSignerCredential(input.signerPath)
    const signerReady = signerCredentialReady && signerConsent?.acknowledged
    return {
      runtime,
      runtimeMcpMode: 'manual',
      hostedMcpConfigured: false,
      localSignerConfigured: false,
      localMcpConfigured: false,
      probeResult: signerReady
        ? 'manual_runtime_setup_required_local_signer_ready'
        : 'manual_runtime_setup_required_local_signer_unavailable',
      restartRequired: true,
      nextUserAction: 'return_to_haven_for_wallet_approval_then_configure_runtime',
      errorCode: 'manual_runtime_setup_required',
      configTarget: 'manual runtime setup',
      signerAcknowledged: signerConsent?.acknowledged,
      localMcpAcknowledged: false,
      messages: [
        ...consentMessages,
        'Custom runtime: Haven did not auto-configure it. Your credentials are on disk (chmod 600) — read them at runtime; never paste a key into the agent prompt, memory, or logs.',
        `  identity (hosted MCP Bearer): ${input.identityPath}`,
        `  signer (local signing key):   ${input.signerPath}`,
        'After wallet approval, wire the runtime to Haven by reference:',
        `  Hosted MCP + local signer: point your MCP client at ${input.hostedMcpUrl} with the api_key from identity.json, then run  npx -y ${signerPackageSpec()} --credentials ${input.signerPath}`,
        `  Fully local MCP (no hosted dependency):  npx -y ${mcpPackageSpec()} --identity ${input.identityPath} --signer ${input.signerPath}`,
      ],
    }
  }

  let localRuntimeInstall: PreparedLocalMcpRuntime | undefined
  let localRuntimeError: unknown
  if (localRuntime) {
    try {
      localRuntimeInstall = await prepareRuntimeForLocalMcp(input, deps)
    } catch (err) {
      localRuntimeError = err
    }
  }

  if (localRuntimeError) {
    const errorCode = localRuntimePrepareErrorCode(localRuntimeError)
    return {
      runtime,
      runtimeMcpMode: 'local_stdio',
      hostedMcpConfigured: false,
      localSignerConfigured: false,
      localMcpConfigured: false,
      probeResult: errorCode === 'local_mcp_unsupported_node_version'
        ? 'local_stdio_mcp_unsupported_node_version'
        : 'local_stdio_mcp_runtime_install_failed',
      restartRequired: true,
      nextUserAction: nextAction(runtime, profile.restartMode, errorCode),
      errorCode,
      configTarget: profile.label,
      signerAcknowledged: signerConsent?.acknowledged,
      localMcpAcknowledged: localMcpConsent?.acknowledged,
      activationCommand: undefined,
      messages: [
        ...consentMessages,
        `Could not prepare local Haven MCP runtime: ${localRuntimeError instanceof Error ? localRuntimeError.message : String(localRuntimeError)}`,
      ],
    }
  }

  // Hosted topology launches the local signer as its own MCP stdio server.
  // Pre-install it and register an absolute wrapper instead of a runtime
  // `npx -y` invocation, which is fragile in the agent runtime's MCP-spawn
  // environment.
  //
  // #1586: prep failure is FATAL for this setup run — loud and fail-closed,
  // never a silent npx fallback. The 2026-08-18 Codex Desktop test showed
  // why: with Codex's startup_timeout_sec = 120, an npx first-launch is a
  // multi-minute npm install killed at 2 minutes, leaving corrupted _npx
  // dirs and a config that LOOKS wired but structurally cannot connect —
  // strictly worse than a clear error. Fail-closed here means NO config is
  // written at all (not even the hosted `haven` entry): a half-wired setup
  // where quotes work but signing never can is the same looks-fine trap in
  // a different place. The recovery is a re-run once the cause (network,
  // npm cache) is addressed.
  let signerCommand: { command: string; args: string[] } | undefined
  if (!localRuntime) {
    progress('Getting the signer ready…')
    try {
      const signerRuntime = await prepareSignerForRuntime(input, deps)
      signerCommand = { command: signerRuntime.command, args: signerRuntime.args }
      consentMessages.push(...signerRuntime.messages)
    } catch (err) {
      return {
        runtime,
        runtimeMcpMode: 'hosted_plus_signer',
        hostedMcpConfigured: false,
        localSignerConfigured: false,
        localMcpConfigured: false,
        probeResult: 'signer_runtime_install_failed',
        restartRequired: false,
        nextUserAction:
          'The local Haven signer runtime could not be installed, so no configuration was written. ' +
          `Check your network (a cold install downloads the signer package set) and re-run: ${connectorRerunCommand()}`,
        errorCode: 'signer_runtime_install_failed',
        configTarget: profile.label,
        signerAcknowledged: signerConsent?.acknowledged,
        localMcpAcknowledged: localMcpConsent?.acknowledged,
        activationCommand: undefined,
        signerRuntimePrepared: false,
        messages: [
          ...consentMessages,
          `Could not pre-install the local Haven signer: ${err instanceof Error ? err.message : String(err)}`,
          'No runtime configuration was written (fail-closed): a config pointing at an uninstalled signer looks wired but cannot start.',
          `Re-run \`${connectorRerunCommand()}\` to retry the setup.`,
        ],
      }
    }
  }
  const signerRuntimePrepared = localRuntime ? undefined : signerCommand !== undefined

  progress('Setting up your Haven tools…')
  const configResult = localRuntime
    ? runtime === 'claude-code'
      ? await configureClaudeCode(deps, localRuntimeInstall?.command ?? '', input.serverName)
      : await writeRuntimeConfig({
          runtime,
          hostedMcpUrl: input.hostedMcpUrl,
          apiKey: input.apiKey,
          identityPath: input.identityPath,
          signerPath: input.signerPath,
          serverName: input.serverName,
          credentialDirectory: input.credentialDirectory,
          localMcpCommand: localRuntimeInstall?.command,
          signerCommand,
          homeDir: deps.homeDir,
          mode: 'local',
        })
    : await writeHostedRuntimeConfig(deps, { ...input, runtime }, signerCommand)

  // #1543: the config write has settled — everything the dashboard's approval
  // unlock reads is now known, so report it before the probes and skill
  // install run. The signer-credential check is a local fs stat, cheap enough
  // to make the early booleans carry the final report's semantics (minus the
  // network probe verdicts, which only refine — never gate — the unlock).
  if (deps.onRuntimeConfigured) {
    const signerCredentialOnDisk = await probeLocalSignerCredential(input.signerPath)
    const earlyLocalMcpOk = configResult.runtimeMcpMode === 'local_stdio' &&
      configResult.localMcpConfigured &&
      signerCredentialOnDisk &&
      Boolean(localMcpConsent?.acknowledged)
    const earlySignerOk = configResult.runtimeMcpMode === 'local_stdio'
      ? earlyLocalMcpOk
      : configResult.signerConfigured && signerCredentialOnDisk && Boolean(signerConsent?.acknowledged)
    try {
      await deps.onRuntimeConfigured({
        runtime,
        runtimeMcpMode: configResult.runtimeMcpMode,
        hostedMcpConfigured: configResult.hostedConfigured,
        localSignerConfigured: earlySignerOk,
        localMcpConfigured: earlyLocalMcpOk,
        signerAcknowledged: signerConsent?.acknowledged,
        localMcpAcknowledged: localMcpConsent?.acknowledged,
        restartRequired: configResult.restartRequired || restartRequiredForRuntime(runtime, deps.env),
        nextUserAction: nextAction(runtime, profile.restartMode, configResult.errorCode),
        errorCode: configResult.errorCode,
      })
    } catch {
      // Best-effort by contract: early reporting must never fail the install —
      // the caller's complete report follows either way.
    }
  }

  progress('Almost there — just confirming everything connects…')
  const localProbePromise = configResult.runtimeMcpMode === 'local_stdio' && localRuntimeInstall
    ? runLocalMcpProbe(localRuntimeInstall, deps)
    : Promise.resolve(undefined)
  // #1587: in the hosted topology the signer is its own MCP stdio server and
  // gets the same courtesy as the hosted server — a REAL handshake
  // (initialize → tools/list → required-tools check) against the registered
  // command, not a credential-file stat. The 2026-08-18 Codex test is why:
  // setup exited 0 on a signer that could not start, and the failure
  // surfaced mid-payment. Cheap and fast now that #1586 guarantees the
  // command is a prepared wrapper, never a cold npx launch.
  const signerProbePromise = configResult.runtimeMcpMode !== 'local_stdio' && signerCommand
    ? (deps.probeSignerTools ?? probeLocalMcpTools)(
        signerCommand.command,
        signerCommand.args,
        MCP_RUNTIME_MANIFEST.requiredSignerTools,
      )
    : Promise.resolve(undefined)
  const [hostedProbe, signerCredentialReady, localMcpProbe, signerProbe] = await Promise.all([
    configResult.hostedConfigured
      ? probeHostedMcpTools(input.apiKey, input.hostedMcpUrl, deps.fetch)
      : Promise.resolve({ status: 'bad_response' as const }),
    probeLocalSignerCredential(input.signerPath),
    localProbePromise,
    signerProbePromise,
  ])

  const hostedOk = configResult.hostedConfigured && hostedProbe.status === 'ok'
  const localMcpOk = configResult.runtimeMcpMode === 'local_stdio' &&
    configResult.localMcpConfigured &&
    signerCredentialReady &&
    Boolean(localMcpConsent?.acknowledged) &&
    localMcpProbe?.status === 'ok'
  const signerOk = configResult.runtimeMcpMode === 'local_stdio'
    ? localMcpOk
    : configResult.signerConfigured &&
      signerCredentialReady &&
      Boolean(signerConsent?.acknowledged) &&
      // #1587: no handshake, no green. A signer command that was registered
      // but not probed (manual topology) keeps the old semantics.
      (signerProbe === undefined || signerProbe.status === 'ok')
  const restartRequired = configResult.restartRequired || restartRequiredForRuntime(runtime, deps.env)
  const errorCode = configResult.errorCode ??
    (configResult.runtimeMcpMode === 'local_stdio'
      ? localMcpErrorCode(signerCredentialReady, localMcpConsent, localMcpProbe?.status)
      : hostedMcpErrorCode(configResult.hostedConfigured, hostedProbe.status) ??
        signerConsentErrorCode(signerCredentialReady, signerConsent) ??
        signerProbeErrorCode(signerProbe))
  const hostedProbeMessages = configResult.hostedConfigured && hostedProbe.status !== 'ok'
    ? [`Hosted Haven MCP probe failed: ${hostedProbe.status}.`]
    : configResult.hostedConfigured
      ? ['Verified hosted Haven MCP tools with a read-only handshake.']
      : []
  const signerProbeMessages = signerProbe
    ? signerProbe.status === 'ok'
      ? ['Verified local Haven signer with a stdio handshake.']
      : [
          `Local Haven signer handshake failed: ${signerProbe.status}.`,
          `Re-run \`${connectorRerunCommand()}\` to repair the signer setup.`,
        ]
    : []
  const localProbeMessages = localMcpProbe && localMcpProbe.status !== 'ok'
    ? [`Local Haven MCP handshake failed: ${localMcpProbe.status}.`]
    : localMcpProbe?.status === 'ok'
      ? ['Verified local Haven MCP tools with a stdio handshake.']
      : []

  // The generic payment skill is static and secret-free, so it is installed
  // like the other acknowledged local writes on every runtime with a
  // documented instruction mechanism (#1332): Claude's and Hermes's skills
  // folders, Codex's global AGENTS.md managed section. Runtimes without one
  // rely on the MCP server-level initialize instructions.
  const skillInstall = !configResult.errorCode
    ? await installSkillForRuntime(runtime, { homeDir: deps.homeDir, env: deps.env })
    : undefined

  return {
    runtime,
    runtimeMcpMode: configResult.runtimeMcpMode,
    hostedMcpConfigured: hostedOk,
    localSignerConfigured: signerOk,
    localMcpConfigured: localMcpOk,
    probeResult: buildProbeResult(configResult.runtimeMcpMode, configResult.hostedConfigured, hostedProbe.status, signerOk, localMcpOk, localMcpProbe?.status),
    restartRequired,
    nextUserAction: nextAction(runtime, profile.restartMode, errorCode),
    errorCode,
    configTarget: configResult.target,
    signerAcknowledged: signerConsent?.acknowledged,
    localMcpAcknowledged: localMcpConsent?.acknowledged,
    activationCommand: configResult.activationCommand,
    skillInstalled: skillInstall?.installed,
    signerRuntimePrepared,
    messages: [...consentMessages, ...(localRuntimeInstall?.messages ?? []), ...configResult.messages, ...hostedProbeMessages, ...signerProbeMessages, ...localProbeMessages, ...(skillInstall?.messages ?? [])],
  }
}

export function runtimeInstallCapabilities(runtime: string | undefined, env: NodeJS.ProcessEnv = process.env): {
  canWriteRuntimeConfig: boolean
  restartRequired: boolean
} {
  const profile = runtimeProfile(runtime, env)
  return {
    canWriteRuntimeConfig: profile.canWriteRuntimeConfig,
    restartRequired: restartRequiredForRuntime(runtime, env),
  }
}

async function configureClaudeCode(
  deps: RuntimeInstallDeps,
  localMcpCommand: string,
  serverName?: string,
): Promise<{
  hostedConfigured: boolean
  signerConfigured: boolean
  localMcpConfigured: boolean
  runtimeMcpMode: RuntimeMcpMode
  target: string
  changed: boolean
  restartRequired: boolean
  messages: string[]
  errorCode?: string
  activationCommand?: string
}> {
  const runCommand = deps.runCommand ?? defaultRunCommand
  const serverJson = JSON.stringify({
    type: 'stdio',
    command: localMcpCommand,
    args: [],
    env: {},
  })
  try {
    if (!localMcpCommand) throw new Error('local MCP wrapper command is required')
    // Remove stale entries first so re-runs and hosted→local switches are
    // idempotent — `claude mcp add-json` fails when the name already exists.
    // #1569: without this, a second setup left the runtime wired to the
    // PREVIOUS agent's wrapper (the add collided, the old entry survived) —
    // the hosted sibling below always did it in this order. Deliberate
    // tradeoff: if the add fails AFTER a successful remove, the runtime ends
    // with NO haven entry instead of a stale wrong-agent one — fail-closed,
    // and the claude_code_config_failed recovery (rerun setup) works cleanly
    // from that state because this sequence is idempotent from any start.
    const names = serverNamesFor(serverName)
    await runCommand('claude', ['mcp', 'remove', names.hosted]).catch(() => undefined)
    await runCommand('claude', ['mcp', 'remove', names.signer]).catch(() => undefined)
    await runCommand('claude', ['mcp', 'add-json', names.hosted, serverJson, '--scope', 'user'])
      .catch(async () => {
        await runCommand('claude', ['mcp', 'add', names.hosted, '--scope', 'user', '--', localMcpCommand])
      })
    const verified = await runCommand('claude', ['mcp', 'get', names.hosted])
      .then(() => true)
      .catch(() => false)
    return {
      hostedConfigured: false,
      signerConfigured: true,
      localMcpConfigured: true,
      runtimeMcpMode: 'local_stdio',
      target: 'Claude Code MCP config',
      changed: true,
      restartRequired: true,
      messages: [
        'Updated local Haven MCP entry with Claude Code.',
        ...(verified ? ['Verified Claude Code MCP entry.'] : []),
      ],
    }
  } catch (err) {
    return {
      hostedConfigured: false,
      signerConfigured: false,
      localMcpConfigured: false,
      runtimeMcpMode: 'local_stdio',
      target: 'Claude Code MCP config',
      changed: false,
      restartRequired: true,
      messages: [
        `Could not update Claude Code MCP config: ${err instanceof Error ? err.message : String(err)}`,
        'Install Claude Code or rerun the Haven setup command inside a Claude Code terminal.',
      ],
      errorCode: 'claude_code_config_failed',
    }
  }
}

/**
 * Write the HOSTED topology's runtime config, whichever runtime it is.
 *
 * Exported and extracted (#1700) because Claude Code is not written by
 * `writeRuntimeConfig` at all — its `switch` has no `claude-code` case, so that
 * runtime falls through to the `default:` branch and returns
 * `hostedConfigured: false` with a "add it manually" message. Claude Code's
 * config is written by shelling out to `claude mcp add-json` instead.
 *
 * That is easy to not know, and the cost of not knowing it is silent: a caller
 * that reaches for `writeRuntimeConfig` directly gets a plausible-looking
 * result object for the single most common runtime, having changed nothing.
 * Re-key hit exactly that — it reported success while leaving every wired
 * Claude Code host presenting an API key the backend had just retired. This
 * function is the one place that fork is decided, so a future caller inherits
 * the right answer instead of rediscovering the wrong one.
 */
export async function writeHostedRuntimeConfig(
  deps: RuntimeInstallDeps,
  input: RuntimeInstallInput,
  signerCommand?: { command: string; args: string[] },
): Promise<RuntimeConfigWriteResult> {
  if (input.runtime === 'claude-code') {
    return configureClaudeCodeHosted(deps, input, signerCommand)
  }
  return writeRuntimeConfig({
    runtime: input.runtime as RuntimeId,
    hostedMcpUrl: input.hostedMcpUrl,
    apiKey: input.apiKey,
    identityPath: input.identityPath,
    signerPath: input.signerPath,
    serverName: input.serverName,
    credentialDirectory: input.credentialDirectory,
    signerCommand,
    homeDir: deps.homeDir,
    mode: 'hosted',
  })
}

async function configureClaudeCodeHosted(
  deps: RuntimeInstallDeps,
  input: RuntimeInstallInput,
  signerCommand?: { command: string; args: string[] },
): Promise<{
  hostedConfigured: boolean
  signerConfigured: boolean
  localMcpConfigured: boolean
  runtimeMcpMode: RuntimeMcpMode
  target: string
  changed: boolean
  restartRequired: boolean
  messages: string[]
  errorCode?: string
  activationCommand?: string
}> {
  const runCommand = deps.runCommand ?? defaultRunCommand
  const hostedJson = JSON.stringify({
    type: 'http',
    url: input.hostedMcpUrl,
    headers: { Authorization: `Bearer ${input.apiKey}` },
  })
  const signerJson = JSON.stringify({
    type: 'stdio',
    command: signerCommand?.command ?? 'npx',
    args: signerCommand?.args ?? ['-y', signerPackageSpec(), '--credentials', input.signerPath],
    env: {},
  })
  try {
    // Remove stale entries first so re-runs and local→hosted switches are
    // idempotent — `claude mcp add-json` fails when the name already exists.
    // #1695: only the entries THIS pair owns, by name — a named setup can
    // never clobber the bare pair or a sibling named pair.
    const names = serverNamesFor(input.serverName)
    await runCommand('claude', ['mcp', 'remove', names.hosted]).catch(() => undefined)
    await runCommand('claude', ['mcp', 'remove', names.signer]).catch(() => undefined)
    await runCommand('claude', ['mcp', 'add-json', names.hosted, hostedJson, '--scope', 'user'])
    await runCommand('claude', ['mcp', 'add-json', names.signer, signerJson, '--scope', 'user'])
    const verified = await runCommand('claude', ['mcp', 'get', names.hosted])
      .then(() => true)
      .catch(() => false)
    return {
      hostedConfigured: true,
      signerConfigured: true,
      localMcpConfigured: false,
      runtimeMcpMode: 'hosted_plus_signer',
      target: 'Claude Code MCP config',
      changed: true,
      restartRequired: true,
      messages: [
        'Updated hosted Haven MCP and local signer entries with Claude Code.',
        ...(verified ? ['Verified Claude Code MCP entry.'] : []),
      ],
    }
  } catch (err) {
    return {
      hostedConfigured: false,
      signerConfigured: false,
      localMcpConfigured: false,
      runtimeMcpMode: 'hosted_plus_signer',
      target: 'Claude Code MCP config',
      changed: false,
      restartRequired: true,
      messages: [
        `Could not update Claude Code MCP config: ${err instanceof Error ? err.message : String(err)}`,
        'Install Claude Code or rerun the Haven setup command inside a Claude Code terminal.',
      ],
      errorCode: 'claude_code_config_failed',
    }
  }
}

async function defaultRunCommand(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { timeout: 10_000 })
}

function buildProbeResult(
  mode: RuntimeMcpMode,
  hostedConfigured: boolean,
  hostedStatus: string,
  signerReady: boolean,
  localMcpReady: boolean,
  localMcpProbeStatus?: LocalMcpProbeStatus,
): string {
  if (mode === 'local_stdio') {
    if (localMcpReady) return 'local_stdio_mcp_ready'
    return localMcpProbeStatus ? `local_stdio_mcp_${localMcpProbeStatus}` : 'local_stdio_mcp_unavailable'
  }
  const hostedPart = hostedConfigured ? `hosted_${hostedStatus}` : 'hosted_not_configured'
  const signerPart = signerReady ? 'local_signer_ready' : 'local_signer_unavailable'
  return `${hostedPart}_${signerPart}`.slice(0, 120)
}

async function resolveLocalMcpConsent(
  input: RuntimeInstallInput,
  messages: string[],
): Promise<LocalMcpConsentStatus> {
  if (input.ackLocalTools || input.ackSigner) {
    const status = await acknowledgeLocalMcpConsent(input.identityPath, input.signerPath, (message) => messages.push(message))
    if (status.acknowledged) {
      messages.push('Prepared the local Haven tools acknowledgement.')
    } else {
      messages.push('Local Haven tools acknowledgement still needs attention.')
    }
    return status
  }
  return getLocalMcpConsentStatus(input.identityPath, input.signerPath)
}

async function resolveSignerConsent(
  input: RuntimeInstallInput,
  messages: string[],
): Promise<LocalSignerConsentStatus> {
  if (input.ackSigner || input.ackLocalTools) {
    const status = await acknowledgeLocalSignerConsent(input.signerPath, (message) => messages.push(message))
    if (status.acknowledged) {
      messages.push('Prepared the local Haven signer acknowledgement.')
    } else {
      messages.push('Local Haven signer acknowledgement still needs attention.')
    }
    return status
  }
  return getLocalSignerConsentStatus(input.signerPath)
}

function signerConsentErrorCode(
  signerCredentialReady: boolean,
  signerConsent: LocalSignerConsentStatus | undefined,
): string | undefined {
  if (!signerCredentialReady) return 'local_signer_credential_unavailable'
  if (!signerConsent?.acknowledged) return 'local_signer_ack_required'
  return undefined
}

function signerProbeErrorCode(probe: LocalMcpProbeResult | undefined): string | undefined {
  if (!probe || probe.status === 'ok') return undefined
  return `local_signer_probe_${probe.status}`
}

function hostedMcpErrorCode(
  hostedConfigured: boolean,
  hostedProbeStatus: string,
): string | undefined {
  if (!hostedConfigured || hostedProbeStatus === 'ok') return undefined
  return `hosted_mcp_probe_${hostedProbeStatus}`
}

function localMcpErrorCode(
  signerCredentialReady: boolean,
  localMcpConsent: LocalMcpConsentStatus | undefined,
  localMcpProbeStatus: LocalMcpProbeStatus | undefined,
): string | undefined {
  if (!signerCredentialReady) return 'local_signer_credential_unavailable'
  if (!localMcpConsent?.acknowledged) return 'local_mcp_ack_required'
  if (localMcpProbeStatus && localMcpProbeStatus !== 'ok') return `local_mcp_probe_${localMcpProbeStatus}`
  return undefined
}

function nextAction(
  runtime: RuntimeId,
  restartMode: 'restart-session' | 'restart-app' | 'hot-reload' | 'manual',
  errorCode?: string,
): string {
  if (errorCode) return 'return_to_haven_for_wallet_approval_then_finish_runtime_setup'
  if (restartMode === 'hot-reload') return 'return_to_haven_for_wallet_approval'
  if (runtime === 'codex-cli' || runtime === 'codex-desktop') return 'return_to_haven_for_wallet_approval_then_restart_codex'
  if (runtime === 'claude-code') return 'return_to_haven_for_wallet_approval_then_restart_claude_code'
  if (restartMode === 'restart-app') return 'return_to_haven_for_wallet_approval_then_restart_app'
  if (restartMode === 'restart-session') return 'return_to_haven_for_wallet_approval_then_restart_agent_session'
  return 'return_to_haven_for_wallet_approval_then_configure_runtime'
}

/**
 * Runtimes where the local-stdio MCP topology can be installed when the user
 * explicitly opts in. Never used by default — the default topology is hosted
 * MCP + local signer for every runtime.
 */
export function supportsLocalMcp(runtime: RuntimeId): boolean {
  return runtime === 'codex-cli' || runtime === 'codex-desktop' || runtime === 'claude-code'
}

async function prepareRuntimeForLocalMcp(
  input: RuntimeInstallInput,
  deps: RuntimeInstallDeps,
): Promise<PreparedLocalMcpRuntime> {
  // onProgress threaded through on purpose (#1593, the #1586 review lesson):
  // without it the install heartbeat is dead code in production.
  const prepare = deps.prepareLocalMcpRuntime ?? ((runtimeInput: PrepareLocalMcpRuntimeInput) =>
    prepareLocalMcpRuntime(runtimeInput, { runCommand: deps.runCommand, onProgress: deps.onProgress }))
  return prepare({
    credentialDirectory: input.credentialDirectory,
    identityPath: input.identityPath,
    signerPath: input.signerPath,
    homeDir: deps.homeDir,
    serverName: input.serverName,
  })
}

async function prepareSignerForRuntime(
  input: RuntimeInstallInput,
  deps: RuntimeInstallDeps,
): Promise<PreparedSignerRuntime> {
  const prepare = deps.prepareSignerRuntime ?? ((runtimeInput: PrepareSignerRuntimeInput) =>
    // onProgress threaded through on purpose (#1586 review): without it the
    // install heartbeat was dead code in production and the console still
    // went silent for the whole cold install — the exact symptom the issue
    // set out to remove, at a longer timeout.
    prepareSignerRuntime(runtimeInput, { runCommand: deps.runCommand, onProgress: deps.onProgress }))
  return prepare({
    credentialDirectory: input.credentialDirectory,
    signerPath: input.signerPath,
    homeDir: deps.homeDir,
    serverName: input.serverName,
  })
}

async function runLocalMcpProbe(
  runtimeInstall: PreparedLocalMcpRuntime,
  deps: RuntimeInstallDeps,
): Promise<LocalMcpProbeResult> {
  const probe = deps.probeLocalMcpTools ?? probeLocalMcpTools
  try {
    return await probe(runtimeInstall.command, runtimeInstall.args, MCP_RUNTIME_MANIFEST.requiredTools)
  } catch {
    return { status: 'process_error' }
  }
}

function localRuntimePrepareErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'local_mcp_unsupported_node_version') {
    return 'local_mcp_unsupported_node_version'
  }
  return 'local_mcp_runtime_install_failed'
}
