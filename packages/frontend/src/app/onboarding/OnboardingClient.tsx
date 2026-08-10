'use client'

/**
 * Onboarding — one screen (#1162).
 *
 * Signup is passkey-only and single-screen: welcome + network + "create with
 * Face ID / Touch ID", then a success state IN PLACE that hands off to the
 * dashboard, where `DashboardOnboardingGuide` takes over. There is no signer
 * fork here — the delegation rail (epic #821/#836) is passkey-first, and an
 * EOA is a later addition to an account's signer set, not a starting choice.
 * A wallet-owned account is still reachable post-onboarding from
 * Accounts → Add account, and a wallet can join an existing account's signer
 * set from Backup & recovery.
 */

import { Check } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { displayName } from '@/lib/user'
import { DEFAULT_CHAIN_ID, DELEGATION_ONBOARDING_CHAIN_IDS, getChainConfig } from '@/lib/chains'
import { useDeployableChains } from '@/hooks/useDeployableChains'
import { HavenMark } from '@/components/brand/HavenMark'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Select } from '@/components/ui/Select'
import PasskeyEnrollFlow from './PasskeyEnrollFlow'
import HybridEnrollFlow from './HybridEnrollFlow'

type Phase = 'create' | 'success'

/** How long the success state holds before handing off to the dashboard. */
export const SUCCESS_REDIRECT_MS = 2000

/**
 * Capture the "just onboarded" moment so the dashboard can fire its welcome
 * toast / hero fade exactly once on first arrival. Session-scoped so a normal
 * refresh of the dashboard later in the session doesn't re-fire.
 */
function markJustOnboarded() {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem('haven-just-onboarded', '1')
  } catch {
    // sessionStorage can throw in private mode — fall back to a dashboard
    // arrival without the celebration. No user-facing impact.
  }
}

