import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import crypto from 'crypto'
import { resolveX402BindingSignerAddress } from '../infra/chain/x402-binding-signer.js'
import * as setups from '../infra/repositories/agent-connection-setups.js'
import type {
  AllowanceRow,
  SetupRow,
  UserSafeRow,
} from '../infra/repositories/agent-connection-setups.js'
import { authMiddleware } from '../middleware/auth.js'
import { findAgentAuthRowByApiKeyHash } from '../infra/repositories/agents.js'
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
} from '../modules/agents/index.js'
import { normalizeAgentAllowances } from '../modules/agents/index.js'
import { getChain } from '../domain/chains.js'
import { emitFunnelEvent } from '../infra/repositories/onboarding-funnel.js'
import {
  requestPassport,
  issuePassportBestEffort,
  isPassportConfigured,
  PASSPORT_CHAIN_IDS,
} from '../modules/passport/index.js'

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
  /** Discovery-source slug for connect attribution (#2302); sanitized, never refused. */
  source?: string
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
  /**
   * #1878: the resolved hosted MCP server name the connector wired this agent
   * as — `haven` for the bare pair, `haven-<slug>` for a named one. Optional:
   * connectors older than #1878 send nothing, and those agents stay NULL
   * rather than being guessed at.
   */
  mcp_server_name?: string
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


/**
 * The PRODUCTION hosted MCP. Served as a default ONLY when this backend IS
 * the production backend (#1129): a dev/local backend handing out this URL
 * points agents at the wrong database, and every call 401s with a message
 * blaming the key. Environments other than prod must set HAVEN_HOSTED_MCP_URL
 * (or NEXT_PUBLIC_HAVEN_MCP_URL) explicitly or the setup fails LOUDLY with
 * the variable named.
 */
/**
 * #1878: the connector's self-reported MCP server name, reduced to something
 * safe to store and show.
 *
 * This is a DISPLAY-SAFETY check, not the naming contract. That contract lives
 * in `packages/connect/src/server-names.ts` and cannot be imported here —
 * connect is published to npm and this package is not, so the two cannot share
 * a module. Re-implementing the full rule (reserved words, collision families)
 * would therefore be a second copy that silently drifts, and it would buy
 * nothing: Haven keys nothing off this value, so a name that is wrong is a
 * wrong label, not a wrong authorization.
 *
 * What is worth refusing is anything that is not plausibly one of our server
 * names — an oversized blob, a different product's name, control characters —
 * because that is what would land in the dashboard. Anything unrecognized
 * becomes NULL, which the UI already renders honestly as "not recorded". A
 * refusal would be worse: it would fail a whole registration over a label.
 */
const MCP_SERVER_NAME_RE = /^haven(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/

export function normalizeMcpServerName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 64) return null
  return MCP_SERVER_NAME_RE.test(trimmed) ? trimmed : null
}

const DEFAULT_HOSTED_MCP_URL = 'https://haven-ai-production-5953.up.railway.app/v1'
const PRODUCTION_API_HOST = 'havenbackend-production-8a00.up.railway.app'
export const CONNECTOR_PACKAGE = '@haven_ai/connect@alpha'

/**
 * Refuse a request from inside a transaction.
 *
 * `withTransaction` rolls back on a throw and commits on a normal return, so a
 * guard that wants to answer the caller AND abandon the transaction has to
 * throw. Returning early would commit — for these routes an empty transaction,
 * but the next guard added after a write would silently keep it. Making refusal
 * a throw keeps "we did not proceed" and "nothing was written" the same fact.
 */
class SetupRefusal extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
  }
}

/**
 * Hosted MCP URL configuration refusal (#1129). A distinct class so route
 * handlers can convert it into an explicit 500 carrying the actionable
 * message — the app-level error handler masks generic 500 messages as
 * "Internal server error", which would hide the variable name from the
 * operator/developer who needs it.
 */
