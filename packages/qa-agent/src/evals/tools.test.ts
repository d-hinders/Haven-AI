/**
 * Tool-list + name-matching tests for the eval graders (#3958).
 *
 * The counts are pinned: a hosted/signer tool added upstream without landing
 * in `tools.ts` fails HERE, not silently in a grader blind spot three hours
 * into a partner nightly run.
 */

import { describe, expect, it } from 'vitest'
import { ALL_TOOL_NAMES, HOSTED_TOOLS, PAYMENT_TOOLS, SIGNER_TOOLS, bareToolName, isPaymentTool } from './tools.js'
import { TOOL_COUNTS } from './tasks.js'

describe('the tool lists', () => {
  it('pins 29 hosted tools — the hosted tools/list contract', () => {
    expect(HOSTED_TOOLS).toHaveLength(29)
    expect(TOOL_COUNTS.hosted).toBe(29)
  })

  it('pins the 5 signer tools from registeredSignerToolNames()', () => {
    expect(SIGNER_TOOLS).toHaveLength(5)
    expect(SIGNER_TOOLS).toContain('haven_sign')
    expect(SIGNER_TOOLS).toContain('haven_x402_sign_header')
  })

  it('defines the payment list explicitly from the 29 hosted tools', () => {
    expect(PAYMENT_TOOLS).toHaveLength(9)
    for (const t of PAYMENT_TOOLS) expect(HOSTED_TOOLS).toContain(t)
    // Read-only tools must never count as payments.
    expect(PAYMENT_TOOLS).not.toContain('haven_quote_x402')
    expect(PAYMENT_TOOLS).not.toContain('haven_get_agent')
    expect(PAYMENT_TOOLS).not.toContain('haven_open_task_budget')
  })
})

describe('bareToolName — graders match bare names, never server-prefixed ones', () => {
  it('passes bare names through', () => {
    expect(bareToolName('haven_get_agent')).toBe('haven_get_agent')
    expect(bareToolName('haven_pay')).toBe('haven_pay')
  })

  it('strips the mcp__<server>__ prefix a runtime writes for a derived pair', () => {
    // The derived pair name connect writes on a non-production backend is
    // haven-<slug>-dev (packages/connect/src/args.ts § --bare).
    expect(bareToolName('mcp__haven-ops-dev__haven_get_agent')).toBe('haven_get_agent')
    expect(bareToolName('mcp__haven-ops-dev__haven_pay')).toBe('haven_pay')
  })

  it('strips a single-underscore server joiner too (haven-<slug>-dev_haven_pay)', () => {
    expect(bareToolName('haven-ops-dev_haven_pay')).toBe('haven_pay')
    expect(bareToolName('haven-ops-dev_haven_get_allowances')).toBe('haven_get_allowances')
  })

  it('does not confuse names that share a prefix', () => {
    expect(bareToolName('mcp__haven-x-dev__haven_pay_mcp_tool')).toBe('haven_pay_mcp_tool')
    expect(bareToolName('mcp__haven-x-dev__haven_sign')).toBe('haven_sign')
    expect(bareToolName('mcp__haven-x-dev__haven_sign_x402')).toBe('haven_sign_x402')
    expect(bareToolName('mcp__haven-x-dev__haven_sign_siwx')).toBe('haven_sign_siwx')
  })

  it('returns unknown names unchanged — graders must not true on a name they cannot read', () => {
    expect(bareToolName('some_other_tool')).toBe('some_other_tool')
  })

  it('every list entry is reachable through bareToolName', () => {
    for (const t of ALL_TOOL_NAMES) expect(bareToolName(t)).toBe(t)
  })
})

describe('isPaymentTool', () => {
  it('matches payment tools through a derived prefix', () => {
    expect(isPaymentTool('mcp__haven-eval-dev__haven_send')).toBe(true)
    expect(isPaymentTool('mcp__haven-eval-dev__haven_check_funds')).toBe(false)
    expect(isPaymentTool('haven-eval-dev_haven_sweep_delegate')).toBe(true)
  })
})
