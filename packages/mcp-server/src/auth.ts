import type { IncomingMessage } from 'node:http'

/**
 * Extract the agent API key from an incoming MCP HTTP request.
 *
 * The hosted server is multi-tenant: there is no ambient credential. Every
 * request carries its own `Authorization: Bearer sk_agent_*` token, which is
 * the agent's *identity* (see docs/architecture/06-hosted-mcp-connect-flow.md).
 * The token authorizes nothing on its own — every payment still requires an
 * edge signature the server never holds.
 *
 * Returns the raw token (no `Bearer ` prefix) or `null` if absent/malformed.
 */
export function extractBearerToken(req: Pick<IncomingMessage, 'headers'>): string | null {
  const header = req.headers['authorization'] ?? req.headers['Authorization' as 'authorization']
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  if (!match) return null
  const token = match[1].trim()
  return token.length > 0 ? token : null
}
