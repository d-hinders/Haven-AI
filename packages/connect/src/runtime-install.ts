import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { writeRuntimeConfig, type RuntimeMcpMode } from './config-writers.js'
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
import { MCP_RUNTIME_MANIFEST, signerPackageSpec } from './runtime-manifest.js'
import { HAVEN_SKILL_MD, SKILL_FOLDER_NAME } from './skill-content.js'
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
  messages: string[]
}

export interface RuntimeInstallDeps {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  fetch?: typeof fetch
  runCommand?: (command: string, args: string[]) => Promise<void>
  prepareLocalMcpRuntime?: (input: PrepareLocalMcpRuntimeInput) => Promise<PreparedLocalMcpRuntime>
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
        'Runtime was not recognized. Keep the local credentials and add Haven MCP entries manually after wallet approval.',
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

  const configResult = runtime === 'claude-code'
    ? localRuntime
      ? await configureClaudeCode(deps, localRuntimeInstall?.command ?? '')
      : await configureClaudeCodeHosted(deps, input)
    : await writeRuntimeConfig({
        runtime,
        hostedMcpUrl: input.hostedMcpUrl,
        apiKey: input.apiKey,
        identityPath: input.identityPath,
        signerPath: input.signerPath,
        credentialDirectory: input.credentialDirectory,
        localMcpCommand: localRuntimeInstall?.command,
        homeDir: deps.homeDir,
        mode: localRuntime ? 'local' : 'hosted',
      })

  const localProbePromise = configResult.runtimeMcpMode === 'local_stdio' && localRuntimeInstall
    ? runLocalMcpProbe(localRuntimeInstall, deps)
    : Promise.resolve(undefined)
  const [hostedProbe, signerCredentialReady, localMcpProbe] = await Promise.all([
    configResult.hostedConfigured
      ? probeHostedMcpTools(input.apiKey, input.hostedMcpUrl, deps.fetch)
      : Promise.resolve({ status: 'bad_response' as const }),
    probeLocalSignerCredential(input.signerPath),
    localProbePromise,
  ])

  const hostedOk = configResult.hostedConfigured && hostedProbe.status !== 'unauthorized'
  const localMcpOk = configResult.runtimeMcpMode === 'local_stdio' &&
    configResult.localMcpConfigured &&
    signerCredentialReady &&
    Boolean(localMcpConsent?.acknowledged) &&
    localMcpProbe?.status === 'ok'
  const signerOk = configResult.runtimeMcpMode === 'local_stdio'
    ? localMcpOk
    : configResult.signerConfigured && signerCredentialReady && Boolean(signerConsent?.acknowledged)
  const restartRequired = configResult.restartRequired || restartRequiredForRuntime(runtime, deps.env)
  const errorCode = configResult.errorCode ??
    (configResult.runtimeMcpMode === 'local_stdio'
      ? localMcpErrorCode(signerCredentialReady, localMcpConsent, localMcpProbe?.status)
      : signerConsentErrorCode(signerCredentialReady, signerConsent))
  const localProbeMessages = localMcpProbe && localMcpProbe.status !== 'ok'
    ? [`Local Haven MCP handshake failed: ${localMcpProbe.status}.`]
    : localMcpProbe?.status === 'ok'
      ? ['Verified local Haven MCP tools with a stdio handshake.']
      : []

  // The generic payment skill is static and secret-free, so it is installed
  // like the other acknowledged local writes on runtimes with a skills folder.
  const skillInstall = runtime === 'claude-code' && !configResult.errorCode
    ? await installClaudeSkill(deps.homeDir)
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
    messages: [...consentMessages, ...(localRuntimeInstall?.messages ?? []), ...configResult.messages, ...localProbeMessages, ...(skillInstall?.messages ?? [])],
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
    await runCommand('claude', ['mcp', 'add-json', 'haven', serverJson, '--scope', 'user'])
      .catch(async () => {
        await runCommand('claude', ['mcp', 'add', 'haven', '--scope', 'user', '--', localMcpCommand])
      })
    await runCommand('claude', ['mcp', 'remove', 'haven-signer']).catch(() => undefined)
    const verified = await runCommand('claude', ['mcp', 'get', 'haven'])
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
        'After Haven approval, Haven tools should appear in your next Claude Code message. If they don\'t, restart the session to load them.',
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

async function configureClaudeCodeHosted(
  deps: RuntimeInstallDeps,
  input: RuntimeInstallInput,
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
    command: 'npx',
    args: ['-y', signerPackageSpec(), '--credentials', input.signerPath],
    env: {},
  })
  try {
    // Remove stale entries first so re-runs and local→hosted switches are
    // idempotent — `claude mcp add-json` fails when the name already exists.
    await runCommand('claude', ['mcp', 'remove', 'haven']).catch(() => undefined)
    await runCommand('claude', ['mcp', 'remove', 'haven-signer']).catch(() => undefined)
    await runCommand('claude', ['mcp', 'add-json', 'haven', hostedJson, '--scope', 'user'])
    await runCommand('claude', ['mcp', 'add-json', 'haven-signer', signerJson, '--scope', 'user'])
    const verified = await runCommand('claude', ['mcp', 'get', 'haven'])
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
        'After Haven approval, Haven tools should appear in your next Claude Code message. If they don\'t, restart the session to load them.',
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

async function installClaudeSkill(homeDir?: string): Promise<{ installed: boolean; messages: string[] }> {
  try {
    const skillDir = resolve(homeDir ?? homedir(), '.claude', 'skills', SKILL_FOLDER_NAME)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), HAVEN_SKILL_MD, 'utf8')
    return {
      installed: true,
      messages: ['Installed the generic Haven payment skill (~/.claude/skills/haven-pay). It contains no secrets.'],
    }
  } catch (err) {
    return {
      installed: false,
      messages: [`Could not install the Haven payment skill: ${err instanceof Error ? err.message : String(err)}. Download it from the Haven dashboard instead.`],
    }
  }
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
  const prepare = deps.prepareLocalMcpRuntime ?? ((runtimeInput: PrepareLocalMcpRuntimeInput) =>
    prepareLocalMcpRuntime(runtimeInput, { runCommand: deps.runCommand }))
  return prepare({
    credentialDirectory: input.credentialDirectory,
    identityPath: input.identityPath,
    signerPath: input.signerPath,
    homeDir: deps.homeDir,
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
