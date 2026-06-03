import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import crypto from 'crypto'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import {
  SETUP_TOKEN_TTL_MINUTES,
  apiKeyHash,
  buildSetupChallengeMessage,
  containsForbiddenInstallStatusField,
  containsForbiddenPrivateKeyField,
  generateSetupToken,
  hashSetupSecret,
  isValidAddress,
  sanitizeConnectorContext,
  sanitizeInstallStatus,
  verifySetupProof,
} from '../lib/agent-connection-setup.js'

interface AllowanceInput {
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

interface CreateSetupBody {
  name: string
  description?: string
  safe_id?: string
  runtime?: string
  allowances?: AllowanceInput[]
}

interface ResolveSetupBody {
  setup_token: string
  connector_version?: string
  runtime?: string
}

interface RegisterSetupBody extends ResolveSetupBody {
  challenge_id: string
  delegate_address: string
  proof_signature: string
  api_key_hash: string
  api_key_prefix: string
  connector_context?: unknown
  install_capabilities?: {
    can_write_runtime_config?: boolean
    restart_required?: boolean
  }
}

interface InstallStatusBody {
  setup_token?: string
  runtime?: string
  connector_version?: string
  hosted_mcp_configured?: boolean
  local_signer_configured?: boolean
  credential_files_written?: boolean
  probe_result?: string
  restart_required?: boolean
  next_user_action?: string
  error_code?: string | null
  environment_label?: string
}

interface SetupRow {
  id: string
  user_id: string
  agent_id: string | null
  safe_id: string
  name: string
  description: string | null
  runtime: string | null
  status: string
  setup_token_expires_at: string
  setup_token_consumed_at: string | null
  challenge_id: string
  challenge_message: string
  challenge_expires_at: string
  delegate_address: string | null
  proof_signature: string | null
  api_key_prefix: string | null
  connector_version: string | null
  connector_context: Record<string, unknown>
  install_status: Record<string, unknown>
  approval_status: string
  safe_tx_hash: string | null
  tx_hash: string | null
  failure_reason: string | null
  safe_address: string
  safe_name: string
  safe_chain_id: number
}

interface AllowanceRow {
  id?: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

interface UserSafeRow {
  id: string
  safe_address: string
  name: string
  chain_id: number
}

const DEFAULT_HOSTED_MCP_URL = 'https://haven-ai-production-5953.up.railway.app/v1'

export default async function agentConnectionSetupRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CreateSetupBody }>(
    '/',
    { preHandler: authMiddleware },
    async (request, reply) => {
      if (containsForbiddenPrivateKeyField(request.body)) {
        return reply.code(400).send({ error: 'Private key fields are not accepted by Haven' })
      }

      const { sub } = request.user as { sub: string }
      const parsed = validateCreateBody(request.body, reply)
      if (!parsed) return

      const safe = await resolveUserSafe(sub, request.body.safe_id)
      if (!safe) {
        return reply.code(400).send({ error: 'Haven wallet is required' })
      }

      const setupId = crypto.randomUUID()
      const challengeId = crypto.randomUUID()
      const setupToken = generateSetupToken()
      const expiresAt = addMinutes(new Date(), SETUP_TOKEN_TTL_MINUTES).toISOString()
      const challengeNonce = crypto.randomBytes(16).toString('hex')
      const challengeMessage = buildSetupChallengeMessage({
        setupId,
        challengeId,
        nonce: challengeNonce,
        expiresAt,
      })

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO agent_connection_setups (
             id, user_id, safe_id, name, description, runtime, status,
             setup_token_hash, setup_token_prefix, setup_token_expires_at,
             challenge_id, challenge_message, challenge_expires_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_connection',
                   $7, $8, $9, $10, $11, $12)`,
          [
            setupId,
            sub,
            safe.id,
            parsed.name,
            parsed.description,
            parsed.runtime,
            hashSetupSecret(setupToken),
            setupToken.slice(0, 20),
            expiresAt,
            challengeId,
            challengeMessage,
            expiresAt,
          ],
        )
        for (const allowance of parsed.allowances) {
          await client.query(
            `INSERT INTO agent_connection_setup_allowances (
               setup_id, token_address, token_symbol, allowance_amount, reset_period_min
             )
             VALUES ($1, $2, $3, $4, $5)`,
            [
              setupId,
              allowance.token_address.toLowerCase(),
              allowance.token_symbol,
              allowance.allowance_amount,
              allowance.reset_period_min,
            ],
          )
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      const command = buildConnectorCommand(setupToken, request, parsed.runtime)
      return reply.code(201).send({
        setup_id: setupId,
        status: 'awaiting_connection',
        setup_token: setupToken,
        expires_at: expiresAt,
        connector_command: command,
        setup_prompt: buildSetupPrompt(command),
      })
    },
  )

  app.post<{ Body: ResolveSetupBody }>('/resolve', async (request, reply) => {
    if (containsForbiddenPrivateKeyField(request.body)) {
      return reply.code(400).send({ error: 'Private key fields are not accepted by Haven' })
    }

    const setup = await loadSetupByToken(request.body?.setup_token)
    if (!setup) return reply.code(401).send({ error: 'Invalid setup token' })
    if (setup.status !== 'awaiting_connection') {
      return reply.code(409).send({ error: 'Setup is not awaiting connection' })
    }
    if (isExpired(setup.setup_token_expires_at) || isExpired(setup.challenge_expires_at)) {
      return reply.code(410).send({ error: 'Setup token expired' })
    }

    if (request.body.connector_version || request.body.runtime) {
      await pool.query(
        `UPDATE agent_connection_setups
         SET connector_version = COALESCE($2, connector_version),
             runtime = COALESCE($3, runtime),
             updated_at = NOW()
         WHERE id = $1`,
        [setup.id, stringOrNull(request.body.connector_version), stringOrNull(request.body.runtime)],
      )
    }

    const allowances = await loadSetupAllowances(setup.id)
    return buildConnectorSetupResponse(setup, allowances)
  })

  app.post<{ Body: RegisterSetupBody }>('/register', async (request, reply) => {
    if (
      containsForbiddenPrivateKeyField(request.body) ||
      containsForbiddenInstallStatusField(request.body)
    ) {
      return reply.code(400).send({ error: 'Credential material is not accepted by Haven' })
    }
    if (!request.body?.setup_token || typeof request.body.setup_token !== 'string') {
      return reply.code(401).send({ error: 'Invalid setup token' })
    }

    let agentId = ''
    let setupId = ''
    let apiKeyPrefix = ''
    let delegateAddress = ''
    let hostedMcpUrlValue = ''
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const setupResult = await client.query<SetupRow>(
        `${setupSelectSql('s.setup_token_hash = $1')} FOR UPDATE OF s`,
        [hashSetupSecret(request.body.setup_token)],
      )
      const setup = setupResult.rows[0]
      if (!setup) {
        await client.query('ROLLBACK')
        return reply.code(401).send({ error: 'Invalid setup token' })
      }
      if (setup.status !== 'awaiting_connection' || setup.setup_token_consumed_at) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'Setup is not awaiting connection' })
      }
      if (isExpired(setup.setup_token_expires_at) || isExpired(setup.challenge_expires_at)) {
        await client.query('ROLLBACK')
        return reply.code(410).send({ error: 'Setup token expired' })
      }
      if (request.body.challenge_id !== setup.challenge_id) {
        await client.query('ROLLBACK')
        return reply.code(400).send({ error: 'Invalid challenge' })
      }
      if (!isValidAddress(request.body.delegate_address)) {
        await client.query('ROLLBACK')
        return reply.code(400).send({ error: 'Valid public signing address is required' })
      }
      delegateAddress = request.body.delegate_address.toLowerCase()
      if (!verifySetupProof(setup.challenge_message, request.body.proof_signature, delegateAddress)) {
        await client.query('ROLLBACK')
        return reply.code(400).send({ error: 'Invalid proof signature' })
      }
      if (!isValidSha256Hash(request.body.api_key_hash)) {
        await client.query('ROLLBACK')
        return reply.code(400).send({ error: 'Valid API key hash is required' })
      }
      if (!isValidApiKeyPrefix(request.body.api_key_prefix)) {
        await client.query('ROLLBACK')
        return reply.code(400).send({ error: 'Valid API key prefix is required' })
      }

      const existing = await client.query(
        `SELECT id FROM agents
         WHERE user_id = $1 AND lower(delegate_address) = $2 AND status != 'revoked'
         LIMIT 1`,
        [setup.user_id, delegateAddress],
      )
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ error: 'An agent with this signing address already exists' })
      }

      apiKeyPrefix = request.body.api_key_prefix
      const connectorContext = sanitizeConnectorContext(request.body.connector_context)
      const initialInstallStatus = {
        hosted_mcp_configured: false,
        local_signer_configured: false,
        restart_required: Boolean(request.body.install_capabilities?.restart_required),
      }
      setupId = setup.id
      hostedMcpUrlValue = hostedMcpUrl()

      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO agents (
           user_id, name, description, delegate_address, api_key_hash,
           api_key_prefix, safe_id, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_approval')
         RETURNING id`,
        [
          setup.user_id,
          setup.name,
          setup.description,
          delegateAddress,
          request.body.api_key_hash,
          apiKeyPrefix,
          setup.safe_id,
        ],
      )
      agentId = agentResult.rows[0].id

      await client.query(
        `INSERT INTO agent_allowances (
           agent_id, token_address, token_symbol, allowance_amount, reset_period_min
         )
         SELECT $1, token_address, token_symbol, allowance_amount, reset_period_min
         FROM agent_connection_setup_allowances
         WHERE setup_id = $2`,
        [agentId, setupId],
      )

      await client.query(
        `UPDATE agent_connection_setups
         SET agent_id = $2,
             status = 'connected_local',
             delegate_address = $3,
             proof_signature = $4,
             api_key_prefix = $5,
             connector_version = COALESCE($6, connector_version),
             runtime = COALESCE($7, runtime),
             connector_context = $8::jsonb,
             install_status = $9::jsonb,
             setup_token_consumed_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [
          setupId,
          agentId,
          delegateAddress,
          request.body.proof_signature,
          apiKeyPrefix,
          stringOrNull(request.body.connector_version),
          stringOrNull(request.body.runtime),
          JSON.stringify(connectorContext),
          JSON.stringify(initialInstallStatus),
        ],
      )
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      if (isUniqueDelegateConflict(err)) {
        return reply.code(409).send({ error: 'An agent with this signing address already exists' })
      }
      throw err
    } finally {
      client.release()
    }

    return reply.code(201).send({
      setup_id: setupId,
      agent_id: agentId,
      status: 'connected_local',
      agent_status: 'pending_approval',
      api_key_prefix: apiKeyPrefix,
      api_key_scope: 'setup_pending',
      delegate_address: delegateAddress,
      hosted_mcp_url: hostedMcpUrlValue,
      next_action: 'return_to_haven_for_wallet_approval',
    })
  })

  app.get<{ Params: { setupId: string } }>(
    '/:setupId',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const setup = await loadSetupForUser(request.params.setupId, sub)
      if (!setup) return reply.code(404).send({ error: 'Setup not found' })
      const allowances = await loadSetupAllowances(setup.id)
      return buildUserSetupStatus(setup, allowances)
    },
  )

  app.post<{ Params: { setupId: string }; Body: InstallStatusBody }>(
    '/:setupId/install-status',
    async (request, reply) => {
      if (
        containsForbiddenPrivateKeyField(request.body) ||
        containsForbiddenInstallStatusField(request.body)
      ) {
        return reply.code(400).send({ error: 'Credential material is not accepted in setup status' })
      }
      const setup = await authenticateInstallStatus(request, request.params.setupId)
      if (!setup) return reply.code(401).send({ error: 'Invalid setup status credential' })
      if (setup.status === 'cancelled' || setup.status === 'expired' || setup.status === 'failed') {
        return reply.code(409).send({ error: 'Setup cannot be updated' })
      }

      const installStatus = sanitizeInstallStatus(request.body)
      const result = await pool.query<SetupRow>(
        `UPDATE agent_connection_setups
         SET install_status = install_status || $2::jsonb,
             connector_version = COALESCE($3, connector_version),
             runtime = COALESCE($4, runtime),
             updated_at = NOW()
         WHERE id = $1
         RETURNING install_status`,
        [
          setup.id,
          JSON.stringify(installStatus),
          stringOrNull(request.body.connector_version),
          stringOrNull(request.body.runtime),
        ],
      )

      return {
        setup_id: setup.id,
        status: setup.status,
        install_status: result.rows[0]?.install_status ?? installStatus,
      }
    },
  )

  app.post<{ Params: { setupId: string } }>(
    '/:setupId/cancel',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const setup = await loadSetupForUser(request.params.setupId, sub)
      if (!setup) return reply.code(404).send({ error: 'Setup not found' })
      if (setup.status === 'active') {
        return reply.code(409).send({ error: 'Active agents must be revoked from the agent page' })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE agent_connection_setups
           SET status = 'cancelled',
               setup_token_consumed_at = COALESCE(setup_token_consumed_at, NOW()),
               updated_at = NOW()
           WHERE id = $1 AND user_id = $2`,
          [setup.id, sub],
        )
        if (setup.agent_id) {
          await client.query(
            `UPDATE agents
             SET status = 'revoked',
                 api_key_hash = NULL,
                 api_key_prefix = NULL,
                 updated_at = NOW()
             WHERE id = $1 AND user_id = $2 AND status = 'pending_approval'`,
            [setup.agent_id, sub],
          )
        }
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      return { success: true }
    },
  )
}

