'use client'

/**
 * The account detail page (#4097, epic #4093): the FULL RECORD of one Haven
 * account — header, one summary card (Balance / Holdings / Last 30 days),
 * and one tab row (Activity · Agents · Security & details). The dashboard
 * stays the inbox and the summary; this page repeats none of it.
 *
 * ## What lives where (owner decisions, 2026-10-19 mockup review)
 *
 * - **Header.** The "Test network" and "Default account" badges sit in
 *   `PageHeader`'s `meta` line, not in `actions` — testnets only, and the
 *   default badge only with two or more accounts. Send is primary once the
 *   account holds money; an empty account makes Receive primary and Send
 *   disabled.
 * - **Summary card.** Three columns in one card, stacking on a phone:
 *   Balance (one figure), Holdings (a header row — "Holdings" left, a small
 *   "Amount" label right — with each token's mark and symbol on the left and
 *   its amount right-aligned at MOST 4 decimals, rounded down by string
 *   truncation, the served amount in the figure's tooltip (#4197); one token
 *   shows no value, a non-USD display currency shows the rate, two or more
 *   show values — `lib/account-holdings.ts` owns those rules), and Last 30
 *   days (ONE row under the title (#4197): an inline in-arrow and the Money-in
 *   figure, then an out-arrow and the Money-out figure — each figure named by
 *   sr-only text and its arrow's tooltip — `hooks/useAccountMoneyFlow.ts`).
 *   The right-aligned amounts are mockup v9 (#4166); the one-row direction
 *   figures replace #4166's label row so the columns end at about the same
 *   height.
 * - **Agents tab.** Every active agent drawn with #4096's shared `AgentRow`
 *   from the same dashboard overview the dashboard reads (filtered by
 *   `accountId`), plus one budget-snapshot summary line
 *   (`lib/agent-spend-summary.ts`). Revoked agents are not listed; one line
 *   says how many are hidden and links to the Agents page's revoked facet.
 * - **Security & details tab.** The ONLY place in the app that can add or
 *   remove a signer or run recovery: `AccountSignersCard` renders here
 *   (Settings' `SignersSection` lists signers without add/remove flows).
 *   With one signer the tab carries the warning dot and the card its
 *   warning; Account details (address, network, created date) sit below.
 *
 * ## Removed with this slice (#4097)
 *
 * - The #3333 "Receiving USDC" off-ramp panel and the receive-ledger hook
 *   behind it — cash-out returns later as a saved destination inside Send,
 *   when a merchant partner needs it.
 * - The "Agent access" card (superseded by the Agents tab), the "Token
 *   balances" table (superseded by Holdings), "Advanced account details"
 *   (superseded by Account details in the Security tab), and the 10-row
 *   `TransactionsTable` preview (the Activity tab renders the feed through
 *   the shared `TransactionActivityRow` instead; #4098 owns that tab).
 *
 * ## Tab ownership
 *
 * The page owns `?tab=` (`activity` default, `agents`, `security`); an
 * unknown value falls back to Activity. `Tabs` itself is URL-blind (#4096),
 * so the mapping and the URL write live here.
 */