export class HostedMcpConfigError extends Error {}

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

      await setups.insertSetupWithAllowances(
        {
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
          source: parsed.source,
        },
        parsed.allowances,
      )

      const apiUrl = apiBaseUrl(request)
      const command = buildConnectorCommand(setupToken, apiUrl, parsed.localMcp)
      return reply.code(201).send({
        setup_id: setupId,
        status: 'awaiting_connection',
        setup_token: setupToken,
        expires_at: expiresAt,
        connector_command: command,
        setup_prompt: buildSetupPrompt(command, apiUrl),
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

    // #1129: resolve BEFORE the connector-metadata write so a configuration
    // error answers cleanly without mutating the setup row.
    const hostedMcpUrlValue = hostedMcpUrlOrReply(request, reply)
    if (hostedMcpUrlValue == null) return reply

    if (request.body.connector_version || request.body.runtime) {
      await setups.updateConnectorMetadata(
        setup.id,
        stringOrNull(request.body.connector_version),
        stringOrNull(request.body.runtime),
      )
    }

    const allowances = await loadSetupAllowances(setup.id)
    return buildConnectorSetupResponse(setup, allowances, hostedMcpUrlValue)
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

    // #1129: resolved BEFORE the transaction opens. A configuration error must
    // refuse the whole registration up front — never after the setup token has
    // been locked/consumed or the pending agent row inserted, so a misconfigured
    // backend can neither burn the client's one-shot token nor leave a setup
    // half-registered.
    const hostedMcpUrlValue = hostedMcpUrlOrReply(request, reply)
    if (hostedMcpUrlValue == null) return reply

    let agentId = ''
    let setupId = ''
    let apiKeyPrefix = ''
    let delegateAddress = ''
    let issuePassportForSetup = false
    let setupChainId = 0
    let setupUserId = ''
    let setupSource: string | null = null
    try {
      await setups.inTransaction(async (tx) => {
        const setup = await setups.lockSetupByTokenHash(
          hashSetupSecret(request.body.setup_token),
          tx,
        )
        if (!setup) throw new SetupRefusal(401, 'Invalid setup token')
        if (setup.status !== 'awaiting_connection' || setup.setup_token_consumed_at) {
          throw new SetupRefusal(409, 'Setup is not awaiting connection')
        }
        if (isExpired(setup.setup_token_expires_at) || isExpired(setup.challenge_expires_at)) {
          throw new SetupRefusal(410, 'Setup token expired')
        }
        if (request.body.challenge_id !== setup.challenge_id) {
          throw new SetupRefusal(400, 'Invalid challenge')
        }
        if (!isValidAddress(request.body.delegate_address)) {
          throw new SetupRefusal(400, 'Valid public signing address is required')
        }
        delegateAddress = request.body.delegate_address.toLowerCase()
        if (!verifySetupProof(setup.challenge_message, request.body.proof_signature, delegateAddress)) {
          throw new SetupRefusal(400, 'Invalid proof signature')
        }
        if (!isValidSha256Hash(request.body.api_key_hash)) {
          throw new SetupRefusal(400, 'Valid API key hash is required')
        }
        if (!isValidApiKeyPrefix(request.body.api_key_prefix)) {
          throw new SetupRefusal(400, 'Valid API key prefix is required')
        }

        const existingAgentId = await setups.findActiveAgentIdByDelegate(
          setup.user_id,
          delegateAddress,
          tx,
        )
        if (existingAgentId) {
          throw new SetupRefusal(409, 'An agent with this signing address already exists')
        }

        apiKeyPrefix = request.body.api_key_prefix
        const mcpServerName = normalizeMcpServerName(request.body.mcp_server_name)
        const connectorContext = sanitizeConnectorContext(request.body.connector_context)
        // The browser-hosted fallback creates the credential in the browser and
        // hands it to the user to save in their agent workspace. It cannot run
        // the local connector, so it will never PATCH ordinary runtime probes.
        // This marker is presentation state only: the owner still must sign the
        // existing budget delegation before the pending agent becomes active.
        const manualCredentialFallback =
          request.body.connector_version === 'browser-manual-fallback' &&
          request.body.install_capabilities?.can_write_runtime_config === false
        const initialInstallStatus = {
          hosted_mcp_configured: false,
          local_signer_configured: false,
          local_mcp_configured: false,
          local_mcp_acknowledged: false,
          restart_required: Boolean(request.body.install_capabilities?.restart_required),
          ...(manualCredentialFallback ? { manual_credential_fallback: true } : {}),
        }
        setupId = setup.id
        issuePassportForSetup = setup.issue_passport === true
        setupChainId = setup.safe_chain_id
        setupUserId = setup.user_id
        setupSource = setup.source ?? null

        agentId = await setups.insertPendingAgent(
          {
            userId: setup.user_id,
            name: setup.name,
            description: setup.description,
            delegateAddress,
            apiKeyHash: request.body.api_key_hash,
            apiKeyPrefix,
            safeId: setup.safe_id,
            mcpServerName,
          },
          tx,
        )

        // #2020: the allowance-mirror copy that stood here is gone — the
        // requested budgets stay on `agent_connection_setup_allowances`, and
        // the authority the user approves is the delegation grant built from
        // them. `agent_allowances` is never written any more.
        await setups.markSetupRegistered(
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
      // #2302: the discovery source recorded at CREATE rides the funnel event so
      // "attributed connects" and per-source time-to-first-payment are plain
      // SQL over onboarding_events — no join back to the setups table needed.
      emitFunnelEvent(setupUserId, 'agent_created', {
        agent_id: agentId,
        via: 'connection_setup',
        ...(setupSource ? { source: setupSource } : {}),
      })
      emitFunnelEvent(setupUserId, 'allowance_granted', { agent_id: agentId, via: 'connection_setup' })
    } catch (err) {
      if (err instanceof SetupRefusal) {
        return reply.code(err.statusCode).send({ error: err.message })
      }
      if (isUniqueDelegateConflict(err)) {
        return reply.code(409).send({ error: 'An agent with this signing address already exists' })
      }
      throw err
    }

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

  // ── GET /:setupId/connector-status — the CONNECTOR's own poll ──
  //
  // Authenticated by the agent API key the connector minted at /register, NOT
  // by `authMiddleware` (there is no dashboard session on a headless
  // connector) and NOT by the one-shot setup token (already consumed by
  // /register). That key starts life scoped to a `pending_approval` agent
  // (`api_key_scope: 'setup_pending'` in the /register response) — the
  // ordinary `agentAuthMiddleware` refuses a pending agent outright (#1130,
  // `agent_pending_approval`), which is correct for the money-moving routes it
  // guards but wrong here: this IS the endpoint a pending agent's key is
  // supposed to work against, so it needs its own auth path rather than the
  // shared one.
  //
  // Deliberately cheap: this is polled, so it reads the setup row's OWN status
  // and issues no RPC. Since #2259 the dashboard GET does the same — the
  // legacy on-chain reconciliation it used to contrast with is gone with the
  // Safe rail. `POST /:setupId/budget-approval` is what verifies authority and
  // flips the DB status to 'active'; this endpoint only reports what it wrote.
  app.get<{ Params: { setupId: string } }>(
    '/:setupId/connector-status',
    async (request, reply) => {
      const auth = await authenticateConnectorStatusRequest(request)
      if (!auth) return reply.code(401).send({ error: 'Invalid or revoked API key' })

      // Tenant scope: `findSetupByAgentApiKeyHash` joins the setup to its
      // OWN agent_id and requires that agent's api_key_hash to equal the
      // caller's — so a valid key for a DIFFERENT agent looking up someone
      // else's setup id gets the same empty result as a setup that does not
      // exist. 404, indistinguishable from not-found, is deliberate: this
      // route must not confirm or deny that a given setup id belongs to some
      // other tenant's agent.
      const setup = await setups.findSetupByAgentApiKeyHash(request.params.setupId, auth.apiKeyHash)
      if (!setup) return reply.code(404).send({ error: 'Setup not found' })

      const allowances = await loadSetupAllowances(setup.id)
      return buildConnectorStatusResponse(setup, allowances)
    },
  )

  app.get<{ Params: { setupId: string } }>(
    '/:setupId',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const setup = await loadSetupForUser(request.params.setupId, sub)
      if (!setup) return reply.code(404).send({ error: 'Setup not found' })
      const allowances = await loadSetupAllowances(setup.id)
      // #2259: this read used to reconcile a legacy setup to `active` from
      // live AllowanceModule state — a WRITE hidden in a GET, and the last
      // path by which a retired-rail agent could still be activated. It is
      // gone with the rail (epic #1440); the read is now purely a read.
      return buildUserSetupStatus(setup, allowances)
    },
  )

  // ── POST /:setupId/budget-approval — the DELEGATION rail's approval ──
  //
  // The retired Safe rail proved authority by reading the AllowanceModule
  // on-chain; #2259 deleted that half with the rail. A delegation has nothing
  // to read until it is redeemed — its enforcement is the caveat enforcers at
  // payment time — so the analogue is the signed, activated delegation: a row
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
      const setup = await loadSetupForUser(request.params.setupId, sub)
      if (!setup) return reply.code(404).send({ error: 'Setup not found' })

      if (setup.account_type !== 'delegator_hybrid') {
        return reply
          .code(409)
          .send({ error: 'This Haven wallet approves agent rules with a wallet transaction' })
      }

      const allowances = await loadSetupAllowances(setup.id)
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
      const merged = await setups.mergeInstallStatus(
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
        await setups.inTransaction(async (tx) => {
          const setup = await setups.lockSetupForUser(request.params.setupId, sub, tx)
          if (!setup) throw new SetupRefusal(404, 'Setup not found')
          if (
            setup.status === 'active' ||
            setup.status === 'approval_in_progress' ||
            setup.status === 'proposed' ||
            setup.safe_tx_hash ||
            setup.tx_hash
          ) {
            throw new SetupRefusal(409, 'Approved agents must be paused or revoked from the agent page')
          }
          if (!['awaiting_connection', 'connected_local', 'awaiting_wallet_approval'].includes(setup.status)) {
            throw new SetupRefusal(409, 'Setup cannot be cancelled')
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
            const agentStatus = await setups.findAgentStatus(setup.agent_id, sub, tx)
            if (agentStatus === 'active' || agentStatus === 'paused') {
              throw new SetupRefusal(
                409,
                'Approved agents must be paused or revoked from the agent page',
              )
            }
          }

          const cancelled = await setups.cancelSetup(setup.id, sub, tx)
          if (!cancelled) {
            throw new SetupRefusal(409, 'Setup state changed; refresh and try again')
          }
          if (setup.agent_id) {
            await setups.revokePendingAgent(setup.agent_id, sub, tx)
          }
        })
      } catch (err) {
        if (err instanceof SetupRefusal) {
          return reply.code(err.statusCode).send({ error: err.message })
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
  source: string | null
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
  // #1720: a request with NO runtime is now the normal case — the dashboard
  // stopped picking one — so absence can no longer mean refusal. The runtime
  // check moves to the connector, which is the only party that knows the
  // answer and already refuses `--local` on an unsupported runtime by name.
  //
  // An EXPLICIT unsupported runtime is still refused here. Older clients that
  // still send the field keep the behaviour they were built against, and
  // refusing at setup time beats refusing at connector run time whenever we
  // genuinely know enough to do it.
  if (body.local_mcp === true && runtime && !LOCAL_MCP_RUNTIMES.has(runtime)) {
    reply.code(400).send({ error: 'Local MCP is only available for the Claude Code, Codex, and Cowork runtimes' })
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
    source: normalizeDiscoverySource(body.source),
  }
}

/**
 * Discovery-source attribution (#2302). A lowercase slug naming where this
 * setup came from (registry listing, the /402 page, a template, a skill).
 * Sanitized, never refused: attribution is telemetry, and a malformed tag
 * degrading to null must not block a connect. Mirrors the frontend's
 * `parseDiscoverySource` — keep the two rules identical.
 */
export function normalizeDiscoverySource(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const slug = value.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(slug) ? slug : null
}

// The command-path runtimes: Claude Code, Codex, and Cowork (which runs
// Claude Code's config). #1682 replaced #1672's collapsed 'agent' entry with
// named rows, and 'agent' stays accepted for the rollout window in which a
// deployed frontend still sends it. The legacy per-client ids stay too, for
// setups created before either change.
const LOCAL_MCP_RUNTIMES = new Set([
  'claude-code',
  'codex',
  'cowork',
  'agent',
  'codex-cli',
  'codex-desktop',
])

async function resolveUserSafe(userId: string, safeId?: string): Promise<UserSafeRow | null> {
  return setups.findUserSafe(userId, safeId)
}

async function loadSetupByToken(setupToken: string | undefined): Promise<SetupRow | null> {
  if (!setupToken || typeof setupToken !== 'string') return null
  return setups.findSetupByTokenHash(hashSetupSecret(setupToken))
}

async function loadSetupForUser(setupId: string, userId: string): Promise<SetupRow | null> {
  return setups.findSetupForUser(setupId, userId)
}

async function loadSetupAllowances(setupId: string): Promise<AllowanceRow[]> {
  return setups.listSetupAllowances(setupId)
}

/**
 * The rail-agnostic preconditions a setup must satisfy before its budget can
 * approve it. Originally the subset of the legacy `validateWalletApprovalBody`
 * that was not Safe-shaped, kept separate rather than branching inside it;
 * #2259 deleted that validator with the rail, and this is what survives.
 */
function validateBudgetApprovalPreconditions(
  setup: SetupRow,
  allowances: AllowanceRow[],
): { ok: true } | { ok: false; statusCode: 409 | 410; error: string } {
  if (setup.status === 'cancelled' || setup.status === 'expired' || setup.status === 'failed') {
    return { ok: false, statusCode: 409, error: 'Setup cannot be approved' }
  }
  if (!setups.WALLET_APPROVAL_STATES.has(setup.status)) {
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
    const active = await setups.listActiveDelegations(setup.agent_id)

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

async function persistWalletApprovalState(
  setup: SetupRow,
  input: setups.ApprovalStateInput,
): Promise<SetupRow | null> {
  return setups.applyApprovalState(setup, input)
}

/**
 * Auth for `GET /:setupId/connector-status` (#1377 part D).
 *
 * Distinct from `authenticateInstallStatus` below: that helper accepts a
 * setup TOKEN as an alternative to an agent key (install status can be
 * reported before an agent even exists) and folds the tenant check into one
 * query. This route always has an agent by the time it is called — the
 * connector only starts polling once /register handed it a key — so it
 * splits the check in two: first "is this API key valid for ANY agent"
 * (governs 401 vs proceeding), then the caller does a SEPARATE, setup-scoped
 * lookup for "is it valid for THIS agent's setup" (governs 404). Collapsing
 * both into one query, as `findSetupByAgentApiKeyHash` does, cannot
 * distinguish "no such key" from "wrong tenant" — and this endpoint's
 * contract requires it to (401 vs 404).
 *
 * Statuses allowed mirror `INSTALL_STATUS_AGENT_STATUSES`: `pending_approval`
 * (the normal pre-approval poll), `active` (the poll that discovers
 * approval), and `paused` (so a key does not go dark just because the agent
 * was paused after approval). `revoked` — and any unrecognised future status —
 * is refused, same fail-closed allow-list `agentAuthMiddleware` uses.
 */
async function authenticateConnectorStatusRequest(
  request: FastifyRequest,
): Promise<{ agentId: string; apiKeyHash: string } | null> {
  const apiKey = extractAgentApiKey(request)
  if (!apiKey) return null
  const hash = apiKeyHash(apiKey)
  const agentRow = await findAgentAuthRowByApiKeyHash(hash)
  if (!agentRow) return null
  if (!(setups.INSTALL_STATUS_AGENT_STATUSES as readonly string[]).includes(agentRow.status)) {
    return null
  }
  return { agentId: agentRow.id, apiKeyHash: hash }
}

/**
 * Poll-tolerant response body: `status` plus the approved budget once (and
 * only once) the setup is `active`. Sources the four fields from the
 * `agent_connection_setup_allowances` row(s) the setup itself stores — never
 * from the agent's api_key_hash/setup token/delegate signing material, none
 * of which this function ever touches.
 *
 * Singular by contract (`{ ... } | null`, not an array): the delegation rail
 * caps a connect-modal setup at one allowance (#1074), so `allowances[0]` is
 * the only budget for the setups this endpoint is meant for. A legacy-rail
 * setup approved with more than one token allowance would have its later
 * allowances silently unreported here — flagged to the captain rather than
 * widened, since the response shape was specified as singular.
 */
function buildConnectorStatusResponse(setup: SetupRow, allowances: AllowanceRow[]) {
  const primary = allowances[0]
  const approvedBudget =
    setup.status === 'active' && primary
      ? {
          token_symbol: primary.token_symbol,
          token_address: primary.token_address,
          amount: primary.allowance_amount,
          reset_period_min: primary.reset_period_min,
        }
      : null
  return {
    status: effectiveStatus(setup),
    approved_budget: approvedBudget,
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
      const setup = await setups.findSetupByIdAndTokenHash(setupId, hashSetupSecret(setupToken))
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
  return setups.findSetupByAgentApiKeyHash(setupId, apiKeyHash(apiKey))
}


// #1129: the hosted MCP URL is resolved by the ROUTE (via hostedMcpUrlOrReply)
// and passed in, so a configuration error is answered before any state changes
// rather than thrown from inside response building.
function buildConnectorSetupResponse(
  setup: SetupRow,
  allowances: AllowanceRow[],
  hostedMcpUrlValue: string,
) {
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
    hosted_mcp_url: hostedMcpUrlValue,
    x402_binding_signer: resolveX402BindingSignerAddress(),
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

// #1720: NO command carries --runtime any more. The dashboard stopped asking
// which runtime a user is in, because it never had a way to know: it sees no
// env markers, no installed clients, and no live agent. The connector sees all
// three (#1672 detection, #1719 self-report + installed-client prompt), so the
// resolution moved to the component that can answer.
//
// DETECTED_RUNTIMES went with it. That set existed to answer one question —
// "does this picked id need the flag spelled out?" — and with no picked id and
// no flag, nothing asked it. LOCAL_MCP_RUNTIMES stays because it still has a
// live caller in validateCreateBody.
function buildConnectorCommand(setupToken: string, apiUrl: string, localMcp = false): string {
  const args = [
    `npx -y ${CONNECTOR_PACKAGE}`,
    `--setup ${shellQuote(setupToken)}`,
    `--api ${shellQuote(apiUrl)}`,
    '--ack-local-tools',
  ]
  // `--local` is the ONE remaining suffix, and it is not environment-derived:
  // it is an advanced choice the user makes explicitly. Nothing here varies by
  // who is asking (#1720).
  if (localMcp) args.push('--local')
  return args.join(' ')
}

function buildSetupPrompt(command: string, apiUrl: string): string {
  const approvedActions = [
    `download and execute the published npm package ${CONNECTOR_PACKAGE}`,
    `connect to Haven at ${apiUrl}`,
    'write local Haven credential files under ~/.haven',
    'update the local agent MCP config when supported',
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
    'Network access is expected: this command downloads the npm package and contacts the Haven API, so if your environment is sandboxed, run it with network access enabled or request network access escalation; that changes the execution environment, not the command, and is not a third command modification.',
    '',
    'Do not print private keys, API keys, credential file contents, or config secrets in chat or logs.',
    '',
    'The Haven connector generates the signing key locally and sends Haven only the public signing address plus proof.',
    '',
    // #1545: one sentence of discoverability for agent operators — the flag is
    // opt-in and the pasted command stays the prose-mode default, so the
    // relay-to-human narration keeps working when the operator ignores this.
    'If you are orchestrating this setup programmatically, the connector also supports a --json mode: one machine-readable, secret-free result object on stdout, progress on stderr.',
    // #1719: the old sentence said appending --json was the ONLY permitted
    // change, which forbade the one retry the connector now asks an agent for
    // by name. Exactly two changes are permitted, and the second is bounded to
    // a value the refusal itself listed — an agent must never invent a runtime
    // name, because the name selects which app gets an API key and a signing
    // key written into it.
    'Only two changes to the command above are permitted, and no others: appending --json, and — only if the connector refuses because it could not determine the agent runtime — re-running it once with --runtime <name> added, naming the harness you are running in, using one of the values that refusal lists. Never invent a runtime name and never change anything else.',
    '',
    // #1545: "budget" is the connect flow's one name for the approval gate —
    // the same word the connector's own wait loop and celebration use (#1542).
    'When the connector finishes, tell me to return to Haven to approve the budget.',
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

/**
 * #1129: the default is paired to the backend's own identity. An explicit
 * variable always wins; the prod fallback is served only when the resolved
 * self-URL IS the production host; everywhere else (dev, localhost — on
 * purpose) this throws a configuration error naming the variable, which the
 * routes surface as a 500 instead of silently emitting another environment's
 * URL.
 */
export function hostedMcpUrl(request: FastifyRequest): string {
  const explicit = process.env.HAVEN_HOSTED_MCP_URL ?? process.env.NEXT_PUBLIC_HAVEN_MCP_URL
  if (explicit) return explicit.replace(/\/+$/, '')
  const self = apiBaseUrl(request)
  // A malformed self-URL (scheme-less HAVEN_API_URL, weird Host header) must
  // yield the ACTIONABLE config error, not a masked TypeError-500 (#1136
  // review) — treat unparseable as not-production.
  let selfHost: string | null = null
  try {
    selfHost = new URL(self).host
  } catch {
    selfHost = null
  }
  if (selfHost === PRODUCTION_API_HOST) {
    return DEFAULT_HOSTED_MCP_URL
  }
  throw new HostedMcpConfigError(
    `This backend (${self}) is not production, so it has no hosted MCP URL to hand out — ` +
      'set HAVEN_HOSTED_MCP_URL to this environment\'s hosted MCP (see .env.example), ' +
      'or connect with --local.',
  )
}

/**
 * Resolve the hosted MCP URL or answer the request with an explicit 500
 * configuration error (returns null after replying, so callers bail with
 * `return reply`). Call this OUTSIDE any transaction: a configuration error
 * must never consume a setup token, mutate a setup row, or leave a
 * registration half-created.
 */
function hostedMcpUrlOrReply(request: FastifyRequest, reply: FastifyReply): string | null {
  try {
    return hostedMcpUrl(request)
  } catch (err) {
    if (err instanceof HostedMcpConfigError) {
      request.log.error({ err }, 'hosted MCP URL not configured for this environment (#1129)')
      void reply.code(500).send({ error: err.message })
      return null
    }
    throw err
  }
}

// Address of the dedicated x402 binding key the backend signs expected-context
// with (X402_BINDING_PRIVATE_KEY). The edge signer must verify expected-context
// signatures against this address before signing an x402 funding hash, so we
// hand it to the connector at setup time to write into signer.json — otherwise
// the signer has no trusted verifier and refuses to sign x402 payments. Returns
// null when x402 binding is not configured on this deployment (the field is
// then omitted from the setup response). HAVEN_X402_BINDING_SIGNER overrides the
// derived address for deployments that hold only the public address here.
// `resolveX402BindingSignerAddress` (infra/chain — #994) reads env fresh per
// call, matching /resolve's low-frequency connect-time usage.

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