export default function OnboardingClient() {
  const { user, loading, updateUser, refreshUser, logout } = useAuth()
  const router = useRouter()

  const [phase, setPhase] = useState<Phase>('create')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [selectedChainId, setSelectedChainId] = useState(DEFAULT_CHAIN_ID)

  // Latches on the first create attempt so the "already has an account"
  // redirect below can't fire mid-flow — completing enrollment gives the user
  // an account, which would otherwise bounce them past the success state.
  const creationStartedRef = useRef(false)

  // Delegation-rail onboarding (#886): dark-launched behind a flag, on the
  // chains where the rail is live — Base Sepolia since the pilot, Base
  // mainnet since the #908 launch prep (the flag on the prod Vercel scope is
  // the actual launch switch; flipping it is the LAST step of the mainnet
  // canary runbook, docs/operations/mainnet-canary.md). When active, the
  // passkey path creates a Hybrid account (counterfactual, zero tx) instead
  // of deploying a Safe.
  const delegationOnboarding =
    process.env.NEXT_PUBLIC_DELEGATION_ONBOARDING === '1' &&
    DELEGATION_ONBOARDING_CHAIN_IDS.has(selectedChainId)

  // Only offer chains the backend actually serves deploys on (#679). If the
  // current selection isn't served (e.g. the default is mainnet but this env
  // only serves Base Sepolia), snap to the first served chain.
  const { chains: deployableChains } = useDeployableChains()
  useEffect(() => {
    if (
      deployableChains.length > 0 &&
      !deployableChains.some((c) => c.chainId === selectedChainId)
    ) {
      setSelectedChainId(deployableChains[0].chainId)
    }
  }, [deployableChains, selectedChainId])

  // Redirect if not logged in
  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login')
    }
  }, [loading, user, router])

  // Redirect if the user already had an account before onboarding started.
  useEffect(() => {
    if (loading || !user) return
    if (creationStartedRef.current || phase === 'success') return
    if (user.safes?.length > 0 || user.safe_address) {
      router.replace('/dashboard')
    }
  }, [loading, phase, router, user])

  const goToDashboard = useCallback(() => {
    markJustOnboarded()
    router.push('/dashboard')
  }, [router])

  // Held in a ref so the auto-advance effect below depends on `phase` alone —
  // depending on the callback would restart the countdown on every unrelated
  // re-render, and a user who never re-renders is not a user we have.
  const goToDashboardRef = useRef(goToDashboard)
  goToDashboardRef.current = goToDashboard

  // Auto-advance off the success state. Timer-driven, not animation-driven, so
  // a reduced-motion visitor (whose check-bloom never plays) still moves on,
  // and the always-visible CTA covers a throttled/background tab where the
  // timer is delayed.
  useEffect(() => {
    if (phase !== 'success') return
    const timer = setTimeout(() => goToDashboardRef.current(), SUCCESS_REDIRECT_MS)
    return () => clearTimeout(timer)
  }, [phase])

  const handleCreatingChange = useCallback((next: boolean) => {
    if (next) creationStartedRef.current = true
    setCreating(next)
  }, [])

  async function handleHybridComplete(args: { accountAddress: `0x${string}` }) {
    setError('')
    updateUser({ safe_address: args.accountAddress, wallet_address: null })
    await refreshUser()
    setPhase('success')
  }

  async function handlePasskeyComplete(args: { safeAddress: `0x${string}` }) {
    setError('')
    updateUser({ safe_address: args.safeAddress, wallet_address: null })
    await refreshUser()
    setPhase('success')
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

  const name = displayName(user)
  const networkName = getChainConfig(selectedChainId).name

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
          {/* #1239: this header is the ONLY page a signed-in user without
              accounts can reach (login auto-redirects here, ProtectedRoute
              bounces every other page back here) — so it must carry the way
              out, or switching accounts requires clearing site data. */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-[var(--v2-ink-3)]">{name}</span>
            <button
              type="button"
              onClick={() => {
                logout()
                router.replace('/login')
              }}
              className="text-xs font-medium text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] transition-colors"
            >
              Log out
            </button>
          </div>
        </div>
      </div>

      <div className="relative z-10 flex-1 flex items-center justify-center px-6 py-16">
        <Card className="w-full max-w-xl p-6" hover={false}>
          {phase === 'create' && (
            <div key="create" className="v2-animate-step-rise space-y-6">
              <div>
                <span className="block text-xs font-medium text-[var(--v2-ink-3)] mb-1.5">
                  Welcome, {name}
                </span>
                <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                  Create your Haven account
                </h1>
                <p className="text-sm text-[var(--v2-ink-2)] leading-relaxed">
                  {creating
                    ? 'Setting up your account. Stay on this tab, it takes a few seconds.'
                    : 'Your face or fingerprint approves everything: budgets, agents, changes. No wallet, no seed phrase, nothing to install.'}
                </p>
              </div>

              <div>
                <label
                  htmlFor="onboarding-network"
                  className="block text-xs font-medium text-[var(--v2-ink-2)] mb-1.5"
                >
                  Network
                </label>
                <Select
                  id="onboarding-network"
                  value={selectedChainId}
                  disabled={creating}
                  onChange={(e) => setSelectedChainId(Number(e.target.value))}
                >
                  {deployableChains.map((chain) => (
                    <option key={chain.chainId} value={chain.chainId}>
                      {chain.name}
                    </option>
                  ))}
                </Select>
              </div>

              {error && (
                <div
                  role="alert"
                  className="rounded-md border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]"
                >
                  {error}
                </div>
              )}

              {delegationOnboarding ? (
                <HybridEnrollFlow
                  user={user}
                  selectedChainId={selectedChainId}
                  onCreatingChange={handleCreatingChange}
                  onComplete={(args) => {
                    void handleHybridComplete(args)
                  }}
                  onError={setError}
                />
              ) : (
                <PasskeyEnrollFlow
                  user={user}
                  selectedChainId={selectedChainId}
                  onCreatingChange={handleCreatingChange}
                  onComplete={(args) => {
                    void handlePasskeyComplete(args)
                  }}
                  onError={setError}
                />
              )}
            </div>
          )}

          {phase === 'success' && (
            <div key="success" className="v2-animate-step-rise">
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
                  {/* Heavier stroke: the 56px success bloom check reads too light at 1.5. */}
                  <Icon icon={Check} className="h-7 w-7 text-[var(--v2-brand)]" strokeWidth={2.4} />
                </div>
              </div>

              <div className="text-center" role="status">
                <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
                  You&apos;re in
                </h1>
                <p className="text-sm text-[var(--v2-ink-2)] mb-8 leading-relaxed">
                  Your Haven account is live on {networkName}. Taking you to your dashboard…
                </p>
              </div>

              <Button onClick={goToDashboard} size="lg" className="w-full">
                Go to dashboard
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
