/**
 * The anti-divergence guard for the paused notice.
 *
 * The #2230 defect was two surfaces one click apart describing one fact in
 * two sentences that differed by a single noun. Sharing a module removes the
 * *mechanism*; what this file pins is the property the sharing is FOR — that
 * the sentence is the settled one, not a third phrasing invented on the way.
 *
 * The words are RESTATED here rather than imported into the assertion: a test
 * that reads the string it is checking asserts nothing about it. Same reason
 * `stranded-funds-copy.test.ts` restates its clause and
 * `e2e/agent-panel-states.visual.spec.ts` keeps the title as a literal. The
 * two RENDER-side halves — that each surface actually reads this module — are
 * asserted where the surfaces are: `AgentCard.test.tsx` and
 * `AgentDetailClient.test.tsx`.
 *
 * The settled sentence is now the 2026-10-07 owner decision (see the module
 * header): it says what a pause does NOT block, not only what it blocks.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '../agent-pause-copy'

describe('agent pause copy (#3717)', () => {
  it('keeps the title both surfaces already agreed on', () => {
    expect(AGENT_PAUSED_TITLE).toBe('Paused in Haven')
  })

  it('is the owner-approved sentence, taken verbatim rather than reworded', () => {
    expect(AGENT_PAUSED_BODY).toBe(
      "Payments paused. Haven won't send payments for this agent until you resume. Its budget is still live on-chain. To end it, stop the budget or remove the agent.",
    )
  })

  /**
   * The load-bearing claim the #2230 sentence could not make: a Haven-side
   * pause does NOT end the budget. The delegation stays live on-chain, so a
   * pause alone is not an end to spending — the banner must say so, or the
   * next reader is left worse-informed than the 2026-10-07 owner decision.
   */
  it('says the budget stays live through a pause', () => {
    expect(AGENT_PAUSED_BODY).toContain('Its budget is still live on-chain.')
  })

  /**
   * A pause is not an end. The banner names the two actions that actually end
   * it — the Stop budget confirm and Remove — so the one-click pause does not
   * read like the last step. If either path is ever renamed, this fails and
   * the banner is updated with it, not left pointing at a control that no
   * longer exists.
   */
  it('names stop and remove as the ways to end what a pause leaves standing', () => {
    expect(AGENT_PAUSED_BODY).toContain('To end it, stop the budget or remove the agent.')
  })

  /**
   * Kept from #2230: the "permissions" register is what `docs/product/
   * copy-guidelines.md` steers away from ("Session key permissions") and what
   * `AgentCard`'s old dialog coinaged. The new sentence has no reason to
   * reach for it either.
   */
  it('stays out of the permissions register', () => {
    expect(AGENT_PAUSED_BODY).not.toMatch(/permission/i)
  })
})
