import { describe, expect, it } from 'vitest'
import { AgentPaymentNextAction, HavenApiError, HavenError, HavenPaymentStateError } from '@haven_ai/sdk'
import { HostedToolError, normalizeError } from './tools/support/errors.js'
import { buildAgentGuidance, refusalNextStep } from './tools/support/guidance.js'

/** #3101 (decision 7): a refusal carries the same typed next step a success does. */
describe('a payment-state refusal carries a typed step from the default table (#3102)', () => {
  const state = (nextAction: string, paymentId = 'pay_1') =>
    new HavenPaymentStateError('m', 409, { paymentId, status: 'funded', phase: 'funded_but_unsettled', nextAction, rail: 'x402' } as never)
  it('check_status_later names the status read with the id', () => {
    const out = normalizeError(state('check_status_later'))
    expect(out.next_action).toBe('check_status_later')
    expect(out.next_tool).toBe('mcp__haven__haven_get_payment_status')
    expect(out.next_arguments).toEqual({ payment_id: 'pay_1' })
  })
  it('sweep_stranded_funds names the sweep', () => {
    expect(normalizeError(state('sweep_stranded_funds')).next_tool).toBe('mcp__haven__haven_sweep_delegate')
  })
  it('any other state names no tool and says why', () => {
    const out = normalizeError(state('none'))
    expect(out.next_tool).toBeUndefined()
    expect(out.next_tool_omitted_reason).toMatch(/cannot act on/)
    expect(normalizeError(state('retry_original_x402_request')).next_tool_omitted_reason).toMatch(/your own HTTP call/)
  })
})

describe('HostedToolError carries a NextStep (#3101)', () => {
  const summary = { payment_id: 'pay_1', status: 'funded' } as unknown as Parameters<typeof buildAgentGuidance>[0]['summary']
  it('normalizeError emits the next_tool family from the carried step', () => {
    const step = buildAgentGuidance({
      nextTool: 'haven_sweep_delegate',
      nextArguments: {},
      nextAction: AgentPaymentNextAction.SweepStrandedFunds,
      safeToContinue: false,
      reason: 'r',
      summary,
    })
    const failure = normalizeError(new HostedToolError({ code: 'X', message: 'm', statusCode: 400, paymentId: 'pay_1', nextStep: step }))
    expect(failure).toMatchObject({
      success: false,
      code: 'X',
      paymentId: 'pay_1',
      next_action: 'sweep_stranded_funds',
      next_tool: 'mcp__haven__haven_sweep_delegate',
      next_tool_server: 'haven',
      next_tool_name: 'haven_sweep_delegate',
      next_tool_server_role: 'hosted',
      next_arguments: {},
    })
    expect('next_tool_omitted_reason' in failure).toBe(false)
  })

  it('an omitted tool rides on the refusal with its reason, and nextAction alone still works', () => {
    const step = buildAgentGuidance({ nextTool: null, nextToolOmittedReason: 'why', nextAction: AgentPaymentNextAction.StopAndTellUser, safeToContinue: false, reason: 'r', summary })
    const failure = normalizeError(new HostedToolError({ code: 'X', message: 'm', nextStep: step }))
    expect(failure.next_tool).toBeUndefined()
    expect(failure.next_tool_omitted_reason).toBe('why')
    expect(failure.next_action).toBe('stop_and_tell_user')
    const plain = normalizeError(new HostedToolError({ code: 'X', message: 'm', nextStep: refusalNextStep({ nextAction: AgentPaymentNextAction.CheckStatusLater, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'p' } }) }))
    expect(plain.next_action).toBe('check_status_later')
    expect(plain.next_tool).toBe('mcp__haven__haven_get_payment_status')
  })
})

