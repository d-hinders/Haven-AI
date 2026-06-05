import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Wallet } from 'ethers'
import agentConnectionSetupRoutes from '../agent-connection-setups.js'

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

vi.mock('../../lib/allowance-module.js', () => ({
  getTokenAllowance: (...args: unknown[]) => mockGetTokenAllowance(...args),
  getTokensForDelegate: (...args: unknown[]) => mockGetTokensForDelegate(...args),
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

const API_KEY_HASH = 'a'.repeat(64)
const API_KEY_PREFIX = 'sk_agent_abc'
const DELEGATE_ADDRESS = '0x3333333333333333333333333333333333333333'
const TX_HASH = `0x${'a'.repeat(64)}`
const SAFE_TX_HASH = `0x${'b'.repeat(64)}`
const ALLOWANCE_MODULE_ADDRESS = '0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134'

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
    delete process.env.HAVEN_API_URL
    delete process.env.HAVEN_HOSTED_MCP_URL
    delete process.env.CONNECT_AGENT_2_ENABLED
  })

  it('creates a pending setup with a returned-once token stored only as a hash', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValueOnce({ rows: [SAFE] })

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
    expect(body.connector_command).toContain('npx -y @haven_ai/connect@0.1.3-alpha')
    expect(body.connector_command).toContain('--ack-local-tools')
    expect(body.setup_prompt).toContain('I approve running this exact Haven setup command')
    expect(body.setup_prompt).toContain('download and execute the published npm package @haven_ai/connect@0.1.3-alpha')
    expect(body.setup_prompt).toContain('connect to Haven at http://localhost:80')
    expect(body.setup_prompt).toContain('write local Haven credential files under ~/.haven')
    expect(body.setup_prompt).toContain('update the local agent MCP config when supported')
    expect(body.setup_prompt).toContain('Run this exact command:')
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

    await app.close()
  })

  it('includes Codex Desktop runtime in the generated setup command', async () => {
    const app = await buildApp()
    mockQuery.mockResolvedValueOnce({ rows: [SAFE] })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        runtime: 'codex-desktop',
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.connector_command).toContain('--ack-local-tools')
    expect(body.connector_command).toContain('--runtime codex-desktop')
    expect(body.setup_prompt).toContain('I approve running this exact Haven setup command')
    expect(body.setup_prompt).toContain('update Codex MCP config under ~/.codex/config.toml')
    expect(body.setup_prompt).toContain('Do not print private keys, API keys, credential file contents, or config secrets')
    expect(body.setup_prompt).not.toMatch(/delegate_key|private_key|sk_agent_/)

    await app.close()
  })

  it('creates a pending setup when the rollout gate is explicitly enabled', async () => {
    process.env.CONNECT_AGENT_2_ENABLED = 'true'
    const app = await buildApp()
    mockQuery.mockResolvedValueOnce({ rows: [SAFE] })

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ status: 'awaiting_connection' })

    await app.close()
  })

  it.each(['false', '0', 'off'])('blocks new pending setup creation when the rollout gate is %s', async (gateValue) => {
    process.env.CONNECT_AGENT_2_ENABLED = gateValue
    const app = await buildApp()

    const response = await app.inject({
      method: 'POST',
      url: '/agent-connection-setups',
      payload: {
        name: 'Research Agent',
        safe_id: SAFE.id,
        allowances: [ALLOWANCE],
      },
    })

    expect(response.statusCode).toBe(404)
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()

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
    const resolved = resolveResponse.json()
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
    mockQuery
      .mockResolvedValueOnce({ rows: [SETUP] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [ALLOWANCE] })

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
    mockQuery
      .mockResolvedValueOnce({ rows: [CONNECTED_SETUP] })
      .mockResolvedValueOnce({ rows: [ALLOWANCE] })
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
    mockQuery
      .mockResolvedValueOnce({ rows: [CONNECTED_SETUP] })
      .mockResolvedValueOnce({ rows: [ALLOWANCE] })
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
    mockQuery
      .mockResolvedValueOnce({ rows: [CONNECTED_SETUP] })
      .mockResolvedValueOnce({ rows: [ALLOWANCE] })
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
    mockQuery
      .mockResolvedValueOnce({ rows: [CONNECTED_SETUP] })
      .mockResolvedValueOnce({ rows: [ALLOWANCE] })
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
    mockQuery
      .mockResolvedValueOnce({ rows: [CONNECTED_SETUP] })
      .mockResolvedValueOnce({ rows: [ALLOWANCE] })
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
    mockQuery
      .mockResolvedValueOnce({ rows: [CONNECTED_SETUP] })
      .mockResolvedValueOnce({ rows: [ALLOWANCE] })
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
    mockQuery
      .mockResolvedValueOnce({ rows: [CONNECTED_SETUP] })
      .mockResolvedValueOnce({ rows: [ALLOWANCE] })
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
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          ...CONNECTED_SETUP,
          status: 'active',
          approval_status: 'confirmed',
          tx_hash: TX_HASH,
          safe_tx_hash: SAFE_TX_HASH,
        }],
      })
      .mockResolvedValueOnce({ rows: [ALLOWANCE] })

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
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          ...CONNECTED_SETUP,
          status: 'proposed',
          approval_status: 'proposed',
          safe_tx_hash: SAFE_TX_HASH,
        }],
      })
      .mockResolvedValueOnce({ rows: [ALLOWANCE] })
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
    mockQuery.mockResolvedValueOnce({
      rows: [{
        ...SETUP,
        status: 'cancelled',
      }],
    })

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
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...SETUP, status: 'connected_local', agent_id: 'agent-1' }] })
      .mockResolvedValueOnce({
        rows: [{
          install_status: {
            runtime_mcp_mode: 'local_stdio',
            hosted_mcp_configured: false,
            local_signer_configured: true,
            local_mcp_configured: true,
            local_mcp_acknowledged: true,
            activation_command_available: true,
            error_code: null,
          },
        }],
      })

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
    mockQuery.mockResolvedValueOnce({
      rows: [{
        ...SETUP,
        status: 'connected_local',
        setup_token_consumed_at: '2026-06-03T12:00:00.000Z',
      }],
    })

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
    mockQuery.mockResolvedValueOnce({
      rows: [{
        ...SETUP,
        setup_token_expires_at: '2000-01-01T00:00:00.000Z',
      }],
    })

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
    mockQuery
      .mockResolvedValueOnce({ rows: [SETUP] })
      .mockResolvedValueOnce({
        rows: [{
          install_status: {
            hosted_mcp_configured: false,
            last_probe_at: '2026-06-03T12:00:00.000Z',
          },
        }],
      })

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
