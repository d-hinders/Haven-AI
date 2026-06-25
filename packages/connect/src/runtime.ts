import { createConnectApiClient, type ConnectApiClient, type ResolvedSetup } from './api.js'
import {
  agentApiKeyPrefix,
  generateAgentApiKey,
  generateDelegateKey,
  hashAgentApiKey,
  type LocalDelegateKey,
} from './key.js'
import { redactSecrets, shortAddress } from './redact.js'
import {
  preflightCredentialStorage,
  writeCredentialFiles,
  type StoredCredentialPaths,
} from './storage.js'
import {
  installRuntime,
  runtimeInstallCapabilities,
  supportsLocalMcp,
  type RuntimeInstallResult,
} from './runtime-install.js'
import { normalizeRuntime, runtimeProfile, runtimeRequiresHardRestart } from './runtime-registry.js'

export const CONNECTOR_VERSION = '0.1.17-alpha.0'

export interface ConnectOptions {
  setupToken: string
  apiBaseUrl: string
  runtime?: string
  credentialsDir?: string
  environmentLabel?: string
  connectorVersion?: string
  ackSigner?: boolean
  ackLocalTools?: boolean
  localMcp?: boolean
}

export interface ConnectDeps {
  api?: ConnectApiClient
  generateKey?: () => LocalDelegateKey
  generateApiKey?: () => string
  preflightStorage?: typeof preflightCredentialStorage
  writeCredentials?: typeof writeCredentialFiles
  installRuntime?: typeof installRuntime
  log?: (message: string) => void
}

export interface ConnectResult {
  setupId: string
  agentId: string
  delegateAddress: string
  credentialPaths: StoredCredentialPaths
}

