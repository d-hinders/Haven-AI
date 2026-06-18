import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { HavenClient } from '@haven_ai/sdk'
import { loadCredentials, type HavenCredentialFile } from './credentials.js'
import {
  createToolHandlers,
  toolDescriptions,
  toolSchemas,
  type HavenMcpToolName,
  type ToolPayload,
} from './tools.js'
import {
  consentInputFromClient,
  ensureConsent,
  registeredToolNames,
  type ConsentDecision,
} from './consent.js'

export interface HavenMcpServerOptions {
  credentialsPath?: string
  identityPath?: string
  signerPath?: string
  credentials?: HavenCredentialFile
  /**
   * When true, write the consent sidecar file (`<credentials>.ack.json`)
   * with the current consent hash and proceed. Surfaced via the `--ack`
   * CLI flag.
   */
  writeAck?: boolean
  /**
   * When true, skip the consent gate entirely. Reserved for tests and
   * controlled embedding — production CLIs should not set this.
   */
  skipConsent?: boolean
}

export interface ResolvedHavenClient {
  client: HavenClient
  credentials: HavenCredentialFile
}

export async function createHavenClient(options: HavenMcpServerOptions = {}): Promise<HavenClient> {
  const { client } = await resolveHavenClient(options)
  return client
}

export async function resolveHavenClient(options: HavenMcpServerOptions = {}): Promise<ResolvedHavenClient> {
  const credentialSource = options.credentialsPath || options.identityPath || options.signerPath
    ? {
        credentialsPath: options.credentialsPath,
        identityPath: options.identityPath,
        signerPath: options.signerPath,
      }
    : undefined
  const credentials = options.credentials ?? await loadCredentials(credentialSource)
  const client = new HavenClient({
    apiKey: credentials.apiKey,
    delegateKey: credentials.delegateKey,
    baseUrl: credentials.apiUrl,
  })
  return { client, credentials }
}

export async function createHavenMcpServer(options: HavenMcpServerOptions = {}): Promise<McpServer> {
  const haven = await createHavenClient(options)
  return buildMcpServer(haven)
}

/**
 * Build an MCP server bound to the supplied Haven client.
 *
 * Each tool dispatch is wrapped in `haven.withRequestContext` so every
 * Haven API request the dispatch issues carries `X-Haven-MCP-Tool: <name>`
 * — and *only* that dispatch's requests see the header. The SDK uses an
 * `AsyncLocalStorage` for the context, so two tool calls running
 * concurrently cannot leak headers into each other and the backend
 * `agent_tool_invocations` rows are always attributed to the right tool.
 */
export const MCP_NAME = '@haven_ai/mcp'
export const MCP_VERSION = '0.1.16-alpha.0'

export function buildMcpServer(haven: HavenClient): McpServer {
  const server = new McpServer({
    name: MCP_NAME,
    version: MCP_VERSION,
  })

  const handlers = createToolHandlers(haven)
  const registerTool = (server as any).tool.bind(server)
  for (const name of Object.keys(toolSchemas) as HavenMcpToolName[]) {
    registerTool(
      name,
      toolDescriptions[name],
      toolSchemas[name],
      async (args: unknown) =>
        haven.withRequestContext({ 'X-Haven-MCP-Tool': name }, async () =>
          toMcpResult(await handlers[name](args)),
        ),
    )
  }

  return server
}

export async function runStdioServer(options: HavenMcpServerOptions = {}): Promise<void> {
  const { client: haven, credentials } = await resolveHavenClient(options)

  if (!options.skipConsent) {
    const decision = await runConsentGate(haven, credentials, options)
    if (!decision.ok) {
      // The consent block has already been printed by `ensureConsent`.
      const err: NodeJS.ErrnoException = new Error(
        decision.reason === 'env_var_mismatch'
          ? 'Haven MCP consent acknowledgement does not match the current configuration.'
          : 'Haven MCP server requires a one-time consent acknowledgement before starting.',
      )
      err.code = 'HAVEN_MCP_NO_CONSENT'
      throw err
    }
  }

  const server = buildMcpServer(haven)
  await server.connect(new StdioServerTransport())
}

export async function runConsentGate(
  haven: HavenClient,
  credentials: HavenCredentialFile,
  options: HavenMcpServerOptions,
): Promise<ConsentDecision> {
  const toolNames = registeredToolNames()
  const input = await consentInputFromClient(
    haven,
    {
      apiKey: credentials.apiKey,
      apiUrl: credentials.apiUrl,
      agentId: credentials.agentId,
      safeAddress: credentials.safeAddress,
      delegateAddress: credentials.delegateAddress,
      chainId: credentials.chainId,
      allowanceSummary: credentials.allowanceSummary,
    },
    toolNames,
  )
  // Prefer the path actually used to load credentials (covers
  // HAVEN_CREDENTIALS as well as --credentials). If neither file path is
  // available the operator must use HAVEN_MCP_ACK; --ack has nowhere to
  // write a sidecar in that case.
  const credentialsPath = options.identityPath ?? options.credentialsPath ?? credentials.sourcePath
  return ensureConsent(input, {
    credentialsPath,
    writeAck: options.writeAck,
  })
}

function toMcpResult(payload: ToolPayload) {
  return {
    isError: !payload.success,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  }
}
