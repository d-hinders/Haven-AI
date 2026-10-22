import { TransactionMovement } from '@/components/haven'
import type { AmountCurrency } from '@/components/haven/Amount'
import { shouldMarkApprox, type ApproxMarkKind } from '@haven_ai/core'
import type { StatusTone } from '@/components/ui/StatusBadge'
import { isMachinePaymentSource, parseX402Hostname, paymentSourceTitle } from '@/lib/transaction-labels'
import { truncate } from '@/lib/format'
import type { AggregatedTransaction } from '@/types/transactions'
import type { PaymentActivityItem } from '@/hooks/useAgentActivity'

export function isDelegateSweep(tx: Pick<AggregatedTransaction, 'activityType'>): boolean {
  return tx.activityType === 'delegate_sweep'
}

/**
 * The fields `counterpartyLabel` reads. A structural slice of
 * `AggregatedTransaction` so the dashboard can label #3824's activity groups
 * (which carry the counterparty fields of the group's newest member, not a
 * full row) through the same helper the shared screens use.
 */
export type CounterpartyFields = Pick<
  AggregatedTransaction,
  'activityType' | 'agentName' | 'source' | 'x402ResourceUrl' | 'direction' | 'to' | 'from' | 'chainId'
>

export function transactionTitle(tx: AggregatedTransaction): string {
  if (isDelegateSweep(tx)) return 'Agent funds swept back'
  if (tx.direction === 'in') return 'Received payment'

  const sourceTitle = paymentSourceTitle(tx.source)
  if (sourceTitle && tx.agentName) return `${sourceTitle} by ${tx.agentName}`
  if (sourceTitle) return sourceTitle
  if (tx.agentName) return `Agent payment by ${tx.agentName}`
  // "Payment sent by you" is reserved for human-initiated payments; a row
  // with no human marker renders neutral copy — the Initiator field carries
  // the attribution state (#2097).
  if (tx.initiatedBy === 'human') return 'Payment sent by you'
  return 'Payment sent'
}

/**
 * Who initiated the row (#2097). "You" is reserved for human-initiated
 * payments (`initiatedBy === 'human'`, an owner send recorded at submit,
 * #4099); agent rows render the agent identity; inbound rows carry no
 * initiator, bar an agent's delegate sweep; and missing attribution renders
 * as explicit "Unknown" — never "You".
 */
export function transactionInitiator(tx: AggregatedTransaction): string {
  // Delegate sweeps are agent-attributed regardless of direction — they read
  // as inbound rows (funds recovered TO the Haven wallet), so the sweep check
  // must precede the direction check.
  if (isDelegateSweep(tx)) return tx.agentName ?? 'Unknown'
  if (tx.direction === 'in') return ''
  if (tx.initiatedBy === 'human') return 'You'
  return tx.agentName ?? 'Unknown'
}

export function transactionStatus(
  tx: AggregatedTransaction,
): { label: string; tone: StatusTone } | null {
  if (!isDelegateSweep(tx)) return null
  return { label: 'Recovered', tone: 'success' }
}

export function transactionMovement(
  tx: AggregatedTransaction,
  resolveAddress?: (address: string) => string | null,
  accountNamesByAddress?: Map<string, string>,
  options?: { noAddress?: boolean },
) {
  if (isDelegateSweep(tx)) {
    return (
      <TransactionMovement
        from={tx.agentName ?? 'Agent'}
        to={tx.accountName}
      />
    )
  }

  const counterparty = counterpartyLabel(tx, resolveAddress, accountNamesByAddress, options)
  // The movement line prints its own "From", so an own-account sender goes in
  // bare — `counterpartyLabel`'s "From <account>" is the dashboard's title.
  const ownSender =
    options?.noAddress && tx.direction === 'in'
      ? ownAccountSenderName(tx, accountNamesByAddress)
      : null
  const from = tx.direction === 'in' ? (ownSender ?? counterparty) : tx.accountName
  const to = tx.direction === 'in' ? tx.accountName : counterparty

  return <TransactionMovement from={from} to={to} />
}

