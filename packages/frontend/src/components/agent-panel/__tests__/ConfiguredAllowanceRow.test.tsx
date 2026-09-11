/**
 * #1846: `ConfiguredAllowanceRow` must render no meter-shaped control.
 *
 * It has no spend figure at all (`AgentAllowance` is
 * `{ allowance_amount, reset_period_min }`), so it must render no meter-shaped
 * control. It used to render a `h-full w-full` rule with the retired on-chain
 * meter's exact geometry: permanently pegged at 100%, identical
 * whatever was true, which is the one thing a meter must never be. That bar —
 * and the presence-side positive control that used to be paired here — went
 * with the Safe rail (#2848 deleted the meter and its off-chain mirror
 * with zero render path); the absence assertion on the configured row is what
 * remains of the split.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import type { AgentAllowance } from '@/hooks/useAgents'
import { ConfiguredAllowanceRow, GRANTED_BUDGET_CAPTION } from '../ConfiguredAllowanceRow'

const CHAIN_ID = 84532
const TOKEN = ('0x' + '33'.repeat(20)) as `0x${string}`

/**
 * Elements shaped like a progress track: a pill-rounded rule with a fixed
 * small height, or one carrying an explicit percentage width.
 *
 * The height test is written against whitespace, NOT `\b`. Tailwind's
 * arbitrary-value syntax ends in `]`, and `]` followed by a space is two
 * non-word characters — so a trailing `\b` can never match `h-[3px]`. The
 * first draft of this helper had exactly that bug, which made it structurally
 * unable to see the one shape it exists to catch; the M1 mutation (restoring
 * the removed bar verbatim) went green and exposed it.
 *
 * Known limit, stated rather than pretended away: this is a shape detector,
 * not a semantic one. A track drawn with some height class outside the set
 * below would slip past it. It is written wide enough to catch the shape the
 * removed code actually used and its near neighbours, which is what a
 * convergence guard needs to do.
 */
const FIXED_SMALL_HEIGHT = /(?:^|\s)h-(?:\[\d+(?:px|rem)\]|px|0\.5|1|1\.5|2|2\.5|3)(?=\s|$)/

function meterShapedElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('*')).filter((el) => {
    const cls = el.getAttribute('class') ?? ''
    if (!/(?:^|\s)rounded-full(?=\s|$)/.test(cls)) return false
    const percentageWidth = /^\d+(?:\.\d+)?%$/.test(el.style.width ?? '')
    return FIXED_SMALL_HEIGHT.test(cls) || percentageWidth
  })
}

function configured(overrides: Partial<AgentAllowance> = {}): AgentAllowance {
  return {
    id: 'alw-1',
    agent_id: 'agent-1',
    token_address: TOKEN,
    token_symbol: 'USDC',
    allowance_amount: '500000000',
    reset_period_min: 1440,
    ...overrides,
  } as AgentAllowance
}

describe('ConfiguredAllowanceRow — configuration, not measurement (#1846)', () => {
  it('renders no meter-shaped control', () => {
    const { container } = render(
      <ConfiguredAllowanceRow allowance={configured()} chainId={CHAIN_ID} />,
    )
    const found = meterShapedElements(container)
    expect(
      found.map((el) => el.getAttribute('class')),
      'AgentAllowance carries no spend figure, so this row has no proportion ' +
        'to draw; any track here is a decorative rule that reads as a gauge',
    ).toEqual([])
  })

  it('still says what it knows, and says something different when that differs', () => {
    const big = render(
      <ConfiguredAllowanceRow allowance={configured()} chainId={CHAIN_ID} />,
    )
    const small = render(
      <ConfiguredAllowanceRow
        allowance={configured({ id: 'alw-2', allowance_amount: '25000000', reset_period_min: 0 })}
        chainId={CHAIN_ID}
      />,
    )

    // Whole-subtree text compared as a unit: textContent concatenates across
    // children with no separator, so word-boundary matching on it is
    // structurally unreliable. Comparing two renders of the same markup is not.
    const bigText = big.container.textContent ?? ''
    const smallText = small.container.textContent ?? ''

    expect(bigText).toContain('Enforced on-chain')
    expect(smallText).toContain('Enforced on-chain')
    expect(
      bigText,
      'the row must still vary with the configured envelope — dropping the ' +
        'bar must not leave a row that renders the same whatever is configured',
    ).not.toBe(smallText)
    expect(bigText).toContain('500')
    expect(smallText).toContain('25')
  })
})

/**
 * #2283: `allowance_amount` carries TWO wire shapes under one field name, and
 * this row must render both as money.
 *
 * `AgentAllowance` — what `GET /agents` puts on `agent.allowances`, and this
 * component's only input — is the HUMAN-decimal projection
 * `rails/delegation-budget-view.ts` builds with `formatTokenValue`, so a
 * 250 USDC weekly budget arrives as `'250.000000'`. The sibling
 * `AgentConnectionAllowance` on the connect-setup routes is an ATOMIC integer
 * string for the same field name (`openapi/spec.ts`, `allowanceAtomicAmount`).
 *
 * `formatConfiguredAllowance` used to tell them apart BY EXCEPTION —
 * `BigInt('250.000000')` throws and a bare `catch` returned the string
 * untouched — so `/agents` rendered `"250.000000 USDC per week"` where
 * `/dashboard` and `/custody` rendered `250.00` for the same delegation.
 *
 * Why BOTH shapes are pinned here, not just the one that was broken: the
 * atomic case was already covered (`configured()`'s fixture is atomic) and
 * that is precisely why the bug survived — a single-shape test on a
 * two-shape field is half a test.
 *
 * The assertions read the `.v2-tabular` amount span rather than the whole
 * subtree, so they pin the formatted NUMBER exactly instead of a
 * concatenation that also carries the symbol and the period label.
 */
