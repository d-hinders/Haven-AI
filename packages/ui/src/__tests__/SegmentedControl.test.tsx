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
  // 44px hit area…"). #4496 inverted the selected-state half: the owner's
  // 2026-10-27 decision replaced the inset brand outline with the outlined,
  // divided mockup look — selected = brand-soft fill + brand ink + semibold,
  // NO outline — so this case now pins the ABSENCE of the outline classes and
  // the weight step that carries selection instead. Every option still carries
  // the vertical 44px hit-area pseudo-element.
  it('marks only the selected option with the brand-soft fill and semibold, and every option has a 44px hit area', () => {
    renderControl()
    const classes = (name: string) => screen.getByRole('radio', { name }).className.split(/\s+/)
    // #4496: no outline on the selected option — the fill, the ink and the
    // weight step carry selection (WCAG 1.4.1), with `aria-checked`.
    for (const name of ['Light', 'Dark', 'System']) {
      expect(classes(name)).not.toContain('outline')
      expect(classes(name)).not.toContain('outline-1')
      expect(classes(name)).not.toContain('-outline-offset-1')
      expect(classes(name)).not.toContain('outline-brand')
    }
    expect(classes('System')).toEqual(
      expect.arrayContaining(['bg-[var(--v2-brand-soft)]', 'text-[var(--v2-brand)]', 'font-semibold']),
    )
    expect(classes('System')).not.toContain('font-medium')
    for (const name of ['Light', 'Dark']) {
      expect(classes(name)).toEqual(expect.arrayContaining(['font-medium', 'text-[var(--v2-ink-2)]']))
      expect(classes(name)).not.toContain('font-semibold')
      expect(classes(name)).not.toContain('bg-[var(--v2-brand-soft)]')
    }
    // The group is the outlined, divided control: no tinted track, no padding,
    // and no `overflow-hidden` (it would clip the options' hit-area overhang).
    const group = screen.getByRole('radiogroup', { name: 'Theme' }).className.split(/\s+/)
    expect(group).toEqual(expect.arrayContaining(['inline-flex', 'rounded-md', 'border']))
    expect(group).toEqual(expect.arrayContaining(['divide-x', 'divide-[var(--v2-border)]']))
    expect(group).not.toContain('bg-[var(--v2-surface)]')
    expect(group).not.toContain('p-1')
    expect(group).not.toContain('overflow-hidden')
    for (const name of ['Light', 'Dark', 'System']) {
      // One focus treatment for every option: an OUTSET ring. `ring-inset`
      // anywhere on an option would leak into the focus ring (#4056 review).
      expect(classes(name)).not.toContain('ring-inset')
      expect(classes(name)).toEqual(expect.arrayContaining(['focus-visible:outline-none', 'focus-visible:ring-2']))
      // #4496: the ring must out-stack the next segment's fill.
      expect(classes(name)).toContain('focus-visible:z-10')
      expect(classes(name)).toEqual(expect.arrayContaining(['relative', 'after:absolute', 'after:h-11']))
      // Vertical only: the options abut, so the target must not grow sideways.
      expect(classes(name)).toContain('after:inset-x-0')
      // #4496: the bold width is reserved by a `::before` (never a text node —
      // `textContent` stays the bare label), and the outer segments are rounded
      // because the group cannot clip.
      expect(classes(name)).toEqual(
        expect.arrayContaining(['before:content-[attr(data-label)]', 'before:font-semibold', 'before:invisible']),
      )
      expect(classes(name)).toEqual(expect.arrayContaining(['first:rounded-l-[5px]', 'last:rounded-r-[5px]']))
    }
  })
})
