'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { api } from '@/lib/api'
import { deploySafe, type DeployStage } from '@/lib/safe'
import { displayName } from '@/lib/user'
import { useActiveSigner } from '@/lib/signer'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, usePublicClient } from 'wagmi'
import { DEFAULT_CHAIN_ID, getExplorerUrl, getChainConfig, SUPPORTED_CHAINS } from '@/lib/chains'
import NetworkGate from '@/components/NetworkGate'
import { SigningStatus } from '@/components/SigningStatus'
import { HavenMark } from '@/components/brand/HavenMark'
import PasskeyEnrollFlow from './PasskeyEnrollFlow'
import type { User } from '@/context/AuthContext'

type Step = 'choose-signer' | 'connect' | 'deploy' | 'done'
type SignerMode = 'passkey' | 'eoa' | null

const EMPTY_TX_HASH = `0x${'0'.repeat(64)}`

export default function OnboardingClient() {
  const { user, loading, updateUser, refreshUser } = useAuth()
  const router = useRouter()

  const { address, isConnected } = useAccount()

  const [step, setStep] = useState<Step>('choose-signer')
  const [signerMode, setSignerMode] = useState<SignerMode>(null)
  const [deploying, setDeploying] = useState(false)
  const [deployStage, setDeployStage] = useState<DeployStage | null>(null)
  const [error, setError] = useState('')
  const [txHash, setTxHash] = useState('')
  const [safeAddress, setSafeAddress] = useState('')
  const [selectedChainId, setSelectedChainId] = useState(DEFAULT_CHAIN_ID)
  const publicClient = usePublicClient({ chainId: selectedChainId })
  const signer = useActiveSigner({ chainId: selectedChainId })

  const progressSteps = useMemo(() => {
    if (signerMode === 'eoa') {
      return ['choose-signer', 'connect', 'deploy', 'done'] as const
    }
    return ['choose-signer', 'deploy', 'done'] as const
  }, [signerMode])

  // Redirect if not logged in
  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login')
    }
  }, [loading, user, router])

  // Redirect if user already has a Safe before onboarding starts.
  useEffect(() => {
    if (
      !loading &&
      user &&
      (user.safes?.length > 0 || user.safe_address) &&
      step === 'choose-signer'
    ) {
      router.replace('/dashboard')
    }
  }, [loading, router, step, user])

  // EOA branch only: when wallet connects, save the address and advance to deploy.
  useEffect(() => {
    if (signerMode !== 'eoa') return

    if (isConnected && address && user && step === 'connect') {
      api
        .put<User>('/user/wallet', { wallet_address: address })
        .then((updated) => {
          updateUser(updated)
          setStep('deploy')
        })
        .catch((err: unknown) => {
          console.warn('[Haven] Failed to persist wallet address before deploy:', err)
          setError(
            'We couldn\u2019t save your wallet address just now. You can continue \u2014 we\u2019ll save it when you deploy.',
          )
          setStep('deploy')
        })
    }
  }, [address, isConnected, signerMode, step, updateUser, user])

  const handleDeploy = async () => {
    if (!signer || !publicClient) return

    setDeploying(true)
    setDeployStage('signing')
    setError('')

    try {
      const result = await deploySafe(
        signer,
        publicClient,
        selectedChainId,
        (stage, data) => {
          setDeployStage(stage)
          if (data?.txHash) setTxHash(data.txHash)
        },
      )
      setTxHash(result.txHash)
      setSafeAddress(result.safeAddress)

      // Save to backend using the existing EOA path.
      setDeployStage('registering')
      await api.put<User>('/user/safe', {
        safe_address: result.safeAddress,
        chain_id: selectedChainId,
      })

      updateUser({
        safe_address: result.safeAddress,
        wallet_address: signer.type === 'eoa' ? signer.address : user?.wallet_address,
      })
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

  async function handlePasskeyComplete(args: {
    safeAddress: `0x${string}`
    txHash: `0x${string}`
  }) {
    setError('')
    setSafeAddress(args.safeAddress)
    setTxHash(args.txHash)
    updateUser({
      safe_address: args.safeAddress,
      wallet_address: null,
    })
    await refreshUser()
    setStep('done')
  }

  if (loading || !user) {
    return (
      <div className="min-h-screen bg-[var(--v2-bg)] flex items-center justify-center">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" />
          <span className="text-sm text-[var(--v2-ink-2)]">Loading...</span>
        </div>
      </div>
    )
  }

  const isPasskeyOnboarding = signerMode === 'passkey'
  const name = displayName(user)
  const completionTitle = 'Your Haven account is ready'
  const completionDescription = `Your account is live on ${getChainConfig(selectedChainId).name}. You can now add funds, create agent budgets, and start making payments.`
  const completionAddressLabel = 'Account address'
  const completionTxLabel = isPasskeyOnboarding ? 'Setup transaction' : 'Transaction'

  return (
    <div className="min-h-screen bg-[var(--v2-bg)] text-[var(--v2-ink)] flex flex-col">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 55% at 50% -10%, rgba(99,102,241,0.13) 0%, transparent 70%), radial-gradient(ellipse 70% 60% at 100% 10%, rgba(14,165,233,0.08) 0%, transparent 65%)',
        }}
      />

      <div className="relative z-10 border-b border-[var(--v2-border)] bg-white/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight text-[var(--v2-ink)]"
          >
            <HavenMark />
            Haven
          </Link>
          <span className="text-xs text-[var(--v2-ink-3)]">{name}</span>
        </div>
      </div>

      <div className="relative z-10 flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-xl rounded-[14px] border border-[var(--v2-border)] bg-white p-6 shadow-[var(--v2-shadow-card)]">
          <div className="flex items-center gap-3 mb-10">
            {progressSteps.map((currentStep, index) => {
              const currentIndex = progressSteps.findIndex((progressStep) => progressStep === step)
              const isCompleted = currentIndex > index || (step === 'done' && currentStep === 'done')
              const isActive = step === currentStep && step !== 'done'
              return (
                <div key={currentStep} className="flex items-center gap-3">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium border transition-colors duration-300 ${
                      isActive
                        ? 'border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                        : isCompleted
                          ? 'border-[var(--v2-success)]/30 bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
                          : 'border-[var(--v2-border)] text-[var(--v2-ink-3)]'
                    }`}
                  >
                    {isCompleted ? '✓' : index + 1}
                  </div>
                  {index < progressSteps.length - 1 && (
                    <div
                      className={`h-px w-12 shrink-0 transition-colors duration-300 ${
                        currentIndex > index ? 'bg-[var(--v2-success)]/45' : 'bg-[var(--v2-border)]'
                      }`}
                    />
                  )}
                </div>
              )
            })}
          </div>

          {step === 'choose-signer' && (
            <div className="space-y-6">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">Welcome, {name}</h1>
                <p className="text-sm text-[var(--v2-ink-2)] leading-relaxed">
                  Choose a network, then pick how you want to approve payments and changes.
                </p>
              </div>

              <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                <span className="block text-xs font-medium text-[var(--v2-ink-2)] mb-2">Network</span>
                <select
                  value={selectedChainId}
                  onChange={(e) => setSelectedChainId(Number(e.target.value))}
                  className="w-full bg-transparent text-sm text-[var(--v2-ink)] outline-none cursor-pointer"
                >
                  {SUPPORTED_CHAINS.map((chain) => (
                    <option key={chain.chainId} value={chain.chainId}>
                      {chain.name}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="button"
                onClick={() => {
                  setSignerMode('passkey')
                  setError('')
                  setStep('deploy')
                }}
                className="group w-full rounded-xl border-2 border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] px-5 py-4 text-left shadow-[var(--v2-shadow-button)] transition-all duration-150 hover:-translate-y-0.5 hover:border-[var(--v2-brand-strong)] hover:bg-white hover:shadow-[var(--v2-shadow-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-[var(--v2-ink)]">Use Face ID / Touch ID</div>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-[var(--v2-brand)] ring-1 ring-[var(--v2-brand)]/20 group-hover:bg-[var(--v2-brand-soft)]">
                    Default
                  </span>
                </div>
                <div className="mt-1 text-xs text-[var(--v2-ink-2)]">Fastest option. Creates a secure passkey.</div>
              </button>

              <button
                type="button"
                onClick={() => {
                  setSignerMode('eoa')
                  setError('')
                  setStep('connect')
                }}
                className="w-full rounded-xl border border-[var(--v2-border-strong)] bg-white px-5 py-4 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-[var(--v2-brand)]/45 hover:bg-[var(--v2-surface)] hover:shadow-[var(--v2-shadow-card)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 focus-visible:ring-offset-2 focus-visible:ring-offset-white"
              >
                <div className="text-sm font-semibold text-[var(--v2-ink)]">Connect a wallet instead</div>
                <div className="mt-1 text-xs text-[var(--v2-ink-3)]">Use an existing crypto wallet.</div>
              </button>
            </div>
          )}

          {step === 'connect' && signerMode === 'eoa' && (
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">Connect your wallet</h1>
              <p className="text-sm text-[var(--v2-ink-2)] mb-8 leading-relaxed">
                Connect a browser wallet to get started. This wallet will approve payments and
                changes for your Haven account.
              </p>
              <ConnectButton />
            </div>
          )}

          {step === 'deploy' && signerMode === 'eoa' && (
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">Create your Haven account</h1>
              <p className="text-sm text-[var(--v2-ink-2)] mb-8 leading-relaxed">
                Create your Haven account on your chosen network. Your connected wallet will approve
                payments and changes. Haven never holds signing authority.
              </p>

              <div className="mb-4 p-4 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="block text-xs text-[var(--v2-ink-3)] mb-1">Connected wallet</span>
                    <span className="text-sm font-mono text-[var(--v2-ink)]">
                      {address?.slice(0, 6)}...{address?.slice(-4)}
                    </span>
                  </div>
                  <ConnectButton.Custom>
                    {({ openAccountModal }) => (
                      <button
                        onClick={openAccountModal}
                        className="text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
                      >
                        Change
                      </button>
                    )}
                  </ConnectButton.Custom>
                </div>
              </div>

              <div className="mb-6 p-4 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                <span className="block text-xs text-[var(--v2-ink-3)] mb-2">Network</span>
                <select
                  value={selectedChainId}
                  onChange={(e) => setSelectedChainId(Number(e.target.value))}
                  className="w-full bg-transparent text-sm text-[var(--v2-ink)] outline-none cursor-pointer"
                >
                  {SUPPORTED_CHAINS.map((chain) => (
                    <option key={chain.chainId} value={chain.chainId}>
                      {chain.name}
                    </option>
                  ))}
                </select>
              </div>

              {error && (
                <div className="mb-6 rounded-md border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
                  {error}
                </div>
              )}

              <NetworkGate requiredChainId={selectedChainId}>
                <button
                  onClick={handleDeploy}
                  disabled={deploying}
                  className="w-full py-2.5 rounded-md bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-all duration-200 shadow-[var(--v2-shadow-button)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deploying ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      {deployStage === 'signing' && 'Waiting for signature...'}
                      {deployStage === 'confirming' && 'Confirming on-chain...'}
                      {deployStage === 'registering' && 'Finalizing...'}
                      {!deployStage && 'Creating account...'}
                    </span>
                  ) : (
                    'Create account'
                  )}
                </button>
              </NetworkGate>

              {deploying && (
                <div className="mt-6 space-y-2">
                  {(
                    [
                      { id: 'signing', label: 'Sign in wallet' },
                      { id: 'confirming', label: 'Confirming on-chain' },
                      { id: 'registering', label: 'Registering with Haven' },
                    ] as const
                  ).map((item, index) => {
                    const order: DeployStage[] = ['signing', 'confirming', 'registering']
                    const currentIndex = deployStage ? order.indexOf(deployStage) : 0
                    const isActive = deployStage === item.id
                    const isDone = currentIndex > index

                    return (
                      <div
                        key={item.id}
                        className={`flex items-center gap-3 px-3 py-2.5 rounded-md border transition-colors duration-300 ${
                          isActive
                            ? 'border-[var(--v2-brand)]/35 bg-[var(--v2-brand-soft)]'
                            : isDone
                              ? 'border-[var(--v2-success)]/20 bg-[var(--v2-success-soft)]'
                              : 'border-[var(--v2-border)] bg-white'
                        }`}
                      >
                        <div
                          className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 ${
                            isActive
                              ? 'bg-white text-[var(--v2-brand)]'
                              : isDone
                                ? 'bg-white text-[var(--v2-success)]'
                                : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-3)]'
                          }`}
                        >
                          {isDone ? '✓' : isActive ? <span className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" /> : index + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className={`text-xs font-medium ${isActive ? 'text-[var(--v2-brand)]' : isDone ? 'text-[var(--v2-success)]' : 'text-[var(--v2-ink-3)]'}`}>
                            {item.label}
                          </div>
                          {isActive && (
                            <div className="text-[11px] text-[var(--v2-ink-3)] mt-0.5">
                              {item.id === 'signing' ? (
                                <SigningStatus signer={signer} stage="signing" />
                              ) : item.id === 'confirming' ? (
                                'Waiting for block inclusion'
                              ) : (
                                'Linking your account to Haven'
                              )}
                            </div>
                          )}
                        </div>
                        {isActive && (
                          <div className="w-3 h-3 border-2 border-[var(--v2-brand)]/30 border-t-[var(--v2-brand)] rounded-full animate-spin shrink-0" />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {step === 'deploy' && signerMode === 'passkey' && (
            <PasskeyEnrollFlow
              user={user}
              selectedChainId={selectedChainId}
              onComplete={(args) => {
                void handlePasskeyComplete(args)
              }}
              onError={setError}
            />
          )}

          {step === 'done' && (
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">{completionTitle}</h1>
              <p className="text-sm text-[var(--v2-ink-2)] mb-8 leading-relaxed">
                {completionDescription}
              </p>

              <div className="mb-6 space-y-3">
                <div className="p-4 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                  <span className="block text-xs text-[var(--v2-ink-3)] mb-1">{completionAddressLabel}</span>
                  <a
                    href={getExplorerUrl(selectedChainId, 'address', safeAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-mono text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors break-all"
                  >
                    {safeAddress}
                  </a>
                </div>
                {txHash && txHash !== EMPTY_TX_HASH && (
                  <div className="p-4 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)]">
                    <span className="block text-xs text-[var(--v2-ink-3)] mb-1">{completionTxLabel}</span>
                    <a
                      href={getExplorerUrl(selectedChainId, 'tx', txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-mono text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors break-all"
                    >
                      {txHash.slice(0, 20)}...{txHash.slice(-8)}
                    </a>
                  </div>
                )}
              </div>

              <button
                onClick={() => router.push('/dashboard')}
                className="w-full py-2.5 rounded-md bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-all duration-200 shadow-[var(--v2-shadow-button)]"
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
