'use client'

/**
 * Agent Passport status on the agent detail page (#1072, epic #970).
 *
 * Issuance is opt-in and asynchronous, so this card renders the two-layer
 * truth honestly: `standing` (active / suspended / revoked, DB-authoritative,
 * live) alongside `anchor` (not_anchored / anchored / revocation_pending /
 * revoked_onchain, the on-chain lag). Never collapse the two into one badge —
 * see `lib/passport/revocation.ts`.
 *
 * Naming discipline (docs/product/agent-passport.md, copy-guidelines.md):
 * say issued / governed / revocable. Never "verified" — that word is reserved
 * for L2, which is not issuable yet.
 *
 * Status display only, no revoke control: #973 shipped revocation as
 * automatic and derived (agent revoke -> passport revoke), so there is
 * nothing here for a button to do.
 */

import { useAgentPassport } from '@/hooks/useAgentPassport'
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
}

function headlineBadge(
  status: 'pending' | 'anchored' | 'failed' | null,
  anchor: 'not_anchored' | 'anchored' | 'revocation_pending' | 'revoked_onchain' | null,
): { label: string; tone: StatusTone } {
  if (status === null) return { label: 'Not issued', tone: 'neutral' }
  if (status === 'failed') return { label: 'Issuance failed', tone: 'danger' }
  if (status === 'pending') return { label: 'Issuing…', tone: 'neutral' }
  if (anchor === 'revoked_onchain') return { label: 'Revoked on-chain', tone: 'danger' }
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

export default function AgentPassportCard({ agentId, agentRevoked = false }: Props) {
  const { passport, standing, loading, issuing, issueError, issuePassport } = useAgentPassport(agentId)

  if (loading && !passport && !standing) {
    return (
      <Card hover={false} className="mt-6 p-5 md:p-6">
        <Skeleton variant="text" className="h-5 w-32" />
        <Skeleton className="mt-3 h-16 rounded-lg" />
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
            A signed record that this agent was issued by Haven, bound to this account, and
            revocable at any time.
          </p>
        </div>
        <StatusBadge tone={headline.tone}>{headline.label}</StatusBadge>
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
                    className="font-medium text-[var(--v2-brand)] hover:underline"
                  >
                    View transaction
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
          {passport.status === 'failed' && passport.last_error ? (
            <p className="mt-3 text-xs text-[var(--v2-danger)]">{passport.last_error}</p>
          ) : null}
          {standing?.chainLagging ? (
            <p className="mt-3 text-xs text-[var(--v2-ink-3)]">
              Revoked in Haven; the on-chain record has not caught up yet. Treat the agent as
              revoked now.
            </p>
          ) : null}
        </Card.Section>
      ) : (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[var(--v2-ink-2)]">
            This agent has no passport. Issuing one is optional and does not change what it can
            spend.
          </p>
          {!agentRevoked ? (
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
