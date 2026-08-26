import { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { authMiddleware } from '../middleware/auth.js'
import { normalizeAgentAllowanceTokenAddress } from '../modules/agents/index.js'
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
  createAgent,
  agentHasLiveDelegations,
  archiveAgent,
  unarchiveAgent,
  findAgentForUserAllStatuses,
  findAgentIdStatusForUser,
  findDefaultUserSafeId,
  findDelegateAgentForUser,
  findNonRevokedAgentIdByDelegate,
  findUserSafeIdForUser,
  listAgentsForUserAllStatuses,
  pauseAgent,
  resumeAgent,
  revokeAgent,
  rotateAgentApiKey,
  updateAgentProfile,
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

    // Delegation-rail agents derive their budget from ACTIVE delegations
    // (#1090). Legacy-rail agents get an empty list: the Safe rail is retired
    // (#1440/#2020) and `agent_allowances` is no longer read anywhere — this
    // handler must work with the table gone.
    const delegationAgentIds = agentRows
      .filter((a) => a.account_type === 'delegator_hybrid')
      .map((a) => a.id)
    const derivedByAgent = await deriveDelegationAllowances(delegationAgentIds)

    const agents = agentRows.map((agent) => ({
      ...agent,
      allowances:
        agent.account_type === 'delegator_hybrid'
          ? (derivedByAgent.get(agent.id) ?? [])
          : [],
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
      // Live budget = the active delegations, not an onboarding mirror (#1090).
      const derived = await deriveDelegationAllowances([id])
      return { ...agent, allowances: derived.get(id) ?? [] }
    }

    // Legacy rail retired (#1440/#2020): no allowance config to show.
    return {
      ...agent,
      allowances: [],
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

  // POST /agents — create agent with a delegate address; spend authority is
  // granted separately as a delegation (#1440/#2020)
  app.post<{ Body: CreateAgentBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { name, description, delegate_address, safe_id, allowances, issue_passport } = request.body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' })
    }
    if (!delegate_address || !isValidAddress(delegate_address)) {
      return reply.code(400).send({ error: 'Valid delegate address is required' })
    }
    // #2020: the allowance mirror is retired with the Safe rail. Refuse rather
    // than silently drop — a caller passing allowances believes it is granting
    // authority, and nothing here grants anything any more.
    if (Array.isArray(allowances) && allowances.length > 0) {
      return reply.code(400).send({
        error:
          'Per-token allowances are retired with the Safe rail (#1440). Grant the agent a budget delegation instead.',
      })
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
      const { agent, safeInfo } = await createAgent({
        userId: sub,
        name: name.trim(),
        description: description?.trim() ?? null,
        delegateAddress: delegate_address.toLowerCase(),
        apiKeyHash,
        apiKeyPrefix,
        safeId: resolvedSafeId,
      })

      emitFunnelEvent(sub, 'agent_created', { agent_id: agent.id })
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
        // Always empty since #2020 — kept for response-shape compatibility;
        // budgets arrive later as delegation grants.
        allowances: [],
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

      // #2020: the response's allowances mirror the GET contract — derived
      // from active delegations on the delegation rail, empty on the retired
      // legacy rail. `agent_allowances` is never read.
      const allowances =
        updated.account_type === 'delegator_hybrid'
          ? ((await deriveDelegationAllowances([id])).get(id) ?? [])
          : []

      return {
        ...updated,
        allowances,
      }
    },
  )

  // DELETE /agents/:id — RETIRED (#1401). Hard deletion both failed on any
  // agent with payment history (FK NO ACTION on payment_intents /
  // approval_requests → 23503 → 500) and, where it succeeded, cascaded away
  // seven tables of money-path audit trail. The typed route stays as a 410
  // tombstone for reversibility, in the same spirit as the session-rail
  // retirement (#834). Nothing is written on this path any more.
  app.delete<{ Params: { id: string } }>('/:id', async (_request, reply) => {
    return reply.code(410).send({
      error:
        'Deleting agents is retired: removal is an archive, and history is kept. Use POST /agents/:id/archive on a revoked agent instead.',
    })
  })

  // POST /agents/:id/archive — soft-archive a REVOKED agent (#1401). A filing
  // action only: requires status='revoked' so archiving is never the thing
  // that stops spending, keeps every dependent audit row, and is idempotent
  // (re-archiving keeps the original archived_at, no timestamp churn).
  //
  // #1436: it also requires DEAD BUDGETS. Revoking only flips the agent's
  // status, so revoke+archive without revoke-all used to file an agent under
  // "Removed" while its delegation was still redeemable on-chain. The Remove
  // dialog always killed budgets first, but that ordering was frontend
  // convention, not an invariant — and "Removed" is a promise about spending.
  app.post<{ Params: { id: string } }>('/:id/archive', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const archived = await archiveAgent(id, sub)
    if (!archived) {
      const exists = await agentExistsForUser(id, sub)
      if (!exists) {
        return reply.code(404).send({ error: 'Agent not found' })
      }
      // Name the actual blocker: live budgets and a live credential need
      // different remedies, and a caller told the wrong one is stuck.
      if (await agentHasLiveDelegations(id)) {
        return reply.code(409).send({
          error:
            'This agent still holds budget delegations, so archiving would hide an agent that can still spend. Stop them first with POST /agents/:id/delegations/revoke-all, then archive.',
        })
      }
      return reply.code(409).send({
        error: 'Only revoked agents can be archived. Revoke the agent first — archiving never stops spending by itself.',
      })
    }

    return { success: true, archived_at: archived.archived_at }
  })

  // POST /agents/:id/unarchive — return the agent to the primary list. The
  // status stays exactly as it was (revoked): un-archiving restores no
  // authority of any kind.
  app.post<{ Params: { id: string } }>('/:id/unarchive', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const unarchived = await unarchiveAgent(id, sub)
    if (!unarchived) {
      const exists = await agentExistsForUser(id, sub)
      if (!exists) {
        return reply.code(404).send({ error: 'Agent not found' })
      }
      // Not archived — nothing to do; treat as success for idempotency.
      return { success: true }
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

  // POST /agents/:id/allowances — RETIRED (#1440/#2020). The allowance mirror
  // was legacy-rail spend-authority configuration; on the delegation rail a
  // budget is a signed delegation grant, never a row. Typed 410 tombstone in
  // the same spirit as DELETE /agents/:id (#1401) and the session rail (#834).
  // Nothing is written on this path any more.
  app.post<{ Params: { id: string } }>('/:id/allowances', async (_request, reply) => {
    return reply.code(410).send({
      error:
        'Per-token allowances are retired with the Safe rail (#1440). Grant the agent a budget delegation instead.',
    })
  })

  // DELETE /agents/:id/allowances/:tokenAddress — RETIRED (#1440/#2020), same
  // tombstone contract as the POST above. The token-address parse stays so a
  // malformed call still gets its 400 rather than a misleading 410.
  app.delete<{ Params: { id: string; tokenAddress: string } }>(
    '/:id/allowances/:tokenAddress',
    async (request, reply) => {
      const normalizedTokenAddress = normalizeAgentAllowanceTokenAddress(request.params.tokenAddress)
      if (!normalizedTokenAddress.ok) {
        return reply.code(400).send({ error: normalizedTokenAddress.error })
      }
      return reply.code(410).send({
        error:
          'Per-token allowances are retired with the Safe rail (#1440). Revoke or change the agent’s budget delegation instead.',
      })
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
