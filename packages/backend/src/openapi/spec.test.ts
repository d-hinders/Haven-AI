import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import openapiRoutes from '../routes/openapi.js'
import { openapiSpec } from './spec.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
} from '../lib/agent-payment-taxonomy.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTES_DIR = join(__dirname, '..', 'routes')

/**
 * The route files that publish the agent payment surface. Adding a new route
 * file here must come with corresponding paths in `openapiSpec`. Adding a
 * new route handler inside one of these files must come with corresponding
 * paths in `openapiSpec`. The drift test below catches both cases.
 *
 * Auth, dashboard, balances, contacts, etc. are deliberately out of scope —
 * they are not part of the agent payment surface and not in the published
 * spec.
 */
const AGENT_PAYMENT_ROUTE_FILES: Array<{ file: string; prefix: string }> = [
  { file: 'agents.ts', prefix: '/agents' },
  { file: 'agent-connection-setups.ts', prefix: '/agent-connection-setups' },
  { file: 'payments.ts', prefix: '/payments' },
  { file: 'x402.ts', prefix: '/x402' },
  { file: 'machine-payments.ts', prefix: '/machine-payments' },
  { file: 'transactions.ts', prefix: '/transactions' },
]

/**
 * Routes declared in the above files that are intentionally NOT part of the
 * public agent payment surface and therefore not in `openapiSpec`. Each
 * entry needs an explicit `because:` justification — auditors and future
 * contributors must understand why a route exists but is undocumented.
 *
 * When a new route is added, it should EITHER be documented in
 * `openapi/spec.ts` OR added here with a clear reason. The default must be
 * "document it"; the allowlist exists for genuinely-internal routes.
 */
const KNOWN_UNDOCUMENTED_ROUTES: Array<{
  method: string
  path: string
  because: string
}> = [
  // ── agents.ts ──
  {
    method: 'PUT',
    path: '/agents/{id}',
    because:
      'Dashboard-only mutation that uses dashboard JWT auth, not the agent API key. ' +
      'Could be documented when the dashboard surface is folded into a separate dashboard spec.',
  },
  {
    method: 'DELETE',
    path: '/agents/{id}',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  {
    method: 'POST',
    path: '/agents/{id}/pause',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  {
    method: 'POST',
    path: '/agents/{id}/resume',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  {
    method: 'POST',
    path: '/agents/{id}/rotate-key',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  {
    method: 'DELETE',
    path: '/agents/{id}/allowances/{tokenAddress}',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  {
    method: 'POST',
    path: '/agents/{id}/allowances',
    because: 'Dashboard-only — see PUT /agents/{id}.',
  },
  // ── transactions.ts ──
  {
    method: 'GET',
    path: '/transactions/payment-intents/{paymentId}/evidence',
    because: 'Dashboard-only audit view using dashboard JWT auth.',
  },
  {
    method: 'GET',
    path: '/transactions/filters',
    because: 'Dashboard-only filter metadata using dashboard JWT auth.',
  },
  {
    method: 'GET',
    path: '/transactions/{safeAddress}',
    because: 'Dashboard-only per-Safe view using dashboard JWT auth.',
  },
]

function isKnownUndocumented(method: string, path: string): boolean {
  return KNOWN_UNDOCUMENTED_ROUTES.some(
    (entry) => entry.method === method && entry.path === path,
  )
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

/**
 * Extract Fastify route registrations from a route file's source text.
 *
 * Matches `<identifier>.<method>(<optional generic>)(<path>` for the standard
 * HTTP methods. The optional generic is consumed by `[^'"\`(]*` — anything
 * that is not a string quote or an opening paren — so nested type parameters
 * like `Record<K,V>` or multi-line `{\n  Body: ...\n}` work without a regex
 * brace-balancer. Quote-aware for single/double/backtick string literals.
 * Strips comments before matching so example snippets in JSDoc don't appear
 * as live registrations.
 */
function extractRoutes(source: string): Array<{ method: string; path: string }> {
  // Strip comments outside string literals so we don't (a) match example
  // routes inside JSDoc, (b) eat `://` inside a URL string literal.
  const noComments = stripCommentsOutsideStrings(source)
  const re = new RegExp(
    `\\b[A-Za-z_$][A-Za-z0-9_$]*\\.(${HTTP_METHODS.join('|')})[^'"\`(]*\\(\\s*(['"\`])([^'"\`]+)\\2`,
    'g',
  )
  const routes: Array<{ method: string; path: string }> = []
  let match: RegExpExecArray | null
  while ((match = re.exec(noComments)) !== null) {
    routes.push({ method: match[1].toUpperCase(), path: match[3] })
  }
  return routes
}

// Strip JS line and block comments from `source`, leaving content inside
// string literals untouched. A naive `source.replace(/\/\/[^\n]*/g, '')`
// would eat the rest of any line that contains `://` inside a URL string,
// dropping route registrations on that line. This walks the text
// character-by-character with a small state machine instead.
function stripCommentsOutsideStrings(source: string): string {
  let out = ''
  let i = 0
  // States: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template'
  let state: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code'
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line-comment'; i += 2; continue }
      if (c === '/' && next === '*') { state = 'block-comment'; i += 2; continue }
      if (c === "'") { state = 'single'; out += c; i++; continue }
      if (c === '"') { state = 'double'; out += c; i++; continue }
      if (c === '`') { state = 'template'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line-comment') {
      if (c === '\n') { state = 'code'; out += c; i++; continue }
      i++; continue
    }
    if (state === 'block-comment') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue }
      i++; continue
    }
    // Inside a string literal — preserve content as-is, honor backslash escapes.
    if (c === '\\' && i + 1 < source.length) {
      out += c + source[i + 1]; i += 2; continue
    }
    if (state === 'single' && c === "'") { state = 'code'; out += c; i++; continue }
    if (state === 'double' && c === '"') { state = 'code'; out += c; i++; continue }
    if (state === 'template' && c === '`') { state = 'code'; out += c; i++; continue }
    out += c; i++
  }
  return out
}

/**
 * Fastify path syntax `:id` → OpenAPI path syntax `{id}`. Both inside the
 * same path string.
 */
function fastifyPathToOpenApi(prefix: string, path: string): string {
  const full = (prefix + (path === '/' ? '' : path)).replace(/\/+/g, '/')
  return full.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
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
