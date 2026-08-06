import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import crypto from 'crypto'
import { ethers } from 'ethers'
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
  isValidHexHash,
  sanitizeConnectorContext,
  sanitizeInstallStatus,
  verifySetupProof,
} from '../lib/agent-connection-setup.js'
import { normalizeAgentAllowances } from '../lib/agent-allowance-validation.js'
import { getTokenAllowance, getTokensForDelegate } from '../lib/allowance-module.js'
import { getChain } from '../lib/chains.js'
import { emitFunnelEvent } from '../lib/onboarding-funnel.js'
import {
  requestPassport,
  issuePassportBestEffort,
  isPassportConfigured,
  PASSPORT_CHAIN_IDS,
} from '../lib/passport/index.js'
// All SQL lives in the repository (#985); this file keeps validation,
// authorization decisions and orchestration only.
import {
  type AllowanceRow,
  type SetupRow,
  type UserSafeRow,
  activatePendingAgent,
  cancelSetup,
  copySetupAllowancesToAgent,
  createSetupWithAllowances,
  findAgentStatus,
  findDefaultUserSafe,
  findNonRevokedAgentIdByDelegate,
  findSetupByAgentApiKey,
  findSetupByIdAndTokenHash,
  findSetupByTokenHash,
  findSetupForUser,
  findUserSafeById,
  insertAgentForSetup,
  listActiveDelegationBudgets,
  listSetupAllowances,
  lockSetupByTokenHash,
  lockSetupForUser,
  markSetupRegistered,
  mergeInstallStatus,
  revokePendingAgent,
  updateConnectorMetadata,
  updateWalletApprovalState,
  withSetupTransaction,
} from '../infra/repositories/agent-connection-setups.js'

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
  /** Advanced opt-in: generate a connector command for the fully-local MCP topology. */
  local_mcp?: boolean
  /**
   * Opt in to an L0 Agent Passport (#972), mirroring `POST /agents`'
   * `issue_passport`. Absent/false is the DEFAULT and normal case. Recorded on
   * the setup row now and acted on at `/register` time, since the connector
   * flow has no `agents` row to hang the flag on until then (#1072).
   */
  issue_passport?: boolean
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
  runtime_mcp_mode?: string
  connector_version?: string
  hosted_mcp_configured?: boolean
  local_signer_configured?: boolean
  local_mcp_configured?: boolean
  credential_files_written?: boolean
  signer_acknowledged?: boolean
  local_mcp_acknowledged?: boolean
  activation_command_available?: boolean
  probe_result?: string
  restart_required?: boolean
  next_user_action?: string
  error_code?: string | null
  environment_label?: string
}

interface WalletApprovalBody {
  result?: 'confirmed' | 'proposed'
  tx_hash?: string
  safe_tx_hash?: string
  chain_id?: number
  safe_address?: string
  allowance_module_address?: string
  delegate_address?: string
  confirmation_status?: 'confirmed' | 'receipt_timeout'
}

const DEFAULT_HOSTED_MCP_URL = 'https://haven-ai-production-5953.up.railway.app/v1'
export const CONNECTOR_PACKAGE = '@haven_ai/connect@alpha'
const WALLET_APPROVAL_STATES = new Set([
  'connected_local',
  'awaiting_wallet_approval',
  'approval_in_progress',
  'proposed',
  'active',
])

/**
 * Thrown inside a `withSetupTransaction` callback to abort with a ROLLBACK
 * and answer with a specific status — the decisions stay in this file, and
 * the transaction verb sequence (early exit = ROLLBACK, never COMMIT) stays
 * exactly what the pre-#985 inline BEGIN/ROLLBACK produced.
 */
class SetupTxAbort extends Error {
  constructor(
    readonly statusCode: number,
    readonly body: { error: string },
  ) {
    super('setup transaction aborted')
  }
}

