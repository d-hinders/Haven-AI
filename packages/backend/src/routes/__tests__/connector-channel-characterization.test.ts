import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

/**
 * CHARACTERIZATION of the connector handout's PRODUCTION default (#2422).
 *
 * `routes/agent-connection-setups.ts` is on the money-path perimeter
 * (`.github/money-path-globs.json`, added by #2264), so existing behaviour is
 * pinned before it is changed.
 *
 * These assertions pin the LITERAL `@haven_ai/connect@alpha`, and that is the
 * entire point of the file. The pre-existing suite asserts
 * ``toContain(`npx -y ${CONNECTOR_PACKAGE}`)`` — an assertion that FOLLOWS the
 * constant wherever it goes and stays green if the default channel silently
 * became `dev`, `beta`, or the empty string. Production never sets
 * `HAVEN_CONNECTOR_CHANNEL`, so the default IS the production blast radius of
 * #2422, and it needs a test that cannot move with it.
 *
 * Mutation-proved: setting the default to `dev` reddens both cases here.
 *
 * If this file ever has to be edited to make CI green, that is the signal to
 * stop — something changed what a production dashboard hands a real user.
 */

// db-mock-exempt: nothing here is database behaviour. The subject is which npm
// dist-tag the route interpolates into two strings, and each case must build a
// FRESH module graph (vi.resetModules) because the value is read from the
// environment at import — neither of which a real-Postgres repository test can
// express. The db.js mock exists only to keep the handler from touching a
// database at all; it answers two SQL fragments by content, never positionally
// (no mockResolvedValueOnce), so it carries none of the #1227 ordering
// fragility this ratchet exists to shrink. The real database behaviour of this
// route is owned by infra/repositories/__tests__/agent-connection-setups.test.ts
// on the real harness, and this change adds nothing to it.

const PRODUCTION_CONNECTOR_SPEC = '@haven_ai/connect@alpha'

/**
 * Every case here (re)builds the route's module graph through a dynamic
 * `import()` — that is the only way to observe a value the config module reads
 * at import time. Vitest's 5 s default is a graph-load budget, not a logic
 * budget, and it is the first thing to lose when the full backend suite runs
 * 228 files in parallel: these cases pass in ~1.6 s alone and time out under
 * contention. An explicit, generous budget keeps a red here meaning "the
 * handout is wrong", never "the machine was busy".
 */
const MODULE_GRAPH_TIMEOUT_MS = 60_000

const { mockQuery, mockConnect, mockClientQuery, mockClientRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockClientQuery: vi.fn(),
  mockClientRelease: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
  },
}))

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'user-1' }
  },
}))

vi.mock('../../modules/passport/index.js', () => ({
  requestPassport: async () => true,
  issuePassportBestEffort: async () => undefined,
  isPassportConfigured: () => true,
  PASSPORT_CHAIN_IDS: new Set([84532]),
}))

const SAFE = {
  id: 'safe-1',
  safe_address: '0x2222222222222222222222222222222222222222',
  name: 'Main Haven wallet',
  chain_id: 100,
}

const ALLOWANCE = {
  id: 'allowance-1',
  token_address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0',
  token_symbol: 'USDC.e',
  allowance_amount: '25000000',
  reset_period_min: 1440,
}

beforeEach(() => {
  mockQuery.mockReset()
  mockConnect.mockReset()
  mockClientQuery.mockReset()
  mockClientRelease.mockReset()
  mockClientQuery.mockResolvedValue({ rows: [] })
  mockConnect.mockResolvedValue({
    query: (...args: unknown[]) => mockClientQuery(...args),
    release: mockClientRelease,
  })
  mockQuery.mockImplementation(async (sql: unknown) => {
    if (/FROM user_safes/.test(String(sql))) return { rows: [SAFE] }
    if (/FROM agent_connection_setup_allowances/.test(String(sql))) return { rows: [ALLOWANCE] }
    return { rows: [] }
  })
  delete process.env.HAVEN_API_URL
  delete process.env.NEXT_PUBLIC_HAVEN_MCP_URL
  process.env.HAVEN_HOSTED_MCP_URL = 'https://hosted-mcp.test.haven/v1'
})

async function createSetup(app: FastifyInstance) {
  return app.inject({
    method: 'POST',
    url: '/agent-connection-setups',
    payload: {
      name: 'Research Agent',
      description: 'Pays for research APIs',
      safe_id: SAFE.id,
      runtime: 'claude-code',
      allowances: [ALLOWANCE],
    },
  })
}

