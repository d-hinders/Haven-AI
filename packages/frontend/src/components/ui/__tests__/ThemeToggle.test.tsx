import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@/context/ThemeContext'
import { THEME_STORAGE_KEY } from '@/lib/theme-bootstrap'
import { LocaleProvider } from '@/context/LocaleContext'
import { ThemeToggle } from '../ThemeToggle'

/**
 * The quick toggle (#2928): the cycle order, the label in every state,
 * keyboard activation, and the reduced-motion path.
 *
 * The provider wraps the control rather than `useTheme` being mocked. The
 * cycle is the interaction of two components — the button's ring and the
 * provider's `setPreference` — and the label is derived from the provider's
 * state; stubbing the hook would let a control that cycles an order the
 * provider does not implement, or announces a state it does not hold, pass
 * every green test. It is the same choice `ThemeContext.test.tsx` makes from
 * the other side of the same seam.
 */

type MotionListener = (event: { matches: boolean }) => void

let motionListeners: MotionListener[] = []
let reduced = false

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
function installMatchMedia(initialReduced = false) {
  motionListeners = []
  reduced = initialReduced
  vi.spyOn(window, 'matchMedia').mockImplementation(((query: string) => ({
    matches:
      query === '(prefers-color-scheme: dark)'
        ? false
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

function renderToggle(ui = <ThemeToggle />) {
  return render(<LocaleProvider><ThemeProvider>{ui}</ThemeProvider></LocaleProvider>)
}

/** The control, named by its accessible message in the given state. */
const buttonIn = (message: string) => screen.getByRole('button', { name: message })

const MESSAGES = {
  light: 'Theme: light. Switch to dark',
  dark: 'Theme: dark. Switch to system',
  system: 'Theme: system. Switch to light',
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

  it('cycles light, dark, system, light — the order the issue specifies', async () => {
    const user = userEvent.setup()
    renderToggle()
    await waitFor(() => buttonIn(MESSAGES.system))

    await user.click(buttonIn(MESSAGES.system))
    await waitFor(() => buttonIn(MESSAGES.light))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')

    await user.click(buttonIn(MESSAGES.light))
    await waitFor(() => buttonIn(MESSAGES.dark))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')

    await user.click(buttonIn(MESSAGES.dark))
    await waitFor(() => buttonIn(MESSAGES.system))
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)

    // And the ring closes: system advances to light, not off the end.
    await user.click(buttonIn(MESSAGES.system))
    await waitFor(() => buttonIn(MESSAGES.light))
  })

  it.each([
    ['light', MESSAGES.light],
    ['dark', MESSAGES.dark],
    ['system', MESSAGES.system],
  ] as const)(
    'in preference %s the name states the current and the next: %s',
    async (stored, message) => {
      if (stored !== 'system') window.localStorage.setItem(THEME_STORAGE_KEY, stored)
      renderToggle()
      await waitFor(() => buttonIn(message))
      // The one control, three messages: no stale second button, and no
      // other state's name is reachable.
      expect(screen.queryAllByRole('button')).toHaveLength(1)
      for (const other of Object.values(MESSAGES)) {
        if (other !== message) {
          expect(screen.queryByRole('button', { name: other })).toBeNull()
        }
      }
    },
  )

  it('shows the sun in light, the moon in dark, the monitor on a system choice', async () => {
    const user = userEvent.setup()
    renderToggle()
    await waitFor(() => buttonIn(MESSAGES.system))

    // Structural fingerprints rather than path literals: lucide's sun carries
    // a circle, the monitor a rect, the moon neither. Reading the SVG
    // serialisation binds the assertion to WHICH glyph is on screen, which is
    // the claim; a snapshot would bind it to lucide's whole icon library.
    const systemMarkup = glyphMarkup()
    expect(/<rect/.test(systemMarkup)).toBe(true)
    expect(/<circle/.test(systemMarkup)).toBe(false)

    await user.click(buttonIn(MESSAGES.system))
    await waitFor(() => buttonIn(MESSAGES.light))
    const lightMarkup = glyphMarkup()
    expect(/<circle/.test(lightMarkup)).toBe(true)
    expect(/<rect/.test(lightMarkup)).toBe(false)

    await user.click(buttonIn(MESSAGES.light))
    await waitFor(() => buttonIn(MESSAGES.dark))
    const darkMarkup = glyphMarkup()
    expect(/<path/.test(darkMarkup)).toBe(true)
    expect(/<circle/.test(darkMarkup)).toBe(false)
    expect(/<rect/.test(darkMarkup)).toBe(false)

    // Three distinct glyphs. A component that ignored the preference and drew
    // one icon always would pass every per-state check above written against a
    // mocked icon map, and fails this one.
    expect(new Set([systemMarkup, lightMarkup, darkMarkup]).size).toBe(3)
  })

  it('is keyboard operable: Tab reaches it, Enter and Space both advance the ring', async () => {
    const user = userEvent.setup()
    renderToggle()
    await waitFor(() => buttonIn(MESSAGES.system))

    await user.tab()
    expect(buttonIn(MESSAGES.system)).toHaveFocus()
    await user.keyboard('{Enter}')
    await waitFor(() => buttonIn(MESSAGES.light))

    // Space is the second half of the <button> activation contract, and it
    // only lands if the focus survived the Enter-activated click.
    await user.keyboard(' ')
    await waitFor(() => buttonIn(MESSAGES.dark))
  })

  it('cross-fades the swap with no OS preference and snaps it when the OS says reduce — live, not by reload', async () => {
    renderToggle()
    await waitFor(() => buttonIn(MESSAGES.system))
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

    // And the next step of the ring still works under reduce: the control
    // degrades, it does not die.
    const user = userEvent.setup()
    await user.click(buttonIn(MESSAGES.system))
    await waitFor(() => expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light'))
  })

  it('renders the More-sheet row: the visible label is the prefix of the accessible name', async () => {
    renderToggle(<ThemeToggle variant="row" />)
    await waitFor(() => buttonIn(MESSAGES.system))
    const row = buttonIn(MESSAGES.system)

    // The row shows the command and the state it is in, next to the glyph.
    expect(row.textContent).toContain('Theme')
    expect(row.textContent).toContain('System')

    // WCAG 2.5.3 (Label in Name). The lookup above IS the assertion that the
    // accessible name is the whole sentence — dom-accessible-name computed it
    // from the control's own markup, so this does not read the attribute back
    // to itself. And the sentence begins with the visible label, so a voice
    // command that speaks the label activates this control.
    expect(/^Theme/.test(MESSAGES.system)).toBe(true)
    expect(row.textContent).toContain(MESSAGES.system.slice(0, 'Theme'.length))
  })
})
