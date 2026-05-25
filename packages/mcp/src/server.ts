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

export interface HavenMcpServerOptions {
  credentialsPath?: string
  credentials?: HavenCredentialFile
}

export async function createHavenClient(options: HavenMcpServerOptions = {}): Promise<HavenClient> {
  const credentials = options.credentials ?? await loadCredentials(options.credentialsPath)
  return new HavenClient({
    apiKey: credentials.apiKey,
    delegateKey: credentials.delegateKey,
    baseUrl: credentials.apiUrl,
  })
}

export async function createHavenMcpServer(options: HavenMcpServerOptions = {}): Promise<McpServer> {
  const haven = await createHavenClient(options)
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
      async (args: unknown) => toMcpResult(await handlers[name](args)),
    )
  }

  return server
}

export async function runStdioServer(options: HavenMcpServerOptions = {}): Promise<void> {
  const server = await createHavenMcpServer(options)
  await server.connect(new StdioServerTransport())
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