function validateCreateBody(body: CreateSetupBody, reply: FastifyReply): {
  name: string
  description: string | null
  runtime: string | null
  allowances: AllowanceInput[]
} | null {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    reply.code(400).send({ error: 'Name is required' })
    return null
  }
  const allowances = Array.isArray(body.allowances) ? body.allowances : []
  for (const allowance of allowances) {
    if (!isValidAddress(allowance.token_address)) {
      reply.code(400).send({ error: 'Valid token address is required' })
      return null
    }
    if (!allowance.token_symbol || typeof allowance.token_symbol !== 'string') {
      reply.code(400).send({ error: 'Token symbol is required' })
      return null
    }
    if (!/^\d+$/.test(String(allowance.allowance_amount))) {
      reply.code(400).send({ error: 'Allowance amount must be an atomic integer string' })
      return null
    }
    if (!Number.isInteger(allowance.reset_period_min) || allowance.reset_period_min < 0) {
      reply.code(400).send({ error: 'Reset period must be a non-negative integer' })
      return null
    }
  }
  return {
    name,
    description: typeof body.description === 'string' && body.description.trim()
      ? body.description.trim()
      : null,
    runtime: typeof body.runtime === 'string' && body.runtime.trim()
      ? body.runtime.trim().slice(0, 80)
      : null,
    allowances,
  }
}

