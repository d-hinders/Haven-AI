'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { api } from '@/lib/api'
import { displayName } from '@/lib/user'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount } from 'wagmi'
import { DEFAULT_CHAIN_ID, getExplorerUrl, getChainConfig, SUPPORTED_CHAINS } from '@/lib/chains'
import { HavenMark } from '@/components/brand/HavenMark'
import { StepProgress } from '@/components/ui/StepProgress'
import PasskeyEnrollFlow from './PasskeyEnrollFlow'
import type { User } from '@/context/AuthContext'

type Step = 'choose-signer' | 'connect' | 'deploy' | 'done'
type SignerMode = 'passkey' | 'eoa' | null
type DeployStage = 'deploying' | 'registering'

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
            'We couldn’t save your wallet address just now. You can continue — we’ll save it when you deploy.',
          )
          setStep('deploy')
        })
    }
  }, [address, isConnected, signerMode, step, updateUser, user])

  const handleDeploy = async () => {
    if (!address) return

    setDeploying(true)
    setDeployStage('deploying')
    setError('')

    try {
      // Step 1: relay pays gas and deploys the Safe on-chain — no wallet signature needed
      const deployed = await api.post<{ safe_address: string; tx_hash: string }>(
        '/user/safes/deploy',
        { chain_id: selectedChainId, owner_address: address },
      )

      setTxHash(deployed.tx_hash)
      setSafeAddress(deployed.safe_address)

      // Step 2: register in Haven
      setDeployStage('registering')
      await api.post('/user/safes', {
        safe_address: deployed.safe_address,
        chain_id: selectedChainId,
        name: 'My account',
      })
      updateUser({ safe_address: deployed.safe_address, wallet_address: address })
      await refreshUser()

      setStep('done')
    } catch (err: unknown) {
      console.error('Safe deployment failed:', err)
      setError(err instanceof Error ? err.message : 'Deployment failed. Please try again.')
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
  const networkName = getChainConfig(selectedChainId).name
  const completionTitle = "You're in"
  const completionDescription = `Your Haven account is live on ${networkName}. Add funds, set agent budgets, and you're ready to pay.`
  const completionAddressLabel = 'Account address'
  const completionTxLabel = isPasskeyOnboarding ? 'Setup transaction' : 'Transaction'

  // Capture the "just onboarded" moment so the dashboard can fire its
  // welcome toast / hero fade exactly once on first arrival. Session-scoped
  // so a normal refresh of the dashboard later in the session doesn't
  // re-fire.
  const markJustOnboarded = () => {
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem('haven-just-onboarded', '1')
      } catch {
        // sessionStorage can throw in private mode — fall back to a
        // dashboard arrival without the celebration. No user-facing impact.
      }
    }
  }

  const handleGoToDashboard = () => {
    markJustOnboarded()
    router.push('/dashboard')
  }

  const handleSetUpFirstAgent = () => {
    markJustOnboarded()
    router.push('/agents?setup=first')
  }

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
          <StepProgress
            totalSteps={progressSteps.length}
            currentStep={
              step === 'done'
                ? progressSteps.length
                : progressSteps.findIndex((progressStep) => progressStep === step)
            }
            className="mb-10"
          />

          {step === 'choose-signer' && (
            <div key="choose-signer" className="v2-animate-step-rise space-y-6">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">Welcome, {name}</h1>
                <p className="text-sm text-[var(--v2-ink-2)] leading-relaxed">
                  Pick how you'll approve payments. You can change networks later.
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
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-[var(--v2-brand)] ring-1 ring-[var(--v2-brand)]/20 group-hover:bg-[var(--v2-brand-soft)]">
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
            <div key="connect" className="v2-animate-step-rise">
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">Connect your wallet</h1>
              <p className="text-sm text-[var(--v2-ink-2)] mb-8 leading-relaxed">
                Use a browser wallet to approve payments and changes for your Haven account.
                You stay in control — Haven never holds your signing key.
              </p>
              <ConnectButton />
            </div>
          )}

          {step === 'deploy' && signerMode === 'eoa' && (
            <div key="deploy-eoa" className="v2-animate-step-rise">
              <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">Create your Haven account</h1>
              <p className="text-sm text-[var(--v2-ink-2)] mb-8 leading-relaxed">
                Your connected wallet will be the owner of this account. Haven&rsquo;s relayer pays gas &mdash; no wallet signature needed.
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

              <button
                onClick={handleDeploy}
                disabled={deploying || !address}
                className="w-full py-2.5 rounded-md bg-[var(--v2-brand)] text-white text-sm font-medium hover:bg-[var(--v2-brand-strong)] transition-all duration-200 shadow-[var(--v2-shadow-button)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deploying ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {deployStage === 'deploying' && 'Deploying on-chain…'}
                    {deployStage === 'registering' && 'Linking to Haven…'}
                    {!deployStage && 'Creating your account…'}
                  </span>
                ) : (
                  'Create my Haven account'
                )}
              </button>

              {deploying && (
                <div className="relative mt-6">
                  <div
                    aria-hidden="true"
                    className="v2-mesh-drift pointer-events-none absolute -inset-x-6 -inset-y-4 -z-10 opacity-60"
                    style={{
                      background:
                        'radial-gradient(ellipse 60% 50% at 30% 30%, rgba(99,102,241,0.16) 0%, transparent 70%), radial-gradient(ellipse 55% 45% at 75% 70%, rgba(14,165,233,0.13) 0%, transparent 65%)',
                    }}
                  />
                  <div className="space-y-2">
                    {(
                      [
                        {
                          id: 'deploying',
                          label: 'Deploying on-chain',
                          hint: 'Relayer is submitting the transaction — no wallet action needed.',
                        },
                        {
                          id: 'registering',
                          label: 'Linking to Haven',
                          hint: 'Linking the on-chain account to your Haven profile.',
                        },
                      ] as const
                    ).map((item, index) => {
                      const order: DeployStage[] = ['deploying', 'registering']
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
                            {isDone ? (
                              '✓'
                            ) : isActive ? (
                              <span className="animate-pending-pulse w-2 h-2 rounded-full bg-[var(--v2-brand)]" />
                            ) : (
                              index + 1
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className={`text-xs font-medium ${isActive ? 'text-[var(--v2-brand)]' : isDone ? 'text-[var(--v2-success)]' : 'text-[var(--v2-ink-3)]'}`}>
                              {item.label}
                            </div>
                            {isActive && (
                              <div className="text-xs text-[var(--v2-ink-3)] mt-0.5">
                                {item.hint}
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
                </div>
              )}
            </div>
          )}

          {step === 'deploy' && signerMode === 'passkey' && (
            <div key="deploy-passkey" className="v2-animate-step-rise">
              <PasskeyEnrollFlow
                user={user}
                selectedChainId={selectedChainId}
                onComplete={(args) => {
                  void handlePasskeyComplete(args)
                }}
                onError={setError}
              />
            </div>
          )}

          {step === 'done' && (
            <div key="done" className="v2-animate-step-rise">
              {/* Check-bloom moment — a brand-soft disc with a check that
                  pops in, surrounded by a single soft radial bloom that
                  grows and fades behind it. Plays once on mount. */}
              <div className="relative mb-6 flex justify-center">
                <div
                  aria-hidden="true"
                  className="v2-animate-bloom pointer-events-none absolute inset-0 flex items-center justify-center"
                >
                  <div
                    className="h-24 w-24 rounded-full"
                    style={{
                      background:
                        'radial-gradient(circle, rgba(99,102,241,0.35) 0%, rgba(99,102,241,0.12) 45%, transparent 70%)',
                    }}
                  />
                </div>
                <div className="animate-check-pop relative flex h-14 w-14 items-center justify-center rounded-full bg-[var(--v2-brand-soft)] ring-1 ring-inset ring-[var(--v2-brand)]/25 shadow-[var(--v2-shadow-button)]">
                  <svg
                    className="h-7 w-7 text-[var(--v2-brand)]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.4}
                  >
                    <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>

              <div
                className="v2-animate-stagger text-center"
                style={{ ['--v2-stagger-delay' as string]: '160ms' }}
              >
                <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                  {completionTitle}
                </h1>
                <p className="text-sm text-[var(--v2-ink-2)] mb-8 leading-relaxed">
                  {completionDescription}
                </p>
              </div>

              <div
                className="v2-animate-stagger mb-6 space-y-3"
                style={{ ['--v2-stagger-delay' as string]: '260ms' }}
              >
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
                onClick={handleSetUpFirstAgent}
                className="v2-animate-stagger w-full py-3 rounded-md bg-[var(--v2-brand)] text-white text-sm font-semibold hover:bg-[var(--v2-brand-strong)] transition-all duration-200 shadow-[var(--v2-shadow-button)] hover:-translate-y-0.5 hover:shadow-[var(--v2-shadow-card)]"
                style={{ ['--v2-stagger-delay' as string]: '340ms' }}
              >
                Set up your first agent →
              </button>
              <button
                onClick={handleGoToDashboard}
                className="v2-animate-stagger mt-3 w-full py-3 rounded-md text-sm font-medium text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] transition-colors"
                style={{ ['--v2-stagger-delay' as string]: '400ms' }}
              >
                Skip for now — go to dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
