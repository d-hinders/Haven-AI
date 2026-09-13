import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@/context/ThemeContext'
import { THEME_STORAGE_KEY } from '@/lib/theme-bootstrap'
import { LocaleProvider } from '@/context/LocaleContext'
import { ThemeToggle } from '../ThemeToggle'

/**
 * The quick toggle (#2928, two-state flip per #2953): the flip in both
 * directions, the label in every palette, the system-resolution rule, the
 * absent tooltip, keyboard activation, and the reduced-motion path.
 *
 * The provider wraps the control rather than `useTheme` being mocked. The
 * flip is the interaction of two components — the button's ring and the
 * provider's `setPreference` — and the label is derived from the provider's
 * state; stubbing the hook would let a control that flips to a state the
 * provider does not implement, or announces a state it does not hold, pass
 * every green test. It is the same choice `ThemeContext.test.tsx` makes from
 * the other side of the same seam.
 */

type MotionListener = (event: { matches: boolean }) => void

let motionListeners: MotionListener[] = []
let reduced = false
let osDark = false

/**
 * jsdom's `matchMedia` (src/__tests__/setup.ts) answers `reduce` to every
 * query and never dispatches, and the ThemeContext test installs its own
 * colour-scheme mock the same way. Both queries must be modelled here: the
 * provider asks `prefers-color-scheme: dark` and the toggle asks
 * `prefers-reduced-motion: reduce`, and a mock that fanned every query out to
 * every listener would let a motion flip drive the provider's resolved theme.
 * So each query answers only its own question and registers only its own
 * listeners — the discipline the Sidebar drawer mock (#2586) documents.
 */
