'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth, type UserSafe } from '@/context/AuthContext'
import { useOwnerDirectory } from '@/context/OwnerDirectoryContext'
import { useBalances } from '@/hooks/useBalances'
import { useTransactionsFeed } from '@/hooks/useTransactionsFeed'
import { usePortfolio } from '@/hooks/usePortfolio'
import { useSafeDetails } from '@/hooks/useSafeDetails'
import { usePreferences } from '@/hooks/usePreferences'
import { useContacts } from '@/hooks/useContacts'
import { useAgents, type Agent } from '@/hooks/useAgents'
import { useUserSafes } from '@/hooks/useUserSafes'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import SendModal from '@/components/SendModal'
import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import ConfirmDialog from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Skeleton } from '@/components/ui/Skeleton'
import { ExternalDetailsLink } from '@/components/haven'
import { useToast } from '@/components/ui/Toast'
import { getExplorerUrl, getChainConfig } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { formatAllowanceForToken } from '@/lib/allowance-format'
import { agentStatusPresentation } from '@/lib/payment-status'
import { Tooltip } from '@/components/ui/Tooltip'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const { toast } = useToast()
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    toast.success('Address copied')
  }
  return (
    <button
      onClick={copy}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
      title="Copy"
      aria-label="Copy address"
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-[var(--v2-success)] animate-check-pop" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
        </svg>
      )}
    </button>
  )
}

function formatFiatValue(value: number, currency: 'USD' | 'EUR'): string {
  return new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value)
}

