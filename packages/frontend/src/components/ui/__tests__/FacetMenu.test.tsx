import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FacetMenu, type ListFacet } from '../FacetMenu'
import { menuShift } from '../list-menu'
import { PeriodPicker } from '../PeriodPicker'
import type { PeriodValue } from '../list-url-codec'

const DIRECTION: ListFacet = {
  id: 'direction',
  label: 'Direction',
  options: [
    { value: 'in', label: 'Incoming' },
    { value: 'out', label: 'Outgoing' },
  ],
}

const STATUS: ListFacet = {
  id: 'status',
  label: 'Status',
  selection: 'multi',
  options: [
    { value: 'active', label: 'Active', count: 6 },
    { value: 'paused', label: 'Paused', count: 0 },
    { value: 'revoked', label: 'Revoked', count: 19 },
  ],
}

function Controlled({ facet, initial = [] as string[] }: { facet: ListFacet; initial?: string[] }) {
  const [value, setValue] = useState<string[]>(initial)
  return <FacetMenu facet={facet} value={value} onChange={setValue} />
}

describe('FacetMenu — single-select', () => {
  it('is a menu button whose radio rows put All first; choosing one applies, closes and returns focus', async () => {
    const user = userEvent.setup()
    render(<Controlled facet={DIRECTION} />)
    const trigger = screen.getByRole('button', { name: 'Direction: All', expanded: false })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')

    await user.click(trigger)
    expect(screen.getByRole('button', { name: 'Direction: All', expanded: true })).toBeInTheDocument()
    const menu = screen.getByRole('menu', { name: 'Direction: All' })
    expect(menu).toBeInTheDocument()
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.map((r) => r.textContent)).toEqual(['All', 'Incoming', 'Outgoing'])
    expect(screen.getByRole('menuitemradio', { name: 'All', checked: true })).toHaveFocus()
    expect(screen.getByRole('menuitemradio', { name: 'Incoming', checked: false })).toBeInTheDocument()

    await user.click(screen.getByRole('menuitemradio', { name: 'Outgoing' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const after = screen.getByRole('button', { name: 'Direction: Outgoing', expanded: false })
    expect(after).toHaveFocus()
  })

  it('opens on Arrow Down at the checked row, moves with the arrows and wraps, closes on Escape to the trigger', async () => {
    const user = userEvent.setup()
    render(<Controlled facet={DIRECTION} initial={['in']} />)
    const trigger = screen.getByRole('button', { name: 'Direction: Incoming' })
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: 'Incoming', checked: true })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: 'Outgoing' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemradio', { name: 'All' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitemradio', { name: 'Outgoing' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('menuitemradio', { name: 'All' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.getByRole('menuitemradio', { name: 'Outgoing' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens on Arrow Up at the last row, and on Enter and Space', async () => {
    const user = userEvent.setup()
    render(<Controlled facet={DIRECTION} />)
    const trigger = screen.getByRole('button', { name: 'Direction: All' })
    trigger.focus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('menuitemradio', { name: 'Outgoing' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.keyboard(' ')
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('closes on a click outside, without moving focus to the trigger', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <Controlled facet={DIRECTION} />
        <button type="button">Elsewhere</button>
      </div>,
    )
    await user.click(screen.getByRole('button', { name: 'Direction: All' }))
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus()
  })

  it('is hidden when the facet has one possible value', () => {
    const { container } = render(
      <FacetMenu facet={{ ...DIRECTION, options: [DIRECTION.options[0]] }} value={[]} onChange={() => {}} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('FacetMenu — a long selected name (#4401)', () => {
  it('bounds the trigger from `sm` so the name truncates, and keeps the full name in its accessible name', () => {
    const long = 'Quarterly procurement research agent for the Nordic region'
    render(
      <FacetMenu
        facet={{ id: 'agent', label: 'Agent', options: [{ value: 'a', label: long }, { value: 'b', label: 'Other' }] }}
        value={['a']}
        onChange={() => {}}
      />,
    )
    const trigger = screen.getByRole('button', { name: `Agent: ${long}` })
    const root = trigger.parentElement as HTMLElement
    const classes = root.className.split(/\s+/)
    // Below `sm` the row is full width and `max-w-full` truncates; from `sm`
    // the actions row is max-content, so only a fixed bound can.
    expect(classes).toContain('max-w-full')
    expect(classes).toContain('sm:max-w-[20rem]')
    const summary = screen.getByText(long, { selector: 'button span' })
    expect(summary.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))
    expect(summary).toHaveAttribute('title', long)
  })
})

describe('FacetMenu — no All row (allLabel: null, #4113)', () => {
  const ARCHIVED: ListFacet = {
    id: 'archived',
    label: 'Archived',
    allLabel: null,
    defaultValue: ['hidden'],
    options: [
      { value: 'hidden', label: 'Hidden' },
      { value: 'shown', label: 'Shown' },
    ],
  }

  it('lists only the options, tints away from the default, and keeps the keyboard contract', async () => {
    const user = userEvent.setup()
    render(<Controlled facet={ARCHIVED} initial={['hidden']} />)
    const trigger = screen.getByRole('button', { name: 'Archived: Hidden' })
    expect(trigger).toHaveAttribute('data-active', 'false')
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['Hidden', 'Shown'])
    expect(screen.getByRole('menuitemradio', { name: 'Hidden', checked: true })).toHaveFocus()
    await user.keyboard('{ArrowDown}{Enter}')
    const after = screen.getByRole('button', { name: 'Archived: Shown' })
    expect(after).toHaveAttribute('data-active', 'true')
    expect(after).toHaveFocus()
  })

  it('as pills there is no All pill, and the selected pill does not deselect to nothing', async () => {
    const user = userEvent.setup()
    render(<Controlled facet={{ ...ARCHIVED, rendering: 'pills' }} initial={['hidden']} />)
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Hidden', 'Shown'])
    await user.click(screen.getByRole('button', { name: 'Hidden', pressed: true }))
    expect(screen.getByRole('button', { name: 'Hidden', pressed: true })).toBeInTheDocument()
  })
})

describe('FacetMenu — multi-select', () => {
  it('uses checkbox rows with counts, stays open while ticking, and summarises the trigger', async () => {
    const user = userEvent.setup()
    render(<Controlled facet={STATUS} />)
    await user.click(screen.getByRole('button', { name: 'Status: All' }))
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
    const active = screen.getByRole('menuitemcheckbox', { name: /Active/, checked: false })
    expect(active).toHaveTextContent('6')

    await user.click(active)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitemcheckbox', { name: /Active/, checked: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Status: Active', expanded: true })).toBeInTheDocument()

    await user.click(screen.getByRole('menuitemcheckbox', { name: /Paused/ }))
    expect(screen.getByRole('button', { name: 'Status: Active, Paused' })).toBeInTheDocument()
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Revoked/ }))
    expect(screen.getByRole('button', { name: 'Status: 3 selected' })).toBeInTheDocument()

    await user.click(screen.getByRole('menuitemcheckbox', { name: /Active/, checked: true }))
    expect(screen.getByRole('button', { name: 'Status: Paused, Revoked' })).toBeInTheDocument()
  })
})

describe('FacetMenu — pills', () => {
  it('renders toggle buttons with aria-pressed, All first, and no menu roles', async () => {
    const user = userEvent.setup()
    const category: ListFacet = {
      id: 'category',
      label: 'Category',
      rendering: 'pills',
      options: [
        { value: 'ai', label: 'AI' },
        { value: 'data', label: 'Data' },
      ],
    }
    render(<Controlled facet={category} />)
    const group = screen.getByRole('group', { name: 'Category' })
    expect(group).toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All', pressed: true })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Data', pressed: false }))
    expect(screen.getByRole('button', { name: 'Data', pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All', pressed: false })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Data' }))
    expect(screen.getByRole('button', { name: 'All', pressed: true })).toBeInTheDocument()
  })
})

describe('menu viewport clamp', () => {
  it('shifts a panel back inside a 375px viewport from either edge', () => {
    expect(menuShift({ left: 200, right: 420 }, 375)).toBe(375 - 8 - 420)
    expect(menuShift({ left: -40, right: 180 }, 375)).toBe(48)
    expect(menuShift({ left: 16, right: 236 }, 375)).toBe(0)
    // Wider than the viewport: the left edge wins, the CSS max-width caps the rest.
    expect(menuShift({ left: 100, right: 500 }, 375)).toBe(-92)
  })

  it('applies the shift when the opened panel would overhang the right edge', async () => {
    const user = userEvent.setup()
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isMenu = this.getAttribute('role') === 'menu'
      return { left: isMenu ? 250 : 0, right: isMenu ? 470 : 0, top: 0, bottom: 0, width: 220, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 375 })
    render(<Controlled facet={DIRECTION} />)
    await user.click(screen.getByRole('button', { name: 'Direction: All' }))
    expect(screen.getByRole('menu').style.transform).toBe('translateX(-103px)')
    spy.mockRestore()
  })
})

