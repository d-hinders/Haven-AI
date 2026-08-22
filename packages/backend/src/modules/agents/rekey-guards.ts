/**
 * The two authority refusals a re-key must make (#1698, epic #1694).
 *
 * Pure functions, deliberately living OUTSIDE `routes/agent-rekey.ts`. Two
 * reasons, and the second is the real one:
 *
 * 1. The route module pulls in the whole delegation-rail chain stack
 *    (bundler client, smart-accounts kit, viem). A rule that can only be
 *    exercised by loading all of that is a rule nobody checks.
 * 2. "Nothing is written when a refusal fires" is then true BY CONSTRUCTION
 *    rather than by inspection — neither function takes a database handle, so
 *    it cannot regress without a signature change.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'

/** The account fields the rail decision needs. */
export interface RekeyRailInput {
  account_type: string | null
  execution_rail: string | null
  treasury_address: string | null
}

/**
 * Refuse a caller presenting an agent credential.
 *
 * > "An agent can never re-key itself. Re-key is authorised by the account
 * > owner, through the dashboard. An agent rotating its own credentials would
 * > be an agent editing its own authority." (#1694)
 *
 * The re-key routes sit behind `authMiddleware`, so an agent API key does not
 * authenticate there at all — this guard is redundant today, and deliberately
 * so. "The invariant holds because of which hook is installed" is a fact
 * about today's wiring, not a rule anyone reads, and a refactor that added an
 * agent-auth hook would take the invariant with it silently. Stating the rule
 * where it applies also means the agent gets an answer that names it instead
 * of a bare 401.
 *
 * Returns true when it has replied and the caller should stop.
 */
export function refuseAgentCaller(request: FastifyRequest, reply: FastifyReply): boolean {
  const header = request.headers.authorization ?? ''
  const apiKeyHeader = request.headers['x-api-key']
  const looksLikeAgentKey =
    header.replace(/^Bearer\s+/i, '').startsWith('sk_agent_') ||
    (typeof apiKeyHeader === 'string' && apiKeyHeader.startsWith('sk_agent_'))
  if (!looksLikeAgentKey) return false
  reply.code(403).send({
    error: 'agent_cannot_rekey',
    detail:
      'An agent cannot re-key itself — that would be an agent editing its own authority. ' +
      'Re-key is authorised by the account owner from the Haven dashboard.',
  })
  return true
}

/**
 * Refuse anything that is not a provisioned delegation-rail account.
 *
 * > "Re-key is delegation-rail only. Legacy AllowanceModule is import-only
 * > and its authority is per-token allowances rather than a signed
 * > delegation. Legacy accounts get an explicit refusal naming re-onboarding
 * > as the path." (#1694)
 *
 * The legacy refusal names the path AND the reason. "Not supported" reads as
 * an oversight when it is a structural difference between the rails: there is
 * no delegation to revoke and reissue, so there is no period to carry, so a
 * re-key could not preserve the thing a re-key exists to preserve.
 *
 * Null means permitted.
 */
export function railRefusal(agent: RekeyRailInput): { statusCode: number; body: unknown } | null {
  // Both conditions, not either: a half-provisioned account that claims the
  // delegation type but has no treasury has nothing to revoke or issue
  // against, and would fail at the revoke step with the ledger row already
  // written.
  if (agent.account_type === 'delegator_hybrid' && agent.treasury_address) return null

  if (agent.execution_rail === 'allowance_module') {
    return {
      statusCode: 409,
      body: {
        error: 'rekey_not_supported_on_legacy_rail',
        detail:
          "This account is on the legacy AllowanceModule rail, where an agent's authority is a " +
          'set of per-token on-chain allowances rather than a signed delegation — there is no ' +
          'delegation to revoke and reissue, so a re-key cannot preserve the budget period. ' +
          'Re-onboard the agent on the delegation rail instead: create a new agent through the ' +
          'connect flow, grant it a budget, then revoke the old agent.',
      },
    }
  }
  return {
    statusCode: 409,
    body: {
      error: 'rekey_requires_delegation_rail',
      detail:
        'Agent account is not on the delegation rail — re-key is delegation-rail only. ' +
        'Re-onboard the agent on the delegation rail to rotate its credentials.',
    },
  }
}
