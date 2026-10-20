import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useMemo, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ListFacet } from '../FacetMenu'
import { ListNoMatch, ListToolbar, type ListToolbarProps } from '../ListToolbar'
import type { ListCount } from '../list-controls-copy'
import type { ListState } from '../list-url-codec'

const noun = { one: 'agent', other: 'agents' }

const FACETS: ListFacet[] = [
  {
    id: 'status',
    label: 'Status',
    selection: 'multi',
    options: [
      { value: 'active', label: 'Active', count: 2 },
      { value: 'paused', label: 'Paused', count: 1 },
    ],
  },
  {
    id: 'direction',
    label: 'Direction',
    options: [
      { value: 'in', label: 'Incoming' },
      { value: 'out', label: 'Outgoing' },
    ],
  },
  // One possible value: hidden, but its chip still shows when it is set.
  { id: 'account', label: 'Account', options: [{ value: 'acc-1', label: 'My account' }] },
]

const SORT = { options: [{ value: 'name', label: 'Name' }, { value: 'seen', label: 'Recently seen' }] }

const EMPTY: ListState = { q: '', facets: { status: [], direction: [], account: [] }, sort: 'name', period: {} }

const ROWS = [
  { name: 'Atlas', status: 'active' },
  { name: 'Agent naming', status: 'active' },
  { name: 'Lovable Dev', status: 'paused' },
]

/**
 * A browser-filtered harness: rows are filtered in memory from the state, so
 * the count is the applied result, exactly as a page would wire it.
 */
