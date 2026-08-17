import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import openapiRoutes from '../routes/openapi.js'
import { openapiSpec } from './spec.js'
// #1443: the extractor and the allowlist moved to shared modules so the wider
// route-coverage gate reads the same ones instead of a second copy.
import { ROUTES_DIR, extractRoutes, fastifyPathToOpenApi } from './route-inventory.js'
import { KNOWN_UNDOCUMENTED_ROUTES } from './route-coverage.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
} from '../domain/agent-payment-taxonomy.js'

/**
 * The route files that publish the agent payment surface. Adding a new route
 * file here must come with corresponding paths in `openapiSpec`. Adding a
 * new route handler inside one of these files must come with corresponding
 * paths in `openapiSpec`. The drift test below catches both cases.
 *
 * Auth, dashboard, balances, contacts, etc. are deliberately out of scope —
 * they are not part of the agent payment surface and not in the published
 * spec.
 *
 * #1443: this list is no longer the whole story, and must not be read as it.
 * It scopes THIS test to the agent-payment surface on purpose; the repo-wide
 * property — every registered module is documented, justified or explicitly
 * deferred — lives in `route-coverage.test.ts`, which derives its scope from
 * the app's registration table so a new module cannot hide by not being listed.
 */
const AGENT_PAYMENT_ROUTE_FILES: Array<{ file: string; prefix: string }> = [
  { file: 'agents.ts', prefix: '/agents' },
  { file: 'agent-connection-setups.ts', prefix: '/agent-connection-setups' },
  { file: 'payments.ts', prefix: '/payments' },
  { file: 'x402.ts', prefix: '/x402' },
  { file: 'machine-payments.ts', prefix: '/machine-payments' },
  { file: 'transactions.ts', prefix: '/transactions' },
  { file: 'catalog.ts', prefix: '/catalog' },
]

function isKnownUndocumented(method: string, path: string): boolean {
  return KNOWN_UNDOCUMENTED_ROUTES.some(
    (entry) => entry.method === method && entry.path === path,
  )
}

