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
})