/**
 * #3214: the three GENERIC refusal branches — `HavenApiError`, `HavenError`
 * and anything unrecognized — carry the typed step too. #3102's rule ("no
 * hosted refusal carries a bare next_action") held only for refusals that
 * carry a `next_action`; these three carried none at all, and a transient
 * upstream 500 (the live case that filed this) left the agent with nothing
 * to act on. The step rides through `nextStepWireFields`, exactly as on the
 * state-error branch; deleting the added spread from any one of the three
 * branches turns one of these cases red (mutation M5's gap, closed).
 */
describe('the generic refusal branches carry a typed step (#3214)', () => {
  it('a 5xx HavenApiError — the live x402-quote 500 — says retry the same call once', () => {
    const out = normalizeError(new HavenApiError('Expected an x402 quote response with HTTP 402, got HTTP 500.', 500)) as unknown as Record<string, unknown>
    expect(out.success).toBe(false)
    expect(out.code).toBe('API_ERROR')
    expect(out.statusCode).toBe(500)
    expect(out.next_action).toBe('retry_with_explicit_context')
    expect(out.next_tool).toBeUndefined()
    expect(out.next_tool_omitted_reason).toMatch(/same arguments/)
    expect(out.next_tool_omitted_reason).toMatch(/idempotency_key/)
  })

  it('a 4xx HavenApiError says stop and tell the user', () => {
    const out = normalizeError(new HavenApiError('refused as made', 404)) as unknown as Record<string, unknown>
    expect(out.success).toBe(false)
    expect(out.statusCode).toBe(404)
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(out.next_tool).toBeUndefined()
    expect(out.next_tool_omitted_reason).toMatch(/cannot succeed/)
  })

  it('a HavenError — a client-side failure with no upstream answer — says stop and tell the user', () => {
    const out = normalizeError(new HavenError('config broke', 'CONFIG_ERROR', 500)) as unknown as Record<string, unknown>
    expect(out.code).toBe('CONFIG_ERROR')
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(out.next_tool).toBeUndefined()
    expect(out.next_tool_omitted_reason).toMatch(/tell the user/)
  })

  it('a thrown non-Error (UNKNOWN_ERROR) still carries the family', () => {
    const out = normalizeError('a string failure') as unknown as Record<string, unknown>
    expect(out.code).toBe('UNKNOWN_ERROR')
    expect(out.message).toBe('a string failure')
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(out.next_tool).toBeUndefined()
    expect(typeof out.next_tool_omitted_reason).toBe('string')
  })

  it('a status-less HavenApiError takes the retry family (the 4xx split needs a status)', () => {
    const out = normalizeError(new HavenApiError('no status reported', undefined as unknown as number)) as unknown as Record<string, unknown>
    expect(out.next_action).toBe('retry_with_explicit_context')
    expect(out.next_tool_omitted_reason).toBeDefined()
  })
})

describe('the typed rail-unavailable 503 is a stop with its own code (#3416)', () => {
  const railUnavailable = () =>
    new HavenApiError('This Haven deployment cannot serve delegation-rail bundler payments on chain 84532 yet.', 503, {
      error: 'This Haven deployment cannot serve delegation-rail bundler payments on chain 84532 yet.',
      error_code: 'rail_unavailable_for_chain',
      chain_id: 84532,
    })

  it('carries the machine-readable code RAIL_UNAVAILABLE_FOR_CHAIN, not the generic API_ERROR', () => {
    const out = normalizeError(railUnavailable())
    expect(out.code).toBe('RAIL_UNAVAILABLE_FOR_CHAIN')
    expect(out.statusCode).toBe(503)
  })

  it('says stop, never the 5xx "retry once" (retrying cannot succeed until an operator provisions the chain)', () => {
    const out = normalizeError(railUnavailable())
    expect(out.next_action).toBe(AgentPaymentNextAction.StopAndTellUser)
    expect(out.next_action).not.toBe(AgentPaymentNextAction.RetryWithExplicitContext)
  })

  it('any other 503 keeps the generic transient-retry step', () => {
    const out = normalizeError(new HavenApiError('bundler timeout', 503, { error: 'bundler timeout' }))
    expect(out.code).toBe('API_ERROR')
    expect(out.next_action).toBe(AgentPaymentNextAction.RetryWithExplicitContext)
  })
})

