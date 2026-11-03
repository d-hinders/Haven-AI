import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ArrowUp, Download, ExternalLink } from 'lucide-react'
import { Button } from '../Button'

/**
 * Tap-target guard (#1726).
 *
 * `sm` painted a 36px-tall control and `md` 40px — under the ~44px commonly
 * cited as comfortable for touch. The fix extends the HIT AREA with a
 * transparent pseudo-element instead of raising the rendered heights, so the
 * density of every table, toolbar and row list is untouched.
 *
 * jsdom cannot compute Tailwind, so these assertions read the utility classes
 * and convert them back to pixels. That is deliberate: the invariant being
 * guarded — "the target is at least 44px while the paint is unchanged" — is
 * expressible in the class names, and both halves of it break under mutation.
 */

const SIZES = ['sm', 'md', 'lg'] as const
const COMFORTABLE_TAP_TARGET_PX = 44

/** Tailwind's spacing scale: `h-9` is 9 × 4px. */
const remScaleToPx = (step: string) => Number(step) * 4

const classesOf = (name: string) => screen.getByRole('button', { name }).className.split(/\s+/)

/** The height the button actually paints. */
const paintedHeightPx = (classes: string[]) => {
  const cls = classes.find((c) => /^h-\d+$/.test(c))
  if (!cls) throw new Error(`no painted height class in: ${classes.join(' ')}`)
  return remScaleToPx(cls.slice('h-'.length))
}

/**
 * The height that actually receives taps: the pseudo-element overlay when the
 * size carries one, otherwise the painted height.
 */
const tapTargetHeightPx = (classes: string[]) => {
  const cls = classes.find((c) => /^after:h-\d+$/.test(c))
  if (!cls) return paintedHeightPx(classes)
  // An overlay only enlarges the target if it is positioned against the button
  // and centred on it. Absent any of these it is inert, or offset — either way
  // it is not the target it claims to be.
  for (const required of [
    'relative',
    'after:absolute',
    'after:top-1/2',
    'after:-translate-y-1/2',
    "after:content-['']",
  ]) {
    if (!classes.includes(required)) {
      throw new Error(`tap-target overlay is missing "${required}": ${classes.join(' ')}`)
    }
  }
  return remScaleToPx(cls.slice('after:h-'.length))
}

// The first render in this file pays for React + jsdom warm-up, which on a loaded
// machine or a cold CI runner can exceed vitest's 5s default. These assertions are
// pure string work, so a generous ceiling costs nothing and keeps the guard from
// flaking — an intermittently red guard is one people learn to ignore.
const COLD_START_TIMEOUT_MS = 30_000

describe('Button tap targets (#1726)', () => {
  it.each(SIZES)(
    'size=%s offers a tap target of at least 44px',
    (size) => {
      render(<Button size={size}>Remove</Button>)
      expect(tapTargetHeightPx(classesOf('Remove'))).toBeGreaterThanOrEqual(
        COMFORTABLE_TAP_TARGET_PX,
      )
    },
    COLD_START_TIMEOUT_MS,
  )

  it('leaves the painted heights alone, so no existing layout shifts', () => {
    // The whole point of the pseudo-element approach: these three numbers are
    // what every table, toolbar and row list in the product is laid out around.
    // If this test fails, the change stopped being layout-neutral.
    const painted: Record<string, number> = {}
    for (const size of SIZES) {
      const { unmount } = render(<Button size={size}>Remove</Button>)
      painted[size] = paintedHeightPx(classesOf('Remove'))
      unmount()
    }
    expect(painted).toEqual({ sm: 36, md: 40, lg: 44 })
  })

  it('grows the target vertically only, so neighbouring controls keep their taps', () => {
    // A horizontally-inflated target would swallow taps meant for the next
    // button in a `gap-2` toolbar. `inset-x-0` pins the overlay to the button's
    // own width.
    render(<Button size="sm">Remove</Button>)
    const classes = classesOf('Remove')
    expect(classes).toContain('after:inset-x-0')
    expect(classes.filter((c) => /^after:(-?inset-x-(?!0$)|w-|-?left-|-?right-|px-)/.test(c))).toEqual(
      [],
    )
  })

  it('applies the same tap target to the link form', () => {
    render(
      <Button size="sm" href="/agents">
        View agents
      </Button>,
    )
    const classes = screen.getByRole('link', { name: 'View agents' }).className.split(/\s+/)
    expect(tapTargetHeightPx(classes)).toBeGreaterThanOrEqual(COMFORTABLE_TAP_TARGET_PX)
  })

  it('does not let a caller className displace the tap-target classes', () => {
    render(
      <Button size="sm" className="w-full">
        Remove
      </Button>,
    )
    const classes = classesOf('Remove')
    expect(classes).toContain('w-full')
    expect(tapTargetHeightPx(classes)).toBeGreaterThanOrEqual(COMFORTABLE_TAP_TARGET_PX)
  })
})

