import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify'
import { createHash } from 'crypto'
import {
  AGENT_BY_API_KEY_SQL,
  LAST_SEEN_THROTTLE_SECONDS,
  findAgentAuthRowByApiKeyHash,
  touchAgentLastSeenRow,
  type Executor,
} from '../infra/repositories/agents.js'

// Re-exported for existing consumers (db-schema-smoke, tests): the query and
// its throttle constant moved into the agents repository (#999) so this
// middleware no longer reaches the pool directly.
export { AGENT_BY_API_KEY_SQL, LAST_SEEN_THROTTLE_SECONDS }

// ── Types ─────────────────────────────────────────────────────────

export interface AgentContext {
  id: string
  user_id: string
  name: string
  delegate_address: string
  safe_address: string
  chain_id: number
  status: string
  /** The account's execution rail (#821): 'delegation' routes to the new rail. */
  execution_rail?: string | null
  account_type?: string | null
  /** False when the agent's Safe row was removed; recovery must fail closed. */
  has_bound_safe?: boolean
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
 * Record that an agent just talked to Haven. Best-effort and throttled: the
 * write only happens if the agent hasn't been seen in the last
 * `LAST_SEEN_THROTTLE_SECONDS` (enforced in the repository's SQL), and any
 * failure is swallowed — liveness tracking must never break or slow an
 * authenticated request.
 *
 * Exported for testing; called fire-and-forget from the middleware. The SQL
 * lives in `infra/repositories/agents.ts` (#999); omitting `db` uses the pool.
 */
export async function touchAgentLastSeen(agentId: string, db?: QueryableLike): Promise<void> {
  try {
    if (db === undefined) await touchAgentLastSeenRow(agentId)
    else await touchAgentLastSeenRow(agentId, db as unknown as Executor)
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
export function registerAgentLastSeenHook(app: FastifyInstance, db?: QueryableLike): void {
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
  const row = await findAgentAuthRowByApiKeyHash(
    createHash('sha256').update(apiKey).digest('hex'),
  )

  if (row === null) {
    return reply.code(401).send({ error: 'Invalid or revoked API key' })
  }

  // #1130: pending_approval is the NORMAL starting state for every connect-
  // modal agent (the key is issued at /register; activation happens at the
  // first budget grant) — a valid key must not read as "invalid or revoked".
  // Named branch BEFORE the allow-list rejection, mirroring `paused` below;
  // it never authenticates the request.
  if (row.status === 'pending_approval') {
    return reply.code(403).send({
      error: 'agent_pending_approval',
      detail:
        'This agent is waiting for its first budget approval. Open Haven and complete the ' +
        'budget grant for this agent — its API key starts working the moment the budget is active.',
    })
  }

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

  // `safe_address` intentionally falls back to the user's legacy mirror for
  // older agent endpoints. That fallback is unsafe for recovery after an
  // account unlink: the mirror may now point at a different wallet. Keep the
  // agent authenticated only when its original Safe binding still exists;
  // callers can reconnect or rebind through the supported account flow.
  if (row.has_bound_safe === false) {
    return reply.code(403).send({ error: 'Agent is no longer linked to a Haven wallet' })
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
    execution_rail: row.execution_rail ?? null,
    account_type: row.account_type ?? null,
    // Characterization fakes from before this field existed omit it; the
    // real query always returns a boolean. Treat an omitted value as bound so
    // those fakes keep exercising the legacy auth branches.
    has_bound_safe: row.has_bound_safe ?? true,
  }
}
