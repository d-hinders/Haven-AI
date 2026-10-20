import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Tabs, type TabItem } from '../Tabs'

/**
 * The shared Tabs primitive (#4096): a controlled tablist per the WAI-ARIA
 * tabs pattern — selection follows the arrow keys, Tab leaves the list, and
 * the optional count / warning dot adornments render beside the label.
 */

type Tab = 'overview' | 'agents' | 'activity'

const TABS: ReadonlyArray<TabItem<Tab>> = [
  { value: 'overview', label: 'Overview' },
  { value: 'agents', label: 'Agents', count: 3 },
  { value: 'activity', label: 'Activity', warningDot: true },
]

function TabsHarness({
  value: initial,
  onChange,
}: {
  value?: Tab
  onChange?: (value: Tab) => void
}) {
  const [value, setValue] = useState<Tab>(initial ?? 'overview')
  return (
    <div>
      <Tabs
        ariaLabel="Account"
        tabs={TABS}
        value={value}
        onChange={(next) => {
          onChange?.(next)
          setValue(next)
        }}
      />
      <button type="button">After the tablist</button>
    </div>
  )
}

function renderTabs(overrides: Partial<Parameters<typeof Tabs>[0]> = {}) {
  const onChange = vi.fn()
  const utils = render(
    <Tabs ariaLabel="Account" tabs={TABS} value="overview" onChange={onChange} {...overrides} />,
  )
  return { onChange, ...utils }
}

describe('Tabs', () => {
  it('renders a tablist of tabs with aria-selected on the active one', () => {
    renderTabs()
    const list = screen.getByRole('tablist', { name: 'Account' })
    expect(list).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Agents3' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tab', { name: 'ActivityNeeds attention' })).toHaveAttribute('aria-selected', 'false')
  })

  it('is controlled: click reports the new value, the mark moves only when the caller re-renders', async () => {
    const user = userEvent.setup()
    const { onChange, rerender } = renderTabs()
    await user.click(screen.getByRole('tab', { name: 'Agents3' }))
    expect(onChange).toHaveBeenCalledWith('agents')
    // Still on the old value — the primitive owns nothing.
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    rerender(
      <Tabs ariaLabel="Account" tabs={TABS} value="agents" onChange={onChange} />,
    )
    expect(screen.getByRole('tab', { name: 'Agents3' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'false')
  })

  it('moves selection and focus with the arrow keys, wrapping at both ends', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    // A stateful harness: selection follows focus, so each arrow press must
    // land on the value the PREVIOUS press selected.
    render(<TabsHarness onChange={onChange} />)
    await user.tab()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('agents')
    expect(screen.getByRole('tab', { name: 'Agents3' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('activity')
    expect(screen.getByRole('tab', { name: 'ActivityNeeds attention' })).toHaveFocus()
    // Wraps forward to the first tab…
    await user.keyboard('{ArrowRight}')
    expect(onChange).toHaveBeenLastCalledWith('overview')
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus()
    // …and backward to the last.
    await user.keyboard('{ArrowLeft}')
    expect(onChange).toHaveBeenLastCalledWith('activity')
    expect(screen.getByRole('tab', { name: 'ActivityNeeds attention' })).toHaveFocus()
  })

  it('jumps to the first and last tab with Home and End', async () => {
    const user = userEvent.setup()
    const { onChange } = renderTabs({ value: 'agents' })
    await user.tab()
    expect(screen.getByRole('tab', { name: 'Agents3' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(onChange).toHaveBeenLastCalledWith('activity')
    await user.keyboard('{Home}')
    expect(onChange).toHaveBeenLastCalledWith('overview')
  })

  it('leaves the tablist on Tab — only the selected tab is a tab stop', async () => {
    const user = userEvent.setup()
    render(
      <TabsHarness value="overview" />,
    )
    await user.tab()
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus()
    // Tab again: the NEXT element after the list takes focus, not another tab.
    await user.tab()
    expect(screen.getByRole('button', { name: 'After the tablist' })).toHaveFocus()
  })

  it('renders an optional muted count beside the label', () => {
    renderTabs()
    const agents = screen.getByRole('tab', { name: 'Agents3' })
    expect(agents).toHaveTextContent('Agents')
    expect(agents).toHaveTextContent('3')
  })

  it('renders an optional warning dot with an accessible name', () => {
    renderTabs()
    const activity = screen.getByRole('tab', { name: 'ActivityNeeds attention' })
    const dot = activity.querySelector('span[aria-hidden="true"].bg-\\[var\\(--v2-warning\\)\\]')
    expect(dot).not.toBeNull()
    // The dot is decorative to the eye; the warning is named to the ear.
    expect(screen.getByRole('tab', { name: 'ActivityNeeds attention' })).toBeInTheDocument()
  })

  it('keeps every tab a type="button" so it never submits a surrounding form', () => {
    renderTabs()
    for (const name of ['Overview', 'Agents3', 'ActivityNeeds attention']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('type', 'button')
    }
  })
})
