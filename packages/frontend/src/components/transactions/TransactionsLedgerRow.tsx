import { AccountingBadge } from '@/components/accounting/AccountingBadge'
import { TransactionActivityRow, TransactionMovement } from '@/components/haven'
import { timeAgo } from '@/lib/format'
import {
  counterpartyLabel,
  transactionFiat,
  transactionInitiator,
  transactionRowBadge,
} from '@/lib/transaction-presentation'
import type { AggregatedTransaction } from '@/types/transactions'

/** The name an account carries on a row; the backend's own fallback (#4265). */
function accountLabel(name: string | null | undefined): string {
  return name?.trim() || 'Unnamed account'
}

/**
 * One row of the all-accounts ledger (#4266) — #4096's ledger mode, the
 * anatomy the account and agent Activity tabs share: the title is WHO WAS
 * PAID (or who paid), by `counterpartyLabel`'s no-address rules, so a raw
 * address never surfaces; the subline says who acted (`transactionInitiator`:
 * the agent, or "You"), plus the account when the user has two or more —
 * with one, naming it would repeat the page on every row. Badges come from
 * the one precedence (`transactionRowBadge`) and the accounting feed's
 * per-payment badge (#2870).
 *
 * A move between the user's own accounts arrives folded into one row
 * (`ownTransfer`, #4265): it reads "Moved between your accounts" with the
 * neutral two-way mark and an unsigned amount — it is neither money in nor
 * money out. Its actor is "You" only for an owner send Haven recorded;
 * otherwise "Your accounts", which names the wallet set without claiming a
 * human initiator (#2097).
 */
export default function TransactionsLedgerRow({
  tx,
  resolveAddress,
  accountNamesByAddress,
  showAccount,
  onOpen,
  insetDivider,
}: {
  tx: AggregatedTransaction
  resolveAddress: (address: string) => string | null
  accountNamesByAddress: Map<string, string>
  /** Two or more accounts: the subline names the row's account. */
  showAccount: boolean
  onOpen: () => void
  /** #4165: the same-day inset hairline, on every row after a day's first. */
  insetDivider: boolean
}) {
  const badge = transactionRowBadge(tx)
  const fiat = transactionFiat(tx, 'row')
  const shared = {
    value: tx.valueFormatted,
    asset: tx.tokenSymbol,
    failed: tx.isError,
    status: badge?.label,
    statusTone: badge?.tone,
    // The pill alone (#4266): the row is a whole-row button, and a link
    // inside it is invalid ARIA; the panel's Accounting row links to /accounting.
    extraBadges: <AccountingBadge accounting={tx.accounting} interactive={false} />,
    timestamp: timeAgo(tx.timestamp * 1000),
    fiat,
    density: 'compact' as const,
    onOpen,
    insetDivider,
  }

  if (tx.ownTransfer) {
    return (
      <TransactionActivityRow
        {...shared}
        title="Moved between your accounts"
        direction="move"
        description={
          // One line, like every compact subline: the actor stays whole
          // and the bare movement's names shrink to an ellipsis, so the
          // destination is never clipped mid-word and the line never wraps
          // past the 72px row (#4266 reviews). The 4px gap sets the dot as
          // the text " · " sets it on every other subline.
          <span className="flex min-w-0 max-w-full items-center gap-x-1">
            <span className="shrink-0">{tx.initiatedBy === 'human' ? 'You' : 'Your accounts'} ·{' '}</span>
            <TransactionMovement
              bare
              from={accountLabel(tx.accountName)}
              to={accountLabel(tx.ownTransfer.toAccountName)}
            />
          </span>
        }
      />
    )
  }

  const subline = [transactionInitiator(tx), showAccount ? accountLabel(tx.accountName) : '']
    .filter(Boolean)
    .join(' · ')
  return (
    <TransactionActivityRow
      {...shared}
      title={counterpartyLabel(tx, resolveAddress, accountNamesByAddress, { noAddress: true })}
      description={subline || undefined}
      direction={tx.direction}
    />
  )
}
