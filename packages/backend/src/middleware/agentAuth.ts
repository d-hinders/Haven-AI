import { FastifyRequest, FastifyReply } from 'fastify'
import pool from '../db.js'

// ── Types ─────────────────────────────────────────────────────────

export interface AgentContext {
  id: string
  user_id: string
  name: string
  delegate_address: string
  safe_address: string
}

// Extend Fastify request
declare module 'fastify' {
  interface FastifyRequest {
    agent?: AgentContext
  }
}

// ── Middleware ─────────────────────────────────────────────────────

/**
 * Authenticate requests using agent API keys (sk_agent_xxx).
 *
 * Accepts the key from:
 *   - Authorization: Bearer sk_agent_xxx
 *   - X-API-Key: sk_agent_xxx
 *
 * On success, decorates request.agent with the agent context
 * (including the owning user's safe_address via JOIN).
 */
export async function agentAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Extract API key from header
  let apiKey: string | null = null

  const authHeader = request.headers.authorization
  if (authHeader?.startsWith('Bearer sk_agent_')) {
    apiKey = authHeader.slice(7) // strip "Bearer "
  }

  if (!apiKey) {
    const xApiKey = request.headers['x-api-key']
    if (typeof xApiKey === 'string' && xApiKey.startsWith('sk_agent_')) {
      apiKey = xApiKey
    }
  }

  if (!apiKey) {
    return reply.code(401).send({ error: 'Missing or invalid API key' })
  }

  // Look up agent + its linked Safe address (multi-Safe via user_safes)
  const result = await pool.query<{
    id: string
    user_id: string
    name: string
    delegate_address: string | null
    safe_address: string | null
  }>(
    `SELECT a.id, a.user_id, a.name, a.delegate_address,
            COALESCE(us.safe_address, u.safe_address) as safe_address
     FROM agents a
     JOIN users u ON a.user_id = u.id
     LEFT JOIN user_safes us ON a.safe_id = us.id
     WHERE a.api_key = $1 AND a.status = 'active'`,
    [apiKey],
  )

  if (result.rows.length === 0) {
    return reply.code(401).send({ error: 'Invalid or revoked API key' })
  }

  const row = result.rows[0]

  if (!row.delegate_address) {
    return reply.code(403).send({ error: 'Agent has no delegate address configured' })
  }

  if (!row.safe_address) {
    return reply.code(403).send({ error: 'No Safe deployed for this account' })
  }

  request.agent = {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    delegate_address: row.delegate_address,
    safe_address: row.safe_address,
  }
}
