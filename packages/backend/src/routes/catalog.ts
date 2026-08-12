/**
 * Merchant catalog — read-only discovery surface (#348).
 *
 * One source of truth consumed by two clients with the same response shape:
 *   - the dashboard catalog page (JWT auth)
 *   - the `haven_discover_tools` MCP tool via the SDK (agent API key auth)
 *
 * Strictly read-only: nothing here creates payments, signatures, or any
 * state change. Curation is operator-side (migrations/scripts); there is no
 * self-service submission in this slice.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
// dep-lint-exempt: the public listing assembles its WHERE at runtime from optional category/rail filters (no fixed statement to PREPARE); read-only discovery surface, extraction deferred with the catalog module's under #999
import pool from '../db.js'
import { agentAuthMiddleware } from '../middleware/agentAuth.js'
import type { CatalogRow } from '../modules/catalog/index.js'

const VALID_RAILS = new Set(['x402', 'mpp'])

/**
 * Accept either an agent API key or a dashboard JWT. Agent keys are
 * recognizable by prefix, so requests carrying one are routed through the
 * full agent auth (which also feeds liveness + audit hooks); everything else
 * falls back to JWT verification.
 */
async function eitherAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization
  const xApiKey = request.headers['x-api-key']
  const hasAgentKey =
    authHeader?.startsWith('Bearer sk_agent_') ||
    (typeof xApiKey === 'string' && xApiKey.startsWith('sk_agent_'))

  // The `sk_agent_` prefix only ROUTES to the agent middleware — it is not a
  // trust decision. agentAuthMiddleware then does a full SHA-256 hash lookup
  // (WHERE api_key_hash = $1) plus a status allow-list, so a forged prefix
  // routes straight into verification and fails at the DB. No prefix-match
  // bypass exists.
  if (hasAgentKey) {
    return agentAuthMiddleware(request, reply)
  }
  try {
    await request.jwtVerify()
  } catch {
    reply.code(401).send({ error: 'Unauthorized' })
  }
}

function serialize(row: CatalogRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    resource_url: row.resource_url,
    rail: row.rail,
    protocol: row.protocol,
    tool_name: row.tool_name,
    tool_arguments: row.tool_arguments,
    price_display: row.price_display,
    price_atomic: row.price_atomic,
    asset: row.asset,
    network: row.network,
    asset_transfer_methods: row.asset_transfer_methods,
    status: row.status,
    verified_at: row.verified_at,
  }
}

export default async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', eitherAuth)

  // GET /catalog — list entries, optionally filtered by category/rail/search.
  app.get<{ Querystring: { category?: string; rail?: string; search?: string } }>(
    '/',
    async (request, reply) => {
      const { category, rail, search } = request.query

      if (rail !== undefined && !VALID_RAILS.has(rail)) {
        return reply.code(400).send({ error: `Invalid rail: ${rail}` })
      }

      // Search is deliberately bounded and normalized at the route boundary.
      // This keeps the read-only discovery contract predictable for both the
      // dashboard and agent clients, while the SQL below remains parameterized.
      if (search !== undefined && typeof search !== 'string') {
        return reply.code(400).send({ error: 'Search must be a single string' })
      }
      const normalizedSearch =
        typeof search === 'string' ? search.trim().replace(/\s+/g, ' ') : undefined
      if (search !== undefined && !normalizedSearch) {
        return reply.code(400).send({ error: 'Search must not be empty' })
      }
      if (normalizedSearch && normalizedSearch.length > 120) {
        return reply.code(400).send({ error: 'Search must be 120 characters or fewer' })
      }

      const conditions = [`status != 'delisted'`]
      const values: string[] = []
      if (category !== undefined && typeof category !== 'string') {
        return reply.code(400).send({ error: 'Category must be a single string' })
      }
      const normalizedCategory = typeof category === 'string' ? category.trim() : undefined
      if (normalizedCategory) {
        values.push(normalizedCategory)
        conditions.push(`LOWER(TRIM(category)) = LOWER(TRIM($${values.length}))`)
      }
      if (rail) {
        values.push(rail)
        conditions.push(`rail = $${values.length}`)
      }
      if (normalizedSearch) {
        values.push(normalizedSearch)
        conditions.push(
          `(name ILIKE '%' || $${values.length} || '%' OR ` +
            `description ILIKE '%' || $${values.length} || '%' OR ` +
            `category ILIKE '%' || $${values.length} || '%')`,
        )
      }
      if (request.agent) {
        values.push(`eip155:${request.agent.chain_id}`)
        conditions.push(`network = $${values.length}`)
      }

      const result = await pool.query<CatalogRow>(
        `SELECT * FROM merchant_catalog
         WHERE ${conditions.join(' AND ')}
         ORDER BY status = 'active' DESC, category ASC, name ASC, id ASC`,
        values,
      )

      return { entries: result.rows.map(serialize) }
    },
  )

  // GET /catalog/:id — single entry detail.
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const conditions = [`id = $1`, `status != 'delisted'`]
    const values = [request.params.id]
    if (request.agent) {
      values.push(`eip155:${request.agent.chain_id}`)
      conditions.push(`network = $${values.length}`)
    }
    const result = await pool.query<CatalogRow>(
      `SELECT * FROM merchant_catalog WHERE ${conditions.join(' AND ')} LIMIT 1`,
      values,
    )
    const row = result.rows[0]
    if (!row) {
      return reply.code(404).send({ error: 'Catalog entry not found' })
    }
    return serialize(row)
  })
}
