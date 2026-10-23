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

describe('TransactionActivityRow same-day divider (#4165)', () => {
  it('draws no divider by default', () => {
    const { container } = renderRow()
    expect(container.querySelector('[data-inset-divider]')).toBeNull()
  })

  it('draws the inset hairline in --v2-border-subtle, starting at the text column', () => {
    const { container } = renderRow({ insetDivider: true, density: 'compact' })
    const row = container.querySelector('[data-inset-divider]')!
    expect(row.className).toContain('before:bg-[var(--v2-border-subtle)]')
    // Compact: 16/20px padding + the 32px mark + the 12px gap.
    expect(row.className).toContain('before:left-[60px]')
    expect(row.className).toContain('sm:before:left-[64px]')
  })

  it('insets past the larger mark at comfortable density', () => {
    const { container } = renderRow({ insetDivider: true })
    const row = container.querySelector('[data-inset-divider]')!
    // Comfortable: 16/20px padding + the 36px mark + the 12px gap.
    expect(row.className).toContain('before:left-[64px]')
    expect(row.className).toContain('sm:before:left-[68px]')
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

  // #4225: the day band is the design system's second sanctioned band —
  // pinned to the table-header tokens, with a full-width hairline below.
  it('renders the tinted band on the table-header tokens with a hairline below', () => {
    const { container } = render(<TransactionActivityDayHeader label="Today" />)
    const band = screen.getByText('Today')
    expect(band.className).toContain('bg-[var(--v2-table-header-bg)]')
    expect(band.className).toContain('text-[var(--v2-table-header-ink)]')
    expect(band.className).toContain('border-b')
    expect(band.className).toContain('border-[var(--v2-border)]')
  })

  // Uppercase comes from CSS (text-transform), never from the DOM text —
  // so "Today" stays matchable by text.
  it('uppercases the label by CSS, not by mutating the text', () => {
    render(<TransactionActivityDayHeader label="Today" />)
    const band = screen.getByText('Today')
    expect(band.className).toContain('uppercase')
    expect(band.textContent).toBe('Today')
  })

  it('keeps the plain label when band={false} — the dashboard first day', () => {
    render(<TransactionActivityDayHeader label="Today" band={false} />)
    const band = screen.getByText('Today')
    expect(band.className).not.toContain('bg-[var(--v2-table-header-bg)]')
    expect(band.className).toContain('text-[var(--v2-ink-3)]')
  })
})

describe('TransactionActivityRow move direction (#4264)', () => {
  it('renders the two-way mark and an UNSIGNED amount, like neutral', () => {
    const { container } = renderRow({
      direction: 'move',
      fiat: { amount: 12, currency: 'SEK' },
    })
    expect(container.querySelector('svg.lucide-arrow-left-right')).not.toBeNull()
    expect(container.querySelector('span.v2-tabular')!.textContent).not.toMatch(/^[-+\u2212]/)
  })

  it('out still signs the amount — the unsigned path is move/neutral only', () => {
    const { container } = renderRow({
      direction: 'out',
      fiat: { amount: 12, currency: 'SEK' },
    })
    expect(container.querySelector('span.v2-tabular')!.textContent).toMatch(/^[-+\u2212]/)
  })
})