describe('PeriodPicker', () => {
  function Period(props: { initial?: PeriodValue; allowAllTime?: boolean; allowCustom?: boolean; onChange?: (v: PeriodValue) => void }) {
    const [value, setValue] = useState<PeriodValue>(props.initial ?? {})
    return (
      <PeriodPicker
        value={value}
        onChange={(v) => {
          setValue(v)
          props.onChange?.(v)
        }}
        allowAllTime={props.allowAllTime}
        allowCustom={props.allowCustom}
      />
    )
  }

  it('offers All time and the three rolling presets as radio rows', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Period onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Period: All time', expanded: false }))
    expect(screen.getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual([
      'All time',
      'Last 7 days',
      'Last 30 days',
      'Last 90 days',
    ])
    expect(screen.getByRole('menuitemradio', { name: 'All time', checked: true })).toHaveFocus()
    await user.click(screen.getByRole('menuitemradio', { name: 'Last 30 days' }))
    expect(onChange).toHaveBeenLastCalledWith({ preset: '30d' })
    expect(screen.getByRole('button', { name: 'Period: Last 30 days' })).toHaveFocus()
  })

  it('presets only, for Analytics: no All time, no Custom range', async () => {
    const user = userEvent.setup()
    render(<Period initial={{ preset: '30d' }} allowAllTime={false} />)
    await user.click(screen.getByRole('button', { name: 'Period: Last 30 days' }))
    expect(screen.getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['Last 7 days', 'Last 30 days', 'Last 90 days'])
  })

  it('without All time, the default does not tint; a change does', () => {
    render(<PeriodPicker value={{ preset: '30d' }} onChange={() => {}} allowAllTime={false} defaultValue={{ preset: '30d' }} />)
    expect(screen.getByRole('button', { name: 'Period: Last 30 days' })).toHaveAttribute('data-active', 'false')
    render(<PeriodPicker value={{ preset: '7d' }} onChange={() => {}} allowAllTime={false} defaultValue={{ preset: '30d' }} />)
    expect(screen.getByRole('button', { name: 'Period: Last 7 days' })).toHaveAttribute('data-active', 'true')
  })

  it('re-clamps the panel when the wider custom-range form replaces the list (#4110 review)', async () => {
    const user = userEvent.setup()
    // The list view fits (8..216); the form, growing left from the same right
    // edge, would start at -66 in a 375px viewport.
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isPanel = this.id.endsWith('-menu')
      const custom = isPanel && this.querySelector('form') !== null
      const left = !isPanel ? 0 : custom ? -66 : 8
      return { left, right: isPanel ? 216 : 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 375 })
    render(<Period allowCustom />)
    await user.click(screen.getByRole('button', { name: 'Period: All time' }))
    expect(screen.getByRole('menu').style.transform).toBe('')
    await user.click(screen.getByRole('menuitemradio', { name: 'Custom range' }))
    expect(screen.getByRole('group', { name: 'Custom range' }).style.transform).toBe('translateX(74px)')
    spy.mockRestore()
  })

  it('a custom range applies only once both dates are valid', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Period allowCustom onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Period: All time' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Custom range' }))
    expect(screen.getByRole('group', { name: 'Custom range' })).toBeInTheDocument()
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeDisabled()
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-20' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-09-01' } })
    expect(apply).toBeDisabled()
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-25' } })
    await user.click(apply)
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-20', to: '2026-10-25' })
    expect(screen.getByRole('button', { name: 'Period: 2026-10-20 to 2026-10-25' })).toBeInTheDocument()
  })
})
