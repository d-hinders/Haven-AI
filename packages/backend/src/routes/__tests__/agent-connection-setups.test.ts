import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Wallet } from 'ethers'
import agentConnectionSetupRoutes, {
  CONNECTOR_PACKAGE,
  normalizeMcpServerName,
} from '../agent-connection-setups.js'

const { mockQuery, mockConnect, mockClientQuery, mockClientRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockClientQuery: vi.fn(),
  mockClientRelease: vi.fn(),
}))

const { mockGetTokenAllowance, mockGetTokensForDelegate } = vi.hoisted(() => ({
  mockGetTokenAllowance: vi.fn(),
  mockGetTokensForDelegate: vi.fn(),
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

vi.mock('../../rails/allowance-module.js', () => ({
  getTokenAllowance: (...args: unknown[]) => mockGetTokenAllowance(...args),
  getTokensForDelegate: (...args: unknown[]) => mockGetTokensForDelegate(...args),
}))

// Mirrors agents.test.ts: the passport module is mocked so the register-path
// opt-in (#1072) can be tested directly, including the "never breaks
// registration" guarantee it inherits from POST /agents (#972).
const { mockRequestPassport, mockIssueBestEffort } = vi.hoisted(() => ({
  mockRequestPassport: vi.fn(),
  mockIssueBestEffort: vi.fn(),
}))
vi.mock('../../modules/passport/index.js', () => ({
  requestPassport: (...a: unknown[]) => mockRequestPassport(...a),
  issuePassportBestEffort: (...a: unknown[]) => mockIssueBestEffort(...a),
  isPassportConfigured: () => true,
  PASSPORT_CHAIN_IDS: new Set([84532]),
}))

const SAFE = {
  id: 'safe-1',
  safe_address: '0x2222222222222222222222222222222222222222',
  name: 'Main Haven wallet',
  chain_id: 100,
}

const SETUP = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: 'user-1',
  agent_id: null,
  safe_id: SAFE.id,
  name: 'Research Agent',
  description: 'Pays for research APIs',
  runtime: 'claude-code',
  status: 'awaiting_connection',
  setup_token_expires_at: '2099-01-01T00:00:00.000Z',
  setup_token_consumed_at: null,
  challenge_id: '22222222-2222-2222-2222-222222222222',
  challenge_message: [
    'Haven Connect Agent 2',
    'setup_id: 11111111-1111-1111-1111-111111111111',
    'challenge_id: 22222222-2222-2222-2222-222222222222',
    'challenge: abc123',
    'expires_at: 2099-01-01T00:00:00.000Z',
  ].join('\n'),
  challenge_expires_at: '2099-01-01T00:00:00.000Z',
  delegate_address: null,
  proof_signature: null,
  api_key_prefix: null,
  connector_version: null,
  connector_context: {},
  install_status: {},
  approval_status: 'not_started',
  safe_tx_hash: null,
  tx_hash: null,
  failure_reason: null,
  safe_address: SAFE.safe_address,
  safe_name: SAFE.name,
  safe_chain_id: SAFE.chain_id,
}

const ALLOWANCE = {
  id: 'allowance-1',
  token_address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0',
  token_symbol: 'USDC.e',
  allowance_amount: '25000000',
  reset_period_min: 1440,
}
const UINT96_OVERFLOW = (1n << 96n).toString()

const API_KEY_HASH = 'a'.repeat(64)
const API_KEY_PREFIX = 'sk_agent_abc'
const DELEGATE_ADDRESS = '0x3333333333333333333333333333333333333333'
const TX_HASH = `0x${'a'.repeat(64)}`
const SAFE_TX_HASH = `0x${'b'.repeat(64)}`
const ALLOWANCE_MODULE_ADDRESS = '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134'

/** Suite-wide hosted MCP URL (#1129) — see the root beforeEach note. */
const TEST_HOSTED_MCP_URL = 'https://hosted-mcp.test.haven/v1'
/** The production backend host that (alone) still earns the built-in default. */
const PROD_API_URL = 'https://havenbackend-production-8a00.up.railway.app'
const PROD_DEFAULT_HOSTED_MCP_URL = 'https://haven-ai-production-5953.up.railway.app/v1'

// #1129: with HAVEN_HOSTED_MCP_URL / NEXT_PUBLIC_HAVEN_MCP_URL unset, a
// non-production self-URL (inject resolves to localhost) is a hard
// configuration error on /resolve and /register. The whole file therefore
// pins an explicit hosted MCP URL so every describe stays representative of
// a correctly configured deployment; the resolution matrix itself is covered
// by the dedicated "hosted MCP URL resolution (#1129)" describe, which
// overrides/unsets these per case.
beforeEach(() => {
  delete process.env.HAVEN_API_URL
  delete process.env.NEXT_PUBLIC_HAVEN_MCP_URL
  process.env.HAVEN_HOSTED_MCP_URL = TEST_HOSTED_MCP_URL
})

const CONNECTED_SETUP = {
  ...SETUP,
  agent_id: 'agent-1',
  status: 'connected_local',
  setup_token_consumed_at: '2026-06-03T12:00:00.000Z',
  delegate_address: DELEGATE_ADDRESS,
  api_key_prefix: API_KEY_PREFIX,
  approval_status: 'not_started',
}

type SetupFixture = Omit<
  typeof SETUP,
  | 'agent_id'
  | 'description'
  | 'runtime'
  | 'status'
  | 'setup_token_consumed_at'
  | 'delegate_address'
  | 'proof_signature'
  | 'api_key_prefix'
  | 'connector_version'
  | 'approval_status'
  | 'safe_tx_hash'
  | 'tx_hash'
  | 'failure_reason'
> & {
  agent_id: string | null
  description: string | null
  runtime: string | null
  status: string
  setup_token_consumed_at: string | null
  delegate_address: string | null
  proof_signature: string | null
  api_key_prefix: string | null
  connector_version: string | null
  approval_status: string
  safe_tx_hash: string | null
  tx_hash: string | null
  failure_reason: string | null
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(agentConnectionSetupRoutes, { prefix: '/agent-connection-setups' })
  return app
}

function approvalPayload(result: 'confirmed' | 'proposed') {
  return {
    result,
    tx_hash: result === 'confirmed' ? TX_HASH : undefined,
    safe_tx_hash: SAFE_TX_HASH,
    chain_id: SAFE.chain_id,
    safe_address: SAFE.safe_address,
    allowance_module_address: ALLOWANCE_MODULE_ADDRESS,
    delegate_address: DELEGATE_ADDRESS,
  }
}

function mockWalletApprovalPersist(setup: SetupFixture = CONNECTED_SETUP) {
  mockClientQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('FROM agent_connection_setups')) {
      return { rows: [setup] }
    }
    return { rows: [] }
  })
}

// ── Content-dispatch DB stub for the plain pool.query() calls (#1226) ──────
//
// Routes match on SQL FRAGMENTS, first hit wins, anything unmatched returns
// zero rows. This replaces the positional mockResolvedValueOnce chains that
// re-shuffled whenever a handler gained a query (#775) — what the database
// DOES with these statements (the `FOR UPDATE OF s` serialisation, the
// setup+allowances one-unit write, the cancel state-machine guard) is proven
// in infra/repositories/__tests__/agent-connection-setups.test.ts on the real
// Postgres harness (#1225, epic #1219); these tests own only the handler:
// status codes, response shapes, and which reads/writes were requested.
//
// Scope: this dispatcher answers `mockQuery` — the plain (non-transactional)
// `db.query()` calls the repository issues with its default `pool` executor
// (findUserSafe, findSetupByTokenHash, listSetupAllowances, …). Everything
// inside a repository transaction (register, cancel, and applyApprovalState's
// lock+write) runs on `mockClientQuery` via `mockConnect`, which this suite
// already answers with its own SQL-text `mockImplementation` per test — that
// pattern predates #1226 and needed no positional chain to begin with.

type DbRoute = [RegExp, (sql: string, params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>]

function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler(text, params)
    }
    return { rows: [] }
  })
}

/** findUserSafe (POST / — explicit safe_id or the default-wallet fallback). */
const safeLookup = (row: Record<string, unknown> = SAFE): DbRoute => [
  /FROM user_safes/,
  () => ({ rows: [row] }),
]
/** findSetupByTokenHash (POST /resolve's token load). */
const setupByTokenHash = (row: Record<string, unknown> | null): DbRoute => [
  /s\.setup_token_hash = \$1\b/,
  () => ({ rows: row ? [row] : [] }),
]
/** findSetupByIdAndTokenHash (install-status auth via setup_token). */
const setupByIdAndTokenHash = (row: Record<string, unknown> | null): DbRoute => [
  /s\.id = \$1 AND s\.setup_token_hash = \$2/,
  () => ({ rows: row ? [row] : [] }),
]
/** findSetupByAgentApiKeyHash (install-status auth via API key). */
const setupByAgentApiKey = (row: Record<string, unknown> | null): DbRoute => [
  /a\.api_key_hash = \$2/,
  () => ({ rows: row ? [row] : [] }),
]
/** findSetupForUser (GET /:setupId, wallet-approval, budget-approval). */
const setupForUser = (row: Record<string, unknown> | null): DbRoute => [
  /s\.id = \$1 AND s\.user_id = \$2/,
  () => ({ rows: row ? [row] : [] }),
]
/** updateConnectorMetadata (resolve's optional connector-metadata write). */
const connectorMetadataUpdate: DbRoute = [
  /connector_version = COALESCE\(\$2, connector_version\)/,
  () => ({ rows: [] }),
]
/** listSetupAllowances. */
const setupAllowances = (rows: unknown[] = [ALLOWANCE]): DbRoute => [
  /FROM agent_connection_setup_allowances/,
  () => ({ rows }),
]
/** listActiveDelegations (budget-approval's delegation-rail authority check). */
const activeDelegations = (rows: unknown[]): DbRoute => [
  /FROM agent_delegations/,
  () => ({ rows }),
]
/** mergeInstallStatus's RETURNING install_status. */
const mergeInstallStatusResult = (installStatus: Record<string, unknown> | null): DbRoute => [
  /install_status = install_status \|\| \$2::jsonb/,
  () => ({ rows: installStatus ? [{ install_status: installStatus }] : [] }),
]

