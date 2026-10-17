import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SegmentedControl } from '../SegmentedControl'

/**
 * The promoted segmented control (#2927): radio semantics over a mutually
 * exclusive choice, keyboard operability, and the disabled pass-through.
 */

function renderControl(overrides: Partial<Parameters<typeof SegmentedControl>[0]> = {}) {
  const onChange = vi.fn()
  const utils = render(
    <SegmentedControl
      ariaLabel="Theme"
      value="system"
      onChange={onChange}
      options={[
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
        { value: 'system', label: 'System' },
      ]}
      {...overrides}
    />,
  )
  return { onChange, ...utils }
}

describe('SegmentedControl', () => {
  it('renders a radiogroup whose options are radios with aria-checked', () => {
    renderControl()
    const group = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(group).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
  })

  it('activates on click and reports the new value', async () => {
    const user = userEvent.setup()
    const { onChange, rerender } = renderControl()
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(onChange).toHaveBeenCalledWith('dark')
    // Controlled component: the caller re-renders with the new value…
    rerender(
      <SegmentedControl
        ariaLabel="Theme"
        value="dark"
        onChange={onChange}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
          { value: 'system', label: 'System' },
        ]}
      />,
    )
    // …and the active mark moves.
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'false')
  })

  it('is keyboard operable — options are buttons reachable by Tab, activated by Enter and Space', async () => {
    const user = userEvent.setup()
    const { onChange } = renderControl()
    await user.tab()
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenLastCalledWith('light')
    await user.keyboard(' ') // Space activates a <button> too
    expect(onChange).toHaveBeenLastCalledWith('light')
  })

  it('passes disabled through to every option', () => {
    renderControl({ disabled: true })
    for (const name of ['Light', 'Dark', 'System']) {
      expect(screen.getByRole('radio', { name })).toBeDisabled()
    }
  })

  it('marks only the active option and keeps every option a type="button"', () => {
    renderControl({ value: 'dark' })
    const active = screen.getByRole('radio', { name: 'Dark' })
    expect(active).toHaveAttribute('aria-checked', 'true')
    for (const name of ['Light', 'Dark', 'System']) {
      expect(screen.getByRole('radio', { name })).toHaveAttribute('type', 'button')
    }
  })

  // #4056 — className pins (jsdom has no layout; the rendered hit area is
  // asserted in navigation.mobile.spec.ts, "a theme option takes a tap in its
  // 44px hit area…"). The selected option carries a boundary that clears 3:1
  // against the track (the inset brand outline), only the selected one does,
  // and every option carries the vertical 44px hit-area pseudo-element.
  it('marks only the selected option with the brand outline, and every option has a 44px hit area', () => {
    renderControl()
    const classes = (name: string) => screen.getByRole('radio', { name }).className.split(/\s+/)
    expect(classes('System')).toEqual(expect.arrayContaining(['outline-1', '-outline-offset-1', 'outline-brand']))
    expect(classes('Light')).not.toContain('outline-brand')
    expect(classes('Dark')).not.toContain('outline-brand')
    for (const name of ['Light', 'Dark', 'System']) {
      // One focus treatment for every option: an OUTSET ring. `ring-inset`
      // anywhere on an option would leak into the focus ring (#4056 review).
      expect(classes(name)).not.toContain('ring-inset')
      expect(classes(name)).toEqual(expect.arrayContaining(['focus-visible:outline-none', 'focus-visible:ring-2']))
      expect(classes(name)).toEqual(expect.arrayContaining(['relative', 'after:absolute', 'after:h-11']))
      // Vertical only: the options abut, so the target must not grow sideways.
      expect(classes(name)).toContain('after:inset-x-0')
    }
  })
})
