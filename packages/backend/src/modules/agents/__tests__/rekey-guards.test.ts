/**
 * The two authority refusals on the re-key route (#1698, epic #1694).
 *
 * Both live in `modules/agents/rekey-guards.ts` rather than inside the route,
 * and are tested directly rather than through a Fastify instance, for a reason
 * worth stating: each one is a RULE,
 * and a rule that is only observable by driving a request through five layers
 * of mocks is a rule nobody can check. Testing them here means the refusal
 * text — which is the part a stuck user actually reads — is asserted too, not
 * just the status code.
 *
 * What this file does NOT cover, and where it is covered instead: the stage
 * ordering lives in `modules/agents/rekey-stages.test.ts` and, independently,
 * in the CHECK constraints proven by
 * `infra/repositories/__tests__/agent-rekeys.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { railRefusal, refuseAgentCaller } from '../rekey-guards.js'

function fakeReply(): FastifyReply & { statusCode?: number; payload?: unknown } {
  const reply = {
    statusCode: undefined as number | undefined,
    payload: undefined as unknown,
    code(status: number) {
      reply.statusCode = status
      return reply
    },
    send(body: unknown) {
      reply.payload = body
      return reply
    },
  }
  return reply as unknown as FastifyReply & { statusCode?: number; payload?: unknown }
}

function fakeRequest(headers: Record<string, string> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest
}

describe('an agent can never re-key itself', () => {
  it('refuses a caller presenting an agent API key as a Bearer token', () => {
    const reply = fakeReply()
    const handled = refuseAgentCaller(
      fakeRequest({ authorization: 'Bearer sk_agent_deadbeefdeadbeef' }),
      reply,
    )

    expect(handled).toBe(true)
    expect(reply.statusCode).toBe(403)
    const body = reply.payload as { error: string; detail: string }
    expect(body.error).toBe('agent_cannot_rekey')
    // The refusal names the rule and the actual path, because "403" tells a
    // stuck agent nothing about whether it should retry.
    expect(body.detail).toMatch(/editing its own authority/)
    expect(body.detail).toMatch(/account owner/)
    expect(body.detail).toMatch(/dashboard/)
  })

  it('refuses the X-API-Key form too', () => {
    const reply = fakeReply()
    expect(refuseAgentCaller(fakeRequest({ 'x-api-key': 'sk_agent_abc123' }), reply)).toBe(true)
    expect(reply.statusCode).toBe(403)
  })

  it('MUTATION TARGET — the refusal is not merely "authMiddleware would have stopped it"', () => {
    // This is the point of the explicit guard. `authMiddleware` means an
    // agent key does not authenticate on this router TODAY; that is a fact
    // about which hook is installed, and a refactor could change it without
    // anyone noticing the invariant left with it. Deleting refuseAgentCaller
    // makes this test fail even though the route would still be behind
    // session auth.
    const reply = fakeReply()
    refuseAgentCaller(fakeRequest({ authorization: 'Bearer sk_agent_x' }), reply)
    expect(reply.statusCode).toBe(403)
    expect((reply.payload as { error: string }).error).toBe('agent_cannot_rekey')
  })

  it('lets an ordinary dashboard session through untouched', () => {
    const reply = fakeReply()
    expect(refuseAgentCaller(fakeRequest({ authorization: 'Bearer eyJhbGciOi...' }), reply)).toBe(
      false,
    )
    expect(reply.statusCode).toBeUndefined()
    expect(reply.payload).toBeUndefined()
  })

  it('lets an unauthenticated request through to the normal auth failure', () => {
    // Not this guard's job — a missing credential is authMiddleware's 401,
    // and answering 403 here would misdescribe it.
    const reply = fakeReply()
    expect(refuseAgentCaller(fakeRequest({}), reply)).toBe(false)
  })
})

describe('re-key is delegation-rail only', () => {
  const delegationAgent = {
    treasury_address: '0xt1',
    account_type: 'delegator_hybrid',
    execution_rail: 'delegation',
  }

  it('permits a delegation-rail account', () => {
    expect(railRefusal(delegationAgent)).toBeNull()
  })

  it('refuses a legacy AllowanceModule account, NAMING re-onboarding as the path', () => {
    const refusal = railRefusal({
      ...delegationAgent,
      account_type: null,
      execution_rail: 'allowance_module',
    })
    expect(refusal?.statusCode).toBe(409)
    const body = refusal?.body as { error: string; detail: string }
    expect(body.error).toBe('rekey_not_supported_on_legacy_rail')
    // The acceptance criterion is specifically that the message names the
    // path, not merely that the call is refused. A user whose key is lost
    // needs to know what to do next.
    expect(body.detail).toMatch(/re-onboard/i)
    expect(body.detail).toMatch(/delegation rail/i)
    // And it says WHY, because "not supported" reads as an oversight when it
    // is actually a structural difference between the rails.
    expect(body.detail).toMatch(/per-token on-chain allowances/i)
  })

  it('refuses an account with no treasury even if it claims the delegation type', () => {
    // Half-provisioned: there is no account to revoke or issue against.
    const refusal = railRefusal({ ...delegationAgent, treasury_address: null })
    expect(refusal?.statusCode).toBe(409)
    expect((refusal?.body as { error: string }).error).toBe('rekey_requires_delegation_rail')
  })

  it('refuses a retired session-rail account', () => {
    const refusal = railRefusal({
      ...delegationAgent,
      account_type: null,
      execution_rail: 'session_key',
    })
    expect(refusal?.statusCode).toBe(409)
    expect((refusal?.body as { detail: string }).detail).toMatch(/delegation rail/i)
  })

  it('MUTATION TARGET — the rail check keys on account_type AND treasury, not on either alone', () => {
    // Loosening this to `account_type === 'delegator_hybrid'` alone would
    // let a half-provisioned account into the flow, where the revoke step
    // would fail after the ledger row was written.
    expect(railRefusal({ ...delegationAgent, treasury_address: null })).not.toBeNull()
    expect(railRefusal({ ...delegationAgent, account_type: 'safe' })).not.toBeNull()
  })
})

describe('nothing is written when a refusal fires', () => {
  it('both guards are pure — neither can reach a repository', () => {
    // Stated as a property of the SIGNATURES rather than as an integration
    // assertion: neither function takes a database handle or imports one, so
    // "nothing is written on a refusal" is true by construction and cannot
    // regress without a signature change that a reviewer would see. This is
    // also why the guards live outside the route module — inside it, the
    // claim would depend on reading a 700-line file.
    expect(railRefusal).toHaveLength(1)
    expect(refuseAgentCaller).toHaveLength(2)
  })
})