describe('agent connection setup routes', () => {
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
    mockGetTokenAllowance.mockReset()
    mockGetTokensForDelegate.mockReset()
    mockRequestPassport.mockReset().mockResolvedValue(true)
    mockIssueBestEffort.mockReset()
    // Env vars (HAVEN_API_URL, HAVEN_HOSTED_MCP_URL, …) are pinned by the
    // root-level beforeEach above (#1129).
  })

  it('creates a pending setup with a returned-once token stored only as a hash', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
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

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.status).toBe('awaiting_connection')
    expect(body.setup_token).toMatch(/^hv_setup_[0-9a-f]+$/)
    expect(body.connector_command).toContain(`npx -y ${CONNECTOR_PACKAGE}`)
    expect(body.connector_command).toContain('--ack-local-tools')
    expect(body.setup_prompt).toContain('I approve running this exact Haven setup command')
    expect(body.setup_prompt).toContain(`download and execute the published npm package ${CONNECTOR_PACKAGE}`)
    expect(body.setup_prompt).toContain('connect to Haven at http://localhost:80')
    expect(body.setup_prompt).toContain('write local Haven credential files under ~/.haven')
    expect(body.setup_prompt).toContain('update the local agent MCP config when supported')
    expect(body.setup_prompt).toContain('Run this exact command:')
    expect(body.setup_prompt).toContain(
      'Network access is expected: this command downloads the npm package and contacts the Haven API, so if your environment is sandboxed, run it with network access enabled or request network access escalation; that changes the execution environment, not the command, and is not a third command modification.',
    )
    expect(body.setup_prompt).toContain(
      'Only two changes to the command above are permitted, and no others: appending --json, and — only if the connector refuses because it could not determine the agent runtime — re-running it once with --runtime <name> added, naming the harness you are running in, using one of the values that refusal lists. Never invent a runtime name and never change anything else.',
    )
    // #1545: the backend is the source of truth for the prompt — pin the
    // --json discoverability sentence and the gate's one name here, not only
    // in the frontend/e2e mirrors.
    // #1719: the permitted-changes sentence now names the --runtime retry the
    // connector asks an agent for by name, and still forbids everything else.
    expect(body.setup_prompt).toContain('Only two changes to the command above are permitted, and no others: appending --json')
    expect(body.setup_prompt).toContain('could not determine the agent runtime')
    expect(body.setup_prompt).toContain('Never invent a runtime name')
    expect(body.setup_prompt).toContain('return to Haven to approve the budget')
    expect(body.setup_prompt).not.toContain('agent rules')
    expect(body.setup_prompt).not.toMatch(/delegate_key|private_key|sk_agent_/)

    const insertSetup = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO agent_connection_setups'),
    )
    expect(insertSetup).toBeTruthy()
    const params = insertSetup?.[1] as unknown[]
    expect(params).not.toContain(body.setup_token)
    expect(params[6]).toMatch(/^[0-9a-f]{64}$/)
    expect(params[7]).toBe(body.setup_token.slice(0, 20))
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT')
    const insertAllowance = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO agent_connection_setup_allowances'),
    )
    expect(insertAllowance?.[1]).toEqual([
      expect.any(String),
      ALLOWANCE.token_address.toLowerCase(),
      ALLOWANCE.token_symbol,
      ALLOWANCE.allowance_amount,
      ALLOWANCE.reset_period_min,
    ])

    await app.close()
  })

  it('persists the passport opt-in on the setup row for /register to act on later (#1072)', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        allowances: [ALLOWANCE],
        issue_passport: true,
      },
    })

    expect(response.statusCode).toBe(201)
    const insertSetup = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO agent_connection_setups'),
    )
    const params = insertSetup?.[1] as unknown[]
    expect(params[12]).toBe(true)

    await app.close()
  })

  it('appends --local to the connector command when local_mcp is requested for a supported runtime', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        runtime: 'claude-code',
        local_mcp: true,
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().connector_command).toContain('--local')
  })

  it('omits --local from the connector command by default', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        runtime: 'claude-code',
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().connector_command).not.toContain('--local')
  })

  // #1720: the dashboard sends no runtime now, so "no runtime" can no longer
  // mean "refuse". Before this change the same payload 400'd on `!runtime`,
  // which would have made the Advanced opt-in unusable the moment the picker
  // went — the failure this test exists to catch if the condition is ever
  // widened back.
  it('accepts local_mcp when no runtime is named, leaving the check to the connector', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        local_mcp: true,
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().connector_command).toContain('--local')
  })

  // The other half of that loosening: an EXPLICIT unsupported runtime from an
  // older client is still refused here, where the answer is known, rather than
  // deferred to a connector refusal the user cannot act on without starting
  // over.
  it('rejects local_mcp for runtimes without local MCP support', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        runtime: 'cursor',
        local_mcp: true,
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/Local MCP is only available/)
  })

  it('normalizes setup allowances before storing pending wallet approval state', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        allowances: [{
          ...ALLOWANCE,
          token_symbol: '  USDC.e  ',
          allowance_amount: '00025000000',
        }],
      },
    })

    expect(response.statusCode).toBe(201)
    const insertAllowance = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO agent_connection_setup_allowances'),
    )
    expect(insertAllowance?.[1]).toEqual([
      expect.any(String),
      ALLOWANCE.token_address.toLowerCase(),
      'USDC.e',
      '25000000',
      ALLOWANCE.reset_period_min,
    ])

    await app.close()
  })

  it.each([
    ['bad token address', { ...ALLOWANCE, token_address: 'not-an-address' }, /Valid token address/],
    ['blank token symbol', { ...ALLOWANCE, token_symbol: '   ' }, /Token symbol is required/],
    ['zero allowance amount', { ...ALLOWANCE, allowance_amount: '0' }, /positive decimal atomic amount/],
    ['scientific allowance amount', { ...ALLOWANCE, allowance_amount: '1e6' }, /positive decimal atomic amount/],
    ['uint96 overflow allowance amount', { ...ALLOWANCE, allowance_amount: UINT96_OVERFLOW }, /uint96/],
    ['negative reset period', { ...ALLOWANCE, reset_period_min: -1 }, /0 to 65535/],
    ['uint16 overflow reset period', { ...ALLOWANCE, reset_period_min: 65536 }, /0 to 65535/],
  ])('rejects invalid setup allowance input before wallet lookup: %s', async (_label, allowance, errorPattern) => {
    const app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        allowances: [allowance],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(errorPattern)
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()

    await app.close()
  })

  it('rejects duplicate setup allowances after token address normalization', async () => {
    const app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        allowances: [
          ALLOWANCE,
          {
            ...ALLOWANCE,
            token_address: ALLOWANCE.token_address.toUpperCase().replace('X', 'x'),
            allowance_amount: '50000000',
          },
        ],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/Duplicate token/)
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()

    await app.close()
  })

  // #1672 gave the command-path runtimes a flag-free command; #1720 gives it
  // to EVERYONE. The connector resolves the runtime itself — detection, then
  // self-report, then a prompt over installed clients (#1719) — so no id a
  // caller supplies has any business being spelled into the command.
  //
  // The list below is deliberately every id the route has ever accepted,
  // snippet rows included, PLUS undefined (the shape the dashboard now sends).
  // The old suite asserted the flag's absence for six ids and its PRESENCE for
  // the rest, so a narrower list here would leave the inverted half untested.
  it.each([
    'claude-code', 'codex', 'cowork', 'agent', 'codex-cli', 'codex-desktop',
    'claude-desktop', 'cursor', 'vscode', 'openclaw', 'hermes', 'other',
    undefined,
  ])(
    'never emits --runtime, for runtime %s',
    async (runtime) => {
      const app = await buildApp()
      primeDb(safeLookup())

      const response = await app.inject({
        method: 'POST',
        url: '/agent-connection-setups',
        payload: {
          name: 'Research Agent',
          safe_id: SAFE.id,
          runtime,
          allowances: [ALLOWANCE],
        },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.connector_command).toContain(`npx -y ${CONNECTOR_PACKAGE}`)
      expect(body.connector_command).toContain('--ack-local-tools')
      expect(body.connector_command).not.toContain('--runtime')
      expect(body.setup_prompt).toContain('I approve running this exact Haven setup command')
      expect(body.setup_prompt).toContain(`download and execute the published npm package ${CONNECTOR_PACKAGE}`)
      expect(body.setup_prompt).toContain('Do not print private keys, API keys, credential file contents, or config secrets')
      expect(body.setup_prompt).not.toMatch(/delegate_key|private_key|sk_agent_/)

      await app.close()
    },
  )

  // #1720 inverts this. It used to assert the flag SURVIVED for snippet
  // runtimes "where nothing is detectable" — true of #1672's connector, false
  // of #1719's, which asks the user over the clients it can actually see.
  it('drops --runtime even for a snippet runtime an older client still sends', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        runtime: 'claude-desktop',
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().connector_command).not.toContain('--runtime')

    await app.close()
  })

  // #1720: the flag is gone for OpenClaw like everything else, but the id an
  // older client sends is still STORED. That half is the backwards-compat
  // contract — existing setup rows carry picked ids and the status response
  // reads them back — so it is asserted separately from the flag.
  it('drops --runtime for OpenClaw but still stores the id an older client sent', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        runtime: 'openclaw',
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().connector_command).not.toContain('--runtime')
    const insertSetup = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO agent_connection_setups'),
    )
    expect(insertSetup?.[1] as unknown[]).toContain('openclaw')

    await app.close()
  })

  // Local MCP follows the command path, so the two new named rows get it and
  // a snippet row still does not.
  it.each(['codex', 'cowork'])(
    'accepts local_mcp for the %s runtime',
    async (runtime) => {
      const app = await buildApp()
      primeDb(safeLookup())

      const response = await app.inject({
        method: 'POST',
        url: '/agent-connection-setups',
        payload: {
          name: 'Research Agent',
          safe_id: SAFE.id,
          runtime,
          local_mcp: true,
          allowances: [ALLOWANCE],
        },
      })

      expect(response.statusCode).toBe(201)
      expect(response.json().connector_command).toContain('--local')

      await app.close()
    },
  )

  it('still rejects local_mcp for the OpenClaw snippet runtime', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        runtime: 'openclaw',
        local_mcp: true,
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(400)

    await app.close()
  })

  // #1720: the setup prompt is now UNIVERSAL — one text for every environment,
  // because the dashboard no longer knows which environment it is talking to.
  // The Hermes-specific block that used to ride here is asserted GONE.
  //
  // What it said is not lost. The connector emits the restart, `hermes mcp
  // list` / `test`, and `pip install mcp` steps itself once it has configured
  // Hermes (packages/connect/src/config-writers.ts), which is both later and
  // better placed: after the config exists, from the component that knows the
  // runtime. The one line without a connector counterpart — "do not run
  // `hermes mcp add`" — is subsumed by the universal rule below, which forbids
  // substituting anything for the command in every environment rather than
  // naming one tool in one of them.
  it('builds one universal setup prompt, with no runtime-specific block', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        runtime: 'hermes',
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.connector_command).not.toContain('--runtime')

    // The consent line is the generic one for everybody. This is the real cost
    // of the change and it is pinned deliberately: the text a user approves
    // BEFORE anything runs no longer names their client's config file.
    expect(body.setup_prompt).toContain('update the local agent MCP config when supported')
    expect(body.setup_prompt).not.toContain('update Hermes Agent MCP config')
    expect(body.setup_prompt).not.toContain('~/.codex/config.toml')

    // No Hermes block.
    expect(body.setup_prompt).not.toContain('hermes mcp add')
    expect(body.setup_prompt).not.toContain('hermes mcp list')
    expect(body.setup_prompt).not.toContain('pip install mcp')

    // The universal guardrails still stand.
    expect(body.setup_prompt).toContain('Do not print private keys, API keys, credential file contents, or config secrets')
    expect(body.setup_prompt).toContain('Only two changes to the command above are permitted')
    expect(body.setup_prompt).not.toMatch(/delegate_key|private_key|sk_agent_|hermes_cli\.mcp_config|npm install -g/)

    await app.close()
  })

  // #1720: byte-identical means byte-identical. Two setups created from
  // different callers' payloads must differ in nothing but the token — the
  // property the picker's removal is FOR, and the one a per-runtime assertion
  // can never quite state.
  it('produces an identical command and prompt whatever runtime the caller names', async () => {
    const app = await buildApp()

    async function createWith(runtime: string | undefined) {
      primeDb(safeLookup())
      const response = await app.inject({
        method: 'POST',
        url: '/agent-connection-setups',
        payload: { name: 'Research Agent', safe_id: SAFE.id, runtime, allowances: [ALLOWANCE] },
      })
      expect(response.statusCode).toBe(201)
      const body = response.json()
      // The setup token is the one legitimate difference; normalise it out.
      const token = body.setup_token
      return {
        command: String(body.connector_command).split(token).join('<token>'),
        prompt: String(body.setup_prompt).split(token).join('<token>'),
      }
    }

    const none = await createWith(undefined)
    for (const runtime of ['claude-code', 'claude-desktop', 'hermes', 'openclaw', 'other']) {
      const other = await createWith(runtime)
      expect(other.command).toBe(none.command)
      expect(other.prompt).toBe(none.prompt)
    }

    await app.close()
  })

  it('exercises the Connect Agent 2 setup spine from pending setup through active wallet approval', async () => {
    const app = await buildApp()
    const wallet = new Wallet('0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38')
    const setupRows: SetupFixture[] = []
    const allowanceRows: (typeof ALLOWANCE)[] = []
    let agentStatus = ''

    mockQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      if (text.includes('FROM user_safes')) {
        return { rows: [SAFE] }
      }
      if (text.includes('UPDATE agent_connection_setups')) {
        const setup = setupRows.find((row) => row.id === params[0])
        if (setup) {
          setup.connector_version = typeof params[1] === 'string' ? params[1] : setup.connector_version
          setup.runtime = typeof params[2] === 'string' ? params[2] : setup.runtime
        }
        return { rows: [] }
      }
      if (text.includes('FROM agent_connection_setups')) {
        return { rows: setupRows.length ? [setupRows[0]] : [] }
      }
      if (text.includes('FROM agent_connection_setup_allowances')) {
        return { rows: allowanceRows }
      }
      return { rows: [] }
    })

    mockClientQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const text = String(sql)
      if (text.includes('INSERT INTO agent_connection_setups')) {
        setupRows[0] = {
          ...SETUP,
          id: String(params[0]),
          user_id: String(params[1]),
          safe_id: String(params[2]),
          name: String(params[3]),
          description: params[4] as string | null,
          runtime: params[5] as string | null,
          status: 'awaiting_connection',
          setup_token_expires_at: String(params[8]),
          challenge_id: String(params[9]),
          challenge_message: String(params[10]),
          challenge_expires_at: String(params[11]),
        }
        return { rows: [] }
      }
      if (text.includes('INSERT INTO agent_connection_setup_allowances')) {
        allowanceRows.push({
          ...ALLOWANCE,
          token_address: String(params[1]),
          token_symbol: String(params[2]),
          allowance_amount: String(params[3]),
          reset_period_min: Number(params[4]),
        })
        return { rows: [] }
      }
      if (text.includes('FROM agent_connection_setups')) {
        return { rows: setupRows.length ? [setupRows[0]] : [] }
      }
      if (text.includes('SELECT id FROM agents')) {
        return { rows: [] }
      }
      if (text.includes('INSERT INTO agents')) {
        agentStatus = 'pending_approval'
        return { rows: [{ id: 'agent-1' }] }
      }
      if (text.includes('INSERT INTO agent_allowances')) {
        return { rows: [] }
      }
      if (text.includes('UPDATE agent_connection_setups') && text.includes('agent_id = $2')) {
        setupRows[0] = {
          ...setupRows[0],
          agent_id: String(params[1]),
          status: 'connected_local',
          delegate_address: String(params[2]),
          proof_signature: String(params[3]),
          api_key_prefix: String(params[4]),
          connector_version: params[5] as string | null,
          runtime: params[6] as string | null,
          connector_context: JSON.parse(String(params[7])) as Record<string, unknown>,
          install_status: JSON.parse(String(params[8])) as Record<string, unknown>,
          setup_token_consumed_at: '2026-06-03T12:00:00.000Z',
        }
        return { rows: [] }
      }
      if (text.includes('UPDATE agent_connection_setups') && text.includes('status = $3')) {
        setupRows[0] = {
          ...setupRows[0],
          status: String(params[2]),
          approval_status: String(params[3]),
          tx_hash: params[4] as string | null,
          safe_tx_hash: params[5] as string | null,
          failure_reason: params[6] as string | null,
        }
        return { rows: [] }
      }
      if (text.includes('UPDATE agents')) {
        agentStatus = 'active'
        return { rows: [] }
      }
      return { rows: [] }
    })

    const createResponse = await app.inject({
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
    expect(createResponse.statusCode).toBe(201)
    const created = createResponse.json()
    expect(created.setup_token).toMatch(/^hv_setup_[0-9a-f]+$/)
    expect(JSON.stringify(created)).not.toMatch(/delegate_key|private_key|privateKey|sk_agent_/)
    const insertedSetup = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO agent_connection_setups'),
    )
    expect(insertedSetup?.[1]).not.toContain(created.setup_token)

    // The resolve response must carry the x402 binding signer so the connector
    // can write it into signer.json (else the edge signer refuses to sign x402).
    const BINDING_SIGNER = '0x3b35f00021032F6cC8ad20bd136BD945DAd04d04'
    const priorBindingSigner = process.env.HAVEN_X402_BINDING_SIGNER
    process.env.HAVEN_X402_BINDING_SIGNER = BINDING_SIGNER
    let resolved: Record<string, any>
    try {
      const resolveResponse = await app.inject({
        method: 'POST',
        url: '/agent-connection-setups/resolve',
        payload: {
          setup_token: created.setup_token,
          connector_version: '0.1.0',
          runtime: 'claude-code',
        },
      })
      expect(resolveResponse.statusCode).toBe(200)
      resolved = resolveResponse.json()
      expect(resolved.x402_binding_signer).toBe(BINDING_SIGNER)
    } finally {
      if (priorBindingSigner === undefined) delete process.env.HAVEN_X402_BINDING_SIGNER
      else process.env.HAVEN_X402_BINDING_SIGNER = priorBindingSigner
    }
    expect(resolved.challenge.message).toBe(setupRows[0].challenge_message)
    expect(JSON.stringify(resolved)).not.toMatch(/api_key|delegate_key|private_key|privateKey/)

    const proof = await wallet.signMessage(resolved.challenge.message)
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: created.setup_token,
        challenge_id: resolved.challenge.id,
        delegate_address: wallet.address,
        proof_signature: proof,
        api_key_hash: API_KEY_HASH,
        api_key_prefix: 'sk_agent_fed',
        runtime: 'claude-code',
        connector_version: '0.1.0',
        connector_context: {
          environment_label: 'Local workspace',
          runtime_version: 'claude-code 1.2.3',
        },
      },
    })
    expect(registerResponse.statusCode).toBe(201)
    expect(registerResponse.json()).toMatchObject({
      status: 'connected_local',
      agent_status: 'pending_approval',
      api_key_scope: 'setup_pending',
      delegate_address: wallet.address.toLowerCase(),
    })
    expect(registerResponse.json()).not.toHaveProperty('api_key')
    expect(JSON.stringify(mockClientQuery.mock.calls)).not.toContain(wallet.privateKey)

    const statusResponse = await app.inject({
      method: 'GET',
      url: `/agent-connection-setups/${created.setup_id}`,
    })
    expect(statusResponse.statusCode).toBe(200)
    expect(statusResponse.json()).toMatchObject({
      setup_id: created.setup_id,
      status: 'connected_local',
      delegate_address: wallet.address.toLowerCase(),
      approval: { status: 'not_started' },
    })

    mockGetTokensForDelegate.mockResolvedValue([ALLOWANCE.token_address])
    mockGetTokenAllowance.mockResolvedValue({
      amount: BigInt(ALLOWANCE.allowance_amount),
      spent: 0n,
      resetTimeMin: ALLOWANCE.reset_period_min,
      lastResetMin: 0,
      nonce: 0,
    })
    const approvalResponse = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${created.setup_id}/wallet-approval`,
      payload: {
        ...approvalPayload('confirmed'),
        delegate_address: wallet.address,
      },
    })

    expect(approvalResponse.statusCode).toBe(200)
    expect(approvalResponse.json()).toMatchObject({
      setup_id: created.setup_id,
      status: 'active',
      delegate_address: wallet.address.toLowerCase(),
      approval: {
        status: 'confirmed',
        tx_hash: TX_HASH,
        safe_tx_hash: SAFE_TX_HASH,
      },
    })
    expect(agentStatus).toBe('active')
    expect(mockGetTokenAllowance).toHaveBeenCalledWith(
      SAFE.chain_id,
      SAFE.safe_address,
      wallet.address.toLowerCase(),
      ALLOWANCE.token_address.toLowerCase(),
    )

    await app.close()
  })

  it('resolves a setup token for the connector without returning credentials', async () => {
    const app = await buildApp()
    primeDb(setupByTokenHash(SETUP), connectorMetadataUpdate, setupAllowances([ALLOWANCE]))

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/resolve',
      payload: {
        setup_token: 'hv_setup_test',
        connector_version: '0.1.0',
        runtime: 'claude-code',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      setup_id: SETUP.id,
      status: 'awaiting_connection',
      agent: { name: 'Research Agent' },
      haven_wallet: { address: SAFE.safe_address, chain_id: 100 },
      challenge: { id: SETUP.challenge_id, message: SETUP.challenge_message },
    })
    expect(JSON.stringify(response.json())).not.toMatch(/api_key|delegate_key|private_key/)

    await app.close()
  })

  it('registers a public signing address with proof and creates a non-active agent', async () => {
    const app = await buildApp()
    const wallet = new Wallet('0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38')
    const proof = await wallet.signMessage(SETUP.challenge_message)

    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return { rows: [SETUP] }
      }
      if (String(sql).includes('SELECT id FROM agents')) {
        return { rows: [] }
      }
      if (String(sql).includes('INSERT INTO agents')) {
        return { rows: [{ id: 'agent-1' }] }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_test',
        challenge_id: SETUP.challenge_id,
        delegate_address: wallet.address,
        proof_signature: proof,
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
        runtime: 'claude-code',
        connector_version: '0.1.0',
        connector_context: {
          environment_label: 'Local workspace',
          runtime_version: 'claude-code 1.2.3',
        },
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.agent_status).toBe('pending_approval')
    expect(body).not.toHaveProperty('api_key')
    expect(body.api_key_prefix).toBe(API_KEY_PREFIX)
    expect(body.delegate_address).toBe(wallet.address.toLowerCase())

    const insertAgent = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO agents'),
    )
    expect(String(insertAgent?.[0])).toContain("'pending_approval'")
    expect(insertAgent?.[1]).toContain(API_KEY_HASH)
    expect(JSON.stringify(mockClientQuery.mock.calls)).not.toContain(wallet.privateKey)
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT')

    await app.close()
  })

  /**
   * #1072: the connector flow could not opt in at all — `issue_passport` had
   * no path from setup creation through to the agent that /register creates.
   * This pins the flag actually reaching `requestPassport`/
   * `issuePassportBestEffort`, mirroring the POST /agents coverage in
   * agents.test.ts so the two entry points are held to the same bar.
   */
  it('requests a passport at register time when the setup opted in on an eligible chain', async () => {
    const app = await buildApp()
    const wallet = new Wallet('0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38')
    const passportSetup = { ...SETUP, issue_passport: true, safe_chain_id: 84532 }
    const proof = await wallet.signMessage(passportSetup.challenge_message)

    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return { rows: [passportSetup] }
      }
      if (String(sql).includes('SELECT id FROM agents')) {
        return { rows: [] }
      }
      if (String(sql).includes('INSERT INTO agents')) {
        return { rows: [{ id: 'agent-1' }] }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_test',
        challenge_id: passportSetup.challenge_id,
        delegate_address: wallet.address,
        proof_signature: proof,
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().passport_requested).toBe(true)
    expect(mockRequestPassport).toHaveBeenCalledWith('agent-1', 84532)
    expect(mockIssueBestEffort).toHaveBeenCalledWith('agent-1', 'user-1')

    await app.close()
  })

  it('does not request a passport unless the setup explicitly opted in', async () => {
    const app = await buildApp()
    const wallet = new Wallet('0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38')
    // SETUP carries no issue_passport flag — the normal, unchanged case.
    const proof = await wallet.signMessage(SETUP.challenge_message)

    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return { rows: [SETUP] }
      }
      if (String(sql).includes('SELECT id FROM agents')) {
        return { rows: [] }
      }
      if (String(sql).includes('INSERT INTO agents')) {
        return { rows: [{ id: 'agent-1' }] }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_test',
        challenge_id: SETUP.challenge_id,
        delegate_address: wallet.address,
        proof_signature: proof,
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().passport_requested).toBe(false)
    expect(mockRequestPassport).not.toHaveBeenCalled()
    expect(mockIssueBestEffort).not.toHaveBeenCalled()

    await app.close()
  })

  it('registers the agent even when passport issuance throws', async () => {
    const app = await buildApp()
    const wallet = new Wallet('0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38')
    const passportSetup = { ...SETUP, issue_passport: true, safe_chain_id: 84532 }
    const proof = await wallet.signMessage(passportSetup.challenge_message)
    mockRequestPassport.mockRejectedValue(new Error('passport table missing'))

    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return { rows: [passportSetup] }
      }
      if (String(sql).includes('SELECT id FROM agents')) {
        return { rows: [] }
      }
      if (String(sql).includes('INSERT INTO agents')) {
        return { rows: [{ id: 'agent-1' }] }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_test',
        challenge_id: passportSetup.challenge_id,
        delegate_address: wallet.address,
        proof_signature: proof,
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().agent_status).toBe('pending_approval')
    expect(mockClientQuery.mock.calls.some(([sql]) => /ROLLBACK/.test(String(sql)))).toBe(false)

    await app.close()
  })

  it('rejects invalid proof signatures before creating an agent', async () => {
    const app = await buildApp()
    const wallet = Wallet.createRandom()
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return { rows: [SETUP] }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_test',
        challenge_id: SETUP.challenge_id,
        delegate_address: wallet.address,
        proof_signature: '0xdeadbeef',
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/Invalid proof/)
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO agents'))).toBe(false)

    await app.close()
  })

  it('rejects duplicate non-revoked signing addresses during registration', async () => {
    const app = await buildApp()
    const wallet = new Wallet('0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38')
    const proof = await wallet.signMessage(SETUP.challenge_message)
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return { rows: [SETUP] }
      }
      if (String(sql).includes('SELECT id FROM agents')) {
        return { rows: [{ id: 'existing-agent' }] }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_test',
        challenge_id: SETUP.challenge_id,
        delegate_address: wallet.address,
        proof_signature: proof,
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/signing address/)
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO agents'))).toBe(false)

    await app.close()
  })

  it('returns 409 when concurrent registration hits the delegate uniqueness index', async () => {
    const app = await buildApp()
    const wallet = new Wallet('0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38')
    const proof = await wallet.signMessage(SETUP.challenge_message)

    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return { rows: [SETUP] }
      }
      if (String(sql).includes('SELECT id FROM agents')) {
        return { rows: [] }
      }
      if (String(sql).includes('INSERT INTO agents')) {
        throw Object.assign(new Error('duplicate delegate'), {
          code: '23505',
          constraint: 'idx_agents_user_delegate_non_revoked_unique',
        })
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_test',
        challenge_id: SETUP.challenge_id,
        delegate_address: wallet.address,
        proof_signature: proof,
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/signing address/)
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK')

    await app.close()
  })

  it('records confirmed wallet approval and activates only after on-chain allowance reconciliation', async () => {
    const app = await buildApp()
    primeDb(setupForUser(CONNECTED_SETUP), setupAllowances([ALLOWANCE]))
    mockGetTokensForDelegate.mockResolvedValue([ALLOWANCE.token_address])
    mockGetTokenAllowance.mockResolvedValue({
      amount: BigInt(ALLOWANCE.allowance_amount),
      spent: 0n,
      resetTimeMin: ALLOWANCE.reset_period_min,
      lastResetMin: 0,
      nonce: 0,
    })
    mockWalletApprovalPersist()

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/wallet-approval`,
      payload: approvalPayload('confirmed'),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      setup_id: SETUP.id,
      status: 'active',
      delegate_address: DELEGATE_ADDRESS,
      approval: {
        status: 'confirmed',
        tx_hash: TX_HASH,
        safe_tx_hash: SAFE_TX_HASH,
      },
    })
    expect(mockGetTokenAllowance).toHaveBeenCalledWith(
      SAFE.chain_id,
      SAFE.safe_address,
      DELEGATE_ADDRESS,
      ALLOWANCE.token_address,
    )
    const setupUpdate = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE agent_connection_setups'),
    )
    expect(setupUpdate?.[1]).toEqual([
      SETUP.id,
      'user-1',
      'active',
      'confirmed',
      TX_HASH,
      SAFE_TX_HASH,
      null,
    ])
    const agentUpdate = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE agents'),
    )
    expect(String(agentUpdate?.[0])).toContain("status = 'active'")

    await app.close()
  })

  it('keeps multisig wallet approval proposals non-active', async () => {
    const app = await buildApp()
    primeDb(setupForUser(CONNECTED_SETUP), setupAllowances([ALLOWANCE]))
    mockGetTokensForDelegate.mockResolvedValue([])
    mockWalletApprovalPersist()

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/wallet-approval`,
      payload: approvalPayload('proposed'),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      setup_id: SETUP.id,
      status: 'proposed',
      approval: {
        status: 'proposed',
        tx_hash: null,
        safe_tx_hash: SAFE_TX_HASH,
      },
    })
    const agentUpdate = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE agents'),
    )
    expect(agentUpdate).toBeUndefined()

    await app.close()
  })

  it('does not activate when the live allowance does not match the pending setup', async () => {
    const app = await buildApp()
    primeDb(setupForUser(CONNECTED_SETUP), setupAllowances([ALLOWANCE]))
    mockGetTokensForDelegate.mockResolvedValue([ALLOWANCE.token_address])
    mockGetTokenAllowance.mockResolvedValue({
      amount: 1n,
      spent: 0n,
      resetTimeMin: ALLOWANCE.reset_period_min,
      lastResetMin: 0,
      nonce: 0,
    })

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/wallet-approval`,
      payload: approvalPayload('confirmed'),
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/budget does not match/)
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE agents'))).toBe(false)
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE agent_connection_setups'))).toBe(false)

    await app.close()
  })

  it('records submitted confirmation evidence after a receipt timeout without activating', async () => {
    const app = await buildApp()
    primeDb(setupForUser(CONNECTED_SETUP), setupAllowances([ALLOWANCE]))
    mockGetTokensForDelegate.mockResolvedValue([])
    mockWalletApprovalPersist()

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/wallet-approval`,
      payload: {
        ...approvalPayload('confirmed'),
        confirmation_status: 'receipt_timeout',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      status: 'approval_in_progress',
      approval: {
        status: 'submitted',
        tx_hash: TX_HASH,
        safe_tx_hash: SAFE_TX_HASH,
      },
    })
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE agents'))).toBe(false)

    await app.close()
  })

  it('keeps confirmed wallet approval in progress when on-chain budget is not visible yet', async () => {
    const app = await buildApp()
    primeDb(setupForUser(CONNECTED_SETUP), setupAllowances([ALLOWANCE]))
    mockGetTokensForDelegate.mockResolvedValue([])
    mockWalletApprovalPersist()

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/wallet-approval`,
      payload: approvalPayload('confirmed'),
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      status: 'approval_in_progress',
      approval: {
        status: 'submitted',
        tx_hash: TX_HASH,
        safe_tx_hash: SAFE_TX_HASH,
      },
      failure_reason: 'On-chain agent budget is not active yet',
    })
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE agents'))).toBe(false)
    const setupUpdate = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE agent_connection_setups'),
    )
    expect(setupUpdate?.[1]).toEqual([
      SETUP.id,
      'user-1',
      'approval_in_progress',
      'submitted',
      TX_HASH,
      SAFE_TX_HASH,
      'On-chain agent budget is not active yet',
    ])

    await app.close()
  })

  it('keeps confirmed wallet approval in progress when on-chain verification is temporarily unavailable', async () => {
    const app = await buildApp()
    primeDb(setupForUser(CONNECTED_SETUP), setupAllowances([ALLOWANCE]))
    mockGetTokensForDelegate.mockRejectedValue(new Error('rpc unavailable'))
    mockWalletApprovalPersist()

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/wallet-approval`,
      payload: approvalPayload('confirmed'),
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      status: 'approval_in_progress',
      approval: {
        status: 'submitted',
        tx_hash: TX_HASH,
        safe_tx_hash: SAFE_TX_HASH,
      },
      failure_reason: 'Haven could not verify the on-chain agent rules yet',
    })
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE agents'))).toBe(false)

    await app.close()
  })

  it('does not persist wallet approval if setup was cancelled after the initial read', async () => {
    const app = await buildApp()
    primeDb(setupForUser(CONNECTED_SETUP), setupAllowances([ALLOWANCE]))
    mockGetTokensForDelegate.mockResolvedValue([ALLOWANCE.token_address])
    mockGetTokenAllowance.mockResolvedValue({
      amount: BigInt(ALLOWANCE.allowance_amount),
      spent: 0n,
      resetTimeMin: ALLOWANCE.reset_period_min,
      lastResetMin: 0,
      nonce: 0,
    })
    mockWalletApprovalPersist({ ...CONNECTED_SETUP, status: 'cancelled' })

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/wallet-approval`,
      payload: approvalPayload('confirmed'),
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/state changed/)
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE agents'))).toBe(false)

    await app.close()
  })

  it('treats repeated confirmed wallet approval evidence as idempotent', async () => {
    const app = await buildApp()
    primeDb(
      setupForUser({
        ...CONNECTED_SETUP,
        status: 'active',
        approval_status: 'confirmed',
        tx_hash: TX_HASH,
        safe_tx_hash: SAFE_TX_HASH,
      }),
      setupAllowances([ALLOWANCE]),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/wallet-approval`,
      payload: approvalPayload('confirmed'),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().status).toBe('active')
    expect(mockGetTokensForDelegate).not.toHaveBeenCalled()
    expect(mockClientQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('recovers a proposed setup to active when status read sees live on-chain authority', async () => {
    const app = await buildApp()
    primeDb(
      setupForUser({
        ...CONNECTED_SETUP,
        status: 'proposed',
        approval_status: 'proposed',
        safe_tx_hash: SAFE_TX_HASH,
      }),
      setupAllowances([ALLOWANCE]),
    )
    mockGetTokensForDelegate.mockResolvedValue([ALLOWANCE.token_address])
    mockGetTokenAllowance.mockResolvedValue({
      amount: BigInt(ALLOWANCE.allowance_amount),
      spent: 0n,
      resetTimeMin: ALLOWANCE.reset_period_min,
      lastResetMin: 0,
      nonce: 0,
    })
    mockWalletApprovalPersist({
      ...CONNECTED_SETUP,
      status: 'proposed',
      approval_status: 'proposed',
      safe_tx_hash: SAFE_TX_HASH,
    })

    const response = await app.inject({
      method: 'GET',
      url: `/agent-connection-setups/${SETUP.id}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      setup_id: SETUP.id,
      status: 'active',
      approval: {
        status: 'confirmed',
        safe_tx_hash: SAFE_TX_HASH,
      },
    })
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes("status = 'active'"))).toBe(true)

    await app.close()
  })

  it('cancels a pre-approval setup under a row lock', async () => {
    const app = await buildApp()
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return { rows: [CONNECTED_SETUP] }
      }
      if (String(sql).includes('UPDATE agent_connection_setups')) {
        return { rows: [{ id: SETUP.id }] }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/cancel`,
    })

    expect(response.statusCode).toBe(200)
    const lockedRead = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('FROM agent_connection_setups'),
    )
    expect(String(lockedRead?.[0])).toContain('FOR UPDATE OF s')
    const cancelUpdate = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE agent_connection_setups'),
    )
    expect(String(cancelUpdate?.[0])).toContain("status IN ('awaiting_connection', 'connected_local', 'awaiting_wallet_approval')")
    expect(String(cancelUpdate?.[0])).toContain('safe_tx_hash IS NULL')

    await app.close()
  })

  it('rejects cancellation after wallet approval is proposed or submitted', async () => {
    const app = await buildApp()
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return {
          rows: [{
            ...CONNECTED_SETUP,
            status: 'proposed',
            approval_status: 'proposed',
            safe_tx_hash: SAFE_TX_HASH,
          }],
        }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/cancel`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/paused or revoked/)
    expect(mockClientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE agent_connection_setups'))).toBe(false)

    await app.close()
  })

  it('rejects cancelled setup tokens for install status updates', async () => {
    const app = await buildApp()
    primeDb(setupByIdAndTokenHash({ ...SETUP, status: 'cancelled' }))

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/install-status`,
      payload: {
        setup_token: 'hv_setup_test',
        hosted_mcp_configured: true,
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Invalid setup status credential')

    await app.close()
  })

  it('rejects private key fields in setup requests', async () => {
    const app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_test',
        challenge_id: SETUP.challenge_id,
        delegate_address: '0x1111111111111111111111111111111111111111',
        proof_signature: '0x',
        delegate_key: '0xsecret',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('rejects plaintext API keys in registration requests', async () => {
    const app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_test',
        challenge_id: SETUP.challenge_id,
        delegate_address: '0x1111111111111111111111111111111111111111',
        proof_signature: '0x',
        api_key: 'sk_agent_secret',
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
      },
    })

    expect(response.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('lets a pending setup API key update install status without credential material', async () => {
    const app = await buildApp()
    primeDb(
      setupByAgentApiKey({ ...SETUP, status: 'connected_local', agent_id: 'agent-1' }),
      mergeInstallStatusResult({
        runtime_mcp_mode: 'local_stdio',
        hosted_mcp_configured: false,
        local_signer_configured: true,
        local_mcp_configured: true,
        local_mcp_acknowledged: true,
        activation_command_available: true,
        error_code: null,
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/install-status`,
      headers: { authorization: 'Bearer sk_agent_pending' },
      payload: {
        runtime_mcp_mode: 'local_stdio',
        hosted_mcp_configured: false,
        local_signer_configured: true,
        local_mcp_configured: true,
        local_mcp_acknowledged: true,
        activation_command_available: true,
        restart_required: true,
        error_code: null,
        environment_label: 'Local workspace',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().install_status.runtime_mcp_mode).toBe('local_stdio')
    expect(response.json().install_status.hosted_mcp_configured).toBe(false)
    expect(response.json().install_status.local_mcp_configured).toBe(true)
    expect(response.json().install_status.local_mcp_acknowledged).toBe(true)
    expect(response.json().install_status.activation_command_available).toBe(true)
    expect(response.json().install_status.error_code).toBeNull()
    expect(String(mockQuery.mock.calls[0][0])).toContain("a.status IN ($3, $4, $5)")
    expect(mockQuery.mock.calls[0][1]).toContain('pending_approval')

    await app.close()
  })

  it('rejects consumed setup tokens for install status updates', async () => {
    const app = await buildApp()
    primeDb(setupByIdAndTokenHash({
      ...SETUP,
      status: 'connected_local',
      setup_token_consumed_at: '2026-06-03T12:00:00.000Z',
    }))

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/install-status`,
      payload: {
        setup_token: 'hv_setup_test',
        hosted_mcp_configured: true,
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Invalid setup status credential')

    await app.close()
  })

  it('rejects expired setup tokens for install status updates', async () => {
    const app = await buildApp()
    primeDb(setupByIdAndTokenHash({
      ...SETUP,
      setup_token_expires_at: '2000-01-01T00:00:00.000Z',
    }))

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/install-status`,
      payload: {
        setup_token: 'hv_setup_test',
        hosted_mcp_configured: true,
      },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Invalid setup status credential')

    await app.close()
  })

  it('accepts a valid pre-registration setup token from the setup-token header for install status', async () => {
    const app = await buildApp()
    primeDb(
      setupByIdAndTokenHash(SETUP),
      mergeInstallStatusResult({
        hosted_mcp_configured: false,
        last_probe_at: '2026-06-03T12:00:00.000Z',
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/install-status`,
      headers: { 'x-haven-setup-token': 'hv_setup_test' },
      payload: {
        hosted_mcp_configured: false,
        probe_result: 'not_ready',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().install_status.hosted_mcp_configured).toBe(false)

    await app.close()
  })

  it('rejects credential material in install status reports', async () => {
    const app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/install-status`,
      payload: {
        setup_token: 'hv_setup_test',
        hosted_mcp_configured: true,
        private_key: '0xsecret',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })
})

describe('setup allowance cap on the delegation rail (#1074)', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockConnect.mockReset()
    mockClientQuery.mockReset()
    mockClientQuery.mockResolvedValue({ rows: [] })
    mockConnect.mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: vi.fn(),
    })
  })

  const SECOND_ALLOWANCE = { ...ALLOWANCE, token_address: '0x' + '3b'.repeat(20), token_symbol: 'EURe' }

  it('rejects >1 allowance on a delegator_hybrid wallet at CREATE — not as a dead end at approval', async () => {
    const app = await buildApp()
    primeDb(safeLookup({ ...SAFE, account_type: 'delegator_hybrid' }))
    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      headers: { authorization: 'Bearer user-jwt' },
      payload: { name: 'Agent', runtime: 'claude_code', allowances: [ALLOWANCE, SECOND_ALLOWANCE] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/one budget per agent/)
    // Nothing was persisted:
    expect(mockClientQuery.mock.calls.some((c) => /INSERT INTO agent_connection_setups/.test(String(c[0])))).toBe(false)
  })

  it('a single allowance on the delegation rail is accepted', async () => {
    const app = await buildApp()
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM user_safes')) return { rows: [{ ...SAFE, account_type: 'delegator_hybrid' }] }
      return { rows: [] }
    })
    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      headers: { authorization: 'Bearer user-jwt' },
      payload: { name: 'Agent', runtime: 'claude_code', allowances: [ALLOWANCE] },
    })
    expect(response.statusCode).toBe(201)
  })

  it('the legacy Safe rail still accepts multiple allowances — unchanged', async () => {
    const app = await buildApp()
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM user_safes')) return { rows: [{ ...SAFE, account_type: null }] }
      return { rows: [] }
    })
    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      headers: { authorization: 'Bearer user-jwt' },
      payload: { name: 'Agent', runtime: 'claude_code', allowances: [ALLOWANCE, SECOND_ALLOWANCE] },
    })
    expect(response.statusCode).toBe(201)
  })
})

