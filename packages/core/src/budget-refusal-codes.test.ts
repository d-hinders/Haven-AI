import { describe, expect, it } from 'vitest'
import {
  PAYMENT_SCOPE_REFUSAL_CODES,
  PAYMENT_SCOPE_REFUSAL_STATUS,
  SUB_BUDGET_PAYMENT_REFUSALS,
  SUB_BUDGET_REFUSAL_STATUS,
  TASK_BUDGET_PAYMENT_REFUSALS,
  TASK_BUDGET_REFUSAL_STATUS,
} from './budget-refusal-codes.js'

/**
 * #4468: the shared payment-scope refusal artifact. These assertions are about
 * the ARTIFACT's shape, not about either consumer — the hosted MCP's answer
 * table and the backend's resolver are pinned by their own tests. What matters
 * here is that the union is exactly the ten codes the issue names, that the
 * two scopes cannot collide, and that every member has a status.
 */
describe('the payment-scope refusal artifact (#4468)', () => {
  it('is exactly the ten codes: five per scope', () => {
    expect(TASK_BUDGET_PAYMENT_REFUSALS).toHaveLength(5)
    expect(SUB_BUDGET_PAYMENT_REFUSALS).toHaveLength(5)
    expect(PAYMENT_SCOPE_REFUSAL_CODES).toHaveLength(10)
  })

  it('keeps the two scopes disjoint, so the union has no duplicate member', () => {
    const overlap = TASK_BUDGET_PAYMENT_REFUSALS.filter((code) =>
      (SUB_BUDGET_PAYMENT_REFUSALS as readonly string[]).includes(code),
    )
    expect(overlap).toEqual([])
    expect(new Set(PAYMENT_SCOPE_REFUSAL_CODES).size).toBe(PAYMENT_SCOPE_REFUSAL_CODES.length)
  })

  it('gives every member a status: 404 for not_found, 409 for every other code', () => {
    for (const code of PAYMENT_SCOPE_REFUSAL_CODES) {
      expect(PAYMENT_SCOPE_REFUSAL_STATUS[code], code).toBe(code.endsWith('_not_found') ? 404 : 409)
    }
    expect(Object.keys(TASK_BUDGET_REFUSAL_STATUS)).toEqual([...TASK_BUDGET_PAYMENT_REFUSALS])
    expect(Object.keys(SUB_BUDGET_REFUSAL_STATUS)).toEqual([...SUB_BUDGET_PAYMENT_REFUSALS])
  })
})