export async function runConnect(options: ConnectOptions, deps: ConnectDeps = {}): Promise<ConnectResult> {
  const connectorVersion = options.connectorVersion ?? CONNECTOR_VERSION
  const api = deps.api ?? createConnectApiClient(options.apiBaseUrl)
  const log = secureLogger(deps.log ?? ((message) => process.stdout.write(`${message}\n`)))
  const writeCredentials = deps.writeCredentials ?? writeCredentialFiles
  const preflightStorage = deps.preflightStorage ?? preflightCredentialStorage
  const runRuntimeInstall = deps.installRuntime ?? installRuntime
  const generateKey = deps.generateKey ?? generateDelegateKey
  const generateLocalApiKey = deps.generateApiKey ?? generateAgentApiKey
  const installCapabilities = runtimeInstallCapabilities(options.runtime)

  if (options.localMcp) {
    const resolvedRuntime = normalizeRuntime(options.runtime)
    if (!supportsLocalMcp(resolvedRuntime)) {
      throw new Error(
        `--local (fully-local Haven MCP) is only available for Claude Code and Codex. ` +
        `The detected runtime is ${runtimeProfile(resolvedRuntime).label}. ` +
        'Re-run without --local to use the default hosted MCP + local signer setup.',
      )
    }
  }

  log('Warming up your connection to Haven…')
  const setup = await api.resolveSetup({
    setupToken: options.setupToken,
    connectorVersion,
    runtime: options.runtime,
  })
  printSetupSummary(setup, log)

  await preflightStorage({ baseDir: options.credentialsDir, warn: log })
  log('Checked local credential storage — all clear.')

  const localKey = generateKey()
  const localApiKey = generateLocalApiKey()
  log('Minting a fresh signing key and API key — both stay on this machine.')
  const proofSignature = await localKey.signChallenge(setup.challenge.message)

  log('Introducing your agent to Haven…')
  const registration = await api.registerSetup({
    setupToken: options.setupToken,
    connectorVersion,
    runtime: options.runtime,
    challengeId: setup.challenge.id,
    delegateAddress: localKey.address,
    proofSignature,
    apiKeyHash: hashAgentApiKey(localApiKey),
    apiKeyPrefix: agentApiKeyPrefix(localApiKey),
    connectorContext: {
      environment_label: options.environmentLabel ?? 'Local workspace',
      config_target: installCapabilities.canWriteRuntimeConfig
        ? 'agent runtime MCP config'
        : 'local credential files',
    },
    installCapabilities,
  })

  log(`Registered signing address with Haven: ${shortAddress(registration.delegate_address)}.`)

  log('Tucking your credentials away safely on disk…')
  const credentialPaths = await writeCredentials({
    baseDir: options.credentialsDir,
    agentId: registration.agent_id,
    apiKey: localApiKey,
    delegateKey: localKey.privateKey,
    delegateAddress: localKey.address,
    safeAddress: setup.haven_wallet.address,
    chainId: setup.haven_wallet.chain_id,
    network: setup.haven_wallet.network,
    agentBudget: setup.agent_budget.map((budget) => ({
      token_symbol: budget.token_symbol,
      allowance_amount: budget.allowance_amount,
      reset_period_min: budget.reset_period_min,
    })),
    apiUrl: options.apiBaseUrl,
    hostedMcpUrl: registration.hosted_mcp_url,
    x402BindingSigner: setup.x402_binding_signer ?? undefined,
    warn: log,
  })
  log(`Stored Haven identity credential locally: ${credentialPaths.identityPath}`)
  log(`Stored local signer credential locally: ${credentialPaths.signerPath}`)
  log(`Stored non-secret agent orientation locally: ${credentialPaths.agentPath}`)
  if (setup.x402_binding_signer) {
    log('Configured x402 binding signer for the local signer.')
  } else {
    // Fail loud here rather than silently at x402 sign time: without a trusted
    // binding signer the edge signer refuses to sign x402 funding hashes.
    log(
      'Warning: Haven did not provide an x402 binding signer, so x402 payments will not sign ' +
        'until HAVEN_X402_BINDING_SIGNER is set for the signer. Non-x402 payments are unaffected.',
    )
  }

  const runtimeInstall = await runRuntimeInstall({
    runtime: options.runtime,
    hostedMcpUrl: registration.hosted_mcp_url,
    apiKey: localApiKey,
    signerPath: credentialPaths.signerPath,
    identityPath: credentialPaths.identityPath,
    credentialDirectory: credentialPaths.directory,
    environmentLabel: options.environmentLabel ?? 'Local workspace',
    ackSigner: options.ackSigner,
    ackLocalTools: options.ackLocalTools,
    localMcp: options.localMcp,
  }, { onProgress: log })
  printRuntimeInstall(runtimeInstall, log)

  // Tell the user they're done and what to do next BEFORE the telemetry call —
  // the install-status report is best-effort and must not sit between them and
  // the "you're finished" signal. The agent who reported the setup couldn't tell
  // whether the connector had finished; this affirms it explicitly. Only claim
  // completion when the runtime install actually succeeded — an errorCode means
  // manual steps remain (e.g. an unrecognized runtime), so don't overstate it.
  if (runtimeInstall.errorCode) {
    log('Haven setup needs a couple more steps on this machine — see the notes above.')
  } else {
    log('Haven setup on this machine is complete.')
  }
  printNextSteps(runtimeInstall, log)

  try {
    await api.updateInstallStatus(registration.setup_id, localApiKey, {
      runtime: runtimeInstall.runtime,
      connectorVersion,
      runtimeMcpMode: runtimeInstall.runtimeMcpMode,
      hostedMcpConfigured: runtimeInstall.hostedMcpConfigured,
      localSignerConfigured: runtimeInstall.localSignerConfigured,
      localMcpConfigured: runtimeInstall.localMcpConfigured,
      credentialFilesWritten: true,
      signerAcknowledged: runtimeInstall.signerAcknowledged,
      localMcpAcknowledged: runtimeInstall.localMcpAcknowledged,
      activationCommandAvailable: Boolean(runtimeInstall.activationCommand),
      skillInstalled: runtimeInstall.skillInstalled,
      probeResult: runtimeInstall.probeResult,
      restartRequired: runtimeInstall.restartRequired,
      nextUserAction: runtimeInstall.nextUserAction,
      errorCode: runtimeInstall.errorCode,
      environmentLabel: options.environmentLabel ?? 'Local workspace',
    })
  } catch (err) {
    log(`Could not report install status to Haven: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    setupId: registration.setup_id,
    agentId: registration.agent_id,
    delegateAddress: registration.delegate_address,
    credentialPaths,
  }
}

function printSetupSummary(setup: ResolvedSetup, log: (message: string) => void): void {
  log(`Fetched Haven setup for ${setup.agent.name}.`)
  log(`Haven wallet: ${setup.haven_wallet.name} on ${setup.haven_wallet.network}.`)
  if (setup.agent_budget.length > 0) {
    for (const budget of setup.agent_budget) {
      log(
        `Agent budget: ${budget.allowance_amount} atomic ${budget.token_symbol} / ${budget.reset_period_min} minute reset.`,
      )
    }
  }
  log(`Setup challenge expires at ${setup.challenge.expires_at}.`)
}

function secureLogger(log: (message: string) => void): (message: string) => void {
  return (message) => log(redactSecrets(message))
}

function printRuntimeInstall(result: RuntimeInstallResult, log: (message: string) => void): void {
  for (const message of result.messages) log(message)
  if (result.localMcpConfigured) {
    log('Configured local Haven MCP tools.')
  } else if (result.hostedMcpConfigured) {
    log('Configured hosted Haven MCP identity.')
  } else {
    log('Haven MCP tools still need runtime setup.')
  }
  if (result.localSignerConfigured) {
    log('Configured local Haven signer.')
  } else {
    log('Local Haven signer still needs runtime setup.')
  }
}

/**
 * The two remaining gates after the local connector finishes: approve the rules
 * in Haven, then (for most runtimes) restart so the freshly-written MCP config
 * is loaded. The approval line states the dependency explicitly — tools never
 * appear before approval, restart or not — because an agent that had already
 * approved still couldn't tell whether missing tools meant "not approved" or
 * "needs restart."
 */
function printNextSteps(result: RuntimeInstallResult, log: (message: string) => void): void {
  log('Next: approve the agent rules in Haven. No Haven tools appear until you approve — restart or not.')
  if (result.restartRequired) {
    if (runtimeRequiresHardRestart(result.runtime)) {
      // Desktop GUI runtimes: the MCP server is bound to app launch.
      log('After you approve, restart this agent so it can load Haven tools.')
    } else {
      // CLI / session runtimes (Claude Code, Codex CLI). The MCP config is
      // written after the session starts and these runtimes only load MCP
      // servers at startup, so a restart is required — not optional. An earlier
      // softened "should appear in your next message" hint was misleading: a
      // user who had already approved still saw no tools until they restarted.
      log('After you approve, restart this agent — your current session won\'t load the Haven tools until you do.')
    }
  } else {
    // Hot-reload runtimes (Cursor, VS Code) genuinely pick up new MCP servers
    // without a restart.
    log('After you approve, the Haven tools should appear in this runtime shortly.')
  }
}
