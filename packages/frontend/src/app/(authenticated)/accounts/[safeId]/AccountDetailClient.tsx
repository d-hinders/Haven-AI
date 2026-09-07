'use client'

import { EllipsisVertical, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useAuth, type UserSafe } from '@/context/AuthContext'
import { useBalances } from '@/hooks/useBalances'
import { useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import { usePortfolio } from '@/hooks/usePortfolio'
import { usePreferences } from '@/hooks/usePreferences'
import { useContacts } from '@/hooks/useContacts'
import { useAgents, type Agent } from '@/hooks/useAgents'
import { useUserSafes } from '@/hooks/useUserSafes'
import { ApiRequestError } from '@/lib/api'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import DelegationSendModal from '@/components/DelegationSendModal'
import AccountSignersCard from '@/components/AccountSignersCard'
import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import ConfirmDialog from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { CopyButton } from '@/components/ui/CopyButton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { PageHeader } from '@/components/ui/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Row } from '@/components/ui/Row'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Skeleton } from '@/components/ui/Skeleton'
import { ExternalDetailsLink } from '@/components/haven'
import { useToast } from '@/components/ui/Toast'
import { getExplorerUrl, getChainConfig, DEFAULT_CHAIN_ID } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { agentStatusPresentation } from '@/lib/payment-status'
import { formatAgentLastActivity } from '@/lib/agent-last-seen'
import { Tooltip } from '@/components/ui/Tooltip'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { useFocusTrap } from '@/hooks/useFocusTrap'

function formatFiatValue(value: number, currency: 'USD' | 'EUR'): string {
  return new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}


function formatResetPeriod(minutes: number): string {
  if (minutes === 1440) return 'per day'
  if (minutes === 10080) return 'per week'
  if (minutes === 43200) return 'per month'
  return `every ${minutes} minutes`
}

function agentBudgetSummary(agent: Agent, chainId: number | null): string {
  if (agent.status === 'revoked') return 'Access revoked'
  const allowances = agent.allowances ?? []
  if (allowances.length === 0) return 'No agent budget set'
  if (allowances.length > 1) return `${allowances.length} agent budgets`

  const allowance = allowances[0]
  const amount = formatAllowanceForToken(
    allowance.allowance_amount,
    chainId,
    allowance.token_symbol,
  )
  return `${amount} ${allowance.token_symbol} ${formatResetPeriod(allowance.reset_period_min)}`
}

function agentAccessSummary(agent: Agent, chainId: number | null): string {
  return `${agentBudgetSummary(agent, chainId)} · ${formatAgentLastActivity(agent.mcp_last_seen_at)}`
}