describe('openapiSpec', () => {
  it('publishes an OpenAPI 3.1 document for the agent payment surface', () => {
    expect(openapiSpec.openapi).toBe('3.1.0')
    expect(openapiSpec.paths).toHaveProperty('/openapi.json')
    expect(openapiSpec.paths).toHaveProperty('/agents')
    expect(openapiSpec.paths).toHaveProperty('/agent-connection-setups')
    expect(openapiSpec.paths).toHaveProperty('/agent-connection-setups/resolve')
    expect(openapiSpec.paths).toHaveProperty('/agent-connection-setups/register')
    expect(openapiSpec.paths).toHaveProperty('/agent-connection-setups/{setupId}')
    expect(openapiSpec.paths).toHaveProperty('/agent-connection-setups/{setupId}/install-status')
    expect(openapiSpec.paths).toHaveProperty('/agent-connection-setups/{setupId}/cancel')
    expect(openapiSpec.paths).toHaveProperty('/agents/{id}')
    expect(openapiSpec.paths).toHaveProperty('/agents/{id}/revoke')
    expect(openapiSpec.paths).toHaveProperty('/payments')
    expect(openapiSpec.paths).toHaveProperty('/payments/{id}')
    expect(openapiSpec.paths).toHaveProperty('/payments/{id}/resume_state')
    expect(openapiSpec.paths).toHaveProperty('/x402/authorize')
    expect(openapiSpec.paths).toHaveProperty('/machine-payments/authorize')
    expect(openapiSpec.paths).toHaveProperty('/machine-payments/{id}/status')
    expect(openapiSpec.paths).toHaveProperty('/machine-payments/evidence')
    expect(openapiSpec.paths).toHaveProperty('/machine-payments/reconciliation-events')
    expect(openapiSpec.paths).toHaveProperty('/transactions')
  })

  it('keeps payment taxonomy enums in sync with backend exports', () => {
    expect(openapiSpec.components.schemas.AgentPaymentPhase.enum).toEqual(
      Object.values(AgentPaymentPhase),
    )
    expect(openapiSpec.components.schemas.AgentPaymentNextAction.enum).toEqual(
      Object.values(AgentPaymentNextAction),
    )
    expect(openapiSpec.components.schemas.AgentPaymentRail.enum).toEqual(
      Object.values(AgentPaymentRail),
    )
  })

  it('documents allowance input constraints for owner-created agent rules', () => {
    const createAgentAllowance =
      openapiSpec.components.schemas.CreateAgentRequest.properties.allowances.items
    const setupAllowance =
      openapiSpec.components.schemas.AgentConnectionAllowanceInput

    for (const schema of [createAgentAllowance, setupAllowance]) {
      expect(schema.properties.token_symbol).toMatchObject({
        minLength: 1,
        maxLength: 20,
      })
      expect(schema.properties.allowance_amount).toMatchObject({
        type: 'string',
        pattern: '^[0-9]+$',
      })
      expect(schema.properties.reset_period_min).toMatchObject({
        minimum: 0,
        maximum: 65535,
      })
    }
  })

  it('documents reconciliation event response statuses', () => {
    const responseSchema =
      openapiSpec.components.schemas.MachinePaymentReconciliationEventResponse

    expect(responseSchema.required).toContain('status')
    expect(responseSchema.properties.status).toMatchObject({
      type: 'string',
      enum: ['open', 'resolved'],
    })
  })

  it('documents catalog MCP product arguments for agent discovery', () => {
    const catalogEntry = openapiSpec.components.schemas.CatalogEntry

    expect(catalogEntry.properties.tool_arguments).toMatchObject({
      anyOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' },
      ],
    })
  })

  it('documents catalog discovery filters as read-only query parameters', () => {
    const catalogGet = openapiSpec.paths['/catalog'].get
    const searchParam = catalogGet.parameters?.find((param) => param.name === 'search')

    expect(catalogGet.description).toMatch(/case-insensitive/i)
    expect(catalogGet.description).toMatch(/search matches product name, description, or category/i)
    expect(catalogGet.description).toMatch(/blank search is rejected after trimming/i)
    expect(catalogGet.description).toMatch(/nothing here creates payments or signatures/i)
    expect(catalogGet.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'category', in: 'query', schema: { type: 'string' } }),
      expect.objectContaining({
        name: 'rail',
        in: 'query',
        schema: { type: 'string', enum: ['x402', 'mpp'] },
      }),
    ]))
    expect(searchParam).toMatchObject({
      in: 'query',
      description: expect.stringMatching(/Blank search after trimming returns 400/i),
      schema: expect.objectContaining({ type: 'string', minLength: 1, maxLength: 120 }),
    })
  })

  it('documents machine payment evidence proof statuses', () => {
    const receiptSchema = openapiSpec.components.schemas.MachinePaymentReceipt

    expect(receiptSchema.required).toContain('proof_status')
    expect(receiptSchema.properties.proof_status).toMatchObject({
      type: 'string',
      enum: ['payment_confirmed', 'merchant_response_observed', 'protocol_receipt_attached'],
    })
  })

  it('documents the non-custodial authority boundary in security schemes and resume state', () => {
    const agentScheme = openapiSpec.components.securitySchemes.AgentApiKey
    expect(agentScheme.description).toMatch(/identity/i)
    expect(agentScheme.description).toMatch(/signature is authority/i)
    expect(agentScheme.description).toMatch(/API keys alone cannot move funds/i)

    const resumeDescription =
      openapiSpec.paths['/payments/{id}/resume_state'].get.description
    expect(resumeDescription).toMatch(/context only/i)
    expect(resumeDescription).toMatch(/does not sign/i)
  })

  it('serves the exact spec at /openapi.json', async () => {
    const app = Fastify({ logger: false })
    await app.register(openapiRoutes)

    const response = await app.inject({
      method: 'GET',
      url: '/openapi.json',
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('max-age=300')
    expect(response.json()).toEqual(openapiSpec)

    await app.close()
  })
})

