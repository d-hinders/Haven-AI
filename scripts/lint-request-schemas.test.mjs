// Self-test for the request-schema ratchet (#3029, epic #3028 slice 1).
//
// Two layers, because they prove different things:
//
//   unit   — the scanner's pure functions. A fixture route source, a fixture
//            index.ts and a fixture spec answer exactly what each resolves;
//            no process spawn, no repo dependency.
//   CLI    — the gate run AS A PROCESS over a fixture repo the test owns
//            (`scripts/test-support/guard-cli.mjs`, #2720's rule: only running
//            the script proves the guard — #2690/#2704 mutated two `main()`
//            refusals away and the suites stayed green). The fixture carries
//            its own `packages/backend/src/{index.ts,routes/*,openapi/spec.ts}`
//            and baseline, so the gate scans the FIXTURE, never the real repo;
//            `linkNodeModules` is what lets the fixture's `tsx` invocation
//            resolve, and the fixture's spec.ts is real TypeScript run by real
//            tsx — the same mechanism generate-api-types.mjs uses.
//
// The green-on-the-real-repo case is NOT here on purpose: CI runs
// `npm run lint:request-schemas` as its own step, the gate's scan is
// spec-version-coupled (a spec edit shifts which modules are shadowed), and a
// fixture pins the behaviour instead of drifting with the tree.
import { test, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runGuard } from './test-support/guard-cli.mjs'
import {
  fastifyPathToOpenApi,
  registeredRoutes,
  prefixesFromIndex,
  importNameFromIndex,
  enforcedModulesFromIndex,
  operationHasRequestConstraints,
  ownSchemaRoutes,
  typeofLines,
} from './lint-request-schemas.mjs'

const GATE = 'lint-request-schemas.mjs'
const ALSO = ['lib/ratchet.mjs']
const BASE = 'scripts/lint-request-schemas-baseline.json'

// ── The fixture repo ──────────────────────────────────────────────────────────
//
// Two route modules, both registered by the fixture index.ts:
//   probe.ts    — GET /items (spec'd: a typed query param) + POST /items
//                 (spec'd: a requestBody). Shadowed, and carrying two
//                 `typeof` guard lines: the slice-2 work waiting to happen.
//   contacts.ts — POST / (spec'd: a requestBody) but the module is ENFORCED
//                 via `enforcedModules` in the fixture index.ts, exactly as
//                 the real one is: the proof module. shadow: 0 by WIRING,
//                 which is what the mutation test below removes. The key is
//                 the route FILE since #3135 — a prefix could not express
//                 epic #3028's slice partition.

const INDEX = `import { installRequestValidation } from './openapi/request-validation.js'
import probeRoutes from './routes/probe.js'
import contactRoutes from './routes/contacts.js'
const app = { register: () => {}, setErrorHandler: () => {} }
installRequestValidation(app, {
  mode: 'shadow',
  enforcedModules: ['routes/contacts.ts'],
})
await app.register(probeRoutes, { prefix: '/probe' })
await app.register(contactRoutes, { prefix: '/contacts' })
`

const INDEX_WITHOUT_ENFORCED = INDEX.replace("  enforcedModules: ['routes/contacts.ts'],\n", '')

const SPEC = `export const openapiSpec = {
  openapi: '3.1.0',
  info: { title: 'fixture', version: '0.0.0' },
  paths: {
    '/probe/items': {
      get: {
        operationId: 'listItems',
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
        ],
        responses: { '200': { description: 'ok' } },
      },
      post: {
        operationId: 'createItem',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
    '/contacts': {
      post: {
        operationId: 'createContact',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
  },
}
`

const PROBE_TS = `import { FastifyInstance } from 'fastify'
export default async function probeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/items', async (request) => {
    const { limit } = request.query as { limit?: number }
    if (typeof limit !== 'undefined' && typeof limit !== 'number') {
      return { error: 'bad limit' }
    }
    return { items: [], limit: limit ?? 30 }
  })
  app.post('/items', async (request) => {
    const body = request.body as { name?: string }
    return { created: body.name ?? null }
  })
}
`

const CONTACTS_TS = `import { FastifyInstance } from 'fastify'
export default async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (request) => {
    const { name } = request.body as { name: string }
    if (!name || name.trim().length === 0) {
      return { error: 'Name is required' }
    }
    const duplicate = Object.assign(new Error('dup'), { code: '23505' })
    if (duplicate && typeof duplicate === 'object' && 'code' in duplicate) {
      return { error: 'duplicate' }
    }
    return { name }
  })
}
`

const BASELINE = JSON.stringify({
  'routes/probe.ts': { shadow: 1, typeof: 1 },
  'routes/contacts.ts': { shadow: 0, typeof: 1 },
})

