import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { HavenClient } from '@haven_ai/sdk'
import {
  createToolHandlers,
  toolDescriptions,
  toolSchemas,
  type HostedToolName,
  type ToolPayload,
} from './tools.js'

export const HOSTED_SERVER_NAME = '@haven_ai/mcp-server'
export const HOSTED_SERVER_VERSION = '0.1.15-alpha.0'

export interface HostedClientOptions {
  /** Agent API key (identity) extracted from the request Bearer token. */
  apiKey: string
  /** Haven backend base URL the server relays through. */
  baseUrl?: string
}

/**
 * Build a **keyless** Haven client for one tenant (one request/session).
 *
 * The client is constructed without a `delegateKey`, so it can construct
 * intents (`createIntent`) and relay signatures (`submitSignature`) but cannot
 * sign. This is the non-custodial guarantee in code: the hosted server has no
 * key material and no signing path.
 *
 * @throws if a delegate key ever leaks into this path — a defensive guard so a
 * future refactor can't silently make the hosted server custodial.
 */
export function createHostedHavenClient(options: HostedClientOptions): HavenClient {
  // Base mainnet RPC, so the server can wait for ≥1 on-chain confirmation of
  // the Safe→delegate funding tx before delivering the X-PAYMENT header to the
  // merchant (ensureFundingConfirmed). Read-only RPC — no signing capability.
  const chainRpcs: Record<number, string> = {}
  const baseRpc = process.env.BASE_RPC_URL?.trim()
  if (baseRpc) chainRpcs[8453] = baseRpc

  const client = new HavenClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    chainRpcs,
    // Intentionally NO delegateKey. See custody invariant in
    // docs/architecture/06-hosted-mcp-connect-flow.md.
  })

  if (client.delegateAddress !== undefined) {
    throw new Error(
      'Hosted Haven MCP server must be keyless: a delegate key was present on the client. ' +
        'The hosted server constructs and relays only — the edge signs.',
    )
  }

  return client
}

/**
 * Build an MCP server bound to a keyless Haven client.
 *
 * Each tool dispatch is wrapped in `haven.withRequestContext` so every Haven
 * API request that dispatch issues carries `X-Haven-MCP-Tool: <name>` and the
 * backend can attribute the audit-log row. The async-local store keeps
 * concurrent tenants' headers from leaking into each other.
 */
export function buildHostedMcpServer(haven: HavenClient): McpServer {
  const server = new McpServer({
    name: HOSTED_SERVER_NAME,
    version: HOSTED_SERVER_VERSION,
  })

  const handlers = createToolHandlers(haven)
  // The fluent `.tool(name, description, schema, handler)` overload keeps this
  // in step with the local @haven_ai/mcp package's registration style.
  const registerTool = (server as unknown as {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: (args: unknown) => Promise<unknown>,
    ) => void
  }).tool.bind(server)

  for (const name of Object.keys(toolSchemas) as HostedToolName[]) {
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