export default function AccountDetailClient() {
  const params = useParams()
  const router = useRouter()
  const safeId = params.safeId as string

  const { user, activeSafe, setActiveSafe, loading: authLoading, passkeys = [] } = useAuth()
  const { renameSafe, removeSafe, setDefault, loading: safesLoading } = useUserSafes()
  const { toast } = useToast()
  const { currency } = usePreferences()
  const { contacts, error: contactsError, resolveAddress } = useContacts()
  const { agents, loading: agentsLoading, error: agentsError, refetch: refetchAgents } = useAgents()

  // Find this Safe from user's list
  const safe = user?.safes?.find((s) => s.id === safeId)
  const safeAddress = safe?.safe_address ?? null
  const chainId = safe?.chain_id ?? DEFAULT_CHAIN_ID

  // Keep the active Safe in sync with the route. Runs as an effect so we
  // never call setState during render.
  useEffect(() => {
    if (safe && activeSafe?.id !== safe.id) {
      setActiveSafe(safe)
    }
  }, [safe, activeSafe, setActiveSafe])

  const safeNamesByAddress = new Map<string, string>()
  for (const account of user?.safes ?? []) {
    safeNamesByAddress.set(
      `${account.safe_address.toLowerCase()}:${account.chain_id}`,
      account.name,
    )
  }

  // Build linked-agent list
  const safeAgents = agents.filter((a) => a.safe_id === safeId)


  // #2413: the deposit gate was about retired accounts, which no longer
  // render. Every account reachable here is a live delegation account whose
  // owner can move funds out, so Receive is unconditional again.

  const {
    totalUsd,
    totalEur,
    breakdown,
    loading: portfolioLoading,
    error: portfolioError,
    refetch: refetchPortfolio,
  } = usePortfolio(safeAddress, { chainId })

  const {
    balances,
    error: balancesError,
    refetch: refetchBalances,
  } = useBalances(safeAddress, { chainId })

  const {
    transactions,
    loadingInitial: txLoading,
    error: txError,
    total,
    hasMore,
    refresh: refetchTx,
  } = useTransactionsFeed({ safeId }, 10)

  const totalFiat = currency === 'EUR' ? totalEur : totalUsd
  const chain = getChainConfig(chainId)
  const formattedTotal = formatFiatValue(totalFiat, currency)
  const balanceUnavailable = Boolean(portfolioError || balancesError)
  const [renameOpen, setRenameOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<{ message: string; retryable: boolean } | null>(
    null,
  )
  const [sendOpen, setSendOpen] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)

  const handleSendSuccess = () => {
    refetchBalances()
    refetchPortfolio()
    void refetchTx()
  }

  const handleBalancesRefresh = () => {
    refetchBalances()
    refetchPortfolio()
  }

  const handleRename = async (name: string) => {
    if (!safe) return
    await renameSafe(safe.id, name)
    setRenameOpen(false)
  }

  // The unlink is REFUSED, not merely failed, while an agent on this account
  // still holds spending authority or a recovery is mid-flight — the backend
  // answers 409 and keeps the account intact. Without a catch the rejection
  // became an unhandled promise rejection: the button stopped spinning and
  // nothing else happened, so the refusal read as a broken button.
  //
  // Deliberately NOT `err.message`, matching `RemoveAgentDialog`: `api.ts`
  // throws the backend's raw error string, and this is a destructive-flow
  // dialog. The 409's three causes share one remedy the user can act on, so
  // the copy names that instead of restating the server's sentence.
  //
  // Two words in it are load-bearing, both from the design review:
  //  - "a budget", not "an active budget" — `HAS_LIVE_DELEGATIONS_FOR_SAFE_SQL`
  //    matches `status IN ('pending', 'active')`, so a grant that was never
  //    activated blocks the unlink too.
  //  - "recovering funds", not "a recovery" — this page already renders a
  //    "Backup & recovery" card (`AccountSignersCard`), which is signer
  //    replacement and has nothing to do with the sweep this refusal means.
  //    The phrasing follows the sweep screen's own vocabulary instead.
  const handleRemoveConfirmed = async () => {
    if (!safe) return
    setRemoving(true)
    setRemoveError(null)
    try {
      await removeSafe(safe.id)
      router.push('/accounts')
    } catch (err) {
      setRemoveError(
        err instanceof ApiRequestError && err.status === 409
          ? {
              message:
                'An agent on this account still has a budget, or is part-way through recovering funds or replacing its signing key. Finish or stop that from the Agents page, then remove the account.',
              // The remedy is OUTSIDE this dialog and `Modal`'s backdrop blocks
              // the page behind it, so pressing the primary action again can
              // only reproduce the identical refusal. `RemoveAgentDialog` draws
              // the same line: its `filing_failed` (retryable here) relabels to
              // "Finish removal", while `too_many` (go act elsewhere) keeps the
              // original label rather than inviting a useless second press.
              retryable: false,
            }
          : {
              message: 'The account could not be removed. Check your connection and try again.',
              retryable: true,
            },
      )
    } finally {
      setRemoving(false)
    }
  }

  const closeRemoveDialog = () => {
    setRemoveOpen(false)
    setRemoveError(null)
  }

  // While auth context is still hydrating `user.safes`, avoid flashing
  // "Account not found" — the safe lookup will resolve once safes load.
  if (authLoading || !user) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading account" className="max-w-5xl py-16 flex items-center justify-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--v2-brand)] animate-pulse" />
        <span className="text-xs text-[var(--v2-ink-3)]">Loading account...</span>
      </div>
    )
  }

  if (!safe) {
    return (
      <div className="max-w-5xl py-16 text-center">
        <p className="text-sm text-[var(--v2-ink-3)]">Account not found</p>
      </div>
    )
  }

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        title={safe.name}
        subtitle={
          'Control the funds, agent access, and recent activity for this Haven wallet.'
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {safe.is_default && (user?.safes?.length ?? 0) > 1 ? (
              <StatusBadge tone="brand">Default</StatusBadge>
            ) : null}
            <StatusBadge>{chain.name}</StatusBadge>
            {safeAddress && (
              <>
                {/* #1083 gave Send to BOTH rails. #1989 (epic #1440) took it
                    back off the legacy Safe rail: that path signed a Safe
                    transaction through `SendModal`, which is deleted with the
                    rail. Delegation accounts keep the sponsored owner-send.
                    Hidden rather than disabled, per #1079 — a legacy account
                    stays fully readable and simply offers no spend action. */}
                <Button onClick={() => setSendOpen(true)}>
                  Send
                </Button>
                <Button variant="ghost" onClick={() => setReceiveOpen(true)}>
                  Receive
                </Button>
              </>
            )}
            {/*
              Account-level settings live behind a kebab menu so they don't
              compete visually with the transactional Send/Receive buttons.
              "Rename" + "Remove" are direct actions; "Set as default" only
              appears when this isn't already the default Safe.
            */}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account options"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-[var(--v2-border)] bg-white text-[var(--v2-ink-2)] transition-colors hover:border-[var(--v2-border-strong)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                <Icon icon={EllipsisVertical} className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                  Rename
                </DropdownMenuItem>
                {!safe.is_default && (user?.safes?.length ?? 0) > 1 ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      void setDefault(safe.id)
                      toast.success(`${safe.name} is now your default account`)
                    }}
                  >
                    Set as default
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => setRemoveOpen(true)}>
                  Remove account
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <Card hover={false} elevation="raised" className="overflow-hidden">
        <Card.Header padding="none" className="px-5 py-5 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-[var(--v2-ink-3)]">Total balance</p>
              {portfolioLoading ? (
                <Skeleton className="mt-3 h-9 w-44" />
              ) : balanceUnavailable ? (
                <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink-3)] v2-tabular">
                  Unavailable
                </p>
              ) : (
                <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
                  {formattedTotal}
                </p>
              )}
            </div>
            <p className="max-w-sm text-sm leading-relaxed text-[var(--v2-ink-2)]">
              Sum of all tokens held by this Haven wallet, converted to {currency}.
            </p>
          </div>
        </Card.Header>

        <div className="p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-[var(--v2-ink)]">Token balances</h2>
            <Button
              type="button"
              variant="tertiary"
              size="sm"
              onClick={handleBalancesRefresh}
            >
              Refresh
            </Button>
          </div>
          {portfolioLoading ? (
            <div role="status" aria-busy="true" aria-label="Loading token balances" className="space-y-2">
              {[0, 1, 2].map((item) => (
                <div key={item} className="grid grid-cols-3 gap-4 px-2 py-2">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 w-20 justify-self-end" />
                  <Skeleton className="h-4 w-24 justify-self-end" />
                </div>
              ))}
            </div>
          ) : balancesError || portfolioError ? (
            <EmptyState
              title="Balances could not load"
              body={portfolioError ?? balancesError}
              className="py-8"
              action={<Button variant="ghost" size="sm" onClick={handleBalancesRefresh}>Try again</Button>}
            />
          ) : breakdown.length === 0 ? (
            <EmptyState
              title="No token balances yet"
              body="Receive funds to see tokens in this Haven wallet."
              className="py-8"
              action={safeAddress ? <Button size="sm" onClick={() => setReceiveOpen(true)}>Receive funds</Button> : null}
            />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4 text-xs text-[var(--v2-ink-3)] mb-2 px-2">
                <span>Asset</span>
                <span className="text-right">Balance</span>
                <span className="text-right">
                  Value ({currency})
                </span>
              </div>
              {breakdown.map((item) => {
                const fiatValue = currency === 'EUR' ? item.eurValue : item.usdValue
                return (
                  <div
                    key={item.symbol}
                    className="grid grid-cols-3 gap-4 px-2 py-2 rounded-md hover:bg-[var(--v2-surface)] transition-colors"
                  >
                    <span className="text-sm text-[var(--v2-ink)]">{item.symbol}</span>
                    <span className="text-sm text-[var(--v2-ink-2)] text-right font-mono v2-tabular">
                      {item.formatted}
                    </span>
                    <span className="text-sm text-[var(--v2-ink)] text-right v2-tabular">
                      {formatFiatValue(fiatValue, currency)}
                    </span>
                  </div>
                )
              })}
            </>
          )}
        </div>
      </Card>

      <Card hover={false}>
        <div className="px-5 pt-5 sm:px-6 sm:pt-6">
          <div className="flex items-center gap-3">
            <h2 className="text-base font-semibold text-[var(--v2-ink)]">Agent access</h2>
            <Button
              href="/agents"
              variant="tertiary"
              size="sm"
              trailingIcon
            >
              View all agents
            </Button>
          </div>
          <p className="mt-1 max-w-2xl pb-5 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            Agents can request payments from this Haven wallet when their status and agent budget allow it.
          </p>
        </div>

        {agentsLoading ? (
          <div role="status" aria-busy="true" aria-label="Loading agent access">
            <Card.Section divided>
              {[0, 1, 2].map((item) => (
                <div key={item} className="px-4 py-3.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="mt-2 h-3 w-24" />
                </div>
              ))}
            </Card.Section>
          </div>
        ) : agentsError && safeAgents.length > 0 ? (
          <>
            <div className="border-t border-warning/30 px-5 py-3 text-sm text-[var(--v2-ink-2)]">
              <div className="flex flex-wrap items-center justify-between gap-3" role="alert">
                <span>Showing the last successful agent records. Try again to refresh them.</span>
                <Button variant="ghost" size="sm" onClick={() => refetchAgents()}>Try again</Button>
              </div>
            </div>
            <Card.Section divided>
              {safeAgents.map((agent) => {
                const status = agentStatusPresentation(agent.status)
                return (
                  <Row
                    key={agent.id}
                    href={`/agents/${agent.id}`}
                    title={agent.name}
                    subtitle={agentAccessSummary(agent, chainId)}
                    trailing={
                      agent.status === 'active'
                        ? undefined
                        : <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    }
                  />
                )
              })}
            </Card.Section>
          </>
        ) : agentsError ? (
          <div className="border-t border-[var(--v2-border)]">
            <EmptyState
              title="Agent access could not load"
              body={
                'Haven could not verify which agents can request payments from this wallet.'
              }
              className="py-8"
              action={<Button variant="ghost" size="sm" onClick={() => refetchAgents()}>Try again</Button>}
            />
          </div>
        ) : safeAgents.length > 0 ? (
          <Card.Section divided>
            {safeAgents.map((agent) => {
              const status = agentStatusPresentation(agent.status)
              return (
                <Row
                  key={agent.id}
                  href={`/agents/${agent.id}`}
                  title={agent.name}
                  subtitle={agentAccessSummary(agent, chainId)}
                  trailing={
                    agent.status === 'active'
                      ? undefined
                      : <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  }
                />
              )
            })}
          </Card.Section>
        ) : (
          <div className="border-t border-[var(--v2-border)]">
            <EmptyState
              title="No agents connected"
              body={
                'Connect an agent when you want it to request payments from this Haven wallet.'
              }
              className="py-8"
              action={
                <Button href="/agents" size="sm">Connect agent</Button>
              }
            />
          </div>
        )}
      </Card>

      {/* #1089: backup & recovery is an account capability, not an agent one —
          it works from the moment the account exists, with no agent required. */}
      <AccountSignersCard
        safeAddress={safe.safe_address}
        chainId={chainId}
        userEmail={user?.email ?? ''}
      />

      {/* Account info */}
      <Card hover={false} className="p-5 sm:p-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-[var(--v2-ink)]">
            Advanced account details
          </h2>
        </div>

        {/* #2413: single-column now. This was `sm:grid-cols-2` for the Address
            / Required-approvals pair; with the approvals block deleted, the
            two-column rule left the lone remaining child in column 1 and a
            dead half-card to its right at `sm:` and above. Caught by the
            rendered design pass, on a route the screenshot set did not cover. */}
        <div className="grid grid-cols-1 gap-6">
          {/* Address */}
          <div>
            <p className="text-xs text-[var(--v2-ink-3)] mb-1">Haven wallet address</p>
            <div className="flex items-center gap-3">
              {safeAddress ? (
                <Tooltip label={safeAddress} mono>
                  <span className="text-sm font-mono text-[var(--v2-ink)]">
                    {truncate(safeAddress)}
                  </span>
                </Tooltip>
              ) : (
                <span className="text-sm font-mono text-[var(--v2-ink)]">—</span>
              )}
              {safeAddress && <CopyButton value={safeAddress} label="address" />}
              {safeAddress && <ExternalDetailsLink href={getExplorerUrl(chainId, 'address', safeAddress)} label="Open wallet address externally" />}
            </div>
          </div>
          {/* #2413: "Required approvals" and "Approvers" lived here. Both were
              fed by the Safe-details read that this slice deletes, and both
              were already inert for a delegation account — the hook behind
              them was gated to the retired rail. Delegation signers are shown
              by AccountSignersCard above, which is the live control. */}
        </div>
      </Card>

      {/* Full transaction history */}
      <div>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-[var(--v2-ink)]">Transaction history</h2>
              {!txLoading && total > 0 ? (
                <Button
                  href={`/transactions?safeId=${encodeURIComponent(safeId)}`}
                  variant="tertiary"
                  size="sm"
                  trailingIcon
                >
                  View all
                </Button>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-[var(--v2-ink-3)]">
              {txLoading
                ? 'Loading activity...'
                : `${total} transaction${total !== 1 ? 's' : ''} for this Haven wallet`}
            </p>
          </div>
          {!txLoading && transactions.length > 0 ? (
            <p className="text-xs text-[var(--v2-ink-3)]">Showing <span className="v2-tabular">{transactions.length}</span> of <span className="v2-tabular">{total}</span></p>
          ) : null}
        </div>
        <Card hover={false}>
          <TransactionsTable
            transactions={transactions}
            loading={txLoading}
            error={txError}
            onRefresh={() => void refetchTx()}
            resolveAddress={resolveAddress}
            safeNamesByAddress={safeNamesByAddress}
            hasActiveFilters={false}
            variant="card"
            emptyState={{
              title: 'No activity yet',
              body: 'Inbound and outbound payments for this Haven wallet will appear here.',
            }}
          />
        </Card>
        {transactions.length > 0 && hasMore ? (
          <div className="mt-5 flex justify-center">
            <Button href={`/transactions?safeId=${encodeURIComponent(safeId)}`} variant="ghost">
              View all
            </Button>
          </div>
        ) : null}
      </div>

      {/*
        Mount the modal only while open so its wallet hooks
        (useSendTransaction / useActiveSigner / useSafeOperationGate, each
        backing a wagmi wallet-client subscription) don't run in the
        background on every account page view.
      */}
      {sendOpen && safeAddress && (
        <DelegationSendModal
          open
          onClose={() => setSendOpen(false)}
          accountAddress={safeAddress}
          chainId={chainId}
          onSent={handleSendSuccess}
        />
      )}
      <ReceiveFundsModal
        open={receiveOpen}
        safe={safe}
        onClose={() => setReceiveOpen(false)}
      />
      {renameOpen && (
        <RenameModal
          safe={safe}
          onClose={() => setRenameOpen(false)}
          onRename={handleRename}
          loading={safesLoading}
        />
      )}
      <ConfirmDialog
        open={removeOpen}
        onCancel={closeRemoveDialog}
        onConfirm={handleRemoveConfirmed}
        title={`Remove ${safe.name}?`}
        body={(
          <div className="space-y-3">
            <p>
              This only removes the account from Haven. Funds on-chain are unaffected. Removing it
              may permanently remove this read-only record from Haven.
            </p>
            {removeError && (
              <InlineAlert>{removeError.message}</InlineAlert>
            )}
          </div>
        )}
        confirmLabel={removeError?.retryable ? 'Try again' : 'Remove account'}
        loading={removing}
      />
    </div>
  )
}

