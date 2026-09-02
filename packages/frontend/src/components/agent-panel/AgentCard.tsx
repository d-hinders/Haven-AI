'use client'

import { McpServerName } from './McpServerName'
import { ApprovalRequiredBanner } from '@/components/haven/ApprovalRequiredBanner'
import { useState, useMemo, type KeyboardEvent, type MouseEvent } from 'react'
import { type Agent } from '@/hooks/useAgents'
import { type AllowanceInfo } from '@/lib/allowance-module'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { formatAgentLastActivity, formatAgentLastActivityTitle } from '@/lib/agent-last-seen'
import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '@/lib/agent-pause-copy'
import { STRANDED_FUNDS_TITLE, strandedFundsCause } from '@/lib/stranded-funds-copy'
import ConfirmDialog from '../ConfirmDialog'
import { RemoveAgentDialog } from './RemoveAgentDialog'
import { entityCardClassName } from '../ui/entityCardStyles'
import { AllowanceBar, AllowanceBarSkeleton, ConfiguredAllowanceRow } from './AllowanceBar'
import { BotIcon } from './agent-display'
import type { AgentBusyAction } from '@/hooks/useAgentPanelState'

export function AgentCard({
  agent,
  onChainAllowances,
  onChainLoading,
  chainTimeSec,
  onViewDetails,
  onEdit,
  onPause,
  onResume,
  onRevoke,
  onRevokeCredential,
  onArchive,
  onRestore,
  busyAction,
  canUseWalletActions,
  chainId = DEFAULT_CHAIN_ID,
}: {
  agent: Agent
  onChainAllowances: AllowanceInfo[] | null
  onChainLoading: boolean
  chainTimeSec: number | null
  onViewDetails: (agent: Agent) => void
  onEdit: (agent: Agent) => void
  onPause: (agent: Agent) => void
  onResume: (agent: Agent) => void
  onRevoke: (agent: Agent) => void
  /** RemoveAgentDialog step 2: plain POST /agents/:id/revoke, throws on failure. */
  onRevokeCredential: (agentId: string) => Promise<void>
  /** RemoveAgentDialog step 3: archive (#1401), throws on failure. */
  onArchive: (agent: Agent) => Promise<void>
  onRestore: (agent: Agent) => void
  busyAction: AgentBusyAction
  canUseWalletActions: boolean
  chainId?: number
}) {
  const [pauseModalOpen, setPauseModalOpen] = useState(false)
  const [revokeModalOpen, setRevokeModalOpen] = useState(false)
  const [removeModalOpen, setRemoveModalOpen] = useState(false)

  const isActive = agent.status === 'active'
  const isPaused = agent.status === 'paused'
  const isRevoked = agent.status === 'revoked'
  const isArchived = Boolean(agent.archived_at)
  const isOperational = !isRevoked
  const isDelegationAgent = agent.account_type === 'delegator_hybrid'
  const isBusy = busyAction !== null

  async function handleConfirmPause() {
    setPauseModalOpen(false)
    onPause(agent)
  }

  async function handleConfirmRevoke() {
    setRevokeModalOpen(false)
    onRevoke(agent)
  }

  function openDetails() {
    onViewDetails(agent)
  }

  function handleCardKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openDetails()
    }
  }

  function stopCardClick(event: MouseEvent) {
    event.stopPropagation()
  }

  // Merge on-chain + DB allowance data: on-chain is primary, DB fills gaps
  const displayAllowances = useMemo(() => {
    if (onChainAllowances && onChainAllowances.length > 0) {
      return onChainAllowances
    }
    return null
  }, [onChainAllowances])
  const hasNetworkAllowances = !!displayAllowances && displayAllowances.length > 0
  const hasConfiguredAllowances = agent.allowances.length > 0
  const showConfiguredFallback =
    !onChainLoading &&
    !hasNetworkAllowances &&
    hasConfiguredAllowances

  // Tokens from DB that we haven't seen on-chain yet (shown as skeleton)
  const pendingDbTokens = useMemo(() => {
    if (!onChainLoading) return [] // done loading, trust on-chain
    if (!onChainAllowances) {
      // Still loading — show all DB tokens as skeleton
      return agent.allowances.map((a) => a.token_symbol)
    }
    // Show DB tokens not yet in on-chain results
    const onChainAddrs = new Set(onChainAllowances.map((a) => a.token.toLowerCase()))
    return agent.allowances
      .filter((a) => !onChainAddrs.has(a.token_address.toLowerCase()))
      .map((a) => a.token_symbol)
  }, [onChainAllowances, onChainLoading, agent.allowances])

  return (
    <>
    <div
      role="link"
      tabIndex={0}
      onClick={openDetails}
      onKeyDown={handleCardKeyDown}
      aria-label={`View ${agent.name}`}
      /* #2251: `min-w-0` is the STRUCTURAL half of the fit-the-track fix, and
         it is on the call site rather than in `entityCardClassName` on
         purpose — `/accounts` shares that helper and has its own open
         sizing issue (#2241), so folding this in would ship an unmeasured
         change to a surface this diff never rendered.

         A grid item's `min-width` defaults to `auto`, which resolves to its
         min-content. `AgentPanel`'s grid (`grid items-start gap-4
         lg:grid-cols-2`) therefore sizes its column to the WIDEST card's
         min-content and lets no card shrink below it. At 390 the track is
         342px and a card carrying the longest legal `mcp_server_name` floors
         at 466.6px, so every card in the grid rendered ~146px wider than the
         track and was CLIPPED — `main` is `overflow-x: auto` inside an
         `overflow-hidden` parent, so `documentElement.scrollWidth` stays 390
         and nothing on the page says there is more to the right.

         This class alone is not the fix and was measured not to be: with it
         the card sits at 342px while the MCP chip still renders 264.9px inside
         an 86.5px box, i.e. spilling out of the card instead of expanding it.
         The other half is `McpServerName`'s `[&>span]:min-w-0`, which lets the
         chip's `truncate` finally engage. Both are asserted, separately, in
         `e2e/agent-card-fit-measure.spec.ts`. */
      className={`${entityCardClassName({ muted: isRevoked })} min-w-0 cursor-pointer`}
    >
      {/* Header */}
      {/* #2325: `flex-wrap` here, plus the stamp's `basis-full sm:basis-auto`
          below, is the information-priority decision for a narrow card. Below
          `sm` the "Last activity" stamp drops to its own line under the
          name/account/MCP block, so the block gets the row's full width and the
          MCP chip inside it is distinguishable at 390. At `sm` and up the stamp
          is `basis-auto` and stays on the line, so the tablet/desktop layout is
          unchanged. `flex-wrap` alone does nothing (the block's flex-basis is
          0%, so it never pushes the stamp to a second line); the `basis-full`
          is what forces the wrap. Proven by rendered geometry in
          `e2e/agent-card-mcp-chip-measure.spec.ts`. */}
      <div className="flex flex-wrap items-start gap-3 mb-4">
          <div
            className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isActive
                ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                : isPaused
                  ? 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]'
                  : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
            }`}
          >
            <BotIcon size={16} />
          </div>
          <div className="min-w-0 flex-1">
            {/* #2237: the title row WRAPS, so the name stops paying for the
                status pill. Same idiom as `components/haven/
                TransactionActivityRow.tsx` (#1833), `WalletIdentityBlock.tsx`
                and, since #2223, the `/accounts` card — `flex flex-wrap
                items-center gap-2` around a `min-w-0 truncate` name.

                This is a REAL defect here, not only an inconsistency, and it
                was measured before it was fixed. At 1280 this row's content is
                259px and the `paused` pill is 54.5px + an 8px gap. Without
                `flex-wrap` the pill is the row's incompressible item, so the
                name is capped at 196.7px whatever it says — "Nightly data-feed
                reconciliation agent" measures 256.2px, FITS the row, and was
                still rendered ellipsised at 75.9% of it. Every name past
                196.5px truncated 62.5px earlier than the card required.

                WHAT WRAPPING COSTS, stated rather than buried. When the pill
                does move down, the title row grows one line: 20px -> 48px, and
                the card 332px -> 360px. That cost is confined to the card that
                wraps, because `AgentPanel`'s grid is `items-start` — unlike
                `/accounts`, whose `align-items: stretch` propagated #2223's
                wrap to the whole grid row as 28px of dead whitespace. Nothing
                else on this row can pay: at most ONE pill renders (`!isActive`),
                so there is no badge pair to orphan (#2235) and no hover-action
                reservation to derive (#2236) — both of #2240's fixes are
                inapplicable here, which is why this stayed a separate issue.

                `min-w-0` on the `h3` is redundant given `truncate`
                (`overflow: hidden` already resolves `min-width: auto` to 0, and
                removing it alone leaves the geometry suite green — mutated and
                measured). It is written anyway because all three sibling
                surfaces write it, and an idiom that is only sometimes complete
                is the thing this issue is about. */}
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-sm font-semibold text-[var(--v2-ink)]">
                {agent.name}
              </h3>
              {!isActive ? (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                    isPaused
                      ? 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]'
                      : agent.status === 'revoked'
                        ? 'bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]'
                        : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
                  }`}
                >
                  {agent.status}
                </span>
              ) : null}
            </div>
            {agent.safe_name && (
              <p className="text-xs text-[var(--v2-ink-2)] mt-0.5">
                <span className="text-[var(--v2-ink-3)]">Account:</span> {agent.safe_name}
              </p>
            )}
            {/*
              #1878: which MCP pair this agent is wired as. Below the display
              name rather than beside it, and monospace rather than prose —
              #1694's decision is "editable display name, immutable wiring
              slug", so the two must not read as the same kind of thing.
            */}
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs">
              <span className="text-[var(--v2-ink-3)]">MCP:</span>
              <McpServerName value={agent.mcp_server_name} />
            </div>
            {agent.description && (
              <p className="text-xs text-[var(--v2-ink-3)] mt-0.5">
                {agent.description}
              </p>
            )}
          </div>
          <p
            /* #2325: the information-priority half of the narrow-card fix.
               `basis-full` makes this stamp a full-width flex item, so on the
               now-wrapping header row it is forced onto its own line below the
               name/account/MCP block at every width below `sm`. `sm:basis-auto`
               restores the on-the-line layout at `sm` and up, where the card is
               wide enough that the stamp and the block share the row.

               The stamp stays `shrink-0` and `ml-auto`: on its own line,
               `ml-auto` right-aligns it (the block above is `flex-1` and fills
               the line, so `ml-auto` is a no-op there) and `shrink-0` keeps the
               "Last activity 1mo ago" text from wrapping. The `title` tooltip
               and the text are untouched — only the line it sits on changes. */
            className="ml-auto shrink-0 basis-full pt-0.5 text-right text-xs text-[var(--v2-ink-3)] sm:basis-auto"
            title={formatAgentLastActivityTitle(agent.mcp_last_seen_at)}
          >
            {formatAgentLastActivity(agent.mcp_last_seen_at)}
          </p>
      </div>

      {/* ── Both notices go through `ApprovalRequiredBanner` (#2216) ───────────
          These were two hand-rolled copies of the primitive's shape, a few
          lines apart in this file, painting TITLE AND BODY in
          `--v2-warning` while the primitive reserves the tint for the icon
          badge and keeps prose in `--v2-ink` / `--v2-ink-2`. Same words as the
          agent-detail banners one click away, two colour voices.

          Restyling the two to imitate the primitive was rejected: it leaves
          three implementations of one visual idea, which is how these diverged
          in the first place, and the pattern-absorption preflight (#901) says
          extract on the SECOND occurrence — this file was already at two, and
          the primitive existed. Adopting it inherits the ink rule, the icon
          badge, the tone ladder and the 10px frame instead of re-typing any of
          them.

          `--v2-warning` is scoped to "402 Payment Required, pending review"
          (`docs/product/design-system.md` § 1, restated in § Local hint
          marker), which is a reason the tint belongs on a severity MARKER and
          not on a paragraph.

          The tones are the ones `AgentDetailClient` already passes for the
          same two facts (`:666`, `:674`) — `neutral` for paused, `warning` for
          stranded. Paused is not 402/pending-review, and the card has not lost
          its amber: the header's status pill and the bot tile both still paint
          it. Choosing anything else here would leave one fact rendered two
          ways on two screens the card's own link navigates between, which is
          exactly the #2195 defect this is the styling half of. */}
      {/* #2230 (the BODY half #2216 deferred): title and body now come from
          `lib/agent-pause-copy.ts`, shared with the detail page's banner one
          click away. The card used to say "Existing network permissions stay
          in place" where the detail page said "Existing wallet rules" — the
          detail page's wording was TAKEN rather than a third one written, for
          the usage / register / accuracy reasons recorded in that module. */}
      {isPaused && (
        <div className="mb-3">
          <ApprovalRequiredBanner title={AGENT_PAUSED_TITLE} tone="neutral" density="compact">
            {AGENT_PAUSED_BODY}
          </ApprovalRequiredBanner>
        </div>
      )}

      {agent.has_stranded_funds && (
        <div className="mb-3">
          <ApprovalRequiredBanner title={STRANDED_FUNDS_TITLE} tone="warning" density="compact">
            {/* #2195: title and cause clause are the SHARED ones — this card and
                the agent-detail banner are one click apart and used to name the
                same reconciliation event two different ways. The count is `null`
                because `has_stranded_funds` is a SQL `EXISTS`, so this surface
                knows the state exists and cannot know how many events or how
                much money; the detail banner holds the list and the balance, and
                says so. That is the difference in detail level, made deliberate.

                `strandedFundsCause`, not the `WithLocation` variant the detail
                banner uses: the shared title already says "in agent wallet" and
                the link below says "these funds", so repeating the location
                here bought nothing and cost a fourth wrapped line at 390px
                (`haven-design-reviewer` on this change, measured off the 390
                capture — it also corrected my desktop-only "2 to 3 lines"
                reading; the real growth at 390 was 3 to 4). */}
            <span>
              {strandedFundsCause(null)}{' '}
              <a href={`/agents/${agent.id}`} className="underline underline-offset-2">
                View agent to recover these funds.
              </a>
            </span>
          </ApprovalRequiredBanner>
        </div>
      )}

      {isOperational && (
        <div className="mb-3">
          <div className="space-y-2">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">Agent budget</p>

            {hasNetworkAllowances ? (
              displayAllowances.map((info) => (
                <AllowanceBar key={info.token} info={info} chainTimeSec={chainTimeSec} chainId={chainId} />
              ))
            ) : showConfiguredFallback ? (
              agent.allowances.map((allowance) => (
                <ConfiguredAllowanceRow
                  key={allowance.id}
                  allowance={allowance}
                  chainId={chainId}
                />
              ))
            ) : !onChainLoading ? (
              <p className="text-xs text-[var(--v2-ink-3)]">No agent budget configured</p>
            ) : null}

            {/* ONE status region for the whole pending list, not one per row
                (#2204 design review). The app's convention is a status region
                per loading SURFACE — `DashboardClient.tsx:134`,
                `AgentDetailClient.tsx:373`, `TransactionsTable.tsx:150` — and
                the per-row version announced the same string once per card,
                three times over on `/agents`. The rows keep `aria-busy`, which
                is what the capture harness reads. */}
            {pendingDbTokens.length > 0 && (
              <div
                /* `space-y-2` is carried, not added: these rows used to be
                   direct children of the `space-y-2` list above, so wrapping
                   them without it would silently close the gap between two
                   pending tokens. */
                className="space-y-2"
                role="status"
                aria-live="polite"
                aria-label={`Loading ${agent.name}'s budget`}
              >
                {pendingDbTokens.map((symbol) => (
                  <AllowanceBarSkeleton key={symbol} symbol={symbol} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      {/* #1909: `pb-1` is load-bearing, not spacing taste. These controls carry
          `ring-2` with NO offset, so ~2px of every focus ring falls outside the
          control's own box. The clearance the operational branches appeared to
          have was an ACCIDENT of the `|` separators below: they carry no
          `text-xs`, so they inherit 16px/24px and become the tallest flex item,
          and `items-center` then centres the 16px controls inside that 24px band
          — 4px above and below, for free. The archived branch renders no
          separator, so its tallest item IS the 16px control and the row's box
          ended exactly at the control's box: ring flush against the boundary,
          zero clearance, identically on macOS and Linux (measured 29px vs the
          siblings' 37px). Stating the padding makes the clearance a property of
          the row rather than of which children happen to render. 4px is the
          sibling clearance exactly — 2px of ring, 2px clear.

          The result is deliberately asymmetric and that is fine: the branches
          with separators now get ~8px (4 accidental + 4 stated) and the
          archived branch gets 4. Both contain the ring with room to spare, and
          the alternative — a `pb` conditional on which branch rendered — would
          encode the accident instead of retiring it. Giving the separators
          `text-xs` would equalise the band at 16px and make all five branches
          4px, but it also resizes a visible glyph, so it is a design change
          rather than this fix. */}
      <div className="flex items-center gap-2 pt-3 pb-1 border-t border-[var(--v2-border)]" onClick={stopCardClick}>
        {isOperational && (
          <>
            {canUseWalletActions ? (
              <button
                onClick={() => onEdit(agent)}
                disabled={isBusy}
                aria-label={`Edit ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                Edit
              </button>
            ) : (
              <button
                onClick={openDetails}
                disabled={isBusy}
                aria-label={`Open details for ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                Details
              </button>
            )}
            <span className="text-[var(--v2-border-strong)]">|</span>
            {isActive ? (
              <button
                onClick={() => setPauseModalOpen(true)}
                disabled={isBusy}
                aria-label={`Pause ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                {busyAction === 'pause' ? 'Pausing...' : 'Pause'}
              </button>
            ) : (
              <button
                onClick={() => onResume(agent)}
                disabled={isBusy}
                aria-label={`Resume ${agent.name}`}
                className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                {busyAction === 'resume' ? 'Resuming...' : 'Resume from pause'}
              </button>
            )}
            {/* Safe revoke is an AllowanceModule teardown; on delegation
                agents the whole shutdown is the Remove flow below (#1402),
                so the Safe control is hidden there. */}
            {canUseWalletActions && !isDelegationAgent ? (
              <>
                <span className="text-[var(--v2-border-strong)]">|</span>
                <button
                  onClick={() => setRevokeModalOpen(true)}
                  disabled={isBusy}
                  aria-label={`Revoke ${agent.name}`}
                  className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-danger)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80"
                >
                  Revoke
                </button>
              </>
            ) : null}
            {/* #1402: Remove = revoke-all budgets + revoke credential +
                archive, one confirmed action. Delegation agents only while
                operational; on legacy agents Revoke stays the shutdown and
                Remove appears after it (the revoked branch below). */}
            {isDelegationAgent ? (
              <>
                <span className="text-[var(--v2-border-strong)]">|</span>
                <button
                  onClick={() => setRemoveModalOpen(true)}
                  disabled={isBusy}
                  aria-label={`Remove ${agent.name}`}
                  className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-danger)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80"
                >
                  Remove
                </button>
              </>
            ) : null}
          </>
        )}
        {isRevoked && !isArchived && (
          <>
            <span className="text-xs text-[var(--v2-ink-3)]">
              Network access already revoked
            </span>
            <span className="text-[var(--v2-border-strong)]">|</span>
            <button
              onClick={() => setRemoveModalOpen(true)}
              disabled={isBusy}
              aria-label={`Remove ${agent.name}`}
              className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-danger)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80"
            >
              {busyAction === 'archive' ? 'Removing...' : 'Remove'}
            </button>
          </>
        )}
        {isArchived && (
          <>
            {/* #1909: `whitespace-nowrap` on the action label, with the sentence
                beside it left free to wrap. Under CI's (Linux) font metrics
                `Restore to list` broke across two lines at DESKTOP width — the
                committed baseline was 438x45 where macOS rendered 438x29 — so
                this is a real wrap, not a rendering-judge quirk.

                The 390px budget says this costs nothing. Row content width
                there is 300px (342px card less `p-5` and borders), gap 8px, so
                the two children share 292px. Unwrapped the label is 77px and
                the sentence is 340px — the sentence CANNOT fit on one line at
                this width whatever the label does, and its `min-content` is
                53px. Pinning the label therefore leaves 300 - 77 - 8 - 53 =
                162px of slack before the row could overflow, and the measured
                overflow at 390px is 0. A two-word action label is an atomic
                phrase; the explanatory sentence is the thing that should reflow.

                That budget is ASSERTED rather than merely recorded here — see
                "the archived branch does not overflow at 390px" in
                `e2e/focus-visible.visual.spec.ts`, which checks both the
                overflow and the single line at exactly this width. Arithmetic
                in a comment is run by nobody.

                Rejected: shortening to `Restore` (43px unwrapped) — a shorter
                label is still a wrappable one, so it buys probability where the
                whole lesson of this defect is that macOS metrics mispredicted
                Linux by 16px, and it drops the object from a control whose
                destination is the point (`aria-label` says "to the list").
                Rejected: widening the container — it is the agents grid column,
                so every card on the page moves to fix one label. */}
            <button
              onClick={() => onRestore(agent)}
              disabled={isBusy}
              aria-label={`Restore ${agent.name} to the list`}
              className="text-xs whitespace-nowrap text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
            >
              {busyAction === 'restore' ? 'Restoring...' : 'Restore to list'}
            </button>
            <span className="ml-auto text-xs text-[var(--v2-ink-3)]">
              History stays readable; restoring never re-enables spending
            </span>
          </>
        )}
      </div>
    </div>

    <ConfirmDialog
      open={pauseModalOpen}
      onCancel={() => setPauseModalOpen(false)}
      onConfirm={handleConfirmPause}
      title={`Pause ${agent.name}?`}
      body={
        <div className="space-y-3">
          <p>
            {/* #2230: the same noun as the banner above and the detail page.
                Leaving "network permissions" here would have replaced a
                divergence BETWEEN two screens with one INSIDE a single file,
                for the same fact — a strictly worse version of the defect. */}
            Pausing stops this agent from creating new payments through Haven right away, without changing its wallet rules.
          </p>
          <div className="rounded-lg border border-brand/15 bg-[var(--v2-brand-soft)] px-3 py-3 text-[var(--v2-ink-2)]">
            <p className="text-xs font-medium text-[var(--v2-brand)] mb-1">What stays the same</p>
            <p className="text-xs leading-relaxed">
              The agent&apos;s wallet rules remain in place. You can resume this agent later without reconnecting or reconfiguring it.
            </p>
          </div>
          <p className="text-xs text-[var(--v2-ink-2)]">
            Use Pause for a fast, reversible stop. Use Revoke when you also want to remove the agent&apos;s network spending authority.
          </p>
        </div>
      }
      confirmLabel="Pause agent"
      tone="primary"
      loading={busyAction === 'pause'}
    />

    <ConfirmDialog
      open={revokeModalOpen}
      onCancel={() => setRevokeModalOpen(false)}
      onConfirm={handleConfirmRevoke}
      title={`Revoke ${agent.name}?`}
      body={
        <div className="space-y-3">
          <p>
            This removes the agent&apos;s Haven access immediately and also revokes its network spending authority.
          </p>
          <div className="rounded-lg border border-danger/15 bg-[var(--v2-danger-soft)] px-3 py-3 text-[var(--v2-ink-2)]">
            <p className="text-xs font-medium text-[var(--v2-danger)] mb-1">What happens next</p>
            <p className="text-xs leading-relaxed">
              Haven will stop accepting new requests from this agent, and you&apos;ll be asked to approve the update that removes its spending access.
            </p>
          </div>
          <p className="text-xs text-[var(--v2-ink-2)]">
            Use Pause when you want a quick, reversible stop. Use Revoke when you want to fully shut this agent down.
          </p>
        </div>
      }
      confirmLabel="Revoke agent"
      loading={busyAction === 'revoke'}
    />

    {/* Mounted only while open: its hooks (budget prepare, delegate-balance
        read) are per-agent and must not run for every card in the list. */}
    {removeModalOpen && (
      <RemoveAgentDialog
        agent={agent}
        chainId={chainId}
        onRevokeCredential={() => onRevokeCredential(agent.id)}
        onArchive={() => onArchive(agent)}
        onClose={() => setRemoveModalOpen(false)}
      />
    )}
    </>
  )
}
