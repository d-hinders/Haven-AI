'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'
import { useAgents } from '@/hooks/useAgents'
import { useAggregatedBalances } from '@/hooks/useAggregatedPortfolio'
import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { useBalances } from '@/hooks/useBalances'
import { useAccountFunding } from '@/hooks/useAccountFunding'
import { useAccountOperationGate } from '@/hooks/useAccountOperationGate'
import { displayName } from '@/lib/user'
import DashboardOnboardingGuide, { SetupCompleteLine } from '@/components/DashboardOnboardingGuide'
import UsingYourAgentInfo from '@/components/UsingYourAgentInfo'
import ConnectAgentModal from '@/components/ConnectAgentModal'
import DashboardActionPickerModal from '@/components/DashboardActionPickerModal'
import ReceiveDialog from '@/components/ReceiveDialog'
import DelegationSendModal from '@/components/DelegationSendModal'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import MoneyPanel from './MoneyPanel'
import { ActivitySection } from './ActivitySection'
import { AgentsSection } from './AgentsSection'
import { resolveDefaultAccount } from '@/lib/default-account'
import {
  attentionEmptyState,
  computeAttentionItems,
  DISMISSIBLE_ATTENTION_KINDS,
  firstRunSetupState,
  type AttentionRuleItem,
} from '@/lib/dashboard-attention'
import { useBudgetRemaining } from '@/hooks/useBudgetRemaining'
import { useAttentionDismissals } from '@/hooks/useAttentionDismissals'
import NeedsYou from './NeedsYou'

// #3127 (finding 6): the per-currency formatting itself lives in ONE place —
// `lib/format.ts`'s `formatFiat`, shared with /accounts and /accounts/[id].
// The dashboard's compact tile wrapper and the signed change/percent helpers
// moved to `dashboard/MoneyPanel.tsx` with the money panel (#3807) — the
// tiles that needed the compact tier are gone.