/** Reference-compared sentinel: persistWalletApprovalState's "state changed" rollback. */
const APPROVAL_STATE_CONFLICT = new Error('wallet-approval state conflict')

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

      // #1074: on the delegation rail each budget is its own signed grant and
      // the approval step only ever grants ONE — a multi-allowance setup can
      // never be approved (verifyDelegationSetupAuthority requires every
      // allowance to match an active delegation). Fail at CREATE with the
      // remedy, not at approval with a dead end. The legacy Safe rail keeps
      // multi-token allowances unchanged.
      if (safe.account_type === 'delegator_hybrid' && (parsed.allowances?.length ?? 0) > 1) {
        return reply.code(400).send({
          error:
            'This account uses one budget per agent — send a single allowance, then add more budgets from the agent page after setup.',
        })
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

      await createSetupWithAllowances({
        id: setupId,
        userId: sub,
        safeId: safe.id,
        name: parsed.name,
        description: parsed.description,
        runtime: parsed.runtime,
        setupTokenHash: hashSetupSecret(setupToken),
        setupTokenPrefix: setupToken.slice(0, 20),
        expiresAt,
        challengeId,
        challengeMessage,
        issuePassport: parsed.issuePassport,
        allowances: parsed.allowances,
      })

      const apiUrl = apiBaseUrl(request)
      const command = buildConnectorCommand(setupToken, apiUrl, parsed.runtime, parsed.localMcp)
      return reply.code(201).send({
        setup_id: setupId,
        status: 'awaiting_connection',
        setup_token: setupToken,
        expires_at: expiresAt,
        connector_command: command,
        setup_prompt: buildSetupPrompt(command, parsed.runtime, apiUrl),
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
      await updateConnectorMetadata(
        setup.id,
        stringOrNull(request.body.connector_version),
        stringOrNull(request.body.runtime),
      )
    }

    const allowances = await listSetupAllowances(setup.id)
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
    let issuePassportForSetup = false
    let setupChainId = 0
    let setupUserId = ''
    try {
      await withSetupTransaction(async (tx) => {
        const setup = await lockSetupByTokenHash(hashSetupSecret(request.body.setup_token), tx)
        if (!setup) {
          throw new SetupTxAbort(401, { error: 'Invalid setup token' })
        }
        if (setup.status !== 'awaiting_connection' || setup.setup_token_consumed_at) {
          throw new SetupTxAbort(409, { error: 'Setup is not awaiting connection' })
        }
        if (isExpired(setup.setup_token_expires_at) || isExpired(setup.challenge_expires_at)) {
          throw new SetupTxAbort(410, { error: 'Setup token expired' })
        }
        if (request.body.challenge_id !== setup.challenge_id) {
          throw new SetupTxAbort(400, { error: 'Invalid challenge' })
        }
        if (!isValidAddress(request.body.delegate_address)) {
          throw new SetupTxAbort(400, { error: 'Valid public signing address is required' })
        }
        delegateAddress = request.body.delegate_address.toLowerCase()
        if (!verifySetupProof(setup.challenge_message, request.body.proof_signature, delegateAddress)) {
          throw new SetupTxAbort(400, { error: 'Invalid proof signature' })
        }
        if (!isValidSha256Hash(request.body.api_key_hash)) {
          throw new SetupTxAbort(400, { error: 'Valid API key hash is required' })
        }
        if (!isValidApiKeyPrefix(request.body.api_key_prefix)) {
          throw new SetupTxAbort(400, { error: 'Valid API key prefix is required' })
        }

        const existingAgentId = await findNonRevokedAgentIdByDelegate(
          setup.user_id,
          delegateAddress,
          tx,
        )
        if (existingAgentId) {
          throw new SetupTxAbort(409, { error: 'An agent with this signing address already exists' })
        }

        apiKeyPrefix = request.body.api_key_prefix
        const connectorContext = sanitizeConnectorContext(request.body.connector_context)
        const initialInstallStatus = {
          hosted_mcp_configured: false,
          local_signer_configured: false,
          local_mcp_configured: false,
          local_mcp_acknowledged: false,
          restart_required: Boolean(request.body.install_capabilities?.restart_required),
        }
        setupId = setup.id
        hostedMcpUrlValue = hostedMcpUrl()
        issuePassportForSetup = setup.issue_passport === true
        setupChainId = setup.safe_chain_id
        setupUserId = setup.user_id

        agentId = await insertAgentForSetup(
          {
            userId: setup.user_id,
            name: setup.name,
            description: setup.description,
            delegateAddress,
            apiKeyHash: request.body.api_key_hash,
            apiKeyPrefix,
            safeId: setup.safe_id,
          },
          tx,
        )

        await copySetupAllowancesToAgent(agentId, setupId, tx)

        await markSetupRegistered(
          {
            setupId,
            agentId,
            delegateAddress,
            proofSignature: request.body.proof_signature,
            apiKeyPrefix,
            connectorVersion: stringOrNull(request.body.connector_version),
            runtime: stringOrNull(request.body.runtime),
            connectorContext,
            installStatus: initialInstallStatus,
          },
          tx,
        )
      })
    } catch (err) {
      if (err instanceof SetupTxAbort) {
        return reply.code(err.statusCode).send(err.body)
      }
      if (isUniqueDelegateConflict(err)) {
        return reply.code(409).send({ error: 'An agent with this signing address already exists' })
      }
      throw err
    }
    emitFunnelEvent(setupUserId, 'agent_created', { agent_id: agentId, via: 'connection_setup' })
    emitFunnelEvent(setupUserId, 'allowance_granted', { agent_id: agentId, via: 'connection_setup' })

    // Opt-in passport (#972/#1072). Deliberately AFTER the transaction commits
    // and outside any try that could turn a passport problem into a failed
    // registration — same discipline as POST /agents. `issuePassportForSetup`
    // was recorded when the setup was created; the agent row (and its chain)
    // only exists now.
    const passportChainId =
      issuePassportForSetup && PASSPORT_CHAIN_IDS.has(setupChainId) ? setupChainId : null
    if (passportChainId != null) {
      try {
        await requestPassport(agentId, passportChainId)
        if (isPassportConfigured(passportChainId)) {
          issuePassportBestEffort(agentId, setupUserId)
        } else {
          request.log.info(
            { agentId, chainId: passportChainId },
            'passport requested but schema not registered — deferred to the sweep',
          )
        }
      } catch (err) {
        request.log.warn({ err, agentId }, 'passport request failed; agent registered')
      }
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
      passport_requested: passportChainId != null,
    })
  })

  app.get<{ Params: { setupId: string } }>(
    '/:setupId',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const setup = await findSetupForUser(request.params.setupId, sub)
      if (!setup) return reply.code(404).send({ error: 'Setup not found' })
      const allowances = await listSetupAllowances(setup.id)
      const reconciled = await maybeActivateFromLiveAuthority(setup, allowances)
      return buildUserSetupStatus(reconciled, allowances)
    },
  )

  app.post<{ Params: { setupId: string }; Body: WalletApprovalBody }>(
    '/:setupId/wallet-approval',
    { preHandler: authMiddleware },
    async (request, reply) => {
      if (
        containsForbiddenPrivateKeyField(request.body) ||
        containsForbiddenInstallStatusField(request.body)
      ) {
        return reply.code(400).send({ error: 'Credential material is not accepted by Haven' })
      }

      const { sub } = request.user as { sub: string }
      const setup = await findSetupForUser(request.params.setupId, sub)
      if (!setup) return reply.code(404).send({ error: 'Setup not found' })

      const allowances = await listSetupAllowances(setup.id)
      const validation = validateWalletApprovalBody(setup, allowances, request.body)
      if (!validation.ok) {
        return reply.code(validation.statusCode).send({ error: validation.error })
      }

      if (setup.status === 'active') {
        return buildUserSetupStatus(setup, allowances)
      }

      if (request.body.result === 'proposed') {
        const live = await tryVerifySetupAuthority(setup, allowances)
        if (live.ok) {
          const active = await persistWalletApprovalState(setup, {
            status: 'active',
            approvalStatus: 'confirmed',
            txHash: null,
            safeTxHash: normalizeHash(request.body.safe_tx_hash),
            failureReason: null,
            activateAgent: true,
          })
          if (!active) {
            return reply.code(409).send({ error: 'Setup state changed; refresh and try again' })
          }
          return buildUserSetupStatus(active, allowances)
        }

        const proposed = await persistWalletApprovalState(setup, {
          status: 'proposed',
          approvalStatus: 'proposed',
          txHash: null,
          safeTxHash: normalizeHash(request.body.safe_tx_hash),
          failureReason: null,
          activateAgent: false,
        })
        if (!proposed) {
          return reply.code(409).send({ error: 'Setup state changed; refresh and try again' })
        }
        return buildUserSetupStatus(proposed, allowances)
      }

      const verification = await tryVerifySetupAuthority(setup, allowances)
      if (verification.ok) {
        const active = await persistWalletApprovalState(setup, {
          status: 'active',
          approvalStatus: 'confirmed',
          txHash: normalizeHash(request.body.tx_hash),
          safeTxHash: normalizeHash(request.body.safe_tx_hash),
          failureReason: null,
          activateAgent: true,
        })
        if (!active) {
          return reply.code(409).send({ error: 'Setup state changed; refresh and try again' })
        }
        return buildUserSetupStatus(active, allowances)
      }

      if (
        request.body.confirmation_status === 'receipt_timeout' ||
        isTransientSetupAuthorityVerification(verification.error)
      ) {
        const inProgress = await persistWalletApprovalState(setup, {
          status: 'approval_in_progress',
          approvalStatus: 'submitted',
          txHash: normalizeHash(request.body.tx_hash),
          safeTxHash: normalizeHash(request.body.safe_tx_hash),
          failureReason: verification.error,
          activateAgent: false,
        })
        if (!inProgress) {
          return reply.code(409).send({ error: 'Setup state changed; refresh and try again' })
        }
        return reply.code(202).send(buildUserSetupStatus(inProgress, allowances))
      }

      return reply.code(409).send({ error: verification.error })
    },
  )

  // ── POST /:setupId/budget-approval — the DELEGATION rail's approval ──
  //
  // The legacy rail proves authority by reading the Safe's AllowanceModule
  // on-chain (`tryVerifySetupAuthority`). A delegation has nothing to read
  // until it is redeemed — its enforcement is the caveat enforcers at payment
  // time — so the analogue is the signed, activated delegation itself: a row
  // only reaches `status='active'` after POST /agents/:id/delegations/:hash/
  // activate validated the OWNER's signature and deployed the account.
  //
  // Haven still verifies rather than trusts: the client asserts nothing here.
  // The body is empty by design — there is no hash, amount, or recipient a
  // caller could supply that would change the outcome.
  app.post<{ Params: { setupId: string } }>(
    '/:setupId/budget-approval',
    { preHandler: authMiddleware },
    async (request, reply) => {
      // The body is ignored, but every sibling route refuses credential
      // material outright rather than discarding it quietly — a private key
      // should never get far enough to reach a log line.
      if (containsForbiddenPrivateKeyField(request.body)) {
        return reply.code(400).send({ error: 'Private key fields are not accepted by Haven' })
      }

      const { sub } = request.user as { sub: string }
      const setup = await findSetupForUser(request.params.setupId, sub)
      if (!setup) return reply.code(404).send({ error: 'Setup not found' })

      if (setup.account_type !== 'delegator_hybrid') {
        return reply
          .code(409)
          .send({ error: 'This Haven wallet approves agent rules with a wallet transaction' })
      }

      const allowances = await listSetupAllowances(setup.id)
      const precondition = validateBudgetApprovalPreconditions(setup, allowances)
      if (!precondition.ok) {
        return reply.code(precondition.statusCode).send({ error: precondition.error })
      }

      if (setup.status === 'active') {
        return buildUserSetupStatus(setup, allowances)
      }

      const verification = await verifyDelegationSetupAuthority(setup, allowances)
      if (!verification.ok) {
        return reply.code(409).send({ error: verification.error })
      }

      // The AGENT is already active by this point — #1069 flips it inside the
      // grant-activation transaction, because the grant signature is what
      // confers the authority. What is left is the SETUP record's own
      // lifecycle. `activateAgent` stays true as an idempotent safety net for
      // a budget granted by some other path; its UPDATE is a no-op on an
      // already-active agent.
      const active = await persistWalletApprovalState(setup, {
        status: 'active',
        approvalStatus: 'confirmed',
        txHash: null,
        safeTxHash: null,
        failureReason: null,
        activateAgent: true,
      })
      if (!active) {
        return reply.code(409).send({ error: 'Setup state changed; refresh and try again' })
      }
      return buildUserSetupStatus(active, allowances)
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
      const merged = await mergeInstallStatus(
        setup.id,
        installStatus,
        stringOrNull(request.body.connector_version),
        stringOrNull(request.body.runtime),
      )

      return {
        setup_id: setup.id,
        status: setup.status,
        install_status: merged ?? installStatus,
      }
    },
  )

  app.post<{ Params: { setupId: string } }>(
    '/:setupId/cancel',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      try {
        await withSetupTransaction(async (tx) => {
          const setup = await lockSetupForUser(request.params.setupId, sub, tx)
          if (!setup) {
            throw new SetupTxAbort(404, { error: 'Setup not found' })
          }
          if (
            setup.status === 'active' ||
            setup.status === 'approval_in_progress' ||
            setup.status === 'proposed' ||
            setup.safe_tx_hash ||
            setup.tx_hash
          ) {
            throw new SetupTxAbort(409, { error: 'Approved agents must be paused or revoked from the agent page' })
          }
          if (!['awaiting_connection', 'connected_local', 'awaiting_wallet_approval'].includes(setup.status)) {
            throw new SetupTxAbort(409, { error: 'Setup cannot be cancelled' })
          }
          // #1073: the guards above read the SETUP's own state, which on the
          // delegation rail can lag the authority itself. The grant activates
          // the agent in its own transaction, and this rail never writes
          // safe_tx_hash/tx_hash — so a setup whose budget is already signed
          // still looks cancellable here. Cancelling it would report "this
          // setup can no longer connect an agent" while leaving a live,
          // spend-capable agent behind, and the revoke below is scoped to
          // 'pending_approval' so it would not catch it either.
          // Ask the agent, not the setup.
          if (setup.agent_id) {
            const agentStatus = await findAgentStatus(setup.agent_id, sub, tx)
            if (agentStatus === 'active' || agentStatus === 'paused') {
              throw new SetupTxAbort(409, {
                error: 'Approved agents must be paused or revoked from the agent page',
              })
            }
          }

          const cancelled = await cancelSetup(setup.id, sub, tx)
          if (!cancelled) {
            throw new SetupTxAbort(409, { error: 'Setup state changed; refresh and try again' })
          }
          if (setup.agent_id) {
            await revokePendingAgent(setup.agent_id, sub, tx)
          }
        })
      } catch (err) {
        if (err instanceof SetupTxAbort) {
          return reply.code(err.statusCode).send(err.body)
        }
        throw err
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
  localMcp: boolean
  issuePassport: boolean
} | null {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    reply.code(400).send({ error: 'Name is required' })
    return null
  }
  const allowances = normalizeAgentAllowances(body.allowances)
  if (!allowances.ok) {
    reply.code(400).send({ error: allowances.error })
    return null
  }
  const runtime = typeof body.runtime === 'string' && body.runtime.trim()
    ? body.runtime.trim().slice(0, 80)
    : null
  if (body.local_mcp === true && (!runtime || !LOCAL_MCP_RUNTIMES.has(runtime))) {
    reply.code(400).send({ error: 'Local MCP is only available for Claude Code and Codex runtimes' })
    return null
  }
  return {
    name,
    description: typeof body.description === 'string' && body.description.trim()
      ? body.description.trim()
      : null,
    runtime,
    allowances: allowances.value,
    localMcp: body.local_mcp === true,
    issuePassport: body.issue_passport === true,
  }
}

