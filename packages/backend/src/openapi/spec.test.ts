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
 * Matches `app.<method>('<path>'` and `fastify.<method>('<path>'` and
 * `<name>.<method>('<path>'`. Quote-aware for both single and double
 * quotes. Strips inline comments to avoid matching example-snippets in
 * comments.
 */
function extractRoutes(source: string): Array<{ method: string; path: string }> {
  const noLineComments = source.replace(/\/\/[^\n]*/g, '')
  const noBlockComments = noLineComments.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = new RegExp(
    `\\b[A-Za-z_$][A-Za-z0-9_$]*\\.(?:${HTTP_METHODS.join('|')})\\s*<[^>]*>?\\s*\\(\\s*(['"\`])([^'"\`]+)\\1`,
    'g',
  )
  const routes: Array<{ method: string; path: string }> = []
  let match: RegExpExecArray | null
  while ((match = re.exec(noBlockComments)) !== null) {
    // The first capture group is the quote character; the second is the path.
    // Extract method from the matched text.
    const methodMatch = /\.(get|post|put|patch|delete)\s*</.exec(match[0])
      ?? /\.(get|post|put|patch|delete)\s*\(/.exec(match[0])
    if (!methodMatch) continue
    routes.push({ method: methodMatch[1].toUpperCase(), path: match[2] })
  }
  return routes
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