async function resolveUserSafe(userId: string, safeId?: string): Promise<{
  id: string
  safe_address: string
  name: string
  chain_id: number
} | null> {
  if (safeId) {
    const result = await pool.query<UserSafeRow>(
      `SELECT id, safe_address, name, chain_id
       FROM user_safes
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [safeId, userId],
    )
    return result.rows[0] ?? null
  }
  const result = await pool.query<UserSafeRow>(
    `SELECT id, safe_address, name, chain_id
     FROM user_safes
     WHERE user_id = $1 AND is_default = true
     LIMIT 1`,
    [userId],
  )
  return result.rows[0] ?? null
}

async function loadSetupByToken(setupToken: string | undefined): Promise<SetupRow | null> {
  if (!setupToken || typeof setupToken !== 'string') return null
  const result = await pool.query<SetupRow>(
    setupSelectSql('s.setup_token_hash = $1'),
    [hashSetupSecret(setupToken)],
  )
  return result.rows[0] ?? null
}

async function loadSetupForUser(setupId: string, userId: string): Promise<SetupRow | null> {
  const result = await pool.query<SetupRow>(
    setupSelectSql('s.id = $1 AND s.user_id = $2'),
    [setupId, userId],
  )
  return result.rows[0] ?? null
}

async function loadSetupAllowances(setupId: string): Promise<AllowanceRow[]> {
  const result = await pool.query<AllowanceRow>(
    `SELECT id, token_address, token_symbol, allowance_amount, reset_period_min
     FROM agent_connection_setup_allowances
     WHERE setup_id = $1
     ORDER BY created_at ASC`,
    [setupId],
  )
  return result.rows
}

async function authenticateInstallStatus(
  request: FastifyRequest<{ Body: InstallStatusBody }>,
  setupId: string,
): Promise<SetupRow | null> {
  const headerSetupToken = request.headers['x-haven-setup-token']
  const setupToken = request.body?.setup_token ??
    (typeof headerSetupToken === 'string' ? headerSetupToken : undefined)
    if (setupToken) {
      const result = await pool.query<SetupRow>(
        setupSelectSql('s.id = $1 AND s.setup_token_hash = $2'),
        [setupId, hashSetupSecret(setupToken)],
      )
      const setup = result.rows[0]
      if (!setup) return null
      if (
        setup.setup_token_consumed_at ||
        setup.status !== 'awaiting_connection' ||
        isExpired(setup.setup_token_expires_at)
      ) {
        return null
      }
      return setup
    }

  const apiKey = extractAgentApiKey(request)
  if (!apiKey) return null
  const result = await pool.query<SetupRow>(
    `SELECT s.id, s.user_id, s.agent_id, s.safe_id, s.name, s.description,
            s.runtime, s.status, s.setup_token_expires_at,
            s.setup_token_consumed_at, s.challenge_id, s.challenge_message,
            s.challenge_expires_at, s.delegate_address, s.proof_signature,
            s.api_key_prefix, s.connector_version, s.connector_context,
            s.install_status, s.approval_status, s.safe_tx_hash, s.tx_hash,
            s.failure_reason,
            us.safe_address, us.name AS safe_name, us.chain_id AS safe_chain_id
     FROM agent_connection_setups s
     JOIN user_safes us ON us.id = s.safe_id
     JOIN agents a ON a.id = s.agent_id
     WHERE s.id = $1 AND a.api_key_hash = $2 AND a.status IN ($3, $4, $5)
     LIMIT 1`,
    [setupId, apiKeyHash(apiKey), 'pending_approval', 'active', 'paused'],
  )
  return result.rows[0] ?? null
}

function setupSelectSql(where: string): string {
  return `SELECT s.id, s.user_id, s.agent_id, s.safe_id, s.name, s.description,
                 s.runtime, s.status, s.setup_token_expires_at,
                 s.setup_token_consumed_at, s.challenge_id, s.challenge_message,
                 s.challenge_expires_at, s.delegate_address, s.proof_signature,
                 s.api_key_prefix, s.connector_version, s.connector_context,
                 s.install_status, s.approval_status, s.safe_tx_hash, s.tx_hash,
                 s.failure_reason,
                 us.safe_address, us.name AS safe_name, us.chain_id AS safe_chain_id
          FROM agent_connection_setups s
          JOIN user_safes us ON us.id = s.safe_id
          WHERE ${where}
          LIMIT 1`
}

function buildConnectorSetupResponse(setup: SetupRow, allowances: AllowanceRow[]) {
  return {
    setup_id: setup.id,
    status: effectiveStatus(setup),
    agent: {
      name: setup.name,
      description: setup.description,
    },
    haven_wallet: {
      id: setup.safe_id,
      name: setup.safe_name,
      address: setup.safe_address,
      chain_id: setup.safe_chain_id,
      network: networkName(setup.safe_chain_id),
    },
    agent_budget: allowances.map((allowance) => ({
      token_address: allowance.token_address,
      token_symbol: allowance.token_symbol,
      allowance_amount: allowance.allowance_amount,
      reset_period_min: allowance.reset_period_min,
    })),
    hosted_mcp_url: hostedMcpUrl(),
    challenge: {
      id: setup.challenge_id,
      message: setup.challenge_message,
      expires_at: setup.challenge_expires_at,
    },
  }
}

function buildUserSetupStatus(setup: SetupRow, allowances: AllowanceRow[]) {
  return {
    setup_id: setup.id,
    agent_id: setup.agent_id,
    status: effectiveStatus(setup),
    expires_at: setup.setup_token_expires_at,
    agent: {
      name: setup.name,
      description: setup.description,
    },
    haven_wallet: {
      id: setup.safe_id,
      name: setup.safe_name,
      address: setup.safe_address,
      chain_id: setup.safe_chain_id,
      network: networkName(setup.safe_chain_id),
    },
    agent_budget: allowances.map((allowance) => ({
      id: allowance.id,
      token_address: allowance.token_address,
      token_symbol: allowance.token_symbol,
      allowance_amount: allowance.allowance_amount,
      reset_period_min: allowance.reset_period_min,
    })),
    delegate_address: setup.delegate_address,
    api_key_prefix: setup.api_key_prefix,
    runtime: setup.runtime,
    connector: {
      connector_version: setup.connector_version,
      ...(setup.connector_context ?? {}),
    },
    install_status: setup.install_status ?? {},
    approval: {
      safe_tx_hash: setup.safe_tx_hash,
      tx_hash: setup.tx_hash,
      status: setup.approval_status,
    },
    failure_reason: setup.failure_reason,
  }
}

function buildConnectorCommand(setupToken: string, request: FastifyRequest, runtime: string | null): string {
  const args = [
    'npx -y @haven_ai/connect',
    `--setup ${shellQuote(setupToken)}`,
    `--api ${shellQuote(apiBaseUrl(request))}`,
  ]
  if (runtime) args.push(`--runtime ${shellQuote(runtime)}`)
  return args.join(' ')
}

function buildSetupPrompt(command: string): string {
  return [
    'Please connect this workspace to Haven.',
    '',
    'Run this local setup command:',
    '',
    command,
    '',
    'The Haven connector will generate the signing key locally and send Haven only the public signing address. Do not print private keys in chat or logs.',
    '',
    'When the connector finishes, tell me to return to Haven to approve the agent rules.',
  ].join('\n')
}

function apiBaseUrl(request: FastifyRequest): string {
  const env = process.env.HAVEN_API_URL ?? process.env.PUBLIC_API_URL
  if (env) return env.replace(/\/+$/, '')
  const host = request.headers.host ?? `localhost:${process.env.PORT ?? 3001}`
  const proto = request.headers['x-forwarded-proto']
  const scheme = typeof proto === 'string' && proto ? proto.split(',')[0] : 'http'
  return `${scheme}://${host}`.replace(/\/+$/, '')
}

function hostedMcpUrl(): string {
  return (
    process.env.HAVEN_HOSTED_MCP_URL ??
    process.env.NEXT_PUBLIC_HAVEN_MCP_URL ??
    DEFAULT_HOSTED_MCP_URL
  ).replace(/\/+$/, '')
}

function extractAgentApiKey(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization
  if (authHeader?.startsWith('Bearer sk_agent_')) return authHeader.slice(7)
  const xApiKey = request.headers['x-api-key']
  if (typeof xApiKey === 'string' && xApiKey.startsWith('sk_agent_')) return xApiKey
  return null
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000)
}

function isExpired(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now()
}

function effectiveStatus(setup: SetupRow): string {
  if (setup.status === 'awaiting_connection' && isExpired(setup.setup_token_expires_at)) {
    return 'expired'
  }
  return setup.status
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isValidApiKeyPrefix(value: unknown): value is string {
  return typeof value === 'string' && /^sk_agent_[0-9a-f]{3}$/.test(value)
}

function isValidSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)
}

function isUniqueDelegateConflict(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === '23505' &&
      'constraint' in err &&
      String(err.constraint).includes('idx_agents_user_delegate_non_revoked_unique'),
  )
}

function networkName(chainId: number): string {
  if (chainId === 8453) return 'Base'
  if (chainId === 100) return 'Gnosis'
  return `Chain ${chainId}`
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}
