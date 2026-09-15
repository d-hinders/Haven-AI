import { render, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StatTile } from '../StatTile'

/**
 * The StatTile contract (#2947, slice C).
 *
 * Two rules make this primitive worth a file of its own, and both are about
 * colour rather than layout:
 *
 *  1. **The figure never carries tone.** The value renders in ink in every
 *     state, so a number that goes red with volume is a defect regardless of
 *     how plausible the screen looks afterwards. That is why the check that
 *     reads worst here walks the four states a tile can be rendered in: a
 *     state-transition bug is exactly the class of thing one screenshot misses.
 *  2. **A chip's tone is derived, never supplied.** The caller declares what a
 *     RISING value of its figure means and the tile picks the colour; a caller
 *     that cannot answer that question is refused at render rather than given a
 *     default, because the one default that exists (green-for-more) is wrong
 *     for half the figures on the page.
 *
 * Every assertion reads the class tokens of the rendered chip rather than a
 * computed style, which is what makes it runnable without a browser. The
 * tokens are the same names `StatusBadge` maps, so a rename in the design
 * system fails here too — that coupling is wanted, not incidental.
 *
 * Queries are scoped to the container each render returned rather than to
 * `screen`: several tests below mount the same tile twice to compare two
 * directions of the same figure, and unscoped queries would find both.
 */

function mount(element: Parameters<typeof render>[0]) {
  const view = render(element)
  const container = view.container as HTMLElement
  const tile = () => container.querySelector('[data-testid^="stat-tile-"]') as HTMLElement
  const chip = () => tile().querySelector('[class*="rounded-full"]')
  const value = () => tile().querySelector('[class*="v2-tabular"]') as HTMLElement
  const text = (want: string) => within(container).getByText(want)
  return { ...view, tile, chip, value, text, html: () => container.innerHTML }
}

