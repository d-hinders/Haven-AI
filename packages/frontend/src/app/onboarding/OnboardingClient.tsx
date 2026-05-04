'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { api } from '@/lib/api'
import { deploySafe, type DeployStage } from '@/lib/safe'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import { getExplorerUrl, getChainConfig, SUPPORTED_CHAINS } from '@/lib/chains'
import NetworkGate from '@/components/NetworkGate'
import type { User } from '@/context/AuthContext'

type Step = 'connect' | 'deploy' | 'done'

export default function OnboardingClient() {
  const { user, loading, updateUser, refreshUser } = useAuth()
  const router = useRouter()

  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { data: walletClient } = useWalletClient()

  const [step, setStep] = useState<Step>('connect')
  const [deploying, setDeploying] = useState(false)
  const [deployStage, setDeployStage] = useState<DeployStage | null>(null)
  const [error, setError] = useState('')
  const [txHash, setTxHash] = useState('')
  const [safeAddress, setSafeAddress] = useState('')
  const [selectedChainId, setSelectedChainId] = useState(100)

  // Redirect if not logged in
  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login')
    }
  }, [loading, user, router])

  // Redirect if user already has a Safe
  useEffect(() => {
    if (!loading && user && (user.safes?.length > 0 || user.safe_address)) {
      router.replace('/dashboard')
    }
  }, [loading, user, router])

  // When wallet connects, save the address and advance to deploy step.
  // If the save fails we still advance (the address will be re-saved during
  // /user/safe), but we log the error and surface a non-blocking warning so
  // nothing fails silently.
  useEffect(() => {
    if (isConnected && address && user && step === 'connect') {
      api
        .put<User>('/user/wallet', { wallet_address: address })
        .then((updated) => {
          updateUser(updated)
          setStep('deploy')
        })
        .catch((err: unknown) => {
          console.warn('[Haven] Failed to persist wallet address before deploy:', err)
          // Address will be saved during deploy via /user/safe. Advance so
          // the user isn't stuck, but keep the warning visible.
          setError(
            'We couldn\u2019t save your wallet address just now. You can continue \u2014 we\u2019ll save it when you deploy.',
          )
          setStep('deploy')
        })
    }
  }, [isConnected, address, user, step, updateUser])

  const handleDeploy = async () => {
    if (!walletClient || !publicClient || !address) return

    setDeploying(true)
    setDeployStage('signing')
    setError('')

    try {
      const result = await deploySafe(
        walletClient,
        publicClient,
        address,
        selectedChainId,
        (stage, data) => {
          setDeployStage(stage)
          if (data?.txHash) setTxHash(data.txHash)
        },
      )
      setTxHash(result.txHash)
      setSafeAddress(result.safeAddress)

      // Save to backend
      setDeployStage('registering')
      await api.put<User>('/user/safe', { safe_address: result.safeAddress, chain_id: selectedChainId })
      updateUser({ safe_address: result.safeAddress, wallet_address: address })
      await refreshUser()

      setStep('done')
    } catch (err: unknown) {
      console.error('Safe deployment failed:', err)
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
      setDeployStage(null)
    }
  }

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
          <span className="text-sm text-zinc-500">Loading...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed] flex flex-col">
      {/* Background gradient */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.12) 0%, transparent 70%)',
        }}
      />

      {/* Top bar */}
      <div className="relative z-10 border-b border-white/[0.06] bg-[#0a0a0a]/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link
            href="/"
            className="text-[15px] font-semibold tracking-tight bg-gradient-to-r from-white to-indigo-200 bg-clip-text text-transparent"
          >
            Haven
          </Link>
          <span className="text-xs text-zinc-600">{user.email}</span>
        </div>
      </div>

      {/* Content */}
      <div className="relative z-10 flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">
          {/* Progress indicator */}
          <div className="flex items-center gap-3 mb-10">
            {(['connect', 'deploy', 'done'] as const).map((s, i) => {
              const steps: Step[] = ['connect', 'deploy', 'done']
              const currentIdx = steps.indexOf(step)
              return (
                <div key={s} className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium border transition-colors duration-300 ${
                      step === s
                        ? 'border-indigo-500 bg-indigo-500/20 text-indigo-300'
                        : currentIdx > i
                          ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
                          : 'border-white/[0.08] text-zinc-600'
                    }`}
                  >
                    {currentIdx > i ? '✓' : i + 1}
                  </div>
                  {i < 2 && (
                    <div
                      className={`w-12 h-px transition-colors duration-300 ${
                        currentIdx > i ? 'bg-emerald-500/30' : 'bg-white/[0.06]'
                      }`}
                    />
                  )}
                </div>
              )
            })}
          </div>

          {/* Step: Connect Wallet */}
          {step === 'connect' && (
            <div>
              <h1 className="text-2xl font-bold tracking-tight mb-2">
                Connect your wallet
              </h1>
              <p className="text-sm text-zinc-500 mb-8 leading-relaxed">
                Connect a browser wallet to get started. This wallet will become the owner of your
                Safe smart account — giving you full custody of your funds.
              </p>
              <ConnectButton />
            </div>
          )}

          {/* Step: Deploy Safe */}
          {step === 'deploy' && (
            <div>
              <h1 className="text-2xl font-bold tracking-tight mb-2">
                Deploy your Safe
              </h1>
              <p className="text-sm text-zinc-500 mb-8 leading-relaxed">
                Deploy a Safe smart account on your chosen network. Your connected wallet will be
                the sole owner with full control. Haven never holds signing authority.
              </p>

              {/* Connected wallet info */}
              <div className="mb-4 p-4 rounded-md border border-white/[0.06] bg-white/[0.02]">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="block text-xs text-zinc-500 mb-1">Connected wallet</span>
                    <span className="text-sm font-mono text-zinc-300">
                      {address?.slice(0, 6)}...{address?.slice(-4)}
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

              {/* Chain selector */}
              <div className="mb-6 p-4 rounded-md border border-white/[0.06] bg-white/[0.02]">
                <span className="block text-xs text-zinc-500 mb-2">Network</span>
                <select
                  value={selectedChainId}
                  onChange={(e) => setSelectedChainId(Number(e.target.value))}
                  className="w-full bg-transparent text-sm text-zinc-200 outline-none cursor-pointer"
                >
                  {SUPPORTED_CHAINS.map((c) => (
                    <option key={c.chainId} value={c.chainId} className="bg-[#0a0a0a]">
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              {error && (
                <div className="mb-6 text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-4 py-3">
                  {error}
                </div>
              )}

              <NetworkGate requiredChainId={selectedChainId}>
                <button
                  onClick={handleDeploy}
                  disabled={deploying}
                  className="w-full py-2.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deploying ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      {deployStage === 'signing' && 'Waiting for signature...'}
                      {deployStage === 'confirming' && 'Confirming on-chain...'}
                      {deployStage === 'registering' && 'Finalizing...'}
                      {!deployStage && 'Deploying Safe...'}
                    </span>
                  ) : (
                    'Deploy Safe'
                  )}
                </button>
              </NetworkGate>

              {deploying && (
                <div className="mt-6 space-y-2">
                  {(
                    [
                      { id: 'signing', label: 'Sign in wallet', hint: 'Confirm the transaction in your wallet' },
                      { id: 'confirming', label: 'Confirming on-chain', hint: 'Waiting for block inclusion' },
                      { id: 'registering', label: 'Registering with Haven', hint: 'Linking Safe to your account' },
                    ] as const
                  ).map((s, i) => {
                    const order: DeployStage[] = ['signing', 'confirming', 'registering']
                    const currentIdx = deployStage ? order.indexOf(deployStage) : 0
                    const isActive = deployStage === s.id
                    const isDone = currentIdx > i
                    return (
                      <div
                        key={s.id}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-md border transition-colors duration-300 ${
                          isActive
                            ? 'border-indigo-500/40 bg-indigo-500/[0.06]'
                            : isDone
                              ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
                              : 'border-white/[0.05] bg-white/[0.01]'
                        }`}
                      >
                        <div
                          className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 ${
                            isActive
                              ? 'bg-indigo-500/20 text-indigo-300'
                              : isDone
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : 'bg-white/[0.04] text-zinc-600'
                          }`}
                        >
                          {isDone ? (
                            '✓'
                          ) : isActive ? (
                            <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
                          ) : (
                            i + 1
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div
                            className={`text-xs font-medium ${
                              isActive ? 'text-indigo-200' : isDone ? 'text-emerald-300/80' : 'text-zinc-500'
                            }`}
                          >
                            {s.label}
                          </div>
                          {isActive && (
                            <div className="text-[11px] text-zinc-500 mt-0.5">{s.hint}</div>
                          )}
                        </div>
                        {isActive && (
                          <div className="w-3 h-3 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin shrink-0" />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Step: Done */}
          {step === 'done' && (
            <div>
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mb-6">
                <span className="text-emerald-400 text-xl">✓</span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight mb-2">
                Safe deployed
              </h1>
              <p className="text-sm text-zinc-500 mb-8 leading-relaxed">
                Your non-custodial smart account is live on {getChainConfig(selectedChainId).name}. You can now create agents
                with spending policies and start transacting.
              </p>

              {/* Safe details */}
              <div className="mb-6 space-y-3">
                <div className="p-4 rounded-md border border-white/[0.06] bg-white/[0.02]">
                  <span className="block text-xs text-zinc-500 mb-1">Safe address</span>
                  <a
                    href={getExplorerUrl(selectedChainId, 'address', safeAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors break-all"
                  >
                    {safeAddress}
                  </a>
                </div>
                <div className="p-4 rounded-md border border-white/[0.06] bg-white/[0.02]">
                  <span className="block text-xs text-zinc-500 mb-1">Transaction</span>
                  <a
                    href={getExplorerUrl(selectedChainId, 'tx', txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors break-all"
                  >
                    {txHash.slice(0, 20)}...{txHash.slice(-8)}
                  </a>
                </div>
              </div>

              <button
                onClick={() => router.push('/dashboard')}
                className="w-full py-2.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20"
              >
                Go to Dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