function fixtureFiles({ index = INDEX } = {}) {
  return {
    // `"type": "module"`: without it the fixture has no package.json, tsx
    // transpiles spec.ts as CJS, and the named `openapiSpec` export hides
    // behind `default` — the gate then reads `undefined.paths` and every CLI
    // case fails for a packaging reason that is not the gate's. The real repo
    // root carries this field; the fixture must too.
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }) + '\n',
    'packages/backend/src/index.ts': index,
    'packages/backend/src/openapi/spec.ts': SPEC,
    'packages/backend/src/routes/probe.ts': PROBE_TS,
    'packages/backend/src/routes/contacts.ts': CONTACTS_TS,
    [BASE]: BASELINE,
  }
}

// ── Unit: the scanner's pure functions ───────────────────────────────────────

describe('fastifyPathToOpenApi (mirrors route-inventory.ts:118)', () => {
  it('maps :param to {param} and joins the prefix', () => {
    assert.equal(fastifyPathToOpenApi('/contacts', '/:id'), '/contacts/{id}')
    assert.equal(fastifyPathToOpenApi('/user/safes', '/:safeId/keys'), '/user/safes/{safeId}/keys')
  })

  it('collapses the root route: prefix-only and bare "/"', () => {
    assert.equal(fastifyPathToOpenApi('/contacts', '/'), '/contacts')
    assert.equal(fastifyPathToOpenApi('', '/'), '/')
  })

  it('collapses slash runs and normalizes the empty string to "/"', () => {
    assert.equal(fastifyPathToOpenApi('', ''), '/')
    assert.equal(fastifyPathToOpenApi('/a//', '//b'), '/a/b')
  })
})

describe('registeredRoutes', () => {
  it('reads the literal app.<method> forms, generics included, HEAD skipped', () => {
    const src = `
      app.get<{ Params: { id: string } }>('/:id', handler)
      app.post('/', handler)
      app.head('/', handler)
      app.delete('/:id', handler)
    `
    assert.deepEqual(registeredRoutes(src), [
      { method: 'get', path: '/:id' },
      { method: 'post', path: '/' },
      { method: 'delete', path: '/:id' },
    ])
  })

  it('ignores non-literal paths (a stated hole, not an oversight)', () => {
    const src = `app.get(somePath, handler)\napp.post('/x', handler)`
    assert.deepEqual(registeredRoutes(src), [{ method: 'post', path: '/x' }])
  })
})

describe('index.ts readers', () => {
  it('prefixesFromIndex: reads the registration prefix, twin mounts included', () => {
    const src = `
      await app.register(userSafesRoutes, { prefix: '/user/safes' })
      await app.register(userSafesRoutes, { prefix: '/user/accounts' })
      await app.register(otherRoutes, { prefix: '/elsewhere' })
    `
    assert.deepEqual(prefixesFromIndex(src, 'userSafesRoutes'), ['/user/safes', '/user/accounts'])
    // A bare registration mounts at the root (#3030: `accounting-webhooks.ts`
    // was invisible to the gauge for exactly this). Mutation: drop the bare
    // branch → [].
    assert.deepEqual(prefixesFromIndex("await app.register(webhookRoutes)\nawait app.register(other, { prefix: '/x' })", 'webhookRoutes'), [''])
    assert.deepEqual(prefixesFromIndex(src, 'missingRoutes'), [])
  })

  it('importNameFromIndex: binds the file to its import name', () => {
    const src = `import contactRoutes from './routes/contacts.js'`
    assert.equal(importNameFromIndex(src, 'contacts'), 'contactRoutes')
    assert.equal(importNameFromIndex(src, 'probe'), null)
  })

  it('enforcedModulesFromIndex: reads the install option; absent install = []', () => {
    assert.deepEqual(enforcedModulesFromIndex(INDEX), ['routes/contacts.ts'])
    assert.deepEqual(enforcedModulesFromIndex(INDEX_WITHOUT_ENFORCED), [])
    assert.deepEqual(enforcedModulesFromIndex('const app = 1'), [])
  })

  it('enforcedModulesFromIndex: reads the REAL index.ts, the rollout\u2019s state (#3135)', async () => {
    const { readFile } = await import('node:fs/promises')
    const real = await readFile(
      new URL('../packages/backend/src/index.ts', import.meta.url),
      'utf8',
    )
    // Exact FILE keys — the same strings the baseline uses. If this ever
    // reads a prefix again, the gate and the plugin have split. #3167 adds
    // two born-enforced label modules (epic #3028's forward direction);
    // #3164 adds the born-enforced organization module the same way.
    assert.deepEqual(enforcedModulesFromIndex(real), [
      'routes/contacts.ts',
      'routes/merchants.ts',
      'routes/labels.ts',
      'routes/agent-labels.ts',
      'routes/agent-organizations.ts',
      // Slice 2 (#3030): the 22 non-money modules and the inline index.ts pair.
      'index.ts',
      'routes/accounting.ts',
      'routes/accounting-feed.ts',
      'routes/accounting-connections.ts',
      'routes/accounting-webhooks.ts',
      'routes/agent-activity.ts',
      'routes/analytics.ts',
      'routes/analytics-overview.ts',
      'routes/auth.ts',
      'routes/balances.ts',
      'routes/catalog.ts',
      'routes/catalog-submissions.ts',
      'routes/dashboard.ts',
      'routes/discovery.ts',
      'routes/health.ts',
      'routes/openapi.ts',
      'routes/passkeys.ts',
      'routes/passport-verify.ts',
      'routes/portfolio.ts',
      'routes/safe-deploy.ts',
      'routes/transactions.ts',
      'routes/user.ts',
      'routes/user-accounts.ts',
      'routes/user-accounts-retired.ts',
      // Slice 3 (#3031): the FIRST money-path module, and the only one the
      // 2026-09-22 shadow reading proved conformant on every operation.
      'routes/x402.ts',
      // Slice 4 (#3032): the LAST five modules, and the default mode flips to
      // `enforce` — from this slice on the list is the per-module rollback.
      'routes/agents.ts',
      'routes/agent-rekey.ts',
      'routes/agent-connection-setups.ts',
      'routes/agent-passports.ts',
      'routes/hybrid-accounts.ts',
    ])
  })
})

