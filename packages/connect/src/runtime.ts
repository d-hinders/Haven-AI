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
  type RuntimeInstallResult,
} from './runtime-install.js'

export const CONNECTOR_VERSION = '0.1.2'

export interface ConnectOptions {
  setupToken: string
  apiBaseUrl: string
  runtime?: string
  credentialsDir?: string
  environmentLabel?: string
  connectorVersion?: string
  ackSigner?: boolean
  ackLocalTools?: boolean
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

  const setup = await api.resolveSetup({
    setupToken: options.setupToken,
    connectorVersion,
    runtime: options.runtime,
  })
  printSetupSummary(setup, log)

  await preflightStorage({ baseDir: options.credentialsDir, warn: log })
  log('Checked local credential storage.')

  const localKey = generateKey()
  const localApiKey = generateLocalApiKey()
  log('Generated local signing key.')
  log('Generated local Haven API key.')
  const proofSignature = await localKey.signChallenge(setup.challenge.message)

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
    warn: log,
  })
  log(`Stored Haven identity credential locally: ${credentialPaths.identityPath}`)
  log(`Stored local signer credential locally: ${credentialPaths.signerPath}`)

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
  })
  printRuntimeInstall(runtimeInstall, log)

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
      probeResult: runtimeInstall.probeResult,
      restartRequired: runtimeInstall.restartRequired,
      nextUserAction: runtimeInstall.nextUserAction,
      errorCode: runtimeInstall.errorCode,
      environmentLabel: options.environmentLabel ?? 'Local workspace',
    })
  } catch (err) {
    log(`Could not report install status to Haven: ${err instanceof Error ? err.message : String(err)}`)
  }

  log('Return to Haven to approve the agent rules.')
  if (runtimeInstall.restartRequired) {
    log('After approval, restart this agent normally so it can load Haven tools.')
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
