'use client'

import { ArrowLeftRight, Bot, ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useContacts } from '@/hooks/useContacts'
import { useAgents } from '@/hooks/useAgents'
import { useAggregatedBalances } from '@/hooks/useAggregatedPortfolio'
import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { useBalances } from '@/hooks/useBalances'
import { useAccountFunding } from '@/hooks/useAccountFunding'
import { useAccountOperationGate } from '@/hooks/useAccountOperationGate'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { timeAgo } from '@/lib/format'
import {
  transactionMovement,
  transactionStatus,
  transactionTitle,
} from '@/lib/transaction-presentation'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { agentStatusPresentation } from '@/lib/payment-status'
import { machinePaymentLifecyclePresentation } from '@/lib/machine-payment-lifecycle'
import { displayName } from '@/lib/user'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
import UsingYourAgentInfo from '@/components/UsingYourAgentInfo'
import ConnectAgentModal from '@/components/ConnectAgentModal'
import DashboardActionPickerModal from '@/components/DashboardActionPickerModal'
import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import AddFundsModal from '@/components/AddFundsModal'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Row } from '@/components/ui/Row'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useToast } from '@/components/ui/Toast'
import { TransactionActivityRow } from '@/components/haven'
import MoneyPanel from './MoneyPanel'
import type { DashboardAgentPreview } from '@/types/dashboard'
import type { AggregatedTransaction } from '@/types/transactions'
import { resolveDefaultAccount } from '@/lib/default-account'
import { computeAttentionItems, type AttentionRuleItem } from '@/lib/dashboard-attention'
import { useBudgetRemaining } from '@/hooks/useBudgetRemaining'
import NeedsYou from './NeedsYou'

// #3127 (finding 6): the per-currency formatting itself lives in ONE place —
// `lib/format.ts`'s `formatFiat`, shared with /accounts and /accounts/[id].
// The dashboard's compact tile wrapper and the signed change/percent helpers
// moved to `dashboard/MoneyPanel.tsx` with the money panel (#3807) — the
// tiles that needed the compact tier are gone.

function buildSpendSummary(agent: DashboardAgentPreview): string {
  // #3802: "No budget" — the overview's allowance array already carries only
  // live (unexpired, started) budgets, so an empty array means the agent
  // cannot spend at all. The old copy said the opposite of the truth.
  if (agent.allowances.length === 0) return 'No budget'

  const summaries = agent.allowances.slice(0, 2).map((allowance) => {
    const amount = formatAllowanceForToken(
      allowance.allowanceAmount,
      agent.accountChainId,
      allowance.tokenSymbol,
    )
    // #3807: no reset label — `resetPeriodMin` left the wire with the KPI
    // tiles, and #3809's budget-caption row replaces this subtitle outright.
    return `${amount} ${allowance.tokenSymbol}`
  })

  if (agent.allowances.length > 2) {
    summaries.push(`+${agent.allowances.length - 2} more`)
  }

  return summaries.join(' • ')
}