const LOCAL_MCP_RUNTIMES = new Set(['claude-code', 'codex-cli', 'codex-desktop'])

async function resolveUserSafe(userId: string, safeId?: string): Promise<UserSafeRow | null> {
  if (safeId) {
    return findUserSafeById(safeId, userId)
  }
  return findDefaultUserSafe(userId)
}

async function loadSetupByToken(setupToken: string | undefined): Promise<SetupRow | null> {
  if (!setupToken || typeof setupToken !== 'string') return null
  return findSetupByTokenHash(hashSetupSecret(setupToken))
}

function validateWalletApprovalBody(
  setup: SetupRow,
  allowances: AllowanceRow[],
  body: WalletApprovalBody | undefined,
): { ok: true } | { ok: false; statusCode: 400 | 409 | 410; error: string } {
  if (!body || (body.result !== 'confirmed' && body.result !== 'proposed')) {
    return { ok: false, statusCode: 400, error: 'Approval result must be confirmed or proposed' }
  }
  if (setup.status === 'cancelled' || setup.status === 'expired' || setup.status === 'failed') {
    return { ok: false, statusCode: 409, error: 'Setup cannot be approved' }
  }
  if (!WALLET_APPROVAL_STATES.has(setup.status)) {
    const expired = setup.status === 'awaiting_connection' && isExpired(setup.setup_token_expires_at)
    return {
      ok: false,
      statusCode: expired ? 410 : 409,
      error: expired ? 'Setup token expired' : 'Local connection is required before wallet approval',
    }
  }
  if (!setup.agent_id || !setup.delegate_address) {
    return { ok: false, statusCode: 409, error: 'Public signing address is required before wallet approval' }
  }
  if (allowances.length === 0) {
    return { ok: false, statusCode: 409, error: 'Agent budget is required before wallet approval' }
  }
  if (body.confirmation_status && !['confirmed', 'receipt_timeout'].includes(body.confirmation_status)) {
    return { ok: false, statusCode: 400, error: 'Invalid confirmation status' }
  }
  if (!Number.isInteger(body.chain_id) || body.chain_id !== setup.safe_chain_id) {
    return { ok: false, statusCode: 400, error: 'Wallet network does not match this setup' }
  }
  if (!isValidAddress(body.safe_address) || body.safe_address.toLowerCase() !== setup.safe_address.toLowerCase()) {
    return { ok: false, statusCode: 400, error: 'Haven wallet does not match this setup' }
  }
  if (
    !isValidAddress(body.delegate_address) ||
    body.delegate_address.toLowerCase() !== setup.delegate_address.toLowerCase()
  ) {
    return { ok: false, statusCode: 400, error: 'Public signing address does not match this setup' }
  }
  let allowanceModuleAddress = ''
  try {
    allowanceModuleAddress = getChain(setup.safe_chain_id).contracts.allowanceModule
  } catch {
    return { ok: false, statusCode: 400, error: 'Unsupported wallet network' }
  }
  if (
    !isValidAddress(body.allowance_module_address) ||
    body.allowance_module_address.toLowerCase() !== allowanceModuleAddress.toLowerCase()
  ) {
    return { ok: false, statusCode: 400, error: 'Wallet approval module does not match this setup' }
  }
  if (!isValidHexHash(body.safe_tx_hash)) {
    return { ok: false, statusCode: 400, error: 'Valid safe_tx_hash is required' }
  }
  if (body.result === 'confirmed' && !isValidHexHash(body.tx_hash)) {
    return { ok: false, statusCode: 400, error: 'Valid tx_hash is required' }
  }
  if (
    setup.safe_tx_hash &&
    body.safe_tx_hash &&
    setup.safe_tx_hash.toLowerCase() !== body.safe_tx_hash.toLowerCase()
  ) {
    return { ok: false, statusCode: 409, error: 'Wallet approval is already tied to a different Safe transaction' }
  }
  if (
    setup.tx_hash &&
    body.tx_hash &&
    setup.tx_hash.toLowerCase() !== body.tx_hash.toLowerCase()
  ) {
    return { ok: false, statusCode: 409, error: 'Wallet approval is already tied to a different transaction' }
  }
  return { ok: true }
}

