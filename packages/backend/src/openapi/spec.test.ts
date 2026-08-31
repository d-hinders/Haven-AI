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
// #1705: the settlement-scheme contract is asserted against real payloads, not
// only against its own description (#1446 discipline).
import { matchSpec } from './response-shape.js'
import {
  AgentPaymentNextAction,
  AgentPaymentPhase,
  AgentPaymentRail,
} from '../domain/agent-payment-taxonomy.js'
// #2105: the retired-rail guard at the bottom of this file asserts the spec
// against the HANDLER's real return value, not against its own description.
import { handleSend } from '../modules/mpp/send.js'
// #2295: the human-decimal `allowance_amount` shape is asserted against the
// function that PRODUCES it, not against the schema's own description.
import { formatTokenValue } from '../domain/tokens.js'
import type { AgentContext } from '../middleware/agentAuth.js'

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

  it('documents allowance input constraints for connect-setup agent rules', () => {
    // #2020: POST /agents no longer accepts allowance rows (the field is
    // pinned empty-only below), so the constraints apply only to the
    // connect-setup input, which still carries the requested budgets that
    // become the delegation grant.
    const setupAllowance =
      openapiSpec.components.schemas.AgentConnectionAllowanceInput

    expect(setupAllowance.properties.token_symbol).toMatchObject({
      minLength: 1,
      maxLength: 20,
    })
    expect(setupAllowance.properties.allowance_amount).toMatchObject({
      type: 'string',
      pattern: '^[0-9]+$',
    })
    expect(setupAllowance.properties.reset_period_min).toMatchObject({
      minimum: 0,
      maximum: 65535,
    })
  })

  /**
   * #2295: `allowance_amount` carries two incompatible wire shapes under one
   * field name. The contract's job is to make them distinguishable WITHOUT
   * reading the route that builds them, so these assertions run against the
   * spec plus the real producer — never against prose.
   *
   * `formatTokenValue` is the producer: `rails/delegation-budget-view.ts`
   * builds every human-decimal `allowance_amount` with it. Flip that view to
   * emit atomic without repointing the schema and the third case below fails.
   */
  describe('the two allowance_amount wire shapes are named apart (#2295)', () => {
    const atomicSchema = openapiSpec.components.schemas.AgentConnectionAllowanceInput.properties.allowance_amount
    const humanSchema = openapiSpec.components.schemas.AgentAllowance.properties.allowance_amount

    it('gives each shape its own pattern, so neither is a bare string', () => {
      expect(atomicSchema.pattern).toBe('^[0-9]+$')
      expect(humanSchema.pattern).toBe('^[0-9]+(\\.[0-9]+)?$')
      expect(humanSchema.pattern).not.toBe(atomicSchema.pattern)
      // The description has to say which unit, or the pattern alone leaves
      // `'250'` ambiguous between 250 USDC and 0.00025 USDC.
      expect(atomicSchema.description).toMatch(/ATOMIC/)
      expect(humanSchema.description).toMatch(/HUMAN-DECIMAL/)
    })

    it('rejects the atomic shape from the human-decimal field and vice versa', () => {
      // The discriminating value: a decimal string is legal human, illegal atomic.
      expect(new RegExp(humanSchema.pattern).test('250.000000')).toBe(true)
      expect(new RegExp(atomicSchema.pattern).test('250.000000')).toBe(false)
      // `BigInt('250.000000')` throwing is exactly how #2283 discriminated;
      // the contract now says it without an exception.
      expect(() => BigInt('250.000000')).toThrow()
    })

    it('validates what rails/delegation-budget-view.ts actually emits', () => {
      const human = new RegExp(humanSchema.pattern)
      const atomic = new RegExp(atomicSchema.pattern)
      // Every case the projection can produce: USDC (6), sub-cent USDC, ETH
      // (18) / the unlisted-token fallback, and the zero budget.
      //
      // Note what these values are NOT. #2283 and #2295 both quote
      // `'250.000000'`, and `packages/frontend/e2e/fixtures/haven-api.ts`
      // hard-codes it — but `formatTokenValue` trims trailing zeros to a
      // two-digit minimum before capping at six, so it cannot emit that
      // string for a whole-token budget. The SHAPE in those reports is right
      // and the DIGITS are a hand-written fixture; pinning the real output
      // here is what keeps this test measuring the producer.
      const produced = [
        formatTokenValue('250000000', 6),
        formatTokenValue('1', 6),
        formatTokenValue('5000000000000000000', 18),
        formatTokenValue('0', 6),
      ]
      expect(produced).toEqual(['250.00', '0.000001', '5.00', '0'])
      // The fixture form is still a legal human amount — a consumer must
      // accept it even though this producer does not emit it.
      expect(human.test('250.000000')).toBe(true)
      for (const value of produced) {
        expect(human.test(value)).toBe(true)
      }
      // '0' is the one value both shapes agree on; every other produced value
      // must be rejected by the atomic pattern, or the two schemas do not in
      // fact separate the shapes.
      expect(produced.filter((v) => atomic.test(v))).toEqual(['0'])
    })

    it('keeps the delegation projection wired to formatTokenValue', async () => {
      // A literal guard on the producer: if this call moves or is replaced,
      // the case above stops testing the real emitter and would pass on a
      // shape the routes no longer return.
      const source = await readFile(
        join(import.meta.dirname, '../rails/delegation-budget-view.ts'),
        'utf8',
      )
      expect(source).toContain('allowance_amount: formatTokenValue(row.budget_atomic, decimals)')
    })

    it('names the human shape on GET /machine-payments/allowances too (#2295)', () => {
      // Same value, same producer, renamed on the wire — and it sits one key
      // above the ATOMIC `onchain.amount`, so leaving it bare recreated the
      // identical ambiguity one field over.
      const summary = openapiSpec.components.schemas.AllowanceSummary
      const row = summary.properties.allowances.items.properties
      expect(row.configured_amount.pattern).toBe(humanSchema.pattern)
      expect(row.onchain.properties.amount.description).toMatch(/ATOMIC/)
    })
  })

  it('pins the retired POST /agents allowances field to empty-only (#2020)', () => {
    const allowances = openapiSpec.components.schemas.CreateAgentRequest.properties.allowances
    expect(allowances.maxItems).toBe(0)
    // The tombstoned CRUD operations answer 410, never 200.
    const setOp = openapiSpec.paths['/agents/{id}/allowances'].post
    const deleteOp = openapiSpec.paths['/agents/{id}/allowances/{tokenAddress}'].delete
    expect(Object.keys(setOp.responses)).toContain('410')
    expect(Object.keys(setOp.responses)).not.toContain('200')
    expect(Object.keys(deleteOp.responses)).toContain('410')
    expect(Object.keys(deleteOp.responses)).not.toContain('200')
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

/**
 * #1705 (epic #1704). The settlement scheme on the transaction wire contract.
 *
 * Asserted against REAL payload shapes through `matchSpec`, not only against
 * the schema's own description — the #1446 lesson: five spec bugs shipped
 * because a field was only ever checked by restating it. Every case below
 * hands a transaction row to the spec's own `TransactionBase` schema and lets
 * it decide.
 */
describe('TransactionBase settlementScheme (#1705)', () => {
  const TRANSACTION_BASE = { $ref: '#/components/schemas/TransactionBase' }

  /**
   * The spec is a `const` literal, so asking whether a property is ABSENT is a
   * compile error rather than an assertion. Widen for the negative checks only
   * — the positive ones keep their literal types.
   */
  const asProperties = (node: unknown) =>
    (node as { properties: Record<string, unknown> }).properties

  /** A minimal row carrying every required `TransactionBase` field. */
  function transactionRow(overrides: Record<string, unknown> = {}) {
    return {
      hash: '0x5ca67847000000000000000000000000000000000000000000000000000000ab',
      type: 'erc20',
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '1000000',
      valueFormatted: '1.00',
      asset: 'USDC',
      decimals: 6,
      direction: 'out',
      timestamp: 1755000000,
      blockNumber: 34567890,
      isError: false,
      ...overrides,
    }
  }

  it('declares the nullable three-value enum, camelCase like its neighbours', () => {
    const properties = openapiSpec.components.schemas.TransactionBase.properties

    expect(properties.settlementScheme).toMatchObject({
      type: ['string', 'null'],
      enum: ['eip3009', 'erc7710', null],
    })
    // Optional, never required: the field is absent on rows that predate it.
    expect(openapiSpec.components.schemas.TransactionBase.required).not.toContain(
      'settlementScheme',
    )
    // snake_case here would be a wire-contract break — the sibling enrichment
    // fields (`valueFormatted`, `x402ResourceUrl`, `paymentProofStatus`) are
    // all camelCase, and the frontend consumes this shape verbatim.
    expect(asProperties(openapiSpec.components.schemas.TransactionBase).settlement_scheme)
      .toBeUndefined()
  })

  it('keeps the three-way terminology split in the description', () => {
    const description =
      openapiSpec.components.schemas.TransactionBase.properties.settlementScheme.description

    expect(description).toMatch(/settlement/i)
    // Named as the neighbours it must NOT be collapsed into.
    expect(description).toMatch(/`source`/)
    expect(description).toMatch(/`execution_rail`/)
    // And the legacy-rail null asymmetry, recorded on purpose (epic #1704
    // review): a legacy row showing nothing is the contract, not a bug.
    expect(description).toMatch(/legacy/i)
    expect(description).toMatch(/null/i)
  })

  it('accepts both settlement schemes on a real transaction row', () => {
    expect(matchSpec(TRANSACTION_BASE, transactionRow({ settlementScheme: 'erc7710' }))).toEqual([])
    expect(matchSpec(TRANSACTION_BASE, transactionRow({ settlementScheme: 'eip3009' }))).toEqual([])
  })

  it('accepts null and absent — the legacy-rail asymmetry is in-contract', () => {
    // Legacy-rail x402 never stamps `settlement_scheme` (structurally 3009), and
    // non-machine transfers have no scheme at all. Null-in-null-out.
    expect(matchSpec(TRANSACTION_BASE, transactionRow({ settlementScheme: null }))).toEqual([])
    expect(matchSpec(TRANSACTION_BASE, transactionRow())).toEqual([])
  })

  it('rejects a value outside the enum', () => {
    // Near-misses a mapper could plausibly emit from the raw metadata.
    for (const bogus of ['eip-3009', 'ERC7710', 'erc7710 ', 'delegation', '']) {
      expect(
        matchSpec(TRANSACTION_BASE, transactionRow({ settlementScheme: bogus })),
        `expected '${bogus}' to be rejected by the spec's enum`,
      ).not.toEqual([])
    }
    // And the wrong type entirely.
    expect(matchSpec(TRANSACTION_BASE, transactionRow({ settlementScheme: 7710 }))).not.toEqual([])
  })

  it('the aggregated Transaction inherits it through the existing allOf', () => {
    const aggregated = openapiSpec.components.schemas.Transaction

    // The field is declared once, on the base — not restated on the aggregate.
    expect(aggregated.allOf[0]).toEqual({ $ref: '#/components/schemas/TransactionBase' })
    expect(asProperties(aggregated.allOf[1]).settlementScheme).toBeUndefined()

    // The base half of that composition is what carries the field, and it
    // validates a real aggregated row's scheme value. The composed schema is
    // NOT run through `matchSpec` here: the helper closes each component
    // schema it registers, so a `$ref`'d member inside an `allOf` rejects the
    // properties its siblings contribute (`safeId`, `chainId`, …) — the
    // documented composition trap in `response-shape.ts`, not a spec defect.
    expect(
      matchSpec(TRANSACTION_BASE, transactionRow({ settlementScheme: 'erc7710' })),
    ).toEqual([])
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

/**
 * #2105 (epic #1440). The published contract must not describe the retired
 * Safe / AllowanceModule rail as live.
 *
 * The failure this guards against is specific and was real: the spec
 * documented a `201 pending_signature` / `202 pending_approval` happy path for
 * `POST /machine-payments/send`, a route whose handler is three refusals and
 * nothing else, and did not document the 422 that actually happens. A
 * documented-but-unreachable 2xx is not cosmetic — it is an instruction to an
 * integrator to build a branch that can never run.
 *
 * The first block is the one that matters. It does NOT restate a description:
 * it CALLS `handleSend` with each rail state and asserts that the status it
 * really returns is a status the spec really documents. `handleSend` reads
 * only `execution_rail` and `chain_id` off its agent, so this needs no
 * database — the #1446 discipline (assert against the behaviour, not against
 * the prose that describes it) at zero cost.
 */
describe('retired-rail residue in the published contract (#2105)', () => {
  const sendResponses = openapiSpec.paths['/machine-payments/send'].post.responses
  const documentedSendCodes = Object.keys(sendResponses)

  const agentOnRail = (executionRail: string | null): AgentContext => ({
    id: '00000000-0000-4000-8000-000000000001',
    user_id: '00000000-0000-4000-8000-000000000002',
    name: 'guard',
    delegate_address: '0x' + '11'.repeat(20),
    safe_address: '0x' + '22'.repeat(20),
    chain_id: 8453,
    status: 'active',
    execution_rail: executionRail,
  })

  // `resolveExecutionRail` is exhaustively { delegation | retired_session |
  // retired_allowance }, and its fall-through means *anything* that is not the
  // two literals resolves to retired_allowance — including null, which is what
  // a missing Safe row yields. All four inputs below are therefore real
  // populations, not synthetic ones.
  const RAIL_CASES: Array<{ rail: string | null; expected: number; why: string }> = [
    { rail: 'session_key', expected: 410, why: 'session rail retired (#834)' },
    { rail: 'allowance_module', expected: 410, why: 'Safe rail retired (#1986)' },
    { rail: null, expected: 410, why: 'no Safe row falls through to retired_allowance' },
    { rail: 'delegation', expected: 422, why: 'MPP never supported the delegation rail (#1251)' },
  ]

  it.each(RAIL_CASES)(
    'POST /machine-payments/send really answers $expected on rail=$rail ($why), and the spec documents it',
    async ({ rail, expected }) => {
      const result = await handleSend(agentOnRail(rail), 'USDC', '0x' + '33'.repeat(20), '1.0', undefined)

      expect(result.statusCode).toBe(expected)
      expect(
        documentedSendCodes,
        `handleSend returns ${result.statusCode} for execution_rail=${String(rail)}, but the ` +
        `OpenAPI spec for POST /machine-payments/send documents only ` +
        `[${documentedSendCodes.join(', ')}]. Add the response, do not delete the assertion.`,
      ).toContain(String(result.statusCode))
    },
  )

  it('documents NO success response on POST /machine-payments/send — the handler has no success path', () => {
    // Positive control for the predicate itself: it must be able to SEE a 2xx.
    // POST /payments is the live sibling and genuinely has one, so if this
    // first expectation ever fails, the filter is broken and the second
    // expectation below is worthless rather than reassuring.
    const livePaymentCodes = Object.keys(openapiSpec.paths['/payments'].post.responses)
    const is2xx = (code: string) => /^2\d\d$/.test(code)
    expect(livePaymentCodes.filter(is2xx).length).toBeGreaterThan(0)

    expect(documentedSendCodes.filter(is2xx)).toEqual([])
    expect(documentedSendCodes).toContain('422')
  })

  it('documents no 202 approval branch on any payment entry point', () => {
    for (const path of ['/payments', '/x402/authorize', '/x402'] as const) {
      expect(
        Object.keys(openapiSpec.paths[path].post.responses),
        `${path} must not document a 202: no handler behind it emits one — the delegation rail ` +
        'enforces budget on-chain instead of queuing an approval.',
      ).not.toContain('202')
    }
  })

  it('has removed the approval schemas outright, leaving no dangling $ref', () => {
    const schemas = openapiSpec.components.schemas as Record<string, unknown>
    expect(schemas.PendingApproval).toBeUndefined()
    expect(schemas.X402PendingApproval).toBeUndefined()

    const refs: string[] = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return void node.forEach(walk)
      if (node === null || typeof node !== 'object') return
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') refs.push(value)
        else walk(value)
      }
    }
    walk(openapiSpec)

    // Positive control: the walker must actually be finding refs, and must be
    // finding a schema we know is still referenced. Without this, a walker that
    // silently collected nothing would report a clean bill of health.
    expect(refs.length).toBeGreaterThan(50)
    expect(refs).toContain('#/components/schemas/AgentPaymentStatus')

    const componentRefs = refs
      .filter((ref) => ref.startsWith('#/components/schemas/'))
      .map((ref) => ref.slice('#/components/schemas/'.length))
    expect(componentRefs).not.toContain('PendingApproval')
    expect(componentRefs).not.toContain('X402PendingApproval')

    // Every remaining component $ref must resolve. This is what turns the two
    // deletions above from "a string is absent" into "the document is intact".
    const unresolved = [...new Set(componentRefs)].filter((name) => !(name in schemas))
    expect(unresolved, 'Dangling $ref targets in openapiSpec.components.schemas').toEqual([])
  })

  it('names the delegation rail, not Safe module state, as the enforcement primitive', () => {
    const description = openapiSpec.components.securitySchemes.AgentApiKey.description
    // The three-way split must survive the rewrite ...
    expect(description).toMatch(/API auth is identity/i)
    expect(description).toMatch(/signature is authority/i)
    // ... while the primitive holding "enforcement" is the live one.
    expect(description).toMatch(/budget delegation/i)
    expect(description).not.toMatch(/Safe module state/i)
  })

  /**
   * #2105, found by haven-reviewer. The retired rail survived on the LIVE
   * rail's primary success response: `paymentSignData` — the `sign_data` of the
   * 201 of POST /payments, and of the x402 authorize 200/201 through
   * `X402SignablePayment` — required the `executeAllowanceTransfer` argument
   * list (`safe`/`payment_token`/`payment`/`nonce`), was
   * `additionalProperties: false`, and therefore FORBADE the
   * `signature_scheme` and `typed_data` the live handlers actually emit.
   *
   * Asserted against real emitted bodies through the spec's own validator, not
   * against the description — an integrator following the old schema would sign
   * a bare hash with raw ECDSA.
   */
  describe('sign_data describes the delegation rail, not executeAllowanceTransfer', () => {
    // Copied from the emitters: routes/payments.ts' 201 and
    // modules/x402/delegation-authorize.ts' funding shape.
    const directPaymentSignData = {
      hash: '0x' + 'ab'.repeat(32),
      signature_scheme: 'eip712_userop',
      typed_data: { domain: { chainId: 8453 }, types: {}, primaryType: 'UserOperation', message: {} },
      components: {
        account: '0x' + '44'.repeat(20),
        token: '0x' + '55'.repeat(20),
        to: '0x' + '66'.repeat(20),
        amount: '1000000',
      },
      instructions: 'Sign sign_data.typed_data with your delegate (agent) key using EIP-712.',
    }
    const x402FundingSignData = {
      ...directPaymentSignData,
      components: { safe: '0x' + '77'.repeat(20), ...directPaymentSignData.components },
    }

    const signDataSchema = openapiSpec.components.schemas.SignablePaymentIntent.properties.sign_data

    it.each([
      ['the direct-payment 201 shape', directPaymentSignData],
      ['the x402 funding shape (adds components.safe)', x402FundingSignData],
    ])('accepts %s', (_label, payload) => {
      expect(matchSpec(signDataSchema, payload)).toEqual([])
    })

    it('still REJECTS the retired AllowanceModule shape', () => {
      // Positive control for the validator: it must be able to say no. This is
      // the exact body the old schema demanded.
      const retired = {
        hash: '0x' + 'ab'.repeat(32),
        components: {
          safe: '0x' + '77'.repeat(20),
          token: '0x' + '55'.repeat(20),
          to: '0x' + '66'.repeat(20),
          amount: '1000000',
          payment_token: '0x' + '00'.repeat(20),
          payment: '0',
          nonce: 3,
        },
        instructions: 'Sign the hash with your delegate private key using raw ECDSA.',
      }
      expect(matchSpec(signDataSchema, retired).length).toBeGreaterThan(0)
    })

    it('rejects an UNDECLARED components field — the object is closed', () => {
      // Guards the `additionalProperties: false` above. It was `true` first;
      // nothing noticed when a mutation flipped it, because both real shapes
      // are fully declared. This is what makes the closure load-bearing.
      const withStrayField = {
        ...directPaymentSignData,
        components: { ...directPaymentSignData.components, nonce: 3 },
      }
      expect(matchSpec(signDataSchema, withStrayField).length).toBeGreaterThan(0)
    })

    it('names eip712_userop as the only scheme, and requires typed_data', () => {
      expect(signDataSchema.required).toContain('signature_scheme')
      expect(signDataSchema.required).toContain('typed_data')
      expect(signDataSchema.properties.signature_scheme.enum).toEqual(['eip712_userop'])
      // The retired argument list must not be back in the required set.
      const componentsRequired = signDataSchema.properties.components.required
      for (const gone of ['payment_token', 'payment', 'nonce', 'safe']) {
        expect(componentsRequired).not.toContain(gone)
      }
    })
  })

  it('#2262: publishes retirement prose for all five retired approval enum values', () => {
    // The path layer was swept clean (410 tombstones, "always 0 since #2055")
    // and the shared schema constants were not. Before this, a raw-API
    // integrator reading /openapi.json saw five approval values under the bare
    // description "Stable Haven agent payment state phase." — no signal that
    // nothing can produce them. The SDK user has been warned since #2101.
    const phase = openapiSpec.components.schemas.AgentPaymentPhase as {
      enum: string[]
      'x-enumDescriptions'?: Record<string, string>
    }
    const nextAction = openapiSpec.components.schemas.AgentPaymentNextAction as {
      enum: string[]
      'x-enumDescriptions'?: Record<string, string>
    }

    // Positive control: an empty or absent map must not read as a pass, and
    // the map must describe EVERY declared value, not only the retired five.
    expect(Object.keys(phase['x-enumDescriptions'] ?? {}).sort()).toEqual([...phase.enum].sort())
    expect(Object.keys(nextAction['x-enumDescriptions'] ?? {}).sort()).toEqual([...nextAction.enum].sort())

    const retired: Array<[Record<string, string>, string]> = [
      [phase['x-enumDescriptions']!, 'user_approval_required'],
      [phase['x-enumDescriptions']!, 'user_execution_required'],
      [phase['x-enumDescriptions']!, 'waiting_for_additional_approvals'],
      [nextAction['x-enumDescriptions']!, 'wait_for_user_approval'],
      [nextAction['x-enumDescriptions']!, 'wait_for_user_to_complete_payment'],
    ]
    expect(retired).toHaveLength(5)
    for (const [map, value] of retired) {
      expect(map[value], value).toMatch(/Retired wire value/)
      expect(map[value], value).toMatch(/no live rail produces it/)
      expect(map[value]!.toLowerCase(), value).toContain('stop and tell the user')
    }

    // Negative control: a live value must NOT be described as retired, so a
    // build that stamped the retirement string over the whole map is caught.
    expect(phase['x-enumDescriptions']!.payment_submitted).not.toMatch(/Retired wire value/)
    expect(nextAction['x-enumDescriptions']!.sign_and_submit_payment).not.toMatch(/Retired wire value/)
  })

  it("#2262: the activity union declares no 'approval' branch the route cannot emit", () => {
    // #2055 left agent-activity building its list from payment_intents + MCP
    // tool invocations and nothing else, so a documented `type: 'approval'`
    // member promised a response shape no handler can produce. #2120 deleted
    // the fabricated fixture for this reason; the schema was not touched then.
    for (const path of ['/agent-activity/{id}/activity', '/agent-activity/feed'] as const) {
      const spec = openapiSpec.paths[path as keyof typeof openapiSpec.paths] as Record<string, any>
      const json = JSON.stringify(spec)
      expect(json, `${path} still documents an approval activity row`).not.toContain('"approval"')
      // Positive control: the two branches the route CAN emit are still there,
      // so an assertion passing because the path vanished is caught.
      expect(json, `${path} lost its payment branch`).toContain('"payment"')
      expect(json, `${path} lost its tool-call branch`).toContain('"mcp_tool_call"')
    }
  })

  it('keeps AgentPaymentStatus.kind approval_request as a documented wire-compat value', () => {
    // The retained case, and deliberately asymmetric with the deletions above:
    // this enum value is still declared by the backend's own status type and
    // still serialized by a live route, so it stays — but it must carry a note
    // saying it is unreachable, or it reads as a branch worth writing.
    const kind = openapiSpec.components.schemas.AgentPaymentStatus.properties.kind
    expect(kind.enum).toContain('approval_request')
    expect(kind.description).toMatch(/wire compatibility/i)
    expect(kind.description).toMatch(/Do not write a branch on it/i)
  })
})
