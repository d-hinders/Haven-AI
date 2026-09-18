import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AgentPaymentNextAction } from '@haven_ai/sdk'
import { buildAgentGuidance, paymentStatusHandoff } from './tools/support/guidance.js'

/**
 * #3101 (epic #3105, slice 2/5) — CHARACTERIZATION of the 17 hosted
 * next-step emissions (13 tool-naming sites plus the four no-tool sites), written BEFORE the typed builder landed (commit
 * 74cd61da) and carried across it: the inputs are now in the builder's
 * vocabulary (bare tool names, `nextTool: null` + reason where no tool is
 * named) and every expectation is byte-identical to the pre-#3101 wire
 * except the sites the epic re-decided, marked `RE-DECIDED` below. Each fixture is the
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
  { site: 'catalog-purchase.ts prepare erc7710', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts prepare 3009', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign_x402', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign_x402'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts prepare window-expired (payment_id unknown)', action: AgentPaymentNextAction.StopAndTellUser, handoff: paymentStatusHandoff(undefined), expect: { next_tool_omitted_reason: 'no payment_id is known for this refusal, so haven_get_payment_status cannot be named; nothing was funded or signed' } } /* RE-DECIDED: was next_tool + { payment_id: null } */,
  { site: 'catalog-purchase.ts pay erc7710', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts pay 3009', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign_x402', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign_x402'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'catalog-purchase.ts pay window-expired (payment_id unknown)', action: AgentPaymentNextAction.StopAndTellUser, handoff: paymentStatusHandoff(undefined), expect: { next_tool_omitted_reason: 'no payment_id is known for this refusal, so haven_get_payment_status cannot be named; nothing was funded or signed' } } /* RE-DECIDED: was next_tool + { payment_id: null } */,
  { site: 'plain-http-x402.ts pay erc7710', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'plain-http-x402.ts pay 3009', action: AgentPaymentNextAction.SignAndSubmitPayment, tool: 'haven_sign_x402', args: { payment_id: 'pay_1' }, expect: { ...SIGNER('haven_sign_x402'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'plain-http-x402.ts pay window-expired (payment_id unknown)', action: AgentPaymentNextAction.StopAndTellUser, handoff: paymentStatusHandoff(undefined), expect: { next_tool_omitted_reason: 'no payment_id is known for this refusal, so haven_get_payment_status cannot be named; nothing was funded or signed' } } /* RE-DECIDED: was next_tool + { payment_id: null } */,
  { site: 'plain-http-x402.ts report outcome rejected', action: AgentPaymentNextAction.SweepStrandedFunds, tool: 'haven_sweep_delegate', args: {}, expect: { ...HOSTED('haven_sweep_delegate'), next_arguments: {} } },
  { site: 'plain-http-x402.ts report outcome accepted (no tool)', action: AgentPaymentNextAction.None, tool: null, reason: 'the merchant accepted the paid retry; the purchase is complete and no Haven tool follows', expect: { next_tool_omitted_reason: 'the merchant accepted the paid retry; the purchase is complete and no Haven tool follows' } } /* RE-DECIDED: additive reason, no tool before either */,
  { site: 'paid-mcp-completion.ts pending', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'paid-mcp-completion.ts settle held-hash, can report', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_report_settlement_evidence', args: { payment_id: 'pay_1', settlement_tx_hash: '0x' + 'ab'.repeat(32) }, expect: { ...HOSTED('haven_report_settlement_evidence'), next_arguments: { payment_id: 'pay_1', settlement_tx_hash: '0x' + 'ab'.repeat(32) } } },
  { site: 'paid-mcp-completion.ts settle held-hash, cannot report', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  { site: 'paid-mcp-completion.ts settle funding pending', action: AgentPaymentNextAction.CheckStatusLater, tool: 'haven_get_payment_status', args: { payment_id: 'pay_1' }, expect: { ...HOSTED('haven_get_payment_status'), next_arguments: { payment_id: 'pay_1' } } },
  // The four no-tool sites (no `nextTool:` line before #3101; the required input surfaced them).
  { site: 'paid-mcp-completion.ts complete settled', action: AgentPaymentNextAction.None, tool: null, reason: 'the purchase is settled; no Haven tool follows', expect: { next_tool_omitted_reason: 'the purchase is settled; no Haven tool follows' } } /* RE-DECIDED: additive reason */,
  { site: 'paid-mcp-completion.ts settle erc7710 settled', action: AgentPaymentNextAction.None, tool: null, reason: 'the purchase is settled; no Haven tool follows', expect: { next_tool_omitted_reason: 'the purchase is settled; no Haven tool follows' } } /* RE-DECIDED: additive reason */,
  { site: 'paid-mcp-completion.ts settle 3009 settled', action: AgentPaymentNextAction.None, tool: null, reason: 'the purchase is settled; no Haven tool follows', expect: { next_tool_omitted_reason: 'the purchase is settled; no Haven tool follows' } } /* RE-DECIDED: additive reason */,
  { site: 'state-direct-recovery.ts own HTTP retry', action: AgentPaymentNextAction.RetryOriginalX402Request, tool: null, reason: 'the next step is your own HTTP retry of the merchant with the payment_header above, not a Haven tool', expect: { next_tool_omitted_reason: 'the next step is your own HTTP retry of the merchant with the payment_header above, not a Haven tool' } } /* RE-DECIDED: additive reason */,
] as const

/**
 * The census the figure "17 emission sites" comes from: every
 * `buildAgentGuidance(` call in the hosted non-test source. A new site fails
 * this count (haven-reviewer round 2 on #3124 planted an 18th and the suite
 * stayed green), and must then be characterized above. Distinct from the
 * fixture count (19: the held-hash site has two branches, the three null-id
 * sites share one helper) — the number the docs quote is THIS one.
 */
export const EMISSION_SITE_COUNT = 17

function hostedSource(): string {
  const parts = [readFileSync(fileURLToPath(new URL('./tools.ts', import.meta.url)), 'utf8')]
  const walk = (dir: URL) => {
    for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir))
      else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
        parts.push(readFileSync(fileURLToPath(new URL(entry.name, dir)), 'utf8'))
    }
  }
  walk(new URL('./tools/', import.meta.url))
  return parts.join('\n')
}

const NEXT_KEYS = ['next_tool', 'next_tool_server', 'next_tool_name', 'next_tool_server_role', 'next_arguments', 'next_tool_omitted_reason'] as const

describe('hosted next-step emissions — characterization (#3101)', () => {
  it(`the hosted source has exactly ${EMISSION_SITE_COUNT} buildAgentGuidance call sites (census)`, () => {
    // Excludes the definition in guidance.ts (`export function buildAgentGuidance(`).
    const calls = [...hostedSource().matchAll(/(?<!function )buildAgentGuidance\(/g)].length
    expect(calls).toBe(EMISSION_SITE_COUNT)
  })

  for (const fixture of EMISSION_SITES) {
    it(fixture.site, () => {
      const f = fixture as { tool?: string | null; reason?: string; args?: unknown; handoff?: unknown }
      const handoff = (f.handoff
        ? f.handoff
        : f.tool === null
          ? { nextTool: null, nextToolOmittedReason: f.reason }
          : { nextTool: f.tool, nextArguments: f.args }) as unknown as Parameters<typeof buildAgentGuidance>[0]
      const out = buildAgentGuidance({
        ...handoff,
        nextAction: fixture.action,
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
