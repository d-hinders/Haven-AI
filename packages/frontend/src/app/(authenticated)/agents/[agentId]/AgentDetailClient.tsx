'use client'

import { ArrowRight, EllipsisVertical } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { useAgents } from '@/hooks/useAgents'
import {
  useAgentActivity,
  isPaymentActivityItem,
} from '@/hooks/useAgentActivity'
import { useDashboardOverview } from '@/hooks/useDashboardOverview'
import { useDelegateBalance } from '@/hooks/useDelegateBalance'
import { getChainConfig, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { timeAgo } from '@/lib/format'
import { formatAgentLastActivity, formatAgentLastActivityTitle } from '@/lib/agent-last-seen'
import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '@/lib/agent-pause-copy'
import {
  FINISH_REVOKING_LABEL,
  HALF_REVOKED_BODY,
  HALF_REVOKED_TITLE,
  HALF_REVOKED_UNLINKED_BODY,
  canFinishRevoking,
  isHalfRevoked,
} from '@/lib/half-revoked'
import {
  STRANDED_FUNDS_TITLE,
  reviewStrandedPaymentsLabel,
  strandedFundsCauseWithLocation,
} from '@/lib/stranded-funds-copy'
import {
  agentStatusPresentation,
} from '@/lib/payment-status'
import EditAgentModal from '@/components/EditAgentModal'
import LabelsManagerModal from '@/components/LabelsManagerModal'
import { LabelChipRow } from '@/components/haven/LabelChip'
import DelegationBudgetCard, { DELEGATION_BUDGET_CARD_ID } from '@/components/DelegationBudgetCard'
import AgentPassportCard from '@/components/AgentPassportCard'
import {
  MCP_NOT_RECORDED_NOTE,
  McpServerName,
  hasUnrecordedMcpServerName,
} from '@/components/agent-panel/McpServerName'
import PaymentCredentialsModal from '@/components/PaymentCredentialsModal'
import { RemoveAgentDialog } from '@/components/agent-panel/RemoveAgentDialog'
import { ReplaceSigningKeyModal } from '@/components/agent-panel/ReplaceSigningKeyModal'
import { TaxDeclarationToggle } from '@/components/agent-panel/TaxDeclarationToggle'
import { useAgentPassport } from '@/hooks/useAgentPassport'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { Tabs } from '@/components/ui/Tabs'
import { Monogram } from '@/components/ui/Monogram'
import { BackLink } from '@haven_ai/ui/BackLink'
import { Row } from '@/components/ui/Row'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Skeleton } from '@/components/ui/Skeleton'
import AgentActivityTab from './AgentActivityTab'
import AgentToolCallsTab from './AgentToolCallsTab'
import {
  ApprovalRequiredBanner,
} from '@/components/haven'

/** The page's tabs; `activity` is the default and the unknown-value fallback. */
type AgentTab = 'activity' | 'tool-calls' | 'settings'

function agentTabFromUrl(raw: string | null): AgentTab {
  return raw === 'tool-calls' || raw === 'settings' ? raw : 'activity'
}

interface Props {
  agentId: string
}

/**
 * Anchor for the "Activity" section (#2196): the recoverable-funds banner
 * scrolls here rather than opening anything (scroll-don't-open).
 *
 * **What this link claims, and what it deliberately does not.** The
 * recoverable-funds banner sits near the top of the page; the rows that carry
 * the `Needs attention` badge are ~1200px below it at 1280, past the passport
 * card and the whole budget card. Nothing connected them.
 *
 * The connection drawn here is NAVIGATIONAL — "the payments this warning is
 * about are down there, and there are N of them". It is NOT attributive, and
 * that is a fact about the data rather than a matter of taste:
 *
 * - The banner's figure is the delegate EOA's **live USDC balance**
 *   (`GET /agents/:id/delegate-balance` → `routes/agents.ts`, an on-chain
 *   `getTokenBalance` read). No field anywhere apportions that balance to a
 *   payment intent, and none of `payment_intents`,
 *   `machine_payment_reconciliation_events` or the activity projection carries
 *   a per-intent stranded amount.
 * - `unsettledPayments` can hold more than one row (the reconciliation upsert
 *   is unique per `(payment_intent_id, event_type)`, not per agent), so there
 *   is not always a "the" payment to point at.
 * - A partially swept balance, or a balance left over from an earlier
 *   incident, would make a per-payment claim simply false.
 *
 * So the banner does not say "this 8.00 USDC came from that payment", and the
 * activity row does not grow a Recover button implying its own funds are the
 * recoverable ones. Both would be inventing a link the data cannot support.
 */
const AGENT_ACTIVITY_SECTION_ID = 'agent-activity'

type PendingAction = 'pause' | 'resume' | 'restore' | null

