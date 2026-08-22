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
import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { AgentAllowance } from '@/hooks/useAgents'
import type { AllowanceInfo } from '@/lib/allowance-module'
import { AllowanceBar, ConfiguredAllowanceRow } from '../AllowanceBar'

const CHAIN_ID = 84532
const TOKEN = ('0x' + '33'.repeat(20)) as `0x${string}`

/**
 * Elements shaped like a progress track: a pill-rounded rule with a fixed
 * small height, or one carrying an explicit percentage width.
 *
 * Known limit, stated rather than pretended away: this is a shape detector,
 * not a semantic one. A track drawn with some height class outside the list
 * below would slip past it. It is written wide enough to catch the shape the
 * removed code actually used and its near neighbours, which is what a
 * convergence guard needs to do.
 */
function meterShapedElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('*')).filter((el) => {
    const cls = el.getAttribute('class') ?? ''
    if (!/\brounded-full\b/.test(cls)) return false
    const fixedSmallHeight = /\bh-(?:\[\d+(?:px|rem)\]|px|0\.5|1|1\.5|2|2\.5|3)\b/.test(cls)
    const percentageWidth = /^\d+(?:\.\d+)?%$/.test(el.style.width ?? '')
    return fixedSmallHeight || percentageWidth
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
  it('renders exactly one meter-shaped track [presence: positive control]', () => {
    const { container } = render(
      <AllowanceBar info={onChainInfo()} chainTimeSec={null} chainId={CHAIN_ID} />,
    )
    expect(
      meterShapedElements(container).length,
      'the real on-chain meter must render a track — this is the positive ' +
        'control that gives the configured row\'s absence assertion meaning',
    ).toBe(1)
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

    expect(bigText).toContain('Configured in Haven')
    expect(smallText).toContain('Configured in Haven')
    expect(
      bigText,
      'the row must still vary with the configured envelope — dropping the ' +
        'bar must not leave a row that renders the same whatever is configured',
    ).not.toBe(smallText)
    expect(bigText).toContain('500')
    expect(smallText).toContain('25')
  })
})