describe('delegation-rail budget approval (#1073)', () => {
  const DELEGATION_SETUP = { ...CONNECTED_SETUP, account_type: 'delegator_hybrid' }
  /** The signed budget that satisfies ALLOWANCE: same token, amount, period. */
  const MATCHING_DELEGATION = {
    token_address: ALLOWANCE.token_address.toLowerCase(),
    budget_atomic: ALLOWANCE.allowance_amount,
    period_seconds: ALLOWANCE.reset_period_min * 60,
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
  })

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify()
    await app.register(agentConnectionSetupRoutes, { prefix: '/agent-connection-setups' })
    await app.ready()
    return app
  }

  function approve(app: FastifyInstance) {
    return app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/budget-approval`,
      payload: {},
    })
  }

  it('activates the setup and the agent once the owner-signed budget exists', async () => {
    const app = await buildApp()
    primeDb(
      setupForUser(DELEGATION_SETUP),
      setupAllowances([ALLOWANCE]),
      activeDelegations([MATCHING_DELEGATION]),
    )
    mockWalletApprovalPersist(DELEGATION_SETUP)

    const response = await approve(app)

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ setup_id: SETUP.id, status: 'active' })

    // No Safe transaction is recorded on this rail — the signature IS the
    // approval, and there is no tx hash to carry.
    const setupUpdate = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE agent_connection_setups'),
    )
    expect(setupUpdate?.[1]).toEqual([SETUP.id, 'user-1', 'active', 'confirmed', null, null, null])
    const agentUpdate = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE agents'),
    )
    expect(String(agentUpdate?.[0])).toContain("status = 'active'")

    await app.close()
  })

  it('refuses to activate when no signed budget exists — the client cannot assert one', async () => {
    const app = await buildApp()
    primeDb(setupForUser(DELEGATION_SETUP), setupAllowances([ALLOWANCE]), activeDelegations([]))

    const response = await approve(app)

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/not been approved yet/)
    // Nothing written: no transaction was even opened.
    expect(mockConnect).not.toHaveBeenCalled()

    await app.close()
  })

  it('refuses a signed budget that does not match the amount the user reviewed', async () => {
    const app = await buildApp()
    primeDb(
      setupForUser(DELEGATION_SETUP),
      setupAllowances([ALLOWANCE]),
      activeDelegations([{ ...MATCHING_DELEGATION, budget_atomic: '99000000' }]),
    )

    const response = await approve(app)

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/budget does not match/)
    expect(mockConnect).not.toHaveBeenCalled()

    await app.close()
  })

  it('refuses a signed budget whose period does not match the setup', async () => {
    const app = await buildApp()
    primeDb(
      setupForUser(DELEGATION_SETUP),
      setupAllowances([ALLOWANCE]),
      // Weekly instead of the daily budget the user reviewed.
      activeDelegations([{ ...MATCHING_DELEGATION, period_seconds: 604_800 }]),
    )

    const response = await approve(app)

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/reset period does not match/)
    expect(mockConnect).not.toHaveBeenCalled()

    await app.close()
  })

  it('rejects a legacy Safe account — that rail approves with a wallet transaction', async () => {
    const app = await buildApp()
    primeDb(setupForUser({ ...CONNECTED_SETUP, account_type: 'safe' }))

    const response = await approve(app)

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/wallet transaction/)
    expect(mockConnect).not.toHaveBeenCalled()

    await app.close()
  })

  it('requires the local connection before the budget can approve the setup', async () => {
    const app = await buildApp()
    primeDb(
      setupForUser({ ...DELEGATION_SETUP, status: 'awaiting_connection' }),
      setupAllowances([ALLOWANCE]),
    )

    const response = await approve(app)

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/Local connection is required/)
    expect(mockConnect).not.toHaveBeenCalled()

    await app.close()
  })
})

describe('delegation-rail budget approval — credential hygiene (#1073)', () => {
  it('refuses credential material even though the body is ignored', async () => {
    const app = Fastify()
    await app.register(agentConnectionSetupRoutes, { prefix: '/agent-connection-setups' })
    await app.ready()
    mockQuery.mockReset()

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/budget-approval`,
      payload: { private_key: '0xsecret' },
    })

    expect(response.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })
})

