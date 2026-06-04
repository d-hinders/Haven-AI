import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MCP_VERSION } from '@haven_ai/mcp'
import { writeRuntimeConfig, type RuntimeMcpMode } from './config-writers.js'
import {
  acknowledgeLocalMcpConsent,
  getLocalMcpConsentStatus,
  type LocalMcpConsentStatus,
} from './local-mcp-consent.js'
import { probeHostedMcpTools, probeLocalSignerCredential } from './probes.js'
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
  messages: string[]
}

export interface RuntimeInstallDeps {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  fetch?: typeof fetch
  runCommand?: (command: string, args: string[]) => Promise<void>
}

export async function installRuntime(
  input: RuntimeInstallInput,
  deps: RuntimeInstallDeps = {},
): Promise<RuntimeInstallResult> {
  const runtime = normalizeRuntime(input.runtime, deps.env)
  const profile = runtimeProfile(runtime, deps.env)
  const localRuntime = usesLocalMcp(runtime)
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

  const configResult = runtime === 'claude-code'
    ? await configureClaudeCode(input, deps)
    : await writeRuntimeConfig({
        runtime,
        hostedMcpUrl: input.hostedMcpUrl,
        apiKey: input.apiKey,
        identityPath: input.identityPath,
        signerPath: input.signerPath,
        credentialDirectory: input.credentialDirectory,
        homeDir: deps.homeDir,
      })

  const [hostedProbe, signerCredentialReady] = await Promise.all([
    configResult.hostedConfigured
      ? probeHostedMcpTools(input.apiKey, input.hostedMcpUrl, deps.fetch)
      : Promise.resolve({ status: 'bad_response' as const }),
    probeLocalSignerCredential(input.signerPath),
  ])

  const hostedOk = configResult.hostedConfigured && hostedProbe.status !== 'unauthorized'
  const localMcpOk = configResult.runtimeMcpMode === 'local_stdio' &&
    configResult.localMcpConfigured &&
    signerCredentialReady &&
    Boolean(localMcpConsent?.acknowledged)
  const signerOk = configResult.runtimeMcpMode === 'local_stdio'
    ? localMcpOk
    : configResult.signerConfigured && signerCredentialReady && Boolean(signerConsent?.acknowledged)
  const restartRequired = configResult.restartRequired || restartRequiredForRuntime(runtime, deps.env)
  const errorCode = configResult.errorCode ??
    (configResult.runtimeMcpMode === 'local_stdio'
      ? localMcpConsentErrorCode(signerCredentialReady, localMcpConsent)
      : signerConsentErrorCode(signerCredentialReady, signerConsent))

  return {
    runtime,
    runtimeMcpMode: configResult.runtimeMcpMode,
    hostedMcpConfigured: hostedOk,
    localSignerConfigured: signerOk,
    localMcpConfigured: localMcpOk,
    probeResult: buildProbeResult(configResult.runtimeMcpMode, configResult.hostedConfigured, hostedProbe.status, signerOk, localMcpOk),
    restartRequired,
    nextUserAction: nextAction(runtime, profile.restartMode, errorCode),
    errorCode,
    configTarget: configResult.target,
    signerAcknowledged: signerConsent?.acknowledged,
    localMcpAcknowledged: localMcpConsent?.acknowledged,
    activationCommand: configResult.activationCommand,
    messages: [...consentMessages, ...configResult.messages],
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
  input: RuntimeInstallInput,
  deps: RuntimeInstallDeps,
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
  try {
    await runCommand('claude', [
      'mcp',
      'add',
      'haven',
      '--',
      'npx',
      '-y',
      localMcpPackageName(),
      '--identity',
      input.identityPath,
      '--signer',
      input.signerPath,
    ])
    await runCommand('claude', ['mcp', 'remove', 'haven-signer']).catch(() => undefined)
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
        'After Haven approval, restart Claude Code normally so it can load Haven tools.',
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

async function defaultRunCommand(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { timeout: 10_000 })
}

function buildProbeResult(
  mode: RuntimeMcpMode,
  hostedConfigured: boolean,
  hostedStatus: string,
  signerReady: boolean,
  localMcpReady: boolean,
): string {
  if (mode === 'local_stdio') {
    return localMcpReady ? 'local_stdio_mcp_ready' : 'local_stdio_mcp_unavailable'
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

function localMcpConsentErrorCode(
  signerCredentialReady: boolean,
  localMcpConsent: LocalMcpConsentStatus | undefined,
): string | undefined {
  if (!signerCredentialReady) return 'local_signer_credential_unavailable'
  if (!localMcpConsent?.acknowledged) return 'local_mcp_ack_required'
  return undefined
}

function nextAction(
  runtime: RuntimeId,
  restartMode: 'restart-session' | 'restart-app' | 'hot-reload' | 'manual',
  errorCode?: string,
): string {
  if (errorCode) return 'return_to_haven_for_wallet_approval_then_finish_runtime_setup'
  if (restartMode === 'hot-reload') return 'return_to_haven_for_wallet_approval'
  if (runtime === 'codex-cli') return 'return_to_haven_for_wallet_approval_then_restart_codex'
  if (runtime === 'claude-code') return 'return_to_haven_for_wallet_approval_then_restart_claude_code'
  if (restartMode === 'restart-app') return 'return_to_haven_for_wallet_approval_then_restart_app'
  if (restartMode === 'restart-session') return 'return_to_haven_for_wallet_approval_then_restart_agent_session'
  return 'return_to_haven_for_wallet_approval_then_configure_runtime'
}

function localMcpPackageName(): string {
  return `@haven_ai/mcp@${MCP_VERSION}`
}

function usesLocalMcp(runtime: RuntimeId): boolean {
  return runtime === 'codex-cli' || runtime === 'claude-code'
}