/**
 * The rail-agnostic preconditions the legacy `validateWalletApprovalBody`
 * checks before it starts on its Safe-shaped body fields. The delegation rail
 * has no body to validate, so it needs exactly this subset — kept separate
 * rather than branching inside the legacy validator, which stays untouched.
 */
function validateBudgetApprovalPreconditions(
  setup: SetupRow,
  allowances: AllowanceRow[],
): { ok: true } | { ok: false; statusCode: 409 | 410; error: string } {
  if (setup.status === 'cancelled' || setup.status === 'expired' || setup.status === 'failed') {
    return { ok: false, statusCode: 409, error: 'Setup cannot be approved' }
  }
  if (!WALLET_APPROVAL_STATES.has(setup.status)) {
    const expired = setup.status === 'awaiting_connection' && isExpired(setup.setup_token_expires_at)
    return {
      ok: false,
      statusCode: expired ? 410 : 409,
      error: expired ? 'Setup token expired' : 'Local connection is required before approving the budget',
    }
  }
  if (!setup.agent_id || !setup.delegate_address) {
    return { ok: false, statusCode: 409, error: 'Public signing address is required before approving the budget' }
  }
  if (allowances.length === 0) {
    return { ok: false, statusCode: 409, error: 'Agent budget is required before approving the budget' }
  }
  return { ok: true }
}