function BrowserList(props: { initial?: ListState; onChange?: (s: ListState) => void; extra?: Partial<ListToolbarProps> }) {
  const [state, setState] = useState<ListState>(props.initial ?? EMPTY)
  const rows = useMemo(
    () =>
      ROWS.filter(
        (r) =>
          r.name.toLowerCase().includes(state.q.toLowerCase()) &&
          (state.facets.status.length === 0 || state.facets.status.includes(r.status)),
      ),
    [state],
  )
  return (
    <>
      <ListToolbar
        noun={noun}
        state={state}
        onChange={(next) => {
          setState(next)
          props.onChange?.(next)
        }}
        filtering="browser"
        facets={FACETS}
        sort={SORT}
        period={{ allowCustom: true }}
        count={{ shown: rows.length, total: ROWS.length }}
        {...props.extra}
      />
      <ul aria-label="rows">
        {rows.map((r) => (
          <li key={r.name}>{r.name}</li>
        ))}
      </ul>
    </>
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ListToolbar — search', () => {
  it('browser-filtered: the rows update on every keystroke', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<BrowserList onChange={onChange} />)
    const field = screen.getByRole('searchbox', { name: 'Search agents' })
    await user.type(field, 'at')
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(within(screen.getByRole('list', { name: 'rows' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Atlas'])
    await user.type(field, 'x')
    expect(within(screen.getByRole('list', { name: 'rows' })).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('server-filtered: one commit per 300 ms pause, Enter commits at once, Escape clears', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<ListToolbar noun={noun} state={EMPTY} onChange={onChange} filtering="server" count={{ shown: 3, total: 3 }} />)
    const field = screen.getByRole('searchbox', { name: 'Search agents' })

    for (const value of ['s', 'sa', 'sav', 'savi']) fireEvent.change(field, { target: { value } })
    act(() => vi.advanceTimersByTime(299))
    expect(onChange).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY, q: 'savi' })

    fireEvent.change(field, { target: { value: 'savings' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY, q: 'savings' })
    act(() => vi.advanceTimersByTime(1000))
    expect(onChange).toHaveBeenCalledTimes(2)

    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY, q: '' })
    expect(field).toHaveValue('')
  })

  it('an external change (a removed chip) resets the field and cancels a pending commit', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    const { rerender } = render(
      <ListToolbar noun={noun} state={{ ...EMPTY, q: 'old' }} onChange={onChange} filtering="server" count={{ shown: 1, total: 3 }} />,
    )
    const field = screen.getByRole('searchbox', { name: 'Search agents' })
    fireEvent.change(field, { target: { value: 'olde' } })
    rerender(<ListToolbar noun={noun} state={EMPTY} onChange={onChange} filtering="server" count={{ shown: 3, total: 3 }} />)
    act(() => vi.advanceTimersByTime(1000))
    expect(onChange).not.toHaveBeenCalled()
    expect(field).toHaveValue('')
  })

  it('a pending search commit does not undo a facet change made before it fires (#4110 review)', () => {
    vi.useFakeTimers()
    function Server() {
      const [state, setState] = useState<ListState>({ ...EMPTY, facets: { ...EMPTY.facets, status: ['active'] } })
      return (
        <>
          <ListToolbar noun={noun} state={state} onChange={setState} filtering="server" facets={FACETS} count={{ shown: 1, total: 3 }} />
          <output data-testid="state">{JSON.stringify(state)}</output>
        </>
      )
    }
    render(<Server />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), { target: { value: 'foo' } })
    act(() => vi.advanceTimersByTime(100))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Status: Active' }))
    act(() => vi.advanceTimersByTime(300))
    const state = JSON.parse(screen.getByTestId('state').textContent!) as ListState
    expect(state.q).toBe('foo')
    expect(state.facets.status).toEqual([])
  })

  it('Clear filters cancels a pending search commit even when q was empty (#4110 review)', () => {
    vi.useFakeTimers()
    function Server() {
      const [state, setState] = useState<ListState>({ ...EMPTY, facets: { ...EMPTY.facets, status: ['active'] } })
      return (
        <>
          <ListToolbar noun={noun} state={state} onChange={setState} filtering="server" facets={FACETS} count={{ shown: 1, total: 3 }} />
          <output data-testid="state">{JSON.stringify(state)}</output>
        </>
      )
    }
    render(<Server />)
    const field = screen.getByRole('searchbox', { name: 'Search agents' })
    fireEvent.change(field, { target: { value: 'f' } })
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    act(() => vi.advanceTimersByTime(1000))
    const state = JSON.parse(screen.getByTestId('state').textContent!) as ListState
    expect(state.q).toBe('')
    expect(state.facets.status).toEqual([])
    expect(field).toHaveValue('')
  })

  it('carries the search description for screen readers', () => {
    render(<ListToolbar noun={noun} state={EMPTY} onChange={() => {}} filtering="browser" count={null} searchDescription="By name or address" />)
    expect(screen.getByRole('searchbox', { name: 'Search agents' })).toHaveAccessibleDescription('By name or address')
  })
})

