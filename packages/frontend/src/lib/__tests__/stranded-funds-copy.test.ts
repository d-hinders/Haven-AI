/**
 * #2195 — the anti-divergence guard.
 *
 * The defect was two surfaces one click apart describing one reconciliation
 * event in two different sentences. Sharing a module removes the *mechanism*
 * for that; what this file pins is the property the sharing is FOR: every
 * branch says the same thing, and only the count moves.
 *
 * The words are RESTATED here rather than imported into the assertion — a test
 * that reads the string it is checking asserts nothing about it. Same reason
 * `e2e/agent-panel-states.visual.spec.ts` keeps the title as a literal.
 */
import { describe, expect, it } from 'vitest'
import {
  STRANDED_FUNDS_TITLE,
  reviewStrandedPaymentsLabel,
  strandedFundsCause,
  strandedFundsCauseWithLocation,
} from '../stranded-funds-copy'

/**
 * The clause both surfaces share. Everything before it is the count; the only
 * thing that may differ after it is the detail banner's ADDED location clause.
 */
const SHARED_TAIL = 'funded on-chain but didn’t reach the merchant.'

/** What the detail banner adds, and only it. */
const LOCATION_TAIL =
  'funded on-chain but didn’t reach the merchant, leaving money in your agent’s wallet.'

describe('stranded-funds copy (#2195)', () => {
  it('has one title for the state, and it names the wallet rather than the delegate', () => {
    expect(STRANDED_FUNDS_TITLE).toBe('Recoverable funds in agent wallet')
    // "delegate" is the internal name for the agent's EOA; the product does not
    // use it with users anywhere else, and the old AgentCard title did.
    expect(STRANDED_FUNDS_TITLE).not.toMatch(/delegate/i)
  })

  it('ends every branch with the identical shared clause', () => {
    for (const count of [null, 1, 2, 7] as const) {
      expect(strandedFundsCause(count).endsWith(SHARED_TAIL), `count=${count}`).toBe(true)
      expect(
        strandedFundsCauseWithLocation(count).endsWith(LOCATION_TAIL),
        `count=${count}`,
      ).toBe(true)
    }
  })

  /**
   * The #2195 property, stated as an invariant rather than as two literals:
   * the detail banner's sentence is the card's sentence with a clause ADDED,
   * never a reworded core. If someone edits one branch and not the other, the
   * prefix stops matching and this fails.
   */
  it('makes the detail variant the shared clause PLUS a location, not a rewording', () => {
    for (const count of [null, 1, 2, 7] as const) {
      const core = strandedFundsCause(count)
      const withLocation = strandedFundsCauseWithLocation(count)
      // Same words up to the core's final full stop.
      expect(withLocation.startsWith(core.slice(0, -1)), `count=${count}`).toBe(true)
      expect(withLocation.length).toBeGreaterThan(core.length)
    }
  })

  it('claims exactly as much as the surface can know', () => {
    // `null` = the AgentCard's boolean EXISTS: existence, no count.
    expect(strandedFundsCause(null)).toBe(`At least one payment was ${SHARED_TAIL}`)
    expect(strandedFundsCause(1)).toBe(`A payment was ${SHARED_TAIL}`)
    expect(strandedFundsCause(2)).toBe(`2 payments were ${SHARED_TAIL}`)
    expect(strandedFundsCauseWithLocation(1)).toBe(`A payment was ${LOCATION_TAIL}`)
  })

  /**
   * The card must NOT carry the location clause: the shared title already says
   * "in agent wallet" and its link says "these funds", and the repetition cost
   * a fourth wrapped line at 390px.
   */
  it('keeps the location clause off the count-free (card) variant', () => {
    expect(strandedFundsCause(null)).not.toContain('leaving money')
  })

  it('never emits a bare singular for a count it knows is greater than one', () => {
    for (const count of [2, 3, 11]) {
      expect(strandedFundsCause(count)).toMatch(/^\d+ payments were /)
    }
  })

  /**
   * There is no `null` branch here, deliberately: a surface that cannot count
   * the events cannot honestly promise how many rows the reader will find.
   */
  it('labels the review affordance with the count it is about to show (#2196)', () => {
    expect(reviewStrandedPaymentsLabel(1)).toBe('Review the payment')
    expect(reviewStrandedPaymentsLabel(2)).toBe('Review the 2 payments')
    expect(reviewStrandedPaymentsLabel(9)).toBe('Review the 9 payments')
  })
})
