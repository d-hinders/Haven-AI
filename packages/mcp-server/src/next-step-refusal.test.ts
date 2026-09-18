import { describe, expect, it } from 'vitest'
import { AgentPaymentNextAction, HavenPaymentStateError } from '@haven_ai/sdk'
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
