'use client'

import { Archive, CircleAlert, Clock, LoaderCircle, Network, Plus, Tag } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useCallback, useMemo, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { setupIdFromSearch } from '@/lib/discovery'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { useAgentPanelState } from '@/hooks/useAgentPanelState'
import { useAgentListFilters } from '@/hooks/useAgentListFilters'
import {
  ARCHIVED_FACET,
  BUILT_IN_FACETS,
  SORT_OPTIONS,
  accountFacet,
  archivedHidden,
  toListFacet,
} from '@/lib/agent-list-filters'
import { organizationFacet } from '@/lib/agent-organizations'
import { ListNoMatch, ListToolbar } from './ui/ListToolbar'
import type { ListNoun } from './ui/list-controls-copy'
import { ApprovalRequiredBanner } from './haven/ApprovalRequiredBanner'
import { AgentOrganizationTree } from './agent-panel/AgentOrganizationTree'
import ConnectAgentModal from './ConnectAgentModal'
import LabelsManagerModal from './LabelsManagerModal'
import OrganizationsManagerModal from './OrganizationsManagerModal'
import { AgentCard } from './agent-panel/AgentCard'
import { MCP_NOT_RECORDED_NOTE, hasUnrecordedMcpServerName } from './agent-panel/McpServerName'
import { BotIcon } from './agent-panel/agent-display'
import { isHalfRevoked } from '@/lib/half-revoked'
import { Button } from './ui/Button'
import { EmptyState } from './ui/EmptyState'
import { Skeleton } from './ui/Skeleton'
import { InlineAgentSetup } from './connect-agent/InlineAgentSetup'

const agentNoun: ListNoun = { one: 'agent', other: 'agents' }

/**
 * #3542's guarantee, carried from the "Removed" toggle it lived on (#4113):
 * a hidden group never hides spend authority that is still redeemable.
 */
export function hiddenActiveBudgetTitle(n: number): string {
  return n === 1
    ? '1 archived agent still has an active budget'
    : `${n} archived agents still have an active budget`
}

/**
 * The agents panel's shell: header, list layout, empty states, and modals.
 *
 * All state and orchestration live in `useAgentPanelState` (#989) so the flow
 * logic is testable without rendering the panel; the card pieces live in
 * `./agent-panel/`.
 */