describe('ConfiguredAllowanceRow — both wire shapes of allowance_amount (#2283)', () => {
  function renderedAmount(allowance: AgentAllowance): string {
    const { container } = render(<ConfiguredAllowanceRow allowance={allowance} chainId={CHAIN_ID} />)
    const span = container.querySelector<HTMLElement>('.v2-tabular')
    expect(span, 'ConfiguredAllowanceRow should render a .v2-tabular amount span').not.toBeNull()
    return span?.textContent ?? ''
  }

  it('renders the delegation rail’s HUMAN-decimal string as a money figure', () => {
    expect(
      renderedAmount(configured({ allowance_amount: '250.000000', reset_period_min: 10080 })),
      "the live rail emits '250.000000'; six trailing zeroes on the page whose " +
        'job is "how much, which asset" is the #2283 defect',
    ).toBe('250.00')
  })

  it('renders the legacy ATOMIC integer string as a money figure', () => {
    expect(
      renderedAmount(configured({ allowance_amount: '250000000', reset_period_min: 10080 })),
      'the atomic shape must keep working — the fix removes the BigInt pre-parse, ' +
        'not the atomic path, which now runs inside formatAllowanceAmount',
    ).toBe('250.00')
  })

  it('renders one budget identically whichever shape the wire used', () => {
    expect(renderedAmount(configured({ allowance_amount: '250.000000' }))).toBe(
      renderedAmount(configured({ allowance_amount: '250000000' })),
    )
  })

  it('leaves the raw decimal string off the screen entirely', () => {
    const { container } = render(
      <ConfiguredAllowanceRow
        allowance={configured({ allowance_amount: '250.000000', reset_period_min: 10080 })}
        chainId={CHAIN_ID}
      />,
    )
    expect(
      container.textContent ?? '',
      'the catch used to return the wire string unformatted, so the raw value ' +
        'reached the screen verbatim',
    ).not.toContain('250.000000')
  })

  it('passes a genuinely unparseable value through unchanged', () => {
    // The `catch` is gone, but its job is not: `formatAllowanceAmount` owns
    // the fallback explicitly and documents it. Asserted here so the removal
    // of the catch is not also the silent removal of the fallback.
    expect(renderedAmount(configured({ allowance_amount: 'not-a-number' }))).toBe('not-a-number')
  })

  it('positive control: distinct budgets render distinct figures', () => {
    // Without this, a formatter that returned a constant — or that kept
    // returning its input — would satisfy a lone equality assertion above.
    expect(renderedAmount(configured({ allowance_amount: '250.000000' }))).not.toBe(
      renderedAmount(configured({ allowance_amount: '25.000000' })),
    )
    expect(renderedAmount(configured({ allowance_amount: '25.000000' }))).toBe('25.00')
  })
})

/**
 * #2224: the caption must describe where the limit is ENFORCED, not who
 * happens to be holding a copy of it.
 *
 * The row's input is `agent.allowances`, and both agent reads fill that array
 * from `deriveDelegationAllowances` — the projection of the agent's ACTIVE
 * `agent_delegations` rows (`backend/src/routes/agents.ts:92-98`, `:113-121`;
 * `rails/delegation-budget-view.ts`). A legacy-rail agent gets `[]` outright
 * (`infra/repositories/agents.ts:232-237`, #1440/#2020), so this component
 * cannot render one at all. The number is therefore always the terms of a
 * signed delegation enforced on-chain by the caveat enforcers — never a
 * Haven-held figure — and "Configured in Haven" inverted the claim `/custody`
 * exists to make.
 *
 * ── Why the assertion is written both ways ──────────────────────────────────
 *
 * Asserting only that "Enforced on-chain" is present would go green with the
 * old caption still rendered beside it, which is a half-fix that photographs
 * as a fix. The banned-phrasing assertion is what makes the removal part of
 * the contract.
 *
 * The expected string is RESTATED here rather than imported from the
 * component, for the reason `agent-panel-states.visual.spec.ts` restates the
 * banner titles: a test that imports the string it is checking asserts nothing
 * about it. `GRANTED_BUDGET_CAPTION` is imported only to prove the exported
 * constant and the rendered output are the same string, so a future call site
 * reusing the constant cannot drift from what is pinned here.
 */
describe('ConfiguredAllowanceRow — the caption names on-chain enforcement (#2224)', () => {
  it('says the budget is enforced on-chain, in /custody’s words', () => {
    const { container } = render(
      <ConfiguredAllowanceRow allowance={configured()} chainId={CHAIN_ID} />,
    )
    expect(container.textContent ?? '').toContain('Enforced on-chain')
    expect(
      GRANTED_BUDGET_CAPTION,
      'the exported caption and the string this test pins have diverged — a second ' +
        'call site reusing the constant would render something this file never checked',
    ).toBe('Enforced on-chain')
  })

  it('no longer claims Haven holds the limit', () => {
    const { container } = render(
      <ConfiguredAllowanceRow allowance={configured()} chainId={CHAIN_ID} />,
    )
    const text = container.textContent ?? ''
    // The exact old caption, and the weaker claim it belongs to. `/custody`
    // says these limits are "enforced on-chain by your account, not by Haven's
    // database"; a budget row on the same screen family must not say the
    // opposite about the same delegation.
    expect(text).not.toContain('Configured in Haven')
    expect(text).not.toMatch(/\bin Haven\b/)
  })
})
