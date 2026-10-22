import { describe, expect, it } from 'vitest'
import { errorCodeLabel, MCP_TOOL_NAMES, toolCallLabel } from '../tool-call-labels'

/**
 * #4227: every tool the backend's closed allowlist can record gets a
 * plain-language label; a retired name in old audit rows falls back to its
 * raw name. This file is the frontend mirror of
 * `packages/backend/src/middleware/agentToolAudit.ts` → `MCP_TOOL_NAMES`
 * (and `packages/mcp`'s registered set) — keep the lists in sync.
 */
describe('tool-call labels', () => {
  it('every name in the allowlist has a label that is not the raw name', () => {
    expect(MCP_TOOL_NAMES).toHaveLength(8)
    for (const name of MCP_TOOL_NAMES) {
      const label = toolCallLabel(name)
      expect(label, `${name} has a label`).toBeTruthy()
      expect(label, `${name} is labelled in plain language`).not.toBe(name)
    }
  })

  it('the owner examples are the settled wording', () => {
    expect(toolCallLabel('haven_get_agent')).toBe('Checked identity and budget')
    expect(toolCallLabel('haven_quote_x402')).toBe('Quoted a paid API')
    expect(toolCallLabel('haven_pay_x402_quote')).toBe('Paid a quote')
    expect(toolCallLabel('haven_get_allowances')).toBe('Read budgets')
  })

  it('an unknown (retired) name falls back to its raw name', () => {
    expect(toolCallLabel('haven_quote_mpp')).toBe('haven_quote_mpp')
    expect(toolCallLabel('anything_at_all')).toBe('anything_at_all')
  })
})

describe('error-code labels', () => {
  it('known refusals render in words', () => {
    expect(errorCodeLabel('delegation_budget_exceeded')).toBe('Over the agent budget')
    expect(errorCodeLabel('relayer_budget_exceeded')).toBe('Over the wallet budget')
    expect(errorCodeLabel('signature_rejected')).toBe('Signature rejected')
  })

  it('an unknown code renders as-is, and absent renders nothing', () => {
    // The middleware records whatever the response body named `code`/`error`
    // — the backend's own `error` values are full sentences and are already
    // words, so pass-through is the honest default.
    expect(errorCodeLabel('Payment intent has expired')).toBe('Payment intent has expired')
    expect(errorCodeLabel(null)).toBeNull()
    expect(errorCodeLabel(undefined)).toBeNull()
    expect(errorCodeLabel('')).toBeNull()
  })
})