describe('cancel cannot orphan a live delegation-rail agent (#1073)', () => {
  const DELEGATION_SETUP = { ...CONNECTED_SETUP, account_type: 'delegator_hybrid' }

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
  })

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify()
    await app.register(agentConnectionSetupRoutes, { prefix: '/agent-connection-setups' })
    await app.ready()
    return app
  }

  it('refuses to cancel once the budget signature has activated the agent', async () => {
    // The regression this guards: on this rail the grant activates the agent
    // in its OWN transaction, and no safe_tx_hash/tx_hash is ever written, so
    // the setup still looks cancellable. Cancelling would have reported "this
    // setup can no longer connect an agent" while leaving a live, spending
    // agent behind — the revoke is scoped to 'pending_approval' and misses it.
    const app = await buildApp()
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return { rows: [DELEGATION_SETUP] }
      }
      if (String(sql).includes('SELECT status FROM agents')) {
        return { rows: [{ status: 'active' }] }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/cancel`,
      payload: {},
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/paused or revoked from the agent page/)
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK')
    // The setup must NOT have been marked cancelled.
    expect(
      mockClientQuery.mock.calls.some(([sql]) =>
        String(sql).includes("SET status = 'cancelled'"),
      ),
    ).toBe(false)

    await app.close()
  })

  it('still cancels a setup whose agent never became active', async () => {
    const app = await buildApp()
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) {
        return { rows: [DELEGATION_SETUP] }
      }
      if (String(sql).includes('SELECT status FROM agents')) {
        return { rows: [{ status: 'pending_approval' }] }
      }
      if (String(sql).includes("SET status = 'cancelled'")) {
        return { rows: [{ id: SETUP.id }] }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/cancel`,
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT')

    await app.close()
  })

  it('accepts a PINNED budget as satisfying the setup — narrower authority is safe', async () => {
    // The one comparison verifyDelegationSetupAuthority deliberately skips.
    // A recipient-pinned budget grants strictly LESS than the unpinned budget
    // the setup described, so it must still activate rather than 409.
    const app = await buildApp()
    primeDb(
      setupForUser(DELEGATION_SETUP),
      setupAllowances([ALLOWANCE]),
      activeDelegations([{
        token_address: ALLOWANCE.token_address.toLowerCase(),
        budget_atomic: ALLOWANCE.allowance_amount,
        period_seconds: ALLOWANCE.reset_period_min * 60,
        recipient_address: '0x' + 'cc'.repeat(20),
      }]),
    )
    mockWalletApprovalPersist(DELEGATION_SETUP)

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/budget-approval`,
      payload: {},
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'active' })

    await app.close()
  })
})

/**
 * Characterization for the query paths #985 extracts into
 * `infra/repositories/agent-connection-setups.ts`.
 *
 * Written BEFORE the extraction, deliberately asserting the SQL shape and the
 * parameter POSITIONS rather than only the HTTP result: the point of a
 * characterization suite for a data-access refactor is to fail if a query's
 * scoping, ordering or transaction discipline changes, and an assertion that
 * only reads the status code cannot see any of that.
 *
 * These paths were the coverage holes — every pre-existing test passed an
 * explicit `safe_id`, so the default-wallet query had never been executed by
 * the suite at all.
 */
describe('data access characterization (#985)', () => {
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
    mockGetTokenAllowance.mockReset()
    mockGetTokensForDelegate.mockReset()
    mockRequestPassport.mockReset().mockResolvedValue(true)
    mockIssueBestEffort.mockReset()
  })

  it('falls back to the default Haven wallet when no safe_id is supplied', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      headers: { authorization: 'Bearer user-jwt' },
      payload: { name: 'Agent', runtime: 'claude-code', allowances: [ALLOWANCE] },
    })

    expect(response.statusCode).toBe(201)
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain('FROM user_safes')
    // The tenant predicate is asserted in the SQL, not merely in the params:
    // the params come from the CALL SITE and stay `['user-1']` even if the
    // `user_id` clause is deleted from the query — a mutation that silently
    // returns another tenant's default wallet. Assert the clause itself.
    expect(String(sql)).toContain('WHERE user_id = $1')
    expect(String(sql)).toContain('is_default = true')
    expect(params).toEqual(['user-1'])
    await app.close()
  })

  it('scopes an explicit safe_id to the calling user', async () => {
    const app = await buildApp()
    primeDb(safeLookup())

    await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      headers: { authorization: 'Bearer user-jwt' },
      payload: { name: 'Agent', safe_id: SAFE.id, runtime: 'claude-code', allowances: [ALLOWANCE] },
    })

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain('WHERE id = $1 AND user_id = $2')
    expect(params).toEqual([SAFE.id, 'user-1'])
    await app.close()
  })

  it('reads a setup for its owner only — user_id is part of every user-facing lookup', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValue({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: `/agent-connection-setups/${SETUP.id}`,
      headers: { authorization: 'Bearer user-jwt' },
    })

    expect(response.statusCode).toBe(404)
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(String(sql)).toContain('s.id = $1 AND s.user_id = $2')
    expect(params).toEqual([SETUP.id, 'user-1'])
    await app.close()
  })

  it('records connector version and runtime on resolve, and skips the write when neither is sent', async () => {
    const app = await buildApp()
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('UPDATE agent_connection_setups')) return { rows: [] }
      if (String(sql).includes('agent_connection_setup_allowances')) return { rows: [ALLOWANCE] }
      return { rows: [SETUP] }
    })

    await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/resolve',
      payload: { setup_token: 'hv_setup_abc', connector_version: '0.1.0', runtime: 'claude-code' },
    })

    const update = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('UPDATE agent_connection_setups'),
    )
    expect(update).toBeTruthy()
    expect(String(update?.[0])).toContain('COALESCE($2, connector_version)')
    expect(update?.[1]).toEqual([SETUP.id, '0.1.0', 'claude-code'])

    mockQuery.mockClear()
    await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/resolve',
      payload: { setup_token: 'hv_setup_abc' },
    })
    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE agent_connection_setups')),
    ).toBe(false)

    await app.close()
  })

  it('rolls back and writes nothing when registration fails validation inside the transaction', async () => {
    const app = await buildApp()
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) return { rows: [SETUP] }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_abc',
        challenge_id: SETUP.challenge_id,
        delegate_address: DELEGATE_ADDRESS,
        proof_signature: `0x${'1'.repeat(130)}`,
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
      },
    })

    expect(response.statusCode).toBe(400)
    const statements = mockClientQuery.mock.calls.map(([sql]) => String(sql))
    expect(statements).toContain('BEGIN')
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(statements.some((sql) => /INSERT INTO agents/.test(sql))).toBe(false)
    expect(mockClientRelease).toHaveBeenCalled()
    await app.close()
  })

  it('locks the setup row before consuming the token on register', async () => {
    const app = await buildApp()
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) return { rows: [SETUP] }
      return { rows: [] }
    })

    await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: { setup_token: 'hv_setup_abc', challenge_id: 'wrong', delegate_address: DELEGATE_ADDRESS,
        proof_signature: `0x${'1'.repeat(130)}`, api_key_hash: API_KEY_HASH, api_key_prefix: API_KEY_PREFIX },
    })

    const select = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('FROM agent_connection_setups'),
    )
    expect(String(select?.[0])).toContain('FOR UPDATE OF s')
    expect(String(select?.[0])).toContain('s.setup_token_hash = $1')
    await app.close()
  })

  /**
   * Every early exit inside the register transaction must ROLLBACK, not COMMIT.
   * Asserted branch by branch rather than once: the refactor routes all of them
   * through a single mechanism, and a table here is what proves the mechanism
   * did not quietly convert one of them into a committed empty transaction.
   */
  it.each([
    ['setup not found under the lock', {}, 401, null],
    ['setup already consumed', {}, 409, { ...SETUP, setup_token_consumed_at: '2026-01-01T00:00:00.000Z' }],
    ['setup no longer awaiting connection', {}, 409, { ...SETUP, status: 'connected_local' }],
    ['expired setup token', {}, 410, { ...SETUP, setup_token_expires_at: '2000-01-01T00:00:00.000Z' }],
    ['invalid challenge', { challenge_id: 'wrong' }, 400, SETUP],
    ['malformed signing address', { delegate_address: 'not-an-address' }, 400, SETUP],
    ['invalid proof signature', { proof_signature: `0x${'9'.repeat(130)}` }, 400, SETUP],
    ['malformed api key hash', { api_key_hash: 'short' }, 400, SETUP],
    ['malformed api key prefix', { api_key_prefix: 42 }, 400, SETUP],
  ])('rolls back the register transaction on %s', async (_label, override, expected, row) => {
    const app = await buildApp()
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) return { rows: row ? [row] : [] }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_abc',
        challenge_id: SETUP.challenge_id,
        delegate_address: DELEGATE_ADDRESS,
        proof_signature: `0x${'1'.repeat(130)}`,
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
        ...override,
      },
    })

    expect(response.statusCode).toBe(expected)
    const statements = mockClientQuery.mock.calls.map(([sql]) => String(sql))
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(statements.some((sql) => /INSERT INTO agents/.test(sql))).toBe(false)
    await app.close()
  })

  it('authenticates an install-status report by API key against the setup and allowed agent states', async () => {
    const app = await buildApp()
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('JOIN agents a')) return { rows: [{ ...CONNECTED_SETUP }] }
      if (String(sql).includes('UPDATE agent_connection_setups')) {
        return { rows: [{ install_status: { hosted_mcp_configured: true } }] }
      }
      return { rows: [] }
    })

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/install-status`,
      headers: { authorization: 'Bearer sk_agent_live_key' },
      payload: { hosted_mcp_configured: true },
    })

    expect(response.statusCode).toBe(200)
    const auth = mockQuery.mock.calls.find(([sql]) => String(sql).includes('JOIN agents a'))
    expect(String(auth?.[0])).toContain('WHERE s.id = $1 AND a.api_key_hash = $2')
    expect((auth?.[1] as unknown[])[0]).toBe(SETUP.id)
    expect((auth?.[1] as unknown[]).slice(2)).toEqual(['pending_approval', 'active', 'paused'])
    await app.close()
  })

  it('reads the active delegations for a budget approval scoped to the setup agent', async () => {
    const app = await buildApp()
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_delegations')) return { rows: [] }
      if (String(sql).includes('agent_connection_setup_allowances')) return { rows: [ALLOWANCE] }
      return { rows: [{ ...CONNECTED_SETUP, account_type: 'delegator_hybrid' }] }
    })

    const response = await app.inject({
      method: 'POST',
      url: `/agent-connection-setups/${SETUP.id}/budget-approval`,
      headers: { authorization: 'Bearer user-jwt' },
      payload: {},
    })

    expect(response.statusCode).toBe(409)
    const read = mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM agent_delegations'))
    expect(String(read?.[0])).toContain("status = 'active'")
    expect(read?.[1]).toEqual(['agent-1'])
    await app.close()
  })
})

