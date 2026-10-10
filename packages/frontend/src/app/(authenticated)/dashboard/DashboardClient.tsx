'use client'

import { Bot, ChevronRight, Coins, ShieldCheck, Wallet } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import type { Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useAgents } from '@/hooks/useAgents'
import { useAggregatedBalances } from '@/hooks/useAggregatedPortfolio'
import { useCountUp } from '@/hooks/useCountUp'
import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { useBalances } from '@/hooks/useBalances'
import { useAccountFunding } from '@/hooks/useAccountFunding'
import { useAccountOperationGate } from '@/hooks/useAccountOperationGate'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { formatFiat, currencyLocale } from '@/lib/format'
import { displayName } from '@/lib/user'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
import UsingYourAgentInfo from '@/components/UsingYourAgentInfo'
import ConnectAgentModal from '@/components/ConnectAgentModal'
import DashboardActionPickerModal from '@/components/DashboardActionPickerModal'
import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import AddFundsModal from '@/components/AddFundsModal'
import PasskeyOtherDeviceNotice from '@/components/PasskeyOtherDeviceNotice'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { BalanceFreshnessIndicator } from '@/components/haven'
import { useToast } from '@/components/ui/Toast'
import { ActivitySection } from './ActivitySection'
import { AgentsSection } from './AgentsSection'
import { resolveDefaultAccount } from '@/lib/default-account'
import { computeAttentionItems, type AttentionRuleItem } from '@/lib/dashboard-attention'
import { useBudgetRemaining } from '@/hooks/useBudgetRemaining'
import NeedsYou from './NeedsYou'

// #3127 (finding 6): the per-currency formatting itself lives in ONE place —
// `lib/format.ts`'s `formatFiat`, shared with /accounts and /accounts/[id].
// These two wrappers keep only what is dashboard-specific: the compact
// notation for the metric tiles, and the signed change line.
//
// #3195 (round-2 finding a): the SEK compact tier renders in the UI's voice
// (en-US), not the currency's — a big SEK tile read sv-SE's Swedish scale
// words (`5,19 tn kr`, "tn" = tusen) in an otherwise English UI. Scoped to
// the compact tier: the standard tier keeps `133,00 kr` (the #3127 voice,
// byte-pinned by the SEK baseline), and EUR keeps its deliberate de-DE voice
// at every tier (#3127's "the rule that puts EUR in de-DE" — untouched).
function formatCompactCurrency(value: number, currency: 'USD' | 'EUR' | 'SEK'): string {
  const compact = Math.abs(value) >= 1000
  const locale = compact && currency === 'SEK' ? 'en-US' : currencyLocale(currency)
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: 2,
  }).format(value)
}