/**
 * #2203. The recoverable-funds CTA was a hand-rolled `<a>` at ~24 CSS px on
 * the money-recovery path — the one CTA inside an `ApprovalRequiredBanner`
 * that was not already a `Button`. Moving it onto the primitive used to cost
 * it its `aria-label`, so the prop exists; these pin that it survives on BOTH
 * branches, since the CTA takes the link branch and its neighbour does not.
 */
describe('Button accessible name (#2203)', () => {
  it('carries an aria-label on the button branch', () => {
    render(<Button aria-label="Recover funds to your Haven wallet">Recover funds</Button>)
    expect(screen.getByRole('button', { name: 'Recover funds to your Haven wallet' })).toBeTruthy()
  })

  it('carries an aria-label on the link branch', () => {
    render(
      <Button href="/agents/a/sweep" aria-label="Recover funds to your Haven wallet">
        Recover funds
      </Button>,
    )
    expect(screen.getByRole('link', { name: 'Recover funds to your Haven wallet' })).toBeTruthy()
  })

  it('falls back to the visible label when none is given', () => {
    render(<Button>Recover funds</Button>)
    expect(screen.getByRole('button', { name: 'Recover funds' })).toBeTruthy()
  })
})

describe('Button disclosure pair (#2903)', () => {
  it('carries aria-expanded and aria-controls on the button branch', () => {
    render(
      <Button aria-expanded={false} aria-controls="feed-settings">
        Settings
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Settings' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-controls')).toBe('feed-settings')
  })

  it('emits neither when the caller passes neither', () => {
    render(<Button>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button.hasAttribute('aria-expanded')).toBe(false)
    expect(button.hasAttribute('aria-controls')).toBe(false)
  })
})

/**
 * #4561. A label that breaks mid-phrase is a layout bug, not a wrap: "Set
 * budget" split onto two lines inside a 98px button at 1288px, measured in
 * the browser (`white-space: normal`). The default is `whitespace-nowrap`;
 * `wrap` is the one opt-out, and it has to carry the matching size class
 * because a fixed height cannot hold a second line.
 *
 * jsdom does not lay out, so these read the utility classes — the same
 * instrument the tap-target guard above uses, and the same reason: the
 * invariant is expressible in the class names and breaks under mutation.
 */
describe('Button label wrapping (#4561)', () => {
  const classesOfLabel = (name: string) => screen.getByRole('button', { name }).className.split(/\s+/)

  it('never wraps by default', () => {
    render(<Button>Set budget</Button>)
    const classes = classesOfLabel('Set budget')
    expect(classes).toContain('whitespace-nowrap')
    expect(classes).not.toContain('whitespace-normal')
  })

  it('keeps the fixed painted height on the default form', () => {
    render(<Button size="sm">Set budget</Button>)
    expect(classesOfLabel('Set budget')).toContain('h-9')
  })

  it('wrap opts out of nowrap', () => {
    render(<Button wrap>Copied — paste it to Atlas</Button>)
    const classes = classesOfLabel('Copied — paste it to Atlas')
    expect(classes).toContain('whitespace-normal')
    expect(classes).not.toContain('whitespace-nowrap')
  })

  it.each([
    ['sm', 'min-h-9'],
    ['md', 'min-h-10'],
    ['lg', 'min-h-11'],
  ] as const)('wrap at size=%s keeps the declared height as a floor (%s)', (size, floor) => {
    // A fixed `h-*` would paint the second line outside the button's box, so
    // the wrapping form swaps it for the same number as a `min-h-*`.
    render(
      <Button size={size} wrap>
        Copied — paste it to Atlas
      </Button>,
    )
    const classes = classesOfLabel('Copied — paste it to Atlas')
    expect(classes).toContain(floor)
    expect(classes.some((c) => /^h-\d+$/.test(c))).toBe(false)
  })
})