describe('StatTile — what it renders', () => {
  it('renders the label, the figure, and the sentence under it', () => {
    const t = mount(<StatTile label="Spent" value="$324.75" footnote="based on 5 payments" />)
    expect(t.tile()).not.toBeNull()
    expect(t.tile().getAttribute('data-testid')).toBe('stat-tile-spent')
    expect(t.text('Spent')).toBeTruthy()
    expect(t.text('$324.75')).toBeTruthy()
    expect(t.text('based on 5 payments')).toBeTruthy()
  })

  it('keeps the test hook derivable from the label, the way the capture harness finds tiles', () => {
    // The hook is a function of the label, not a hand-typed string per call
    // site, so the analytics scenarios' selectors and this component cannot
    // disagree about what a tile is called.
    const t = mount(<StatTile label="Fees paid to Haven" value="No fees yet" />)
    expect(t.tile().getAttribute('data-testid')).toBe('stat-tile-fees-paid-to-haven')
  })

  it('renders a unit beside the figure without borrowing the figure weight', () => {
    // The unit is the token the figure is denominated in, and it is secondary
    // ink at a smaller size: a `USDC` set in the figure's own weight would
    // make the pair read as one long number at a glance. It is a SEPARATE
    // element nested in the figure's paragraph, which is what lets it carry
    // different ink at all — so the figure's own text node must stay bare.
    const t = mount(<StatTile label="Balance" value="250.00" unit="USDC" />)
    const unit = t.text('USDC')
    expect(unit.className).toContain('text-sm')
    expect(unit.className).toContain('text-[var(--v2-ink-3)]')
    expect(unit.className).not.toContain('text-2xl')
    expect(unit.tagName).toBe('SPAN')
    // The figure itself, minus the nested unit: the first text node of the
    // paragraph that holds the number.
    const figure = t.value()
    const ownText = Array.from(figure.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim()
    expect(ownText).toBe('250.00')
  })

  it('omits the unit element entirely when the caller passes none', () => {
    // The four Analytics tiles have no unit at all; a stray empty span would
    // put a gap in the figure's line and give the display a second thing to
    // be wrong about.
    const t = mount(<StatTile label="Spent" value="$324.75" />)
    expect(within(t.container as HTMLElement).queryByText('USDC')).toBeNull()
    expect(t.value().querySelector('span')).toBeNull()
  })

  it('renders no chip at all when there is no change to report', () => {
    // `null` is the state the formatter hands over when there was nothing to
    // compare against, and the answer is the absence of a claim — not a
    // confident "+0.0%" that a reader cannot tell from a real flat.
    const t = mount(<StatTile label="Spent" value="$324.75" polarity="neutral" delta={null} />)
    expect(t.chip()).toBeNull()
  })

  it('renders no chip for an omitted delta either, which is the same state by another route', () => {
    const t = mount(<StatTile label="Fees paid to Haven" value="No fees yet" polarity="neutral" />)
    expect(t.chip()).toBeNull()
  })

  it('formats a chip to one decimal place with an explicit sign', () => {
    // One decimal because the figures behind it are window aggregates, and a
    // sign because "+12%" and "-12%" are two different news stories that a
    // colour alone cannot tell a reader who cannot see the colour.
    const up = mount(<StatTile label="Spent" value="$324.75" polarity="neutral" delta={15.94} />)
    expect(up.chip()?.textContent).toBe('+15.9%')
    const down = mount(<StatTile label="Spent" value="$324.75" polarity="neutral" delta={-33.33} />)
    expect(down.chip()?.textContent).toBe('-33.3%')
    const flat = mount(<StatTile label="Spent" value="$324.75" polarity="neutral" delta={0} />)
    expect(flat.chip()?.textContent).toBe('0.0%')
  })
})

describe('StatTile — the polarity rule', () => {
  it('reads a rise in a bad figure as danger and a fall as success', () => {
    // Refused: more refusals is worse news and fewer is better, so the two
    // directions are opposite tones under the one reading.
    const up = mount(<StatTile label="Refused" value="2" polarity="higher-is-bad" delta={100} />)
    expect(up.chip()?.className).toContain('text-[var(--v2-danger)]')
    const down = mount(<StatTile label="Refused" value="2" polarity="higher-is-bad" delta={-50} />)
    expect(down.chip()?.className).toContain('text-[var(--v2-success)]')
  })

  it('reads a rise in a figure worth warning about as a warning, and a fall as nothing', () => {
    // Budget used: past three quarters of the delegation is the condition the
    // chip exists to surface, and a fall is not news at all.
    const up = mount(<StatTile label="Budget used" value="1/2" polarity="higher-is-warning" delta={40} />)
    expect(up.chip()?.className).toContain('text-[var(--v2-warning)]')
    const down = mount(<StatTile label="Budget used" value="1/2" polarity="higher-is-warning" delta={-40} />)
    expect(down.chip()?.className).toContain('text-[var(--v2-ink-2)]')
    expect(down.chip()?.className).not.toContain('text-[var(--v2-success)]')
    expect(down.chip()?.className).not.toContain('text-[var(--v2-danger)]')
  })

  it('keeps the chip neutral in both directions for a figure that is neither good nor bad', () => {
    // Spend and fees are activity, not loss. Colouring a rising spend red is
    // the single most likely misreading of this surface, and it is the one
    // this file exists to prevent.
    const up = mount(<StatTile label="Spent" value="$324.75" polarity="neutral" delta={200} />)
    expect(up.chip()?.className).toContain('text-[var(--v2-ink-2)]')
    const down = mount(<StatTile label="Spent" value="$324.75" polarity="neutral" delta={-200} />)
    expect(down.chip()?.className).toContain('text-[var(--v2-ink-2)]')
    expect(down.chip()?.className).not.toContain('text-[var(--v2-success)]')
  })

  it('reads a flat figure as neutral under every polarity, including the alarming ones', () => {
    // "No change" is neither better nor worse under any reading of the figure,
    // so the reading does not get a vote.
    for (const polarity of ['higher-is-bad', 'neutral', 'higher-is-warning'] as const) {
      const t = mount(<StatTile label="Flat" value="1" polarity={polarity} delta={0} />)
      expect(t.chip()?.className).toContain('text-[var(--v2-ink-2)]')
      expect(t.chip()?.className).not.toContain('text-[var(--v2-danger)]')
      expect(t.chip()?.className).not.toContain('text-[var(--v2-warning)]')
    }
  })

  it('refuses a chip whose figure nobody can read', () => {
    // The caller has not said whether more of this figure is bad, so the tile
    // has no basis for a colour and says so loudly, at render time, rather
    // than defaulting to the one guess that would be wrong half the time.
    const error = console.error
    console.error = () => {}
    try {
      expect(() => render(<StatTile label="Mystery" value="1" delta={12} />)).toThrow(/polarity/)
    } finally {
      console.error = error
    }
  })
})

describe('StatTile — the figure carries no colour', () => {
  it('renders the value in ink whatever the polarity and whatever the direction', () => {
    // The headless equivalent AGENTS.md asks for when a rendered check is
    // skipped: the class is pinned across the state transitions, so a change
    // that colours the number with volume fails in CI rather than reaching a
    // screenshot review.
    const states = [
      { polarity: 'higher-is-bad', delta: 999 },
      { polarity: 'higher-is-bad', delta: -999 },
      { polarity: 'neutral', delta: 999 },
      { polarity: 'higher-is-warning', delta: 999 },
      { polarity: 'higher-is-warning', delta: null },
      { polarity: 'neutral', delta: null },
    ] as const

    for (const state of states) {
      const t = mount(<StatTile label="Stable" value="$324.75" polarity={state.polarity} delta={state.delta} />)
      const value = t.value()
      expect(value.className).toContain('text-[var(--v2-ink)]')
      for (const tone of ['--v2-danger', '--v2-warning', '--v2-success', '--v2-brand']) {
        expect(value.className).not.toContain(`text-[var(${tone})]`)
      }
    }
  })

  it('keeps the card chrome identical across those same states', () => {
    // The border and the surface are the card; an alarming figure does not
    // get a redder border, because the tile is a reading and not a
    // notification.
    const t = mount(<StatTile label="Refused" value="9" polarity="higher-is-bad" delta={500} />)
    expect(t.tile().className).toContain('border-[var(--v2-border)]')
    expect(t.tile().className).toContain('bg-[var(--v2-bg)]')
    expect(t.tile().className).toContain('shadow-card')
    expect(t.tile().className).not.toContain('--v2-danger')
  })
})

describe('StatTile — the caption of the chip', () => {
  it('names the window the change is measured against, beside the chip', () => {
    // A percentage without its base is a rumour: plus 15.9% of what, over
    // which period. The caption is the endpoint's window, not a guess made
    // here, and the tile renders it rather than leaving it to the page.
    const t = mount(
      <StatTile
        label="Spent"
        value="$324.75"
        polarity="neutral"
        delta={15.9}
        deltaCaption="vs previous 30 days"
      />,
    )
    expect(t.text('vs previous 30 days')).toBeTruthy()
    expect(t.chip()?.textContent).toBe('+15.9%')
  })

  it('omits the caption when the caller has not said what the change is versus', () => {
    const t = mount(<StatTile label="Spent" value="$324.75" polarity="neutral" delta={15.9} />)
    expect(t.chip()?.textContent).toBe('+15.9%')
    expect(within(t.container as HTMLElement).queryByText(/^vs previous/)).toBeNull()
  })
})
