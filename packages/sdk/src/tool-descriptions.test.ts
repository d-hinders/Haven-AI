import { describe, expect, it } from 'vitest'
import { composeDescription, toolDescriptions } from './tool-descriptions.js'

describe('shared Haven tool descriptions', () => {
  it('routes allowance and budget questions to the allowance lookup', () => {
    const desc = composeDescription(toolDescriptions.getAllowances).toLowerCase()

    expect(desc).toContain('allowance')
    expect(desc).toContain('budget')
    expect(desc).toContain('spend limit')
    expect(desc).toContain('remaining amount')
    expect(desc).toContain('remaining allowance')
    expect(desc).toContain('remaining budget')
    expect(desc).toContain('daily limit')
    expect(desc).toContain('reset period')
    expect(desc).toContain('what can i spend')
    expect(desc).toContain('what the agent can still spend')
  })

  it('routes transaction-history questions away from remaining-budget lookups', () => {
    const desc = composeDescription(toolDescriptions.listReceipts).toLowerCase()

    expect(desc).toContain('transaction history')
    expect(desc).toContain('payment evidence')
    expect(desc).toContain('use the allowance tool instead')
    expect(desc).toContain('remaining allowance')
    expect(desc).toContain('what-can-i-spend')
  })

  it('routes read-only budget questions away from payment tools', () => {
    for (const key of ['payX402', 'payMpp'] as const) {
      const desc = composeDescription(toolDescriptions[key]).toLowerCase()

      expect(desc).toContain('do not use this for read-only allowance')
      expect(desc).toContain('what-can-i-spend')
      expect(desc).toContain('use the allowance lookup tool instead')
    }
  })

  // ── Prose-drift guards ──────────────────────────────────────────────
  //
  // Agent feedback specifically called out the older `haven_x402_authorize`
  // description embedding multi-step instructions like
  //   "Next: sign payload_hash with x402.expected on your machine, call
  //    haven_submit..."
  // and noted that an agent has to *parse prose* to recover the next step.
  // Structured `nextAction` values on responses are the reliable path;
  // descriptions should describe what the tool does and what the agent
  // should read from the response, never tell the agent to call a specific
  // follow-up tool name as a hardcoded next step.
  //
  // SCOPE LIMIT: these guards iterate the fragments registered in
  // `tool-descriptions.ts` (the local MCP + SDK shared source of truth).
  // They do NOT cover hand-rolled description strings that live elsewhere
  // — notably `packages/mcp-server/src/tools.ts`, where the legacy hosted
  // MCP still carries the "Next: sign payload_hash..." prose the original
  // feedback flagged. Aligning the hosted MCP is a separate, deferred
  // slice. A future author editing the hosted-MCP descriptions will not
  // get a signal from these guards, by design.
  it('contains no developer-doc-style imperatives ("Next:", "Then call X", ...) in any tool-descriptions.ts fragment', () => {
    // These were the exact shapes the original agent feedback flagged. Any
    // future fragment registered in this module that drops imperative prose
    // like this is signalling that the structured `nextAction` field should
    // be carrying the same information instead. Hand-rolled description
    // strings outside this module are explicitly out of scope (see the
    // SCOPE LIMIT note above).
    const forbidden: Array<RegExp> = [
      /\bNext\s*:/i,
      /\bThen\s+call\b/i,
      /\bThen\s+sign\b/i,
      /\bThen\s+submit\b/i,
      /\bNow\s+call\b/i,
      /\bAfter\s+that,?\s+call\b/i,
    ]

    for (const [key, fragment] of Object.entries(toolDescriptions)) {
      const composed = composeDescription(fragment as typeof fragment)
      for (const pattern of forbidden) {
        expect(
          composed,
          `${key} description must not embed developer-doc imperatives — use structured nextAction on the response instead. Hit: ${pattern}`,
        ).not.toMatch(pattern)
      }
    }
  })

  it('teaches agents to read the structured nextAction on payment tools, not memorise tool names', () => {
    // Each payment tool's nextActionGuidance must reference the structured
    // nextAction enum the agent will see on the response, so the agent
    // branches on machine-readable data instead of prose. We anchor on the
    // x402 retry action; presence of that string in the composed description
    // means the description is doing the right thing.
    for (const key of ['payX402', 'payX402OneShot'] as const) {
      const desc = composeDescription(toolDescriptions[key])
      expect(
        desc,
        `${key} should reference nextAction=retry_original_x402_request so the agent reads the structured field`,
      ).toContain('nextAction=retry_original_x402_request')
    }
    const mppDesc = composeDescription(toolDescriptions.payMpp)
    expect(mppDesc).toContain('nextAction=retry_original_x402_request')
  })

  it('warns x402 payment tools about the new insufficient_funds failure mode', () => {
    // Slice B added a pre-flight check that surfaces phase=insufficient_funds
    // / nextAction=fund_safe_or_raise_allowance when the delegate balance plus
    // the remaining Safe allowance cannot cover the requested amount. The
    // x402 payment descriptions must mention this failure mode so agents know
    // to expect it from the response and surface the shortfall to the user
    // instead of retrying. This guard fails if a future taxonomy change drops
    // the reference and leaves agents to discover the failure mode on first
    // production hit.
    for (const key of ['payX402', 'payX402OneShot'] as const) {
      const desc = composeDescription(toolDescriptions[key])
      expect(desc).toContain('phase=insufficient_funds')
      expect(desc).toContain('nextAction=fund_safe_or_raise_allowance')
    }
  })

  it('guides agents from a quote success into the matching pay tool', () => {
    // Empty nextActionGuidance on the quote tools used to leave agents
    // wondering what to call next after a successful quote — the answer is
    // never "call the merchant again," because the SDK has already captured
    // the request and Haven will re-use that capture when paying. Pin the
    // guidance so the chain is discoverable from descriptions alone.
    const x402QuoteDesc = composeDescription(toolDescriptions.quoteX402)
    expect(x402QuoteDesc).toContain('haven_pay_x402_quote')
    expect(x402QuoteDesc.toLowerCase()).toContain('do not call the merchant again')

    const mppQuoteDesc = composeDescription(toolDescriptions.quoteMpp)
    expect(mppQuoteDesc).toContain('haven_pay_mpp_challenge')
    expect(mppQuoteDesc.toLowerCase()).toContain('do not call the merchant again')
  })
})
