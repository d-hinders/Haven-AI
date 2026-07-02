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
import pool from '../db.js'
import { agentAuthMiddleware } from '../middleware/agentAuth.js'
import type { CatalogRow } from '../lib/merchant-catalog.js'

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

  // GET /catalog — list entries, optionally filtered by category/rail.
  app.get<{ Querystring: { category?: string; rail?: string } }>(
    '/',
    async (request, reply) => {
      const { category, rail } = request.query

      if (rail !== undefined && !VALID_RAILS.has(rail)) {
        return reply.code(400).send({ error: `Invalid rail: ${rail}` })
      }

      const conditions = [`status != 'delisted'`]
      const values: string[] = []
      if (category) {
        values.push(category)
        conditions.push(`category = $${values.length}`)
      }
      if (rail) {
        values.push(rail)
        conditions.push(`rail = $${values.length}`)
      }

      const result = await pool.query<CatalogRow>(
        `SELECT * FROM merchant_catalog
         WHERE ${conditions.join(' AND ')}
         ORDER BY status = 'active' DESC, category ASC, name ASC`,
        values,
      )

      return { entries: result.rows.map(serialize) }
    },
  )

  // GET /catalog/:id — single entry detail.
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const result = await pool.query<CatalogRow>(
      `SELECT * FROM merchant_catalog WHERE id = $1 AND status != 'delisted' LIMIT 1`,
      [request.params.id],
    )
    const row = result.rows[0]
    if (!row) {
      return reply.code(404).send({ error: 'Catalog entry not found' })
    }
    return serialize(row)
  })
}
