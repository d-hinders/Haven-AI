/**
 * #1402: the action-row visibility matrix. RemoveAgentDialog.test.tsx proves
 * the dialog's internal state machine; this file pins WHICH control renders
 * for each {status, account_type, archived_at} combination, so dropping a
 * gate (e.g. !isArchived) or inverting the rail check cannot ship silently.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Agent } from '@/hooks/useAgents'
import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '@/lib/agent-pause-copy'
import { STRANDED_FUNDS_TITLE, strandedFundsCause } from '@/lib/stranded-funds-copy'

/** Escape a copy string for use inside a text-matching RegExp. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

vi.mock('../RemoveAgentDialog', () => ({
  RemoveAgentDialog: () => <div data-testid="remove-agent-dialog" />,
}))

const { AgentCard } = await import('../AgentCard')

function agentFixture(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Research agent',
    description: null,
    delegate_address: '0x' + '22'.repeat(20),
    safe_id: 'safe-1',
    safe_address: '0x' + '11'.repeat(20),
    safe_name: 'Main account',
    safe_chain_id: 84532,
    status: 'active',
    account_type: 'delegator_hybrid',
    created_at: '2026-05-01T00:00:00Z',
    allowances: [],
    ...overrides,
  } as Agent
}

function renderCard(agent: Agent, { canUseWalletActions = true } = {}) {
  const onRestore = vi.fn()
  const { container } = render(
    <AgentCard
      agent={agent}
      onViewDetails={vi.fn()}
      onEdit={vi.fn()}
      onPause={vi.fn()}
      onResume={vi.fn()}
      onRevokeCredential={vi.fn().mockResolvedValue(undefined)}
      onArchive={vi.fn().mockResolvedValue(undefined)}
      onRestore={onRestore}
      busyAction={null}
      canUseWalletActions={canUseWalletActions}
    />,
  )
  return { onRestore, container }
}

/**
 * #2195: the stranded-funds notice on this card and the recoverable-funds
 * banner on `/agents/[agentId]` describe ONE reconciliation event, one click
 * apart, and used to say it in two different sentences with two different
 * titles. The core clause now comes from `lib/stranded-funds-copy.ts`.
 *
 * These assertions compare the render against that module ON PURPOSE — the
 * claim under test is "this surface renders the SHARED clause", so importing
 * it is what makes a re-divergence fail. The independently-restated literal
 * lives where it belongs: `stranded-funds-copy.test.ts` pins the words, and
 * `e2e/agent-panel-states.visual.spec.ts` pins the title.
 */
describe('AgentCard stranded-funds notice (#2195)', () => {
  it('uses the shared title and the shared cause clause', () => {
    renderCard(agentFixture({ has_stranded_funds: true } as Partial<Agent>))
    expect(screen.getByText(STRANDED_FUNDS_TITLE)).toBeTruthy()
    expect(screen.getByText(new RegExp(escapeRe(strandedFundsCause(null))))).toBeTruthy()
  })

  /**
   * The information-richness half of #2195, made structural.
   *
   * `has_stranded_funds` is a bare SQL `EXISTS(...)` in both agent-row reads
   * (`repositories/agents.ts`), so this surface can prove the state exists and
   * nothing more. It must not borrow the detail banner's count or amount — it
   * has neither — so its clause is the count-free one.
   */
  it('makes no claim it cannot support: no count, no amount, from a boolean EXISTS', () => {
    renderCard(agentFixture({ has_stranded_funds: true } as Partial<Agent>))
    const notice = screen.getByText(STRANDED_FUNDS_TITLE).parentElement as HTMLElement
    const text = notice.textContent ?? ''
    expect(text).toContain('At least one payment')
    expect(text).not.toMatch(/\bA payment was\b/)
    expect(text).not.toMatch(/\d+ payments were/)
    expect(text).not.toMatch(/USDC/)
  })

  it('shows nothing when the agent has no open reconciliation event', () => {
    renderCard(agentFixture())
    expect(screen.queryByText(STRANDED_FUNDS_TITLE)).toBeNull()
  })

  it('does not advertise recovery for a legacy Safe agent', () => {
    renderCard(agentFixture({ account_type: 'safe', has_stranded_funds: true } as Partial<Agent>))
    expect(screen.queryByText(STRANDED_FUNDS_TITLE)).toBeNull()
    expect(screen.queryByText(/View agent to recover these funds/)).toBeNull()
  })
})

