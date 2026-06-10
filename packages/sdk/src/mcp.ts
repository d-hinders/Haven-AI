/**
 * MCP-over-x402 helpers shared across the SDK and the MCP tool surfaces.
 *
 * MCP merchants (Soundside, the Coinbase reference) expose named tools over the
 * Streamable-HTTP transport. Calling one means POSTing a JSON-RPC `tools/call`
 * envelope. Both the local one-shot path (`HavenClient.fetch`) and the hosted
 * keyless split path build the exact same envelope, so the construction lives
 * here in one place.
 */

/** A JSON-RPC 2.0 `tools/call` request envelope for an MCP merchant. */
export interface McpToolCallEnvelope {
  jsonrpc: '2.0'
  id: string | number
  method: 'tools/call'
  params: {
    name: string
    arguments: Record<string, unknown>
  }
}

/**
 * Build the JSON-RPC `tools/call` envelope an MCP merchant expects.
 *
 * The agent supplies only the tool name and its arguments; the protocol
 * plumbing (jsonrpc version, request id, method) is filled in here so neither
 * the agent nor the MCP tool handlers have to hand-roll it.
 */
export function buildMcpToolCallEnvelope(
  toolName: string,
  args?: Record<string, unknown>,
  id: string | number = 'haven-mcp-call-1',
): McpToolCallEnvelope {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args ?? {},
    },
  }
}
