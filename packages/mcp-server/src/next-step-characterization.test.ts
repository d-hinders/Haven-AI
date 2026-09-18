import { describe, expect, it } from 'vitest'
import { AgentPaymentNextAction } from '@haven_ai/sdk'
import { buildAgentGuidance } from './tools/support/guidance.js'

/**
 * #3101 (epic #3105, slice 2/5) — CHARACTERIZATION of the 13 hosted
 * next-step emissions BEFORE the typed builder lands. Each fixture is the
 * literal `buildAgentGuidance` input one emission site passes (ids
 * substituted), and the expected `next_*` wire fields are what the pre-#3101
 * builder produced for it. The structural commit that follows must keep every
 * expectation byte-identical except the three `payment_id: null` sites, whose
 * new shape (omitted tool + `next_tool_omitted_reason`) is stated in the PR
 * body and updated here in the same commit.
 */
const SUMMARY = {
  payment_id: 'pay_1',
  status: 'pending_signature',
  amount_atomic: '1500000',
  asset: 'USDC',
  network: 'base',
} as unknown as Parameters<typeof buildAgentGuidance>[0]['summary']

const SIGNER = (name: string) => ({
  next_tool: `mcp__haven-signer__${name}`,
  next_tool_server: 'haven-signer',
  next_tool_name: name,
  next_tool_server_role: 'signer',
})
const HOSTED = (name: string) => ({
  next_tool: `mcp__haven__${name}`,
  next_tool_server: 'haven',
  next_tool_name: name,
  next_tool_server_role: 'hosted',
})

export const EMISSION_SITES = [
  { site: 'catalog-purchase.ts prepare erc7710', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'mcp__haven-signer__haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts prepare 3009', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'mcp__haven-signer__haven_sign_x402', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign_x402'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts prepare window-expired (payment_id unknown)', action: AgentPaymentNextAction.StopAndTellUser, tool: 'mcp__haven__haven_get_payment_status', args: { payment_id: null }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: null } } },
  { site: 'catalog-purchase.ts pay erc7710', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'mcp__haven-signer__haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts pay 3009', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'mcp__haven-signer__haven_sign_x402', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign_x402'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts pay window-expired (payment_id unknown)', action: AgentPaymentNextAction.StopAndTellUser, tool: 'mcp__haven__haven_get_payment_status', args: { payment_id: null }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: null } } },
  { site: 'plain-http-x402.ts pay erc7710', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'mcp__haven-signer__haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'plain-http-x402.ts pay 3009', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'mcp__haven-signer__haven_sign_x402', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign_x402'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'plain-http-x402.ts pay window-expired (payment_id unknown)', action: AgentPaymentNextAction.StopAndTellUser, tool: 'mcp__haven__haven_get_payment_status', args: { payment_id: null }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: null } } },
  { site: 'plain-http-x402.ts report outcome rejected', action: AgentPaymentNextAction.SweepStrandedFunds, tool: 'mcp__haven__haven_sweep_delegate', args: {}, expect: { ...HOSTED('haven_sweep_delegate'), next_arguments: {} } },
  { site: 'plain-http-x402.ts report outcome accepted (no tool)', action: AgentPaymentNextAction.None, tool: undefined, args: undefined, expect: {} },
  { site: 'paid-mcp-completion.ts pending', action: AgentPaymentNextAction.CheckStatusLater, tool: 'mcp__haven__haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'paid-mcp-completion.ts settle held-hash, can report', action: AgentPaymentNextAction.CheckStatusLater, tool: 'mcp__haven__haven_report_settlement_evidence', args: { payment_id: 'pay_1', settlement_tx_hash: '0xabc' }, expect: { ...HOSTED('haven_report_settlement_evidence'), next_arguments: { payment_id: 'pay_1', settlement_tx_hash: '0xabc' } } },
  { site: 'paid-mcp-completion.ts settle held-hash, cannot report', action: AgentPaymentNextAction.CheckStatusLater, tool: 'mcp__haven__haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'paid-mcp-completion.ts settle funding pending', action: AgentPaymentNextAction.CheckStatusLater, tool: 'mcp__haven__haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
] as const

const NEXT_KEYS = ['next_tool', 'next_tool_server', 'next_tool_name', 'next_tool_server_role', 'next_arguments', 'next_tool_omitted_reason'] as const

describe('hosted next-step emissions — characterization (#3101)', () => {
  for (const fixture of EMISSION_SITES) {
    it(fixture.site, () => {
      const out = buildAgentGuidance({
        nextAction: fixture.action,
        ...(fixture.tool ? { nextTool: fixture.tool } : {}),
        ...(fixture.args ? { nextArguments: fixture.args as Record<string, unknown> } : {}),
        safeToContinue: true,
        reason: 'r',
        summary: SUMMARY,
      })
      const picked = Object.fromEntries(NEXT_KEYS.filter((k) => k in out).map((k) => [k, (out as unknown as Record<string, unknown>)[k]]))
      expect(picked).toEqual(fixture.expect)
      expect(out.next_action).toBe(fixture.action)
    })
  }
})