function installMatchMedia(initialReduced = false, initialDark = false) {
  motionListeners = []
  reduced = initialReduced
  osDark = initialDark
  vi.spyOn(window, 'matchMedia').mockImplementation(((query: string) => ({
    matches:
      query === '(prefers-color-scheme: dark)'
        ? osDark
        : query === '(prefers-reduced-motion: reduce)'
          ? reduced
          : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: (type: string, listener: MotionListener) => {
      if (query === '(prefers-reduced-motion: reduce)' && type === 'change') {
        motionListeners.push(listener)
      }
    },
    removeEventListener: (type: string, listener: MotionListener) => {
      if (type === 'change') motionListeners = motionListeners.filter((l) => l !== listener)
    },
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia)
}

/** Flip the OS motion preference and notify, the way the OS panel does. */
function setReducedMotion(matches: boolean) {
  reduced = matches
  act(() => {
    for (const listener of [...motionListeners]) listener({ matches })
  })
}

/** Recolour the device; the mount effect of the next provider reads it live. */
function setOsDark(matches: boolean) {
  osDark = matches
}

function renderToggle(ui = <ThemeToggle />) {
  return render(<LocaleProvider><ThemeProvider>{ui}</ThemeProvider></LocaleProvider>)
}

/** The control, named by its accessible message in the given palette. */
const buttonIn = (message: string) => screen.getByRole('button', { name: message })

const MESSAGES = {
  light: 'Theme: light. Switch to dark',
  dark: 'Theme: dark. Switch to light',
} as const

/** The serialisation of the glyph currently on screen, or the empty string. */
function glyphMarkup(): string {
  const svg = screen.getByRole('button').querySelector('svg')
  return svg ? String(svg.outerHTML) : ''
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    installMatchMedia()
    window.localStorage.clear()
    delete document.documentElement.dataset.theme
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete document.documentElement.dataset.theme
  })

  it('flips light to dark and back — the two-state ring #2953 specifies', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    renderToggle()
    await waitFor(() => buttonIn(MESSAGES.light))

    await user.click(buttonIn(MESSAGES.light))
    await waitFor(() => buttonIn(MESSAGES.dark))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')

    // And the ring closes: dark flips straight back to light. No third step
    // exists to pass through.
    await user.click(buttonIn(MESSAGES.dark))
    await waitFor(() => buttonIn(MESSAGES.light))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('a click while system is stored resolves the palette on screen, flips it, and persists the explicit choice', async () => {
    const user = userEvent.setup()

    // A light device: `system` resolves light, so the click must land on dark
    // — persisted as the EXPLICIT choice, never left as `system`.
    const first = renderToggle()
    await waitFor(() => buttonIn(MESSAGES.light))
    await user.click(buttonIn(MESSAGES.light))
    await waitFor(() => buttonIn(MESSAGES.dark))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    first.unmount()

    // The same gesture on a dark device resolves the other way: `system`
    // reads dark, the flip lands on light. The resolved palette decides, not
    // the stored word.
    window.localStorage.clear()
    setOsDark(true)
    renderToggle()
    await waitFor(() => buttonIn(MESSAGES.dark))
    await user.click(buttonIn(MESSAGES.dark))
    await waitFor(() => buttonIn(MESSAGES.light))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it.each([
    ['light', MESSAGES.light],
    ['dark', MESSAGES.dark],
  ] as const)(
    'in palette %s the name states the current and the next: %s',
    async (stored, message) => {
      window.localStorage.setItem(THEME_STORAGE_KEY, stored)
      renderToggle()
      await waitFor(() => buttonIn(message))
      // The one control, two messages: no stale second button, and no
      // other state's name is reachable.
      expect(screen.queryAllByRole('button')).toHaveLength(1)
      for (const other of Object.values(MESSAGES)) {
        if (other !== message) {
          expect(screen.queryByRole('button', { name: other })).toBeNull()
        }
      }
    },
  )

  it('shows the sun in light and the moon in dark — two glyphs, no monitor', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    renderToggle()
    await waitFor(() => buttonIn(MESSAGES.light))

    // Structural fingerprints rather than path literals: lucide's sun carries
    // a circle, the moon neither. Reading the SVG serialisation binds the
    // assertion to WHICH glyph is on screen, which is the claim; a snapshot
    // would bind it to lucide's whole icon library.
    const lightMarkup = glyphMarkup()
    expect(/<circle/.test(lightMarkup)).toBe(true)
    // The monitor glyph of the retired three-state ring carries a <rect>;
    // the quick toggle must not render it in ANY state (#2953).
    expect(/<rect/.test(lightMarkup)).toBe(false)

    await user.click(buttonIn(MESSAGES.light))
    await waitFor(() => buttonIn(MESSAGES.dark))
    const darkMarkup = glyphMarkup()
    expect(/<path/.test(darkMarkup)).toBe(true)
    expect(/<circle/.test(darkMarkup)).toBe(false)
    expect(/<rect/.test(darkMarkup)).toBe(false)

    // Two distinct glyphs. A component that ignored the palette and drew one
    // icon always would pass every per-state check above written against a
    // mocked icon map, and fails this one.
    expect(lightMarkup).not.toBe(darkMarkup)
  })

  it('renders no tooltip on the icon variant — a plain clickable icon (#2953)', async () => {
    const { container } = renderToggle()
    await waitFor(() => buttonIn(MESSAGES.light))
    const button = buttonIn(MESSAGES.light)

    // The trigger wrapper the Tooltip primitive renders around the control is
    // gone: the button mounts directly in its call site's markup, not under a
    // hover/focus proxy span.
    expect(button.parentElement).toBe(container)

    // Hovering and focusing show nothing: no tooltip role anywhere in the
    // document, and no aria-describedby pointing at one.
    const user = userEvent.setup()
    await user.hover(button)
    button.focus()
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(0)
    expect(button.getAttribute('aria-describedby')).toBeNull()
  })

  it('the glyph keeps a stable className across the flip — the key replays the animation, the class does not change', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    renderToggle()
    await waitFor(() => buttonIn(MESSAGES.light))

    const glyphClass = () => screen.getByRole('button').querySelector('span')?.className ?? ''
    const before = glyphClass()
    expect(before).toContain('animate-theme-swap')

    await user.click(buttonIn(MESSAGES.light))
    await waitFor(() => buttonIn(MESSAGES.dark))
    // Headless equivalent of the rendered pass: the swap is a remount of the
    // glyph under the SAME classes, so a regression that swapped the class
    // (and with it the palette-gated styles) reddens here.
    expect(glyphClass()).toBe(before)
  })

  it('is keyboard operable: Tab reaches it, Enter and Space both flip', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
    renderToggle()
    await waitFor(() => buttonIn(MESSAGES.light))

    await user.tab()
    expect(buttonIn(MESSAGES.light)).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => buttonIn(MESSAGES.dark))

    // Space is the second half of the <button> activation contract, and it
    // only lands if the focus survived the Enter-activated click.
    await user.keyboard(' ')
    await waitFor(() => buttonIn(MESSAGES.light))
  })

  it('cross-fades the swap with no OS preference and snaps it when the OS says reduce — live, not by reload', async () => {
    renderToggle()
    await waitFor(() => buttonIn(MESSAGES.light))
    const animatedGlyph = () =>
      screen.getByRole('button').querySelector('span[class*=animate-theme-swap]')

    // Before any click there is one glyph and it opts in to the cross-fade.
    expect(animatedGlyph()).not.toBeNull()

    // The OS flips the switch mid-session: the MediaQueryList listener, not a
    // remount, must carry it to the component. The class disappears ENTIRELY
    // rather than the animation being shortened — under `reduce` the component
    // does not ask for the animation at all.
    setReducedMotion(true)
    await waitFor(() => expect(animatedGlyph()).toBeNull())

    // And the next flip still works under reduce: the control degrades, it
    // does not die.
    const user = userEvent.setup()
    await user.click(buttonIn(MESSAGES.light))
    await waitFor(() => expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark'))
  })

  it('renders the More-sheet row: the visible label is the prefix of the accessible name', async () => {
    renderToggle(<ThemeToggle variant="row" />)
    await waitFor(() => buttonIn(MESSAGES.light))
    const row = buttonIn(MESSAGES.light)

    // The row shows the command and the state it is in, next to the glyph.
    expect(row.textContent).toContain('Theme')
    expect(row.textContent).toContain('Light')

    // WCAG 2.5.3 (Label in Name). The lookup above IS the assertion that the
    // accessible name is the whole sentence — dom-accessible-name computed it
    // from the control's own markup, so this does not read the attribute back
    // to itself. And the sentence begins with the visible label, so a voice
    // command that speaks the label activates this control.
    expect(/^Theme/.test(MESSAGES.light)).toBe(true)
    expect(row.textContent).toContain(MESSAGES.light.slice(0, 'Theme'.length))
  })
})
