/**
 * The `/transactions` ledger row (#4266, epic #4263): merchant-first title,
 * who acted on the subline (plus the account with 2+ accounts), the one
 * badge precedence plus the accounting badge, and one folded row for a move
 * between the user's own accounts (#4265's `ownTransfer`).
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LocaleProvider } from '@/context/LocaleContext'
import TransactionsLedgerRow from '@/components/transactions/TransactionsLedgerRow'
import type { AggregatedTransaction } from '@/types/transactions'

const MAIN = '0x1111111111111111111111111111111111111111'
const RESERVE = '0x2222222222222222222222222222222222222222'
const ALICE = '0x3333333333333333333333333333333333333333'
const STRANGER = '0x4444444444444444444444444444444444444444'

function tx(overrides: Partial<AggregatedTransaction> = {}): AggregatedTransaction {
  return {
    hash: '0xabc',
    type: 'erc20',
    from: MAIN,
    to: ALICE,
    value: '1000000',
    valueFormatted: '1.00',
    asset: 'USDC',
    tokenSymbol: 'USDC',
    decimals: 6,
    direction: 'out',
    timestamp: 1_700_000_000,
    blockNumber: 1,
    isError: false,
    chainId: 8453,
    accountId: 'acc-main',
    accountAddress: MAIN,
    accountName: 'Main',
    convertedAmount: '1.00',
    convertedCurrency: 'USD',
    ...overrides,
  }
}

function renderRow(
  row: AggregatedTransaction,
  { showAccount = false, onOpen = vi.fn() }: { showAccount?: boolean; onOpen?: () => void } = {},
) {
  render(
    <LocaleProvider>
      <TransactionsLedgerRow
        tx={row}
        resolveAddress={(address) => (address.toLowerCase() === ALICE ? 'Alice' : null)}
        accountNamesByAddress={new Map([
          [`${MAIN}:8453`, 'Main'],
          [`${RESERVE}:8453`, 'Reserve'],
        ])}
        showAccount={showAccount}
        onOpen={onOpen}
        insetDivider={false}
      />
    </LocaleProvider>,
  )
  return screen.getByRole('button', { name: /./ })
}

const x402 = tx({
  source: 'x402',
  x402ResourceUrl: 'https://api.vendor.com/search',
  to: STRANGER,
  agentId: 'agent-1',
  agentName: 'Atlas',
  initiatedBy: 'agent',
})
const contactSend = tx({ initiatedBy: 'human' })
const deposit = tx({ direction: 'in', from: STRANGER, to: MAIN })
const sweep = tx({
  direction: 'in',
  activityType: 'delegate_sweep',
  agentName: 'Atlas',
  from: STRANGER,
  to: MAIN,
})
const ownTransfer = tx({
  to: RESERVE,
  initiatedBy: 'human',
  ownTransfer: { toAccountId: 'acc-reserve', toAccountName: 'Reserve', toAccountAddress: RESERVE },
})

describe('TransactionsLedgerRow — titles and sublines', () => {
  it('an x402 payment: the merchant host, by the agent', () => {
    const row = renderRow(x402)
    expect(within(row).getByText('api.vendor.com')).toBeInTheDocument()
    expect(within(row).getByText('Atlas')).toBeInTheDocument()
  })

  it('a contact send: the contact, by You', () => {
    const row = renderRow(contactSend)
    expect(within(row).getByText('Alice')).toBeInTheDocument()
    expect(within(row).getByText('You')).toBeInTheDocument()
  })

  it('a deposit: "Deposit", and no actor', () => {
    const row = renderRow(deposit)
    expect(within(row).getByText('Deposit')).toBeInTheDocument()
    expect(row.textContent).not.toMatch(/You|Unknown/)
  })

  it('a sweep: "Returned from <agent>" with the Recovered badge', () => {
    const row = renderRow(sweep)
    expect(within(row).getByText('Returned from Atlas')).toBeInTheDocument()
    expect(within(row).getByText('Recovered')).toBeInTheDocument()
  })

  it('one account: the subline names no account', () => {
    const row = renderRow(contactSend, { showAccount: false })
    expect(within(row).getByText('You')).toBeInTheDocument()
    expect(row.textContent).not.toContain('Main')
  })

  it('two accounts: the subline adds " · <account>"', () => {
    const row = renderRow(contactSend, { showAccount: true })
    expect(within(row).getByText('You · Main')).toBeInTheDocument()
  })
})

describe('TransactionsLedgerRow — badges', () => {
  it('needs attention, from the machine-payment lifecycle', () => {
    const row = renderRow(tx({ ...x402, paymentFlowStatus: 'needs_attention' }))
    expect(within(row).getByText('Needs attention')).toBeInTheDocument()
  })

  it('confirming, from the machine-payment lifecycle', () => {
    const row = renderRow(tx({ ...x402, paymentFlowStatus: 'confirming_merchant' }))
    expect(within(row).getByText('Confirming')).toBeInTheDocument()
  })

  it('an on-chain failure reads Failed', () => {
    const row = renderRow(tx({ ...contactSend, isError: true }))
    expect(within(row).getByText('Failed')).toBeInTheDocument()
  })

  it('carries the accounting badge beside the status', () => {
    const row = renderRow(
      tx({
        ...x402,
        paymentId: 'pay-1',
        accounting: { status: 'pushed', provider: 'fortnox', externalRef: 'fortnox:supplierinvoice:11', error: null },
      }),
    )
    expect(within(row).getByTestId('accounting-badge')).toHaveTextContent('In Fortnox')
  })
})

describe('TransactionsLedgerRow — a move between your accounts', () => {
  it('one row: the move title, You · Main → Reserve, and an unsigned amount', () => {
    const row = renderRow(ownTransfer, { showAccount: true })
    expect(within(row).getByText('Moved between your accounts')).toBeInTheDocument()
    expect(within(row).getByText('You')).toBeInTheDocument()
    expect(within(row).getByText('Main')).toBeInTheDocument()
    expect(within(row).getByText('Reserve')).toBeInTheDocument()
    const amount = row.querySelector('.v2-tabular')
    expect(amount?.textContent).not.toMatch(/^[-+−]/)
    expect(amount?.textContent).toMatch(/1\.00/)
  })

  it('says "Your accounts", never "You", when no owner send was recorded (#2097)', () => {
    const row = renderRow(tx({ ...ownTransfer, initiatedBy: 'unknown' }))
    expect(within(row).getByText('Your accounts')).toBeInTheDocument()
    expect(within(row).queryByText('You')).toBeNull()
    expect(row.textContent).not.toContain('Unknown')
  })
})

describe('TransactionsLedgerRow — what a row never says', () => {
  const rows: Array<[string, AggregatedTransaction]> = [
    ['x402', x402],
    ['contact send', contactSend],
    ['send to an unknown address', tx({ to: STRANGER, initiatedBy: 'human' })],
    ['deposit', deposit],
    ['sweep', sweep],
    ['failed', tx({ ...x402, isError: true })],
    ['own transfer', ownTransfer],
  ]
  it.each(rows)('%s: no "Agent payment by", no "From … →", no 0x address', (_, row) => {
    const button = renderRow(row, { showAccount: true })
    const text = button.textContent ?? ''
    expect(text).not.toContain('Agent payment by')
    expect(text).not.toMatch(/From .*→/)
    expect(text).not.toMatch(/0x[0-9a-fA-F]{4}/)
  })
})

describe('TransactionsLedgerRow — activation', () => {
  it('click, Enter and Space open the panel; Enter on the accounting link does not', () => {
    const onOpen = vi.fn()
    const row = renderRow(
      tx({
        ...x402,
        paymentId: 'pay-1',
        accounting: { status: 'pushed', provider: 'fortnox', externalRef: 'fortnox:supplierinvoice:11', error: null },
      }),
      { onOpen },
    )
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.keyDown(row, { key: ' ' })
    expect(onOpen).toHaveBeenCalledTimes(3)
    fireEvent.keyDown(within(row).getByRole('link'), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(3)
  })
})