/**
 * The name of the user's own account an inbound row came from (#4099): the
 * server-resolved name when one rode along, else the chain-keyed own-account
 * map entry for `tx.from`. Own accounts only — a contact never names a
 * deposit. Null for every other deposit.
 */
function ownAccountSenderName(
  tx: Pick<CounterpartyFields, 'from' | 'chainId'>,
  accountNamesByAddress?: Map<string, string>,
  resolvedName?: string | null,
): string | null {
  return (
    resolvedName ||
    accountNamesByAddress?.get(`${tx.from.toLowerCase()}:${tx.chainId}`) ||
    null
  )
}

/**
 * The counterparty half of a movement line. `transactionMovement` renders it
 * inside "From … → To …"; the dashboard (#3810) reads it DIRECTLY as the
 * merchant-first row title.
 *
 * `options.noAddress` is the opt-in dashboard mode: the raw address never
 * surfaces, so every `truncate()` fallback is replaced by calm copy — a sweep
 * reads "Returned from <agent>", an x402 row without a recorded resource URL
 * falls back to its source title ("Agent payment"), an inbound row reads
 * "Deposit" — or "From <account>" when its sender is another of the user's
 * own accounts (the backend's `resolvedName`, else the chain-keyed
 * `accountNamesByAddress` entry, #4099) — and an address
 * nothing resolves (no own-account name, no
 * contact, no pre-resolved counterparty name) reads "New recipient" rather
 * than `0xA873…DD35`. `options.resolvedName` carries a name resolved
 * server-side for the counterparty (the activity groups' `merchantName`,
 * #3824) — the groups expose no chain-scoped address map, so the client
 * cannot re-run the `accountNamesByAddress` lookup itself.
 *
 * The default mode is byte-identical to the pre-#3810 behaviour:
 * `TransactionsTable` and `TransactionDetailPanel` keep rendering truncated
 * addresses until #3811 retires them.
 */
export function counterpartyLabel(
  tx: CounterpartyFields,
  resolveAddress?: (address: string) => string | null,
  accountNamesByAddress?: Map<string, string>,
  options?: { noAddress?: boolean; resolvedName?: string | null },
): string {
  if (options?.noAddress) {
    // Sweeps are agent-attributed inbound rows; the sweep check precedes the
    // direction check for the same reason `transactionInitiator`'s does.
    if (isDelegateSweep(tx)) {
      return `Returned from ${tx.agentName ?? 'agent'}`
    }
    if (isMachinePaymentSource(tx.source)) {
      return (
        parseX402Hostname(tx.x402ResourceUrl) ??
        paymentSourceTitle(tx.source) ??
        'Agent payment'
      )
    }
    // #4099 (owner decision, 2026-10-20): a server-resolved sender name — only
    // a transfer from another of the user's own accounts — reads "From
    // <account>", so the title says the money LEFT that account (a bare name
    // reads as the account that received it). Screens without a server name
    // (the account page, /transactions) look the sender up in the own-account
    // map — chain-keyed only, never a contact. Every other deposit stays
    // "Deposit".
    if (tx.direction === 'in') {
      const sender = ownAccountSenderName(tx, accountNamesByAddress, options.resolvedName)
      return sender ? `From ${sender}` : 'Deposit'
    }

    const address = tx.to
    const addressKey = address.toLowerCase()
    const accountName =
      accountNamesByAddress?.get(`${addressKey}:${tx.chainId}`) ??
      accountNamesByAddress?.get(addressKey)
    return (
      options.resolvedName ??
      accountName ??
      resolveAddress?.(address) ??
      'New recipient'
    )
  }

  if (isMachinePaymentSource(tx.source)) {
    return parseX402Hostname(tx.x402ResourceUrl) ?? truncate(tx.to)
  }

  const address = tx.direction === 'in' ? tx.from : tx.to
  const addressKey = address.toLowerCase()
  const accountName =
    accountNamesByAddress?.get(`${addressKey}:${tx.chainId}`) ??
    accountNamesByAddress?.get(addressKey)
  const contactName = resolveAddress?.(address)

  return accountName ?? contactName ?? truncate(address)
}

