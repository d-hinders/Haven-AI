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
  const credentials = options.credentials ?? await loadCredentials(options.credentialsPath)
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
 * Each tool dispatch sets `X-Haven-MCP-Tool: <name>` on the underlying SDK
 * requests so the backend can write an audit-log row attributing the call
 * to this MCP tool. The header is cleared after the dispatch so that
 * follow-on internal calls (e.g. the consent-gate `getAgent`) are not
 * mis-attributed.
 */
export function buildMcpServer(haven: HavenClient): McpServer {
  const server = new McpServer({
    name: '@haven_ai/mcp',
    version: '0.1.0-alpha',
  })

  const handlers = createToolHandlers(haven)
  const registerTool = (server as any).tool.bind(server)
  for (const name of Object.keys(toolSchemas) as HavenMcpToolName[]) {
    registerTool(
      name,
      toolDescriptions[name],
      toolSchemas[name],
      async (args: unknown) => {
        haven.setDefaultHeader('X-Haven-MCP-Tool', name)
        try {
          return toMcpResult(await handlers[name](args))
        } finally {
          haven.setDefaultHeader('X-Haven-MCP-Tool', undefined)
        }
      },
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
  const input = await consentInputFromClient(haven, credentials.apiKey, toolNames)
  return ensureConsent(input, {
    credentialsPath: options.credentialsPath,
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