/**
 * Hosted MCP URL resolution matrix (#1129).
 *
 * A non-production backend must never hand out the PRODUCTION hosted MCP URL
 * as a silent default: the hosted MCP relays to exactly one backend fixed at
 * deploy time, so a dev/local-issued sk_agent_ key sent there is looked up in
 * the prod database and 401s with a message blaming the key. The rule under
 * test: explicit variable wins → prod self-URL earns the built-in default →
 * everything else is a LOUD 500 configuration error naming the variable, and
 * — on /register — one that fires BEFORE the transaction so the one-shot
 * setup token is not consumed and no agent row is half-created.
 */
describe('hosted MCP URL resolution (#1129)', () => {
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
    mockRequestPassport.mockReset().mockResolvedValue(true)
    mockIssueBestEffort.mockReset()
  })

  function mockResolveQueries() {
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('UPDATE agent_connection_setups')) return { rows: [] }
      if (String(sql).includes('agent_connection_setup_allowances')) return { rows: [ALLOWANCE] }
      return { rows: [SETUP] }
    })
  }

  function resolvePayload() {
    return { setup_token: 'hv_setup_abc', connector_version: '0.1.0', runtime: 'claude-code' }
  }

  async function injectResolve(app: FastifyInstance) {
    return app.inject({
      method: 'POST',
      url: '/agent-connection-setups/resolve',
      payload: resolvePayload(),
    })
  }

  /** Full happy-path register mocks + payload — with config present it 201s. */
  async function registerSetup() {
    const wallet = new Wallet('0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38')
    const proof = await wallet.signMessage(SETUP.challenge_message)
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) return { rows: [SETUP] }
      if (String(sql).includes('SELECT id FROM agents')) return { rows: [] }
      if (String(sql).includes('INSERT INTO agents')) return { rows: [{ id: 'agent-1' }] }
      return { rows: [] }
    })
    return {
      setup_token: 'hv_setup_abc',
      challenge_id: SETUP.challenge_id,
      delegate_address: wallet.address,
      proof_signature: proof,
      api_key_hash: API_KEY_HASH,
      api_key_prefix: API_KEY_PREFIX,
    }
  }

  it('an explicitly set HAVEN_HOSTED_MCP_URL always wins, on resolve and register (trailing slash stripped)', async () => {
    process.env.HAVEN_HOSTED_MCP_URL = 'https://dev-mcp.example.test/v1/'

    const app = await buildApp()
    mockResolveQueries()
    const resolveResponse = await injectResolve(app)
    expect(resolveResponse.statusCode).toBe(200)
    expect(resolveResponse.json().hosted_mcp_url).toBe('https://dev-mcp.example.test/v1')

    const registerResponse = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: await registerSetup(),
    })
    expect(registerResponse.statusCode).toBe(201)
    expect(registerResponse.json().hosted_mcp_url).toBe('https://dev-mcp.example.test/v1')
    await app.close()
  })

  it('NEXT_PUBLIC_HAVEN_MCP_URL is honoured as the explicit fallback variable', async () => {
    delete process.env.HAVEN_HOSTED_MCP_URL
    process.env.NEXT_PUBLIC_HAVEN_MCP_URL = 'https://mcp-from-public-var.test/v1'

    const app = await buildApp()
    mockResolveQueries()
    const response = await injectResolve(app)
    expect(response.statusCode).toBe(200)
    expect(response.json().hosted_mcp_url).toBe('https://mcp-from-public-var.test/v1')
    await app.close()
  })

  it('unset variables + production self-URL still serve the built-in default — prod needs no config change', async () => {
    delete process.env.HAVEN_HOSTED_MCP_URL
    process.env.HAVEN_API_URL = PROD_API_URL

    const app = await buildApp()
    mockResolveQueries()
    const resolveResponse = await injectResolve(app)
    expect(resolveResponse.statusCode).toBe(200)
    expect(resolveResponse.json().hosted_mcp_url).toBe(PROD_DEFAULT_HOSTED_MCP_URL)

    const registerResponse = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: await registerSetup(),
    })
    expect(registerResponse.statusCode).toBe(201)
    expect(registerResponse.json().hosted_mcp_url).toBe(PROD_DEFAULT_HOSTED_MCP_URL)
    await app.close()
  })

  it('unset variables + dev self-URL fail register with a 500 naming the variable — and write NOTHING', async () => {
    delete process.env.HAVEN_HOSTED_MCP_URL
    process.env.HAVEN_API_URL = 'https://havenbackend-dev-8b95.up.railway.app'

    const app = await buildApp()
    // Identical mocks/payload to the 201 happy path — proving the refusal is
    // the configuration guard, not some validation failure.
    const payload = await registerSetup()
    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload,
    })

    expect(response.statusCode).toBe(500)
    expect(response.json().error).toContain('HAVEN_HOSTED_MCP_URL')
    expect(response.json().error).toContain('--local')
    expect(response.json().error).toContain('havenbackend-dev-8b95.up.railway.app')
    // The guard fires BEFORE the transaction opens: the setup token was not
    // locked or consumed, no agent row was inserted — not even BEGIN ran.
    expect(mockConnect).not.toHaveBeenCalled()
    expect(mockClientQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('unset variables + dev self-URL fail resolve with the same 500, before the connector-metadata write', async () => {
    delete process.env.HAVEN_HOSTED_MCP_URL
    process.env.HAVEN_API_URL = 'https://havenbackend-dev-8b95.up.railway.app'

    const app = await buildApp()
    mockResolveQueries()
    const response = await injectResolve(app)

    expect(response.statusCode).toBe(500)
    expect(response.json().error).toContain('HAVEN_HOSTED_MCP_URL')
    // The payload carried connector_version/runtime, so a pass-through would
    // have written connector metadata — the config error must precede it.
    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE agent_connection_setups')),
    ).toBe(false)
    await app.close()
  })

  it('unset variables + localhost self-URL fail the same way — local dev is pointed at --local, not at prod', async () => {
    delete process.env.HAVEN_HOSTED_MCP_URL
    // No HAVEN_API_URL: the self-URL falls back to the request host, which is
    // localhost under inject — exactly the local-dev backend case.

    const app = await buildApp()
    mockResolveQueries()
    const resolveResponse = await injectResolve(app)
    expect(resolveResponse.statusCode).toBe(500)
    expect(resolveResponse.json().error).toContain('HAVEN_HOSTED_MCP_URL')
    expect(resolveResponse.json().error).toContain('--local')

    const registerResponse = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: await registerSetup(),
    })
    expect(registerResponse.statusCode).toBe(500)
    expect(registerResponse.json().error).toContain('HAVEN_HOSTED_MCP_URL')
    expect(mockConnect).not.toHaveBeenCalled()
    await app.close()
  })
})

