/**
 * #2907 (naming P0): the `AgentNextStep` enum gains an account-vocabulary
 * value additively — declared in the schema and its descriptions, accepted
 * on input — but the server must keep EMITTING the old
 * `fund_safe_or_raise_allowance` through this window. One field cannot carry
 * two values at once; an old mcp-server switching on the compiled literal
 * would otherwise silently drop the over-budget guidance it needs to act on
 * (owner review on #2906). The flip to emitting the new value is #2914.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { openapiSpec } from './spec.js'
import { AgentPaymentNextAction } from '../domain/agent-payment-taxonomy.js'

describe('#2907 — AgentNextStep enum is additive, emission is pinned', () => {
  it('the served enum documents both values', () => {
    const schema = openapiSpec.components.schemas.AgentPaymentNextAction as {
      enum: string[]
      'x-enumDescriptions'?: Record<string, string>
    }
    expect(schema.enum).toContain('fund_safe_or_raise_allowance')
    expect(schema.enum).toContain('fund_account_or_raise_allowance')
    expect(schema['x-enumDescriptions']?.fund_account_or_raise_allowance).toMatch(
      /#2907|twin/i,
    )
  })

  it('the backend mirror (parity-pinned to the SDK, P1/#2908 surface) is untouched by P0', () => {
    // This is the guard against P0 accidentally widening into P1's scope: if
    // someone "fixes" this by adding the key to the taxonomy mirror instead
    // of splicing it into the served enum, this assertion catches it.
    expect(Object.values(AgentPaymentNextAction)).not.toContain(
      'fund_account_or_raise_allowance',
    )
  })

  it('PIN: the server still only emits the old value, not the new one (flips at #2914)', async () => {
    const source = await readFile(
      new URL('../modules/x402/delegation-authorize.ts', import.meta.url),
      'utf8',
    )
    const emittedOldValue = source.match(/next_action:\s*AgentPaymentNextAction\.(\w+)/g) ?? []
    expect(emittedOldValue.length).toBeGreaterThan(0)
    for (const site of emittedOldValue) {
      expect(site).toContain('FundSafeOrRaiseAllowance')
      expect(site).not.toContain('FundAccountOrRaiseAllowance')
    }
  })
})