describe('ListToolbar — facets, chips and count', () => {
  it('renders every menu trigger with its state, hides the one-option facet, and puts Sort and Period on the row', () => {
    render(<BrowserList />)
    expect(screen.getByRole('button', { name: 'Status: All', expanded: false })).toHaveAttribute('aria-haspopup', 'menu')
    expect(screen.getByRole('button', { name: 'Direction: All', expanded: false })).toHaveAttribute('aria-haspopup', 'menu')
    expect(screen.getByRole('button', { name: 'Sort: Name', expanded: false })).toHaveAttribute('aria-haspopup', 'menu')
    expect(screen.getByRole('button', { name: 'Period: All time', expanded: false })).toHaveAttribute('aria-haspopup', 'menu')
    expect(screen.queryByRole('button', { name: /^Account:/ })).not.toBeInTheDocument()
  })

  it('the Sort menu has no All row, and choosing keeps the filters', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<BrowserList onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Sort: Name' }))
    expect(screen.getAllByRole('menuitemradio').map((r) => r.textContent)).toEqual(['Name', 'Recently seen'])
    await user.click(screen.getByRole('menuitemradio', { name: 'Recently seen' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY, sort: 'seen' })
    // Sort is a view choice: no chip, the count stays unfiltered.
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
  })

  it('unfiltered: no chips, no Clear filters, the count reads "{n} {things}"', () => {
    render(<BrowserList />)
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('3 agents')
  })

  it('filtered: a removable chip per filter, Clear filters, and "{shown} of {total}"', async () => {
    const user = userEvent.setup()
    render(
      <BrowserList
        initial={{ ...EMPTY, q: 'a', facets: { status: ['active'], direction: [], account: ['acc-1'] }, period: { preset: '30d' } }}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('2 of 3 agents')
    expect(screen.getByRole('button', { name: 'Remove “a”' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Status: Active' })).toBeInTheDocument()
    // The hidden one-option facet still gets its chip: it is the only way out.
    expect(screen.getByRole('button', { name: 'Remove Account: My account' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Period: Last 30 days' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove Status: Active' }))
    expect(screen.queryByRole('button', { name: 'Remove Status: Active' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('3 agents')
    expect(screen.getByRole('searchbox', { name: 'Search agents' })).toHaveValue('')
  })

  it('the count announces politely, says "Showing the first N" when capped, and is a placeholder while loading', () => {
    const capped: ListCount = { shown: 500, total: 500, cappedAt: 500 }
    const { rerender } = render(<ListToolbar noun={noun} state={EMPTY} onChange={() => {}} filtering="server" count={capped} />)
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('Showing the first 500 agents')
    rerender(<ListToolbar noun={noun} state={EMPTY} onChange={() => {}} filtering="server" count={null} />)
    expect(screen.getByLabelText('Loading agents')).toBeInTheDocument()
  })

  it('renders the actions slot', () => {
    render(<BrowserList extra={{ actions: <button type="button">Export CSV</button> }} />)
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument()
  })
})

describe('ListToolbar — page defaults', () => {
  // Marketplace-shaped: the network facet defaults to the user's chain.
  const NETWORK: ListFacet = {
    id: 'chainId',
    label: 'Network',
    defaultValue: ['8453'],
    options: [
      { value: '8453', label: 'Base' },
      { value: '84532', label: 'Base Sepolia' },
    ],
  }
  const CATEGORY: ListFacet = {
    id: 'category',
    label: 'Category',
    rendering: 'pills',
    options: [
      { value: 'ai', label: 'AI' },
      { value: 'data', label: 'Data' },
    ],
  }

  function Market() {
    const [state, setState] = useState<ListState>({ q: '', facets: { chainId: ['8453'], category: [] }, period: { preset: '30d' } })
    return (
      <ListToolbar
        noun={noun}
        state={state}
        onChange={setState}
        filtering="browser"
        facets={[NETWORK, CATEGORY]}
        period={{ defaultValue: { preset: '30d' } }}
        count={{ shown: 3, total: 3 }}
      />
    )
  }

  it('at the page default nothing is active: no tint, no chip, an unfiltered count', () => {
    render(<Market />)
    expect(screen.getByRole('button', { name: 'Network: Base' })).toHaveAttribute('data-active', 'false')
    expect(screen.getByRole('button', { name: 'Period: Last 30 days' })).toHaveAttribute('data-active', 'false')
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('3 agents')
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
  })

  it('All on a non-All default is a filter; its chip and Clear filters return to the default', async () => {
    const user = userEvent.setup()
    render(<Market />)
    await user.click(screen.getByRole('button', { name: 'Network: Base' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'All' }))
    expect(screen.getByRole('button', { name: 'Network: All' })).toHaveAttribute('data-active', 'true')
    await user.click(screen.getByRole('button', { name: 'Remove Network: All' }))
    expect(screen.getByRole('button', { name: 'Network: Base' })).toHaveAttribute('data-active', 'false')

    await user.click(screen.getByRole('button', { name: 'Period: Last 30 days' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Last 7 days' }))
    await user.click(screen.getByRole('button', { name: 'Network: Base' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Base Sepolia' }))
    expect(screen.getByRole('button', { name: 'Filters (2)' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByRole('button', { name: 'Network: Base' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Period: Last 30 days' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
  })

  it('a pill facet gets a chip but does not count on "Filters (n)" — it is not in the sheet', async () => {
    const user = userEvent.setup()
    render(<Market />)
    await user.click(screen.getByRole('button', { name: 'Data', pressed: false }))
    expect(screen.getByRole('button', { name: 'Remove Category: Data' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument()
  })
})

describe('ListToolbar — phone sheet', () => {
  it('"Filters (n)" opens a dialog whose taps apply live; the footer names the applied count and only closes', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<BrowserList onChange={onChange} />)
    const filters = screen.getByRole('button', { name: 'Filters', expanded: false })
    expect(filters).toHaveAttribute('aria-haspopup', 'dialog')
    await user.click(filters)

    const sheet = screen.getByRole('dialog', { name: 'Filters' })
    expect(screen.getByRole('button', { name: 'Filters', expanded: true })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Show 3 agents' })).toBeInTheDocument()

    const paused = within(sheet).getByRole('checkbox', { name: /Paused/, checked: false })
    await user.click(paused)
    // Applied at once — not on confirm — and the footer is the applied result.
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY, facets: { ...EMPTY.facets, status: ['paused'] } })
    expect(within(sheet).getByRole('checkbox', { name: /Paused/, checked: true })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Show 1 agent' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 of 3 agents')

    await user.click(within(sheet).getByRole('radio', { name: 'Outgoing', checked: false }))
    expect(within(sheet).getByRole('radio', { name: 'Outgoing', checked: true })).toBeInTheDocument()
    await user.click(within(sheet).getByRole('radio', { name: 'Recently seen' }))
    await user.click(within(sheet).getByRole('radio', { name: 'Last 7 days' }))
    expect(within(sheet).getByRole('radio', { name: 'Last 7 days', checked: true })).toBeInTheDocument()

    const calls = onChange.mock.calls.length
    await user.click(within(sheet).getByRole('button', { name: 'Show 1 agent' }))
    expect(onChange).toHaveBeenCalledTimes(calls) // the footer applies nothing
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Filters (3)', expanded: false })).toBeInTheDocument()
  })

  it('Escape closes the sheet and Clear filters inside it clears live', async () => {
    const user = userEvent.setup()
    render(<BrowserList initial={{ ...EMPTY, facets: { ...EMPTY.facets, status: ['active'] } }} />)
    await user.click(screen.getByRole('button', { name: 'Filters (1)' }))
    const sheet = screen.getByRole('dialog', { name: 'Filters' })
    await user.click(within(sheet).getByRole('button', { name: 'Clear filters' }))
    expect(within(sheet).getByRole('checkbox', { name: /Active/, checked: false })).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Show 3 agents' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('a custom range in the sheet applies on "Apply range"', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<BrowserList onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: 'Filters' }))
    const sheet = screen.getByRole('dialog', { name: 'Filters' })
    await user.click(within(sheet).getByRole('radio', { name: 'Custom range' }))
    fireEvent.change(within(sheet).getByLabelText('From'), { target: { value: '2026-09-01' } })
    fireEvent.change(within(sheet).getByLabelText('To'), { target: { value: '2026-09-30' } })
    await user.click(within(sheet).getByRole('button', { name: 'Apply range' }))
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY, period: { from: '2026-09-01', to: '2026-09-30' } })
  })
})

describe('ListNoMatch', () => {
  it('names the things and offers Clear filters', async () => {
    const user = userEvent.setup()
    const onClear = vi.fn()
    render(<ListNoMatch noun={noun} onClear={onClear} />)
    expect(screen.getByText('No agents match these filters')).toBeInTheDocument()
    expect(screen.getByText('Try a different search, or clear filters to see everything.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