/**
 * Icons on buttons (#4639, DS § Buttons → Icons on buttons): one decorative
 * lucide icon, before the label (`leadingIcon`) or after it (`trailingIcon`),
 * at the 14px rung. Lucide stamps each SVG with `lucide-<name>`, so the glyph
 * is asserted by that class — a swapped icon fails.
 */

const svgs = (el: HTMLElement) => Array.from(el.querySelectorAll('svg'))
const glyph = (svg: SVGElement) => Array.from(svg.classList).find((c) => c.startsWith('lucide-') && c !== 'lucide-icon') ?? ''

describe('Button icons (#4639)', () => {
  it('leadingIcon draws one aria-hidden 14px icon BEFORE the label, and the label stays the accessible name', () => {
    render(<Button leadingIcon={ArrowUp}>Send</Button>)
    const button = screen.getByRole('button', { name: 'Send' })
    const icons = svgs(button)
    expect(icons).toHaveLength(1)
    expect(glyph(icons[0])).toBe('lucide-arrow-up')
    expect(icons[0].getAttribute('aria-hidden')).toBe('true')
    expect(icons[0].getAttribute('class')).toMatch(/\bh-3\.5\b/)
    expect(icons[0].getAttribute('class')).toMatch(/\bw-3\.5\b/)
    // Order: the icon is the first child, the label text follows it.
    expect(button.firstElementChild).toBe(icons[0])
    expect(button.textContent).toBe('Send')
  })

  it('leadingIcon renders on the href (next/link) branch too', () => {
    render(
      <Button href="/export" leadingIcon={Download}>
        Export
      </Button>,
    )
    const link = screen.getByRole('link', { name: 'Export' })
    const icons = svgs(link)
    expect(icons).toHaveLength(1)
    expect(glyph(icons[0])).toBe('lucide-download')
    expect(link.firstElementChild).toBe(icons[0])
  })

  it('trailingIcon={true} still draws ArrowRight after the label', () => {
    render(<Button trailingIcon>Continue</Button>)
    const button = screen.getByRole('button', { name: 'Continue' })
    const icons = svgs(button)
    expect(icons).toHaveLength(1)
    expect(glyph(icons[0])).toBe('lucide-arrow-right')
    expect(button.lastElementChild).toBe(icons[0])
  })

  it('trailingIcon={ExternalLink} draws that glyph after the label', () => {
    render(
      <Button href="https://example.test" target="_blank" trailingIcon={ExternalLink}>
        View on explorer
      </Button>,
    )
    const link = screen.getByRole('link', { name: 'View on explorer' })
    const icons = svgs(link)
    expect(icons).toHaveLength(1)
    expect(glyph(icons[0])).toBe('lucide-external-link')
    expect(link.lastElementChild).toBe(icons[0])
    expect(icons[0].getAttribute('aria-hidden')).toBe('true')
  })

  it('draws no icon when neither prop is given', () => {
    render(<Button>Cancel</Button>)
    expect(svgs(screen.getByRole('button', { name: 'Cancel' }))).toHaveLength(0)
  })

  it('one icon per button is a type error', () => {
    // @ts-expect-error — leadingIcon and trailingIcon are mutually exclusive (#4639).
    const both = <Button leadingIcon={ArrowUp} trailingIcon>Both</Button>
    expect(both).toBeTruthy()
  })
})