function formatSignedCurrency(value: number, currency: 'USD' | 'EUR' | 'SEK'): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${formatFiat(Math.abs(value), currency)}`
}

// #3195 (round-2 finding b): the percent half of the change line renders in
// the currency's locale through `Intl` — `signDisplay: 'exceptZero'` keeps
// the explicit sign the old `toFixed` branch built by hand. The USD render is
// byte-identical (`+1.00%`); EUR now takes de-DE's voice (`+1,00 %`, its old
// render was the same hand-rolled English scaffold) and a SEK change line
// stops mixing voices: `+20,00 %` now, where the decimal comma came from
// sv-SE and the `+`/`%` scaffold from that pattern.
function formatPercent(value: number, currency: 'USD' | 'EUR' | 'SEK'): string {
  return new Intl.NumberFormat(currencyLocale(currency), {
    style: 'percent',
    signDisplay: 'exceptZero',
    useGrouping: false,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100)
}

function DashboardHero({
  loading,
  unavailable,
  totalFiat,
  currency,
  changeAvailable,
  sekChangeUnavailable,
  balancesFreshness,
  changeUnavailable,
  changeAmount,
  changePercent,
  hasAccounts,
  hasFunds,
  fundingStateKnown,
  watchingForDeposit,
  requiresOtherDevice,
  canSend,
  onSend,
  onReceive,
  onAddFunds,
}: {
  loading: boolean
  unavailable: boolean
  totalFiat: number
  currency: 'USD' | 'EUR' | 'SEK'
  changeAvailable: boolean
  /** True when the SEK baseline for yesterday predates migration 090 — no swing may be claimed. */
  sekChangeUnavailable: boolean
  /**
   * The aggregated degraded-balance marker (#3295). `stale` renders a subtle
   * "as of …" indicator beside the headline figure; `unavailable` means some
   * token has never been read, so the day's change is reported unavailable
   * rather than as a swing computed from an understated total.
   */
  balancesFreshness?: { status: 'stale'; asOf: string } | { status: 'unavailable' }
  /** True when some token has no known value — the change line must step aside. */
  changeUnavailable: boolean
  changeAmount: number | null
  changePercent: number
  hasAccounts: boolean
  hasFunds: boolean
  fundingStateKnown: boolean
  watchingForDeposit: boolean
  requiresOtherDevice: boolean
  /** False when no linked account supports owner send (delegation-only, #1079). */
  canSend: boolean
  onSend: () => void
  onReceive: () => void
  onAddFunds: () => void
}) {
  // Animate the balance from 0 → totalFiat on first paint after data loads.
  // Subsequent changes (currency switches, polled refresh) snap instantly.
  // Respects prefers-reduced-motion via the hook.
  const animatedTotal = useCountUp(totalFiat, { enabled: !loading && !unavailable })

  return (
    <section
      className="relative overflow-hidden rounded-[24px] border border-[var(--v2-border-anchor)] bg-[var(--v2-surface-anchor)] shadow-card-raised"
    >
      {/*
        Subtle ambient drift on the hero's gradient backdrop — the v2-mesh-drift
        keyframe in globals.css alternates ~2% translation over 18s. Adds a
        quiet sense of "alive" without being noticeable. Disabled by the same
        keyframe under prefers-reduced-motion.

        The backdrop extends 6% past the parent on every side so the drift's
        translation never pulls the layer off-edge and exposes the underlying
        anchor surface. The parent's `overflow-hidden` + rounded corners clip
        the buffer away.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-[6%] v2-mesh-drift"
        style={{ background: 'var(--v2-surface-hero)' }}
      />
      <div className="relative grid gap-6 px-6 py-7 sm:px-8 sm:py-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <p className="text-sm font-medium text-[var(--v2-ink-2)]">Total balance</p>
          {loading ? (
            <div className="mt-3 h-12 w-56 rounded bg-[var(--v2-surface-2)] animate-pulse" />
          ) : unavailable ? (
            <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--v2-ink-3)] sm:text-5xl">
              Unavailable
            </p>
          ) : (
            <p className="mt-2 text-4xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular sm:text-5xl">
              {formatFiat(animatedTotal, currency)}
            </p>
            )}
            {/* #3295: the headline figure is the last-known balance when the
                live read failed — a subtle indicator says how old it is, rather
                than the number silently claiming to be current. */}
            {balancesFreshness && (
              <div className="mt-2">
                <BalanceFreshnessIndicator freshness={balancesFreshness} />
              </div>
            )}
            {/*
              Three meta-line states under the headline number:
              1. Watching for a deposit (user opened Receive earlier, balance
                 still 0) — shows a soft brand-tinted pill with a pulse so the
                 user knows the dashboard is actively listening.
              2. Funded with change data — show today's signed % change.
              3. Funded without change data, OR no change available — quiet
                 "Across all linked Haven accounts." caption.
              #3295 adds a fourth input: when some token has never been read
              (unavailable), the change line steps aside entirely — no swing may
              be claimed from a total understated by an unknown amount. A merely
              stale set of totals still diffs normally.
            */}
            {watchingForDeposit ? (
              <p className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-[var(--v2-brand)]">
                <span
                  aria-hidden="true"
                  className="inline-flex h-1.5 w-1.5 rounded-full bg-[var(--v2-brand)] animate-pending-pulse"
                />
                Watching for incoming deposits…
              </p>
            ) : changeAvailable && !sekChangeUnavailable && !changeUnavailable && changeAmount !== null ? (
            <p className={`mt-3 text-sm font-medium ${changeAmount >= 0 ? 'text-[var(--v2-success)]' : 'text-[var(--v2-danger)]'}`}>
              {formatSignedCurrency(changeAmount, currency)} ({formatPercent(changePercent, currency)}) today
            </p>
          ) : (
            <p className="mt-3 text-sm text-[var(--v2-ink-3)]">
              Across all linked Haven accounts.
            </p>
          )}
        </div>

        {hasAccounts ? (
          requiresOtherDevice ? (
            <PasskeyOtherDeviceNotice className="max-w-sm" />
          ) : !fundingStateKnown || hasFunds ? (
            // Funded: Send is primary, Receive + Add funds support.
            // While balances are still loading, keep this neutral action order
            // so the hero does not briefly claim the account needs funds.
            <div className="flex flex-wrap gap-3">
              {canSend ? (
                <Button onClick={onSend} size="lg">
                  Send
                </Button>
              ) : null}
              <Button onClick={onReceive} variant={canSend ? 'ghost' : 'primary'} size="lg">
                Receive
              </Button>
              <Button onClick={onAddFunds} variant="ghost" size="lg">
                Add funds
              </Button>
            </div>
          ) : (
            // Unfunded: Receive becomes the primary action — Send is useless
            // with $0 and a confusing offer. We keep Send visible but ghost
            // so a user who already has off-flow plans can still find it.
            <div className="flex flex-wrap gap-3">
              <Button onClick={onReceive} size="lg">
                Receive funds
              </Button>
              <Button onClick={onAddFunds} variant="ghost" size="lg">
                Add funds
              </Button>
              {canSend ? (
                <Button onClick={onSend} variant="ghost" size="lg">
                  Send
                </Button>
              ) : null}
            </div>
          )
        ) : (
          <Button href="/accounts" size="lg">
            Create Haven account
          </Button>
        )}
      </div>
    </section>
  )
}

function MetricCard({
  label,
  value,
  footer,
  href,
  icon,
  loading,
  unavailable,
}: {
  label: string
  value: string
  footer?: string
  href?: string
  icon?: ReactNode
  loading?: boolean
  unavailable?: boolean
}) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
        {icon ? (
          <span
            aria-hidden="true"
            // Icon adopts brand color on hover via the group class on the parent link.
            className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--v2-ink-3)] transition-colors duration-150 group-hover:text-[var(--v2-brand)]"
          >
            {icon}
          </span>
        ) : null}
      </div>
      {loading ? (
        <div className="mt-3 h-7 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse" />
      ) : (
        <p className={`mt-2 text-2xl font-semibold tracking-tight v2-tabular v2-animate-fade-in ${unavailable ? 'text-[var(--v2-ink-3)]' : 'text-[var(--v2-ink)]'}`}>
          {unavailable ? 'Unavailable' : value}
        </p>
      )}
      {footer ? <p className="mt-2 text-xs text-[var(--v2-ink-3)]">{footer}</p> : null}
    </>
  )

  // Every metric card is interactive now — the four-card grid was inconsistent
  // before (two had href, two didn't). The hover lift (raised shadow + 1px
  // translate) makes the affordance obvious and matches the Stripe-style
  // hover treatment used on the dashboard hero.
  const baseClass =
    'group block rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-5 shadow-card transition-all duration-200 ease-out motion-reduce:transition-none motion-reduce:hover:translate-y-0'
  const hoverClass =
    'hover:-translate-y-px hover:shadow-card-raised hover:border-[var(--v2-border-strong)]'

  if (href) {
    return (
      <Link href={href} className={`${baseClass} ${hoverClass}`}>
        {content}
      </Link>
    )
  }
  return <div className={baseClass}>{content}</div>
}

// ── Metric card icons (1.5 stroke, 14px, currentColor) ───────────────────
// These match the sidebar / Row visual language. AgentMarkIcon mirrors the
// sidebar's "agents" robot mark so the dashboard reads the same as the nav.

function AgentMarkIcon() {
  return (
    <Icon icon={Bot} className="w-full h-full" />
  )
}

function SpendIcon() {
  // #3127 (finding 7): the mark over "Monthly agent spend" was `DollarSign`.
  // With SEK the no-preference default, that tile read `$` over `482,50 kr`
  // for every new signup — a currency glyph has a currency opinion, and the
  // figure beside it now carries a different one. The tile describes AGENT
  // SPEND, not a currency, so the mark is currency-neutral: coins, the same
  // family the sidebar/nav icons come from. `SpendIcon` itself keeps its name
  // and call site so the MetricCard contract is untouched.
  return (
    <Icon icon={Coins} className="w-full h-full" />
  )
}

function CheckIcon() {
  return (
    <Icon icon={ShieldCheck} className="w-full h-full" />
  )
}

function WalletIcon() {
  return (
    <Icon icon={Wallet} className="w-full h-full" />
  )
}

export default function DashboardClient() {
  const { user, passkeys: enrolledPasskeys } = useAuth()
  const { toast } = useToast()
  const accounts = user?.accounts ?? []
  const { currency } = usePreferences()
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
  // mechanism is reused: the hero's `canSend` is now constantly false, so no
  // Send affordance renders and nothing dead-ends.
  const canSendFromDashboard = false

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
  const monthlySpend = currency === 'EUR'
    ? (overview?.metrics.monthlyAgentSpendEur ?? 0)
    : currency === 'SEK'
      ? (overview?.metrics.monthlyAgentSpendSek ?? 0)
      : (overview?.metrics.monthlyAgentSpendUsd ?? 0)
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

  const heroPanel = (
    <DashboardHero
      loading={overviewInitialLoading}
      unavailable={overviewUnavailable}
      totalFiat={totalFiat}
      currency={currency}
      changeAvailable={Boolean(overview?.change.available)}
      sekChangeUnavailable={sekChangeUnavailable}
      balancesFreshness={balancesFreshness}
      changeUnavailable={changeUnavailable}
      changeAmount={changeAmount}
      changePercent={changePercent}
      hasAccounts={accounts.length > 0}
      hasFunds={hasFunds}
      fundingStateKnown={fundingStateKnown}
      watchingForDeposit={fundingStateKnown && !hasFunds && hasOpenedReceive}
      requiresOtherDevice={requiresOtherDevice}
      canSend={canSendFromDashboard}
      onSend={() => {}}
      onReceive={() => openHeroAction('receive')}
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

  const metricsGrid = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        label="Agents connected"
        value={String(overview?.metrics.connectedAgents ?? 0)}
        href="/agents"
        icon={<AgentMarkIcon />}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
      />
      <MetricCard
        label="Monthly agent spend"
        value={formatCompactCurrency(monthlySpend, currency)}
        footer="Current calendar month"
        href="/transactions?direction=out"
        icon={<SpendIcon />}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
      />
      <MetricCard
        label="Successful transactions"
        value={String(overview?.metrics.successfulTransactions ?? 0)}
        footer="All time"
        href="/transactions"
        icon={<CheckIcon />}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
      />
      <MetricCard
        label="Active accounts"
        value={String(overview?.metrics.activeAccounts ?? accounts.length)}
        href="/accounts"
        icon={<WalletIcon />}
        loading={false}
      />
    </div>
  )

  const activityGrid = (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
      <AgentsSection
        overview={overview}
        budgetRemaining={budgetRemaining}
        attentionItems={attentionItems}
        currency={currency}
        accountNames={accountNames}
        hasAnyAgents={agents.length > 0}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
        onRetry={refetchOverview}
        onConnectAgent={openConnectAgent}
      />
      <ActivitySection
        activity={overview?.activity ?? []}
        accountCount={accounts.length}
        hasAccounts={accounts.length > 0}
        loading={overviewInitialLoading}
        unavailable={overviewUnavailable}
        onRetry={refetchOverview}
      />
    </div>
  )

  return (
    <div className="max-w-6xl">
      <PageHeader title="Dashboard" subtitle="Your money, agents, and actions at a glance." />

      {/*
        Hide metrics + activity only for a brand-new user (no progress at
        all). Once any step is done, the full dashboard renders alongside
        the checklist so the user can see their progress against the rest
        of the dashboard.
      */}
      {(() => {
        const showGuide = showOnboardingGuide
        // Focused first-run view: hero + checklist only, no metrics/activity.
        // Triggered when the user hasn't funded their account yet — agent and
        // payment steps need funded state to be useful.
        const isFocusedView = showGuide && !hasFunds
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
              {heroPanel}
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
              {heroPanel}
              {attentionPanel}
            </div>
            {guide}
            {metricsGrid}
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