/** #3818: "Hide for now", per user, holding the completed-step count at hide time. */
const SETUP_GUIDE_HIDDEN_KEY = 'haven-setup-guide-hidden'

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

  // #3808: the "Needs attention" rules read the overview's per-account
  // `needs_backup_recommendation` (#1205) — the server's answer, computed next
  // to the chain classification, so no second copy of "which chains carry
  // value" lives here. The #1153/#1162 RecoveryNudge component is gone; its
  // dismissal key survives as the backup items' dismissal until #3813 owns
  // per-item persistence.

  // The DELEGATION-rail nudge above is untouched — `Who can approve` is live
  // and this is still the rail where new accounts land.
  // #3818: the first-run guide's facts come from the overview through the
  // shared rules module — the same per-account USDC (#3803) and agent list the
  // "Needs attention" rules read, so the guide and the card cannot disagree. Step 1
  // is USDC on the account (agents spend USDC; ETH dust does not count), step 2
  // an agent that can actually pay. `hasFunds` above stays as it is: the hero,
  // the funded toast and the focused view read it.
  const createdAtById = useMemo(
    () => Object.fromEntries(agents.map((agent) => [agent.id, agent.created_at])),
    [agents],
  )
  const firstRun = useMemo(
    () => (overview ? firstRunSetupState(overview, createdAtById) : null),
    [overview, createdAtById],
  )
  const usdcFunded = firstRun?.usdcFunded ?? null
  const hasSetUpAgent = Boolean(firstRun?.hasSetUpAgent)
  const pendingSetupAgent = firstRun?.pendingAgent ?? null
  // #3976: the agent step 2 names, only while step 2 is OPEN. Once a set-up
  // agent completes the step, it names nobody — the waiting agent's own
  // "X is waiting to be set up" row renders instead (in the focused view
  // it is the only place that names it).
  const stepTwoAgent = hasSetUpAgent ? null : pendingSetupAgent
  // #2534: the suggested amount for step 1, from the endpoint `haven wallets
  // funding` prints. Fetched only while the account is known to hold no USDC.
  const { funding: fundingForOnboarding } = useAccountFunding(
    usdcFunded === false ? delegationAccount?.id : undefined,
  )
  const overviewInitialLoading = overviewLoading && !overview
  const firstAgentPaymentKnown = Boolean(overview?.onboardingProgress)
  const hasFirstAgentPayment = Boolean(
    overview?.onboardingProgress?.hasFirstAgentPayment,
  )
  // #3818: the guide no longer waits on the aggregate balance read — a
  // balance error used to hide it — nor on GET /agents, which only orders the
  // waiting agents (a refetch must not flip the card). Its facts are the
  // overview's, and an unknown USDC read is a state the guide shows.
  const setupProgressReady = Boolean(firstRun) && firstAgentPaymentKnown
  // The steps own the card only UNTIL the first agent payment. After it, a
  // regression — USDC spent to zero, an expired budget, an unreadable balance
  // — belongs to the Needs attention rules (#3808), never to "Get started" again.
  const allOnboardingComplete = setupProgressReady && hasFirstAgentPayment

  // #3719: no global active account. The default account pre-selects the
  // hero's Receive / Add funds (which ask when there is more than one) and the
  // connect flow.
  const defaultAccount = useMemo(() => resolveDefaultAccount(accounts), [accounts])
  const hasDelegationAccounts = accounts.length > 0

  // #4094: the dashboard's money verbs are Send / Receive. The owner-send is
  // the DELEGATION rail's (`DelegationSendModal`), reached through the account
  // picker when there is more than one account; the LEGACY Safe send stays
  // retired (#1989, epic #1440) — it was a Safe transaction signed through
  // `SendModal`, and that rail and its hook are deleted. The retired-rail
  // guard from #1987 still holds in rewritten form: the delegation Send is
  // present, and no approvals route renders. The old two-dialog funding pair
  // ("Add funds" + "Deposit address") merged into one Receive dialog.
  // #1079's "hidden, not disabled" mechanism applies to what is gone, not to
  // what is here: nothing dead-ends.

  const [connectAgentOpen, setConnectAgentOpen] = useState(false)
  const [pickerAction, setPickerAction] = useState<'receive' | 'send' | null>(null)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [agentUsageOpen, setAgentUsageOpen] = useState(false)
  // Set true the first time the user opens Receive in this session. Combined
  // with !hasFunds it drives the hero's "Watching for incoming deposits…"
  // hint so the user knows the dashboard is actively listening.
  const [hasOpenedReceive, setHasOpenedReceive] = useState(false)
  const [actionAccountId, setActionAccountId] = useState<string | null>(null)
  // #3818: "Hide for now" survives a reload. Stored per user WITH the number
  // of completed steps at the time; the guide comes back as soon as another
  // step completes. A per-device convenience in browser storage — not the
  // #3813 server store, which holds permanent per-account decisions.
  const [setupHideState, setSetupHideState] = useState<{
    userId: string | null
    hiddenAtCount: number | null
  }>({ userId: null, hiddenAtCount: null })
  const setupHideReady = Boolean(user?.id) && setupHideState.userId === user?.id
  // The "You're set up" line's dismissal IS persisted — once the first agent
  // payment has gone through and the user dismissed that line, it stays gone
  // on reload (key unchanged from the old banner, so earlier dismissals hold).
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

  useEffect(() => {
    if (!user?.id) {
      setSetupHideState({ userId: null, hiddenAtCount: null })
      return
    }
    let hiddenAtCount: number | null = null
    try {
      const stored = window.localStorage.getItem(`${SETUP_GUIDE_HIDDEN_KEY}:${user.id}`)
      const parsed = stored === null ? NaN : Number(stored)
      hiddenAtCount = Number.isInteger(parsed) && parsed >= 0 ? parsed : null
    } catch {
      // Storage blocked (private window): the guide simply shows.
    }
    setSetupHideState({ userId: user.id, hiddenAtCount })
  }, [user?.id])

  // Hidden only while no further step has completed since "Hide for now".
  const completedCount =
    (usdcFunded === true ? 1 : 0) + (hasSetUpAgent ? 1 : 0) + (hasFirstAgentPayment ? 1 : 0)
  const setupHidden =
    setupHideState.hiddenAtCount !== null && completedCount <= setupHideState.hiddenAtCount

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
  // #4307: every nested read is guarded, not just `overview` — a PARTIAL
  // overview body (the screenshot harness's empty fixture answers
  // `/dashboard/overview` with `FIXTURE_EMPTY_FALLBACK`, which carries
  // neither `totals` nor `change`) crashed the client on `.sek`. The child
  // helpers (`dashboard-attention.ts`, `AgentsSection`, `MoneyPanel`) were
  // already defaulting with `??`.
  const totalFiat = currency === 'EUR'
    ? (overview?.totals?.eur ?? 0)
    : currency === 'SEK'
      ? (overview?.totals?.sek ?? 0)
      : (overview?.totals?.usd ?? 0)
  const sekChangeUnavailable = currency === 'SEK' && overview?.change?.sekAmount == null
  const balancesFreshness = overview?.change?.balancesFreshness
  const changeUnavailable = balancesFreshness?.status === 'unavailable'
  const changeAmount = currency === 'EUR'
    ? (overview?.change?.eurAmount ?? 0)
    : currency === 'SEK'
      ? (overview?.change?.sekAmount ?? 0)
      : (overview?.change?.usdAmount ?? 0)
  const changePercent = currency === 'EUR'
    ? (overview?.change?.eurPercent ?? 0)
    : currency === 'SEK'
      ? (overview?.change?.sekPercent ?? 0)
      : (overview?.change?.usdPercent ?? 0)
  const overviewUnavailable = Boolean(overviewError && !overview)
  // Render the guide whenever the user has at least one account and either:
  // (a) the first agent payment hasn't happened and the steps aren't hidden
  //     ("Hide for now", persisted until another step completes), OR
  // (b) the first agent payment has happened and the "You're set up" line
  //     hasn't been dismissed.
  const setupGuideEligible =
    setupProgressReady &&
    hasDelegationAccounts &&
    completeDismissalReady &&
    setupHideReady &&
    !requiresOtherDevice
  // #3818: while setup is in progress the guide IS the "Needs attention" card; once
  // done, one "You're set up" line takes its place until dismissed.
  const showSetupSteps = setupGuideEligible && !allOnboardingComplete && !setupHidden
  const showSetupComplete = setupGuideEligible && allOnboardingComplete && !completeDismissed

  // ── #3808: the "Needs attention" items ─────────────────────────────────────────
  // One definition: `lib/dashboard-attention.ts` — the same rules #3809 (badges)
  // and #3818 (setup guide) import. The panel renders from the last good
  // overview (or the error row when the overview failed); it never renders
  // "nothing needs attention" while the first load is still in flight.
  const {
    data: budgetRemaining,
    loading: budgetRemainingLoading,
  } = useBudgetRemaining()
  // ── #3813: server-saved dismissals ───────────────────────────────────────
  // `useAttentionDismissals` reads and writes them (per account / per
  // agent, permanent, every device) and owns the one-time migration of
  // RecoveryNudge's legacy global key. The hook receives the accounts only
  // once the overview has loaded — a failed load never decides what was
  // "funded at that moment".
  const { acknowledgements, dismiss: dismissOnServer } = useAttentionDismissals({
    accounts: overview?.accounts,
  })
  // Session-only dismissal for everything the rules will re-fire on the next
  // load anyway — the non-dismissible kinds have no server persistence.
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
      acknowledgements,
      dismissedIds: sessionDismissedIds,
      // While the setup guide's "Add USDC" step is open, the guide IS the
      // funds ask — the low-balance and zero-USDC items step aside (#3808).
      // The zero-USDC warning waits while step 1 is open: the step says it.
      holdBackLowBalance: showSetupSteps && usdcFunded !== true,
    })
  }, [overview, budgetRemaining, accountNames, acknowledgements, sessionDismissedIds, showSetupSteps, usdcFunded])
  // #3902: what the card says with no items — decided from measured facts,
  // never from the list being empty, and held back while the budget reads
  // load (an unknown read must not become "agents have room").
  const attentionEmpty = useMemo(
    () =>
      overview
        ? attentionEmptyState({
            overview,
            budgetRemaining: budgetRemaining ?? null,
            budgetRemainingLoading,
            acknowledgements,
          })
        : null,
    [overview, budgetRemaining, budgetRemainingLoading, acknowledgements],
  )
  // The agent step 2 names is not listed twice: while the steps show AND step
  // 2 is open, its "Needs setup" row drops. Other waiting agents keep theirs.
  // #3976: with step 2 complete, `stepTwoAgent` is null, so nothing is
  // dropped and the waiting agent's row renders again (the guide no longer
  // names it, either).
  const cardItems = useMemo(
    () =>
      showSetupSteps && stepTwoAgent
        ? attentionItems.filter((item) => item.id !== `needs-setup:${stepTwoAgent.id}`)
        : attentionItems,
    [attentionItems, showSetupSteps, stepTwoAgent],
  )

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

  function openHeroAction(action: 'receive' | 'send') {
    // No accounts: the money card renders "Create Haven account" instead of
    // these buttons, so this is unreachable from the UI; do nothing rather
    // than open a dialog about nothing.
    if (accounts.length === 0) return

    if (accounts.length > 1) {
      setPickerAction(action)
      return
    }

    setActionAccountId(defaultAccount?.id ?? null)
    if (action === 'receive') {
      setHasOpenedReceive(true)
      setReceiveOpen(true)
    }
    if (action === 'send') setSendOpen(true)
  }

  function handleActionAccountSelected(accountId: string) {
    setActionAccountId(accountId)
    if (pickerAction === 'receive') {
      setHasOpenedReceive(true)
      setReceiveOpen(true)
    }
    if (pickerAction === 'send') setSendOpen(true)
    setPickerAction(null)
  }

  // The hide and dismiss buttons unmount themselves; focus moves to the
  // card's heading (tabIndex -1) rather than dropping to <body>.
  function focusAttentionHeading() {
    window.requestAnimationFrame(() => document.getElementById('needs-attention-heading')?.focus())
  }

  function hideSetupGuide() {
    focusAttentionHeading()
    setSetupHideState({ userId: user?.id ?? null, hiddenAtCount: completedCount })
    if (!user?.id) return
    try {
      window.localStorage.setItem(`${SETUP_GUIDE_HIDDEN_KEY}:${user.id}`, String(completedCount))
    } catch {
      // Storage blocked: hidden for this session only.
    }
  }

  function dismissCompleteBanner() {
    focusAttentionHeading()
    setCompleteDismissalState({ userId: user?.id ?? null, dismissed: true })
    if (typeof window !== 'undefined' && user?.id) {
      window.localStorage.setItem(`haven-onboarding-complete-dismissed:${user.id}`, '1')
    }
  }

  function openAddFundsForAccount(accountId: string) {
    setActionAccountId(accountId)
    setHasOpenedReceive(true)
    setReceiveOpen(true)
  }

  function handleDismissAttention(item: AttentionRuleItem) {
    if (DISMISSIBLE_ATTENTION_KINDS.has(item.kind)) {
      // #3813/#4324: server-saved — a permanent dismissal or an
      // acknowledgement, visible from every device of the same user. The
      // hook is optimistic: the item hides now, and comes back on a failed
      // write.
      dismissOnServer(item)
      return
    }
    setSessionDismissedIds((previous) => new Set(previous).add(item.id))
  }

  // #3807: the money panel replaces the hero + KPI tiles. The focused
  // first-run view (an unfunded account) keeps its spending half: before the
  // first payment that half explains what it will show (#3818's
  // `noPaymentsYet`), never zero tiles — the mockup's new-user card (#3897).
  // Focused only when the account is KNOWN to hold no USDC — a failed
  // balance read must not collapse the page.
  const isFocusedView = showSetupSteps && usdcFunded === false
  const moneyPanel = (
    <MoneyPanel
      loading={overviewInitialLoading}
      unavailable={overviewUnavailable}
      currency={currency}
      totalFiat={totalFiat}
      // #4307: guarded — a partial overview has no `change` at all.
      changeAvailable={Boolean(overview?.change?.available)}
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
      noPaymentsYet={firstAgentPaymentKnown && !hasFirstAgentPayment}
      onReceive={() => openHeroAction('receive')}
      onSend={() => openHeroAction('send')}
      // #4167: the ONE primary-button rule — Send primary once any account
      // holds USDC (`usdcFunded`), Receive primary with Send disabled when
      // known empty, Send primary while the read is loading or failed.
      usdcFunded={usdcFunded}
      // #3902: one primary funding action — while the guide's step 1 is the
      // active step, its "Add funds" is the primary one and the card's
      // "Receive" steps back.
      receiveSecondary={isFocusedView}
    />
  )

  const attentionPanel = attentionVisible ? (
    <NeedsYou
      items={cardItems}
      title={showSetupSteps ? 'Get started' : undefined}
      showCount={!showSetupSteps}
      emptyState={attentionEmpty}
      titleMeta={
        showSetupSteps ? (
          <span className="text-xs text-[var(--v2-ink-3)] v2-tabular">{completedCount} of 3 done</span>
        ) : undefined
      }
      titleAction={
        showSetupSteps ? (
          <Button variant="tertiary" size="sm" onClick={hideSetupGuide}>
            Hide for now
          </Button>
        ) : undefined
      }
      guide={
        showSetupSteps ? (
          <DashboardOnboardingGuide
            usdcFunded={usdcFunded}
            hasSetUpAgent={hasSetUpAgent}
            pendingAgent={stepTwoAgent}
            hasFirstAgentPayment={hasFirstAgentPayment}
            funding={fundingForOnboarding}
            onAddFunds={() => openHeroAction('receive')}
            onAddAgent={openConnectAgent}
            onShowAgentUsage={() => setAgentUsageOpen(true)}
          />
        ) : showSetupComplete ? (
          <SetupCompleteLine onDismiss={dismissCompleteBanner} />
        ) : null
      }
      hasOverviewError={Boolean(overviewError)}
      onRetry={refetchOverview}
      onDismiss={handleDismissAttention}
      onAddFunds={openAddFundsForAccount}
    />
  ) : null

  const activityGrid = (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
      <AgentsSection
        overview={overview}
        budgetRemaining={budgetRemaining}
        budgetRemainingReady={!budgetRemainingLoading}
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
        hasOlderActivity={overview?.hasOlderActivity}
        activityWindowDays={overview?.activityWindowDays}
        activityWindowStart={overview?.activityWindowStart}
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
      {/* #3897: the mockup's order, one column at every width — the heading
          and its 7-day summary with the money panel, then "Needs attention" (and
          the setup guide inside it) at full width, then Agents and Activity.
          The old hero-plus-aside row put this card ("Needs you" then) in a side column beside
          the balance. A brand-new, unfunded user (the focused view) sees the
          money panel and the guide only; the backup and pending-agent items
          that still apply render below the guide's steps (#3808). #3976:
          once a set-up agent completes step 2, that set includes the waiting
          agent's "Needs setup" row — the completed guide names nobody, so
          the row is the only place the agent is named. */}
      <div className="space-y-6">
        {moneyPanel}
        {attentionPanel}
        {isFocusedView ? null : activityGrid}
      </div>

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


      <ReceiveDialog
        open={receiveOpen}
        account={selectedActionAccount}
        // #4167: with several accounts the dialog's card is a picker, so a
        // wrong pre-pick is one switch away; one account renders no card.
        accounts={accounts}
        onClose={() => setReceiveOpen(false)}
      />

      {/*
        Mount the send modal only while open so its wallet hooks
        (useDelegationSend backs wagmi wallet-client subscriptions) don't run
        in the background on every dashboard view — the same pattern the
        account detail page uses. Needs an account with a resolved chain: the
        delegation send signs on a network.
      */}
      {sendOpen && selectedActionAccount?.account_address && selectedActionAccount.chain_id != null && (
        <DelegationSendModal
          open
          onClose={() => setSendOpen(false)}
          accountAddress={selectedActionAccount.account_address}
          chainId={selectedActionAccount.chain_id}
          onSent={refreshDashboardData}
        />
      )}

      <UsingYourAgentInfo
        open={agentUsageOpen}
        onClose={() => setAgentUsageOpen(false)}
      />
    </div>
  )
}