describe('operationHasRequestConstraints', () => {
  it('true for a requestBody', () => {
    assert.equal(operationHasRequestConstraints({ requestBody: { content: {} } }), true)
  })

  it('true for a query or path parameter, false for header-only', () => {
    assert.equal(
      operationHasRequestConstraints({ parameters: [{ name: 'limit', in: 'query' }] }),
      true,
    )
    assert.equal(
      operationHasRequestConstraints({ parameters: [{ name: 'id', in: 'path' }] }),
      true,
    )
    assert.equal(
      operationHasRequestConstraints({ parameters: [{ name: 'X-Key', in: 'header' }] }),
      false,
    )
  })

  it('false for no operation, an empty one, or unrelated parameters', () => {
    assert.equal(operationHasRequestConstraints(null), false)
    assert.equal(operationHasRequestConstraints({}), false)
    assert.equal(operationHasRequestConstraints({ parameters: [{ name: 'x' }] }), false)
  })

  it("resolves a $ref'd parameter against components.parameters (#3135)", () => {
    // A $ref node carries no `in`, so before #3135 both this gate and the
    // plugin dropped it — and a $ref is how every AgentId/PaymentId/SetupId
    // path parameter in the real spec is written.
    const components = { AgentId: { name: 'id', in: 'path', schema: { type: 'string' } } }
    const operation = { parameters: [{ $ref: '#/components/parameters/AgentId' }] }
    assert.equal(operationHasRequestConstraints(operation, components), true)
    // Unresolvable, and with no component map at all: skipped, never thrown.
    assert.equal(operationHasRequestConstraints(operation, {}), false)
    assert.equal(operationHasRequestConstraints(operation), false)
  })
})

describe('ownSchemaRoutes (#3135)', () => {
  it('counts a route options object declaring its own `schema:`', () => {
    assert.equal(ownSchemaRoutes("app.post('/x', {\n  schema: { body: {} },\n}, handler)"), 1)
  })

  it('does NOT count a comment mentioning schema:', () => {
    // `payments.ts` carries exactly such a comment — the reason the slice-1
    // report could say "0 routes with a Fastify schema" while grep said 1.
    assert.equal(ownSchemaRoutes('// the route declares no schema: the plugin injects it'), 0)
    assert.equal(ownSchemaRoutes(' * schema: is injected by the plugin'), 0)
  })
})

describe('typeofLines', () => {
  it('ignores a comment inside the enforcedModules array, apostrophes included (#3030)', () => {
    const src = "installRequestValidation(app, {\n  enforcedModules: [\n    'routes/a.ts',\n    // the epic's fallback: don't read 'this'\n    /* nor 'this' */ 'routes/b.ts',\n  ],\n})"
    assert.deepEqual(enforcedModulesFromIndex(src), ['routes/a.ts', 'routes/b.ts'])
  })

  it('counts lines carrying a RUNTIME typeof — the metric the baseline stores (#3030)', () => {
    assert.equal(typeofLines("const a = typeof x\n// typeof in a comment\nconst b = 1\ndo(() => typeof y)"), 2)
    assert.equal(typeofLines('const clean = 1'), 0)
    // Request-check shapes the migration deletes: each is one line.
    assert.equal(typeofLines("if (typeof name !== 'string') return null\nconst raw = typeof body?.k === 'string' ? body.k : ''"), 2)
  })

  it('does not count a type position or a comment (#3030) — the three false positives the old gauge carried', () => {
    // Mutation: revert to `includes('typeof')` → every line below counts.
    assert.equal(typeofLines("export type Entry = ReturnType<typeof serialize> | ReturnType<typeof other>"), 0)
    assert.equal(typeofLines("type Status = ReturnType<typeof import('../x.js')['fn']>"), 0)
    assert.equal(typeofLines("type Keys = keyof typeof TABLE"), 0)
    assert.equal(typeofLines("/* typeof */\n * typeof in a doc block\n// typeof tail"), 0)
    assert.equal(typeofLines("const a = 1 // typeof in a trailing comment"), 0)
    // …and a runtime typeof on a line that ALSO has a type position still counts.
    assert.equal(typeofLines("const ok = typeof x === 'string' // ReturnType<typeof y>"), 1)
  })
})

