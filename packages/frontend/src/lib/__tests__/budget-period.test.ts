/**
 * #1394: one describer for one grant.
 *
 * The connect flow states the same authority on the pre-approval screen, again
 * on the approved screen, and a third time in the agent's own terminal via the
 * connector. Wording drift between them makes a user wonder whether "25 USDC
 * per day" and "25 USDC daily" are the same number, so the shape lives in one
 * function and is pinned here.
 */
import { describe, expect, it } from 'vitest'
import { budgetPeriodLabel, describeBudgetGrant } from '../budget-period'

// Base USDC — 6 decimals, so the atomic string is 10^6 per unit.
const BASE = 8453
const usdc = (atomic: string, resetMin: number) => ({
  allowance_amount: atomic,
  token_symbol: 'USDC',
  reset_period_min: resetMin,
})

describe('describeBudgetGrant (#1394)', () => {
  it('formats the raw on-chain amount using the chain\'s token decimals', () => {
    // 25000000 atomic is 25 USDC, NOT twenty-five million. Passing the wrong
    // chain (or none) is how a screen shows a user the atomic integer.
    expect(describeBudgetGrant(usdc('25000000', 1440), BASE)).toBe('25.00 USDC per day')
  })

  it('uses the adverbial phrase in sentences and the noun phrase in labels', () => {
    // The label form is built for a "Budget: …" slot. Dropped into the approved
    // screen's sentence it produced "can now spend up to 10.00 USDC total
    // budget from Operating wallet" — broken grammar on the flow's payoff
    // screen, and the reason `form` exists.
    const oneTime = usdc('10000000', 0)
    expect(describeBudgetGrant(oneTime, BASE)).toBe('10.00 USDC total budget')
    expect(describeBudgetGrant(oneTime, BASE, { form: 'label' })).toBe('10.00 USDC total budget')
    expect(describeBudgetGrant(oneTime, BASE, { form: 'sentence' })).toBe('10.00 USDC in total')
  })

  it('leaves every already-adverbial period untouched in sentence form', () => {
    // Only the one-time case is a noun phrase; a blanket rewrite would be a
    // second place for these to drift.
    for (const mins of [60, 1440, 10080, 43200]) {
      const budget = usdc('25000000', mins)
      expect(describeBudgetGrant(budget, BASE, { form: 'sentence' })).toBe(
        `25.00 USDC ${budgetPeriodLabel(mins)}`,
      )
    }
  })

  it('still names the token when the chain is unknown', () => {
    // An unresolvable chain falls back to the symbol's default decimals rather
    // than rendering the atomic integer at the user.
    expect(describeBudgetGrant(usdc('25000000', 1440), null)).toBe('25.00 USDC per day')
  })
})
