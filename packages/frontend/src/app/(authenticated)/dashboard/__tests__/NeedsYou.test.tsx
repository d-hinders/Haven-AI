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

  // ── #3910: a normal card, like Agents and Activity ──────────────────────

  it('is a flat card with the shared header band — no anchor tint on the body (Needs attention mode)', () => {
    render(
      <NeedsYou items={[SIX_ITEMS[0]]} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} />,
    )
    const card = screen.getByRole('article')
    expect(card.className).toContain('bg-[var(--v2-bg)]')
    // No anchor surface anywhere in the card (it used to tint the body too,
    // so a single row read as a second header).
    expect(card.outerHTML).not.toContain('--v2-surface-anchor')
    const heading = screen.getByRole('heading', { level: 2, name: 'Needs attention' })
    expect(heading).toHaveAttribute('id', 'needs-attention-heading')
    expect(heading).toHaveAttribute('tabindex', '-1')
    // Card.Header's band: the surface tint and the bottom hairline.
    const band = heading.closest('div.border-b') as HTMLElement
    expect(band.className).toContain('bg-[var(--v2-surface)]')
    expect(band.contains(screen.getByText('1', { selector: 'span' }))).toBe(true)
  })

  it('keeps "N of 3 done" and "Hide for now" in the same header band (Get started mode)', () => {
    render(
      <NeedsYou
        items={[]}
        hasOverviewError={false}
        onRetry={() => {}}
        onDismiss={() => {}}
        title="Get started"
        titleMeta={<span>1 of 3 done</span>}
        titleAction={<button type="button">Hide for now</button>}
        guide={<p>steps</p>}
      />,
    )
    const heading = screen.getByRole('heading', { level: 2, name: 'Get started' })
    const band = heading.closest('div.border-b') as HTMLElement
    expect(band.className).toContain('bg-[var(--v2-surface)]')
    expect(band.contains(screen.getByText('1 of 3 done'))).toBe(true)
    expect(band.contains(screen.getByRole('button', { name: 'Hide for now' }))).toBe(true)
  })

  // ── #3902: the title, the count badge and the empty state ────────────────

  it('titles the card "Needs attention", with the count beside the heading, not inside it', () => {
    render(
      <NeedsYou items={[SIX_ITEMS[0]]} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} />,
    )
    // The badge must not change the heading's accessible name.
    const heading = screen.getByRole('heading', { level: 2, name: 'Needs attention' })
    expect(heading).toHaveAttribute('id', 'needs-attention-heading')
    const badge = screen.getByText('1', { selector: 'span' })
    expect(heading.contains(badge)).toBe(false)
    expect(badge).toHaveTextContent('1 item')
  })

  it('counts every item, including those behind "Show N more", and announces "N items"', () => {
    render(
      <NeedsYou items={SIX_ITEMS} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} />,
    )
    // Four rows are visible; the badge counts all six.
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByText('6', { selector: 'span' })).toHaveTextContent('6 items')
    expect(screen.getByRole('heading', { level: 2, name: 'Needs attention' })).toBeInTheDocument()
  })

  it('shows no badge at zero items, while "Get started", or for the load-error row alone', () => {
    const { rerender } = render(
      <NeedsYou items={[]} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} emptyState={{ kind: 'quiet', body: 'No items to review right now.' }} />,
    )
    expect(screen.queryByText(/\bitems?\b/, { selector: 'span.sr-only' })).not.toBeInTheDocument()
    rerender(
      <NeedsYou items={SIX_ITEMS} title="Get started" showCount={false} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} />,
    )
    expect(screen.queryByText(/\bitems?\b/, { selector: 'span.sr-only' })).not.toBeInTheDocument()
    rerender(
      <NeedsYou items={[]} hasOverviewError onRetry={() => {}} onDismiss={() => {}} />,
    )
    expect(screen.getByText('Dashboard data could not load')).toBeInTheDocument()
    expect(screen.queryByText(/\bitems?\b/, { selector: 'span.sr-only' })).not.toBeInTheDocument()
  })

  it('renders the rows full-bleed, with dividers', () => {
    render(
      <NeedsYou items={SIX_ITEMS} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} />,
    )
    const list = screen.getAllByRole('listitem')[0].closest('ul')
    expect(list).toHaveAttribute('data-full-bleed')
    expect(list?.className).toContain('divide-y')
    // The rows take the card's 20px inset (px-5) over Row's own px-4.
    const row = screen.getByText('Scout is waiting to be set up').closest('li')?.firstElementChild
    expect(row?.className).toMatch(/(^|\s)px-5(\s|$)/)
  })

  it('never shows an empty state beside the load-error row', () => {
    render(
      <NeedsYou
        items={[]}
        hasOverviewError
        onRetry={() => {}}
        onDismiss={() => {}}
        emptyState={{ kind: 'caught-up', title: "You're all caught up" }}
      />,
    )
    expect(screen.getByText('Dashboard data could not load')).toBeInTheDocument()
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument()
  })

  it('shows the achievement state only when the rules layer says every fact holds', () => {
    render(
      <NeedsYou
        items={[]}
        hasOverviewError={false}
        onRetry={() => {}}
        onDismiss={() => {}}
        emptyState={{ kind: 'caught-up', title: "You're all caught up" }}
      />,
    )
    // The section header stays above it (owner decision 2026-10-12).
    expect(screen.getByRole('heading', { level: 2, name: 'Needs attention' })).toBeInTheDocument()
    const title = screen.getByRole('heading', { level: 3, name: "You're all caught up" })
    // #3908 (owner, 2026-10-13): the title alone — no reason line beside it.
    expect(title.parentElement?.textContent).toBe("You're all caught up")
  })

  it('shows only the neutral line when a fact is unmeasured, and nothing while budget reads load', () => {
    const { rerender } = render(
      <NeedsYou items={[]} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} emptyState={{ kind: 'quiet', body: 'No items to review right now.' }} />,
    )
    expect(screen.getByText('No items to review right now.')).toBeInTheDocument()
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument()
    rerender(
      <NeedsYou items={[]} hasOverviewError={false} onRetry={() => {}} onDismiss={() => {}} emptyState={{ kind: 'pending' }} />,
    )
    expect(screen.queryByText('No items to review right now.')).not.toBeInTheDocument()
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument()
    // The old sentence claimed what nobody measured; it is gone for good.
    expect(screen.queryByText('Nothing needs your attention right now.')).not.toBeInTheDocument()
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

  // ── #3813: only "No backup signer" and "Needs setup" offer the dismiss ────
  // Owner decisions 2026-10-09: "Low balance", "Budget reached" and
  // "Payments failed" offer NO dismiss — those are states the user resolves,
  // not preferences. The control is asserted ABSENT, not just inert.
  it('offers the dismiss control on the two dismissible kinds', () => {
    render(
      <NeedsYou
        items={[
          item({ id: 'needs-setup:a1', kind: 'needs-setup', tone: 'brand', title: 'Scout has no budget' }),
          item({ id: 'no-backup:acct-1', kind: 'no-backup', title: 'Main has one way to approve payments' }),
        ]}
        hasOverviewError={false}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    )
    expect(screen.getByTestId('attention-dismiss-needs-setup:a1')).toBeInTheDocument()
    expect(screen.getByTestId('attention-dismiss-no-backup:acct-1')).toBeInTheDocument()
  })

  it('offers no dismiss control on low balance, budget reached and payments failed', () => {
    render(
      <NeedsYou
        items={[
          item({ id: 'low-balance:acct-1', kind: 'low-balance', tone: 'warning', badge: 'Low balance', title: "Main's USDC is running low", accountId: 'acct-1' }),
          item({ id: 'budget-reached:a1', kind: 'budget-reached', title: 'Scout reached its budget' }),
          item({ id: 'budget-scope:a1', kind: 'budget-scope', title: 'Scout tried to pay outside its rules' }),
          item({ id: 'zero-usdc:acct-1', kind: 'zero-usdc', tone: 'warning', badge: 'Low balance', title: 'Main is out of USDC', accountId: 'acct-1' }),
          item({ id: 'haven-paused', kind: 'haven-paused', title: 'Haven paused sponsored payments' }),
          item({ id: 'payments-failed:a1', kind: 'payments-failed', tone: 'danger', badge: 'Failed', title: 'Scout had a failed payment' }),
        ]}
        hasOverviewError={false}
        onRetry={() => {}}
        onDismiss={() => {}}
      />,
    )
    for (const id of [
      'low-balance:acct-1',
      'budget-reached:a1',
      'budget-scope:a1',
      'zero-usdc:acct-1',
      'haven-paused',
      'payments-failed:a1',
    ]) {
      expect(screen.queryByTestId(`attention-dismiss-${id}`)).not.toBeInTheDocument()
    }
    expect(document.querySelector('[data-attention-dismiss]')).toBeNull()
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
