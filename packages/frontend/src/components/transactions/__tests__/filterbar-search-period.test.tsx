/**
 * FilterBar's #4095 additions: the search field, the Period chip (presets
 * and a custom range), Export CSV living in the bar, and the prop that
 * hides the Account chip on surfaces where the page fixes the account (the
 * account Activity tab, #4093).
 *
 * Controlled through a small harness for the assertions that need the
 * parent's state to echo back (a cleared chip must reset the search field
 * and cancel a pending debounce), and through direct render + onChange spy
 * for the commit-shape assertions.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import FilterBar from '@/components/transactions/FilterBar'
import type { TransactionFilterState } from '@/types/transactions'

const BASE_PROPS = {
  accounts: [] as never[],
  agents: [] as never[],
  tokens: [] as never[],
  loading: false,
  error: null as string | null,
}

function searchInput(): HTMLElement {
  return screen.getByLabelText('Search transactions')
}

/** A parent that actually holds the filter state, like the page does. */
function FilterBarHarness({
  initial,
  ...props
}: { initial: TransactionFilterState } & Record<string, unknown>) {
  const [filters, setFilters] = useState<TransactionFilterState>(initial)
  return (
    <FilterBar
      filters={filters}
      onChange={setFilters}
      accounts={[]}
      agents={[]}
      tokens={[]}
      loading={false}
      error={null}
      {...props}
    />
  )
}

describe('FilterBar search field (#4095)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the search input with its icon and placeholder', () => {
    render(<FilterBar {...BASE_PROPS} filters={{}} onChange={vi.fn()} />)

    const input = searchInput()
    expect(input).toBeInTheDocument()
    expect(input).toHaveAttribute('placeholder', 'Search transactions')
  })

  it('commits debounced — one onChange per pause, not one per keystroke', async () => {
    const onChange = vi.fn()
    render(<FilterBar {...BASE_PROPS} filters={{}} onChange={onChange} />)

    fireEvent.change(searchInput(), { target: { value: 's' } })
    fireEvent.change(searchInput(), { target: { value: 'sa' } })
    fireEvent.change(searchInput(), { target: { value: 'sav' } })
    expect(onChange).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ search: 'sav' })
  })

  it('commits immediately on Enter', () => {
    const onChange = vi.fn()
    render(<FilterBar {...BASE_PROPS} filters={{}} onChange={onChange} />)

    fireEvent.change(searchInput(), { target: { value: 'cafe' } })
    fireEvent.keyDown(searchInput(), { key: 'Enter' })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith({ search: 'cafe' })
  })

  it('an emptied field removes the filter instead of pinning a blank term', async () => {
    const onChange = vi.fn()
    render(
      <FilterBar {...BASE_PROPS} filters={{ search: 'old' }} onChange={onChange} />,
    )

    fireEvent.change(searchInput(), { target: { value: '' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(onChange).toHaveBeenCalledWith({ search: undefined })
  })

  it('lists the search as a removable chip beside the others', () => {
    render(
      <FilterBar
        {...BASE_PROPS}
        filters={{ search: 'cafe', direction: 'out' }}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: /Search: cafe/ })).toBeInTheDocument()
    // An active dimension appears twice: the trigger that sets it and the
    // chip that removes it.
    expect(screen.getAllByRole('button', { name: /Direction: Outgoing/ })).toHaveLength(2)
  })

  it('a cleared chip resets the field and cancels a pending debounce', async () => {
    // The stale-debounce hazard this pins: type a new term (timer pending),
    // then clear via the chip — the external reset must cancel the timer, or
    // it would fire afterwards and re-add the term the user just removed.
    render(<FilterBarHarness initial={{ search: 'old' }} />)

    fireEvent.change(searchInput(), { target: { value: 'new' } })

    fireEvent.click(screen.getByRole('button', { name: /Search: old/ }))

    expect(searchInput()).toHaveValue('')
    expect(screen.queryByRole('button', { name: /Search: / })).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    // The cancelled debounce did not resurrect the term.
    expect(searchInput()).toHaveValue('')
    expect(screen.queryByRole('button', { name: /Search: / })).toBeNull()
  })
})