/**
 * Delegation-rail authority check: every budget this setup promised must exist
 * as an ACTIVE, owner-signed delegation on the setup's agent.
 *
 * Deliberately does NOT compare `recipient_address`. A pinned delegation is
 * STRICTLY narrower than the unpinned budget the setup described, so honouring
 * it activates an agent with less authority than the user approved — safe in
 * the only direction that matters. Amount and period are matched exactly:
 * those can differ in the dangerous direction.
 */
async function verifyDelegationSetupAuthority(
  setup: SetupRow,
  allowances: AllowanceRow[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const active = await listActiveDelegationBudgets(setup.agent_id ?? '')

    for (const allowance of allowances) {
      const match = active.find(
        (row) => row.token_address.toLowerCase() === allowance.token_address.toLowerCase(),
      )
      if (!match) {
        return { ok: false, error: 'The agent budget has not been approved yet' }
      }
      if (BigInt(match.budget_atomic) !== BigInt(allowance.allowance_amount)) {
        return { ok: false, error: `${allowance.token_symbol} budget does not match this setup` }
      }
      // The setup records minutes; a delegation period is seconds.
      if (match.period_seconds !== allowance.reset_period_min * 60) {
        return { ok: false, error: `${allowance.token_symbol} reset period does not match this setup` }
      }
    }
    return { ok: true }
  } catch (err) {
    appLogSafeError(err)
    return { ok: false, error: 'Haven could not confirm the agent budget yet' }
  }
}