/**
 * #2216: both of this card's notices are `ApprovalRequiredBanner`, not two
 * hand-rolled copies of its shape.
 *
 * ── What is asserted here, and what is deliberately not ─────────────────────
 *
 * The defect was a COLOUR one — title and body painted `--v2-warning` where
 * the primitive keeps prose in `--v2-ink` / `--v2-ink-2` and reserves the tint
 * for the icon badge. jsdom resolves no stylesheet, so a colour claim cannot
 * be made honestly in this file; it is made where it can be, against computed
 * style on a real render, in `e2e/agent-panel-states.visual.spec.ts`.
 *
 * What IS user-experienced and checkable here is the structural half, and it
 * is not a proxy for the colour: the hand-rolled notices titled themselves
 * with a `<p>`, so a screen-reader user got two untitled paragraphs where the
 * agent-detail banners for the same two facts announce headings. Asserting the
 * heading role is therefore a claim about the accessibility tree in its own
 * right — and it happens to be unsatisfiable without the primitive, which is
 * what makes it the adoption guard too.
 *
 * The `<p>` absence assertion is the other half. Without it a card that
 * rendered the primitive AND kept a hand-rolled copy beside it would pass:
 * the heading would be found and the old paragraph would still be on screen.
 */
describe('AgentCard warning callouts use the shared primitive (#2216)', () => {
  const CALLOUTS = [
    { label: 'paused', title: 'Paused in Haven', overrides: { status: 'paused' } },
    {
      label: 'stranded',
      title: STRANDED_FUNDS_TITLE,
      overrides: { has_stranded_funds: true },
    },
  ] as const

  for (const callout of CALLOUTS) {
    it(`titles the ${callout.label} notice with a heading, as ApprovalRequiredBanner does`, () => {
      renderCard(agentFixture(callout.overrides as Partial<Agent>))
      expect(screen.getByRole('heading', { name: callout.title })).toBeTruthy()
    })

    it(`leaves no hand-rolled ${callout.label} copy beside it`, () => {
      const { container } = renderCard(agentFixture(callout.overrides as Partial<Agent>))
      const paragraphTitles = Array.from(container.querySelectorAll('p')).filter(
        (p) => (p.textContent ?? '').trim() === callout.title,
      )
      expect(
        paragraphTitles.length,
        `the ${callout.label} notice is still titled by a <p> — either the primitive was ` +
          `not adopted, or a hand-rolled copy survives beside it`,
      ).toBe(0)
    })
  }

  /**
   * The stacked case, because the two notices are independent (an agent can
   * accumulate stranded funds while active and then be paused) and a
   * per-notice assertion cannot see a card that adopted the primitive for one
   * and left the other hand-rolled — which is precisely the inconsistency
   * #2216 says a partial fix would create INSIDE one card.
   */
  it('adopts it for BOTH notices at once, not one of the two', () => {
    const { container } = renderCard(
      agentFixture({ status: 'paused', has_stranded_funds: true } as Partial<Agent>),
    )
    const headings = Array.from(container.querySelectorAll('h3')).map((h) =>
      (h.textContent ?? '').trim(),
    )
    // The agent's own name is an `h3` too, so it is expected here — listing it
    // rather than filtering it out keeps this an exact-set assertion, which is
    // what fails when a third untitled notice appears.
    expect(headings).toEqual(['Research agent', 'Paused in Haven', STRANDED_FUNDS_TITLE])
  })
})

/**
 * #2230: the paused notice's WORDS, not just its shape.
 *
 * #2216 made this card and the agent-detail banner agree on `tone` for the
 * same fact, on the argument that leaving one fact rendered two ways across
 * the link the card itself provides is the #2195 defect. The bodies still
 * disagreed — "Existing NETWORK PERMISSIONS stay in place" here, "Existing
 * WALLET RULES stay in place" there. The detail page's wording was TAKEN
 * rather than a third written; `lib/agent-pause-copy.ts` records why.
 *
 * These assertions compare the render against that module on purpose, exactly
 * as the #2195 block above does: the claim under test is "this surface renders
 * the SHARED sentence", so importing it is what makes a re-divergence fail.
 * The independently-restated literals live in `agent-pause-copy.test.ts`, and
 * the detail page's half is asserted in its own test file — one surface
 * proving it reads the module says nothing about the other.
 */
