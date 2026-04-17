'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth, type UserSafe } from '@/context/AuthContext'
import { useUserSafes } from '@/hooks/useUserSafes'
import { useAgents } from '@/hooks/useAgents'
import { deploySafe } from '@/lib/safe'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import { getExplorerUrl, getChainConfig, SUPPORTED_CHAINS } from '@/lib/chains'

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

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
  const [importChainId, setImportChainId] = useState(100)

  // Deploy state
  const [deployStep, setDeployStep] = useState<DeployStep>('name')
  const [deploying, setDeploying] = useState(false)
  const [deployedAddress, setDeployedAddress] = useState('')
  const [deployTxHash, setDeployTxHash] = useState('')
  const [deployChainId, setDeployChainId] = useState(100)

  const { address: walletAddress, isConnected, chain } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()
  const wrongNetwork = isConnected && chain?.id !== deployChainId

  const resetState = () => {
    setMode('choose')
    setName('')
    setError('')
    setImportAddress('')
    setImportChainId(100)
    setDeployStep('name')
    setDeploying(false)
    setDeployedAddress('')
    setDeployTxHash('')
    setDeployChainId(100)
  }

  const handleClose = () => {
    resetState()
    onClose()
  }

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
      await onAdd(importAddress, name || 'My Safe', importChainId)
      resetState()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add Safe')
    }
  }

  // ── Deploy flow ──
  const handleDeploy = async () => {
    if (!walletClient || !publicClient || !walletAddress) return

    setDeploying(true)
    setDeployStep('deploying')
    setError('')

    try {
      const result = await deploySafe(walletClient, publicClient, walletAddress, deployChainId)
      setDeployedAddress(result.safeAddress)
      setDeployTxHash(result.txHash)

      // Register in Haven
      await onAdd(result.safeAddress, name || 'My Safe', deployChainId)
      setDeployStep('done')
    } catch (err: unknown) {
      setDeployStep('wallet')
      if (err instanceof Error) {
        if (err.message.includes('User rejected') || err.message.includes('denied')) {
          setError('Transaction was rejected in your wallet.')
        } else {
          setError(err.message.length > 200 ? 'Deployment failed. Please try again.' : err.message)
        }
      } else {
        setError('Deployment failed. Please try again.')
      }
    } finally {
      setDeploying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={handleClose} />
      <div className="relative bg-[#111] border border-white/[0.08] rounded-xl w-full max-w-md shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-0">
          <div className="flex items-center gap-2">
            {mode !== 'choose' && deployStep !== 'done' && (
              <button
                onClick={() => { setMode('choose'); setError(''); setDeployStep('name') }}
                className="p-1 -ml-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
              </button>
            )}
            <h2 className="text-lg font-semibold text-zinc-200">
              {mode === 'choose' && 'Add Account'}
              {mode === 'deploy' && deployStep === 'done' && 'Account Created'}
              {mode === 'deploy' && deployStep !== 'done' && 'Deploy New Safe'}
              {mode === 'import' && 'Import Existing Safe'}
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
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
              <p className="text-sm text-zinc-500 mb-4">
                Deploy a new Safe smart account or import one you already own.
              </p>
              <button
                onClick={() => setMode('deploy')}
                className="w-full flex items-center gap-4 p-4 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:border-indigo-500/30 hover:bg-indigo-500/[0.03] transition-all group text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0 group-hover:bg-indigo-500/15 transition-colors">
                  <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-zinc-200 group-hover:text-white transition-colors">Deploy New Safe</span>
                  <span className="block text-xs text-zinc-500 mt-0.5">Create a new Safe smart account on Gnosis Chain or Base</span>
                </div>
                <svg className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
              <button
                onClick={() => setMode('import')}
                className="w-full flex items-center gap-4 p-4 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.03] transition-all group text-left"
              >
                <div className="w-10 h-10 rounded-lg bg-white/[0.04] border border-white/[0.08] flex items-center justify-center flex-shrink-0 group-hover:bg-white/[0.06] transition-colors">
                  <svg className="w-5 h-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.07-9.07l-1.757 1.757a4.5 4.5 0 010 6.364l-4.5 4.5" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <span className="block text-sm font-medium text-zinc-200 group-hover:text-white transition-colors">Import Existing Safe</span>
                  <span className="block text-xs text-zinc-500 mt-0.5">Link a Safe you already own by its address</span>
                </div>
                <svg className="w-4 h-4 text-zinc-600 group-hover:text-zinc-400 transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            </div>
          )}

          {/* ── Deploy flow ── */}
          {mode === 'deploy' && deployStep === 'name' && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-500">
                Give your new account a name and choose a network.
              </p>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Account Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Business, Personal, Treasury"
                  autoFocus
                  className="w-full px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Network</label>
                <select
                  value={deployChainId}
                  onChange={(e) => setDeployChainId(Number(e.target.value))}
                  className="w-full px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50 transition-colors"
                >
                  {SUPPORTED_CHAINS.map((c) => (
                    <option key={c.chainId} value={c.chainId}>{c.name}</option>
                  ))}
                </select>
              </div>
              <button
                onClick={() => setDeployStep('wallet')}
                className="w-full py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 transition-colors"
              >
                Continue
              </button>
            </div>
          )}

          {mode === 'deploy' && deployStep === 'wallet' && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-500">
                Your connected wallet will be the owner of this Safe. Haven never holds signing authority.
              </p>

              {/* Wallet connection */}
              {!isConnected ? (
                <div className="flex flex-col items-center gap-3 p-4 rounded-lg border border-dashed border-white/[0.08]">
                  <p className="text-xs text-zinc-500">Connect a wallet to deploy</p>
                  <ConnectButton />
                </div>
              ) : (
                <div className="p-4 rounded-lg border border-white/[0.06] bg-white/[0.02]">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="block text-xs text-zinc-500 mb-1">Connected wallet</span>
                      <span className="text-sm font-mono text-zinc-300">
                        {walletAddress?.slice(0, 6)}...{walletAddress?.slice(-4)}
                      </span>
                    </div>
                    <ConnectButton.Custom>
                      {({ openAccountModal }) => (
                        <button
                          onClick={openAccountModal}
                          className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
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
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                  <span className="text-xs text-zinc-500">Name:</span>
                  <span className="text-xs text-zinc-300 font-medium">{name}</span>
                </div>
              )}

              {wrongNetwork && (
                <div className="text-sm text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-4 py-3">
                  Please switch to {getChainConfig(deployChainId).name} (chain ID {deployChainId}) in your wallet.
                </div>
              )}

              {error && (
                <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">
                  {error}
                </div>
              )}

              <button
                onClick={handleDeploy}
                disabled={!isConnected || wrongNetwork || deploying}
                className="w-full py-2.5 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all shadow-lg shadow-indigo-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Deploy Safe
              </button>
              <p className="text-[11px] text-zinc-600 text-center">
                This will submit a transaction on {getChainConfig(deployChainId).name}. Gas fees are minimal.
              </p>
            </div>
          )}

          {mode === 'deploy' && deployStep === 'deploying' && (
            <div className="flex flex-col items-center py-8">
              <div className="w-12 h-12 rounded-full border-2 border-indigo-500/30 border-t-indigo-500 animate-spin mb-6" />
              <h3 className="text-sm font-medium text-zinc-200 mb-2">Deploying your Safe</h3>
              <p className="text-xs text-zinc-500 text-center max-w-xs">
                Confirm the transaction in your wallet. Your Safe smart account is being deployed on {getChainConfig(deployChainId).name}.
              </p>
            </div>
          )}

          {mode === 'deploy' && deployStep === 'done' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-200">{name || 'My Safe'}</p>
                  <p className="text-xs text-zinc-500">Successfully deployed on {getChainConfig(deployChainId).name}</p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
                  <span className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Safe Address</span>
                  <a
                    href={getExplorerUrl(deployChainId, 'address', deployedAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-mono text-indigo-400 hover:text-indigo-300 transition-colors break-all"
                  >
                    {deployedAddress}
                  </a>
                </div>
                <div className="p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
                  <span className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Transaction</span>
                  <a
                    href={getExplorerUrl(deployChainId, 'tx', deployTxHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-mono text-indigo-400 hover:text-indigo-300 transition-colors break-all"
                  >
                    {deployTxHash.slice(0, 22)}...{deployTxHash.slice(-8)}
                  </a>
                </div>
              </div>

              <button
                onClick={handleClose}
                className="w-full py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 transition-colors"
              >
                Done
              </button>
            </div>
          )}

          {/* ── Import flow ── */}
          {mode === 'import' && (
            <form onSubmit={handleImport} className="space-y-4">
              <p className="text-sm text-zinc-500">
                Link an existing Safe by its address and network.
              </p>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Account Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Business, Personal"
                  className="w-full px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Network</label>
                <select
                  value={importChainId}
                  onChange={(e) => setImportChainId(Number(e.target.value))}
                  className="w-full px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50 transition-colors"
                >
                  {SUPPORTED_CHAINS.map((c) => (
                    <option key={c.chainId} value={c.chainId}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-500 mb-1">Safe Address</label>
                <input
                  type="text"
                  value={importAddress}
                  onChange={(e) => setImportAddress(e.target.value)}
                  placeholder="0x..."
                  autoFocus
                  className="w-full px-3 py-2.5 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-zinc-200 font-mono placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 transition-colors"
                />
              </div>

              {error && (
                <p className="text-xs text-red-400">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Adding...' : 'Import Account'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Rename Modal ────────────────────────────────────────────────────

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
  const [name, setName] = useState(safe.name)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim()) {
      await onRename(name.trim())
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-[#111] border border-white/[0.08] rounded-xl p-6 w-full max-w-sm shadow-2xl">
        <h2 className="text-lg font-semibold text-zinc-200 mb-4">Rename Account</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 text-sm rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────

export default function AccountsOverviewClient() {
  const router = useRouter()
  const { user, activeSafe, setActiveSafe } = useAuth()
  const { safes, loading, addSafe, renameSafe, removeSafe, setDefault } = useUserSafes()
  const { agents } = useAgents()

  const [addModalOpen, setAddModalOpen] = useState(false)
  const [renamingSafe, setRenamingSafe] = useState<UserSafe | null>(null)

  // Count agents per Safe
  const agentCountBySafe = new Map<string, number>()
  for (const agent of agents) {
    if (agent.safe_id) {
      agentCountBySafe.set(agent.safe_id, (agentCountBySafe.get(agent.safe_id) ?? 0) + 1)
    }
  }

  // Count orphaned agents (no safe_id)
  const orphanedAgents = agents.filter((a) => !a.safe_id && a.status === 'active')

  const handleCardClick = (safe: UserSafe) => {
    setActiveSafe(safe)
    router.push(`/accounts/${safe.id}`)
  }

  const handleRemove = async (safe: UserSafe) => {
    if (!confirm(`Remove "${safe.name}" from your account? This won't affect the on-chain Safe.`)) {
      return
    }
    await removeSafe(safe.id)
  }

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight mb-1">Accounts</h1>
          <p className="text-sm text-zinc-500">
            {safes.length} Safe account{safes.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => setAddModalOpen(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          Add Account
        </button>
      </div>

      {/* Orphaned agents warning */}
      {orphanedAgents.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 mb-6 rounded-lg bg-amber-500/[0.05] border border-amber-500/20">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-amber-400 flex-shrink-0">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="text-sm text-amber-400">
            {orphanedAgents.length} agent{orphanedAgents.length !== 1 ? 's have' : ' has'} no linked account. Reassign them in the Agents page.
          </span>
        </div>
      )}

      {/* Safe cards grid */}
      {safes.length === 0 ? (
        <div className="text-center py-16 rounded-lg border border-dashed border-white/[0.08]">
          <svg className="w-12 h-12 mx-auto mb-4 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
          </svg>
          <p className="text-sm text-zinc-600 mb-4">No Safe accounts yet</p>
          <button
            onClick={() => setAddModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 transition-colors"
          >
            Add your first account
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {safes.map((safe) => {
            const agentCount = agentCountBySafe.get(safe.id) ?? 0
            const isActive = activeSafe?.id === safe.id

            return (
              <div
                key={safe.id}
                className={`group relative rounded-lg border p-5 cursor-pointer transition-all duration-200 ${
                  isActive
                    ? 'border-indigo-500/30 bg-indigo-500/[0.03]'
                    : 'border-white/[0.06] bg-white/[0.01] hover:border-white/[0.12] hover:bg-white/[0.02]'
                }`}
                onClick={() => handleCardClick(safe)}
              >
                {/* Actions menu */}
                <div
                  className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => setRenamingSafe(safe)}
                    className="p-1.5 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
                    title="Rename"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                    </svg>
                  </button>
                  {!safe.is_default && (
                    <button
                      onClick={() => setDefault(safe.id)}
                      className="p-1.5 rounded-md text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.06] transition-colors"
                      title="Set as default"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={() => handleRemove(safe)}
                    className="p-1.5 rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-500/[0.06] transition-colors"
                    title="Remove"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </div>

                {/* Safe name */}
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-sm font-semibold text-zinc-200 truncate">{safe.name}</h3>
                  {safe.is_default && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 font-medium flex-shrink-0">
                      default
                    </span>
                  )}
                </div>

                {/* Address */}
                <p className="text-xs font-mono text-zinc-600 mb-4">
                  {truncate(safe.safe_address)}
                </p>

                {/* Stats */}
                <div className="flex items-center gap-4 text-xs text-zinc-500">
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
                    </svg>
                    {agentCount} agent{agentCount !== 1 ? 's' : ''}
                  </span>
                  <span className="flex items-center gap-1">
                    {getChainConfig(safe.chain_id ?? 100).name}
                  </span>
                </div>
              </div>
            )
          })}
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

      {/* Rename Modal */}
      {renamingSafe && (
        <RenameModal
          safe={renamingSafe}
          onClose={() => setRenamingSafe(null)}
          onRename={async (name) => {
            await renameSafe(renamingSafe.id, name)
          }}
          loading={loading}
        />
      )}
    </div>
  )
}
