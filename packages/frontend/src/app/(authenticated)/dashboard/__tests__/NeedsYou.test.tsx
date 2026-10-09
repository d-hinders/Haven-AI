import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import NeedsYou from '../NeedsYou'
import type { AttentionRuleItem } from '@/lib/dashboard-attention'

function item(overrides: Partial<AttentionRuleItem>): AttentionRuleItem {
  return {
    id: 'test-item',
    kind: 'budget-reached',
    tone: 'neutral',
    badge: 'Budget reached',
    title: 'Scout reached its budget',
    ...overrides,
  }
}

const SIX_ITEMS: AttentionRuleItem[] = [
  item({ id: 'i1', kind: 'needs-setup', tone: 'brand', title: 'Scout is waiting to be set up' }),
  item({ id: 'i2', kind: 'low-balance', tone: 'warning', badge: 'Low balance', title: "Main's USDC is running low", accountId: 'acct-1' }),
  item({ id: 'i3', kind: 'budget-reached', tone: 'neutral', title: 'Runner reached its budget' }),
  item({ id: 'i4', kind: 'payments-failed', tone: 'danger', badge: 'Failed', title: 'Scout had a failed payment' }),
  item({ id: 'i5', kind: 'no-backup', tone: 'warning', badge: 'Backup', title: 'Ops has one way to approve payments' }),
  item({ id: 'i6', kind: 'no-backup', tone: 'warning', badge: 'Backup', title: 'Main has one way to approve payments' }),
]

describe('NeedsYou', () => {
  it('renders the item titles', () => {
    render(
      <NeedsYou items={SIX_ITEMS} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} />,
    )
    expect(screen.getByText('Scout is waiting to be set up')).toBeInTheDocument()
    expect(screen.getByText('Runner reached its budget')).toBeInTheDocument()
  })

  it('collapses past four items behind a button whose accessible name states the count', () => {
    render(
      <NeedsYou items={SIX_ITEMS} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} />,
    )
    expect(screen.queryByText('Main has one way to approve payments')).not.toBeInTheDocument()
    const showMore = screen.getByRole('button', { name: 'Show 2 more items' })
    expect(showMore).toBeInTheDocument()
  })

  it('reveals the remaining items when "Show N more" is pressed', async () => {
    const user = userEvent.setup()
    render(
      <NeedsYou items={SIX_ITEMS} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} />,
    )
    await user.click(screen.getByRole('button', { name: 'Show 2 more items' }))
    expect(screen.getByText('Main has one way to approve payments')).toBeInTheDocument()
    expect(screen.getByText('Ops has one way to approve payments')).toBeInTheDocument()
  })

  it('shows one quiet line when nothing needs attention', () => {
    render(
      <NeedsYou items={[]} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} />,
    )
    expect(screen.getByText('Nothing needs your attention right now.')).toBeInTheDocument()
  })

  it('keeps the load-error row alongside items from the last good data', () => {
    render(
      <NeedsYou
        items={[item({ title: 'Runner reached its budget' })]}
        hasOverviewError
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByText('Dashboard data could not load')).toBeInTheDocument()
    expect(screen.getByText('Runner reached its budget')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('hands the full rule item back on dismiss', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(
      <NeedsYou
        items={[item({ id: 'no-backup:acct-1', kind: 'no-backup', title: 'Main has one way to approve payments' })]}
        hasOverviewError={false}
        onRetry={() => {}}
        onDismiss={onDismiss}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Dismiss: Main has one way to approve payments' }))
    expect(onDismiss).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'no-backup:acct-1', kind: 'no-backup' }),
    )
  })

  it('routes the Add-funds action through the account callback', async () => {
    const user = userEvent.setup()
    const onAddFunds = vi.fn()
    render(
      <NeedsYou
        items={[
          item({
            id: 'zero-usdc:acct-1',
            kind: 'zero-usdc',
            tone: 'warning',
            badge: 'Low balance',
            title: 'Main is out of USDC',
            actionLabel: 'Add funds',
            accountId: 'acct-1',
          }),
        ]}
        hasOverviewError={false}
        onRetry={() => {}}
        onDismiss={() => {}}
        onAddFunds={onAddFunds}
      />,
    )
    await user.click(screen.getByRole('button', { name: 'Add funds' }))
    expect(onAddFunds).toHaveBeenCalledWith('acct-1')
  })
})