describe('AgentCard paused notice copy (#2230)', () => {
  it('renders the shared title and the shared body', () => {
    renderCard(agentFixture({ status: 'paused' } as Partial<Agent>))
    expect(screen.getByRole('heading', { name: AGENT_PAUSED_TITLE })).toBeTruthy()
    expect(screen.getByText(new RegExp(escapeRe(AGENT_PAUSED_BODY)))).toBeTruthy()
  })

  /**
   * The card's OTHER account of a pause — the confirm dialog — has to use the
   * same noun.
   *
   * Converging the banner alone would have replaced a divergence BETWEEN two
   * screens with one INSIDE a single file, describing the same fact two
   * paragraphs apart: strictly worse than what #2230 was filed about. The
   * dialog's prose is hand-maintained rather than shared (it says more than
   * the banner and is not a candidate for one clause), so this is the cheap
   * literal guard the rework caps explicitly keep — a blanket `not.toContain`
   * on a phrase this file now has no legitimate use for, not an assertion that
   * interprets a sentence.
   */
  it('says the same thing in the pause dialog — no "network permissions" anywhere on this card', () => {
    const { container } = renderCard(agentFixture({ status: 'active' } as Partial<Agent>))
    fireEvent.click(screen.getByRole('button', { name: 'Pause Research agent' }))
    // Non-vacuity: the dialog must actually be open, or this passes on an
    // empty haystack — which is how a `not.toContain` guard goes quietly
    // useless.
    expect(
      screen.getByRole('heading', { name: /Pause Research agent\?/ }),
      'the pause dialog did not open, so the absence check below is vacuous',
    ).toBeTruthy()
    // Case-INSENSITIVE, on `haven-reviewer`'s own mutation: it reintroduced
    // the divergence as "Network Permissions" and the `toContain` form stayed
    // green. Nobody types that by accident, but a guard whose only job is to
    // catch one phrase should not be defeatable by the shift key.
    expect((container.textContent ?? '') + (document.body.textContent ?? '')).not.toMatch(
      /network permissions/i,
    )
  })
})

describe('AgentCard action-row matrix (#1402)', () => {
  it('active delegation agent: Remove shown, Safe Revoke hidden', () => {
    renderCard(agentFixture())
    const actions = [
      screen.getByRole('button', { name: 'Edit Research agent' }),
      screen.getByRole('button', { name: 'Pause Research agent' }),
      screen.getByRole('button', { name: 'Remove Research agent' }),
    ]
    for (const action of actions) {
      // Hand-rolled text actions have their own non-overlapping 44px target.
      expect(action.className).toContain('min-h-11')
      expect(action.className).toContain('min-w-11')
    }
    expect(screen.queryByRole('button', { name: 'Revoke Research agent' })).toBeNull()
  })

  it('keeps the live delegation budget row and does not render the historical meter', () => {
    const { container } = renderCard(
      agentFixture({
        allowances: [{
          id: 'allowance-1',
          agent_id: 'agent-1',
          token_address: '0x' + '33'.repeat(20),
          token_symbol: 'USDC',
          allowance_amount: '1000000',
          reset_period_min: 1440,
        }],
      } as Partial<Agent>),
    )

    expect(screen.getByText('Enforced on-chain')).toBeInTheDocument()
    expect(container.querySelector('.allowance-fill')).toBeNull()
  })

  it('active legacy agent: no authority actions are shown while operational', () => {
    renderCard(agentFixture({ account_type: 'safe' as Agent['account_type'] }))
    expect(screen.getByRole('button', { name: 'Rename Research agent' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Revoke Research agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove Research agent' })).toBeNull()
  })

  it('paused legacy agent stays readable without live pause messaging or resume', () => {
    renderCard(agentFixture({ account_type: 'safe' as Agent['account_type'], status: 'paused' }))
    expect(screen.getByText('paused')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Paused in Haven' })).toBeNull()
    expect(screen.queryByRole('button', { name: /resume/i })).toBeNull()
  })

  it('revoked-not-archived agent (any rail): status note + Remove, no Restore', () => {
    renderCard(agentFixture({ status: 'revoked', account_type: 'safe' as Agent['account_type'] }))
    expect(screen.getByText('Network access already revoked')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Research agent' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull()
  })

  it('archived agent: Restore only — no Remove, no Revoke, and the restore promise is stated', () => {
    const { onRestore } = renderCard(
      agentFixture({ status: 'revoked', archived_at: '2026-06-01T00:00:00Z' }),
    )
    expect(screen.queryByRole('button', { name: 'Remove Research agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Revoke Research agent' })).toBeNull()
    expect(screen.getByText(/restoring never re-enables spending/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restore Research agent to the list' }))
    expect(onRestore).toHaveBeenCalled()
  })

  it('Remove opens the dialog; it is not mounted before that', () => {
    renderCard(agentFixture())
    expect(screen.queryByTestId('remove-agent-dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Research agent' }))
    expect(screen.getByTestId('remove-agent-dialog')).toBeTruthy()
  })
})
