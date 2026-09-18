import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NEXT_TOOL_BY_ACTION,
  createNextStepBuilder,
  defaultNextToolFor,
  parseNextTool,
  renderNextTool,
  type NextStepTarget,
} from './next-step.js'
import { AgentPaymentNextAction } from './types.js'

const target = <T,>(role: 'hosted' | 'signer', required: string[]): NextStepTarget<T> => ({
  role,
  validate: (input) => {
    const o = (input ?? {}) as Record<string, unknown>
    const missing = required.filter((k) => typeof o[k] !== 'string')
    return missing.length ? `${missing.join(', ')}: Required` : null
  },
})

const targets = {
  haven_get_payment_status: target<{ payment_id: string }>('hosted', ['payment_id']),
  haven_sign: target<{ payment_id?: string }>('signer', []),
}
const nextStep = createNextStepBuilder(targets)
const base = { nextAction: AgentPaymentNextAction.CheckStatusLater, safeToContinue: true, reason: 'r' } as const

describe('next-step builder (#3101)', () => {
  it('renders the namespaced literal and the runtime-neutral fields from the bare name + role', () => {
    expect(nextStep({ ...base, nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'p' } })).toEqual({
      next_action: 'check_status_later',
      safe_to_continue: true,
      reason: 'r',
      next_tool: 'mcp__haven__haven_get_payment_status',
      next_tool_server: 'haven',
      next_tool_name: 'haven_get_payment_status',
      next_tool_server_role: 'hosted',
      next_arguments: { payment_id: 'p' },
    })
    expect(nextStep({ ...base, nextTool: 'haven_sign', nextArguments: {} }).next_tool).toBe('mcp__haven-signer__haven_sign')
  })

  it('omits the tool and says why when there is none — never a null next_tool', () => {
    const out = nextStep({ ...base, nextTool: null, nextToolOmittedReason: 'done' })
    expect('next_tool' in out).toBe(false)
    expect(out.next_tool_omitted_reason).toBe('done')
  })

  it('fails safe at runtime on arguments the target refuses, and on an unregistered target', () => {
    const bad = nextStep({ ...base, nextTool: 'haven_get_payment_status', nextArguments: {} } as unknown as Parameters<typeof nextStep>[0])
    expect(bad.next_tool).toBeUndefined()
    expect(bad.next_tool_omitted_reason).toBe('next_arguments do not parse under haven_get_payment_status: payment_id: Required')
    const unknown = nextStep({ ...base, nextTool: 'nope', nextArguments: {} } as unknown as Parameters<typeof nextStep>[0])
    expect(unknown.next_tool_omitted_reason).toBe('nope is not a registered next-step target')
  })

  it('parse and render round-trip, and an unknown server carries no role', () => {
    expect(renderNextTool('signer', 'haven_sign_x402')).toBe('mcp__haven-signer__haven_sign_x402')
    expect(parseNextTool('mcp__haven-signer__haven_sign_x402')).toEqual({ server: 'haven-signer', name: 'haven_sign_x402', role: 'signer' })
    expect(parseNextTool('mcp__haven-qa__haven_pay')).toEqual({ server: 'haven-qa', name: 'haven_pay' })
    expect(parseNextTool('haven_pay')).toBeNull()
  })

  it('the per-action default table names one tool for the unambiguous actions only', () => {
    expect(DEFAULT_NEXT_TOOL_BY_ACTION).toEqual({
      check_status_later: 'haven_get_payment_status',
      sweep_stranded_funds: 'haven_sweep_delegate',
      retry_original_x402_request: 'haven_resume_x402_payment',
    })
    expect(defaultNextToolFor(AgentPaymentNextAction.SignAndSubmitPayment)).toBeUndefined()
  })
})
