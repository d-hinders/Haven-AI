/**
 * Merchant catalog — read-only discovery surface (#348).
 *
 * One source of truth consumed by two clients with the same response shape:
 *   - the dashboard catalog page (JWT auth)
 *   - the `haven_discover_tools` MCP tool via the SDK (agent API key auth)
 *
 * The listing merges two sources, each with an honest provenance label
 * (epic #1717, #1715):
 *   - operator-curated rows from `merchant_catalog` (`source: 'operator'`,
 *     no verification badges — the operator curates them, which is a
 *     different trust story from the directory's badges);
 *   - self-submitted entries that have passed domain-ownership proof AND the
 *     SSRF-hardened quote probe (`source: 'ingestion'`,
 *     `domain_verified`/`verified_payable` both true — exactly the badge
 *     claim the epic allows: "this merchant controls the domain and we
 *     watched this endpoint answer a real x402 quote").
 *
 * Strictly read-only: nothing here creates payments, signatures, or any
 * state change.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
// dep-lint-exempt: the public listing assembles its WHERE at runtime from optional category/rail filters (no fixed statement to PREPARE); read-only discovery surface, extraction deferred with the catalog module's under #999
import pool from '../db.js'
import { agentAuthMiddleware } from '../middleware/agentAuth.js'
import { authMiddleware } from '../middleware/auth.js'
import type { CatalogRow } from '../modules/catalog/index.js'
import {
  getCatalogSubmission,
  listVerifiedCatalogSubmissions,
  type VerifiedCatalogListingRow,
} from '../infra/repositories/catalog-submissions.js'

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
  // #1640: the shared middleware, not a second hand-rolled jwtVerify. This
  // route used to verify the token itself, which meant it silently missed the
  // purpose-claim refusal — a single-purpose token was still accepted here
  // after it had been locked out everywhere else. One JWT door, one guard.
  return authMiddleware(request, reply)
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
    source: 'operator' as const,
    domain_verified: false,
    verified_payable: false,
  }
}

/**
 * A self-submitted, ownership-proven, probe-verified entry as a catalog row.
 * Pointer-shaped by design: the probe stores no prices (epic #1717), so every
 * price field is null and the badge IS the payload.
 */
function serializeIngestion(row: VerifiedCatalogListingRow) {
  return {
    id: row.id,
    name: row.name ?? 'Payable service',
    description: row.description ?? '',
    category: 'api',
    resource_url: row.resource_url,
    rail: 'x402' as const,
    protocol: 'mcp' as const,
    tool_name: row.entrypoint,
    tool_arguments: null,
    price_display: null,
    price_atomic: null,
    asset: null,
    network: null,
    asset_transfer_methods: null,
    status: 'active' as const,
    verified_at: row.last_verified_at,
    source: 'ingestion' as const,
    domain_verified: true,
    verified_payable: true,
  }
}

/** One entry's provenance tag for the merged listing's ORDER BY. */
const SOURCE_RANK: Record<'operator' | 'ingestion', number> = {
  operator: 0,
  ingestion: 1,
}

type CatalogListingEntry = ReturnType<typeof serialize> | ReturnType<typeof serializeIngestion>

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

      const entries: CatalogListingEntry[] = result.rows.map(serialize)

      // Ingestion half (#1715): verified_payable self-submitted entries, same
      // read-only contract. Agents always filter by chain (network is null on
      // ingestion rows, so nothing they can pay shows here — what an agent can
      // do with the directory is #1716's question), and the same
      // category/rail/search filters apply. Appended after operator rows.
      if (!request.agent) {
        const ingestion = (await listVerifiedCatalogSubmissions())
          .filter((row) => {
            if (normalizedCategory && normalizedCategory.toLowerCase() !== 'api') return false
            if (rail !== undefined && rail !== 'x402') return false
            if (normalizedSearch) {
              const haystack = `${row.name ?? ''} ${row.description ?? ''}`.toLowerCase()
              if (!haystack.includes(normalizedSearch.toLowerCase())) return false
            }
            return true
          })
          .map(serializeIngestion)
        entries.push(...ingestion)
      }
      entries.sort(
        (a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || String(a.name).localeCompare(String(b.name)),
      )

      return { entries }
    },
  )

  // GET /catalog/:id — single entry detail (both sources).
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
    if (row) {
      return serialize(row)
    }
    const submission = await getCatalogSubmission(request.params.id)
    if (submission && submission.status === 'verified_payable' && !request.agent) {
      return serializeIngestion(submission)
    }
    return reply.code(404).send({ error: 'Catalog entry not found' })
  })
}
