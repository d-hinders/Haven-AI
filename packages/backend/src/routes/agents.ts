import { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { authMiddleware } from '../middleware/auth.js'
import {
  normalizeAgentAllowance,
  normalizeAgentAllowances,
  normalizeAgentAllowanceTokenAddress,
} from '../modules/agents/index.js'
import { getTokenBalance } from '../rails/allowance-module.js'
import { DEFAULT_CHAIN_ID } from '@haven_ai/core'
import { emitFunnelEvent } from '../infra/repositories/onboarding-funnel.js'
import { getChain, isSupportedChain } from '../domain/chains.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  requestPassport,
  issuePassportBestEffort,
  enqueuePassportRevocation,
  revokePassportBestEffort,
  isPassportConfigured,
  PASSPORT_CHAIN_IDS,
} from '../modules/passport/index.js'
import { formatTokenValue } from '../domain/tokens.js'
import { deriveDelegationAllowances } from '../rails/delegation-budget-view.js'
import {
  agentExistsForUser,
  createAgentWithAllowances,
  deleteAgentAllowance,
  deleteRevokedAgent,
  findAgentForUserAllStatuses,
  findAgentIdStatusForUser,
  findDefaultUserSafeId,
  findDelegateAgentForUser,
  findNonRevokedAgentIdByDelegate,
  findUserSafeIdForUser,
  listAgentsForUserAllStatuses,
  listAllowancesForAgent,
  listAllowancesForAgentUnordered,
  listAllowancesForAgents,
  pauseAgent,
  resumeAgent,
  revokeAgent,
  rotateAgentApiKey,
  updateAgentProfile,
  upsertAgentAllowance,
  type AgentAllowanceRow,
} from '../infra/repositories/agents.js'

// ── Types ──────────────────────────────────────────────────────────

interface CreateAgentBody {
  name: string
  description?: string
  delegate_address: string
  safe_id?: string
  /**
   * Opt in to an L0 Agent Passport at creation time (#972). Absent/false is the
   * DEFAULT and the normal case: a basic agent has no passport and behaves
   * exactly as before. Issuance is fire-and-forget — it can never fail or delay
   * agent creation (owner decision 2026-07-24; v6 review point 2).
   */
  issue_passport?: boolean
  allowances?: {
    token_address: string
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }[]
}

interface UpdateAgentBody {
  name?: string
  description?: string
}

