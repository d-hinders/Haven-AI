'use client'

/**
 * The customer page body (#3516): one user's record for support.
 *
 * Sections: user header (masked email/name with the reveal control), smart
 * accounts per chain joined with the on-chain view (#3513 — mismatch flags,
 * the `not_read`/`not_served` reasons, and a budget the chain could not read
 * rendered as **unavailable**, never as a number), agents and delegations,
 * recent payments (status plus the redacted error) and the classified
 * refusals (over budget, wrong recipient, expired).
 *
 * Every read here is audited server-side; the page adds nothing writable.
 */
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Card, EmptyState, InlineAlert, PageHeader, StatusBadge } from '@haven_ai/ui'
import { useOpsClient } from '../useOpsClient'
import { MaskedField } from '../MaskedField'
import { PageStates } from '../PageStates'
import type { OpsReadError } from '../../lib/ops-client'
import type { OpsOnchainView, OpsUserDetail } from '../../lib/ops-types'
import { chainName, formatAtomic, unixLine, utcLine } from '../../lib/format'
import {
  REFUSAL_CLASS_LABEL,
  REFUSAL_CLASS_TONE,
  classifyRefusal,
} from '../../lib/refusals'

/**
 * One smart account row joined with its on-chain view (#3513). The account
 * renders from the DETAIL row; the chain view only adds what it verified.
 * A `not_served` account renders its reason — a condition, not an error.
 */