export default function AgentPanel() {
  const panel = useAgentPanelState()
  const {
    accountAddress,
    agents,
    loading,
    error: agentsError,
    visibleAgents,
    removedAgents,
    finalizingAgent,
    finalizeTimedOut,
    refetchAgents,
  } = panel

  // #3165: search / facets / sort over the list, state in the URL — on the
  // list-controls pattern since #4113. Reads EVERY agent: archived ones are
  // hidden by the Archived facet (default Hidden), not by a separate toggle.
  // #3164 registers the organization facet (a plain data value over the
  // fetched tree) ALONGSIDE the built-ins — the toolbar, the URL codec and
  // the counts pick it up without any of them knowing what an org is.
  // Round-3 review (NB2): the second argument REPLACES the hook's
  // `BUILT_IN_FACETS` default (a default fires only on `undefined`, so
  // `[]` counted as a real answer and org-less users lost Status/Budget
  // entirely, while a shared `?status=active` link was silently ignored).
  // The spread below is the hook doc's prescribed shape.
  const orgFacets = useMemo(
    () => (panel.organizations.length > 0 ? [organizationFacet(panel.organizations)] : []),
    [panel.organizations],
  )
  // #3719: the list spans every account; with more than one, filter by it.
  const accountFacets = useMemo(
    () => (panel.accounts.length > 1 ? [accountFacet(panel.accounts)] : []),
    [panel.accounts],
  )
  const allFacets = useMemo(
    () => [...BUILT_IN_FACETS, ...accountFacets, ...orgFacets],
    [accountFacets, orgFacets],
  )
  // #3542: archived agents whose budget delegation is still live. Same
  // predicate as the cards, so the callout and the cards cannot disagree.
  const removedHalfRevokedCount = useMemo(
    () => removedAgents.filter(isHalfRevoked).length,
    [removedAgents],
  )
  // After Finish revoking lands, the server's own count is the truth — refetch
  // quietly (no skeleton) so the marker and the toggle warning clear in place.
  const handleBudgetEnded = useCallback(
    () => void refetchAgents({ silent: true }),
    [refetchAgents],
  )
  const listFilters = useAgentListFilters(agents, allFacets)
  const toolbarFacets = useMemo(
    () => listFilters.facets.map((facet) => toListFacet(facet, listFilters.counts[facet.id])),
    [listFilters.facets, listFilters.counts],
  )
  const archivedAreHidden = archivedHidden(listFilters.state)
  const showArchived = useCallback(
    () =>
      listFilters.setState({
        ...listFilters.state,
        facets: { ...listFilters.state.facets, [ARCHIVED_FACET.id]: ['shown'] },
      }),
    [listFilters],
  )

  // The tree's selected row IS the organization facet's selection (one
  // source of truth, URL-mirrored by the filter state).
  const selectedOrgId = listFilters.state.facets.organization?.[0] ?? null
  const selectOrganization = useCallback(
    (orgId: string | null) => {
      listFilters.setState({
        ...listFilters.state,
        facets: { ...listFilters.state.facets, organization: orgId ? [orgId] : [] },
      })
    },
    [listFilters],
  )

  /**
   * `/agents?setup=<id>` — the budget-approval hand-off link (#2522).
   *
   * An agent cannot approve a budget; a human must. So the agent pastes this
   * link and the human lands on the exact step for that setup instead of being
   * told to "go to Haven and approve the budget". A foreign or unknown id is
   * not special-cased here: the modal opens, `GET /agent-connection-setups/:id`
   * answers 404 for a setup that is not this owner's, and the flow renders its
   * not-found state.
   *
   * `setup` is a SHARED parameter: `?setup=first` already means "auto-open the
   * connect flow for this user's first agent" (#352). The two do not collide —
   * that handler tests for the literal `'first'` and `parseSetupId` accepts
   * only a UUID — and `lib/__tests__/handoff-links.test.ts` pins both halves so a
   * future loosening of either shape fails a test rather than a user.
   */
  const resumeSetupId = useMemo(
    () => (typeof window === 'undefined' ? null : setupIdFromSearch(window.location.search)),
    [],
  )
  const [resumeDismissed, setResumeDismissed] = useState(false)
  const activeResumeSetupId = resumeDismissed ? null : resumeSetupId

  const closeConnectModal = useCallback(() => {
    panel.setConnectAgentOpen(false)
    if (!resumeSetupId) return
    // `resumeDismissed` is what actually keeps the modal shut; the URL tidy is
    // cosmetic, so it uses `history.replaceState` rather than the Next router.
    // A router navigation would re-render the page to change nothing, and
    // reaching for `useRouter` here would make every AgentPanel test mount an
    // app router to render a panel that does not navigate.
    setResumeDismissed(true)
    try {
      // Drop only `setup`; the list toolbar's filter parameters (#3165) stay.
      // `null` state on purpose — see `useAgentListFilters` for why passing
      // `window.history.state` through would stop Next syncing the URL.
      const url = new URL(window.location.href)
      url.searchParams.delete('setup')
      window.history.replaceState(null, '', `${url.pathname}${url.search}`)
    } catch {
      // A URL that stays tidy is not worth a thrown render.
    }
  }, [panel, resumeSetupId])

  // #4065: the inline first-agent flow replaces the empty state. It never
  // renders while a `?setup=<id>` resume modal is open, so two flows (and two
  // status polls) never run at once; once a setup exists the latch holds it
  // until the user leaves (`useAgentPanelState`). Every other part of the
  // agents surface keys its hiding on THIS value, never on `agents.length`,
  // so the `pending_approval` agent of the setup in progress does not appear
  // under it as a card.
  const showInlineSetup =
    panel.inlineSetupLatched || (panel.inlineSetupEligible && !activeResumeSetupId)

  if (!accountAddress) {
  
  return (
      <EmptyState
        icon={<BotIcon size={20} />}
        title="Create a Haven account to manage agents"
        body="Agents need a Haven account before they can receive a credential and rules."
      />
    )
  }

  return (
    <div>
      {panel.toastMessage && (
        // Safe-area insets (#2730): `top-4` renders this notice under the
        // status bar in the installed shell. Nothing here is interactive
        // (`pointer-events-none`), so this is legibility rather than
        // reachability — and unchanged where the insets are 0.
        <div className="fixed right-[max(1rem,var(--v2-safe-right))] top-[calc(1rem+var(--v2-safe-top))] z-[var(--v2-z-panel)] pointer-events-none">
          <div className="rounded-lg border border-danger/20 bg-[var(--v2-bg)] px-4 py-3 shadow-modal">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-full bg-[var(--v2-danger-soft)] text-[var(--v2-danger)] flex items-center justify-center flex-shrink-0">
                <Icon icon={CircleAlert} className="h-3 w-3" />
              </div>
              <p className="text-sm font-medium text-[var(--v2-ink)]">{panel.toastMessage}</p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      {/* #3164 review: this row WRAPS. Adding the header's Organizations
          button (#3164) grew the action cluster (Labels · Organizations ·
          Connect agent) to ~335px, which no longer shares one
          `justify-between` line with the count chip inside the ~345px
          content box a 393px viewport leaves — measured as
          `contentScrollWidth` 435 vs 393 on the `navigation.mobile` gate
          (42px overflow, deterministic). The card action rows were NOT the
          offender: the widest of them measures ~255px here and fits with
          room to spare. `flex-wrap` drops the cluster to its own line below
          the chip instead of overflowing, and the cluster itself wraps at
          the narrowest supported width (320) for the same reason — its
          natural width exceeds a 320px screen's content box. Desktop is
          untouched: the two clusters fit one line there with hundreds of px
          to spare, so nothing ever wraps at `lg` and up. `gap-y-2` spaces
          the wrapped lines; without it the cluster sits flush under the
          chip. */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 mb-4">
        {/* #4065 (owner decision 2026-10-19): no "Agents 0" chip and no
            header Connect agent while the inline flow shows — the flow IS the
            way to connect, and a second entry would open the modal over it.
            Labels and Organizations stay. */}
        {!showInlineSetup && (
          <div className="flex items-center gap-1">
            <div className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--v2-surface-2)] text-[var(--v2-ink)]">
              Agents
              <span className="ml-1 text-[var(--v2-ink-3)]">
                {visibleAgents.length}
              </span>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => panel.setLabelsManagerOpen(true)} size="sm" variant="tertiary">
            <Icon icon={Tag} className="h-3.5 w-3.5" />
            Labels
          </Button>
          {/* #3164: the organization manager — create/rename/move/delete. The
              tree above the list appears once at least one organization exists. */}
          <Button onClick={() => panel.setOrganizationsManagerOpen(true)} size="sm" variant="tertiary">
            <Icon icon={Network} className="h-3.5 w-3.5" />
            Organizations
          </Button>
          {!showInlineSetup && (
            <Button onClick={() => panel.setConnectAgentOpen(true)} size="sm">
              <Icon icon={Plus} className="h-3.5 w-3.5" />
              Connect agent
            </Button>
          )}
        </div>
      </div>

      {showInlineSetup ? (
        // #4065: the existing connect flow, inline, for a user with no agents
        // — it replaces the "No agents yet" empty state and the onboarding
        // prompt card. Keyed so each leave remounts it fresh.
        <InlineAgentSetup
          key={panel.inlineSetupKey}
          onClose={panel.leaveInlineSetup}
          onSetupStarted={panel.latchInlineSetup}
          onSetupAbandoned={panel.releaseInlineSetup}
          accountAddress={accountAddress}
          accountId={panel.defaultAccountId}
          onSetupUpdated={panel.handleSetupUpdated}
        />
      ) : (
        <>
          {/* #3164: the organization tree above the list — only when the user HAS
              organizations. An empty tree would be a permanent empty management
              panel on every org-less /agents visit (product README, First-Run
              Simplicity); the header's Organizations button is the entry point
              until one exists. */}
          {panel.organizations.length > 0 && (
            <AgentOrganizationTree
              organizations={panel.organizations}
              loading={panel.organizationsLoading}
              error={panel.organizationsError}
              selectedId={selectedOrgId}
              onSelect={selectOrganization}
              onCreate={() => panel.setOrganizationsManagerOpen(true)}
              onManage={() => panel.setOrganizationsManagerOpen(true)}
              onRetry={() => void panel.fetchOrganizations()}
              counts={listFilters.counts.organization}
            />
          )}

          {agents.length > 0 && (
            <div className="mb-4">
              <ListToolbar
                noun={agentNoun}
                state={listFilters.state}
                onChange={listFilters.setState}
                filtering="browser"
                facets={toolbarFacets}
                sort={{ options: SORT_OPTIONS }}
                searchDescription="by name, description or delegate address"
                count={{ shown: listFilters.filtered.length, total: listFilters.total }}
              />
            </div>
          )}

          {/* #3542, carried over from the Removed toggle (#4113): hiding
              archived agents must never hide a budget that can still be
              spent on-chain. Only while they are hidden; "Shown" puts the
              cards, with their own Finish revoking marker, on screen. */}
          {archivedAreHidden && removedHalfRevokedCount > 0 && (
            <div className="mb-4" data-testid="hidden-active-budget-callout">
              <ApprovalRequiredBanner title={hiddenActiveBudgetTitle(removedHalfRevokedCount)} tone="warning" density="compact">
                <Button variant="ghost" size="sm" className="mt-1" onClick={showArchived}>
                  Show archived
                </Button>
              </ApprovalRequiredBanner>
            </div>
          )}

          {agentsError && agents.length > 0 ? (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-warning/30 bg-[var(--v2-warning-soft)] px-4 py-3 text-sm text-[var(--v2-ink-2)]"
            >
              Agent data could not refresh. Showing the last loaded records.
              <Button className="ml-2" size="sm" variant="ghost" onClick={() => void refetchAgents()}>
                Try again
              </Button>
            </div>
          ) : null}

          {/* Agents view */}
          {loading && agents.length === 0 && (
            <div
              className="space-y-3"
              role="status"
              aria-busy="true"
              aria-live="polite"
              aria-label="Loading agents"
            >
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="bg-[var(--v2-bg)] border border-[var(--v2-border)] rounded-[10px] p-5"
                >
                  <div className="flex items-center gap-3 mb-4">
                    <Skeleton className="w-9 h-9 rounded-xl" />
                    <div className="space-y-2">
                      <Skeleton variant="text" className="h-3 w-32" />
                      <Skeleton variant="text" className="h-2 w-48" />
                    </div>
                  </div>
                  <Skeleton variant="text" className="h-2 w-full" />
                </div>
              ))}
            </div>
          )}

          {/* Finalizing placeholder — shown while the post-approval poll waits for a
              freshly-signed agent to flip active, so the inline first-agent flow
              doesn't flash back as if nothing happened. `finalizingAgent` is set
              for every setup, but this only renders when the list is empty (first
              agent) and the user has left the inline flow (#4065: while it is
              latched, its own Done screen is the feedback); for subsequent agents
              the existing list stays visible and the new one just appends. */}
          {!loading && agents.length === 0 && finalizingAgent && (
            <div role="status" aria-busy="true" aria-live="polite" aria-label="Finalizing agent setup">
              <EmptyState
                tone="neutral"
                icon={
                  /* Heavier stroke: matches the original spinner's 3px ring weight. */
                  <Icon icon={LoaderCircle} className="h-5 w-5 animate-spin" strokeWidth={3} />
                }
                title="Finalizing your agent…"
                body="Haven is confirming the new rules on-chain. Your agent will appear here in a moment — no need to refresh."
              />
            </div>
          )}

          {/* Timeout fallback — the poll exhausted its window without the agent
              appearing. Rather than dropping silently back to the inline flow, tell the
              user it may still be confirming and let them re-check. */}
          {!loading &&
            agents.length === 0 &&
            !agentsError &&
            !finalizingAgent &&
            finalizeTimedOut && (
              <EmptyState
                tone="warning"
                icon={
                  <Icon icon={Clock} className="h-5 w-5" />
                }
                title="Your agent is taking longer than expected"
                body="Haven is still confirming the new rules on-chain. This can take a little longer under load — check again in a moment."
                action={
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button onClick={panel.retryFinalizePoll}>
                      Check again
                    </Button>
                  </div>
                }
              />
            )}

          {!loading && agents.length === 0 && agentsError ? (
            <EmptyState
              tone="warning"
              icon={<Icon icon={CircleAlert} className="h-5 w-5" />}
              title="Agents could not load"
              body="Haven could not load your connected agents right now. Try again before assuming there are none."
              action={<Button onClick={() => void refetchAgents()}>Try again</Button>}
            />
          ) : null}

          {/* Agent list */}
          {agents.length > 0 && (
            <div className="space-y-4">
              {/*
                #2043: the `not recorded` explanation, ONCE, as visible text, and
                only when a card on screen actually says `not recorded`.

                #2017's shape (PR #2039), matched rather than re-invented — see
                `MCP_NOT_RECORDED_NOTE` for why this copy cannot live in the
                `Tooltip` it came from, and why the OTHER tooltip in the same
                component stays.

                The predicate reads the cards that are RENDERED, not every agent
                Haven holds: the FILTERED list (#3165), so a filter that hides
                the only `not recorded` card hides the note — and so do
                archived agents while "Archived: Hidden" (#4113); "Shown"
                reveals both together, which is the honest pairing.
              */}
              {hasUnrecordedMcpServerName(listFilters.filtered) && (
                <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
                  {MCP_NOT_RECORDED_NOTE}
                </p>
              )}

              {/* #4113: the pattern's no-match state when a filter emptied the
                  list. An untouched list can be empty too — every agent
                  archived — and Clear filters would change nothing there, so
                  it says what is hidden and offers the one way to see it. */}
              {listFilters.filtered.length === 0 &&
                (listFilters.active ? (
                  <ListNoMatch noun={agentNoun} onClear={listFilters.reset} />
                ) : (
                  <EmptyState
                    size="compact"
                    tone="neutral"
                    icon={<Icon icon={Archive} className="h-5 w-5" />}
                    title="All your agents are archived"
                    body="Archived agents are hidden from this list. Show them to restore one or review its history."
                    action={
                      <Button size="sm" variant="ghost" onClick={showArchived}>
                        Show archived
                      </Button>
                    }
                  />
                ))}

              {listFilters.filtered.length > 0 && (
                <div className="grid items-start gap-4 lg:grid-cols-2">
                  {listFilters.filtered.map((agent) => {
                    const agentChainId = agent.account_chain_id ?? DEFAULT_CHAIN_ID

                    return (
                      <AgentCard
                        key={agent.id}
                        agent={agent}
                        onPause={panel.handlePause}
                        onResume={panel.handleResume}
                        onRevokeCredential={panel.revokeAgentCredential}
                        onArchive={panel.handleArchive}
                        onRestore={panel.handleRestore}
                        onMoveToOrganization={panel.handleAgentMoved}
                        onBudgetEnded={handleBudgetEnded}
                        busyAction={panel.busyAgentId === agent.id ? panel.busyAction : null}
                        chainId={agentChainId}
                        organizations={panel.organizations}
                      />
                    )
                  })}
                </div>
              )}

            </div>
          )}
        </>
      )}

      <ConnectAgentModal
        open={panel.connectAgentOpen || Boolean(activeResumeSetupId)}
        onClose={closeConnectModal}
        starterAllowance={panel.firstAgentSetup}
        accountAddress={accountAddress}
        accountId={panel.defaultAccountId}
        onSetupUpdated={panel.handleSetupUpdated}
        resumeSetupId={activeResumeSetupId}
      />

      {/* Manage labels (#3167): the vocabulary — rename, recolour, delete. */}
      <LabelsManagerModal
        open={panel.labelsManagerOpen}
        onClose={() => panel.setLabelsManagerOpen(false)}
        onLabelsChanged={panel.handleAgentEdited}
      />

      {/* Manage organizations (#3164): the tree — create, rename, move, delete. */}
      <OrganizationsManagerModal
        open={panel.organizationsManagerOpen}
        onClose={() => panel.setOrganizationsManagerOpen(false)}
        onOrganizationsChanged={panel.handleOrganizationsChanged}
      />
    </div>
  )
}