describe('the typed task-budget 403 is a stop with its own code (#3500)', () => {
  const taskBudgetExceeded = () =>
    new HavenApiError('This payment of 0.0005 USDC exceeds what is left of task budget tb_1 (0 USDC left).', 403, {
      error: 'This payment of 0.0005 USDC exceeds what is left of task budget tb_1 (0 USDC left).',
      error_code: 'task_budget_exceeded',
      task_budget_id: 'tb_1',
      remaining_atomic: '0',
    })

  it('carries TASK_BUDGET_EXCEEDED with the task budget id and remainder, not the generic API_ERROR', () => {
    const out = normalizeError(taskBudgetExceeded()) as unknown as Record<string, unknown>
    expect(out.code).toBe('TASK_BUDGET_EXCEEDED')
    expect(out.statusCode).toBe(403)
    expect(out.task_budget_id).toBe('tb_1')
    expect(out.remaining_atomic).toBe('0')
  })

  it('says stop and names the close-and-reopen remedy, never a retry', () => {
    const out = normalizeError(taskBudgetExceeded()) as unknown as Record<string, unknown>
    expect(out.next_action).toBe(AgentPaymentNextAction.StopAndTellUser)
    expect(String(out.next_tool_omitted_reason)).toMatch(/close it and open a new one/)
    expect(String(out.next_tool_omitted_reason)).toMatch(/retrying cannot succeed/)
  })

  it('any other 403 keeps the generic API_ERROR stop', () => {
    const out = normalizeError(new HavenApiError('forbidden', 403, { error: 'forbidden', error_code: 'unknown_rule' }))
    expect(out.code).toBe('API_ERROR')
  })
})

describe('the typed delegation-budget 403 is fund_account_or_raise_allowance with the figures (#3504)', () => {
  const delegationBudgetExceeded = () =>
    new HavenApiError(
      "This x402 payment of 0.001 USDC exceeds the agent's remaining budget for this period (0.0005 USDC, short by 0.0005 USDC).",
      403,
      {
        error:
          "This x402 payment of 0.001 USDC exceeds the agent's remaining budget for this period (0.0005 USDC, short by 0.0005 USDC). There is no approval queue on the delegation rail — an over-budget redemption reverts on-chain. Ask the wallet owner to grant or raise the budget in Haven, then retry.",
        error_code: 'delegation_budget_exceeded',
        phase: 'insufficient_funds',
        next_action: 'fund_account_or_raise_allowance',
        rail: 'x402',
        remaining: '0.0005',
        remaining_atomic: '500',
        shortfall: '0.0005',
        shortfall_atomic: '500',
      },
    )

  it('carries DELEGATION_BUDGET_EXCEEDED — the code the catalog path already emits — with the atomic figures', () => {
    const out = normalizeError(delegationBudgetExceeded()) as unknown as Record<string, unknown>
    expect(out.code).toBe('DELEGATION_BUDGET_EXCEEDED')
    expect(out.statusCode).toBe(403)
    expect(out.remaining_atomic).toBe('500')
    expect(out.shortfall_atomic).toBe('500')
    expect(out.phase).toBe('insufficient_funds')
    expect(out.rail).toBe('x402')
  })

  it('uses the backend next_action and names the remedy (owner raises the budget, or the period resets)', () => {
    const out = normalizeError(delegationBudgetExceeded()) as unknown as Record<string, unknown>
    expect(out.next_action).toBe(AgentPaymentNextAction.FundAccountOrRaiseAllowance)
    expect(String(out.next_tool_omitted_reason)).toMatch(/raise the budget in Haven/)
    expect(String(out.next_tool_omitted_reason)).toMatch(/period to reset/)
    expect(String(out.next_tool_omitted_reason)).toMatch(/retrying cannot succeed/)
  })
})
