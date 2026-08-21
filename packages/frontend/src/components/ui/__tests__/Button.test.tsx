import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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

describe('Button tap targets (#1726)', () => {
  it.each(SIZES)('size=%s offers a tap target of at least 44px', (size) => {
    render(<Button size={size}>Remove</Button>)
    expect(tapTargetHeightPx(classesOf('Remove'))).toBeGreaterThanOrEqual(
      COMFORTABLE_TAP_TARGET_PX,
    )
  })

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
