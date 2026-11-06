'use client'

/**
 * Agent Passport status on the agent detail page (#1072, epic #970).
 *
 * Issuance is opt-in and asynchronous, so this renders the two-layer
 * truth honestly: `standing` (active / suspended / revoked, DB-authoritative,
 * live) alongside `anchor` (not_anchored / anchored / re_anchoring /
 * revocation_pending / revoked_onchain, the on-chain lag). Never collapse the
 * two into one badge — see `lib/passport/revocation.ts`.
 *
 * `re_anchoring` (#1699) is the re-key window, and it is the case that makes
 * the two-layer split earn its keep: the agent is fully live and authorised —
 * standing `active` — while the attestation on-chain still names the delegate
 * key the re-key retired. One badge would have to pick a side and would be
 * wrong either way.
 *
 * Naming discipline (docs/product/agent-passport.md, copy-guidelines.md):
 * say issued / governed / revocable. Never "verified" — that word is reserved
 * for L2, which is not issuable yet.
 *
 * Status display only, no revoke control: #973 shipped revocation as
 * automatic and derived (agent revoke -> passport revoke), so there is
 * nothing here for a button to do.
 *
 * #4228 made this a ROW in the agent page's Settings tab rather than a
 * standalone Card; #4477 reshaped it onto the shared `SettingsRow` slots:
 *
 * - **label** — "Agent Passport" and the headline status badge;
 * - **detail** — the one-line description (or, in the not-issued state, the
 *   opt-in sentence);
 * - **action** — Issue a passport, or Try again on a failed lookup;
 * - **below** — the issued state's `dl` grid and its notes, in #4478's
 *   full-width slot. They do not go in `detail`: that column is the left text
 *   block, so below `sm` the action stacks after it and the grid would push
 *   the control under itself.
 *
 * `data-testid="agent-passport-row"` is the layout contract the page tests
 * select on, and it stays on the row root in every state.
 */

import { useAgentPassport, type PassportAnchorState } from '@/hooks/useAgentPassport'
import { getExplorerUrlOrNull } from '@/lib/chains'
import { timeAgo } from '@/lib/format'
import { Button } from './ui/Button'
import { SettingsRow } from './ui/SettingsSection'
import { StatusBadge, type StatusTone } from './ui/StatusBadge'
import { Skeleton } from './ui/Skeleton'

interface Props {
  agentId: string
  /** Revoked agents cannot issue — mirrors the backend's fail-closed 409. */
  agentRevoked?: boolean
}

function headlineBadge(
  status: 'pending' | 'anchored' | 'failed' | null,
  anchor: PassportAnchorState | null,
): { label: string; tone: StatusTone } {
  if (status === null) return { label: 'Not issued', tone: 'neutral' }
  if (status === 'failed') return { label: 'Issuance failed', tone: 'danger' }
  if (status === 'pending') return { label: 'Issuing…', tone: 'neutral' }
  if (anchor === 'revoked_onchain') return { label: 'Revoked on-chain', tone: 'danger' }
  // Above BOTH revocation labels, mirroring the backend's ordering: a re-anchor
  // drives the row through the same revocation columns, so without this the
  // re-key window would read "Revoking…" and then "Revoked on-chain" on a
  // live, fully authorised agent.
  //
  // `neutral`, not `warning`, and this component already settled the question:
  // `'Issuing…'` above is neutral for exactly this shape of state — the system
  // is doing something in the background and the owner has nothing to do.
  // `warning` is earned by `revocation_pending` and `Suspended`, which are
  // changes in posture; here nothing about the agent's posture has changed.
  if (anchor === 're_anchoring') return { label: 'Updating on-chain', tone: 'neutral' }
  if (anchor === 'revocation_pending') return { label: 'Revoking…', tone: 'warning' }
  return { label: 'Issued', tone: 'success' }
}

function standingBadge(standing: 'active' | 'suspended' | 'revoked' | 'unknown'): {
  label: string
  tone: StatusTone
} {
  if (standing === 'active') return { label: 'Active', tone: 'success' }
  if (standing === 'suspended') return { label: 'Suspended', tone: 'warning' }
  if (standing === 'revoked') return { label: 'Revoked', tone: 'danger' }
  return { label: 'Unknown', tone: 'neutral' }
}

/**
 * #4571: what a non-Active standing MEANS for the agent, in words.
 *
 * The card carries two badges on two axes — the title's issuance badge
 * ("Issued", from the attestation) and the Standing row's badge (from the
 * registry). Both are true at once, and side by side with no explanation they
 * read as a contradiction: "Issued" next to "Suspended". The badge logic is
 * right and stays; this sentence is what links the two, so the reader learns
 * that the passport still exists while the agent's authority does not.
 *
 * `active` returns null: there is nothing to explain, and the row stays the
 * one-line badge it has always been.
 */
function standingDescription(standing: 'active' | 'suspended' | 'revoked' | 'unknown'): string | null {
  if (standing === 'active') return null
  if (standing === 'suspended') {
    return 'The agent cannot act until Haven restores it. Its passport stays issued.'
  }
  if (standing === 'revoked') {
    return 'The agent can no longer act. Its passport stays as a record of what was issued.'
  }
  return 'Haven cannot confirm this agent’s standing right now.'
}