// ── Routes ─────────────────────────────────────────────────────────

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /agents — list agents with their on-chain allowance config
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    // ALL statuses on purpose — pending_approval agents are surfaced (#1069).
    const agentRows = await listAgentsForUserAllStatuses(sub)

    if (agentRows.length === 0) {
      return { agents: [] }
    }

    const agentIds = agentRows.map((a) => a.id)

    const allowanceRows = await listAllowancesForAgents(agentIds)

    const allowancesByAgent = new Map<string, AgentAllowanceRow[]>()
    for (const row of allowanceRows) {
      const existing = allowancesByAgent.get(row.agent_id) ?? []
      existing.push(row)
      allowancesByAgent.set(row.agent_id, existing)
    }

    // Delegation-rail agents derive their budget from ACTIVE delegations —
    // agent_allowances is a frozen onboarding mirror on that rail (#1090).
    const delegationAgentIds = agentRows
      .filter((a) => a.account_type === 'delegator_hybrid')
      .map((a) => a.id)
    const derivedByAgent = await deriveDelegationAllowances(delegationAgentIds)

    const agents = agentRows.map((agent) => ({
      ...agent,
      allowances:
        agent.account_type === 'delegator_hybrid'
          ? (derivedByAgent.get(agent.id) ?? [])
          : (allowancesByAgent.get(agent.id) ?? []),
    }))

    return { agents }
  })

  // GET /agents/:id — fetch one agent with its on-chain allowance config
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    // Same ALL-statuses rule as the list (#1069).
    const agent = await findAgentForUserAllStatuses(id, sub)
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' })
    }

    if (agent.account_type === 'delegator_hybrid') {
      // Live budget = the active delegations, not the onboarding mirror (#1090).
      const derived = await deriveDelegationAllowances([id])
      return { ...agent, allowances: derived.get(id) ?? [] }
    }

    const allowances = await listAllowancesForAgent(id)

    return {
      ...agent,
      allowances,
    }
  })

  // GET /agents/:id/delegate-balance — on-chain USDC + ETH balance of the delegate EOA
  app.get<{ Params: { id: string } }>('/:id/delegate-balance', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    // Status-agnostic since #1403: revoked and archived agents resolve like
    // any other — the delegate EOA can hold stranded funds precisely AFTER a
    // revoke, and this read backs the sweep page that recovers them.
    const agent = await findDelegateAgentForUser(id, sub)
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' })
    }
    if (!agent.delegate_address) {
      return reply.code(422).send({ error: 'Agent has no delegate address' })
    }

    const chainId = agent.safe_chain_id ?? DEFAULT_CHAIN_ID
    if (!isSupportedChain(chainId)) {
      return reply.code(422).send({ error: `Unsupported chain: ${chainId}` })
    }

    const chain = getChain(chainId)
    const delegate = agent.delegate_address

    const usdcConfig = Object.values(chain.tokens).find((t) => t.symbol === 'USDC')

    const [ethAtomic, usdcAtomic] = await Promise.all([
      getTokenBalance(chainId, delegate, '0x0000000000000000000000000000000000000000'),
      usdcConfig?.address ? getTokenBalance(chainId, delegate, usdcConfig.address) : Promise.resolve(0n),
    ])

    return {
      delegate_address: delegate,
      safe_address: agent.safe_address,
      chain_id: chainId,
      eth: formatTokenValue(ethAtomic.toString(), 18),
      eth_atomic: ethAtomic.toString(),
      usdc: formatTokenValue(usdcAtomic.toString(), 6),
      usdc_atomic: usdcAtomic.toString(),
      usdc_address: usdcConfig?.address ?? null,
    }
  })

  // POST /agents — create agent with delegate address and on-chain allowance config
  app.post<{ Body: CreateAgentBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { name, description, delegate_address, safe_id, allowances, issue_passport } = request.body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' })
    }
    if (!delegate_address || !isValidAddress(delegate_address)) {
      return reply.code(400).send({ error: 'Valid delegate address is required' })
    }
    const normalizedAllowances = normalizeAgentAllowances(allowances)
    if (!normalizedAllowances.ok) {
      return reply.code(400).send({ error: normalizedAllowances.error })
    }

    // Validate safe_id belongs to the user (if provided)
    let resolvedSafeId: string | null = null
    if (safe_id) {
      const ownedSafeId = await findUserSafeIdForUser(safe_id, sub)
      if (!ownedSafeId) {
        return reply.code(400).send({ error: 'Invalid Safe — not found or not yours' })
      }
      resolvedSafeId = safe_id
    } else {
      resolvedSafeId = await findDefaultUserSafeId(sub)
    }

    const existingAgentId = await findNonRevokedAgentIdByDelegate(sub, delegate_address.toLowerCase())
    if (existingAgentId) {
      return reply
        .code(409)
        .send({ error: 'An active agent with this delegate address already exists' })
    }

    const apiKey = `sk_agent_${crypto.randomBytes(24).toString('hex')}`
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex')
    // The api_key_prefix column is VARCHAR(12); slicing 20 overflows it and the
    // INSERT fails (Postgres 22001), 500-ing every agent creation. Matches the
    // rotate-key path, which already slices 12.
    const apiKeyPrefix = apiKey.slice(0, 12)

    try {
      const { agent, safeInfo, savedAllowances } = await createAgentWithAllowances(
        {
          userId: sub,
          name: name.trim(),
          description: description?.trim() ?? null,
          delegateAddress: delegate_address.toLowerCase(),
          apiKeyHash,
          apiKeyPrefix,
          safeId: resolvedSafeId,
        },
        normalizedAllowances.value,
      )

      emitFunnelEvent(sub, 'agent_created', { agent_id: agent.id })
      if (savedAllowances.length > 0) {
        emitFunnelEvent(sub, 'allowance_granted', { agent_id: agent.id })
      }
      // Opt-in passport (#972). Deliberately AFTER the transaction commits and
      // outside any try that could turn a passport problem into a failed agent:
      // requestPassport records the intent, then the EAS write is fire-and-forget.
      // A slow, failing, or unfunded attestation degrades to "pending"/"failed"
      // on the passport row and never touches this response.
      // Narrowed to a local so the chain id stays non-null for the call below;
      // eligibility mirrors POST /agents/:id/passport so the two entry points
      // agree rather than one silently creating a permanently-failed row.
      const passportChainId =
        issue_passport === true &&
        safeInfo.safe_chain_id != null &&
        PASSPORT_CHAIN_IDS.has(safeInfo.safe_chain_id)
          ? safeInfo.safe_chain_id
          : null
      if (passportChainId != null) {
        try {
          await requestPassport(agent.id, passportChainId)
          // Parity with POST /agents/:id/passport (#1043): on a deployment
          // where the schema UID is not registered, the :id route 503s. Agent
          // creation must not fail for that — the intent is recorded above and
          // the sweep anchors it once the operator registers — but firing a
          // guaranteed-to-fail attempt here would only burn a retry and start
          // the backoff clock early.
          if (isPassportConfigured(passportChainId)) {
            issuePassportBestEffort(agent.id, sub)
          } else {
            request.log.info(
              { agentId: agent.id, chainId: passportChainId },
              'passport requested but schema not registered — deferred to the sweep',
            )
          }
        } catch (err) {
          request.log.warn({ err, agentId: agent.id }, 'passport request failed; agent created')
        }
      }

      return reply.code(201).send({
        ...agent,
        ...safeInfo,
        api_key: apiKey,
        allowances: savedAllowances,
        passport_requested: passportChainId != null,
      })
    } catch (err) {
      if (isUniqueDelegateConflict(err)) {
        return reply
          .code(409)
          .send({ error: 'An active agent with this delegate address already exists' })
      }
      throw err
    }
  })

  // PUT /agents/:id — update agent name/description
  app.put<{ Params: { id: string }; Body: UpdateAgentBody }>(
    '/:id',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const { name, description } = request.body

      const updated = await updateAgentProfile(
        id,
        sub,
        name?.trim() ?? null,
        description?.trim() ?? null,
      )

      if (!updated) {
        return reply.code(404).send({ error: 'Agent not found' })
      }

      const allowances = await listAllowancesForAgentUnordered(id)

      return {
        ...updated,
        allowances,
      }
    },
  )

  // DELETE /agents/:id
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const deleted = await deleteRevokedAgent(id, sub)

    if (!deleted) {
      const exists = await agentExistsForUser(id, sub)
      if (!exists) {
        return reply.code(404).send({ error: 'Agent not found' })
      }
      return reply.code(409).send({ error: 'Only revoked agents can be deleted' })
    }

    return { success: true }
  })

  // POST /agents/:id/revoke — revoke an agent
  app.post<{ Params: { id: string } }>(
    '/:id/revoke',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const revoked = await revokeAgent(id, sub)

      if (!revoked) {
        return reply
          .code(404)
          .send({ error: 'Agent not found or cannot be revoked' })
      }

      // The UPDATE above IS the revocation — authoritative and already applied
      // (#973). Flipping the on-chain anchor is a separate, eventually-consistent
      // step: enqueued and fired best-effort so a slow or failing EAS revoke can
      // never delay or fail the user's revoke. It retries until the two agree.
      try {
        await enqueuePassportRevocation(id)
        // Fired unconditionally, not gated on the enqueue's return. The enqueue
        // is a no-op while a passport is still anchoring, and gating on it meant
        // the attempt depended on a value read a moment earlier. `claimRevocation`
        // re-checks the invariant atomically, so this is a no-op when there is
        // nothing to revoke and correct when there is.
        revokePassportBestEffort(id)
      } catch (err) {
        request.log.warn({ err, agentId: id }, 'passport revocation enqueue failed; agent revoked')
      }

      return { success: true }
    },
  )

  // POST /agents/:id/rotate-key — generate a new API key for an active agent
  app.post<{ Params: { id: string } }>(
    '/:id/rotate-key',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const newKey = `sk_agent_${crypto.randomBytes(24).toString('hex')}`
      const newKeyHash = crypto.createHash('sha256').update(newKey).digest('hex')
      const prefix = newKey.slice(0, 12)

      const rotated = await rotateAgentApiKey(newKeyHash, prefix, id, sub)

      if (!rotated) {
        const existing = await findAgentIdStatusForUser(id, sub)
        if (!existing) {
          return reply.code(404).send({ error: 'Agent not found' })
        }
        return reply.code(409).send({ error: 'Agent is not active' })
      }

      return { api_key: newKey, api_key_prefix: prefix }
    },
  )

  // POST /agents/:id/pause — block new API-initiated payments in Haven
  app.post<{ Params: { id: string } }>(
    '/:id/pause',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const paused = await pauseAgent(id, sub)

      if (!paused) {
        return reply
          .code(404)
          .send({ error: 'Agent not found or cannot be paused' })
      }

      return { success: true }
    },
  )

  // POST /agents/:id/resume — restore API-initiated payments in Haven
  app.post<{ Params: { id: string } }>(
    '/:id/resume',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const resumed = await resumeAgent(id, sub)

      if (!resumed) {
        return reply
          .code(404)
          .send({ error: 'Agent not found or cannot be resumed' })
      }

      return { success: true }
    },
  )

  // POST /agents/:id/allowances — add/update an allowance record (mirrors on-chain)
  app.post<{
    Params: { id: string }
    Body: {
      token_address: string
      token_symbol: string
      allowance_amount: string
      reset_period_min: number
    }
  }>('/:id/allowances', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params
    const normalizedAllowance = normalizeAgentAllowance(request.body)
    if (!normalizedAllowance.ok) {
      return reply.code(400).send({ error: normalizedAllowance.error })
    }

    const agentCheck = await findAgentIdStatusForUser(id, sub)
    if (!agentCheck) {
      return reply.code(404).send({ error: 'Agent not found' })
    }
    if (agentCheck.status === 'pending_approval') {
      return reply
        .code(409)
        .send({ error: 'Agent rules are pending wallet approval and cannot be changed here' })
    }
    if (agentCheck.status === 'revoked') {
      return reply
        .code(409)
        .send({ error: 'Revoked agent rules cannot be changed' })
    }

    const saved = await upsertAgentAllowance(id, normalizedAllowance.value)

    return {
      ...saved,
      // #802: with an enabled budget schedule, this edit takes effect on-chain
      // Session schedules are retired (#834); the warning slot stays null for
      // response-shape compatibility until clients drop it.
      schedule_warning: null,
    }
  })

  // DELETE /agents/:id/allowances/:tokenAddress
  app.delete<{ Params: { id: string; tokenAddress: string } }>(
    '/:id/allowances/:tokenAddress',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id, tokenAddress } = request.params
      const normalizedTokenAddress = normalizeAgentAllowanceTokenAddress(tokenAddress)
      if (!normalizedTokenAddress.ok) {
        return reply.code(400).send({ error: normalizedTokenAddress.error })
      }

      const agentCheck = await findAgentIdStatusForUser(id, sub)
      if (!agentCheck) {
        return reply.code(404).send({ error: 'Agent not found' })
      }
      if (agentCheck.status === 'pending_approval') {
        return reply
          .code(409)
          .send({ error: 'Agent rules are pending wallet approval and cannot be changed here' })
      }
      if (agentCheck.status === 'revoked') {
        return reply
          .code(409)
          .send({ error: 'Revoked agent rules cannot be changed' })
      }

      const deleted = await deleteAgentAllowance(id, normalizedTokenAddress.value)

      if (!deleted) {
        return reply.code(404).send({ error: 'Allowance not found' })
      }

      return { success: true }
    },
  )
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