export default function AgentDetailClient({ agentId }: Props) {
  const { user } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeTab = agentTabFromUrl(searchParams.get('tab'))
  // #4227: a Tool-calls payment link lands here — `?tab=activity&paymentId=…`.
  // Read once and handed to the Activity tab, which opens the payment's
  // detail panel and then consumes it (clearPaymentLink).
  const openPaymentId = searchParams.get('paymentId')
  const {
    agents,
    loading,
    error: agentsError,
    pauseAgent,
    resumeAgent,
    revokeAgent,
    archiveAgent,
    unarchiveAgent,
    markBudgetEnded,
    refetch,
  } = useAgents()
  const agent = agents.find((item) => item.id === agentId) ?? null
  const account = useMemo(
    () => user?.accounts.find((item) => item.id === agent?.account_id) ?? null,
    [agent?.account_id, user?.accounts],
  )
  const chainId = account?.chain_id ?? agent?.account_chain_id ?? DEFAULT_CHAIN_ID
  const chainConfig = useMemo(() => {
    try {
      return getChainConfig(chainId)
    } catch {
      return null
    }
  }, [chainId])
  // The merged read stays for the page's own consumers — the banners'
  // attention filter and ReplaceSigningKeyModal's recent payments. The Tool
  // calls tab (#4227) reads #4229's kinded population instead.
  const { activity } = useAgentActivity(agent?.id ?? null)
  // #4226: the hero's Last 30 days reads the dashboard overview — the same
  // source #4209's card footer uses, the way the account page reads it. A
  // revoked (or otherwise uncovered) agent is not in the response; the hero
  // then renders no column at all.
  const { data: overview, loading: overviewLoading } = useDashboardOverview()
  const overviewAgent = overview?.agents.find((item) => item.id === agentId) ?? null

  // #3696: the figures the former stat cards showed are GONE with the old
  // Activity header — the tab's own toolbar count (#4226) replaced them, and
  // the per-token `stats` aggregate has no reader left on this page.
  const unsettledPayments = useMemo(
    () => activity
      .filter(isPaymentActivityItem)
      .filter((item) => item.payment_attention_reason === 'merchant_retry_rejected_after_payment'),
    [activity],
  )
  // Gate recovery UI on the delegate EOA actually holding *recoverable* funds — not
  // on a funded-but-unsettled payment record (which can linger after a sweep), and
  // specifically on USDC, since the gasless recovery path is USDC-only. #1403:
  // the read is status-agnostic now — revoked agents resolve too, and that is
  // the POINT: the sequence that strands delegate funds (agent misbehaving
  // mid-x402 → revoke) is the one that needs the recovery banner. Legacy Safe
  // records can also retain a delegate wallet, so the read stays available on
  // every agent detail page; a missing/unsupported delegate degrades silently.
  const { balance: delegateBalance, hasRecoverableUsdc, hasBelowMinimumUsdc } = useDelegateBalance(
    agent?.id ?? null,
  )
  // #1098: the human field can be absent while atomic is set (a partial API
  // response mid-load) — "Recover undefined USDC" is worse than the generic
  // copy, so the summary requires BOTH fields.
  const strandedSummary =
    delegateBalance && delegateBalance.usdc_atomic !== '0' && delegateBalance.usdc
      ? `${delegateBalance.usdc} USDC`
      : null
  const [editOpen, setEditOpen] = useState(false)
  const [credentialsOpen, setCredentialsOpen] = useState(false)
  const [rotatedKeyPatch, setRotatedKeyPatch] = useState<{ api_key: string; api_key_prefix: string } | null>(null)
  const openEditAgent = () => {
    setEditOpen(true)
  }
  const closeEdit = () => {
    setEditOpen(false)
  }
  // #2196: scroll-don't-open — see AGENT_ACTIVITY_SECTION_ID.
  // #4226: "Review the payment(s)" now selects the Activity tab first (the
  // rows live behind it) and scrolls once the panel is mounted. A pending
  // flag survives the router round-trip: the effect fires on the tab change,
  // finds the section, scrolls, and only then stands down.
  const [scrollToActivityPending, setScrollToActivityPending] = useState(false)
  useEffect(() => {
    if (!scrollToActivityPending || activeTab !== 'activity') return
    const target = document.getElementById(AGENT_ACTIVITY_SECTION_ID)
    if (!target) return
    setScrollToActivityPending(false)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [scrollToActivityPending, activeTab])
  const reviewStrandedPayments = () => {
    setScrollToActivityPending(true)
    if (activeTab !== 'activity') {
      router.replace(`/agents/${encodeURIComponent(agentId)}?tab=activity`, { scroll: false })
    }
  }
  const scrollToActivity = reviewStrandedPayments

  // #4226: the page owns `?tab=` (the account page's pattern). `activity` is
  // the default and carries no parameter; the replace names ONLY the tab, so
  // switching tabs clears the tab's filters — the same rule the account page
  // applies. `?grant=` is the budget card's own parameter and is read from
  // the window there, so it survives until consumed regardless of the tab.
  const handleTabChange = (tab: AgentTab) => {
    if (tab === activeTab) return
    router.replace(
      tab === 'activity'
        ? `/agents/${encodeURIComponent(agentId)}`
        : `/agents/${encodeURIComponent(agentId)}?tab=${tab}`,
      { scroll: false },
    )
  }
  // #4227: the Tool calls tab's payment link — selects the Activity tab and
  // carries the payment's id. Only the tab and the id are written; the
  // Activity tab's own filters are the Activity tab's state and a tab switch
  // clears them anyway (the rule above).
  const openPayment = useCallback(
    (paymentId: string) => {
      router.replace(
        `/agents/${encodeURIComponent(agentId)}?tab=activity&paymentId=${encodeURIComponent(paymentId)}`,
        { scroll: false },
      )
    },
    [agentId, router],
  )
  // #4227: the Activity tab consumed (or failed to open) the linked payment —
  // strip ONLY the parameter, preserving the tab and the Activity tab's filter
  // state, so a re-render or filter write cannot re-open the panel.
  const clearPaymentLink = useCallback(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (!url.searchParams.has('paymentId')) return
    url.searchParams.delete('paymentId')
    router.replace(`${url.pathname}${url.search}`, { scroll: false })
  }, [router])
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  // #3542: the Remove dialog in finish mode — ends the remaining budget of a
  // revoked/archived agent and, unlike Remove, keeps the user on this page.
  const [finishOpen, setFinishOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [replaceKeyOpen, setReplaceKeyOpen] = useState(false)
  const [labelsManagerOpen, setLabelsManagerOpen] = useState(false)


  // #1701/#1699: only an anchored attestation is retired and reissued. Pending
  // or failed issuance will read the new delegate if it anchors after re-key.
  const { passport } = useAgentPassport(agentId)

  const isActive = agent?.status === 'active'
  const isPaused = agent?.status === 'paused'
  const isRevoked = agent?.status === 'revoked'
  const isArchived = Boolean(agent?.archived_at)
  // #3549: revoked OR removed — no budget can be granted, raised or shared
  // (the Spending card offers no Add budget for one). Keyed on exactly these
  // two states, never on "not active":
  // a pending_approval agent's FIRST grant is what activates it.
  const isRetired = isRevoked || isArchived

  if (loading) {
    return (
      <div className="max-w-5xl">
        {/* The way back exists in every state of the page (#4028), and sits
            OUTSIDE the live region so it is not announced as loading text. */}
        <BackLink href="/agents" label="Agents" className="mb-4" />
        <div role="status" aria-busy="true" aria-live="polite" aria-label="Loading agent details" className="space-y-4">
          <Skeleton variant="text" className="h-6 w-40" />
          <Skeleton className="h-24 rounded-xl" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-28 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="max-w-3xl">
        <BackLink href="/agents" label="Agents" className="mb-4" />
        <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-8 text-center shadow-card">
          <h1 className="text-xl font-semibold text-[var(--v2-ink)]">
            {agentsError ? 'Agent could not load' : 'Agent not found'}
          </h1>
          <p className="mt-2 text-sm text-[var(--v2-ink-2)]">
            {agentsError
              ? 'Haven could not load this agent right now. Try again before assuming it was removed.'
              : 'This agent may have been removed or you may no longer have access to it.'}
          </p>
          {agentsError ? (
            <Button className="mt-5" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  const currentAgent = rotatedKeyPatch ? { ...agent, ...rotatedKeyPatch } : agent
  const walletName = currentAgent.account_name ?? account?.name ?? 'Unassigned Haven wallet'
  const networkName = chainConfig?.name ?? 'Unknown network'
  // #796/#804: recipients bind per token — the card gets EVERY configured
  // token (a picker appears only when there is more than one).
  // #2473: the token options a FIRST budget is granted from come from the
  // chain, not from the agent's existing budgets. `allowances` is a view
  // projected from ACTIVE delegation rows (#1090), so deriving the options
  // from it meant a brand-new agent offered no tokens, the grant form never
  // rendered, and the page's "Add budget" button scrolled to nothing.
  //
  // A budget delegation is metered per ERC-20 token, so native tokens (no
  // token address in the registry) are not grantable and are left out.
  // Existing budgets are then unioned in so a delegation on a token outside
  // the chain registry still resolves its symbol and decimals in the list.
  const budgetTokenOptions: Array<{ address: string; symbol: string; decimals: number }> = []
  const seenBudgetTokens = new Set<string>()
  for (const token of Object.values(chainConfig?.tokens ?? {})) {
    if (!token.address) continue
    budgetTokenOptions.push({ address: token.address, symbol: token.symbol, decimals: token.decimals })
    seenBudgetTokens.add(token.address.toLowerCase())
  }
  for (const allowance of currentAgent.allowances) {
    const address = allowance.token_address
    if (!address || seenBudgetTokens.has(address.toLowerCase())) continue
    const cfg = Object.values(chainConfig?.tokens ?? {}).find((t) => t.symbol === allowance.token_symbol)
    // Only a token the registry knows can be sized correctly; without decimals
    // the amount would be parsed at the wrong scale, so an unknown token is
    // left out of the picker rather than guessed at.
    if (!cfg) continue
    budgetTokenOptions.push({ address, symbol: cfg.symbol, decimals: cfg.decimals })
    seenBudgetTokens.add(address.toLowerCase())
  }
  const agentStatus = agentStatusPresentation(currentAgent.status)
  const halfRevoked = isHalfRevoked(currentAgent)
  const canFinish = canFinishRevoking(currentAgent)

  async function handlePause() {
    setPendingAction('pause')
    setErrorMessage(null)
    try {
      await pauseAgent(currentAgent.id)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Pause failed')
    } finally {
      setPendingAction(null)
    }
  }

  async function handleResume() {
    setPendingAction('resume')
    setErrorMessage(null)
    try {
      await resumeAgent(currentAgent.id)
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Resume failed')
    } finally {
      setPendingAction(null)
    }
  }

  // #1402: restores list placement only — the agent stays revoked. Runs
  // under pendingAction so a double-click can't fire unarchive twice and
  // paint a false failure over a restore that already succeeded.
  async function handleRestore() {
    setPendingAction('restore')
    setErrorMessage(null)
    try {
      await unarchiveAgent(currentAgent.id)
    } catch {
      setErrorMessage('The agent could not be restored to the list')
    } finally {
      setPendingAction(null)
    }
  }

  // One predicate, read twice: the badge's presence IS one of the reasons the
  // actions slot can or cannot be inlined, so the two must never drift apart
  // (#2821 review).
  const showsStatusBadge = currentAgent.status !== 'active'

  // #3694: the per-state action matrix. Archived dominates — any agent with
  // `archived_at`, including the unlinked shape that is still `active` (an
  // unlinked agent can be archived without being revoked), gets Restore and
  // never Remove, Pause or Resume. The kebab renders for EVERY state, so the
  // terminal action always has a home; before #3694 it was hidden for revoked
  // agents and Remove/Restore lived only in a footer below the fold.
  const showPause = isActive && !isArchived
  const showResume = isPaused && !isArchived
  // Edit and labels keep their pre-#3694 gate: a revoked agent's kebab used to
  // be hidden outright, and `EditAgentModal` is still not mounted for one.
  const canEditDetails = !isRevoked
  // A revoked or removed agent has no credential to show or key to replace.
  const canManageCredentials = !isRevoked && !isArchived
  // Inline ONLY when the slot really is one icon-only control (#2821).
  //
  // The first version passed this unconditionally, on the reasoning that
  // "the badge renders null while the agent is active" — true for an active
  // agent and false for exactly the state a user opens this page to check.
  // Rendered for a paused agent at 390px the badge took x≈250–310 and the
  // kebab x≈322–367, leaving the title ~200px of a 342px content width, and a
  // name as short as "Data-feed agent" wrapped to two lines.
  //
  // Two controls want the stacking the default gives them. One does not. Since
  // #3694 Pause and Resume sit beside the kebab, so an active agent's slot is
  // two controls as well. The one state left with a lone kebab is the
  // archived-unlinked agent: still `active` (no badge), archived (no Pause).
  const inlineHeaderActions = !showsStatusBadge && !showPause && !showResume
  // The one status sentence the old rules footer carried that nothing else on
  // the page says (#3694, moved from the footer). The half-revoked variant is
  // not repeated: the half-revoked banner's title states it, directly below.
  // The paused/active variants went — the badge and the paused banner say them.
  const retiredStatusLine = isRetired && !halfRevoked
    ? 'This agent no longer has access through Haven.'
    : null

  return (
    <div className="max-w-5xl">
      <PageHeader
        back={{ href: '/agents', label: 'Agents' }}
        leading={<Monogram name={currentAgent.name} size="md" decorative />}
        title={currentAgent.name}
        subtitle={currentAgent.description || undefined}
        // #3694: the identity row that was the "About this agent" card —
        // wallet, network, created, last activity — as the header's quiet
        // meta line (#3692's slot). "Last activity" stays `mcp_last_seen_at`:
        // the agents read carries no last-payment field.
        meta={
          // Each fact is one unbreakable segment, so a narrow header wraps
          // BETWEEN facts — never "· Last / activity 2h ago" (#3694 design
          // review, at 390px).
          <>
            {/* The wallet name is user-chosen and can be long, so it may
                wrap; the short facts after it stay whole. */}
            <span>{walletName}</span> ·{' '}
            <span className="whitespace-nowrap">{networkName}</span> ·{' '}
            <span className="whitespace-nowrap">
              Created{' '}
              {/* Its own node: the product-routes visual spec proves the frozen
                  clock by finding the created age as exact text (#2318). */}
              <span>{timeAgo(currentAgent.created_at)}</span>
            </span>{' '}
            ·{' '}
            <span
              className="whitespace-nowrap v2-tabular"
              title={formatAgentLastActivityTitle(currentAgent.mcp_last_seen_at)}
            >
              {formatAgentLastActivity(currentAgent.mcp_last_seen_at)}
            </span>
          </>
        }
        inlineActions={inlineHeaderActions}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {showsStatusBadge ? (
              <StatusBadge tone={agentStatus.tone}>
                {agentStatus.label}
              </StatusBadge>
            ) : null}
            {showPause ? (
              <Button
                onClick={() => void handlePause()}
                disabled={pendingAction !== null}
                variant="ghost"
                // `lg` (44px) so the pair matches the kebab beside it; `sm`
                // painted 36px next to a 44px square (#3694 design review).
                size="lg"
              >
                {pendingAction === 'pause' ? 'Pausing…' : 'Pause payments'}
              </Button>
            ) : null}
            {showResume ? (
              <Button
                onClick={() => void handleResume()}
                disabled={pendingAction !== null}
                size="lg"
              >
                {pendingAction === 'resume' ? 'Resuming…' : 'Resume agent'}
              </Button>
            ) : null}
            {/* Restore runs from a menu that closes on select, so the old
                footer button's "Restoring…" label has no control to live on.
                Shown here instead, beside the (disabled) trigger. The live
                region is ALWAYS mounted and only its text changes — a region
                that appears already holding text is announced unreliably
                (#3694 review); the visible copy is hidden from assistive tech
                so it is not read twice. */}
            <span role="status" className="sr-only">
              {pendingAction === 'restore' ? 'Restoring…' : ''}
            </span>
            {pendingAction === 'restore' ? (
              <span aria-hidden="true" className="v2-text-meta text-[var(--v2-ink-3)]">
                Restoring…
              </span>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Agent options"
                disabled={pendingAction !== null}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] text-[var(--v2-ink-2)] transition-colors hover:border-[var(--v2-border-strong)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Icon icon={EllipsisVertical} className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {canEditDetails ? (
                  <DropdownMenuItem onSelect={openEditAgent}>
                    Edit agent
                  </DropdownMenuItem>
                ) : null}
                {canEditDetails ? (
                  <DropdownMenuItem onSelect={() => setLabelsManagerOpen(true)}>
                    Manage labels
                  </DropdownMenuItem>
                ) : null}
                {canManageCredentials ? (
                  <DropdownMenuItem onSelect={() => setCredentialsOpen(true)}>
                    Payment credentials
                  </DropdownMenuItem>
                ) : null}
                {canManageCredentials ? (
                  <DropdownMenuItem onSelect={() => setReplaceKeyOpen(true)}>
                    Replace signing key
                  </DropdownMenuItem>
                ) : null}
                {canEditDetails ? <DropdownMenuSeparator /> : null}
                {isArchived ? (
                  // #1402: restores list placement only — the agent stays revoked.
                  <DropdownMenuItem onSelect={() => void handleRestore()}>
                    Restore to list
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem tone="danger" onSelect={() => setRemoveOpen(true)}>
                    Remove agent…
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      {/* Labels (#3167): the chips this agent carries, under the title block.
          Display only — the editor (Edit agent) and the vocabulary manager
          (Manage labels, in the menu) are where labels change. Renders nothing
          for an unlabelled agent. */}
      {currentAgent.labels.length > 0 && (
        <div className="mt-1.5">
          <LabelChipRow labels={currentAgent.labels} />
        </div>
      )}

      {retiredStatusLine ? (
        <p className="mt-1.5 v2-text-meta text-[var(--v2-ink-3)]">{retiredStatusLine}</p>
      ) : null}

      {/* #3694: ONE banner slot, directly under the header, ordered by the
          detail-page rule in docs/product/design-system.md (#3692): danger,
          then warning, then neutral; within a tone, the banner asking for a
          decision first. So: the last action's failure (it answers the click
          the user just made in the header), half-revoked (Finish revoking),
          recoverable funds (Recover funds), the refresh error, paused, then
          the recovery minimum. Tones and copy are unchanged; only the
          position moved. `empty:hidden` drops the slot's margin when no
          banner applies (React renders nothing for each null child). */}
      <div className="mb-6 mt-4 flex flex-col gap-4 empty:hidden" data-testid="agent-banner-slot">
      {errorMessage ? (
        <div className="rounded-xl border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3">
          <p className="text-sm font-medium text-[var(--v2-danger)]">Action failed</p>
          <p className="mt-1 text-sm text-[var(--v2-danger)]">{errorMessage}</p>
        </div>
      ) : null}

      {/* #3542: revoked or removed, but a budget delegation is still redeemable
          on-chain — the status badge says "Revoked", which is only half true.
          First warning in the slot: it carries the one action that ends it. */}
      {halfRevoked ? (
        <div data-testid="half-revoked-callout">
          <ApprovalRequiredBanner title={HALF_REVOKED_TITLE} tone="warning" density="compact">
            <span>{canFinish ? HALF_REVOKED_BODY : HALF_REVOKED_UNLINKED_BODY}</span>
            {canFinish ? (
              <div className="mt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFinishOpen(true)}
                  disabled={pendingAction !== null}
                >
                  {FINISH_REVOKING_LABEL}
                </Button>
              </div>
            ) : null}
          </ApprovalRequiredBanner>
        </div>
      ) : null}

      {hasRecoverableUsdc ? (
        <div>
          <ApprovalRequiredBanner title={STRANDED_FUNDS_TITLE} tone="warning" density="compact">
            <span>
              {/* #2195: the cause clause is shared with `AgentCard` and count-aware
                  here because this surface holds the LIST, not an EXISTS. */}
              {unsettledPayments.length > 0
                ? strandedFundsCauseWithLocation(unsettledPayments.length)
                : 'Your agent’s wallet is holding funds that weren’t spent.'}{' '}
              {strandedSummary
                ? `Recover ${strandedSummary} to your Haven wallet.`
                : 'Recover it to your Haven wallet.'}
            </span>
            {/* #2203: was a hand-rolled `<a className="px-2.5 py-1 text-xs">` —
                a ~24 CSS px control on the money-recovery path, and the ONLY CTA
                inside an `ApprovalRequiredBanner` in the product app that was not
                already a `Button` (the others: `ReceiveDialog.tsx` "Refresh
                page"). Routed through the primitive so it inherits #1726's 44px
                tap-target overlay rather than restating the rule. Brand fill
                rather than the old solid `--v2-warning`, matching the recovery
                affordance in the same-tone banner in `RemoveAgentDialog.tsx`:
                the banner carries the severity, the button carries the action. */}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                href={`/agents/${agentId}/sweep`}
                size="sm"
                trailingIcon
                aria-label="Recover funds to your Haven wallet"
              >
                Recover funds
              </Button>
              {/* #2196: the connection between this warning and the rows that
                  caused it — NAVIGATIONAL only, deliberately. See the comment on
                  AGENT_ACTIVITY_SECTION_ID.

                  `ghost`, not `tertiary`: `tertiary` is transparent with no
                  resting chrome, so against the banner's `--v2-warning-soft`
                  fill it read as prose rather than as a control
                  (`haven-design-reviewer` on this change, off the 1280 and 390
                  captures). `ghost` is also the variant the ONE other `Button`
                  inside an `ApprovalRequiredBanner` uses — `ReceiveDialog`'s
                  "Refresh page". It stays a `Button` rather than becoming an
                  inline link so it keeps #1726's 44px hit area: a second
                  control in this banner at 24px would be the defect #2203 was
                  filed about, one row down. */}
              {unsettledPayments.length > 0 ? (
                <Button variant="ghost" size="sm" onClick={scrollToActivity}>
                  {reviewStrandedPaymentsLabel(unsettledPayments.length)}
                </Button>
              ) : null}
            </div>
          </ApprovalRequiredBanner>
        </div>
      ) : null}

      {agentsError ? (
        <div
          role="alert"
          className="rounded-lg border border-warning/30 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-ink-2)]"
        >
          Agent data could not refresh. This page is showing the last loaded record.
          <Button className="ml-2" size="sm" variant="ghost" onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : null}

      {isPaused ? (
        <div>
          {/* #2230: title and body come from `lib/agent-pause-copy.ts`, shared
              with `AgentCard`'s banner one click away. This page's wording is
              the one that was TAKEN — the card said "network permissions" for
              the same fact; see that module for why this one is the settled
              phrasing. The rendered sentence here is byte-identical to what
              stood before. */}
          <ApprovalRequiredBanner title={AGENT_PAUSED_TITLE} tone="neutral" density="compact">
            {AGENT_PAUSED_BODY}
          </ApprovalRequiredBanner>
        </div>
      ) : null}

      {hasBelowMinimumUsdc && delegateBalance ? (
        <div>
          <ApprovalRequiredBanner title="Recovery minimum not met" tone="neutral" density="compact">
            Your agent’s wallet is holding {strandedSummary ?? 'USDC'} below the {delegateBalance.sweep_min_usdc} USDC recovery minimum. More stranded funds can bring the balance up to the minimum.
          </ApprovalRequiredBanner>
        </div>
      ) : null}
      </div>

      {/* #3694: the budget card leads the content. #2821 reordered it above an
          "About this agent" card on phones with `order-*` classes; that card's
          facts now live in the header's meta line, so there is nothing left to
          reorder and DOM order is reading order again at every width. */}
      <div id={DELEGATION_BUDGET_CARD_ID} className="scroll-mt-24">
        <DelegationBudgetCard
          agentId={agentId}
          chainId={chainId}
          tokens={budgetTokenOptions}
          agentName={currentAgent.name}
          onBudgetChange={refetch}
          retired={isRevoked ? 'revoked' : isArchived ? 'archived' : undefined}
          agentStatus={currentAgent.status}
          stats={overviewAgent?.stats ?? null}
          statsLoading={overviewLoading}
        />
      </div>

      {/* #3426: the per-agent x402 tax declaration opt-in moved into the
          "Identity and settings" card below (#3697) — the toggle owns its own
          row and divider there. The opt-in is settings, not authority: it
          changes no budget, no rule, and no key. */}

      {/* #3697: the old standalone Backup & recovery card moved into the
          "Identity and settings" card below — same link, new wording. */}

      {/* #3696: the two stat cards ("All-time transactions" / "Today") are
          gone for good — #3696 moved their figures into the Activity header's
          summary line; #4226 replaced that header with the tab's own toolbar
          count, which describes the FILTERED set from #4229's `total`.
          #2106's rule stands: nothing renders a counter that can only read 0.
          The wire field survives per the #2055 compatibility convention. */}

      {/* #4226: the tab row — the page owns `?tab=` (activity default,
          tool-calls, settings; an unknown value falls back to Activity). No
          counts: the numbers a reader wants (the toolbar's) live on the
          panels, not the tabs. The Activity tab carries the amber dot while
          unsettled payments exist — the same condition the recoverable-funds
          banner above reads, so the dot is the banner's rows, named where
          they live. */}
      <div className="mt-6">
        <Tabs
          tabs={[
            { value: 'activity', label: 'Activity', warningDot: unsettledPayments.length > 0 },
            { value: 'tool-calls', label: 'Tool calls' },
            { value: 'settings', label: 'Settings' },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          ariaLabel="Agent"
        />
      </div>

      {/* ── Activity tab: the agent's own payments, failed and pending
          included, drawn with the shared ledger pieces over #4229's kinded
          read. NOT the wallet-scoped transactions feed — that is a different
          population and would drop payments refused before they reached the
          chain (routes/transactions.ts). openPaymentId/#4227: a Tool-calls
          payment link landed here; the tab opens the shared detail panel for
          it and clears the parameter. */}
      {activeTab === 'activity' ? (
        <div id={AGENT_ACTIVITY_SECTION_ID} className="mt-6 scroll-mt-24" data-testid="agent-activity-section">
          <AgentActivityTab
            agentId={agentId}
            agentName={currentAgent.name}
            walletName={walletName}
            needsSetup={currentAgent.status === 'pending_approval'}
            openPaymentId={activeTab === 'activity' ? openPaymentId : null}
            onPaymentOpened={clearPaymentLink}
          />
        </div>
      ) : null}

      {/* ── Tool calls tab (#4227): the MCP audit log rebuilt — plain-language
          labels with the raw tool name as code, day bands, ×N repeat folding
          over the loaded list, server-filtered Result/Period/search on
          #4229's kinded read, and a payment link per money-touching call. */}
      {activeTab === 'tool-calls' ? (
        <div className="mt-6" data-testid="agent-tool-calls-section">
          <AgentToolCallsTab agentId={agentId} onOpenPayment={openPayment} />
        </div>
      ) : null}

      {/* ── Settings tab (#4226): today's Identity and settings card,
          unchanged — #4228 rebuilds it. */}
      {activeTab === 'settings' ? (
        <div className="mt-6" data-testid="agent-settings-section">
      {/* #3697: the page's optional and account-level items — the Agent
          Passport row, the MCP server name row (#4209), the tax declaration row (rendered only when company
          details are VIES-valid; the toggle owns its own row and divider) and
          the Backup & recovery pointer — as ONE quiet card at the bottom. The
          detail-page section rule (#3692): the heading sits above the card;
          the card holds the rows. Each row renders its own `Card.Section`
          divided wrapper so a hidden row leaves no orphan divider. */}
      <section className="mt-6" data-testid="identity-settings-section">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-[var(--v2-ink)]">Identity and settings</h2>
          <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
            Optional records and account-level settings for this agent.
          </p>
        </div>
        <Card hover={false}>
          <AgentPassportCard
            agentId={agentId}
            agentRevoked={isRevoked}
          />

          {/* #4209: the MCP server name moved here from the `/agents` card
              (#1878) — which hosted+signer pair this agent is wired as, with
              its copy button and tooltip. The `not recorded` note (#2043)
              moved with it: visible text beside the bare label, never a
              tooltip, and only when this agent has no recorded name. */}
          <Card.Section divided>
            <div className="px-4 py-4 md:px-6 md:py-5" data-testid="mcp-server-name-row">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <h3 className="text-base font-semibold text-[var(--v2-ink)]">MCP server name</h3>
                <McpServerName value={currentAgent.mcp_server_name} />
              </div>
              {hasUnrecordedMcpServerName([currentAgent]) ? (
                <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-3)]">
                  {MCP_NOT_RECORDED_NOTE}
                </p>
              ) : (
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                  The name of this agent&apos;s Haven servers in its MCP config.
                </p>
              )}
            </div>
          </Card.Section>

          <TaxDeclarationToggle
            agentId={agentId}
            taxDeclarationEnabled={currentAgent.tax_declaration_enabled}
            onAgentsChanged={() => void refetch()}
          />

          {/* #1089: backup & recovery moved to the account page — it's an
              account capability, not an agent one. This is a pointer, not a
              second copy of the controls. */}
          {account ? (
            <Card.Section divided>
              <Row
                href={`/accounts/${account.id}`}
                title="Backup & recovery"
                subtitle={`Managed on ${account.name}: it covers every agent on it`}
                trailing={<Icon icon={ArrowRight} className="h-4 w-4 text-[var(--v2-ink-3)]" />}
              />
            </Card.Section>
          ) : null}
        </Card>
      </section>
        </div>
      ) : null}

      {removeOpen && currentAgent ? (
        <RemoveAgentDialog
          agent={currentAgent}
          chainId={chainId}
          onRevokeCredential={() => revokeAgent(currentAgent.id)}
          onArchive={async () => {
            await archiveAgent(currentAgent.id)
            // The agent is now archived, hidden from the list (#4113) — land the user
            // there rather than on a page whose actions just disappeared.
            router.push('/agents')
          }}
          onBudgetEnded={() => markBudgetEnded(currentAgent.id)}
          onClose={() => setRemoveOpen(false)}
        />
      ) : null}

      {finishOpen && currentAgent ? (
        // Finish mode never navigates: the page is where the owner sees the
        // marker clear. Nothing is archived or restored by it.
        <RemoveAgentDialog
          agent={currentAgent}
          chainId={chainId}
          mode="finish"
          onRevokeCredential={() => revokeAgent(currentAgent.id)}
          onArchive={async () => {}}
          onBudgetEnded={() => markBudgetEnded(currentAgent.id)}
          onClose={() => setFinishOpen(false)}
        />
      ) : null}

      {!isRevoked ? (
        <EditAgentModal
          open={editOpen}
          onClose={closeEdit}
          agent={currentAgent}
          onUpdated={() => {
            refetch()
            setEditOpen(false)
          }}
        />
      ) : null}

      <ReplaceSigningKeyModal
        open={replaceKeyOpen}
        onClose={() => setReplaceKeyOpen(false)}
        agentId={agentId}
        agentName={currentAgent.name}
        chainId={chainId}
        currentDelegateAddress={currentAgent.delegate_address}
        recentPayments={activity.filter(isPaymentActivityItem)}
        hasAnchoredPassport={passport?.status === 'anchored' && passport.attestation_uid !== null}
        onCompleted={() => {
          refetch()
        }}
      />

      {/* Manage labels (#3167): rename, recolour, delete the vocabulary.
          A delete or rename changes what agent reads return, so agents are
          refetched when the manager reports a change. */}
      <LabelsManagerModal
        open={labelsManagerOpen}
        onClose={() => setLabelsManagerOpen(false)}
        onLabelsChanged={() => {
          refetch()
        }}
      />

      <PaymentCredentialsModal
        open={credentialsOpen}
        onClose={() => {
          setCredentialsOpen(false)
          setRotatedKeyPatch(null)
        }}
        agent={currentAgent}
        onKeyRotated={(newKey, newPrefix) => {
          setRotatedKeyPatch({ api_key: newKey, api_key_prefix: newPrefix })
        }}
      />
    </div>
  )
}