import { EllipsisVertical, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useRef, useState, type FormEvent } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth, type SmartAccount } from '@/context/AuthContext'
import { useBalances } from '@/hooks/useBalances'
import { usePortfolio } from '@/hooks/usePortfolio'
import { usePreferences } from '@/hooks/usePreferences'
import { useContacts } from '@/hooks/useContacts'
import { useAgents } from '@/hooks/useAgents'
import { useAccounts } from '@/hooks/useAccounts'
import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { useBudgetRemaining } from '@/hooks/useBudgetRemaining'
import { useAttentionDismissals } from '@/hooks/useAttentionDismissals'
import { useAccountSigners } from '@/hooks/useAccountSigners'
import { useAccountMoneyFlow } from '@/hooks/useAccountMoneyFlow'
import { UNPRICED_TOTALS_NOTE } from '@/lib/money-flow-tally'
import { ApiRequestError } from '@/lib/api'
import AccountActivityTab from './AccountActivityTab'
import DelegationSendModal from '@/components/DelegationSendModal'
import AccountSignersCard from '@/components/AccountSignersCard'
import ReceiveDialog from '@/components/ReceiveDialog'
import ConfirmDialog from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { CopyButton } from '@/components/ui/CopyButton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { PageHeader } from '@/components/ui/PageHeader'
import { Tabs } from '@/components/ui/Tabs'
import { BackLink } from '@haven_ai/ui/BackLink'
import { EmptyState } from '@/components/ui/EmptyState'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Skeleton } from '@/components/ui/Skeleton'
import { Tooltip } from '@/components/ui/Tooltip'
import { useToast } from '@/components/ui/Toast'
import {
  AgentRow,
  Amount,
  BalanceFreshnessIndicator,
  DirectionMark,
  ExternalDetailsLink,
} from '@/components/haven'
import { getExplorerUrlOrNull, resolveChainOrNull, DEFAULT_CHAIN_ID } from '@/lib/chains'
// #3127 (finding 6): the shared formatter — this page's inline copy was the
// third drift site that let /accounts render `kr13,000.50` while this page
// rendered `13 000,50 kr` for the same figure.
import { formatFiat, formatLongDate, truncate, timeAgo } from '@/lib/format'
import { isTestnetChain } from '@/lib/marketplace'
import { holdingDisplayAmount, holdingRows, holdingRateLine } from '@/lib/account-holdings'
import { agentSpendSummaryLine } from '@/lib/agent-spend-summary'
import { computeAttentionItems } from '@/lib/dashboard-attention'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'

/** The page's tabs; `activity` is the default and the unknown-value fallback. */
type AccountTab = 'activity' | 'agents' | 'security'

function accountTabFromUrl(raw: string | null): AccountTab {
  return raw === 'agents' || raw === 'security' ? raw : 'activity'
}