describe('connector handout — the production default (#2422 characterization)', () => {
  it('hands out the LITERAL @haven_ai/connect@alpha in both agent-facing strings', async () => {
    const { default: routes } = await import('../agent-connection-setups.js')
    const app = Fastify({ logger: false })
    await app.register(routes, { prefix: '/agent-connection-setups' })

    const response = await createSetup(app)
    expect(response.statusCode).toBe(201)
    const body = response.json()

    // The command a developer or an agent actually executes…
    expect(body.connector_command).toContain(`npx -y ${PRODUCTION_CONNECTOR_SPEC} `)
    // …and the consent copy naming what they are approving.
    expect(body.setup_prompt).toContain(
      `download and execute the published npm package ${PRODUCTION_CONNECTOR_SPEC}`,
    )

    await app.close()
  }, MODULE_GRAPH_TIMEOUT_MS)

  it('names NO other @haven_ai/connect channel anywhere in the handout', async () => {
    const { default: routes } = await import('../agent-connection-setups.js')
    const app = Fastify({ logger: false })
    await app.register(routes, { prefix: '/agent-connection-setups' })

    const response = await createSetup(app)
    expect(response.statusCode).toBe(201)
    const body = response.json()

    // A `toContain` for `@alpha` alone would still pass if the spec drifted to a
    // SUPERSET (`@alpha-next`) or if a second, differently-channelled spec were
    // added elsewhere in the prompt. Enumerate every channel mentioned instead.
    const channels = new Set(
      [
        ...String(body.connector_command).matchAll(/@haven_ai\/connect@([^\s`'")]+)/g),
        ...String(body.setup_prompt).matchAll(/@haven_ai\/connect@([^\s`'")]+)/g),
      ].map((m) => m[1].replace(/[.,;:)\]]+$/, '')),
    )
    expect([...channels]).toEqual(['alpha'])

    await app.close()
  }, MODULE_GRAPH_TIMEOUT_MS)
})

describe('connector handout — HAVEN_CONNECTOR_CHANNEL=dev (#2422 acceptance)', () => {
  /**
   * The route resolves `CONNECTOR_PACKAGE` at import from `config`, which
   * itself reads the environment at import — so the variable has to be set
   * BEFORE the module graph is (re)built. `vi.resetModules()` is what makes
   * that possible from inside one process; the mocks above are file-level and
   * still apply to the dynamic import.
   */
  async function importRoutesWithChannel(channel: string | undefined) {
    vi.resetModules()
    if (channel === undefined) delete process.env.HAVEN_CONNECTOR_CHANNEL
    else process.env.HAVEN_CONNECTOR_CHANNEL = channel
    try {
      return await import('../agent-connection-setups.js')
    } finally {
      delete process.env.HAVEN_CONNECTOR_CHANNEL
    }
  }

  afterEach(() => {
    delete process.env.HAVEN_CONNECTOR_CHANNEL
    vi.resetModules()
  })

  it('hands out @haven_ai/connect@dev in the command, the consent copy and the response field', async () => {
    const { default: routes } = await importRoutesWithChannel('dev')
    const app = Fastify({ logger: false })
    await app.register(routes, { prefix: '/agent-connection-setups' })

    const response = await createSetup(app)
    expect(response.statusCode).toBe(201)
    const body = response.json()

    expect(body.connector_command).toContain('npx -y @haven_ai/connect@dev ')
    expect(body.setup_prompt).toContain(
      'download and execute the published npm package @haven_ai/connect@dev',
    )
    expect(body.connector_package).toBe('@haven_ai/connect@dev')

    // The prod channel must not survive anywhere in the handout — this is the
    // whole defect: a developer testing against dev installing prod packages.
    expect(body.connector_command).not.toContain('@alpha')
    expect(body.setup_prompt).not.toContain('@haven_ai/connect@alpha')

    await app.close()
  }, MODULE_GRAPH_TIMEOUT_MS)

  it('still hands out @alpha after the dev import, so module state does not leak', async () => {
    await importRoutesWithChannel('dev')
    const { default: routes } = await importRoutesWithChannel(undefined)
    const app = Fastify({ logger: false })
    await app.register(routes, { prefix: '/agent-connection-setups' })

    const body = (await createSetup(app)).json()
    expect(body.connector_command).toContain('npx -y @haven_ai/connect@alpha ')
    expect(body.connector_package).toBe('@haven_ai/connect@alpha')

    await app.close()
  }, MODULE_GRAPH_TIMEOUT_MS)

  it('refuses to LOAD — not to answer the request — on an invalid channel', async () => {
    // The acceptance criterion is "refuses to boot", and in a Node service
    // "boot" is the import of the config module. Assert the import itself
    // rejects: a route that answered 500 per request would leave a running
    // process that looks healthy to a platform health check.
    await expect(importRoutesWithChannel('Dev BAD')).rejects.toThrow(
      /HAVEN_CONNECTOR_CHANNEL/,
    )
  }, MODULE_GRAPH_TIMEOUT_MS)
})