// ── CLI: the gate as a process, over the fixture ─────────────────────────────

describe('CLI over an owned fixture (#2720: spawn the script)', () => {
  test('green when the tree matches the baseline', () => {
    const { status, out } = runGuard(GATE, {
      also: ALSO,
      linkNodeModules: true,
      files: fixtureFiles(),
    })
    assert.equal(status, 0, out)
    assert.match(
      out,
      /1 shadow module\(s\), 2 typeof line\(s\), 0 own-schema route\(s\), 0 unspecced route\(s\) across 2 file\(s\)/,
    )
    assert.match(out, /✓ request-validation rollout has not regressed/)
  })

  test('a regrown typeof ladder reddens, naming file and key', () => {
    const grown = PROBE_TS.replace("    return { items: [], limit: limit ?? 30 }", "    if (typeof limit === 'string') return { error: 'x' }\n    return { items: [], limit: limit ?? 30 }")
    const { status, out } = runGuard(GATE, {
      also: ALSO,
      linkNodeModules: true,
      files: {
        ...fixtureFiles(),
        'packages/backend/src/routes/probe.ts': grown,
      },
    })
    assert.equal(status, 1, out)
    assert.match(out, /routes\/probe\.ts \[typeof\]: baseline 1, now 2/)
  })

  test('MUTATION: removing enforcedModules re-enters the proof module in shadow and reddens', () => {
    // The gate's whole story about `routes/contacts.ts: shadow: 0` hangs on
    // the wiring in index.ts. This is the mutation the card requires: strip
    // the enforcedModules from the fixture install and the gate must go red
    // naming contacts — proving the scanner reads the wiring, not a constant.
    const { status, out } = runGuard(GATE, {
      also: ALSO,
      linkNodeModules: true,
      files: fixtureFiles({ index: INDEX_WITHOUT_ENFORCED }),
    })
    assert.equal(status, 1, out)
    assert.match(out, /routes\/contacts\.ts \[shadow\]: baseline 0, now 1/)
    assert.match(out, /must stay shadow: 0/)
  })

  test('--update refuses to raise the baseline and writes nothing', () => {
    const grown = PROBE_TS.replace("    return { items: [], limit: limit ?? 30 }", "    if (typeof limit === 'string') return { error: 'x' }\n    return { items: [], limit: limit ?? 30 }")
    const files = {
      ...fixtureFiles(),
      'packages/backend/src/routes/probe.ts': grown,
    }
    const { status, out, wrote } = runGuard(GATE, {
      also: ALSO,
      linkNodeModules: true,
      files,
      args: ['--update'],
      readBack: [BASE],
    })
    assert.equal(status, 1, out)
    assert.match(out, /--update refuses to RAISE the baseline/)
    assert.match(out, /routes\/probe\.ts \[typeof\]: 1 → 2/)
    assert.equal(wrote[BASE], BASELINE)
  })

  test('--update writes when the residue fell (a ladder deleted)', () => {
    const shrunk = PROBE_TS.replace("    if (typeof limit !== 'undefined' && typeof limit !== 'number') {\n      return { error: 'bad limit' }\n    }\n", '')
    const { status, out, wrote } = runGuard(GATE, {
      also: ALSO,
      linkNodeModules: true,
      files: {
        ...fixtureFiles(),
        'packages/backend/src/routes/probe.ts': shrunk,
      },
      args: ['--update'],
      readBack: [BASE],
    })
    assert.equal(status, 0, out)
    assert.match(out, /✓ baseline written/)
    const baseline = JSON.parse(wrote[BASE])
    assert.equal(baseline['routes/probe.ts'].typeof, 0)
    // The shadow flag stays: the module is still spec'd but not enforced.
    assert.equal(baseline['routes/probe.ts'].shadow, 1)
    // Deterministic serialization: files and keys sorted, newline-terminated.
    assert.equal(wrote[BASE], JSON.stringify(baseline, null, 2) + '\n')
  })
})
