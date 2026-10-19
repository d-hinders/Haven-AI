import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  TransactionActivityDayHeader,
  TransactionActivityRow,
  transactionDayGroups,
  transactionDayKey,
  transactionDayLabel,
} from '../TransactionActivityRow'

/**
 * Ledger mode (#4096, epic #4093): the row opens the detail panel from a
 * click or Enter/Space, and the day-group helpers bucket a feed into
 * Today/Yesterday/date headers without merging anything.
 */

function renderRow(overrides: Partial<Parameters<typeof TransactionActivityRow>[0]> = {}) {
  return render(
    <TransactionActivityRow
      title="api.vendor.com"
      description="Research assistant"
      value="12.00"
      asset="USDC"
      timestamp="2m ago"
      {...overrides}
    />,
  )
}

describe('TransactionActivityRow ledger mode', () => {
  it('is inert by default — no button role, no tab stop', () => {
    renderRow()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('opens the detail panel on click when onOpen is provided', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    renderRow({ onOpen })
    const row = screen.getByRole('button', { name: /api\.vendor\.com/ })
    await user.click(row)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('opens on Enter and Space, per the button role', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    renderRow({ onOpen })
    await user.tab()
    expect(screen.getByRole('button', { name: /api\.vendor\.com/ })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledTimes(1)
    await user.keyboard(' ')
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('announces that it opens a dialog', () => {
    renderRow({ onOpen: () => {} })
    expect(screen.getByRole('button', { name: /api\.vendor\.com/ })).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    )
  })
})

describe('transactionDayGroups', () => {
  const today = new Date()
  const iso = (date: Date) => date.toISOString()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const lastWeek = new Date(today)
  lastWeek.setDate(today.getDate() - 7)

  it('buckets by local day without merging — one entry per item survives', () => {
    const items = [
      { id: 1, at: iso(today) },
      { id: 2, at: iso(today) },
      { id: 3, at: iso(yesterday) },
    ]
    const groups = transactionDayGroups(items, (item) => item.at)
    expect(groups.flatMap((group) => group.items.map((item) => item.id))).toEqual([1, 2, 3])
    expect(groups.map((group) => group.label)).toEqual(['Today', 'Yesterday'])
  })

  it('keeps the caller order — newest day first when the feed is newest-first', () => {
    const items = [
      { id: 1, at: iso(today) },
      { id: 2, at: iso(lastWeek) },
      { id: 3, at: iso(yesterday) },
      { id: 4, at: iso(lastWeek) },
    ]
    const groups = transactionDayGroups(items, (item) => item.at)
    expect(groups.map((group) => group.dayKey)).toEqual([
      transactionDayKey(iso(today)),
      transactionDayKey(iso(lastWeek)),
      transactionDayKey(iso(yesterday)),
    ])
  })
})

describe('transactionDayLabel', () => {
  it('names today, yesterday, and older days by short date', () => {
    const format = (date: Date) => transactionDayKey(date.toISOString())
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(today.getDate() - 1)
    const lastWeek = new Date(today)
    lastWeek.setDate(today.getDate() - 7)
    expect(transactionDayLabel(format(today))).toBe('Today')
    expect(transactionDayLabel(format(yesterday))).toBe('Yesterday')
    expect(transactionDayLabel(format(lastWeek))).toMatch(/^\d{1,2} \w+$/)
  })
})

describe('TransactionActivityDayHeader', () => {
  it('renders the label, and "(partial)" only when the day is cut', () => {
    const { rerender } = render(<TransactionActivityDayHeader label="Today" />)
    expect(screen.getByText('Today')).toBeInTheDocument()
    rerender(<TransactionActivityDayHeader label="Today" partial />)
    expect(screen.getByText('Today (partial)')).toBeInTheDocument()
  })
})
