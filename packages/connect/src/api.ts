export interface ConnectApiClient {
  resolveSetup(input: ResolveSetupInput): Promise<ResolvedSetup>
  registerSetup(input: RegisterSetupInput): Promise<RegisterSetupResponse>
  updateInstallStatus(
    setupId: string,
    apiKey: string,
    input: UpdateInstallStatusInput,
  ): Promise<void>
  /**
   * #1377 D: the narrow status read the connector polls after registering,
   * authenticated with the agent API key it just minted (works while the
   * agent is still `setup_pending` — the endpoint exists for exactly that
   * window). Returns status plus the approved budget once approval lands;
   * never any secret material.
   */
  getConnectorStatus(setupId: string, apiKey: string): Promise<ConnectorStatusResponse>
}

export interface ConnectorStatusResponse {
  status: string
  approved_budget: {
    token_symbol: string
    token_address: string
    amount: string
    reset_period_min: number
  } | null
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
  skillInstalled?: boolean
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
  // Address the edge signer verifies x402 expected-context signatures against.
  // null/absent when the backend has no x402 binding key configured.
  x402_binding_signer?: string | null
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

    getConnectorStatus: (setupId, apiKey) =>
      request(fetchImpl, `${root}/agent-connection-setups/${encodeURIComponent(setupId)}/connector-status`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
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
          skill_installed: input.skillInstalled,
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

/**
 * Request failure carrying the HTTP status, so callers can tell a permanent
 * verdict (401 revoked key, 404 gone) from transient noise (5xx, network).
 * The approval poll loop (#1377 D) branches on this: retrying a 401 for the
 * full window and then saying "still pending" is actively wrong when the user
 * cancelled the setup and the key was revoked.
 */
export class ConnectRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ConnectRequestError'
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
    throw new ConnectRequestError(`Haven setup request failed: ${message}`, response.status)
  }
  return body as T
}
