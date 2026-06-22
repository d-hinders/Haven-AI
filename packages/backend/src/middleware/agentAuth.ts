import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import { createHash } from 'crypto'
import pool from '../db.js'

// ── Types ─────────────────────────────────────────────────────────

export interface AgentContext {
  id: string
  user_id: string
  name: string
  delegate_address: string
  safe_address: string
  chain_id: number
  status: string
}

// Extend Fastify request
declare module 'fastify' {
  interface FastifyRequest {
    agent?: AgentContext
  }
}

/** Minimal queryable surface — matches `db.ts` and a fake for tests. */
export interface QueryableLike {
  query: (text: string, values?: unknown[]) => Promise<unknown>
}

/**
 * How recently an agent must have been seen before we skip the write. The
 * dashboard's "last seen N ago" indicator doesn't need sub-throttle precision,
 * and this keeps a busy agent from writing on every single request.
 */
export const LAST_SEEN_THROTTLE_SECONDS = 10

/**
 * Record that an agent just talked to Haven. Best-effort and throttled: the
 * write only happens if the agent hasn't been seen in the last
 * `LAST_SEEN_THROTTLE_SECONDS`, and any failure is swallowed — liveness
 * tracking must never break or slow an authenticated request.
 *
 * Exported for testing; called fire-and-forget from the middleware.
 */
export async function touchAgentLastSeen(
  agentId: string,
  db: QueryableLike = pool as unknown as QueryableLike,
): Promise<void> {
  try {
    await db.query(
      `UPDATE agents
         SET last_seen_at = NOW()
       WHERE id = $1
         AND (last_seen_at IS NULL
              OR last_seen_at < NOW() - INTERVAL '${LAST_SEEN_THROTTLE_SECONDS} seconds')`,
      [agentId],
    )
  } catch {
    // Best-effort: the response has its own path; never surface this.
  }
}

/**
 * Register an `onResponse` hook that records agent liveness after each
 * request. It runs *after* the route handler so it never interleaves with the
 * handler's own queries, and it only fires when `agentAuthMiddleware` set
 * `request.agent`. Mirrors the agent-tool-audit hook's lifecycle.
 */
export function registerAgentLastSeenHook(
  app: FastifyInstance,
  db: QueryableLike = pool as unknown as QueryableLike,
): void {
  app.addHook('onResponse', async (request) => {
    const agent = request.agent
    if (!agent) return
    await touchAgentLastSeen(agent.id, db)
  })
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
    chain_id: number
    status: string
  }>(
    `SELECT a.id, a.user_id, a.name, a.delegate_address,
            a.status,
            COALESCE(us.safe_address, u.safe_address) as safe_address,
            COALESCE(us.chain_id, 8453) as chain_id
     FROM agents a
     JOIN users u ON a.user_id = u.id
     LEFT JOIN user_safes us ON a.safe_id = us.id
     WHERE a.api_key_hash = $1`,
    [createHash('sha256').update(apiKey).digest('hex')],
  )

  if (result.rows.length === 0) {
    return reply.code(401).send({ error: 'Invalid or revoked API key' })
  }

  const row = result.rows[0]

  // Positive allow-list: only 'active' and 'paused' agents are recognised;
  // everything else (including 'revoked' and any future status strings) is
  // rejected. Using an explicit allow-list prevents unknown future statuses
  // from silently authenticating as active agents.
  if (row.status === 'revoked' || (row.status !== 'active' && row.status !== 'paused')) {
    return reply.code(401).send({ error: 'Invalid or revoked API key' })
  }

  if (row.status === 'paused') {
    return reply.code(403).send({
      error: 'agent_paused',
      detail:
        'New API-initiated transactions are blocked until you resume this agent. On-chain delegate access and allowances are still in place.',
    })
  }

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
    chain_id: row.chain_id,
    status: row.status,
  }
}
