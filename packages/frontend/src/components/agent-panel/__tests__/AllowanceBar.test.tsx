/**
 * #1846: keep the two allowance rows from silently converging.
 *
 * `AllowanceBar` is a real proportional meter — it has an on-chain
 * spent-versus-budget pair, so its fill MUST be able to look different when
 * that pair differs. `ConfiguredAllowanceRow` has no spend figure at all
 * (`AgentAllowance` is `{ allowance_amount, reset_period_min }`), so it must
 * render no meter-shaped control. It used to render a `h-full w-full` rule
 * with `AllowanceBar`'s exact geometry: permanently pegged at 100%, identical
 * whatever was true, which is the one thing a meter must never be.
 *
 * Both halves are pinned HERE, in one file, on purpose: the absence assertion
 * on the configured row only means something because the presence assertion on
 * the real bar runs in the same file against the same detector. An absence
 * proved by a detector that finds nothing anywhere proves nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { AgentAllowance } from '@/hooks/useAgents'
import type { AllowanceInfo } from '@/lib/allowance-module'
import { AllowanceBar, ConfiguredAllowanceRow, GRANTED_BUDGET_CAPTION } from '../AllowanceBar'

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

/** The inline width the real meter animates to. */
async function settledFillWidth(container: HTMLElement): Promise<string> {
  return waitFor(() => {
    const fill = container.querySelector<HTMLElement>('.allowance-fill')
    expect(fill, 'AllowanceBar should render an .allowance-fill element').not.toBeNull()
    // The mount animation starts at 0% and rAF-steps to the target; wait for
    // it to settle so we compare targets, not the first frame.
    expect(fill!.style.width).not.toBe('0%')
    return fill!.style.width
  })
}

function onChainInfo(overrides: Partial<AllowanceInfo> = {}): AllowanceInfo {
  return {
    token: TOKEN,
    amount: 1_000_000_000n, // 1000 USDC at 6dp
    spent: 0n,
    resetTimeMin: 1440,
    lastResetMin: Math.floor(Date.now() / 60_000),
    nonce: 1,
    ...overrides,
  }
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

describe('AllowanceBar — the real on-chain meter (#1846)', () => {
  it('renders a track and a proportional fill [presence: positive control]', () => {
    const { container } = render(
      <AllowanceBar info={onChainInfo()} chainTimeSec={null} chainId={CHAIN_ID} />,
    )
    const found = meterShapedElements(container)

    // Two distinct reasons to match, asserted separately so this control
    // cannot pass on one of them while the other is silently broken — which
    // is how the first draft of the detector hid its own dead regex.
    const tracks = found.filter((el) => FIXED_SMALL_HEIGHT.test(el.getAttribute('class') ?? ''))
    const fills = found.filter((el) => /%$/.test(el.style.width ?? ''))

    expect(
      tracks.length,
      'the real on-chain meter must render a fixed-height rounded track — ' +
        "this is the positive control that gives the configured row's " +
        'absence assertion meaning',
    ).toBe(1)
    expect(fills.length, 'the real on-chain meter must render a width-driven fill').toBe(1)
  })

  it('fill width differs when spend differs [proportionality]', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const lastResetMin = Math.floor(nowSec / 60)

    const quarterSpent = render(
      <AllowanceBar
        info={onChainInfo({ spent: 250_000_000n, lastResetMin })}
        chainTimeSec={nowSec}
        chainId={CHAIN_ID}
      />,
    )
    const quarterWidth = await settledFillWidth(quarterSpent.container)

    const mostlySpent = render(
      <AllowanceBar
        info={onChainInfo({ spent: 800_000_000n, lastResetMin })}
        chainTimeSec={nowSec}
        chainId={CHAIN_ID}
      />,
    )
    const mostlyWidth = await settledFillWidth(mostlySpent.container)

    expect(quarterWidth).toBe('25%')
    expect(mostlyWidth).toBe('80%')
    expect(
      quarterWidth,
      'a meter that renders the same width at 25% spent and 80% spent is not ' +
        'measuring anything — it can be neither right nor wrong',
    ).not.toBe(mostlyWidth)
  })
})

