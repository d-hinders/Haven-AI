'use client'

/**
 * Agent Passport status on the agent detail page (#1072, epic #970).
 *
 * Issuance is opt-in and asynchronous, so this card renders the two-layer
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
 */

import { useAgentPassport, type PassportAnchorState } from '@/hooks/useAgentPassport'
import { getExplorerUrl } from '@/lib/chains'
import { timeAgo } from '@/lib/format'
import { Card } from './ui/Card'
import { Button } from './ui/Button'
import { StatusBadge, type StatusTone } from './ui/StatusBadge'
import { Skeleton } from './ui/Skeleton'

interface Props {
  agentId: string
  /** Revoked agents cannot issue — mirrors the backend's fail-closed 409. */
  agentRevoked?: boolean
  /** Legacy Safe records remain readable, but cannot issue new attestations. */
  canIssue?: boolean
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

export default function AgentPassportCard({ agentId, agentRevoked = false, canIssue = true }: Props) {
  const { passport, standing, loading, loadError, issuing, issueError, issuePassport, refetch } = useAgentPassport(agentId)

  if (loading && !passport && !standing) {
    return (
      <Card hover={false} className="mt-6 p-5 md:p-6">
        <Skeleton variant="text" className="h-5 w-32" />
        <Skeleton className="mt-3 h-16 rounded-lg" />
      </Card>
    )
  }

  // A failed LOOKUP must never render as the authoritative "Not issued" state
  // (with a live Issue button, no less) — say what actually happened and
  // offer a retry.
  if (loadError && !passport && !standing) {
    return (
      <Card hover={false} className="mt-6 p-5 md:p-6">
        <h2 className="text-base font-semibold text-[var(--v2-ink)]">Agent Passport</h2>
        <p className="mt-2 text-sm text-[var(--v2-ink-muted)]">
          Couldn&apos;t load passport status.{' '}
          <button
            type="button"
            className="rounded-sm font-medium text-[var(--v2-brand)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
            onClick={() => void refetch()}
          >
            Try again
          </button>
        </p>
      </Card>
    )
  }

  const headline = headlineBadge(passport?.status ?? null, standing?.anchor ?? null)
  // The passport's OWN chain_id, not the account's — attestation issuance is
  // gated to a specific chain (currently Base Sepolia only) that can differ
  // from the account's chain.
  const explorerHref =
    passport?.tx_hash ? getExplorerUrl(passport.chain_id, 'tx', passport.tx_hash) : null

  return (
    <Card hover={false} className="mt-6 p-5 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--v2-ink)]">Agent Passport</h2>
          <p className="mt-0.5 text-sm text-[var(--v2-ink-muted)]">
            {canIssue
              ? 'A signed record that this agent was issued by Haven, bound to this wallet, and revocable at any time.'
              : 'A historical signed record for this agent. It is readable here but is not an active Haven control.'}
          </p>
        </div>
        <StatusBadge tone={headline.tone} className="shrink-0">
          {headline.label}
        </StatusBadge>
      </div>

      {passport ? (
        <Card.Section className="mt-4 -mb-1 py-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {standing ? (
              <div>
                <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Standing</dt>
                <dd className="mt-1">
                  <StatusBadge tone={standingBadge(standing.standing).tone}>
                    {standingBadge(standing.standing).label}
                  </StatusBadge>
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
        </Card.Section>
      ) : (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[var(--v2-ink-2)]">
            {canIssue
              ? 'This agent has no passport. Issuing one is optional and does not change what it can spend.'
              : 'This historical agent record has no passport. New passport issuance is unavailable on the retired Safe rail.'}
          </p>
          {canIssue && !agentRevoked ? (
            <Button size="sm" variant="ghost" onClick={() => void issuePassport()} disabled={issuing}>
              {issuing ? 'Issuing…' : 'Issue a passport'}
            </Button>
          ) : null}
        </div>
      )}

      {issueError ? <p className="mt-3 text-xs text-[var(--v2-danger)]">{issueError}</p> : null}
    </Card>
  )
}