function RenameModal({
  safe,
  onClose,
  onRename,
  loading,
}: {
  safe: UserSafe
  onClose: () => void
  onRename: (name: string) => Promise<void>
  loading: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [name, setName] = useState(safe.name)
  const [error, setError] = useState('')
  useFocusTrap(panelRef, true)
  useEscapeToClose(true, onClose, { enabled: !loading })

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Enter an account name.')
      return
    }

    setError('')
    try {
      await onRename(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We could not rename this account.')
    }
  }

  return (
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={loading ? undefined : onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-account-title"
        className="relative mx-4 w-full max-w-sm rounded-xl border border-[var(--v2-border)] bg-white shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-5 py-4">
          <div>
            <h2 id="rename-account-title" className="text-base font-semibold text-[var(--v2-ink)]">Rename account</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Give this Haven account a name only you see.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            aria-label="Close"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon icon={X} className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <div>
            <label htmlFor="rename-account-name" className="mb-1.5 block text-xs text-[var(--v2-ink-2)]">Account name</label>
            <input
              id="rename-account-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
              autoFocus
              className="w-full rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface-2)] px-3 py-2.5 text-sm text-[var(--v2-ink)] transition-colors focus-visible:border-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
            />
          </div>
          {error && (
            <div className="rounded-lg border border-danger/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-sm text-[var(--v2-danger)]">
              {error}
            </div>
          )}
          <div className="flex gap-3 pt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={loading}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading} className="flex-1">
              {loading ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