describe('extractRoutes', () => {
  // Regression coverage for the issues the route walker is supposed to catch.
  // Before these were added, bare `app.get('/path', h)` registrations and
  // routes with nested type generics were silently invisible to the drift
  // check.
  const cases: Array<{ src: string; expected: Array<{ method: string; path: string }> }> = [
    {
      src: `app.get('/', h)`,
      expected: [{ method: 'GET', path: '/' }],
    },
    {
      src: `app.post('/foo', h)`,
      expected: [{ method: 'POST', path: '/foo' }],
    },
    {
      src: `app.get<{ Params: { id: string } }>('/:id', h)`,
      expected: [{ method: 'GET', path: '/:id' }],
    },
    {
      // Nested generic — previous regex `[^>]*>?` consumed up to the inner
      // `>` and failed the trailing `(`.
      src: `app.put<{ Body: Record<string, T> }>('/x', h)`,
      expected: [{ method: 'PUT', path: '/x' }],
    },
    {
      // Multi-line typed generic.
      src: `app.get<{\n  Body: { a: number },\n}>('/multi', h)`,
      expected: [{ method: 'GET', path: '/multi' }],
    },
    {
      // `://` inside a string literal must not be treated as a line comment.
      src: `const u = 'https://example.com/api'; app.get('/p', h)`,
      expected: [{ method: 'GET', path: '/p' }],
    },
    {
      // Path with `//` is preserved.
      src: `app.get('/a//b', h)`,
      expected: [{ method: 'GET', path: '/a//b' }],
    },
    {
      // JSDoc example must NOT be extracted.
      src: `/**\n * Example: app.get('/draft', h)\n */\napp.get('/real', h)`,
      expected: [{ method: 'GET', path: '/real' }],
    },
    {
      // Inline comment after a route must not corrupt extraction.
      src: `app.get('/x', h) // todo: rename to /y`,
      expected: [{ method: 'GET', path: '/x' }],
    },
  ]

  for (const { src, expected } of cases) {
    it(`extracts ${JSON.stringify(expected)} from ${JSON.stringify(src.slice(0, 60))}`, () => {
      expect(extractRoutes(src)).toEqual(expected)
    })
  }
})

/**
 * Drift check — declared route vs published spec.
 *
 * The original `spec.test.ts` only asserted that an allowlist of required
 * paths exists in the spec. That catches the "removed from spec" case but
 * not the more dangerous case: "new route handler shipped without being
 * documented in the spec." A new payment-mutating route added to
 * `payments.ts` without a spec entry would be silently undocumented and
 * external integrators would never see it.
 *
 * This block reads each agent-payment route file as text, extracts every
 * `app.<method>('<path>'` declaration, and asserts the equivalent OpenAPI
 * path is in the spec. Failure prints which routes are missing.
 */
describe('openapi drift — declared routes vs published spec', () => {
  for (const { file, prefix } of AGENT_PAYMENT_ROUTE_FILES) {
    it(`every route declared in ${file} is documented in the OpenAPI spec`, async () => {
      const source = await readFile(join(ROUTES_DIR, file), 'utf8')
      const declared = extractRoutes(source)
      expect(declared.length).toBeGreaterThan(0)

      const undocumented: Array<{ method: string; path: string }> = []
      for (const route of declared) {
        const openapiPath = fastifyPathToOpenApi(prefix, route.path)
        const pathEntry = openapiSpec.paths[openapiPath as keyof typeof openapiSpec.paths]
        const documented = pathEntry && (
          (route.method === 'GET' && 'get' in pathEntry) ||
          (route.method === 'POST' && 'post' in pathEntry) ||
          (route.method === 'PUT' && 'put' in pathEntry) ||
          (route.method === 'PATCH' && 'patch' in pathEntry) ||
          (route.method === 'DELETE' && 'delete' in pathEntry)
        )
        if (documented) continue
        if (isKnownUndocumented(route.method, openapiPath)) continue
        undocumented.push({ method: route.method, path: openapiPath })
      }

      expect(
        undocumented,
        `Routes declared in ${file} but missing from openapiSpec.paths. ` +
        `Either document them in packages/backend/src/openapi/spec.ts or, ` +
        `if a route is intentionally not part of the public agent payment ` +
        `surface, move it to a separate route file.`,
      ).toEqual([])
    })
  }
})
