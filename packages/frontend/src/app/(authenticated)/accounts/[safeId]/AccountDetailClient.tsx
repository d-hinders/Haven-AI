'use client'

import { useEffect, useState } from 'react'
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
import { useAgents } from '@/hooks/useAgents'
import { useUserSafes } from '@/hooks/useUserSafes'
import TransactionsTable from '@/components/transactions/TransactionsTable'
import SendModal from '@/components/SendModal'
import ReceiveFundsModal from '@/components/ReceiveFundsModal'
import ConfirmDialog from '@/components/ConfirmDialog'
import { Button } from '@/components/ui/Button'
import { getExplorerUrl, getChainConfig } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      onClick={copy}
      className="text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] transition-colors"
      title="Copy"
    >
      {copied ? (
        <svg className="w-3.5 h-3.5 text-emerald-400 animate-check-pop" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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

export default function AccountDetailClient() {
  const params = useParams()
  const router = useRouter()
  const safeId = params.safeId as string

  const { user, activeSafe, setActiveSafe, loading: authLoading } = useAuth()
  const { getOwnerAlias } = useOwnerDirectory()
  const { renameSafe, removeSafe, loading: safesLoading } = useUserSafes()
  const { currency } = usePreferences()
  const { contacts, resolveAddress } = useContacts()
  const { agents } = useAgents()

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

  // Build linked-agent list
  const safeAgents = agents.filter((a) => a.safe_id === safeId && a.status === 'active')

  const { details, loading: detailsLoading } = useSafeDetails(safeAddress)

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
        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
        <span className="text-xs text-[var(--v2-ink-3)]">Loading account...</span>
      </div>
    )
  }

  if (!safe) {
    return (
      <div className="max-w-5xl py-16 text-center">
        <p className="text-sm text-[var(--v2-ink-3)]">Account not found</p>
        <Link href="/accounts" className="text-sm text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] mt-2 inline-block">
          Back to accounts
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-5xl">
      <Link
        href="/accounts"
        className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
      >
        ← Back to Accounts
      </Link>

      {/* Header */}
      <div className="mb-8 mt-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h1 className="text-2xl font-bold tracking-tight">{safe.name}</h1>
              {safe.is_default && (user?.safes?.length ?? 0) > 1 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-[var(--v2-brand)] font-medium">
                  default
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
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
          <Button variant="ghost" size="sm" onClick={() => setRenameOpen(true)}>
            Edit
          </Button>
        </div>
      </div>

      {/* Balances with fiat values */}
      <div className="mb-6 overflow-hidden rounded-[16px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)]">
        <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-6 py-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest text-[var(--v2-ink-3)]">Total balance</p>
              {portfolioLoading ? (
                <div className="mt-3 h-9 w-44 rounded bg-[var(--v2-surface-2)] animate-pulse" />
              ) : (
                <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] tabular-nums">
                  {new Intl.NumberFormat(currency === 'EUR' ? 'de-DE' : 'en-US', {
                    style: 'currency',
                    currency,
                    minimumFractionDigits: 2,
                  }).format(totalFiat)}
                </p>
              )}
            </div>
            <p className="max-w-sm text-sm leading-relaxed text-[var(--v2-ink-3)]">
              Sum of all tokens held by this account, converted to {currency}.
            </p>
          </div>
        </div>

        <div className="p-4">
          <div className="mb-3 flex items-center justify-between gap-3 px-2">
            <h2 className="text-sm font-semibold text-[var(--v2-ink)]">Token balances</h2>
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
            <div className="flex min-h-28 flex-col items-center justify-center rounded-md border border-dashed border-[var(--v2-danger)]/25 bg-[var(--v2-danger-soft)] text-center">
              <p className="mb-2 text-sm text-[var(--v2-danger)]">{portfolioError ?? balancesError}</p>
              <button
                onClick={handleBalancesRefresh}
                className="text-xs font-medium text-[var(--v2-danger)] underline underline-offset-2 hover:opacity-80"
              >
                Retry
              </button>
            </div>
          ) : breakdown.length === 0 ? (
            <div className="flex min-h-28 flex-col items-center justify-center rounded-md border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] text-center">
              <p className="text-sm font-medium text-[var(--v2-ink)]">No token balances yet</p>
              <p className="text-xs text-[var(--v2-ink-3)] mt-1">Receive funds to see tokens in this account.</p>
            </div>
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
                    <span className="text-sm text-[var(--v2-ink-2)] text-right font-mono">
                      {item.formatted}
                    </span>
                    <span className="text-sm text-[var(--v2-ink)] text-right">
                      {new Intl.NumberFormat(
                        currency === 'EUR' ? 'de-DE' : 'en-US',
                        {
                          style: 'currency',
                          currency,
                          minimumFractionDigits: 2,
                        },
                      ).format(fiatValue)}
                    </span>
                  </div>
                )
              })}
            </>
          )}
        </div>
      </div>

      {/* Account info */}
      <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-6 mb-6 shadow-[var(--v2-shadow-card)]">
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="text-xs text-[var(--v2-ink-3)] uppercase tracking-widest">
            Account details
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {/* Address */}
          <div>
            <p className="text-xs text-[var(--v2-ink-3)] mb-1">Account address</p>
            <div className="flex items-center gap-2">
              <span className="text-sm font-mono text-[var(--v2-ink)]">
                {safeAddress ? truncate(safeAddress) : '—'}
              </span>
              {safeAddress && <CopyButton text={safeAddress} />}
              {safeAddress && (
                <a
                  href={getExplorerUrl(chainId, 'address', safeAddress!)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                  </svg>
                </a>
              )}
            </div>
          </div>

          {/* Threshold */}
          <div>
            <p className="text-xs text-[var(--v2-ink-3)] mb-1">Threshold</p>
            {detailsLoading ? (
              <div className="h-5 w-24 bg-[var(--v2-surface-2)] rounded animate-pulse" />
            ) : details ? (
              <span className="text-sm text-[var(--v2-ink)]">
                {details.threshold} of {details.owners.length} owner
                {details.owners.length !== 1 ? 's' : ''}
              </span>
            ) : (
              <span className="text-sm text-[var(--v2-ink-3)]">—</span>
            )}
          </div>

          {/* Network */}
          <div>
            <p className="text-xs text-[var(--v2-ink-3)] mb-1">Network</p>
            <span className="text-sm text-[var(--v2-ink)]">{getChainConfig(chainId).name}</span>
          </div>
        </div>

        {/* Owners */}
        {details && details.owners.length > 0 && (
          <div className="mt-6 pt-5 border-t border-[var(--v2-border)]">
            <p className="text-xs text-[var(--v2-ink-3)] mb-3">Owners</p>
            <div className="space-y-2">
              {details.owners.map((owner) => {
                const isYou =
                  user?.wallet_address?.toLowerCase() === owner.toLowerCase()
                const ownerAlias = getOwnerAlias(owner)
                return (
                  <div
                    key={owner}
                    className="flex flex-wrap items-center gap-2 py-1.5"
                  >
                    <span className={ownerAlias ? 'text-sm font-medium text-[var(--v2-ink)]' : 'text-sm font-mono text-[var(--v2-ink)]'}>
                      {ownerAlias ?? truncate(owner)}
                    </span>
                    {ownerAlias && (
                      <span className="text-xs font-mono text-[var(--v2-ink-3)]">
                        {truncate(owner)}
                      </span>
                    )}
                    <CopyButton text={owner} />
                    <a
                      href={getExplorerUrl(chainId, 'address', owner)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--v2-ink-3)] hover:text-[var(--v2-ink-2)] transition-colors"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                      </svg>
                    </a>
                    {isYou && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-indigo-500/10 text-[var(--v2-brand)] font-medium">
                        You
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Linked agents */}
        {safeAgents.length > 0 && (
          <div className="mt-6 pt-5 border-t border-[var(--v2-border)]">
            <p className="text-xs text-[var(--v2-ink-3)] mb-3">
              Connected agents ({safeAgents.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {safeAgents.map((agent) => (
                <Link
                  key={agent.id}
                  href={`/agents/${agent.id}`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[var(--v2-surface)] border border-[var(--v2-border)] text-xs text-[var(--v2-ink-2)] transition-colors hover:border-[var(--v2-brand)]/30 hover:bg-[var(--v2-brand-soft)] hover:text-[var(--v2-brand)]"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                  </svg>
                  {agent.name}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Full transaction history */}
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-[var(--v2-ink)]">
          Transactions
        </h2>
      </div>
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="text-sm text-[var(--v2-ink-3)]">
          {txLoading
            ? 'Loading transactions...'
            : `${total} transaction${total !== 1 ? 's' : ''}`}
        </p>
        {!txLoading && transactions.length > 0 && (
          <p className="text-xs text-[var(--v2-ink-3)]">
            Showing {transactions.length} of {total}
          </p>
        )}
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
      {transactions.length > 0 && hasMore && (
        <div className="mt-5 flex justify-center">
          <Link
            href={`/transactions?safeId=${encodeURIComponent(safeId)}`}
            className="inline-flex h-10 items-center justify-center rounded-md border border-[var(--v2-border-strong)] bg-white px-4 text-sm font-medium text-[var(--v2-ink)] transition-colors hover:bg-[var(--v2-surface)]"
          >
            View all
          </Link>
        </div>
      )}

      <SendModal
        open={sendOpen && Boolean(safeAddress)}
        onClose={() => setSendOpen(false)}
        safeAddress={safeAddress ?? ''}
        safeDetails={details}
        balances={balances}
        onSuccess={handleSendSuccess}
        contacts={contacts}
        resolveAddress={resolveAddress}
        chainId={chainId}
        contextLoading={detailsLoading}
        contextError={null}
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Account name is required')
      return
    }

    setError('')
    try {
      await onRename(trimmed)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename account')
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={onClose} />
      <div className="relative mx-4 w-full max-w-sm rounded-xl border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-modal)]">
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--v2-ink)]">Edit account</h2>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Rename this account in Haven.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)]"
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
            <div className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-500">
              {error}
            </div>
          )}
          <div className="rounded-lg border border-red-500/15 bg-red-500/[0.04] px-3 py-3">
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
                className="rounded-md px-2.5 py-1.5 text-xs font-medium text-[var(--v2-danger)] transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
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
