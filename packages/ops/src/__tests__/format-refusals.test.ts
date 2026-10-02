/**
 * Page-state and classification units (#3516): unavailable budgets render as
 * unavailable (never a number), refusals classify into the issue's buckets,
 * and the atomic formatter never touches a float.
 */
import { describe, expect, it } from 'vitest'
import { formatAtomic, chainName, ageLine } from '../lib/format'
import { classifyRefusal, REFUSAL_CLASS_LABEL } from '../lib/refusals'

describe('formatAtomic', () => {
  it('renders atomic decimal strings exactly, padding and trimming', () => {
    expect(formatAtomic('1234567', 6)).toBe('1.234567')
    expect(formatAtomic('0', 6)).toBe('0')
    expect(formatAtomic('1000000', 6)).toBe('1')
    expect(formatAtomic('42', 6)).toBe('0.000042')
    expect(formatAtomic('250000000', 6)).toBe('250')
    expect(formatAtomic('420000000', 6)).toBe('420')
  })

  it('never loses precision a float would', () => {
    expect(formatAtomic('9007199254740993', 6)).toBe('9007199254.740993')
  })
})

describe('chainName', () => {
  it('names registered chains and falls back to the raw id', () => {
    expect(chainName(100)).toMatch(/Gnosis/i)
    expect(chainName(8453)).toMatch(/Base/i)
    expect(chainName(999999999)).toBe('Chain 999999999')
  })
})

describe('ageLine', () => {
  it('reads as an age, not a timestamp', () => {
    expect(ageLine(45)).toBe('45s')
    expect(ageLine(3600)).toBe('60 min')
    expect(ageLine(172800)).toBe('2 d')
  })
})

describe('classifyRefusal (#3516: classified refusals — over budget, wrong recipient, expired)', () => {
  it('maps the closed refusal-reason set onto the named buckets', () => {
    expect(classifyRefusal('delegation_budget_exceeded')).toBe('over_budget')
    expect(classifyRefusal('relayer_budget')).toBe('over_budget')
    expect(classifyRefusal('no_delegation_for_target')).toBe('wrong_recipient')
    expect(classifyRefusal('delegation_expired')).toBe('expired')
    // `onchain_revert` is in migration 086's CHECK but not in the issue's
    // three buckets — it shows as Other, with its raw reason beside it.
    expect(classifyRefusal('onchain_revert')).toBe('other')
    expect(classifyRefusal('something_a_migration_added')).toBe('other')
  })

  it('labels every bucket the UI can render', () => {
    for (const klass of ['over_budget', 'wrong_recipient', 'expired', 'other'] as const) {
      expect(REFUSAL_CLASS_LABEL[klass]).toBeTruthy()
    }
  })
})