async function maybeActivateFromLiveAuthority(
  setup: SetupRow,
  allowances: AllowanceRow[],
): Promise<SetupRow> {
  if (!['approval_in_progress', 'proposed'].includes(setup.status)) {
    return setup
  }
  const verification = await tryVerifySetupAuthority(setup, allowances)
  if (!verification.ok) return setup
  return (await persistWalletApprovalState(setup, {
    status: 'active',
    approvalStatus: 'confirmed',
    txHash: setup.tx_hash,
    safeTxHash: setup.safe_tx_hash,
    failureReason: null,
    activateAgent: true,
  })) ?? setup
}

async function tryVerifySetupAuthority(
  setup: SetupRow,
  allowances: AllowanceRow[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!setup.delegate_address) {
      return { ok: false, error: 'Public signing address is missing' }
    }
    if (allowances.length === 0) {
      return { ok: false, error: 'Agent budget is missing' }
    }

    const expectedTokens = new Set(allowances.map((allowance) => allowance.token_address.toLowerCase()))
    const actualTokens = (await getTokensForDelegate(
      setup.safe_chain_id,
      setup.safe_address,
      setup.delegate_address,
    )).map((token) => token.toLowerCase())
    const actualTokenSet = new Set(actualTokens)
    for (const expected of expectedTokens) {
      if (!actualTokenSet.has(expected)) {
        return { ok: false, error: 'On-chain agent budget is not active yet' }
      }
    }
    for (const actual of actualTokenSet) {
      if (!expectedTokens.has(actual)) {
        return { ok: false, error: 'On-chain agent budget contains an unexpected token' }
      }
    }

    for (const allowance of allowances) {
      const info = await getTokenAllowance(
        setup.safe_chain_id,
        setup.safe_address,
        setup.delegate_address,
        allowance.token_address,
      )
      const expectedAmount = BigInt(allowance.allowance_amount)
      if (info.amount !== expectedAmount) {
        return { ok: false, error: `${allowance.token_symbol} budget does not match this setup` }
      }
      if (info.resetTimeMin !== allowance.reset_period_min) {
        return { ok: false, error: `${allowance.token_symbol} reset period does not match this setup` }
      }
    }
    return { ok: true }
  } catch (err) {
    appLogSafeError(err)
    return { ok: false, error: 'Haven could not verify the on-chain agent rules yet' }
  }
}

