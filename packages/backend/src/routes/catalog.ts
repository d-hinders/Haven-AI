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
/**
 * Fields a caller with NO credential may see (#2530).
 *
 * The catalogue is a discovery surface by design (#1717) and answered 401,
 * which meant an agent could not find a payable merchant until after it had
 * been onboarded — the discovery surface required the thing it was supposed to
 * lead to. This exposes a reduced shape to unauthenticated callers.
 *
 * The list is an ALLOW-LIST and a test fails on any key outside it, so the
 * blast radius of this change is reviewable as a list rather than as prose.
 * Two things it deliberately leaves out even though they are non-sensitive:
 * the full `resource_url` (the public shape gives the HOST, which is enough to
 * know who the merchant is and not enough to be a copy-paste call target) and
 * the price/tool-invocation details. An agent that intends to PAY holds a
 * credential by then and gets the full shape; conservative is the right
 * default for a surface that has never been public before, and widening it
 * later is a smaller decision than narrowing it after the fact.
 *
 * There is no per-agent or per-user data in `merchant_catalog` to leak — every
 * column is merchant metadata — so this is a narrowing of an already
 * agent-agnostic row, not a redaction of someone's data. Stated because
 * "never per-agent data" is only a guarantee if somebody checked.
 */
const PUBLIC_CATALOG_FIELDS = [
  'id',
  'name',
  'description',
  'category',
  'rail',
  'protocol',
  'endpoint_host',
  'status',
  'verified_at',
  'source',
  'domain_verified',
  'verified_payable',
] as const

/** The host of a merchant endpoint, or null if it will not parse. */
export function endpointHost(resourceUrl: string | null | undefined): string | null {
  if (typeof resourceUrl !== 'string' || !resourceUrl) return null
  try {
    return new URL(resourceUrl).host || null
  } catch {
    return null
  }
}

/** Reduce a full listing to the public shape. Never widens: it picks. */
export function toPublicListing(entry: Record<string, unknown>): Record<string, unknown> {
  const host = endpointHost(entry.resource_url as string | null)
  const source: Record<string, unknown> = { ...entry, endpoint_host: host }
  const out: Record<string, unknown> = {}
  for (const field of PUBLIC_CATALOG_FIELDS) out[field] = source[field] ?? null
  return out
}

export { PUBLIC_CATALOG_FIELDS }

/**
 * #2530: `GET /catalog` is readable WITHOUT a credential, in the reduced shape
 * above. Every other catalogue route still requires one.
 *
 * A caller that presents a credential is still verified — a bad or revoked key
 * gets its 401 rather than a silent downgrade to the public shape, because
 * silently serving a reduced answer to a revoked agent hides the revocation
 * from the only party who would notice.
 */
function isPublicCatalogRead(request: FastifyRequest): boolean {
  if (request.method !== 'GET') return false
  const path = request.routeOptions?.url ?? request.url.split('?')[0]
  if (path !== '/' && path !== '/catalog' && path !== '/catalog/') return false
  const authHeader = request.headers.authorization
  const xApiKey = request.headers['x-api-key']
  return !authHeader && typeof xApiKey !== 'string'
}

async function eitherAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (isPublicCatalogRead(request)) return
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
      const isPublic = isPublicCatalogRead(request)

      // Ingestion half (#1715, epic #1717): verified_payable self-submitted
      // entries, same read-only contract, for BOTH clients. Agents get them
      // too — an x402 endpoint is self-describing about scheme/chain at pay
      // time, so the directory entry is discoverable on any chain and the
      // payment step negotiates. The agent chain filter applies only to the
      // operator-curated half (which carries an explicit `network`); category,
      // rail and search filters apply to both halves.
      {
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

      // #2530: an unauthenticated caller gets the reduced public shape. The
      // reduction happens HERE, at the response boundary, rather than in the
      // query — so the filtering, sorting and ingestion-merge logic above has
      // exactly one behaviour to reason about, and the public shape can never
      // be a differently-assembled list that drifts from the real one.
      if (isPublic) {
        return { entries: entries.map((entry) => toPublicListing(entry as unknown as Record<string, unknown>)) }
      }

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