describe('FilterBar Period chip (#4095)', () => {
  it('offers the five options: All time, three rolling presets, Custom range', () => {
    render(<FilterBarHarness initial={{}} />)

    fireEvent.click(screen.getByRole('button', { name: /Period: All time/ }))

    expect(screen.getByRole('button', { name: 'All time' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Last 7 days' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Last 90 days' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Custom range' })).toBeInTheDocument()
  })

  it('a preset lands as a removable chip and clears back to All time', () => {
    render(<FilterBarHarness initial={{}} />)

    fireEvent.click(screen.getByRole('button', { name: /Period: All time/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }))

    // Active preset: the trigger names it and so does the removable chip.
    const labelled = screen.getAllByRole('button', { name: /Period: Last 7 days/ })
    expect(labelled).toHaveLength(2)

    // The CHIP (the second match) removes the filter.
    fireEvent.click(labelled[1])
    expect(screen.getByRole('button', { name: /Period: All time/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Period: Last 7 days/ })).toBeNull()
  })

  it('a custom range applies two calendar dates, refused while reversed', () => {
    const onChange = vi.fn()
    render(<FilterBar {...BASE_PROPS} filters={{}} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: /Period: All time/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Custom range' }))

    const from = screen.getByLabelText('Period start date')
    const to = screen.getByLabelText('Period end date')
    const apply = screen.getByRole('button', { name: 'Apply' })

    // Reversed range: refused here, before the server can 400 it.
    fireEvent.change(from, { target: { value: '2026-05-09' } })
    fireEvent.change(to, { target: { value: '2026-05-08' } })
    expect(apply).toBeDisabled()

    fireEvent.change(from, { target: { value: '2026-05-08' } })
    fireEvent.change(to, { target: { value: '2026-05-09' } })
    expect(apply).toBeEnabled()
    fireEvent.click(apply)

    expect(onChange).toHaveBeenCalledWith({
      from: '2026-05-08',
      to: '2026-05-09',
    })
  })

  it('a custom range replaces a preset, and its chip names both dates', () => {
    render(<FilterBarHarness initial={{}} />)

    fireEvent.click(screen.getByRole('button', { name: /Period: All time/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }))
    expect(
      screen.getAllByRole('button', { name: /Period: Last 30 days/ }),
    ).toHaveLength(2)

    // Remove the preset via its chip (second match), then set a custom range.
    fireEvent.click(screen.getAllByRole('button', { name: /Period: Last 30 days/ })[1])
    fireEvent.click(screen.getByRole('button', { name: /Period: All time/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Custom range' }))
    fireEvent.change(screen.getByLabelText('Period start date'), {
      target: { value: '2026-05-08' },
    })
    fireEvent.change(screen.getByLabelText('Period end date'), {
      target: { value: '2026-05-09' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    // Trigger and chip both name the custom range.
    expect(
      screen.getAllByRole('button', { name: /Period: 2026-05-08 to 2026-05-09/ }),
    ).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /Period: Last 30 days/ })).toBeNull()
  })
})

describe('FilterBar Export CSV in the bar + hidden Account chip (#4095)', () => {
  it('renders Export CSV inside the bar when the page hands it an export handler', () => {
    render(
      <FilterBar
        {...BASE_PROPS}
        filters={{}}
        onChange={vi.fn()}
        onExport={vi.fn()}
        canExport
      />,
    )

    const exportButton = screen.getByRole('button', { name: /export csv/i })
    expect(exportButton).toBeEnabled()
  })

  it('calls the page export handler, gated by canExport and busy while exporting', () => {
    const onExport = vi.fn()
    const { rerender } = render(
      <FilterBar
        {...BASE_PROPS}
        filters={{}}
        onChange={vi.fn()}
        onExport={onExport}
        canExport={false}
      />,
    )

    expect(screen.getByRole('button', { name: /export csv/i })).toBeDisabled()

    rerender(
      <FilterBar
        {...BASE_PROPS}
        filters={{}}
        onChange={vi.fn()}
        onExport={onExport}
        canExport
        exporting
      />,
    )
    const busy = screen.getByRole('button', { name: /preparing/i })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')

    rerender(
      <FilterBar
        {...BASE_PROPS}
        filters={{}}
        onChange={vi.fn()}
        onExport={onExport}
        canExport
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }))
    expect(onExport).toHaveBeenCalledTimes(1)
  })

  it('renders no export button on surfaces that pass none', () => {
    render(<FilterBar {...BASE_PROPS} filters={{}} onChange={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /export csv/i })).toBeNull()
  })

  it('hides the Account chip and trigger when the page fixes the account', () => {
    render(
      <FilterBar
        {...BASE_PROPS}
        filters={{ accountId: 'acc-1' }}
        onChange={vi.fn()}
        hideAccountChip
      />,
    )

    expect(screen.queryByRole('button', { name: /Account:/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Account: / })).toBeNull()
  })

  it('still shows the Account chip by default — the Transactions page keeps it', () => {
    render(
      <FilterBar
        {...BASE_PROPS}
        accounts={[
          { id: 'acc-1', name: 'Main', chainId: 8453, address: '0xabc' } as never,
        ]}
        filters={{ accountId: 'acc-1' }}
        onChange={vi.fn()}
      />,
    )

    // Trigger and removable chip both carry the label — two matches, not one.
    const accountControls = screen.getAllByRole('button', { name: /Account: Main/ })
    expect(accountControls).toHaveLength(2)
  })
})