/**
 * `GET /:setupId/connector-status` (#1377 part D) — the narrow endpoint the
 * `@haven_ai/connect` connector polls after /register to learn when the user
 * approves the budget. Authenticated by the agent API key /register minted
 * (Bearer sk_agent_…) rather than `authMiddleware` or the setup token — a
 * `pending_approval` agent's key must work here even though the ordinary
 * `agentAuthMiddleware` refuses that status outright (#1130).
 */
describe('GET /:setupId/connector-status (#1377 part D)', () => {
  const AGENT_AUTH_ROW = {
    id: 'agent-1',
    user_id: 'user-1',
    name: 'Research Agent',
    delegate_address: DELEGATE_ADDRESS,
    safe_address: SAFE.safe_address,
    chain_id: SAFE.chain_id,
    status: 'pending_approval',
    execution_rail: 'delegation',
    account_type: 'delegator_hybrid',
  }

  const PENDING_SETUP = {
    ...CONNECTED_SETUP,
    agent_id: 'agent-1',
    status: 'awaiting_wallet_approval',
  }

  const ACTIVE_SETUP = {
    ...CONNECTED_SETUP,
    agent_id: 'agent-1',
    status: 'active',
    approval_status: 'confirmed',
  }

  /** Matches AGENT_BY_API_KEY_SQL (agent lookup by key hash — no setup join). */
  const agentAuthLookup = (row: Record<string, unknown> | null): DbRoute => [
    /JOIN users u ON a\.user_id = u\.id/,
    () => ({ rows: row ? [row] : [] }),
  ]

  beforeEach(() => {
    mockQuery.mockReset()
    mockConnect.mockReset()
    mockClientQuery.mockReset()
    mockClientRelease.mockReset()
  })

  it('reports pre-approval status with a null approved_budget for the agent that owns the setup', async () => {
    const app = await buildApp()
    primeDb(
      agentAuthLookup(AGENT_AUTH_ROW),
      setupByAgentApiKey(PENDING_SETUP),
      setupAllowances([]),
    )

    const response = await app.inject({
      method: 'GET',
      url: `/agent-connection-setups/${SETUP.id}/connector-status`,
      headers: { authorization: 'Bearer sk_agent_pending_key' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: 'awaiting_wallet_approval',
      approved_budget: null,
    })
    await app.close()
  })

  it('carries the approved budget once the setup is active', async () => {
    const app = await buildApp()
    primeDb(
      agentAuthLookup({ ...AGENT_AUTH_ROW, status: 'active' }),
      setupByAgentApiKey(ACTIVE_SETUP),
      setupAllowances([ALLOWANCE]),
    )

    const response = await app.inject({
      method: 'GET',
      url: `/agent-connection-setups/${SETUP.id}/connector-status`,
      headers: { authorization: 'Bearer sk_agent_active_key' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: 'active',
      approved_budget: {
        token_symbol: ALLOWANCE.token_symbol,
        token_address: ALLOWANCE.token_address,
        amount: ALLOWANCE.allowance_amount,
        reset_period_min: ALLOWANCE.reset_period_min,
      },
    })
    await app.close()
  })

  it('answers 404 — indistinguishable from not-found — for a different agent\'s valid key', async () => {
    const app = await buildApp()
    primeDb(
      // The key belongs to a real, live agent — just not the one this setup
      // is scoped to, so the setup-scoped lookup matches nothing.
      agentAuthLookup({ ...AGENT_AUTH_ROW, id: 'agent-2', status: 'active' }),
      setupByAgentApiKey(null),
    )

    const response = await app.inject({
      method: 'GET',
      url: `/agent-connection-setups/${SETUP.id}/connector-status`,
      headers: { authorization: 'Bearer sk_agent_unrelated_key' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('Setup not found')
    await app.close()
  })

  it('never leaks API keys, setup tokens, or key material in the response', async () => {
    const app = await buildApp()
    const setupWithSecretishFields = {
      ...ACTIVE_SETUP,
      proof_signature: '0xdeadbeefsk_agent_should_not_leak',
      challenge_message: 'setup_token: hv_setup_should_not_leak',
      install_status: { note: 'sk_agent_in_install_status' },
      connector_context: { note: 'sk_agent_in_connector_context' },
      api_key_prefix: 'sk_agent_abc',
      delegate_address: DELEGATE_ADDRESS,
    }
    primeDb(
      agentAuthLookup({ ...AGENT_AUTH_ROW, status: 'active' }),
      setupByAgentApiKey(setupWithSecretishFields),
      setupAllowances([ALLOWANCE]),
    )

    const response = await app.inject({
      method: 'GET',
      url: `/agent-connection-setups/${SETUP.id}/connector-status`,
      headers: { authorization: 'Bearer sk_agent_active_key' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    // Exactly the two documented fields — nothing from the setup row rides
    // along by accident.
    expect(Object.keys(body).sort()).toEqual(['approved_budget', 'status'])
    const serialized = JSON.stringify(body)
    expect(serialized).not.toMatch(/sk_agent_/)
    expect(serialized).not.toMatch(/hv_setup_/)
    expect(serialized).not.toMatch(/delegate_key|private_key|privateKey|proof_signature|setup_token/)
    await app.close()
  })

  it('rejects a request with no API key', async () => {
    const app = await buildApp()

    const response = await app.inject({
      method: 'GET',
      url: `/agent-connection-setups/${SETUP.id}/connector-status`,
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Invalid or revoked API key')
    expect(mockQuery).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a revoked agent\'s key the same as an unrecognised one', async () => {
    const app = await buildApp()
    primeDb(agentAuthLookup({ ...AGENT_AUTH_ROW, status: 'revoked' }))

    const response = await app.inject({
      method: 'GET',
      url: `/agent-connection-setups/${SETUP.id}/connector-status`,
      headers: { authorization: 'Bearer sk_agent_revoked_key' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Invalid or revoked API key')
    await app.close()
  })
})

describe('#1878 the register route seam — body field to stored value', () => {
  // The unit tests above prove normalizeMcpServerName in isolation and the
  // real-DB repository tests prove insertPendingAgent stores what it is given.
  // Neither proves the HANDLER connects them: a body key read under the wrong
  // name, or a value normalized and then not passed on, leaves both green and
  // stores NULL forever.
  const CHALLENGE_KEY = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'

  // This block sits outside the main register describe, so it wires the pool
  // mocks itself; the env vars come from the root beforeEach (#1129).
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
    mockRequestPassport.mockReset().mockResolvedValue(true)
    mockIssueBestEffort.mockReset()
  })

  async function registerWith(mcpServerName: unknown) {
    const app = await buildApp()
    const wallet = new Wallet(CHALLENGE_KEY)
    const proof = await wallet.signMessage(SETUP.challenge_message)
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM agent_connection_setups')) return { rows: [SETUP] }
      if (String(sql).includes('SELECT id FROM agents')) return { rows: [] }
      if (String(sql).includes('INSERT INTO agents')) return { rows: [{ id: 'agent-1' }] }
      return { rows: [] }
    })
    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups/register',
      payload: {
        setup_token: 'hv_setup_test',
        challenge_id: SETUP.challenge_id,
        delegate_address: wallet.address,
        proof_signature: proof,
        api_key_hash: API_KEY_HASH,
        api_key_prefix: API_KEY_PREFIX,
        runtime: 'claude-code',
        ...(mcpServerName === undefined ? {} : { mcp_server_name: mcpServerName }),
      },
    })
    const insertAgent = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO agents'),
    )
    await app.close()
    return { statusCode: response.statusCode, params: insertAgent?.[1] as unknown[] }
  }

  it('carries a named pair from the request body into the insert', async () => {
    const { statusCode, params } = await registerWith('haven-research')
    expect(statusCode).toBe(201)
    expect(params).toContain('haven-research')
  })

  it('carries the bare pair as a value, not as an omission', async () => {
    const { statusCode, params } = await registerWith('haven')
    expect(statusCode).toBe(201)
    expect(params).toContain('haven')
  })

  it('stores NULL when an older connector sends nothing — and still registers', async () => {
    const { statusCode, params } = await registerWith(undefined)
    expect(statusCode).toBe(201)
    // The last bound parameter is the server name; absent must reach the
    // insert as NULL rather than undefined, which pg would reject.
    expect(params?.[params.length - 1]).toBeNull()
  })

  it('registers successfully even when the reported name is garbage', async () => {
    // The direction that matters: a bad label must never cost the user an
    // agent. 201, and NULL in the column.
    const { statusCode, params } = await registerWith('<script>alert(1)</script>')
    expect(statusCode).toBe(201)
    expect(params?.[params.length - 1]).toBeNull()
  })
})

describe('#1878 normalizeMcpServerName — the connector\'s self-reported wiring label', () => {
  it('accepts the bare pair and a named pair', () => {
    expect(normalizeMcpServerName('haven')).toBe('haven')
    expect(normalizeMcpServerName('haven-research')).toBe('haven-research')
    expect(normalizeMcpServerName('haven-team-2')).toBe('haven-team-2')
  })

  it('degrades anything unrecognized to NULL rather than refusing the registration', () => {
    // The direction matters. This is a LABEL: a wrong one is a wrong caption,
    // and NULL already renders honestly as "not recorded". Throwing here would
    // fail a whole agent registration — key minted, config written — over a
    // display string, which is a far worse outcome than a missing caption.
    expect(normalizeMcpServerName(undefined)).toBeNull()
    expect(normalizeMcpServerName(null)).toBeNull()
    expect(normalizeMcpServerName(42)).toBeNull()
    expect(normalizeMcpServerName({ toString: () => 'haven' })).toBeNull()
    expect(normalizeMcpServerName('')).toBeNull()
    expect(normalizeMcpServerName('   ')).toBeNull()
    expect(normalizeMcpServerName('not-a-haven-name')).toBeNull()
    expect(normalizeMcpServerName('haven-Research')).toBeNull() // slugs are lowercase
    expect(normalizeMcpServerName('haven-')).toBeNull()
    expect(normalizeMcpServerName('haven--x')).toBeNull()
    expect(normalizeMcpServerName('haven-' + 'x'.repeat(100))).toBeNull()
  })

  it('refuses anything that could break out of a label', () => {
    // It reaches a dashboard and a copy button, so the shapes worth naming
    // are the ones that would stop being text there.
    expect(normalizeMcpServerName('haven-<script>')).toBeNull()
    expect(normalizeMcpServerName('haven-a\nhaven-b')).toBeNull()
    expect(normalizeMcpServerName('haven-a\u0000')).toBeNull()
    expect(normalizeMcpServerName('../../etc/passwd')).toBeNull()
  })

  it('trims surrounding whitespace rather than storing it', () => {
    expect(normalizeMcpServerName('  haven-work  ')).toBe('haven-work')
  })
})
