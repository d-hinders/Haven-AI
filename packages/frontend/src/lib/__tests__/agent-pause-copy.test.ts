/**
 * #2230 — the anti-divergence guard for the paused notice.
 *
 * The defect was two surfaces one click apart describing one fact in two
 * sentences that differed by a single noun. Sharing a module removes the
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
 */
import { describe, expect, it } from 'vitest'
import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '../agent-pause-copy'

describe('agent pause copy (#2230)', () => {
  it('keeps the title both surfaces already agreed on', () => {
    expect(AGENT_PAUSED_TITLE).toBe('Paused in Haven')
  })

  it('is the detail page’s sentence, taken verbatim rather than reworded', () => {
    expect(AGENT_PAUSED_BODY).toBe(
      'New agent payments are blocked until you resume this agent. Existing wallet rules stay in place.',
    )
  })

  /**
   * The noun is the whole issue, so it gets its own assertion rather than
   * riding on the sentence above. "network permissions" was `AgentCard`'s
   * local coinage — it appeared in exactly one file in the repository — while
   * "wallet rules" is what `packages/connect`'s README and credential note,
   * `docs/architecture/07-edge-signer.md` and the agent-detail banner all
   * already said. This fails if a future edit swaps the settled term back, or
   * reaches for the "permissions" register `docs/product/copy-guidelines.md`
   * steers away from.
   */
  it('names what survives a pause in the settled register', () => {
    expect(AGENT_PAUSED_BODY).toContain('wallet rules')
    expect(AGENT_PAUSED_BODY).not.toMatch(/permission/i)
  })

  /**
   * The opening clause is the half that never diverged, and it carries the
   * only claim in the sentence a user can act on: a pause stops NEW payments.
   * Pinned so a reword of the tail cannot quietly take the promise with it.
   */
  it('still says a pause blocks new payments until the agent is resumed', () => {
    expect(AGENT_PAUSED_BODY).toContain('New agent payments are blocked until you resume this agent.')
  })
})