describe('ConfiguredAllowanceRow — configuration, not measurement (#1846)', () => {
  it('renders no meter-shaped control [absence: paired with the control above]', () => {
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

/**
 * #1995: one clock for both halves of the reset sentence.
 *
 * `AllowanceBar` decides WHETHER the allowance has reset from chain time
 * (`computeEffectiveAllowance(info, chainTimeSec)`), and used to format HOW
 * LONG UNTIL it resets from `Date.now()` — one line below a comment saying the
 * device clock must never be used for this. Two clocks, one sentence.
 *
 * **These tests are written at the boundary on purpose.** The old
 * `timeUntil`'s `if (diffMs <= 0) return 'now'` is a cliff, not a gradient: in
 * the wide middle of a period a skewed device clock only shifts the number a
 * little, and every assertion there passes with the bug fully present. The
 * defect is visible only where a skew pushes a still-live reset past zero — so
 * a test that exercises only the middle proves nothing about it, and the
 * mutation that reintroduces the bug must be shown to redden the BOUNDARY case
 * by name, not merely some case.
 *
 * One correction to the filed report, recorded because it changes what to
 * assert: the countdown here goes through `agent-panel/agent-display.tsx`'s
 * `timeUntil`, NOT `lib/format.ts`'s. Both take `ms - Date.now()`, so the split
 * is identical, but the string at the cliff is `now`, not `expired` — two
 * same-named helpers, and a grep for `timeUntil` cannot say which one a call
 * site binds to. The tests below pin the string this component actually
 * renders.
 */
describe('AllowanceBar — the countdown must be measured from chain time (#1995)', () => {
  /** The pinned fixture block from the report: 2026-07-10T09:00:00Z. */
  const CHAIN_SEC = Math.floor(Date.parse('2026-07-10T09:00:00.000Z') / 1000)
  const CHAIN_MIN = Math.floor(CHAIN_SEC / 60)
  const RESET_MIN = 1440 // 24h period

  /** Six hours into the period — the report's own case. Next reset in 18h. */
  const MID_PERIOD = { resetTimeMin: RESET_MIN, lastResetMin: CHAIN_MIN - 360 }
  /** One minute short of the boundary — still NOT reset, by chain time. */
  const AT_BOUNDARY = { resetTimeMin: RESET_MIN, lastResetMin: CHAIN_MIN - (RESET_MIN - 1) }

  const DAY_MS = 86_400_000
  /** Device clocks, all disagreeing with the chain by different amounts. */
  const DEVICE_45D_AHEAD = CHAIN_SEC * 1000 + 45 * DAY_MS
  const DEVICE_45D_BEHIND = CHAIN_SEC * 1000 - 45 * DAY_MS
  const DEVICE_5MIN_AHEAD = CHAIN_SEC * 1000 + 5 * 60_000
  const DEVICE_IN_SYNC = CHAIN_SEC * 1000

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Render with the device clock forced to `deviceMs`. Only `Date.now` is
   * stubbed — that is precisely the ambient read this issue is about, so a
   * render that is invariant under this stub is a render that does not consult
   * the device clock.
   */
  function renderWithDeviceClock(info: AllowanceInfo, deviceMs: number): HTMLElement {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(deviceMs)
    try {
      return render(
        <AllowanceBar info={info} chainTimeSec={CHAIN_SEC} chainId={CHAIN_ID} />,
      ).container
    } finally {
      spy.mockRestore()
    }
  }

  const lineStartingWith = (container: HTMLElement, prefix: string): string =>
    Array.from(container.querySelectorAll('p'))
      .map((el) => el.textContent ?? '')
      .find((t) => t.startsWith(prefix)) ?? ''

  const resetLine = (c: HTMLElement) => lineStartingWith(c, 'Resets in')
  const pendingLine = (c: HTMLElement) => lineStartingWith(c, 'Reset pending')

  it('never renders "Resets in now" for an allowance the same render decided has NOT reset [boundary cliff]', () => {
    // Chain time says: one minute of the period left. Device clock says: four
    // minutes past the boundary. With the two clocks split, `timeUntil` sees a negative
    // delta and takes its `<= 0` branch, so the row reads "Resets in now"
    // directly beneath a bar drawn from a decision that the reset has NOT
    // happened. This is the whole defect, at the only magnitude where it bites.
    const container = renderWithDeviceClock(onChainInfo(AT_BOUNDARY), DEVICE_5MIN_AHEAD)

    expect(
      resetLine(container),
      'BOUNDARY: chain time leaves 1 minute in the period, so the countdown ' +
        'must read "1m". Reading "now" means the countdown was measured from ' +
        'the device clock while the reset decision was measured from the chain',
    ).toBe('Resets in 1m')

    expect(
      pendingLine(container),
      'sanity on the other half of the sentence: the reset has not happened ' +
        'by chain time, so the pending line must be absent — without this, ' +
        'the assertion above could be satisfied by a row that simply agreed ' +
        'the allowance had reset',
    ).toBe('')
  })

  it('renders the same countdown whatever the device clock says [invariance]', () => {
    // Three device clocks 90 days apart end to end. Any residual `Date.now()`
    // read in this path makes at least two of these three differ.
    const lines = [DEVICE_45D_AHEAD, DEVICE_IN_SYNC, DEVICE_45D_BEHIND].map((deviceMs) =>
      resetLine(renderWithDeviceClock(onChainInfo(MID_PERIOD), deviceMs)),
    )

    expect(
      new Set(lines).size,
      'the countdown is a function of chain time and the allowance alone; ' +
        `three device clocks 90 days apart produced ${JSON.stringify(lines)}`,
    ).toBe(1)
    expect(
      lines[0],
      "the report's own case: six hours into a 24h period, chain time leaves 18h",
    ).toBe('Resets in 18h 0m')
  })

  it('measures the fully-spent row from the same clock [second call site]', () => {
    // `timeUntil` is called twice in this component. The second call site is
    // reachable only when the budget is exhausted, which is exactly when a user
    // reads the countdown most carefully.
    const container = renderWithDeviceClock(
      onChainInfo({ ...MID_PERIOD, spent: 1_000_000_000n }),
      DEVICE_45D_AHEAD,
    )

    expect(
      lineStartingWith(container, 'Fully spent'),
      'the fully-spent line quotes the same reset instant as the countdown ' +
        'above it and must therefore quote the same clock',
    ).toBe('Fully spent — resets in 18h 0m')
  })
})