function OnchainAccountRow({
  account,
  onchain,
}: {
  account: OpsUserDetail['smart_accounts'][number]
  onchain: OpsOnchainView | null
}) {
  const view = onchain?.accounts.find((a) => 'account_id' in a && a.account_id === account.id)
  if (view === undefined) {
    return (
      <div className="rounded-lg border border-[var(--v2-border)] p-4">
        <p className="text-sm font-medium text-[var(--v2-ink)]">{account.name || account.account_type}</p>
        <p className="v2-tabular mt-0.5 text-xs text-[var(--v2-ink-3)]">
          chain {account.chain_id} · {account.account_address}
        </p>
        <p className="mt-2 text-xs text-[var(--v2-ink-2)]">On-chain view not read for this account.</p>
      </div>
    )
  }
  if ('status' in view) {
    // The not-served variant is the one that CARRIES `status` (#3513's
    // `OpsOnchainNotServedAccount`); narrowing on it keeps the served branch
    // below honest about the shape it reads.
    const reasons: Record<typeof view.reason, string> = {
      legacy_safe: 'A legacy Safe record — never read on-chain by this console.',
      chain_not_served: 'This environment does not serve the chain.',
      chain_not_pinned: 'The chain has no pinned delegation contracts.',
    }
    return (
      <div className="rounded-lg border border-[var(--v2-border)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-[var(--v2-ink)]">{account.name || account.account_type}</p>
          <StatusBadge tone="neutral">{view.status}</StatusBadge>
        </div>
        <p className="v2-tabular mt-0.5 text-xs text-[var(--v2-ink-3)]">
          chain {account.chain_id} · {account.account_address}
        </p>
        <p className="mt-2 text-xs text-[var(--v2-ink-2)]">{reasons[view.reason]}</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-[var(--v2-border)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-[var(--v2-ink)]">{account.name || account.account_type}</p>
        <div className="flex flex-wrap items-center gap-2">
          {view.flags.counterfactual_with_active_delegation ? (
            <StatusBadge tone="warning">counterfactual with active delegation</StatusBadge>
          ) : null}
          {view.flags.delegation_disabled_onchain_active_in_db ? (
            <StatusBadge tone="danger">delegation disabled on-chain, active in DB</StatusBadge>
          ) : null}
          <StatusBadge tone={view.chain.deploy_status === 'deployed' ? 'success' : 'neutral'}>
            {view.chain.deploy_status}
          </StatusBadge>
        </div>
      </div>
      <p className="v2-tabular mt-0.5 text-xs text-[var(--v2-ink-3)]">
        {chainName(account.chain_id)} · {account.account_address}
      </p>
      <div className="mt-3 space-y-2">
        {view.db.active_delegations.length === 0 ? (
          <p className="text-xs text-[var(--v2-ink-2)]">No active delegations stored.</p>
        ) : (
          view.db.active_delegations.map((dbRow, index) => {
            const onchainRow = view.chain.delegations[index]
            if (onchainRow === undefined) {
              return (
                <div key={index} className="flex items-center justify-between text-xs">
                  <span className="v2-tabular text-[var(--v2-ink-2)]">
                    {formatAtomic(dbRow.budget_atomic, 6)} budget
                  </span>
                  <span className="text-[var(--v2-ink-3)]">not_read — no on-chain read for this delegation</span>
                </div>
              )
            }
            return (
              <div key={index} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                <span className="v2-tabular text-[var(--v2-ink-2)]">
                  {formatAtomic(dbRow.budget_atomic, 6)} budget
                  {onchainRow.onchain === 'disabled'
                    ? ' · disabled on-chain'
                    : onchainRow.onchain === 'unknown'
                      ? ' · read pending'
                      : onchainRow.onchain === 'unavailable'
                        ? ' · read failed'
                        : null}
                </span>
                {onchainRow.budget_status === 'from_chain' && onchainRow.budget_remaining_atomic !== null ? (
                  <span className="v2-tabular text-[var(--v2-ink)]">
                    remaining {formatAtomic(onchainRow.budget_remaining_atomic, 6)}
                  </span>
                ) : (
                  <StatusBadge tone="neutral">unavailable</StatusBadge>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function AgentsCard({ detail }: { detail: OpsUserDetail }) {
  return (
    <Card className="overflow-hidden" hover={false}>
      <Card.Header
        as="h2"
        padding="none"
        title="Agents"
        actions={<span className="v2-tabular text-xs text-[var(--v2-ink-3)]">{detail.agents.length}</span>}
      />
      <Card.Section divided>
        {detail.agents.map((agent) => (
          <div key={agent.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--v2-ink)]">{agent.name}</p>
              <p className="v2-tabular mt-0.5 text-xs text-[var(--v2-ink-3)]">
                id {agent.id}
                {agent.archived_at !== null ? ` · archived ${utcLine(agent.archived_at)}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              {agent.delegate_address !== null ? (
                <span className="v2-tabular text-[var(--v2-ink-3)]">{agent.delegate_address}</span>
              ) : null}
              <StatusBadge
                tone={agent.status === 'active' ? 'success' : agent.status === 'revoked' ? 'danger' : 'neutral'}
              >
                {agent.status}
              </StatusBadge>
            </div>
          </div>
        ))}
      </Card.Section>
    </Card>
  )
}

function DelegationsCard({ detail }: { detail: OpsUserDetail }) {
  if (detail.active_delegations.length === 0) {
    return (
      <Card className="p-6" hover={false}>
        <EmptyState
          title="No active delegations"
          body="None of this user's agents holds a live budget."
          size="compact"
        />
      </Card>
    )
  }
  return (
    <Card className="overflow-hidden" hover={false}>
      <Card.Header
        as="h2"
        padding="none"
        title="Active delegations"
        actions={
          <span className="v2-tabular text-xs text-[var(--v2-ink-3)]">{detail.active_delegations.length}</span>
        }
      />
      <Card.Section divided>
        {detail.active_delegations.map((delegation) => (
          <div
            key={delegation.id}
            className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm"
          >
            <div className="min-w-0">
              <p className="v2-tabular font-medium text-[var(--v2-ink)]">
                {formatAtomic(delegation.budget_atomic, 6)} budget
              </p>
              <p className="v2-tabular mt-0.5 text-xs text-[var(--v2-ink-3)]">
                agent {delegation.agent_id} · chain {delegation.chain_id}
                {delegation.recipient_address !== null
                  ? ` · pinned to ${delegation.recipient_address}`
                  : ' · open budget'}
              </p>
            </div>
            <p className="v2-tabular text-xs text-[var(--v2-ink-3)]">
              {unixLine(delegation.start_date)} → {unixLine(delegation.expires_at)}
            </p>
          </div>
        ))}
      </Card.Section>
    </Card>
  )
}

function PaymentsCard({ detail }: { detail: OpsUserDetail }) {
  if (detail.payment_intents.length === 0) {
    return (
      <Card className="p-6" hover={false}>
        <EmptyState title="No payments yet" size="compact" />
      </Card>
    )
  }
  return (
    <Card className="overflow-hidden" hover={false}>
      <Card.Header
        as="h2"
        padding="none"
        title="Recent payments"
        description="Status plus the stored, redacted error."
      />
      <Card.Section divided>
        {detail.payment_intents.map((payment) => (
          <div key={payment.id} className="px-5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="v2-tabular text-sm font-medium text-[var(--v2-ink)]">
                {payment.amount_human} {payment.token_symbol}
              </p>
              <div className="flex items-center gap-3 text-xs">
                <span className="v2-tabular text-[var(--v2-ink-3)]">{utcLine(payment.created_at)}</span>
                <StatusBadge
                  tone={
                    payment.status === 'confirmed' ? 'success' : payment.status === 'failed' ? 'danger' : 'neutral'
                  }
                >
                  {payment.status}
                </StatusBadge>
              </div>
            </div>
            {payment.error_message !== null ? (
              <p className="mt-1 text-xs text-[var(--v2-ink-2)]">{payment.error_message}</p>
            ) : null}
          </div>
        ))}
      </Card.Section>
    </Card>
  )
}

function RefusalsCard({ detail }: { detail: OpsUserDetail }) {
  if (detail.payment_refusals.length === 0) {
    return (
      <Card className="p-6" hover={false}>
        <EmptyState title="No refusals recorded" body="Every attempted payment passed the guardrails." size="compact" />
      </Card>
    )
  }
  return (
    <Card className="overflow-hidden" hover={false}>
      <Card.Header
        as="h2"
        padding="none"
        title="Refusals"
        description="Classified: over budget, wrong recipient, expired. Everything else renders as what it is."
      />
      <Card.Section divided>
        {detail.payment_refusals.map((refusal) => {
          const klass = classifyRefusal(refusal.reason)
          return (
            <div key={refusal.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div className="flex items-center gap-3">
                <StatusBadge tone={REFUSAL_CLASS_TONE[klass]}>{REFUSAL_CLASS_LABEL[klass]}</StatusBadge>
                <p className="v2-tabular text-sm text-[var(--v2-ink)]">
                  {formatAtomic(refusal.amount_atomic, 6)} {refusal.token_symbol}
                </p>
              </div>
              <p className="v2-tabular text-xs text-[var(--v2-ink-3)]">
                {refusal.reason} · {refusal.source} · {utcLine(refusal.created_at)}
              </p>
            </div>
          )
        })}
      </Card.Section>
    </Card>
  )
}

function UserHeader({
  detail,
  reveal,
}: {
  detail: OpsUserDetail
  reveal: ReturnType<typeof useOpsClient>['reveal']
}) {
  return (
    <Card className="p-6" hover={false}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-3">
          <MaskedField
            label="Email"
            masked={detail.user.email}
            request={{ target_type: 'user', target_id: detail.user.id, field: 'email' }}
            reveal={reveal}
          />
          <MaskedField
            label="Name"
            masked={detail.user.name ?? ''}
            nullable={detail.user.name === null}
            request={{ target_type: 'user', target_id: detail.user.id, field: 'name' }}
            reveal={reveal}
          />
        </div>
        <div className="text-right text-xs text-[var(--v2-ink-3)]">
          <p className="v2-tabular">id {detail.user.id}</p>
          <p className="v2-tabular mt-1">joined {utcLine(detail.user.created_at)}</p>
        </div>
      </div>
    </Card>
  )
}

export function CustomerView({
  userId,
  client,
}: {
  userId: string
  client: ReturnType<typeof useOpsClient>
}) {
  const [detail, setDetail] = useState<OpsUserDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [onchain, setOnchain] = useState<OpsOnchainView | null>(null)
  const [onchainError, setOnchainError] = useState<OpsReadError | null>(null)
  const [error, setError] = useState<OpsReadError | null>(null)

  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setNotFound(false)
    setOnchain(null)
    setOnchainError(null)
    setError(null)
    client.user(userId).then((read) => {
      if (cancelled) return
      if (!read.ok) {
        setError(read.error)
        return
      }
      if (read.data === null) {
        setNotFound(true)
        return
      }
      setDetail(read.data)
      // The on-chain view is best-effort (#3513): a failure renders as an
      // inline note on the accounts section, never as a failed page.
      client.onchain(userId).then((chainRead) => {
        if (cancelled) return
        if (chainRead.ok) setOnchain(chainRead.data)
        else setOnchainError(chainRead.error)
      })
    })
    return () => {
      cancelled = true
    }
  }, [client, userId])

  if (notFound) {
    return (
      <div className="space-y-6">
        <PageHeader title="Customer" />
        <Card className="p-6" hover={false}>
          <EmptyState
            title="No user with that id"
            body="The id is a UUID — go back to Search and paste the term again."
            action={
              <Link href="/search" className="text-sm font-medium text-[var(--v2-brand)] underline">
                Back to search
              </Link>
            }
          />
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Customer" subtitle="The masked record. Reveals are audited, one field at a time." />
      <PageStates
        loading={detail === null && error === null}
        // A user record is never "empty" — an unknown id is its own state above.
        empty={false}
        error={error}
        emptyTitle="Nothing to show"
      >
        {detail !== null ? (
          <div className="space-y-6">
            <UserHeader detail={detail} reveal={client.reveal} />
            <div>
              <h2 className="mb-3 text-sm font-semibold text-[var(--v2-ink)]">Smart accounts and on-chain view</h2>
              {onchainError !== null ? (
                <Card className="p-4" hover={false}>
                  <InlineAlert>On-chain view could not be read: {onchainError.message}</InlineAlert>
                </Card>
              ) : null}
              <div className="space-y-3">
                {detail.smart_accounts.length === 0 ? (
                  <Card className="p-6" hover={false}>
                    <EmptyState title="No smart accounts" size="compact" />
                  </Card>
                ) : (
                  detail.smart_accounts.map((account) => (
                    <OnchainAccountRow key={account.id} account={account} onchain={onchain} />
                  ))
                )}
              </div>
            </div>
            <AgentsCard detail={detail} />
            <DelegationsCard detail={detail} />
            <PaymentsCard detail={detail} />
            <RefusalsCard detail={detail} />
          </div>
        ) : null}
      </PageStates>
    </div>
  )
}
