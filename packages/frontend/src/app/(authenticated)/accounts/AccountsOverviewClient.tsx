'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAuth, type UserSafe } from '@/context/AuthContext'
import { useUserSafes } from '@/hooks/useUserSafes'
import { useAgents } from '@/hooks/useAgents'
import { usePortfolio } from '@/hooks/usePortfolio'
import { usePreferences } from '@/hooks/usePreferences'
import { api } from '@/lib/api'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { DEFAULT_CHAIN_ID, getExplorerUrl, getChainConfig, SUPPORTED_CHAINS } from '@/lib/chains'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import NetworkPill from '@/components/NetworkPill'
import { timeAgo } from '@/lib/format'
import { entityCardClassName } from '@/components/ui/entityCardStyles'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'

// ── Add Safe Modal ──────────────────────────────────────────────────

type AddMode = 'choose' | 'deploy' | 'import'
type DeployStep = 'name' | 'wallet' | 'deploying' | 'done'

function AddSafeModal({
  open,
  onClose,
  onAdd,
  loading,
}: {
  open: boolean
  onClose: () => void
  onAdd: (address: string, name: string, chainId: number) => Promise<void>
  loading: boolean
}) {
  const [mode, setMode] = useState<AddMode>('choose')
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  // Import state
  const [importAddress, setImportAddress] = useState('')
  const [importChainId, setImportChainId] = useState(DEFAULT_CHAIN_ID)

  // Deploy state
  const [deployStep, setDeployStep] = useState<DeployStep>('name')
  const [deploying, setDeploying] = useState(false)
  const [deployedAddress, setDeployedAddress] = useState('')
  const [deployTxHash, setDeployTxHash] = useState('')
  const [deployChainId, setDeployChainId] = useState(DEFAULT_CHAIN_ID)

  const { address: walletAddress, isConnected } = useAccount()

  const resetState = () => {
    setMode('choose')
    setName('')
    setError('')
    setImportAddress('')
    setImportChainId(DEFAULT_CHAIN_ID)
    setDeployStep('name')
    setDeploying(false)
    setDeployedAddress('')
    setDeployTxHash('')
    setDeployChainId(DEFAULT_CHAIN_ID)
  }

  const handleClose = () => {
    resetState()
    onClose()
  }

  // Escape-to-close — but don't let the user bail on live account creation.
  useEscapeToClose(open, handleClose, { enabled: !deploying })

  if (!open) return null

  // ── Import flow ──
  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!/^0x[0-9a-fA-F]{40}$/.test(importAddress)) {
      setError('Invalid Ethereum address')
      return
    }

    try {
      await onAdd(importAddress, name || 'My account', importChainId)
      resetState()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add account')
    }
  }

  // ── Deploy flow ──
  const handleDeploy = async () => {
    if (!walletAddress) return

    setDeploying(true)
    setDeployStep('deploying')
    setError('')

    try {
      // Relay pays gas — no wallet signature needed
      const deployed = await api.post<{ safe_address: string; tx_hash: string }>(
        '/user/safes/deploy',
        { chain_id: deployChainId, owner_address: walletAddress },
      )
      setDeployedAddress(deployed.safe_address)
      setDeployTxHash(deployed.tx_hash)

      // Register in Haven (same as import flow)
      await onAdd(deployed.safe_address, name || 'My account', deployChainId)
      setDeployStep('done')
    } catch (err: unknown) {
      setDeployStep('wallet')
      setError(err instanceof Error ? err.message : 'Deployment failed. Please try again.')
    } finally {
      setDeploying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 v2-modal-backdrop" onClick={handleClose} />
      <div className="relative bg-white border border-[var(--v2-border)] rounded-xl w-full max-w-md shadow-[var(--v2-shadow-modal)] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-0">
          <div className="flex items-center gap-2">
            {mode !== 'choose' && deployStep !== 'done' && (
              <button
                onClick={() => { setMode('choose'); setError(''); setDeployStep('name') }}
                className="p-1 -ml-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
              </button>
            )}
            <h2 className="text-lg font-semibold text-[var(--v2-ink)]">
              {mode === 'choose' && 'Add account'}
              {mode === 'deploy' && deployStep === 'done' && 'Account created'}
              {mode === 'deploy' && deployStep !== 'done' && 'Create Haven account'}
              {mode === 'import' && 'Import existing account'}
            </h2>
          </div>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="p-1 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {/* ── Choose mode ── */}
          {mode === 'choose' && (
            <div className="space-y-3">
              <p className="text-sm text-[var(--v2-ink-3)] mb-4">
                Create a new Haven account or import one you already use.
              </p>
              <button
                onClick={() => setMode('deploy')}
                className="w-full flex items-center gap-4 p-4 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] hover:border-[var(--v2-brand)]/30 hover:bg-[var(--v2-brand-soft)] transition-all group text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--v2-brand-soft)] border border-[var(--v2-brand)]/20 flex items-center justify-center flex-shrink-0 group-hover:bg-[var(--v2-brand-soft)] transition-colors">
                  <svg className="w-5 h-5 text-[var(--v2-brand)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-[var(--v2-ink)] transition-colors">Create Haven account</span>
                  <span className="block text-xs text-[var(--v2-ink-3)] mt-0.5">Create a new account on Base</span>
                </div>
                <svg className="w-4 h-4 text-[var(--v2-ink-3)] group-hover:text-[var(--v2-ink-2)] transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
              <button
                onClick={() => setMode('import')}
                className="w-full flex items-center gap-4 p-4 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] hover:border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)] transition-all group text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-[var(--v2-surface-2)] border border-[var(--v2-border)] flex items-center justify-center flex-shrink-0 group-hover:bg-[var(--v2-surface-2)] transition-colors">
                  <svg className="w-5 h-5 text-[var(--v2-ink-2)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.07-9.07l-1.757 1.757a4.5 4.5 0 010 6.364l-4.5 4.5" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-[var(--v2-ink)] transition-colors">Import existing account</span>
                  <span className="block text-xs text-[var(--v2-ink-3)] mt-0.5">Link an account you already use by its address</span>
                </div>
                <svg className="w-4 h-4 text-[var(--v2-ink-3)] group-hover:text-[var(--v2-ink-2)] transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            </div>
          )}

          {/* ── Deploy flow ── */}
          {mode === 'deploy' && deployStep === 'name' && (
            <div className="space-y-4">
              <p className="text-sm text-[var(--v2-ink-3)]">
                Give your new account a name and choose a network.
              </p>
              <div>
                <label className="block text-xs text-[var(--v2-ink-3)] mb-1">Account Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Business, Personal, Treasury"
                  autoFocus
                  className="w-full px-3 py-2.5 rounded-lg bg-[var(--v2-surface-2)] border border-[var(--v2-border)] text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)] transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--v2-ink-3)] mb-1">Network</label>
                <select
                  value={deployChainId}
                  onChange={(e) => setDeployChainId(Number(e.target.value))}
                  className="w-full px-3 py-2.5 rounded-lg bg-[var(--v2-surface-2)] border border-[var(--v2-border)] text-sm text-[var(--v2-ink)] focus:outline-none focus:border-[var(--v2-brand)] transition-colors"
                >
                  {SUPPORTED_CHAINS.map((c) => (
                    <option key={c.chainId} value={c.chainId}>{c.name}</option>
                  ))}
                </select>
              </div>
              <Button onClick={() => setDeployStep('wallet')} className="w-full">
                Continue
              </Button>
            </div>
          )}

          {mode === 'deploy' && deployStep === 'wallet' && (
            <div className="space-y-4">
              <p className="text-sm text-[var(--v2-ink-3)]">
                Your connected wallet will be the owner of this account. Network fees are paid by Haven &mdash; no wallet signature needed.
              </p>

              {/* Wallet connection */}
              {!isConnected ? (
                <div className="flex flex-col items-center gap-3 p-4 rounded-lg border border-dashed border-[var(--v2-border)]">
                  <p className="text-xs text-[var(--v2-ink-3)]">Connect a wallet to deploy</p>
                  <ConnectButton />
                </div>
              ) : (
                <div className="p-4 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="block text-xs text-[var(--v2-ink-3)] mb-1">Connected wallet</span>
                      <span className="text-sm font-mono text-[var(--v2-ink)]">
                        {walletAddress?.slice(0, 6)}...{walletAddress?.slice(-4)}
                      </span>
                    </div>
                    <ConnectButton.Custom>
                      {({ openAccountModal }) => (
                        <button
                          onClick={openAccountModal}
                          className="text-xs text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
                        >
                          Change
                        </button>
                      )}
                    </ConnectButton.Custom>
                  </div>
                </div>
              )}

              {/* Account name preview */}
              {name && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--v2-surface)] border border-[var(--v2-border)]">
                  <span className="text-xs text-[var(--v2-ink-3)]">Name:</span>
                  <span className="text-xs text-[var(--v2-ink)] font-medium">{name}</span>
                </div>
              )}

              {error && (
                <div className="rounded-lg border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
                  {error}
                </div>
              )}

              <Button
                onClick={handleDeploy}
                disabled={!isConnected || deploying}
                className="w-full"
              >
                Create account
              </Button>
              <p className="text-center text-xs text-[var(--v2-ink-3)]">
                Network fees are paid by Haven &mdash; no wallet signature needed.
              </p>
            </div>
          )}

          {mode === 'deploy' && deployStep === 'deploying' && (
            <div className="flex flex-col items-center py-8">
              <div className="w-12 h-12 rounded-full border-2 border-[var(--v2-brand)]/30 border-t-[var(--v2-brand)] animate-spin mb-6" />
              <h3 className="text-sm font-medium text-[var(--v2-ink)] mb-2">Deploying your account</h3>
              <p className="text-xs text-[var(--v2-ink-3)] text-center max-w-xs">
                Haven is deploying your account on {getChainConfig(deployChainId).name}. No wallet action needed.
              </p>
            </div>
          )}

          {mode === 'deploy' && deployStep === 'done' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border border-[var(--v2-success)]/30 bg-[var(--v2-success-soft)]">
                  <svg className="h-5 w-5 text-[var(--v2-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-[var(--v2-ink)]">{name || 'My account'}</p>
                  <p className="text-xs text-[var(--v2-ink-3)]">Successfully deployed on {getChainConfig(deployChainId).name}</p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="p-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                  <span className="block text-xs text-[var(--v2-ink-3)] uppercase tracking-wider mb-1">Account address</span>
                  <a
                    href={getExplorerUrl(deployChainId, 'address', deployedAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-mono text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors break-all"
                  >
                    {deployedAddress}
                  </a>
                </div>
                <div className="p-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                  <span className="block text-xs text-[var(--v2-ink-3)] uppercase tracking-wider mb-1">Transaction</span>
                  <a
                    href={getExplorerUrl(deployChainId, 'tx', deployTxHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-mono text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors break-all"
                  >
                    {deployTxHash.slice(0, 22)}...{deployTxHash.slice(-8)}
                  </a>
                </div>
              </div>

              <Button onClick={handleClose} className="w-full">
                Done
              </Button>
            </div>
          )}

          {/* ── Import flow ── */}
          {mode === 'import' && (
            <form onSubmit={handleImport} className="space-y-4">
              <p className="text-sm text-[var(--v2-ink-3)]">
                Link an existing account by its address and network.
              </p>
              <div>
                <label className="block text-xs text-[var(--v2-ink-3)] mb-1">Account Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Business, Personal"
                  className="w-full px-3 py-2.5 rounded-lg bg-[var(--v2-surface-2)] border border-[var(--v2-border)] text-sm text-[var(--v2-ink)] placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)] transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--v2-ink-3)] mb-1">Network</label>
                <select
                  value={importChainId}
                  onChange={(e) => setImportChainId(Number(e.target.value))}
                  className="w-full px-3 py-2.5 rounded-lg bg-[var(--v2-surface-2)] border border-[var(--v2-border)] text-sm text-[var(--v2-ink)] focus:outline-none focus:border-[var(--v2-brand)] transition-colors"
                >
                  {SUPPORTED_CHAINS.map((c) => (
                    <option key={c.chainId} value={c.chainId}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[var(--v2-ink-3)] mb-1">Account address</label>
                <input
                  type="text"
                  value={importAddress}
                  onChange={(e) => setImportAddress(e.target.value)}
                  placeholder="0x..."
                  autoFocus
                  className="w-full px-3 py-2.5 rounded-lg bg-[var(--v2-surface-2)] border border-[var(--v2-border)] text-sm text-[var(--v2-ink)] font-mono placeholder:text-[var(--v2-ink-3)] focus:outline-none focus:border-[var(--v2-brand)] transition-colors"
                />
              </div>

              {error && (
                <p className="text-xs text-[var(--v2-danger)]">{error}</p>
              )}

              <Button type="submit" disabled={loading} className="w-full">
                {loading ? 'Adding…' : 'Import account'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Per-Safe card (handles its own portfolio fetch) ────────────────

function formatFiat(value: number, currency: 'USD' | 'EUR'): string {
  const symbol = currency === 'USD' ? '$' : '€'
  if (value === 0) return `${symbol}0.00`
  if (value < 0.01) return `< ${symbol}0.01`
  return `${symbol}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

interface SafeCardProps {
  safe: UserSafe
  isActive: boolean
  showActiveBadge: boolean
  agentCount: number
  showDefaultBadge: boolean
  currency: 'USD' | 'EUR'
  staggerIndex: number
  onClick: () => void
  onSetActive: () => void
  onSetDefault: () => void
}

// Number of top-token rows we surface on the card before collapsing the rest
// into a "+N more" footnote. Three keeps the card height predictable across a
// row of cards regardless of how many tokens any single Safe holds.
const TOP_TOKENS_PREVIEW = 3

function SafeCard({
  safe,
  isActive,
  showActiveBadge,
  agentCount,
  showDefaultBadge,
  currency,
  staggerIndex,
  onClick,
  onSetActive,
  onSetDefault,
}: SafeCardProps) {
  const {
    totalUsd,
    totalEur,
    breakdown,
    loading: portfolioLoading,
  } = usePortfolio(safe.safe_address, { chainId: safe.chain_id })
  const fiatTotal = currency === 'USD' ? totalUsd : totalEur

  // The breakdown comes back sorted by value, but make it explicit so we never
  // accidentally show dust above a meaningful holding.
  const sortedBreakdown = [...breakdown].sort((a, b) => {
    const aValue = currency === 'USD' ? a.usdValue : a.eurValue
    const bValue = currency === 'USD' ? b.usdValue : b.eurValue
    return bValue - aValue
  })
  const visibleTokens = sortedBreakdown.slice(0, TOP_TOKENS_PREVIEW)
  const hiddenTokenCount = Math.max(0, sortedBreakdown.length - TOP_TOKENS_PREVIEW)

  return (
    <Link
      href={`/accounts/${safe.id}`}
      onClick={onClick}
      aria-label={safe.name}
      className={`v2-animate-stagger block ${entityCardClassName({ selected: isActive })} p-5 sm:p-6`}
      style={{
        ['--v2-stagger-delay' as string]: `${staggerIndex * 60}ms`,
      }}
    >
      {/* Active + default actions — stop link navigation for nested buttons. */}
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {!isActive && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSetActive() }}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-[var(--v2-brand)] hover:bg-[var(--v2-brand-soft)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
            aria-label={`Set ${safe.name} as active`}
          >
            Set active
          </button>
        )}
        {!safe.is_default && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSetDefault() }}
            className="p-1.5 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
            aria-label={`Set ${safe.name} as default`}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
            </svg>
          </button>
        )}
      </div>

      {/* Header — name + active / default chips */}
      <div className="mb-2 flex items-center gap-2 pr-12">
        <h3 className="truncate text-base font-semibold text-[var(--v2-ink)]">{safe.name}</h3>
        {showActiveBadge && (
          <span className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-[var(--v2-success-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--v2-success)]">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--v2-success)]" />
            Active
          </span>
        )}
        {showDefaultBadge && (
          <span className="flex-shrink-0 rounded bg-[var(--v2-brand-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--v2-brand)]">
            default
          </span>
        )}
      </div>

      {/* Caption — network + age. Replaces the raw 0x address that was too
          technical for an at-a-glance overview. */}
      <div className="mb-5 flex items-center gap-2 text-xs text-[var(--v2-ink-3)]">
        <NetworkPill chainId={safe.chain_id ?? DEFAULT_CHAIN_ID} />
        <span aria-hidden="true">{'·'}</span>
        <span>Added {timeAgo(safe.created_at)}</span>
      </div>

      {/* Fiat total */}
      <div className="mb-4" role="status" aria-busy={portfolioLoading} aria-live="polite">
        {portfolioLoading ? (
          <Skeleton className="h-7 w-28" />
        ) : (
          <p className="v2-tabular text-2xl font-semibold tracking-tight text-[var(--v2-ink)]">
            {formatFiat(fiatTotal, currency)}
          </p>
        )}
      </div>

      {/* Token breakdown preview — up to 3 top holdings plus a "+N more"
          overflow. Reserves a small minimum height so cards in the same row
          stay aligned even when one Safe is empty. */}
      <div className="mb-4 min-h-[68px] space-y-1.5">
        {portfolioLoading ? (
          <>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/4" />
          </>
        ) : visibleTokens.length === 0 ? (
          <p className="text-xs text-[var(--v2-ink-3)]">
            No funds yet &mdash; receive to get started.
          </p>
        ) : (
          <>
            {visibleTokens.map((item) => {
              const fiatValue = currency === 'USD' ? item.usdValue : item.eurValue
              return (
                <div
                  key={item.symbol}
                  className="flex items-center justify-between gap-3 text-xs text-[var(--v2-ink-2)]"
                >
                  <span className="truncate">
                    <span className="font-medium text-[var(--v2-ink)]">{item.symbol}</span>{' '}
                    <span className="v2-tabular text-[var(--v2-ink-3)]">{item.formatted}</span>
                  </span>
                  <span className="v2-tabular flex-shrink-0 text-[var(--v2-ink-3)]">
                    {formatFiat(fiatValue, currency)}
                  </span>
                </div>
              )
            })}
            {hiddenTokenCount > 0 && (
              <p className="text-xs text-[var(--v2-ink-3)]">+ {hiddenTokenCount} more</p>
            )}
          </>
        )}
      </div>

      {/* Footer chip row — agent count + Open affordance */}
      <div className="flex items-center justify-between gap-3 border-t border-[var(--v2-border)] pt-3 text-xs text-[var(--v2-ink-3)]">
        <span className="flex items-center gap-1.5">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
          </svg>
          {agentCount} agent{agentCount !== 1 ? 's' : ''}
        </span>
        <span className="font-medium text-[var(--v2-brand)] opacity-70 transition-opacity group-hover:opacity-100">
          Open &rarr;
        </span>
      </div>
    </Link>
  )
}

// ── Main Component ──────────────────────────────────────────────────

export default function AccountsOverviewClient() {
  const { activeSafe, setActiveSafe } = useAuth()
  const { safes, loading, addSafe, setDefault } = useUserSafes()
  const { agents } = useAgents()
  const { currency } = usePreferences()

  const [addModalOpen, setAddModalOpen] = useState(false)

  // Count agents per Safe
  const agentCountBySafe = new Map<string, number>()
  for (const agent of agents) {
    if (agent.safe_id) {
      agentCountBySafe.set(agent.safe_id, (agentCountBySafe.get(agent.safe_id) ?? 0) + 1)
    }
  }

  // Count orphaned agents (no safe_id)
  const orphanedAgents = agents.filter((a) => !a.safe_id && a.status === 'active')

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Accounts"
        subtitle={
          safes.length > 0 ? (
            <>
              <span className="v2-tabular">{safes.length}</span> {safes.length === 1 ? 'account' : 'accounts'} linked
            </>
          ) : undefined
        }
        actions={safes.length > 0 ? (
          <Button onClick={() => setAddModalOpen(true)}>Add account</Button>
        ) : undefined}
      />

      {/* Orphaned agents warning */}
      {orphanedAgents.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 mb-6 rounded-lg bg-[var(--v2-warning-soft)] border border-[var(--v2-warning)]/20">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-[var(--v2-warning)] flex-shrink-0">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="text-sm text-[var(--v2-warning)]">
            {orphanedAgents.length} agent{orphanedAgents.length !== 1 ? 's have' : ' has'} no linked account. Reassign them in the Agents page.
          </span>
        </div>
      )}

      {/* Safe cards grid */}
      {safes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--v2-border)] py-16 text-center">
          <svg className="mx-auto mb-4 h-12 w-12 text-[var(--v2-ink-3)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
          </svg>
          <p className="mb-4 text-sm text-[var(--v2-ink-3)]">No Haven accounts yet</p>
          <Button onClick={() => setAddModalOpen(true)}>Add your first account</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {safes.map((safe, index) => (
            <SafeCard
              key={safe.id}
              safe={safe}
              isActive={activeSafe?.id === safe.id}
              showActiveBadge={activeSafe?.id === safe.id && safes.length > 1}
              agentCount={agentCountBySafe.get(safe.id) ?? 0}
              showDefaultBadge={!!safe.is_default && safes.length > 1}
              currency={currency}
              staggerIndex={index}
              onClick={() => setActiveSafe(safe)}
              onSetActive={() => setActiveSafe(safe)}
              onSetDefault={() => setDefault(safe.id)}
            />
          ))}
        </div>
      )}

      {/* Add Safe Modal */}
      <AddSafeModal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        onAdd={async (address, name, chainId) => {
          await addSafe(address, name, chainId)
        }}
        loading={loading}
      />
    </div>
  )
}