/**
 * Display label for the on-chain settlement scheme (epic #1704, #1707).
 * EIP-3009 is the delegate-signed transferWithAuthorization fallback;
 * ERC-7710 is smart-account redemption. Technical-but-calm per
 * `docs/product/copy-guidelines.md`. Null-in, null-out: an x402 row without
 * a recorded scheme renders nothing — never a guessed value. Kept separate
 * from `source` (protocol) and `execution_rail` (account architecture), which
 * are different axes; do not merge them in copy or naming.
 */
export function settlementSchemeLabel(
  scheme: AggregatedTransaction['settlementScheme'],
): 'EIP-3009' | 'ERC-7710' | null {
  if (scheme === 'eip3009') return 'EIP-3009'
  if (scheme === 'erc7710') return 'ERC-7710'
  return null
}

/**
 * Feeds a `PaymentActivityItem` (the agent activity feed, `useAgentActivity`)
 * into the same `counterpartyLabel` the `AggregatedTransaction` rows use —
 * the second row shape the helper serves (#3811). The activity wire is
 * snake_case and narrower than the shared row, so this maps field by field;
 * agent activity rows are always outbound payments, which is the only
 * direction the feed serves.
 */
export function activityCounterparty(item: PaymentActivityItem): CounterpartyFields {
  return {
    activityType: undefined,
    agentName: item.agent_name,
    source: item.source,
    x402ResourceUrl: item.x402_resource_url,
    direction: 'out',
    to: item.to,
    from: item.account_address ?? '',
    chainId: item.chain_id ?? 0,
  }
}

/**
 * The fiat figure a transaction renders in the user's currency (#3805,
 * #3824), as `<Amount>`'s currency mode wants it: book-time `convertedAmount`,
 * or the serve-time `approxAmount` — one or the other, never both on the
 * wire. A row with neither prices to `amount: null`, which `<Amount>` renders
 * as an em dash: an unknown valuation is never 0.
 *
 * `approx` is the "≈" DECISION for where the figure renders (`kind`), taken
 * by the one rule in `@haven_ai/core`'s `shouldMarkApprox` (#4165): never on
 * a list row (#3950), never on a booked figure, never for USDC shown in USD;
 * otherwise on the detail panel. Callers pass it straight to `<Amount>`.
 *
 * The backend strikes both amounts in the user's `currency_preference`, so
 * the currency arrives ON the row; nothing here reads preferences. The
 * `approxCurrency` fallback is the backend's documented default
 * (`DEFAULT_TRANSACTION_CURRENCY`), reached only if a producer ever omits the
 * currency beside a present amount.
 */
export function transactionFiat(
  tx: Pick<AggregatedTransaction, 'convertedAmount' | 'convertedCurrency' | 'approxAmount' | 'approxCurrency'> &
    Partial<Pick<AggregatedTransaction, 'chainId' | 'tokenSymbol' | 'asset'>>,
  kind: ApproxMarkKind,
): { amount: number | null; currency: AmountCurrency; approx: boolean } {
  if (tx.convertedAmount != null && tx.convertedCurrency) {
    return { amount: Number(tx.convertedAmount), currency: tx.convertedCurrency, approx: false }
  }
  const currency = tx.approxCurrency ?? 'SEK'
  const amount = tx.approxAmount != null ? Number(tx.approxAmount) : null
  return {
    amount,
    currency,
    approx:
      amount != null &&
      shouldMarkApprox({
        repriced: true,
        chainId: tx.chainId,
        tokenSymbol: tx.tokenSymbol ?? tx.asset,
        displayCurrency: currency,
        kind,
      }),
  }
}
