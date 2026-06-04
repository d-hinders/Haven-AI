export interface ConnectApiClient {
  resolveSetup(input: ResolveSetupInput): Promise<ResolvedSetup>
  registerSetup(input: RegisterSetupInput): Promise<RegisterSetupResponse>
  updateInstallStatus(
    setupId: string,
    apiKey: string,
    input: UpdateInstallStatusInput,
  ): Promise<void>
}

export interface ResolveSetupInput {
  setupToken: string
  connectorVersion: string
  runtime?: string
}

export interface RegisterSetupInput extends ResolveSetupInput {
  challengeId: string
  delegateAddress: string
  proofSignature: string
  apiKeyHash: string
  apiKeyPrefix: string
  connectorContext?: ConnectorContext
  installCapabilities?: {
    canWriteRuntimeConfig?: boolean
    restartRequired?: boolean
  }
}

export interface UpdateInstallStatusInput {
  runtime?: string
  connectorVersion: string
  runtimeMcpMode?: string
  hostedMcpConfigured: boolean
  localSignerConfigured: boolean
  localMcpConfigured?: boolean
  credentialFilesWritten?: boolean
  signerAcknowledged?: boolean
  localMcpAcknowledged?: boolean
  activationCommandAvailable?: boolean
  probeResult: string
  restartRequired: boolean
  nextUserAction: string
  errorCode?: string | null
  environmentLabel?: string
}

export interface ConnectorContext {
  environment_label?: string
  runtime_version?: string
  config_target?: string
}

export interface ResolvedSetup {
  setup_id: string
  status: string
  agent: {
    name: string
    description?: string | null
  }
  haven_wallet: {
    id: string
    name: string
    address: string
    chain_id: number
    network: string
  }
  agent_budget: Array<{
    token_address: string
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }>
  hosted_mcp_url: string
  challenge: {
    id: string
    message: string
    expires_at: string
  }
}

export interface RegisterSetupResponse {
  setup_id: string
  agent_id: string
  status: string
  agent_status: string
  api_key_prefix: string
  api_key_scope: string
  delegate_address: string
  hosted_mcp_url: string
  next_action: string
}

export function createConnectApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): ConnectApiClient {
  const root = baseUrl.replace(/\/+$/, '')
  return {
    resolveSetup: (input) =>
      request(fetchImpl, `${root}/agent-connection-setups/resolve`, {
        method: 'POST',
        body: JSON.stringify({
          setup_token: input.setupToken,
          connector_version: input.connectorVersion,
          runtime: input.runtime,
        }),
      }),

    registerSetup: (input) =>
      request(fetchImpl, `${root}/agent-connection-setups/register`, {
        method: 'POST',
        body: JSON.stringify({
          setup_token: input.setupToken,
          challenge_id: input.challengeId,
          delegate_address: input.delegateAddress,
          proof_signature: input.proofSignature,
          api_key_hash: input.apiKeyHash,
          api_key_prefix: input.apiKeyPrefix,
          runtime: input.runtime,
          connector_version: input.connectorVersion,
          connector_context: input.connectorContext,
          install_capabilities: input.installCapabilities && {
            can_write_runtime_config: input.installCapabilities.canWriteRuntimeConfig,
            restart_required: input.installCapabilities.restartRequired,
          },
        }),
      }),

    updateInstallStatus: async (setupId, apiKey, input) => {
      await request(fetchImpl, `${root}/agent-connection-setups/${encodeURIComponent(setupId)}/install-status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          runtime: input.runtime,
          connector_version: input.connectorVersion,
          runtime_mcp_mode: input.runtimeMcpMode,
          hosted_mcp_configured: input.hostedMcpConfigured,
          local_signer_configured: input.localSignerConfigured,
          local_mcp_configured: input.localMcpConfigured,
          credential_files_written: input.credentialFilesWritten,
          signer_acknowledged: input.signerAcknowledged,
          local_mcp_acknowledged: input.localMcpAcknowledged,
          activation_command_available: input.activationCommandAvailable,
          probe_result: input.probeResult,
          restart_required: input.restartRequired,
          next_user_action: input.nextUserAction,
          error_code: input.errorCode ?? null,
          environment_label: input.environmentLabel,
        }),
      })
    },
  }
}

async function request<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) {
    const message = body?.error ?? body?.message ?? `${response.status} ${response.statusText}`
    throw new Error(`Haven setup request failed: ${message}`)
  }
  return body as T
}
