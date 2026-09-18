import { describe, expect, it } from 'vitest'
import { AgentPaymentNextAction } from '@haven_ai/sdk'
import { buildAgentGuidance, paymentStatusHandoff, type HostedHandoff } from './tools/support/guidance.js'

/**
 * #3101 — the COMPILE-TIME twins. `npm run typecheck -w packages/mcp-server`
 * covers test files, so each `@ts-expect-error` below is an assertion that the
 * line does NOT compile: delete one and typecheck fails with "Unused
 * '@ts-expect-error' directive" — that is the mutation, and the diagnostics
 * each line produces are quoted in the PR body. Every probe is a per-site
 * LITERAL assigned to the handoff type, never a conditional spread (spread
 * results are not excess-property checked).
 */
const SUMMARY = { payment_id: 'pay_1', status: 'pending_signature' } as unknown as Parameters<typeof buildAgentGuidance>[0]['summary']

// Positive control: the shapes the 13 sites use compile.
const ok1: HostedHandoff = { nextTool: 'haven_sign', nextArguments: { payment_id: 'pay_1' } }
const ok2: HostedHandoff = { nextTool: 'haven_report_settlement_evidence', nextArguments: { payment_id: 'pay_1', settlement_tx_hash: '0x' + 'ab'.repeat(32) } }
const ok3: HostedHandoff = { nextTool: 'haven_sweep_delegate', nextArguments: {} }
const ok4: HostedHandoff = { nextTool: null, nextToolOmittedReason: 'nothing follows' }

// Twin 1 — a wrong key for the named tool.
// @ts-expect-error payment_ID is not a key haven_get_payment_status declares
const wrongKey: HostedHandoff = { nextTool: 'haven_get_payment_status', nextArguments: { payment_ID: 'pay_1' } }

// Twin 2 — a missing required key (haven_get_payment_status requires payment_id).
// @ts-expect-error payment_id is required
const missingKey: HostedHandoff = { nextTool: 'haven_get_payment_status', nextArguments: {} }

// Twin 3 — a tool name no server registers.
// @ts-expect-error haven_get_payment_statuz is not a registered target
const unregistered: HostedHandoff = { nextTool: 'haven_get_payment_statuz', nextArguments: { payment_id: 'pay_1' } }

// Twin 4 — nextTool omitted altogether (the pre-#3101 shape of the silent sites).
// @ts-expect-error nextTool is required: name a tool or say why there is none
const omitted: HostedHandoff = { nextArguments: { payment_id: 'pay_1' } }

// Twin 5 — null without a reason.
// @ts-expect-error a null nextTool must carry nextToolOmittedReason
const nullNoReason: HostedHandoff = { nextTool: null }

// Twin 6 — the wire's old lie: payment_id: null against a required string.
// @ts-expect-error null is not a string
const nullId: HostedHandoff = { nextTool: 'haven_get_payment_status', nextArguments: { payment_id: null } }

// The full input is checked the same way (a site passes one object).
// @ts-expect-error nextTool is required on the full guidance input too
const fullOmitted = () => buildAgentGuidance({ nextAction: AgentPaymentNextAction.None, safeToContinue: true, reason: 'r', summary: SUMMARY })

describe('typed next-step handoff (#3101)', () => {
  it('the positive controls build the byte-identical wire', () => {
    const out = buildAgentGuidance({ ...ok1, nextAction: AgentPaymentNextAction.SignAndSubmitPayment, safeToContinue: true, reason: 'r', summary: SUMMARY })
    expect(out.next_tool).toBe('mcp__haven-signer__haven_sign')
    expect(out.next_tool_server).toBe('haven-signer')
    expect(out.next_tool_name).toBe('haven_sign')
    expect(out.next_tool_server_role).toBe('signer')
    expect(out.next_arguments).toEqual({ payment_id: 'pay_1' })
    expect(buildAgentGuidance({ ...ok2, nextAction: AgentPaymentNextAction.CheckStatusLater, safeToContinue: true, reason: 'r', summary: SUMMARY }).next_tool).toBe('mcp__haven__haven_report_settlement_evidence')
    expect(buildAgentGuidance({ ...ok3, nextAction: AgentPaymentNextAction.SweepStrandedFunds, safeToContinue: true, reason: 'r', summary: SUMMARY }).next_tool).toBe('mcp__haven__haven_sweep_delegate')
    const none = buildAgentGuidance({ ...ok4, nextAction: AgentPaymentNextAction.None, safeToContinue: true, reason: 'r', summary: SUMMARY })
    expect(none.next_tool).toBeUndefined()
    expect(none.next_tool_omitted_reason).toBe('nothing follows')
  })

  it('the runtime twin fails safe for a caller that bypasses the types', () => {
    // The typed sites cannot reach this; a hand-built object can.
    const out = buildAgentGuidance({
      ...({ nextTool: 'haven_get_payment_status', nextArguments: { payment_ID: 'pay_1' } } as unknown as HostedHandoff),
      nextAction: AgentPaymentNextAction.CheckStatusLater,
      safeToContinue: true,
      reason: 'r',
      summary: SUMMARY,
    })
    expect(out.next_tool).toBeUndefined()
    expect(out.next_tool_omitted_reason).toMatch(/do not parse under haven_get_payment_status: payment_id: Required/)
  })

  it('paymentStatusHandoff names the status tool only when it has an id (decision 3)', () => {
    expect(paymentStatusHandoff('pay_1')).toEqual({ nextTool: 'haven_get_payment_status', nextArguments: { payment_id: 'pay_1' } })
    const none = paymentStatusHandoff(undefined)
    expect(none.nextTool).toBeNull()
    expect((none as { nextToolOmittedReason: string }).nextToolOmittedReason).toContain('no payment_id is known')
    const wire = buildAgentGuidance({ ...none, nextAction: AgentPaymentNextAction.StopAndTellUser, safeToContinue: false, reason: 'r', summary: SUMMARY })
    expect(wire.next_tool).toBeUndefined()
    expect(wire.next_arguments).toBeUndefined()
  })

  it('keeps the probes referenced so the file is not dead', () => {
    expect([wrongKey, missingKey, unregistered, omitted, nullNoReason, nullId, fullOmitted]).toHaveLength(7)
  })
})