export default function AccountDetailClient() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const accountId = params.accountId as string
  const activeTab = accountTabFromUrl(searchParams.get('tab'))

  const { user, loading: authLoading, passkeys = [] } = useAuth()
  const { renameAccount, removeAccount, setDefault, loading: accountsLoading } = useAccounts()
  const { toast } = useToast()
  const { currency } = usePreferences()
  const { resolveAddress } = useContacts()
  const { agents } = useAgents()
  const { data: overview, loading: overviewLoading, error: overviewError, refetch: refetchOverview } =
    useDashboardOverview()
  const { data: budgetRemaining, loading: budgetRemainingLoading } = useBudgetRemaining()
  const { dismissedIds: serverDismissedIds } = useAttentionDismissals({ accounts: overview?.accounts })

  // Find this account from user's list
  const account = user?.accounts?.find((s) => s.id === accountId)
  const accountAddress = account?.account_address ?? null
  const chainId = account?.chain_id ?? DEFAULT_CHAIN_ID
  const accountExplorerHref = accountAddress ? getExplorerUrlOrNull(chainId, 'address', accountAddress) : null

  const accountNamesByAddress = new Map<string, string>()
  for (const acct of user?.accounts ?? []) {
    accountNamesByAddress.set(
      `${acct.account_address.toLowerCase()}:${acct.chain_id}`,
      acct.name,
    )
  }

  // ── Security tab dot (#4097): the SAME read the card's warning uses ──────
  // The dashboard's "No backup signer" attention item is funded/mainnet-gated
  // by the server (#1205), but the tab dot must fire for ANY account with one
  // signer — an unfunded single-signer account still shows the card's warning
  // above its list, and the dot follows the warning, not the nag rule. This
  // is a second read of the same endpoint the card makes below; the signers
  // read is small and the alternative (prop-drilling the card's state out of
  // its own hook) would restructure a flow this slice must not touch.
  const { signers: accountSigners, loadError: signersLoadError } = useAccountSigners(
    accountAddress ?? '',
    chainId,
    user?.email ?? '',
  )
  const signerCount = accountSigners
    ? accountSigners.passkeys.length + (accountSigners.owner_address ? 1 : 0)
    : null
  const onlyOneWayToApprove = signerCount !== null && signerCount < 2 && !signersLoadError

  // ── The Agents tab's data (#4096 rule: the dashboard overview is the one
  // source — it lists every non-revoked agent with its live budgets, so the
  // tab filters it by account; the revoked count comes from `useAgents`,
  // the one list that still carries revoked rows).
  const accountAgents = (overview?.agents ?? []).filter((agent) => agent.accountId === accountId)
  const revokedOnAccount = agents.filter(
    (agent) => agent.account_id === accountId && agent.status === 'revoked',
  )
  const hiddenRevokedCount = revokedOnAccount.length
  const multiAccount = (user?.accounts?.length ?? 0) > 1
  const revokedAgentsHref = multiAccount
    ? `/agents?status=revoked&account=${encodeURIComponent(accountId)}`
    : '/agents?status=revoked'

  const accountNames = Object.fromEntries((user?.accounts ?? []).map((acct) => [acct.id, acct.name]))
  // #3871: rows render only once the badge inputs have settled — `null`
  // budget reads with the load still running is the pending state; a
  // definitively failed first load renders the rows without the ≥90% badge,
  // exactly as the dashboard's `budgetRemainingReady` treats it.
  const agentsListPending =
    accountAgents.length > 0 && budgetRemaining === null && budgetRemainingLoading
  const attentionItems =
    overview && !overviewLoading
      ? computeAttentionItems({
          overview,
          budgetRemaining: budgetRemaining ?? null,
          accountNames,
          dismissedIds: new Set(serverDismissedIds),
        })
      : []

  // ── Balance / Holdings (#4097) ────────────────────────────────────────────
  const {
    totalUsd,
    totalEur,
    totalSek,
    breakdown,
    loading: portfolioLoading,
    error: portfolioError,
    refetch: refetchPortfolio,
  } = usePortfolio(accountAddress, { chainId })

  const {
    error: balancesError,
    refetch: refetchBalances,
  } = useBalances(accountAddress, { chainId })

  // SEK (#3127): the portfolio hook now exposes the wire's `totalSek`, so the
  // headline reads the SEK figures the endpoint prices — never a USD value
  // relabelled "kr".
  const totalFiat = currency === 'EUR' ? totalEur : currency === 'SEK' ? totalSek : totalUsd
  const formattedTotal = formatFiat(totalFiat, currency)
  const balanceUnavailable = Boolean(portfolioError || balancesError)
  // #3295: a token whose balance read failed renders its last-known value
  // with the stale indicator beside it — the headline carries the same
  // marker when any token under it is degraded.
  const degradedFreshness = breakdown.find((item) => item.balanceFreshness)?.balanceFreshness
  const holdings = holdingRows(breakdown, currency)
  // #4097: "holds money" is the Holdings signal — any token with a non-zero
  // raw balance (a held but unpriced token counts; unpriced is not
  // worthless). While the read is in flight or unavailable the buttons keep
  // today's behaviour (Send primary) rather than flipping mid-load.
  const holdingsKnown = !portfolioLoading && !balanceUnavailable
  const accountHoldsMoney = !holdingsKnown || holdings.length > 0

  // ── Last 30 days (#4097) ─────────────────────────────────────────────────
  const moneyFlow = useAccountMoneyFlow(accountId, currency)

  // ── The Activity tab's feed (#4098): the tab owns its own ledger, so the
  // page carries only a refresh beat — bumped after a send or receive so the
  // tab's feed and totals re-read instead of waiting for the next poll.
  const [ledgerRefreshKey, setLedgerRefreshKey] = useState(0)
  const [renameOpen, setRenameOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<{ message: string; retryable: boolean } | null>(
    null,
  )
  const [sendOpen, setSendOpen] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)

  const handleSendSuccess = () => {
    refetchBalances()
    refetchPortfolio()
    setLedgerRefreshKey((key) => key + 1)
    // The send's own row enters the rolling 30-day window the moment it
    // confirms, so the Money out figure refreshes with the same beat.
    void moneyFlow.refresh()
  }

  const handleTabChange = (tab: AccountTab) => {
    if (tab === activeTab) return
    // `activity` is the default and carries no parameter — the URL stays
    // shareable and the default tab is the canonical address.
    router.replace(
      tab === 'activity'
        ? `/accounts/${encodeURIComponent(accountId)}`
        : `/accounts/${encodeURIComponent(accountId)}?tab=${tab}`,
      { scroll: false },
    )
  }

  const handleRename = async (name: string) => {
    if (!account) return
    await renameAccount(account.id, name)
    setRenameOpen(false)
  }

  // The unlink is REFUSED, not merely failed, while an agent on this account
  // still holds spending authority or a recovery is mid-flight — the backend
  // answers 409 and keeps the account intact. Without a catch the rejection
  // became an unhandled promise rejection: the button stopped spinning and
  // nothing else happened, so the refusal read as a broken button.
  //
  // Deliberately NOT `err.message`, matching `RemoveAgentDialog`: `api.ts`
  // throws the backend's raw error string, and this is a destructive-flow
  // dialog. The 409's three causes share one remedy the user can act on, so
  // the copy names that instead of restating the server's sentence.
  //
  // Two words in it are load-bearing, both from the design review:
  //  - "a budget", not "an active budget" — `HAS_LIVE_DELEGATIONS_FOR_ACCOUNT_SQL`
  //    matches `stillEnabledDelegationSql()` (pending/active/replaced; TS
  //    mirror `STILL_ENABLED_DELEGATION_STATUSES`), so a
  //    grant that was never activated, or one replaced but not yet disabled,
  //    blocks the unlink too.
  //  - "recovering funds", not "a recovery" — this page's Security &
  //    details tab hosts signer replacement (`AccountSignersCard`), which
  //    has nothing to do with the sweep this refusal means. The phrasing
  //    follows the sweep screen's own vocabulary instead.
  const handleRemoveConfirmed = async () => {
    if (!account) return
    setRemoving(true)
    setRemoveError(null)
    try {
      await removeAccount(account.id)
      router.push('/accounts')
    } catch (err) {
      setRemoveError(
        err instanceof ApiRequestError && err.status === 409
          ? {
              message:
                'An agent on this account still has a budget, or is part-way through recovering funds or replacing its signing key. Finish or stop that from the Agents page, then remove the account.',
              // The remedy is OUTSIDE this dialog and `Modal`'s backdrop blocks
              // the page behind it, so pressing the primary action again can
              // only reproduce the identical refusal. `RemoveAgentDialog` draws
              // the same line: its `filing_failed` (retryable here) relabels to
              // "Finish removal", while `too_many` (go act elsewhere) keeps the
              // original label rather than inviting a useless second press.
              retryable: false,
            }
          : {
              message: 'The account could not be removed. Check your connection and try again.',
              retryable: true,
            },
      )
    } finally {
      setRemoving(false)
    }
  }

  const closeRemoveDialog = () => {
    setRemoveOpen(false)
    setRemoveError(null)
  }

  // While auth context is still hydrating `user.accounts`, avoid flashing
  // "Account not found" — the account lookup will resolve once accounts load.
  if (authLoading || !user) {
    return (
      <div className="max-w-5xl">
        {/* The way back exists in every state of the page (#4028). */}
        <BackLink href="/accounts" label="Accounts" />
        <div role="status" aria-busy="true" aria-label="Loading account" className="py-16 flex items-center justify-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--v2-brand)] animate-pulse" />
          <span className="text-xs text-[var(--v2-ink-3)]">Loading account...</span>
        </div>
      </div>
    )
  }

  if (!account) {
    return (
      <div className="max-w-5xl">
        <BackLink href="/accounts" label="Accounts" />
        <div className="py-16 text-center">
          <p className="text-sm text-[var(--v2-ink-3)]">Account not found</p>
        </div>
      </div>
    )
  }

  const tabItems: Array<{ value: AccountTab; label: string; count?: number; warningDot?: boolean }> = [
    { value: 'activity', label: 'Activity' },
    // Only the Agents tab carries a count (owner decision). A zero count is
    // carried too: the count is the tab's own number, not an alert.
    { value: 'agents', label: 'Agents', count: accountAgents.length },
    {
      value: 'security',
      label: 'Security & details',
      // The dot fires for any one-signer account (see the hook read above) —
      // the same condition the card's in-tab warning reads.
      warningDot: onlyOneWayToApprove,
    },
  ]

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        back={{ href: '/accounts', label: 'Accounts' }}
        title={account.name}
        meta={
          <>
            {/* #4097: the badges moved out of `actions` into the meta line —
                they describe the account, they are not actions. The default
                badge needs a second account to mean anything (#4021), and
                the network marker stays testnets-only (epic #3801: no
                network marker on Base). */}
            {account.is_default && multiAccount ? (
              <StatusBadge tone="brand">Default account</StatusBadge>
            ) : null}
            {isTestnetChain(chainId) ? <StatusBadge>Test network</StatusBadge> : null}
          </>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {accountAddress && (
              <>
                {/* #1083 gave Send to BOTH rails. #1989 (epic #1440) took it
                    back off the legacy Safe rail: that path signed a Safe
                    transaction through `SendModal`, which is deleted with the
                    rail. Delegation accounts keep the sponsored owner-send.
                    #4097: Send is primary once the account holds money; an
                    empty account makes Receive the primary and disables Send. */}
                <Button
                  onClick={() => setSendOpen(true)}
                  variant={accountHoldsMoney ? 'primary' : 'ghost'}
                  disabled={!accountHoldsMoney}
                >
                  Send
                </Button>
                <Button
                  variant={accountHoldsMoney ? 'ghost' : 'primary'}
                  onClick={() => setReceiveOpen(true)}
                >
                  Receive
                </Button>
              </>
            )}
            {/*
              Account-level settings live behind a kebab menu so they don't
              compete visually with the transactional Send/Receive buttons.
              "Rename" + "Remove" are direct actions; "Set as default" only
              appears when this isn't already the default account.
            */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account options"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] text-[var(--v2-ink-2)] transition-colors hover:border-[var(--v2-border-strong)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                <Icon icon={EllipsisVertical} className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                  Rename
                </DropdownMenuItem>
                {!account.is_default && multiAccount ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      void setDefault(account.id)
                      toast.success(`${account.name} is now your default account`)
                    }}
                  >
                    Set as default
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => setRemoveOpen(true)}>
                  Remove account
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      {/* ── The summary card: three columns, stacking on a phone (#4097). */}
      <Card elevation="raised" hover={false} className="overflow-hidden">
        <div className="grid md:grid-cols-3 md:divide-x md:divide-[var(--v2-border)]">
          {/* Balance */}
          <section aria-label="Balance" className="p-5 sm:p-6">
            <p className="text-sm font-medium text-[var(--v2-ink-2)]">Balance</p>
            {portfolioLoading ? (
              <div className="mt-3 h-9 w-44 rounded bg-[var(--v2-surface-2)] animate-pulse" />
            ) : balanceUnavailable ? (
              <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink-3)] v2-tabular">
                Unavailable
              </p>
            ) : (
              <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
                {formattedTotal}
              </p>
            )}
            {/* #3295: the headline figure is the last-known balance when the
                live read failed — a subtle indicator says how old it is. */}
            {degradedFreshness && (
              <div className="mt-2">
                <BalanceFreshnessIndicator freshness={degradedFreshness} />
              </div>
            )}
          </section>

          {/* Holdings — the token rules live in lib/account-holdings.ts. The
              mockup-v9 anatomy (#4166): "Holdings" on the left of the header
              row with a small "Amount" column label on the right, and each
              token's amount right-aligned under it — the amount no longer
              runs inline after the symbol. #4197: the amount renders at most
              4 decimals, rounded DOWN by string truncation
              (`holdingDisplayAmount`), with the served amount (up to 6
              decimals) in the figure's title. The mark is a quiet monogram
              disc (the token's initial), not a brand logo. */}
          <section aria-label="Holdings" className="p-5 sm:p-6">
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium text-[var(--v2-ink-2)]">Holdings</p>
              <p className="text-xs text-[var(--v2-ink-3)]">Amount</p>
            </div>
            {portfolioLoading ? (
              <div className="mt-3 space-y-2" role="status" aria-busy="true" aria-label="Loading holdings">
                <div className="h-4 w-32 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                <div className="h-4 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse" />
              </div>
            ) : holdings.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--v2-ink-3)]">No tokens yet</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {holdings.map((row) => {
                  const rateLine = holdingRateLine(row, currency)
                  return (
                    <li key={row.symbol}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--v2-surface-2)] text-xs font-semibold text-[var(--v2-ink-2)]"
                          >
                            {row.symbol.charAt(0)}
                          </span>
                          <span className="min-w-0 truncate text-sm font-medium text-[var(--v2-ink)]">
                            {row.symbol}
                          </span>
                        </span>
                        <span className="font-mono text-sm text-[var(--v2-ink)] v2-tabular">
                          {/* #4197: at most 4 decimals, rounded down by
                              string truncation; the title carries the
                              amount AS SERVED (up to 6 decimals). The title
                              sits on its own inner span so it does not
                              bleed onto the freshness marker beside it. */}
                          <span title={row.amount}>{holdingDisplayAmount(row.amount)}</span>
                          {/* #3295: this token's read failed — the amount is
                              the last-known balance, and the row says how old
                              it is. Never an unmarked figure. */}
                          {row.balanceFreshness && (
                            <span className="ml-2">
                              <BalanceFreshnessIndicator freshness={row.balanceFreshness} size="compact" />
                            </span>
                          )}
                        </span>
                      </div>
                      {/* One token shows no value (it would repeat the
                          balance); a non-USD display currency shows the
                          rate instead; two or more each show their value.
                          The secondary line aligns with the symbol, under
                          the mark. */}
                      {row.value !== null ? (
                        <p className="mt-0.5 pl-8 text-sm text-[var(--v2-ink-2)] v2-tabular">
                          {formatFiat(row.value, currency)}
                        </p>
                      ) : null}
                      {rateLine ? (
                        <p className="mt-0.5 pl-8 text-xs text-[var(--v2-ink-3)]">{rateLine}</p>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>

          {/* Last 30 days — ONE row under the title (#4197): an inline
              in-arrow and the Money-in figure, then an out-arrow and the
              Money-out figure, replacing #4166's label row so the column is
              no taller than Balance and Holdings. The mark is `aria-hidden`;
              each figure is named by sr-only text BEFORE the amount (a
              screen reader hears "Money in ≈ $19.99"), and the tooltip lives
              on the ICON — not around `Amount`, whose "≈" already draws its
              own title. The two focusable icon triggers are accepted. */}
          <section aria-label="Last 30 days" className="p-5 sm:p-6">
            <p className="text-sm font-medium text-[var(--v2-ink-2)]">Last 30 days</p>
            {moneyFlow.loading ? (
              <div className="mt-3 space-y-2" role="status" aria-busy="true" aria-label="Loading the last 30 days">
                <div className="h-4 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                <div className="h-4 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse" />
              </div>
            ) : moneyFlow.error ? (
              <div className="mt-2">
                <p className="text-sm text-[var(--v2-ink-3)]">Haven could not load the last 30 days.</p>
                <Button
                  className="mt-2"
                  size="sm"
                  variant="ghost"
                  onClick={() => void moneyFlow.refresh()}
                >
                  Try again
                </Button>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
                <span className="flex items-center gap-1.5">
                  <Tooltip label="Money in">
                    <DirectionMark direction="in" density="inline" />
                  </Tooltip>
                  <span className="sr-only">Money in</span>
                  <Amount amount={moneyFlow.moneyIn} currency={currency} approx={moneyFlow.approxIn} />
                </span>
                <span className="flex items-center gap-1.5">
                  <Tooltip label="Money out">
                    <DirectionMark direction="out" density="inline" />
                  </Tooltip>
                  <span className="sr-only">Money out</span>
                  <Amount amount={moneyFlow.moneyOut} currency={currency} approx={moneyFlow.approxOut} />
                </span>
              </div>
            )}
            {/* #4165: rows the totals could not value are said in words,
                never folded into a "≈" — the mark means converted. Below the
                side-by-side figures (#4166), full width like the qualifier. */}
            {!moneyFlow.loading && !moneyFlow.error && moneyFlow.unpriced ? (
              <p className="mt-2 text-xs text-[var(--v2-ink-3)]">{UNPRICED_TOTALS_NOTE}</p>
            ) : null}
            {/* #2882: the feed is capped at the explorer window, so the
                figures may not cover the full 30 days — the partial-data
                qualifier instead of a completeness claim. */}
            {!moneyFlow.loading && !moneyFlow.error && moneyFlow.partial ? (
              <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
                Figures cover the history Haven could load, which may not cover the full 30 days.
              </p>
            ) : null}
          </section>
        </div>
      </Card>

      {/* ── The tab row (#4096's Tabs; the page owns ?tab=). */}
      <Tabs
        tabs={tabItems}
        value={activeTab}
        onChange={handleTabChange}
        ariaLabel="Account"
      />

      {/* ── Activity tab (#4098): the account's full ledger — FilterBar with
          the Account chip hidden, the server's filtered count and in/out
          totals, day-grouped rows, paging and the detail panel. */}
      {activeTab === 'activity' ? (
        <AccountActivityTab
          accountId={accountId}
          chainId={chainId}
          currency={currency}
          resolveAddress={resolveAddress}
          accountNamesByAddress={accountNamesByAddress}
          onReceive={() => setReceiveOpen(true)}
          refreshKey={ledgerRefreshKey}
        />
      ) : null}

      {/* ── Agents tab: the budget snapshot line, the shared agent rows, the
          hidden revoked count (#4097). */}
      {activeTab === 'agents' ? (
        <div className="space-y-4">
          {/* #3871's rule, carried to this surface: the classification the
              row badges read is still in flight, so the first rows render is
              fully classified — never a frame a later poll would reorder. */}
          {overviewLoading || agentsListPending ? (
            <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card overflow-hidden">
              <div className="divide-y divide-[var(--v2-border)]" role="status" aria-busy="true" aria-label="Loading agents">
                {[0, 1, 2].map((item) => (
                  <div key={item} className="flex items-center gap-3 px-5 py-3.5">
                    <div className="h-8 w-8 rounded-full bg-[var(--v2-surface-2)] animate-pulse" />
                    <div className="min-w-0 flex-1">
                      <div className="h-3.5 w-36 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                      <div className="mt-1.5 h-2.5 w-48 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : overviewError && accountAgents.length === 0 ? (
            <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card overflow-hidden">
              <div className="p-6">
                <EmptyState
                  size="compact"
                  title="Agents could not load"
                  body="Haven could not verify which agents are connected right now."
                  className="py-8"
                  action={<Button variant="ghost" size="sm" onClick={() => void refetchOverview()}>Try again</Button>}
                />
              </div>
            </div>
          ) : accountAgents.length === 0 ? (
            <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card overflow-hidden">
              <div className="p-6">
                <EmptyState
                  size="compact"
                  title="No agents connected"
                  body="Connect an agent when you want it to request payments from this Haven wallet."
                  className="py-8"
                  action={
                    <Button href="/agents" size="sm">Connect agent</Button>
                  }
                />
              </div>
            </div>
          ) : (
            <>
              <p className="max-w-2xl text-sm leading-relaxed text-[var(--v2-ink-2)]">
                {agentSpendSummaryLine(accountAgents, currency, overview?.spotRates)}
              </p>
              <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card overflow-hidden">
                <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
                  {accountAgents.map((agent) => (
                    <AgentRow
                      key={agent.id}
                      agent={agent}
                      budgetRemaining={budgetRemaining ?? null}
                      attentionItems={attentionItems}
                      accountNames={accountNames}
                      accountCount={user?.accounts?.length ?? 0}
                      nowMs={Date.now()}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
          {/* Revoked agents are not listed; one line says how many are hidden
              and links to the Agents page's revoked facet — the account facet
              only exists with two or more accounts (lib/agent-list-filters
              registers it then), so the link narrows by account only then. */}
          {hiddenRevokedCount > 0 ? (
            <p className="text-sm text-[var(--v2-ink-3)]">
              {hiddenRevokedCount} revoked {hiddenRevokedCount === 1 ? 'agent' : 'agents'} not listed.{' '}
              <Link
                href={revokedAgentsHref}
                className="font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
              >
                View
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ── Security & details tab: the ONLY place that changes the signer
          set, plus the account's own details (#4097). */}
      {activeTab === 'security' ? (
        <div className="space-y-6">
          <div>
            <h2 className="text-base font-semibold text-[var(--v2-ink)]">Who can approve</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--v2-ink-2)]">
              The ways this account can be approved. Keep at least two, so a lost device never
              means a lost account.
            </p>
          </div>
          {/* #1089: backup & recovery is an account capability, not an agent
              one — it works from the moment the account exists, with no agent
              required. Every flow the card owns (add a backup passkey, add a
              wallet, remove a signer, "Lost a device?") is reachable here and
              nowhere else; Settings' SignersSection lists without acting. */}
          <AccountSignersCard
            accountAddress={account.account_address}
            chainId={chainId}
            userEmail={user?.email ?? ''}
          />

          {/* Account details */}
          <Card hover={false} className="p-5 sm:p-6">
            <h2 className="mb-5 text-base font-semibold text-[var(--v2-ink)]">Account details</h2>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <p className="text-xs text-[var(--v2-ink-3)] mb-1">Haven wallet address</p>
                <div className="flex items-center gap-3">
                  {accountAddress ? (
                    <Tooltip label={accountAddress} mono>
                      <span className="text-sm font-mono text-[var(--v2-ink)]">
                        {truncate(accountAddress)}
                      </span>
                    </Tooltip>
                  ) : (
                    <span className="text-sm font-mono text-[var(--v2-ink)]">—</span>
                  )}
                  {accountAddress && <CopyButton value={accountAddress} label="address" />}
                  {accountExplorerHref && (
                    <ExternalDetailsLink href={accountExplorerHref} label="Open wallet address externally" />
                  )}
                </div>
              </div>
              <div>
                <p className="text-xs text-[var(--v2-ink-3)] mb-1">Network</p>
                <p className="text-sm text-[var(--v2-ink)]">
                  {resolveChainOrNull(chainId)?.name ?? `Chain ${chainId}`}
                </p>
              </div>
              <div>
                <p className="text-xs text-[var(--v2-ink-3)] mb-1">Created</p>
                <p className="text-sm text-[var(--v2-ink)]">{formatLongDate(account.created_at)}</p>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {/*
        Mount the modal only while open so its wallet hooks
        (useSendTransaction / useActiveSigner / useAccountOperationGate, each
        backing a wagmi wallet-client subscription) don't run in the
        background on every account page view.
      */}
      {sendOpen && accountAddress && (
        <DelegationSendModal
          open
          onClose={() => setSendOpen(false)}
          accountAddress={accountAddress}
          chainId={chainId}
          onSent={handleSendSuccess}
        />
      )}
      <ReceiveDialog
        open={receiveOpen}
        account={account}
        onClose={() => setReceiveOpen(false)}
      />
      {renameOpen && (
        <RenameModal
          account={account}
          onClose={() => setRenameOpen(false)}
          onRename={handleRename}
          loading={accountsLoading}
        />
      )}
      <ConfirmDialog
        open={removeOpen}
        onCancel={closeRemoveDialog}
        onConfirm={handleRemoveConfirmed}
        title={`Remove ${account.name}?`}
        body={(
          <div className="space-y-3">
            <p>
              This only removes the account from Haven. Funds on-chain are unaffected, and you
              keep control of the account itself.
            </p>
            {removeError && (
              <InlineAlert>{removeError.message}</InlineAlert>
            )}
          </div>
        )}
        confirmLabel={removeError?.retryable ? 'Try again' : 'Remove account'}
        loading={removing}
      />
    </div>
  )
}

function RenameModal({
  account,
  onClose,
  onRename,
  loading,
}: {
  account: SmartAccount
  onClose: () => void
  onRename: (name: string) => Promise<void>
  loading: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [name, setName] = useState(account.name)
  const [error, setError] = useState('')
  useFocusTrap(panelRef, true)
  useEscapeToClose(true, onClose, { enabled: !loading })

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Enter an account name.')
      return
    }

    setError('')
    try {
      await onRename(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not rename this account.')
    }
  }

  return (
    // `v2-safe-overlay` with no gutter of its own (#2730): this overlay has
    // never had one, so every side is exactly its safe-area inset — 0 in any
    // browser without a notch, and the clearance the home indicator needs in
    // the installed shell.
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center v2-safe-overlay">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={loading ? undefined : onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-account-title"
        className="relative mx-4 w-full max-w-sm rounded-xl border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-5 py-4">
          <div>
            <h2 id="rename-account-title" className="text-base font-semibold text-[var(--v2-ink)]">Rename account</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Give this Haven account a name only you see.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            aria-label="Close"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon icon={X} className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <div>
            <label htmlFor="rename-account-name" className="mb-1.5 block text-xs text-[var(--v2-ink-2)]">Account name</label>
            <input
              id="rename-account-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
              autoFocus
              className="w-full rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface-2)] px-3 py-2.5 text-sm text-[var(--v2-ink)] transition-colors focus-visible:border-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
            />
          </div>
          {error && (
            <div className="rounded-lg border border-danger/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-sm text-[var(--v2-danger)]">
              {error}
            </div>
          )}
          <div className="flex gap-3 pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={loading}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading} className="flex-1">
              {loading ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
