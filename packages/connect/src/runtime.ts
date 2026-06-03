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

export const CONNECTOR_VERSION = '0.1.0'

export interface ConnectOptions {
  setupToken: string
  apiBaseUrl: string
  runtime?: string
  credentialsDir?: string
  environmentLabel?: string
  connectorVersion?: string
}

export interface ConnectDeps {
  api?: ConnectApiClient
  generateKey?: () => LocalDelegateKey
  generateApiKey?: () => string
  preflightStorage?: typeof preflightCredentialStorage
  writeCredentials?: typeof writeCredentialFiles
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
  const generateKey = deps.generateKey ?? generateDelegateKey
  const generateLocalApiKey = deps.generateApiKey ?? generateAgentApiKey

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
      config_target: 'local credential files',
    },
    installCapabilities: {
      canWriteRuntimeConfig: false,
      restartRequired: true,
    },
  })

  log(`Registered signing address with Haven: ${shortAddress(registration.delegate_address)}.`)

  const credentialPaths = await writeCredentials({
    baseDir: options.credentialsDir,
    agentId: registration.agent_id,
    apiKey: localApiKey,
    delegateKey: localKey.privateKey,
    safeAddress: setup.haven_wallet.address,
    chainId: setup.haven_wallet.chain_id,
    network: setup.haven_wallet.network,
    apiUrl: options.apiBaseUrl,
    hostedMcpUrl: registration.hosted_mcp_url,
    warn: log,
  })
  log(`Stored Haven identity credential locally: ${credentialPaths.identityPath}`)
  log(`Stored local signer credential locally: ${credentialPaths.signerPath}`)

  try {
    await api.updateInstallStatus(registration.setup_id, localApiKey, {
      runtime: options.runtime,
      connectorVersion,
      hostedMcpConfigured: false,
      localSignerConfigured: false,
      credentialFilesWritten: true,
      probeResult: 'credential_files_written',
      restartRequired: true,
      nextUserAction: 'return_to_haven_for_wallet_approval_then_configure_runtime_if_needed',
      environmentLabel: options.environmentLabel ?? 'Local workspace',
    })
  } catch (err) {
    log(`Could not report install status to Haven: ${err instanceof Error ? err.message : String(err)}`)
  }

  log('Stored hosted Haven MCP identity credential locally.')
  log('Stored local Haven signer credential locally.')
  log('Return to Haven to approve the agent rules.')
  log('Restart this agent session after approval if your runtime loads MCP tools at startup.')

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
