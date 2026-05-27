import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createEdgeSigner, type EdgeSigner } from './core.js'
import { loadSignerCredentials } from './credentials.js'
import {
  createToolHandlers,
  toolDescriptions,
  toolSchemas,
  type SignerToolName,
  type ToolPayload,
} from './tools.js'

export const SIGNER_NAME = '@haven_ai/signer'
export const SIGNER_VERSION = '0.1.0-alpha'

export interface SignerOptions {
  /** Path to a Haven credential JSON file (delegate_key is read from it). */
  credentialsPath?: string
  /** Pre-resolved delegate key (skips credential loading). */
  delegateKey?: string
}

export async function resolveEdgeSigner(options: SignerOptions = {}): Promise<EdgeSigner> {
  if (options.delegateKey) return createEdgeSigner(options.delegateKey)
  const creds = await loadSignerCredentials(options.credentialsPath)
  return createEdgeSigner(creds.delegateKey)
}

/**
 * Build a local stdio MCP server exposing the sign-only tools, bound to an
 * edge signer that holds the delegate key. This server performs no network
 * I/O and exposes no construct/relay tools — it only signs.
 */
export function buildSignerMcpServer(signer: EdgeSigner): McpServer {
  const server = new McpServer({ name: SIGNER_NAME, version: SIGNER_VERSION })

  const handlers = createToolHandlers(signer)
  const registerTool = (server as unknown as {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: (args: unknown) => Promise<unknown>,
    ) => void
  }).tool.bind(server)

  for (const name of Object.keys(toolSchemas) as SignerToolName[]) {
    registerTool(name, toolDescriptions[name], toolSchemas[name], async (args: unknown) =>
      toMcpResult(await handlers[name](args)),
    )
  }

  return server
}

export async function runSignerStdioServer(options: SignerOptions = {}): Promise<void> {
  const signer = await resolveEdgeSigner(options)
  const server = buildSignerMcpServer(signer)
  await server.connect(new StdioServerTransport())
}

function toMcpResult(payload: ToolPayload) {
  return {
    isError: !payload.success,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  }
}