function approvalSummary(threshold?: number, ownerCount?: number): string {
  if (!threshold || !ownerCount) return 'Loading approval details'
  const approverLabel = ownerCount === 1 ? 'approver' : 'approvers'
  return `${threshold} of ${ownerCount} ${approverLabel} required`
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

export default function AccountDetailClient() {
  const params = useParams()
  const router = useRouter()
  const safeId = params.safeId as string

  const { user, activeSafe, setActiveSafe, loading: authLoading, passkeys = [] } = useAuth()
  const { getOwnerAlias } = useOwnerDirectory()
  const { renameSafe, removeSafe, loading: safesLoading } = useUserSafes()
  const { currency } = usePreferences()
  const { contacts, error: contactsError, resolveAddress } = useContacts()
  const { agents, loading: agentsLoading, error: agentsError, refetch: refetchAgents } = useAgents()

  // Find this Safe from user's list
  const safe = user?.safes?.find((s) => s.id === safeId)
  const safeAddress = safe?.safe_address ?? null
  const chainId = safe?.chain_id ?? 100

  // Keep the active Safe in sync with the route. Runs as an effect so we
  // never call setState during render.
  useEffect(() => {
    if (safe && activeSafe?.id !== safe.id) {
      setActiveSafe(safe)
    }
  }, [safe, activeSafe, setActiveSafe])

  const safeNamesByAddress = new Map<string, string>()
  for (const account of user?.safes ?? []) {
    safeNamesByAddress.set(account.safe_address.toLowerCase(), account.name)
  }
  const passkeyAddresses = new Set(
    passkeys
      .filter(
        (passkey) =>
          passkey.chain_id === chainId &&
          (!safeAddress || passkey.safe_address?.toLowerCase() === safeAddress.toLowerCase()),
      )
      .map((passkey) => passkey.signer_address.toLowerCase()),
  )

  // Build linked-agent list
  const safeAgents = agents.filter((a) => a.safe_id === safeId)

  const {
    details,
    loading: detailsLoading,
    error: detailsError,
    refetch: refetchDetails,
  } = useSafeDetails(safeAddress)

  const {
    totalUsd,
    totalEur,
    breakdown,
    loading: portfolioLoading,
    error: portfolioError,
    refetch: refetchPortfolio,
  } = usePortfolio(safeAddress)

  const {
    balances,
    error: balancesError,
    refetch: refetchBalances,
  } = useBalances(safeAddress)

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
  const approvalMethodCount = details?.owners.length ?? 0
  const approvalCopy = details
    ? approvalSummary(details.threshold, approvalMethodCount)
    : detailsError
      ? 'Approval details could not be verified'
      : 'Approval details unavailable'
  const [renameOpen, setRenameOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
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

  const handleRemoveConfirmed = async () => {
    if (!safe) return
    setRemoving(true)
    try {
      await removeSafe(safe.id)
      router.push('/accounts')
    } finally {
      setRemoving(false)
    }
  }

  const openDeleteFromEdit = () => {
    setRenameOpen(false)
    setRemoveOpen(true)
  }

  // While auth context is still hydrating `user.safes`, avoid flashing
  // "Account not found" — the safe lookup will resolve once safes load.
  if (authLoading || !user) {
    return (
      <div className="max-w-5xl py-16 flex items-center justify-center gap-2">
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
        subtitle="Control the funds, agent access, and recent activity for this Haven wallet."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {safe.is_default && (user?.safes?.length ?? 0) > 1 ? (
              <StatusBadge tone="brand">Default</StatusBadge>
            ) : null}
            <StatusBadge>{chain.name}</StatusBadge>
            {safeAddress && (
              <>
                <Button onClick={() => setSendOpen(true)}>
                  Send
                </Button>
                <Button variant="ghost" onClick={() => setReceiveOpen(true)}>
                  Receive
                </Button>
              </>
            )}
            <Button variant="ghost" onClick={() => setRenameOpen(true)}>
              Edit
            </Button>
          </div>
        }
      />

      <Card hover={false} elevation="raised" className="overflow-hidden">
        <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-5 sm:px-6">
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
        </div>

        <div className="p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-[var(--v2-ink)]">Token balances</h2>
            <button
              onClick={handleBalancesRefresh}
              className="text-xs font-medium text-[var(--v2-brand)] transition-colors hover:text-[var(--v2-brand-strong)]"
            >
              Refresh
            </button>
          </div>
          {portfolioLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((item) => (
                <div key={item} className="grid grid-cols-3 gap-4 px-2 py-2">
                  <div className="h-4 w-16 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                  <div className="h-4 w-20 justify-self-end rounded bg-[var(--v2-surface-2)] animate-pulse" />
                  <div className="h-4 w-24 justify-self-end rounded bg-[var(--v2-surface-2)] animate-pulse" />
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

      <Card hover={false} className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-[var(--v2-ink)]">Agent access</h2>
              <Link
                href="/agents"
                className="text-xs font-medium text-[var(--v2-brand)] transition-colors hover:text-[var(--v2-brand-strong)]"
              >
                View all agents &rarr;
              </Link>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--v2-ink-2)]">
              Connected agents can request payments from this Haven wallet when their status and agent budget allow it.
            </p>
          </div>
        </div>

        {agentsLoading ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {[0, 1].map((item) => (
              <div
                key={item}
                className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3"
              >
                <div className="h-4 w-32 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                <div className="mt-2 h-3 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse" />
              </div>
            ))}
          </div>
        ) : agentsError ? (
          <EmptyState
            title="Agent access could not load"
            body="Haven could not verify which agents can request payments from this wallet."
            className="mt-5 py-8"
            action={<Button variant="ghost" size="sm" onClick={refetchAgents}>Try again</Button>}
          />
        ) : safeAgents.length > 0 ? (
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {safeAgents.map((agent) => {
              const status = agentStatusPresentation(agent.status)
              return (
                <Link
                  key={agent.id}
                  href={`/agents/${agent.id}`}
                  className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 transition-colors hover:border-[var(--v2-brand)]/30 hover:bg-[var(--v2-brand-soft)]"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{agent.name}</p>
                      <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                        {agentBudgetSummary(agent, chainId)}
                      </p>
                    </div>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  </div>
                  <p className="mt-3 text-xs text-[var(--v2-ink-3)]">
                    Review or stop this agent from its detail page.
                  </p>
                </Link>
              )
            })}
          </div>
        ) : (
          <EmptyState
            title="No agents connected"
            body="Connect an agent when you want it to request payments from this Haven wallet."
            className="mt-5 py-8"
            action={<Button href="/agents" size="sm">Connect agent</Button>}
          />
        )}
      </Card>

      {/* Account info */}
      <Card hover={false} className="p-5 sm:p-6">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-[var(--v2-ink)]">
            Advanced account details
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          {/* Address */}
          <div>
            <p className="text-xs text-[var(--v2-ink-3)] mb-1">Haven wallet address</p>
            <div className="flex items-center gap-2">
              {safeAddress ? (
                <Tooltip label={safeAddress} mono>
                  <span className="text-sm font-mono text-[var(--v2-ink)]">
                    {truncate(safeAddress)}
                  </span>
                </Tooltip>
              ) : (
                <span className="text-sm font-mono text-[var(--v2-ink)]">—</span>
              )}
              {safeAddress && <CopyButton text={safeAddress} />}
              {safeAddress && <ExternalDetailsLink href={getExplorerUrl(chainId, 'address', safeAddress)} label="Open wallet address externally" />}
            </div>
          </div>

          {/* Threshold */}
          <div>
            <p className="text-xs text-[var(--v2-ink-3)] mb-1">Required approvals</p>
            {detailsLoading ? (
              <div className="h-5 w-24 bg-[var(--v2-surface-2)] rounded animate-pulse" />
            ) : details ? (
              <span className="text-sm text-[var(--v2-ink)]">
                {approvalCopy}
              </span>
            ) : detailsError ? (
              <span className="inline-flex flex-col items-start gap-2 text-sm text-[var(--v2-ink-2)]">
                {approvalCopy}
                <button
                  type="button"
                  onClick={refetchDetails}
                  className="text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
                >
                  Try again
                </button>
              </span>
            ) : (
              <span className="text-sm text-[var(--v2-ink-3)]">—</span>
            )}
          </div>
        </div>

        {/* Approvers */}
        {details && details.owners.length > 0 && (
          <div className="mt-6 pt-5 border-t border-[var(--v2-border)]">
            <p className="text-xs text-[var(--v2-ink-3)] mb-3">Approvers</p>
            <div className="space-y-2">
              {details.owners.map((owner) => {
                const normalizedOwner = owner.toLowerCase()
                const isYou =
                  user?.wallet_address?.toLowerCase() === normalizedOwner || passkeyAddresses.has(normalizedOwner)
                const approverType = passkeyAddresses.has(normalizedOwner) ? 'Passkey' : 'Wallet'
                const ownerAlias = getOwnerAlias(owner)
                return (
                  <div
                    key={owner}
                    className="flex flex-wrap items-center gap-2 py-1.5"
                  >
                    {ownerAlias ? (
                      <span className="text-sm font-medium text-[var(--v2-ink)]">
                        {ownerAlias}
                      </span>
                    ) : (
                      <Tooltip label={owner} mono>
                        <span className="text-sm font-mono text-[var(--v2-ink)]">
                          {truncate(owner)}
                        </span>
                      </Tooltip>
                    )}
                    {ownerAlias && (
                      <Tooltip label={owner} mono>
                        <span className="text-xs font-mono text-[var(--v2-ink-3)]">
                          {truncate(owner)}
                        </span>
                      </Tooltip>
                    )}
                    <CopyButton text={owner} />
                    <ExternalDetailsLink href={getExplorerUrl(chainId, 'address', owner)} label="Open approver externally" />
                    <StatusBadge>{approverType}</StatusBadge>
                    {isYou && (
                      <StatusBadge tone="brand">You</StatusBadge>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

      </Card>

      {/* Full transaction history */}
      <div>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-[var(--v2-ink)]">Transaction history</h2>
              {!txLoading && total > 0 ? (
                <Link
                  href={`/transactions?safeId=${encodeURIComponent(safeId)}`}
                  className="text-xs font-medium text-[var(--v2-brand)] transition-colors hover:text-[var(--v2-brand-strong)]"
                >
                  View all &rarr;
                </Link>
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
        <TransactionsTable
          transactions={transactions}
          loading={txLoading}
          error={txError}
          onRefresh={() => void refetchTx()}
          resolveAddress={resolveAddress}
          safeNamesByAddress={safeNamesByAddress}
          hasActiveFilters={false}
        />
        {transactions.length > 0 && hasMore ? (
          <div className="mt-5 flex justify-center">
            <Button href={`/transactions?safeId=${encodeURIComponent(safeId)}`} variant="ghost">
              View all
            </Button>
          </div>
        ) : null}
      </div>

      <SendModal
        open={sendOpen && Boolean(safeAddress)}
        onClose={() => setSendOpen(false)}
        safeAddress={safeAddress ?? ''}
        safeName={safe.name}
        safeDetails={details}
        balances={balances}
        onSuccess={handleSendSuccess}
        contacts={contacts}
        contactsError={contactsError}
        resolveAddress={resolveAddress}
        chainId={chainId}
        contextLoading={detailsLoading}
        contextError={detailsError}
      />
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
          onDelete={openDeleteFromEdit}
          loading={safesLoading}
        />
      )}
      <ConfirmDialog
        open={removeOpen}
        onCancel={() => setRemoveOpen(false)}
        onConfirm={handleRemoveConfirmed}
        title={`Delete ${safe.name}?`}
        body="This only removes the account from Haven. Funds on-chain are unaffected and you can re-import it later."
        confirmLabel="Delete account"
        loading={removing}
      />
    </div>
  )
}

function RenameModal({
  safe,
  onClose,
  onRename,
  onDelete,
  loading,
}: {
  safe: UserSafe
  onClose: () => void
  onRename: (name: string) => Promise<void>
  onDelete: () => void
  loading: boolean
}) {
  const [name, setName] = useState(safe.name)
  const [error, setError] = useState('')
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
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={loading ? undefined : onClose} />
      <div className="relative mx-4 w-full max-w-sm rounded-xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]">
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--v2-ink)]">Edit account</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Rename this account in Haven.</p>
          </div>
          <button
            onClick={onClose}
            disabled={loading}
            aria-label="Close"
            className="rounded-md p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4 p-5">
          <div>
            <label className="mb-1.5 block text-xs text-[var(--v2-ink-2)]">Account name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
              autoFocus
              className="w-full rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface-2)] px-3 py-2.5 text-sm text-[var(--v2-ink)] transition-colors focus:border-[var(--v2-brand)] focus:outline-none focus:ring-1 focus:ring-[var(--v2-brand)]/20"
            />
          </div>
          {error && (
            <div className="rounded-lg border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-sm text-[var(--v2-danger)]">
              {error}
            </div>
          )}
          <div className="rounded-lg border border-[var(--v2-danger)]/15 bg-[var(--v2-danger-soft)] px-3 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-[var(--v2-ink)]">Delete account</p>
                <p className="mt-0.5 text-[11px] text-[var(--v2-ink-3)]">
                  Removes this account from Haven. On-chain funds are unaffected.
                </p>
              </div>
              <button
                type="button"
                onClick={onDelete}
                disabled={loading}
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--v2-danger)] transition-colors hover:bg-[var(--v2-danger)]/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Delete
              </button>
            </div>
          </div>
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
