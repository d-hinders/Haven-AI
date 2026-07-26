/**
 * L0 Agent Passport routes (#972, epic #970).
 *
 * Issuance is OPT-IN and a SEPARATE action from agent creation (owner decision
 * 2026-07-24). These routes are the "later, for an existing agent" half; the
 * "at creation time" half is the `issue_passport` flag on `POST /agents`.
 *
 * Dashboard-authenticated (the owner opts in), not agent-authenticated: an
 * agent must not be able to issue itself a credential.
 */

import type { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { findAgentChain } from '../infra/repositories/agent-passports.js'
import {
  getPassport,
  requestPassport,
  issuePassportBestEffort,
  isPassportConfigured,
  passportStanding,
  PASSPORT_CHAIN_IDS,
} from '../lib/passport/index.js'


function serialize(row: Awaited<ReturnType<typeof getPassport>>) {
  if (!row) return null
  return {
    status: row.status,
    assurance_level: row.assurance_level,
    attestation_uid: row.attestation_uid,
    tx_hash: row.tx_hash,
    chain_id: row.chain_id,
    attempts: row.attempts,
    last_error: row.last_error,
    requested_at: row.requested_at,
    anchored_at: row.anchored_at,
  }
}

export default async function agentPassportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  /**
   * Current passport state. `passport: null` means the agent has none — the
   * normal case for a basic agent, never an error.
   */
  app.get<{ Params: { id: string } }>('/:id/passport', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await findAgentChain(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    // `standing` is the DB-authoritative answer; `passport.revocation_status`
    // merely describes how far the on-chain anchor has got (#973).
    const [passport, standing] = await Promise.all([
      getPassport(request.params.id),
      passportStanding(request.params.id),
    ])
    return reply.send({ passport: serialize(passport), standing })
  })

  /**
   * Opt in for an existing agent. Returns 202: the row is recorded
   * synchronously, the EAS write is fire-and-forget. A caller polls the GET
   * above (or #974's verifier) for the anchored state.
   */
  app.post<{ Params: { id: string } }>('/:id/passport', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agentId = request.params.id

    const agent = await findAgentChain(agentId, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    if (agent.chain_id == null) {
      return reply.code(400).send({
        error: 'Agent has no bound account — a passport attests the treasury it spends from',
      })
    }
    if (!PASSPORT_CHAIN_IDS.has(agent.chain_id)) {
      return reply.code(400).send({
        error: `Passports are not issued on chain ${agent.chain_id}`,
      })
    }
    if (!isPassportConfigured(agent.chain_id)) {
      // Fail-closed and HONEST: this is a deployment gap (#971's operator step),
      // not the caller's mistake, so it is a 503 rather than a 400.
      return reply.code(503).send({
        error: 'Passport issuance is not configured on this deployment yet',
      })
    }

    const existing = await getPassport(agentId)
    if (existing?.status === 'anchored') {
      // Idempotent: never mint a second attestation or re-spend gas.
      return reply.code(200).send({ passport: serialize(existing), already_issued: true })
    }

    await requestPassport(agentId, agent.chain_id)
    issuePassportBestEffort(agentId, sub)

    return reply.code(202).send({ passport: serialize(await getPassport(agentId)) })
  })
}
