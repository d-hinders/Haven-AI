'use client'

import { McpServerName } from './McpServerName'
import { ApprovalRequiredBanner } from '@/components/haven/ApprovalRequiredBanner'
import { useState } from 'react'
import { type Agent } from '@/hooks/useAgents'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { formatAgentLastActivity, formatAgentLastActivityTitle } from '@/lib/agent-last-seen'
import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '@/lib/agent-pause-copy'
import { STRANDED_FUNDS_TITLE, strandedFundsCause } from '@/lib/stranded-funds-copy'
import ConfirmDialog from '../ConfirmDialog'
import { RemoveAgentDialog } from './RemoveAgentDialog'
import { entityCardClassName } from '../ui/entityCardStyles'
import { ConfiguredAllowanceRow } from './AllowanceBar'
import { BotIcon } from './agent-display'
import type { AgentBusyAction } from '@/hooks/useAgentPanelState'

const ACTION_BUTTON_CLASS =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-1 text-xs text-[var(--v2-brand)] transition-colors hover:text-[var(--v2-brand-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] disabled:opacity-50'
const DANGER_ACTION_BUTTON_CLASS =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-1 text-xs text-[var(--v2-ink-3)] transition-colors hover:text-[var(--v2-danger)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] disabled:opacity-50'

export function AgentCard({
  agent,
  onViewDetails,
  onEdit,
  onPause,
  onResume,
  onRevokeCredential,
  onArchive,
  onRestore,
  busyAction,
  canUseWalletActions,
  chainId = DEFAULT_CHAIN_ID,
}: {
  agent: Agent
  onViewDetails: (agent: Agent) => void
  onEdit: (agent: Agent) => void
  onPause: (agent: Agent) => void
  onResume: (agent: Agent) => void
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

  function openDetails() {
    onViewDetails(agent)
  }

  const hasConfiguredAllowances = agent.allowances.length > 0

  return (
    <>
    <div
      data-testid="agent-card"
      className={`${entityCardClassName({ muted: isRevoked })} min-w-0`}
    >
      {/* Header */}
      <div className="flex items-start gap-3 mb-4">
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
                <a
                  href={`/agents/${agent.id}`}
                  className="block min-w-0 truncate rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]"
                >
                  {agent.name}
                </a>
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
            className="ml-auto shrink-0 pt-0.5 text-right text-xs text-[var(--v2-ink-3)]"
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
      {isPaused && isDelegationAgent && (
        <div className="mb-3">
          <ApprovalRequiredBanner title={AGENT_PAUSED_TITLE} tone="neutral" density="compact">
            {AGENT_PAUSED_BODY}
          </ApprovalRequiredBanner>
        </div>
      )}

      {agent.has_stranded_funds && isDelegationAgent && (
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

      {isOperational && isDelegationAgent && (
        <div className="mb-3">
          <div className="space-y-2">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">Agent budget</p>

            {hasConfiguredAllowances ? (
              agent.allowances.map((allowance) => (
                <ConfiguredAllowanceRow
                  key={allowance.id}
                  allowance={allowance}
                  chainId={chainId}
                />
              ))
            ) : (
              <p className="text-xs text-[var(--v2-ink-3)]">No agent budget configured</p>
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
      <div className="flex items-center gap-2 pt-3 pb-1 border-t border-[var(--v2-border)]">
        {isOperational && (
          <>
            {canUseWalletActions ? (
              <button
                onClick={() => onEdit(agent)}
                disabled={isBusy}
                aria-label={`${isDelegationAgent ? 'Edit' : 'Rename'} ${agent.name}`}
                className={ACTION_BUTTON_CLASS}
              >
                {isDelegationAgent ? 'Edit' : 'Rename'}
              </button>
            ) : (
              <button
                onClick={openDetails}
                disabled={isBusy}
                aria-label={`Open details for ${agent.name}`}
                className={ACTION_BUTTON_CLASS}
              >
                Details
              </button>
            )}
            {isDelegationAgent ? (
              <>
                <span className="text-[var(--v2-border-strong)]">|</span>
                {isActive ? (
                  <button
                    onClick={() => setPauseModalOpen(true)}
                    disabled={isBusy}
                    aria-label={`Pause ${agent.name}`}
                    className={ACTION_BUTTON_CLASS}
                  >
                    {busyAction === 'pause' ? 'Pausing...' : 'Pause'}
                  </button>
                ) : (
                  <button
                    onClick={() => onResume(agent)}
                    disabled={isBusy}
                    aria-label={`Resume ${agent.name}`}
                    className={ACTION_BUTTON_CLASS}
                  >
                    {busyAction === 'resume' ? 'Resuming...' : 'Resume from pause'}
                  </button>
                )}
              </>
            ) : null}
            {/* #1402: Remove stops the live delegation and archives its
                credential. A legacy agent can only be unlinked after its owner
                has already revoked the old authority outside Haven. */}
            {isDelegationAgent ? (
              <>
                <span className="text-[var(--v2-border-strong)]">|</span>
                <button
                  onClick={() => setRemoveModalOpen(true)}
                  disabled={isBusy}
                  aria-label={`Remove ${agent.name}`}
                  className={DANGER_ACTION_BUTTON_CLASS}
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
              className={DANGER_ACTION_BUTTON_CLASS}
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
              className={`${ACTION_BUTTON_CLASS} whitespace-nowrap`}
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
            Use Pause for a fast, reversible stop. Use Remove to permanently remove the agent from this account.
          </p>
        </div>
      }
      confirmLabel="Pause agent"
      tone="primary"
      loading={busyAction === 'pause'}
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