function ConnectedAgentsSection({
  agents,
  hasAnyAgents,
  loading,
  unavailable,
  onRetry,
  onConnectAgent,
}: {
  agents: DashboardAgentPreview[]
  hasAnyAgents: boolean
  loading: boolean
  unavailable: boolean
  onRetry: () => void
  onConnectAgent: () => void
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card overflow-hidden">
      <Card.Header
        as="h2"
        title="Connected agents"
        actions={
          <Link href="/agents" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
            View all
          </Link>
        }
      />

      {loading ? (
        <div className="divide-y divide-[var(--v2-border)]" role="status" aria-busy="true" aria-live="polite" aria-label="Loading connected agents">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-center gap-3 px-5 h-[72px]">
              <div className="h-8 w-8 rounded-full bg-[var(--v2-surface-2)] animate-pulse" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-36 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                <div className="mt-1.5 h-2.5 w-48 rounded bg-[var(--v2-surface-2)] animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : unavailable ? (
        <div className="p-6">
          <EmptyState
            size="compact"
            title="Agent preview unavailable"
            body="Haven could not verify which agents are connected right now."
            action={<Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>}
          />
        </div>
      ) : agents.length === 0 ? (
        <div className="p-6">
          <EmptyState
            size="compact"
            title={hasAnyAgents ? 'No connected agents right now' : 'No agents connected yet'}
            body={
              hasAnyAgents
                ? 'Reconnect or create an agent to bring automated spending back online.'
                : 'Create your first agent to give it payment credentials and spend limits.'
            }
            action={
              <div className="flex items-center justify-center gap-3">
                <Button onClick={onConnectAgent} size="sm">
                  Connect agent
                </Button>
                <Link href="/agents" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
                  Go to Agents
                </Link>
              </div>
            }
          />
        </div>
      ) : (
        <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
          {agents.slice(0, 5).map((agent) => {
            const status = agentStatusPresentation(agent.status)
            return (
              <Row
                key={agent.id}
                href={`/agents/${agent.id}`}
                // Robot mark matches the sidebar's "agents" icon so the
                // dashboard and nav read as the same system.
                leading={<AgentMarkIcon />}
                leadingTone="brand"
                title={
                  <span className="flex items-center gap-2">
                    <span className="truncate">{agent.name}</span>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  </span>
                }
                subtitle={buildSpendSummary(agent)}
                trailing={
                  <Icon icon={ChevronRight} className="w-4 h-4 text-[var(--v2-ink-3)]" />
                }
                className="h-[72px] px-5"
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
// ── Metric card icons (1.5 stroke, 14px, currentColor) ───────────────────
// These match the sidebar / Row visual language. AgentMarkIcon mirrors the
// sidebar's "agents" robot mark so the dashboard reads the same as the nav.

function AgentMarkIcon() {
  return (
    <Icon icon={Bot} className="w-full h-full" />
  )
}

function EmptyTransactionsIcon() {
  // Arrows-in-out icon — mirrors the sidebar's "transactions" mark so the
  // empty state belongs to the same visual family.
  return (
    <Icon icon={ArrowLeftRight} className="w-full h-full" />
  )
}

function TransactionsSection({
  transactions,
  hasAccounts,
  loading,
  unavailable,
  onRetry,
  resolveAddress,
}: {
  transactions: AggregatedTransaction[]
  hasAccounts: boolean
  loading: boolean
  unavailable: boolean
  onRetry: () => void
  resolveAddress: (address: string) => string | null
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card overflow-hidden">
      <Card.Header
        as="h2"
        title="Recent transactions"
        actions={
          <Link href="/transactions" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
            View all
          </Link>
        }
      />

      {loading ? (
        <div className="divide-y divide-[var(--v2-border)]" role="status" aria-busy="true" aria-live="polite" aria-label="Loading recent transactions">
          {[0, 1, 2].map((item) => (
            // Same breakpoint-scoped height as the loaded row it stands in for
            // (#1833). It does not currently overflow — the stacked skeleton is
            // ~64px against the 72px clamp — but it is the identical shape:
            // an `sm:`-gated two-column grid pinned unconditionally. Left
            // clamped it would ALSO make the list jump on load, since the
            // loaded row now grows to 116-164px below `sm` while this stayed
            // at 72px.
            <div key={item} className="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5 sm:py-0 sm:h-[72px]">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-[10px] bg-[var(--v2-surface-2)] animate-pulse" />
                <div>
                  <div className="h-3.5 w-40 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                  <div className="mt-1.5 h-2.5 w-56 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                </div>
              </div>
              <div className="h-4 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse sm:justify-self-end" />
            </div>
          ))}
        </div>
      ) : unavailable ? (
        <div className="p-6">
          <EmptyState
            size="compact"
            title="Activity preview unavailable"
            body="Haven could not refresh recent payments right now."
            action={<Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>}
          />
        </div>
      ) : transactions.length === 0 ? (
        <div className="p-6">
          <EmptyState
            tone="brand"
            icon={<EmptyTransactionsIcon />}
            title="No transactions yet"
            body={
              hasAccounts
                ? 'Receive funds or make your first payment to start building activity here.'
                : 'Create a Haven account to start tracking transactions.'
            }
            action={
              <Button
                href={hasAccounts ? '/transactions' : '/accounts'}
                variant="ghost"
                size="sm"
              >
                {hasAccounts ? 'Open transactions' : 'Go to accounts'}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
          {transactions.slice(0, 5).map((tx) => {
            const lifecycle = machinePaymentLifecyclePresentation(tx)
            const recovery = transactionStatus(tx)
            return (
              <Link
                key={`${tx.hash}-${tx.type}-${tx.accountId}`}
                href="/transactions"
                className="block"
              >
                <TransactionActivityRow
                  title={transactionTitle(tx)}
                  description={transactionMovement(tx, resolveAddress)}
                  value={tx.valueFormatted}
                  asset={tx.asset}
                  failed={tx.isError}
                  status={recovery?.label ?? lifecycle?.label ?? (tx.isError ? 'Failed' : tx.direction === 'in' ? 'Received' : 'Sent')}
                  statusTone={recovery?.tone ?? lifecycle?.tone ?? (
                    tx.isError ? 'danger' : tx.direction === 'in' ? 'success' : 'neutral'
                  )}
                  timestamp={timeAgo(tx.timestamp * 1000)}
                  direction={tx.direction}
                  density="compact"
                />
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function DashboardClient() {
  const { user, passkeys: enrolledPasskeys } = useAuth()
  const { toast } = useToast()
  const accounts = user?.accounts ?? []
  const { currency } = usePreferences()
  const { contacts, error: contactsError, resolveAddress } = useContacts()
  const { agents, loading: agentsLoading, refetch: refetchAgents } = useAgents()
  const {
    balances,
    loading: balancesLoading,
    error: balancesError,
    refetch: refetchAggregatedBalances,
  } = useAggregatedBalances()
  const { data: overview, loading: overviewLoading, error: overviewError, refetch: refetchOverview } = useDashboardOverview()

  const hasAnyBalance = balances.some((balance) => {
    try {
      return BigInt(balance.balance) > 0n
    } catch {
      return false
    }
  })

  // Each onboarding step is computed independently from real state so the
  // user can complete them in any order. The guide always renders the
  // canonical Fund → Agent → First payment ordering but a step completed
  // out of order shows as done regardless.
  // #3295: a failed balance read serves the last-known balance, so those
  // figures still settle `hasAnyBalance` — a funded user is never told to
  // fund their account because one read blipped. Only when some token has
  // NEVER been read (status 'unavailable') AND no token shows any balance is
  // the funding state unknown: the wire's zeros are then fillers, not
  // figures, and an empty-looking account may not be empty.
  const hasUnavailableBalance = balances.some(
    (balance) => balance.balanceFreshness?.status === 'unavailable',
  )
  const fundingStateKnown =
    accounts.length > 0 &&
    !balancesLoading &&
    !balancesError &&
    // Unknown only when the zeros might be lying: some token was never read
    // AND nothing shows a balance. A known balance settles it regardless of
    // which other token is unread.
    (!hasUnavailableBalance || hasAnyBalance)
  const dataReady = fundingStateKnown && !agentsLoading
  const hasFunds = fundingStateKnown && hasAnyBalance

  // #1153: the backup recommendation needs BOTH halves — funded, AND actually
  // missing a backup. Telling someone who already enrolled a second signer to
  // enrol one teaches them to ignore the banner.
  //
  // Read from the set `AuthContext` already resolves for every delegation-rail
  // account on login. A plain synchronous read, so no extra request and no
  // signing-provider context — a dashboard banner has no business requiring
  // the wallet machinery `useAccountSigners` pulls in.
  // #2413: the account list is delegation-only, so "the first delegation
  // account" is just the first account.
  const delegationAccount = accounts[0]

  // #3808: the "Needs you" rules read the overview's per-account
  // `needs_backup_recommendation` (#1205) — the server's answer, computed next
  // to the chain classification, so no second copy of "which chains carry
  // value" lives here. The #1153/#1162 RecoveryNudge component is gone; its
  // dismissal key survives as the backup items' dismissal until #3813 owns
  // per-item persistence.

  // The DELEGATION-rail nudge above is untouched — `Backup & recovery` is live
  // and this is still the rail where new accounts land.
  const hasAgents = dataReady && agents.length > 0
  // #2534: the funding facts for the onboarding card's step 1, read from the
  // same endpoint `haven wallets funding` prints — one source for the
  // instruction copy (address, chain, the minimum `@haven_ai/core` owns).
  // Fetched only while the account is unfunded: a funded account has no
  // instruction to show, and the hero/`hasFunds` state already settles the
  // checklist. The hook surfaces errors instead of throwing so the card keeps
  // its general copy when the read fails, exactly as the balance read does.
  const { funding: fundingForOnboarding } = useAccountFunding(
    !fundingStateKnown || hasFunds ? undefined : delegationAccount?.id,
  )
  const overviewInitialLoading = overviewLoading && !overview
  const firstAgentPaymentKnown = Boolean(overview?.onboardingProgress)
  const hasFirstAgentPayment = Boolean(
    overview?.onboardingProgress?.hasFirstAgentPayment,
  )
  const setupProgressReady =
    dataReady &&
    (!hasFunds || !hasAgents || firstAgentPaymentKnown)
  const allOnboardingComplete =
    setupProgressReady && hasFunds && hasAgents && hasFirstAgentPayment

  // #3719: no global active account. The default account pre-selects the
  // hero's Receive / Add funds (which ask when there is more than one) and the
  // connect flow.
  const defaultAccount = useMemo(() => resolveDefaultAccount(accounts), [accounts])
  const hasDelegationAccounts = accounts.length > 0

  // Owner-initiated send from the DASHBOARD is gone (#1989, epic #1440). It was
  // a legacy-Safe transaction signed through `SendModal`, and that rail is
  // retired — the modal and its `useSendTransaction` hook are deleted. The
  // delegation rail's owner-send lives on the account detail page
  // (`DelegationSendModal`) and is untouched. #1079's "hidden, not disabled"
  // mechanism is reused: no Send affordance renders anywhere on the dashboard
  // and nothing dead-ends. The money panel (#3807) offers "Deposit address"
  // and "Add funds" only.

  const [connectAgentOpen, setConnectAgentOpen] = useState(false)
  const [pickerAction, setPickerAction] = useState<'receive' | 'add-funds' | null>(null)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [addFundsOpen, setAddFundsOpen] = useState(false)
  const [agentUsageOpen, setAgentUsageOpen] = useState(false)
  // Set true the first time the user opens Receive in this session. Combined
  // with !hasFunds it drives the hero's "Watching for incoming deposits…"
  // hint so the user knows the dashboard is actively listening.
  const [hasOpenedReceive, setHasOpenedReceive] = useState(false)
  const [actionAccountId, setActionAccountId] = useState<string | null>(null)
  // In-progress dismissal is session-only — refreshing brings the checklist
  // back so we keep nudging the user toward completing setup.
  const [inProgressDismissed, setInProgressDismissed] = useState(false)
  // Setup-complete dismissal IS persisted — once the user has done all three
  // steps and dismissed the celebration, we don't show it again on reload.
  const [completeDismissalState, setCompleteDismissalState] = useState<{
    userId: string | null
    dismissed: boolean
  }>({ userId: null, dismissed: false })
  const completeDismissalReady =
    Boolean(user?.id) && completeDismissalState.userId === user?.id
  const completeDismissed = completeDismissalReady
    ? completeDismissalState.dismissed
    : false

  useEffect(() => {
    if (actionAccountId && accounts.some((account) => account.id === actionAccountId)) return
    setActionAccountId(defaultAccount?.id ?? null)
  }, [actionAccountId, defaultAccount?.id, accounts])

  // Read the persisted setup-complete dismissal once the user is known.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!user?.id) {
      setCompleteDismissalState({ userId: null, dismissed: false })
      return
    }
    const stored = window.localStorage.getItem(`haven-onboarding-complete-dismissed:${user.id}`)
    setCompleteDismissalState({ userId: user.id, dismissed: stored === '1' })
  }, [user?.id])

  // If the user makes progress after dismissing the in-progress checklist,
  // bring it back so they see the next step. We track the completed count in
  // a ref and reset the dismiss whenever it grows.
  const completedCount = (hasFunds ? 1 : 0) + (hasAgents ? 1 : 0) + (hasFirstAgentPayment ? 1 : 0)
  const previousCompletedRef = useRef(completedCount)
  useEffect(() => {
    if (completedCount > previousCompletedRef.current && inProgressDismissed) {
      setInProgressDismissed(false)
    }
    previousCompletedRef.current = completedCount
  }, [completedCount, inProgressDismissed])

  // Celebrate the first-fund moment: when hasFunds flips false → true, fire
  // a success toast. Only after data is ready, to avoid firing on initial
  // mount before the balances hook has resolved.
  const previousFundedRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (!dataReady) return
    if (previousFundedRef.current === false && hasFunds) {
      toast.success('Funds received — your agents can spend now')
    }
    previousFundedRef.current = hasFunds
  }, [dataReady, hasFunds, toast])

  // First arrival from the onboarding wizard — fire a single welcome toast
  // so the moment of arrival nods to the achievement without shouting. The
  // session flag is set by the wizard's "Go to dashboard" CTA and cleared
  // here so a refresh later in the same session doesn't re-fire.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!user) return
    let justOnboarded = false
    try {
      justOnboarded = window.sessionStorage.getItem('haven-just-onboarded') === '1'
      if (justOnboarded) {
        window.sessionStorage.removeItem('haven-just-onboarded')
      }
    } catch {
      // sessionStorage can throw in private mode — bail out silently. No
      // user-facing impact, the dashboard still renders.
      return
    }
    if (!justOnboarded) return
    const firstName = displayName(user).split(' ')[0]
    toast.success(`Welcome to Haven, ${firstName} — your account is live.`)
    // Intentionally fire once per session. The dependency array is empty
    // because we want this effect to run only on first mount after
    // arriving from onboarding; user identity is captured in the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedActionAccount = accounts.find((account) => account.id === actionAccountId) ?? defaultAccount
  const actionGate = useAccountOperationGate({
    accountAddress: selectedActionAccount?.account_address as Address | undefined,
    chainId: selectedActionAccount?.chain_id,
  })
  const requiresOtherDevice = actionGate.kind === 'passkey_on_other_device'
  // The per-account balance/details reads existed only to populate `SendModal`,
  // which is deleted (#1989). They stay wired but permanently disabled so the
  // dashboard makes no chain-fed request it cannot use; `refetchSelectedBalances`
  // is still called by `refreshDashboardData` and is a no-op while disabled.
  const sendModalDataEnabled = false
  const {
    refetch: refetchSelectedBalances,
  } = useBalances(
    selectedActionAccount?.account_address ?? null,
    { enabled: sendModalDataEnabled, chainId: selectedActionAccount?.chain_id },
  )

  // SEK (#3127): the display side now honours the served default end to end.
  // totals.sek / metrics.monthlyAgentSpendSek are optional on the wire and
  // default to 0 exactly as the USD/EUR figures do while the overview loads;
  // change.sekAmount is `null` when yesterday's snapshot predates migration
  // 090 — no SEK baseline was stored — and the hero then reports the change
  // as unavailable rather than reading the null as a zero swing.
  // #3295: the same null rule now also covers a balance read that has never
  // succeeded (balancesFreshness.status === 'unavailable') — the totals are
  // understated by an unknown amount, so no swing may be claimed. A merely
  // STALE set of totals still diffs normally. `change.balancesFreshness`
  // also tells the hero to render its subtle stale indicator beside the
  // headline figure.
  const totalFiat = currency === 'EUR'
    ? (overview?.totals.eur ?? 0)
    : currency === 'SEK'
      ? (overview?.totals.sek ?? 0)
      : (overview?.totals.usd ?? 0)
  const sekChangeUnavailable = currency === 'SEK' && overview?.change.sekAmount == null
  const balancesFreshness = overview?.change.balancesFreshness
  const changeUnavailable = balancesFreshness?.status === 'unavailable'
  const changeAmount = currency === 'EUR'
    ? (overview?.change.eurAmount ?? 0)
    : currency === 'SEK'
      ? (overview?.change.sekAmount ?? 0)
      : (overview?.change.usdAmount ?? 0)
  const changePercent = currency === 'EUR'
    ? (overview?.change.eurPercent ?? 0)
    : currency === 'SEK'
      ? (overview?.change.sekPercent ?? 0)
      : (overview?.change.usdPercent ?? 0)
  const overviewUnavailable = Boolean(overviewError && !overview)
  // Render the guide whenever the user has at least one account and either:
  // (a) they have unfinished steps and haven't dismissed the checklist, OR
  // (b) they've just finished all three steps and haven't dismissed the celebration.
  const showOnboardingGuide =
    setupProgressReady &&
    hasDelegationAccounts &&
    completeDismissalReady &&
    !requiresOtherDevice &&
    (allOnboardingComplete ? !completeDismissed : !inProgressDismissed)

  // ── #3808: the "Needs you" items ─────────────────────────────────────────
  // One definition: `lib/dashboard-attention.ts` — the same rules #3809 (badges)
  // and #3818 (setup guide) import. The panel renders from the last good
  // overview (or the error row when the overview failed); it never renders
  // "nothing needs attention" while the first load is still in flight.
  const { data: budgetRemaining } = useBudgetRemaining()
  const [backupDismissed, setBackupDismissed] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    setBackupDismissed(window.localStorage.getItem('haven.recovery-nudge.dismissed') === '1')
  }, [])
  // Session-only dismissal for everything the rules will re-fire on the next
  // load anyway — until #3813, only the backup item's dismissal persists.
  const [sessionDismissedIds, setSessionDismissedIds] = useState<Set<string>>(() => new Set())
  const accountNames = useMemo(
    () => Object.fromEntries(accounts.map((account) => [account.id, account.name])),
    [accounts],
  )
  const attentionItems = useMemo(() => {
    if (!overview) return []
    return computeAttentionItems({
      overview,
      budgetRemaining: budgetRemaining ?? null,
      accountNames,
      backupDismissed,
      // While the setup guide's "Add USDC" step is open, the guide IS the
      // funds ask — the low-balance and zero-USDC items step aside (#3808).
      holdBackLowBalance: showOnboardingGuide && !hasFunds,
    }).filter((item) => !sessionDismissedIds.has(item.id))
  }, [overview, budgetRemaining, accountNames, backupDismissed, showOnboardingGuide, hasFunds, sessionDismissedIds])

  const attentionVisible = Boolean(overview) || Boolean(overviewError)

  function refreshDashboardData() {
    refetchOverview()
    refetchAgents()
    refetchAggregatedBalances()
    refetchSelectedBalances()
  }

  function openConnectAgent() {
    if (!hasDelegationAccounts) return
    setConnectAgentOpen(true)
  }

  function openHeroAction(action: 'receive' | 'add-funds') {
    if (accounts.length === 0) {
      if (action === 'add-funds') setAddFundsOpen(true)
      return
    }

    if (accounts.length > 1) {
      setPickerAction(action)
      return
    }

    setActionAccountId(defaultAccount?.id ?? null)
    if (action === 'receive') {
      setHasOpenedReceive(true)
      setReceiveOpen(true)
    }
    if (action === 'add-funds') setAddFundsOpen(true)
  }

  function openReceiveForDefaultAccount() {
    if (!defaultAccount) return
    setActionAccountId(defaultAccount.id)
    setHasOpenedReceive(true)
    setReceiveOpen(true)
  }

  function handleActionAccountSelected(accountId: string) {
    setActionAccountId(accountId)
    if (pickerAction === 'receive') setReceiveOpen(true)
    if (pickerAction === 'add-funds') setAddFundsOpen(true)
    setPickerAction(null)
  }

  function dismissInProgressGuide() {
    setInProgressDismissed(true)
  }

  function dismissCompleteBanner() {
    setCompleteDismissalState({ userId: user?.id ?? null, dismissed: true })
    if (typeof window !== 'undefined' && user?.id) {
      window.localStorage.setItem(`haven-onboarding-complete-dismissed:${user.id}`, '1')
    }
  }

  function openAddFundsForAccount(accountId: string) {
    setActionAccountId(accountId)
    setAddFundsOpen(true)
  }

  function handleDismissAttention(item: AttentionRuleItem) {
    if (item.kind === 'no-backup') {
      // The legacy global key: one flag hides the backup item for every
      // account, exactly as RecoveryNudge's "Got it" did. #3813 replaces
      // this with per-item persistence.
      setBackupDismissed(true)
      try {
        window.localStorage.setItem('haven.recovery-nudge.dismissed', '1')
      } catch {
        /* private mode — the state flip above still hides it this session */
      }
      return
    }
    setSessionDismissedIds((previous) => new Set(previous).add(item.id))
  }

  // #3807: the money panel replaces the hero + KPI tiles. The focused
  // first-run view (an unfunded account) renders it without the spending
  // block — the old render was hero + checklist only.
  const isFocusedView = showOnboardingGuide && !hasFunds
  const moneyPanel = (
    <MoneyPanel
      loading={overviewInitialLoading}
      unavailable={overviewUnavailable}
      currency={currency}
      totalFiat={totalFiat}
      changeAvailable={Boolean(overview?.change.available)}
      sekChangeUnavailable={sekChangeUnavailable}
      balancesFreshness={balancesFreshness}
      changeUnavailable={changeUnavailable}
      changeAmount={changeAmount}
      changePercent={changePercent}
      overview={overview}
      hasAccounts={accounts.length > 0}
      hasFunds={hasFunds}
      fundingStateKnown={fundingStateKnown}
      watchingForDeposit={fundingStateKnown && !hasFunds && hasOpenedReceive}
      requiresOtherDevice={requiresOtherDevice}
      showSpending={!isFocusedView}
      onDepositAddress={() => openHeroAction('receive')}
      onAddFunds={() => openHeroAction('add-funds')}
    />
  )

  const attentionPanel = attentionVisible ? (
    <NeedsYou
      items={attentionItems}
      hasOverviewError={Boolean(overviewError)}
      onRetry={refetchOverview}
      onDismiss={handleDismissAttention}
      onAddFunds={openAddFundsForAccount}
    />
  ) : null
  const showTopAside = attentionVisible

  const activityGrid = (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
      <ConnectedAgentsSection
        agents={overview?.agents ?? []}
        hasAnyAgents={agents.length > 0}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
        onRetry={refetchOverview}
        onConnectAgent={openConnectAgent}
      />
      <TransactionsSection
        transactions={overview?.transactions ?? []}
        hasAccounts={accounts.length > 0}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
        onRetry={refetchOverview}
        resolveAddress={resolveAddress}
      />
    </div>
  )

  return (
    <div className="max-w-6xl">
      {/* #3807: the "Dashboard" heading and its templated 7-day summary live
          in the money panel, which owns the top of the page. */}

      {/*
        Hide metrics + activity only for a brand-new user (no progress at
        all). Once any step is done, the full dashboard renders alongside
        the checklist so the user can see their progress against the rest
        of the dashboard.
      */}
      {(() => {
        const showGuide = showOnboardingGuide
        // Focused first-run view: money panel (no spending block) + checklist
        // only. Triggered when the user hasn't funded their account yet —
        // agent and payment steps need funded state to be useful. The
        // computation lives above the money panel (#3807); `showSpending`
        // reads it there.
        const guide = showGuide ? (
          <DashboardOnboardingGuide
            hasFunds={hasFunds}
            hasAgents={hasAgents}
            hasFirstAgentPayment={hasFirstAgentPayment}
            funding={fundingForOnboarding}
            onReceiveFunds={openReceiveForDefaultAccount}
            onAddAgent={openConnectAgent}
            onShowAgentUsage={() => setAgentUsageOpen(true)}
            onDismiss={dismissInProgressGuide}
            onDismissComplete={dismissCompleteBanner}
            inProgressDismissed={inProgressDismissed}
            completeDismissed={completeDismissed}
          />
        ) : null

        // The backup-signer prompt lives INSIDE the NeedsYou card now (#3808):
        // one item per funded account without a backup signer, dismissed via
        // the legacy global key. The focused view keeps the guide first — the
        // items that still apply (load error, backup once funded, extra
        // pending agents) render below its steps, and the low-balance /
        // zero-USDC items are held back while the guide's "Add USDC" step is
        // open (`holdBackLowBalance` on the rules).

        if (isFocusedView) {
          return (
            <div className="space-y-6">
              {moneyPanel}
              {attentionPanel}
              {guide}
            </div>
          )
        }

        return (
          <div className="space-y-6">
            <div
              className={`grid items-start gap-4 ${
                showTopAside ? 'xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.42fr)]' : ''
              }`}
            >
              {moneyPanel}
              {attentionPanel}
            </div>
            {guide}
            {activityGrid}
          </div>
        )
      })()}

      <ConnectAgentModal
        open={connectAgentOpen}
        onClose={() => {
          setConnectAgentOpen(false)
        }}
        accountId={defaultAccount?.id ?? null}
        onSetupUpdated={() => {
          refreshDashboardData()
        }}
      />

      <DashboardActionPickerModal
        open={pickerAction !== null}
        action={pickerAction ?? 'receive'}
        accounts={accounts}
        onClose={() => setPickerAction(null)}
        onSelect={handleActionAccountSelected}
      />


      <ReceiveFundsModal
        open={receiveOpen}
        account={selectedActionAccount}
        onClose={() => setReceiveOpen(false)}
      />

      <AddFundsModal
        open={addFundsOpen}
        onClose={() => setAddFundsOpen(false)}
        accountAddress={selectedActionAccount?.account_address}
        chainId={selectedActionAccount?.chain_id}
        onReceive={() => {
          setHasOpenedReceive(true)
          setReceiveOpen(true)
        }}
      />

      <UsingYourAgentInfo
        open={agentUsageOpen}
        onClose={() => setAgentUsageOpen(false)}
      />
    </div>
  )
}