/** The row's one-line description, in every state that has one. */
const DESCRIPTION =
  'A signed record that this agent was issued by Haven, bound to this wallet, and revocable at any time.'

export default function AgentPassportCard({ agentId, agentRevoked = false }: Props) {
  const { passport, standing, loading, loadError, issuing, issueError, issuePassport, refetch } = useAgentPassport(agentId)

  if (loading && !passport && !standing) {
    return (
      <SettingsRow
        data-testid="agent-passport-row"
        role="status"
        aria-label="Loading passport status"
        label="Agent Passport"
        detail={<Skeleton variant="text" className="h-4 w-64" />}
        action={<Skeleton variant="text" className="h-5 w-20" />}
      />
    )
  }

  // A failed LOOKUP must never render as the authoritative "Not issued" state
  // (with a live Issue button, no less) — say what actually happened and
  // offer a retry.
  if (loadError && !passport && !standing) {
    return (
      <SettingsRow
        data-testid="agent-passport-row"
        label="Agent Passport"
        detail="Passport status could not load."
        action={
          <button
            type="button"
            className="rounded-sm font-medium text-[var(--v2-brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
            onClick={() => void refetch()}
          >
            Try again
          </button>
        }
      />
    )
  }

  const headline = headlineBadge(passport?.status ?? null, standing?.anchor ?? null)
  // The passport's OWN chain_id, not the account's — attestation issuance is
  // gated to a specific chain (currently Base Sepolia only) that can differ
  // from the account's chain.
  const explorerHref =
    passport?.tx_hash ? getExplorerUrlOrNull(passport.chain_id, 'tx', passport.tx_hash) : null

  return (
    <SettingsRow
      data-testid="agent-passport-row"
      label={
        <span className="flex flex-wrap items-center gap-2">
          Agent Passport
          <StatusBadge tone={headline.tone} className="shrink-0">
            {headline.label}
          </StatusBadge>
        </span>
      }
      detail={
        passport
          ? DESCRIPTION
          : 'This agent has no passport. Issuing one is optional and does not change what it can spend.'
      }
      action={
        passport || agentRevoked ? undefined : (
          <Button size="sm" variant="ghost" onClick={() => void issuePassport()} disabled={issuing}>
            {issuing ? 'Issuing…' : 'Issue a passport'}
          </Button>
        )
      }
      below={
        passport || issueError ? (
          <>
            {passport ? (
              <div className="px-6 pb-4">
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  {standing ? (
                    <div>
                      <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Standing</dt>
                      <dd className="mt-1">
                        <StatusBadge tone={standingBadge(standing.standing).tone}>
                          {standingBadge(standing.standing).label}
                        </StatusBadge>
                        {/* #4571: a non-Active standing explains itself, so the
                            title's "Issued" and this badge stop reading as a
                            contradiction. */}
                        {standingDescription(standing.standing) ? (
                          <p
                            className="mt-1 text-xs text-[var(--v2-ink-3)]"
                            data-testid="agent-passport-standing-description"
                          >
                            {standingDescription(standing.standing)}
                          </p>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Assurance level</dt>
                    <dd className="mt-1 font-medium text-[var(--v2-ink)]">L{passport.assurance_level} · Governance</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Requested</dt>
                    <dd className="mt-1 font-medium text-[var(--v2-ink)]">{timeAgo(passport.requested_at)}</dd>
                  </div>
                  {explorerHref ? (
                    <div>
                      <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Attestation</dt>
                      <dd className="mt-1">
                        <a
                          href={explorerHref}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-sm font-medium text-[var(--v2-brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
                        >
                          View transaction
                        </a>
                        {/* The caveat has to travel WITH the link. The note below
                            explains the whole state, but a reader who clicks
                            straight from the grid lands on an explorer showing the
                            retired key with no on-page context. */}
                        {standing?.anchor === 're_anchoring' ? (
                          <span className="block text-xs text-[var(--v2-ink-3)]">Names the previous key</span>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {passport.status === 'failed' && passport.last_error ? (
                  <p className="mt-3 text-xs text-[var(--v2-danger)]">{passport.last_error}</p>
                ) : null}
                {/* An `else if`, not a second `if`. The two notes contradict each
                    other outright — "treat the agent as revoked now" against "the
                    agent stays active the whole time" — so rendering both would be
                    worse than rendering neither. The backend makes them mutually
                    exclusive (`chainLagging` requires standing `revoked`;
                    `re_anchoring` is only ever produced for a live agent), and this
                    encodes that rather than depending on it holding forever. */}
                {standing?.chainLagging ? (
                  <p className="mt-3 text-xs text-[var(--v2-ink-3)]">
                    Revoked in Haven; the on-chain record has not caught up yet. Treat the agent as
                    revoked now.
                  </p>
                ) : standing?.anchor === 're_anchoring' ? (
                  <p className="mt-3 text-xs text-[var(--v2-ink-3)]">
                    This agent&apos;s signing key was replaced. The on-chain record still names the old
                    key until it is reissued. The agent stays active the whole time.
                  </p>
                ) : null}
              </div>
            ) : null}
            {issueError ? (
              <p className="px-6 pb-4 text-xs text-[var(--v2-danger)]">{issueError}</p>
            ) : null}
          </>
        ) : undefined
      }
    />
  )
}