function isTransientSetupAuthorityVerification(error: string): boolean {
  return (
    error === 'On-chain agent budget is not active yet' ||
    error === 'Haven could not verify the on-chain agent rules yet'
  )
}

async function persistWalletApprovalState(
  setup: SetupRow,
  input: {
    status: 'approval_in_progress' | 'proposed' | 'active'
    approvalStatus: 'submitted' | 'proposed' | 'confirmed'
    txHash: string | null | undefined
    safeTxHash: string | null | undefined
    failureReason: string | null
    activateAgent: boolean
  },
): Promise<SetupRow | null> {
  try {
    return await withSetupTransaction(async (tx) => {
      const locked = await lockSetupForUser(setup.id, setup.user_id, tx)
      if (!locked) {
        throw APPROVAL_STATE_CONFLICT
      }
      if (
        locked.status === 'cancelled' ||
        locked.status === 'expired' ||
        locked.status === 'failed'
      ) {
        throw APPROVAL_STATE_CONFLICT
      }
      if (locked.status === 'active') {
        return locked
      }
      if (!WALLET_APPROVAL_STATES.has(locked.status)) {
        throw APPROVAL_STATE_CONFLICT
      }
      if (
        locked.safe_tx_hash &&
        input.safeTxHash &&
        locked.safe_tx_hash.toLowerCase() !== input.safeTxHash.toLowerCase()
      ) {
        throw APPROVAL_STATE_CONFLICT
      }
      if (
        locked.tx_hash &&
        input.txHash &&
        locked.tx_hash.toLowerCase() !== input.txHash.toLowerCase()
      ) {
        throw APPROVAL_STATE_CONFLICT
      }

      const nextSetup: SetupRow = {
        ...locked,
        status: input.status,
        approval_status: input.approvalStatus,
        tx_hash: input.txHash ?? locked.tx_hash,
        safe_tx_hash: input.safeTxHash ?? locked.safe_tx_hash,
        failure_reason: input.failureReason,
      }
      await updateWalletApprovalState(
        {
          setupId: setup.id,
          userId: setup.user_id,
          status: input.status,
          approvalStatus: input.approvalStatus,
          txHash: nextSetup.tx_hash,
          safeTxHash: nextSetup.safe_tx_hash,
          failureReason: input.failureReason,
        },
        tx,
      )
      if (input.activateAgent && nextSetup.agent_id) {
        await activatePendingAgent(nextSetup.agent_id, nextSetup.user_id, tx)
      }
      return nextSetup
    })
  } catch (err) {
    if (err === APPROVAL_STATE_CONFLICT) return null
    throw err
  }
}

