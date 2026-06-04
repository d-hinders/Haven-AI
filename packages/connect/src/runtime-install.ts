import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SIGNER_VERSION } from '@haven_ai/signer'
import { writeRuntimeConfig } from './config-writers.js'
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
}

export interface RuntimeInstallResult {
  runtime: RuntimeId
  hostedMcpConfigured: boolean
  localSignerConfigured: boolean
  probeResult: string
  restartRequired: boolean
  nextUserAction: string
  errorCode?: string
  configTarget?: string
  runtimeVersion?: string
  signerAcknowledged?: boolean
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
  const signerConsentMessages: string[] = []
  const signerConsent = await resolveSignerConsent(input, signerConsentMessages)

  if (runtime === 'other') {
    const signerCredentialReady = await probeLocalSignerCredential(input.signerPath)
    const signerReady = signerCredentialReady && signerConsent.acknowledged
    return {
      runtime,
      hostedMcpConfigured: false,
      localSignerConfigured: false,
      probeResult: signerReady
        ? 'manual_runtime_setup_required_local_signer_ready'
        : 'manual_runtime_setup_required_local_signer_unavailable',
      restartRequired: true,
      nextUserAction: 'return_to_haven_for_wallet_approval_then_configure_runtime',
      errorCode: 'manual_runtime_setup_required',
      configTarget: 'manual runtime setup',
      signerAcknowledged: signerConsent.acknowledged,
      messages: [
        ...signerConsentMessages,
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
  const signerOk = configResult.signerConfigured && signerCredentialReady && signerConsent.acknowledged
  const restartRequired = configResult.restartRequired || restartRequiredForRuntime(runtime, deps.env)
  const errorCode = configResult.errorCode ?? signerConsentErrorCode(signerCredentialReady, signerConsent)

  return {
    runtime,
    hostedMcpConfigured: hostedOk,
    localSignerConfigured: signerOk,
    probeResult: buildProbeResult(configResult.hostedConfigured, hostedProbe.status, signerOk),
    restartRequired,
    nextUserAction: nextAction(runtime, profile.restartMode, errorCode),
    errorCode,
    configTarget: configResult.target,
    signerAcknowledged: signerConsent.acknowledged,
    activationCommand: configResult.activationCommand,
    messages: [...signerConsentMessages, ...configResult.messages],
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
      '--transport',
      'http',
      'haven',
      input.hostedMcpUrl,
      '--header',
      `Authorization: Bearer ${input.apiKey}`,
    ])
    await runCommand('claude', [
      'mcp',
      'add',
      'haven-signer',
      '--',
      'npx',
      '-y',
      signerPackageName(),
      '--credentials',
      input.signerPath,
    ])
    return {
      hostedConfigured: true,
      signerConfigured: true,
      target: 'Claude Code MCP config',
      changed: true,
      restartRequired: true,
      messages: [
        'Updated Haven MCP entries with Claude Code.',
        'Restart Claude Code after Haven approval so it can load the Haven tools.',
      ],
    }
  } catch (err) {
    return {
      hostedConfigured: false,
      signerConfigured: false,
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

function buildProbeResult(hostedConfigured: boolean, hostedStatus: string, signerReady: boolean): string {
  const hostedPart = hostedConfigured ? `hosted_${hostedStatus}` : 'hosted_not_configured'
  const signerPart = signerReady ? 'local_signer_ready' : 'local_signer_unavailable'
  return `${hostedPart}_${signerPart}`.slice(0, 120)
}

async function resolveSignerConsent(
  input: RuntimeInstallInput,
  messages: string[],
): Promise<LocalSignerConsentStatus> {
  if (input.ackSigner) {
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
  signerConsent: LocalSignerConsentStatus,
): string | undefined {
  if (!signerCredentialReady) return 'local_signer_credential_unavailable'
  if (!signerConsent.acknowledged) return 'local_signer_ack_required'
  return undefined
}

function nextAction(
  runtime: RuntimeId,
  restartMode: 'restart-session' | 'restart-app' | 'hot-reload' | 'manual',
  errorCode?: string,
): string {
  if (errorCode) return 'return_to_haven_for_wallet_approval_then_finish_runtime_setup'
  if (restartMode === 'hot-reload') return 'return_to_haven_for_wallet_approval'
  if (runtime === 'codex-cli') return 'return_to_haven_for_wallet_approval_then_restart_codex_with_haven_env'
  if (runtime === 'claude-code') return 'return_to_haven_for_wallet_approval_then_restart_claude_code'
  if (restartMode === 'restart-app') return 'return_to_haven_for_wallet_approval_then_restart_app'
  if (restartMode === 'restart-session') return 'return_to_haven_for_wallet_approval_then_restart_agent_session'
  return 'return_to_haven_for_wallet_approval_then_configure_runtime'
}

function signerPackageName(): string {
  return `@haven_ai/signer@${SIGNER_VERSION}`
}