async function authenticateInstallStatus(
  request: FastifyRequest<{ Body: InstallStatusBody }>,
  setupId: string,
): Promise<SetupRow | null> {
  const headerSetupToken = request.headers['x-haven-setup-token']
  const setupToken = request.body?.setup_token ??
    (typeof headerSetupToken === 'string' ? headerSetupToken : undefined)
  if (setupToken) {
    const setup = await findSetupByIdAndTokenHash(setupId, hashSetupSecret(setupToken))
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
  return findSetupByAgentApiKey(setupId, apiKeyHash(apiKey))
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
    x402_binding_signer: x402BindingSignerAddress(),
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

function buildConnectorCommand(setupToken: string, apiUrl: string, runtime: string | null, localMcp = false): string {
  const args = [
    `npx -y ${CONNECTOR_PACKAGE}`,
    `--setup ${shellQuote(setupToken)}`,
    `--api ${shellQuote(apiUrl)}`,
    '--ack-local-tools',
  ]
  if (runtime) args.push(`--runtime ${shellQuote(runtime)}`)
  if (localMcp) args.push('--local')
  return args.join(' ')
}

function buildSetupPrompt(command: string, runtime: string | null, apiUrl: string): string {
  const approvedActions = [
    `download and execute the published npm package ${CONNECTOR_PACKAGE}`,
    `connect to Haven at ${apiUrl}`,
    'write local Haven credential files under ~/.haven',
    runtime === 'codex-cli' || runtime === 'codex-desktop'
      ? 'update Codex MCP config under ~/.codex/config.toml'
      : 'update the local agent MCP config when supported',
  ]

  return [
    'Please connect this workspace to Haven.',
    '',
    `I approve running this exact Haven setup command. It may ${joinApprovedActions(approvedActions)}.`,
    '',
    'Run this exact command:',
    '',
    command,
    '',
    'Do not print private keys, API keys, credential file contents, or config secrets in chat or logs.',
    '',
    'The Haven connector generates the signing key locally and sends Haven only the public signing address plus proof.',
    '',
    'When the connector finishes, tell me to return to Haven to approve the agent rules.',
  ].join('\n')
}

function joinApprovedActions(actions: string[]): string {
  if (actions.length <= 1) return actions[0] ?? ''
  return `${actions.slice(0, -1).join(', ')}, and ${actions[actions.length - 1]}`
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

// Address of the dedicated x402 binding key the backend signs expected-context
// with (X402_BINDING_PRIVATE_KEY). The edge signer must verify expected-context
// signatures against this address before signing an x402 funding hash, so we
// hand it to the connector at setup time to write into signer.json — otherwise
// the signer has no trusted verifier and refuses to sign x402 payments. Returns
// null when x402 binding is not configured on this deployment (the field is
// then omitted from the setup response). HAVEN_X402_BINDING_SIGNER overrides the
// derived address for deployments that hold only the public address here. Read
// fresh per call — /resolve is a low-frequency connect-time endpoint.
function x402BindingSignerAddress(): string | null {
  const explicit = process.env.HAVEN_X402_BINDING_SIGNER?.trim()
  if (explicit) {
    try {
      return ethers.getAddress(explicit)
    } catch {
      console.warn('HAVEN_X402_BINDING_SIGNER is not a valid address; ignoring.')
    }
  }

  const privateKey = process.env.X402_BINDING_PRIVATE_KEY?.trim()
  if (!privateKey) return null
  try {
    return new ethers.Wallet(privateKey).address
  } catch {
    console.warn('X402_BINDING_PRIVATE_KEY is set but invalid; cannot derive the x402 binding signer.')
    return null
  }
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

function normalizeHash(value: string | null | undefined): string | null {
  return value ? value.toLowerCase() : null
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

function appLogSafeError(err: unknown): void {
  if (process.env.NODE_ENV === 'test') return
  const message = err instanceof Error ? err.message : String(err)
  console.warn('[Haven] Connect Agent 2 authority verification failed:', message)
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
