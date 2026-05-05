'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { SiteHeader } from '@/components/marketing/SiteHeader'
import { SiteFooter } from '@/components/marketing/SiteFooter'

type Phase =
  | 'idle'
  | 'requesting'
  | 'authorize'
  | 'policy'
  | 'sign'
  | 'broadcast'
  | 'confirmed'
  | 'delivered'

interface TimelineEvent {
  step: number
  label: string
  detail?: string
  phase: Phase
}

// Realistic demo payload — Base mainnet USDC payment for a SaaS subscription
const DEMO = {
  resourceUrl: 'https://insightly.example/checkout?item=pro_monthly',
  resourceLabel: 'Insightly Pro — 1 month',
  amount: '29.00',
  token: 'USDC',
  tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  network: 'Base',
  chainId: 8453,
  caip2: 'eip155:8453',
  payTo: '0x4F3ea5d9fE55AAd7F2F00f1eC00cD5BCd8f3bcFc',
  agent: {
    name: 'Ops Agent',
    apiKeyPreview: 'sk_agent_a1b9…7e',
    policy: {
      monthlyLimit: '500 USDC',
      perTxLimit: '100 USDC',
      allowedNetworks: ['Base', 'Gnosis'],
    },
    monthlySpent: '142.50',
    monthlyLimitNum: 500,
  },
  merchant: {
    name: 'Insightly',
    host: 'insightly.example',
    acceptedRails: ['USDC · Base', 'USDC · Gnosis'],
  },
  signHash:
    '0x6c1f4e93a6c1ffde7019a2c5d8b4f16e0a39c7f82bc5d138e40b79aa2c6d9b3a',
  txHash:
    '0x4d8a3b1d2c8f4a60bd5e97c1a4f3b6d29e8c05f14a7b89f3d2c1e4a5b6c7e2f8',
  blockNumber: 14_892_103,
  gasUsed: '41,228',
  steps: [
    { phase: 'requesting', label: 'Agent drafts payment intent' },
    { phase: 'authorize', label: 'Forward to Haven' },
    { phase: 'policy', label: 'Policy evaluation' },
    { phase: 'sign', label: 'Haven signs transfer' },
    { phase: 'broadcast', label: 'Broadcast to Base' },
    { phase: 'confirmed', label: 'On-chain confirmation' },
    { phase: 'delivered', label: 'Merchant fulfils' },
  ] as const,
}

const POLICY_CHECKS: string[] = [
  'Within per-tx limit (100 USDC)',
  `Network ${'Base'} allowed`,
  'On-chain allowance sufficient',
]

function shortHex(s: string, head = 6, tail = 4) {
  return s.length > head + tail + 2 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s
}

const phaseOrder: Phase[] = [
  'idle',
  'requesting',
  'authorize',
  'policy',
  'sign',
  'broadcast',
  'confirmed',
  'delivered',
]
function phaseIndex(p: Phase) {
  return phaseOrder.indexOf(p)
}
function reached(current: Phase, target: Phase) {
  return phaseIndex(current) >= phaseIndex(target)
}

function phaseStep(p: Phase): number {
  const i = DEMO.steps.findIndex((s) => s.phase === p)
  return i < 0 ? 0 : i + 1
}

export default function MPPDemoPage() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [policyProgress, setPolicyProgress] = useState<number>(0)
  const [settled, setSettled] = useState<boolean>(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearTimers = () => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
  }

  useEffect(() => clearTimers, [])

  const run = useCallback(() => {
    clearTimers()
    setTimeline([])
    setPhase('idle')
    setPolicyProgress(0)
    setSettled(false)

    const schedule = (delay: number, fn: () => void) => {
      timers.current.push(setTimeout(fn, delay))
    }
    const push = (ev: Omit<TimelineEvent, 'step'>) => {
      setTimeline((prev) => [...prev, { ...ev, step: phaseStep(ev.phase) }])
    }

    let t = 0

    // 1. Agent drafts payment intent
    t += 400
    schedule(t, () => {
      setPhase('requesting')
      push({
        phase: 'requesting',
        label: 'Agent drafted payment intent',
        detail: `${DEMO.resourceLabel} • ${DEMO.amount} ${DEMO.token} → ${shortHex(DEMO.payTo)}`,
      })
    })

    // 2. Agent forwards intent to Haven
    t += 1100
    schedule(t, () => {
      setPhase('authorize')
      push({
        phase: 'authorize',
        label: 'Agent forwarded intent to Haven',
        detail: `POST /mpp/authorize • ${DEMO.agent.apiKeyPreview}`,
      })
    })

    // 3. Haven policy engine evaluates — staggered ticks
    const policyStart = t + 500
    schedule(policyStart, () => {
      setPhase('policy')
      push({
        phase: 'policy',
        label: 'Policy engine evaluating intent',
        detail: 'Per-tx limit, network allowlist, on-chain allowance',
      })
    })
    for (let i = 1; i <= POLICY_CHECKS.length; i++) {
      schedule(policyStart + i * 300, () => setPolicyProgress(i))
    }
    t += 500 + 300 * POLICY_CHECKS.length + 300

    // 4. Sign
    schedule(t, () => {
      setPhase('sign')
      push({
        phase: 'sign',
        label: 'Policy cleared — delegate signed transfer',
        detail: `Remaining this month: ${(DEMO.agent.monthlyLimitNum - parseFloat(DEMO.agent.monthlySpent) - parseFloat(DEMO.amount)).toFixed(2)} ${DEMO.token} • ${shortHex(DEMO.signHash, 8, 6)}`,
      })
    })

    // 5. Broadcast
    t += 900
    schedule(t, () => {
      setPhase('broadcast')
      push({
        phase: 'broadcast',
        label: 'Allowance transfer submitted to Base',
        detail: 'Safe → ERC-20 transfer via AllowanceModule',
      })
    })

    // 6. Confirmed on Base
    t += 1600
    schedule(t, () => {
      setPhase('confirmed')
      push({
        phase: 'confirmed',
        label: `Confirmed in block ${DEMO.blockNumber.toLocaleString()}`,
        detail: `tx ${shortHex(DEMO.txHash, 10, 8)} • gas ${DEMO.gasUsed}`,
      })
    })

    // 7. Merchant verifies receipt + fulfils
    t += 1400
    schedule(t, () => {
      setPhase('delivered')
      push({
        phase: 'delivered',
        label: 'Merchant verified receipt — access granted',
        detail: `200 OK • ${DEMO.resourceLabel}`,
      })
    })

    // 8. Settle — stop the delivery arrow from pulsing
    t += 1200
    schedule(t, () => setSettled(true))
  }, [])

  const isRunning = phase !== 'idle' && phase !== 'delivered'
  const isDone = phase === 'delivered'
  const currentStep = DEMO.steps.findIndex((s) => s.phase === phase)

  return (
    <div className="bg-[#0a0a0a] text-[#ededed] min-h-screen overflow-x-hidden">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(139,92,246,0.18) 0%, transparent 70%)',
        }}
      />

      <SiteHeader />

      {/* Hero */}
      <section className="relative max-w-6xl mx-auto px-6 pt-16 pb-10 z-10">
        <div className="inline-flex items-center gap-2 mb-6 px-3 py-1 rounded-full border border-violet-500/30 bg-violet-500/10 text-violet-300 text-xs font-medium">
          How Stripe MPP works
        </div>
        <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-[1.05] mb-4 max-w-3xl">
          <span className="bg-gradient-to-br from-white via-white to-violet-200 bg-clip-text text-transparent">
            Watch an AI agent
          </span>
          <br />
          <span className="bg-gradient-to-br from-white via-violet-100 to-fuchsia-300 bg-clip-text text-transparent">
            check out in stablecoins.
          </span>
        </h1>
        <p className="text-base md:text-lg text-zinc-400 leading-relaxed max-w-2xl">
          An agent subscribes to a SaaS tool. Haven validates the intent
          against your policy and settles the payment in USDC straight from
          your Safe — one open standard, no proprietary checkout, no card
          details in agent memory.
        </p>
      </section>

      {/* What is MPP */}
      <section className="relative max-w-6xl mx-auto px-6 pb-10 z-10">
        <div className="flex items-baseline gap-4 mb-6">
          <span className="text-xs font-mono bg-gradient-to-r from-violet-400 to-fuchsia-400 bg-clip-text text-transparent">
            [what is mpp]
          </span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">
            The standard
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr] gap-6 items-start">
          <div className="space-y-4 text-sm md:text-[15px] text-zinc-400 leading-relaxed">
            <p>
              <span className="text-zinc-200 font-medium">Stripe MPP</span> — the{' '}
              <span className="text-zinc-300">Machine Payments Protocol</span> —
              is an open standard for agent-initiated payments across rails.
              It's payment-agnostic: the same protocol can settle directly{' '}
              <span className="text-zinc-300">on-chain in stablecoins</span>, or
              carry traditional methods (cards, wallets, BNPL) via Stripe{' '}
              <span className="font-mono text-zinc-300">Shared Payment Tokens</span>.
              Where x402 covers the HTTP 402 paywall case, MPP covers the
              broader checkout — subscriptions, one-off purchases, anything an
              agent and a merchant need to coordinate.
            </p>
            <p>
              Haven implements the stablecoin path of MPP today. Agents settle
              USDC directly to merchants from your Safe, gated by the same
              allowance, approval, and audit model that wraps x402. SPT-backed
              fiat rails — cards, wallets, BNPL — are on the roadmap. Either
              way the agent never touches keys or card numbers, and you keep
              one policy across every payment.
            </p>
          </div>
          <div className="bg-[#0b0b0f] border border-white/[0.06] rounded-md p-5">
            <div className="text-[11px] text-zinc-500 uppercase tracking-wider mb-4">
              The protocol in 3 lines
            </div>
            <ol className="space-y-3 text-sm">
              <li className="flex items-start gap-3">
                <span className="text-[11px] font-mono text-violet-300 tabular-nums mt-0.5">01</span>
                <div>
                  <div className="text-zinc-200">Intent → authorization</div>
                  <div className="text-xs text-zinc-500">Haven evaluates against policy.</div>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-[11px] font-mono text-violet-300 tabular-nums mt-0.5">02</span>
                <div>
                  <div className="text-zinc-200">Present → pay</div>
                  <div className="text-xs text-zinc-500">Stablecoin transfer or scoped fiat credential.</div>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-[11px] font-mono text-violet-300 tabular-nums mt-0.5">03</span>
                <div>
                  <div className="text-zinc-200">Capture → fulfil</div>
                  <div className="text-xs text-zinc-500">Merchant confirms, fulfils, Haven logs.</div>
                </div>
              </li>
            </ol>
            <div className="mt-5 pt-4 border-t border-white/[0.06] text-[11px] text-zinc-500 leading-relaxed">
              Haven supports the <span className="text-violet-300">stablecoin</span> path
              today. SPT-backed fiat rails coming next.
            </div>
          </div>
        </div>
      </section>

      {/* Stage */}
      <section className="relative max-w-6xl mx-auto px-6 pb-6 z-10">
        <div className="mb-6 max-w-3xl">
          <p className="text-sm md:text-[15px] text-zinc-400 leading-relaxed">
            Below is one MPP payment in motion: an Ops Agent subscribing to an
            analytics dashboard for 29 USDC on Base. Four actors take part —
            agent, merchant, Haven, and the chain that settles.
          </p>
        </div>
        <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-3">
          {(['agent', 'merchant', 'haven', 'chain'] as const).map((kind) => {
            const cfg = COLUMN_CONFIG[kind]
            const role =
              kind === 'agent'
                ? 'The AI making the purchase'
                : kind === 'merchant'
                ? 'Accepts MPP stablecoin'
                : kind === 'haven'
                ? 'Policy engine + Safe signer'
                : 'The settlement chain'
            return (
              <div
                key={kind}
                className="flex items-center gap-2.5 px-3 py-2 rounded-md border border-white/[0.06] bg-[#0b0b0f]/60"
              >
                <div
                  className={`w-6 h-6 rounded bg-gradient-to-br ${cfg.iconGradient} flex items-center justify-center flex-shrink-0`}
                >
                  {cfg.icon}
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] text-zinc-500 uppercase tracking-wider">
                    {cfg.kicker}
                  </div>
                  <div className="text-xs text-zinc-300 truncate">{role}</div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Payment-flow canvas */}
        <div className="border border-white/[0.06] rounded-lg bg-[#0a0a0f]/40 p-5 md:p-7">
          <div className="flex items-center justify-between mb-5 gap-3">
            <div className="flex items-baseline gap-3 min-w-0">
              <span className="text-xs font-mono bg-gradient-to-r from-violet-400 to-fuchsia-400 bg-clip-text text-transparent">
                [flow]
              </span>
              <h3 className="text-sm font-medium text-zinc-200 truncate">
                MPP stablecoin payment flow
              </h3>
            </div>
            <div
              className={`shrink-0 inline-flex items-center gap-2 px-2.5 py-1 rounded border text-[11px] font-mono transition-colors ${
                isRunning
                  ? 'border-violet-400/50 bg-violet-500/10 text-violet-200'
                  : isDone
                  ? 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-300'
                  : 'border-white/[0.08] text-zinc-500'
              }`}
            >
              {isRunning && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-violet-400" />
                </span>
              )}
              <span className="tabular-nums">
                {isRunning
                  ? `Step ${currentStep + 1} / ${DEMO.steps.length} — ${DEMO.steps[currentStep].label}`
                  : isDone
                  ? `Complete · ${DEMO.steps.length} / ${DEMO.steps.length}`
                  : 'Idle'}
              </span>
            </div>
          </div>

          {/* 2x2 actor grid with arrows */}
          <div
            className="grid gap-0"
            style={{
              gridTemplateColumns: '1fr 72px 1fr',
              gridTemplateRows: 'auto 72px auto',
            }}
          >
            {/* Row 1: Agent — [H arrow] — Merchant */}
            <div className="row-start-1 col-start-1">
              <StageColumn
                kind="agent"
                phase={phase}
                active={
                  phase === 'requesting' ||
                  phase === 'authorize' ||
                  (phase === 'delivered' && !settled)
                }
              />
            </div>
            <div className="row-start-1 col-start-2 flex items-center justify-center">
              <FlowArrow
                orientation="horizontal"
                reverse={phase === 'delivered'}
                active={
                  phase === 'requesting' ||
                  (phase === 'delivered' && !settled)
                }
                done={reached(phase, 'requesting')}
                color={reached(phase, 'delivered') ? 'emerald' : 'violet'}
                label={
                  phase === 'requesting'
                    ? 'intent'
                    : phase === 'delivered' && !settled
                    ? '200 OK'
                    : undefined
                }
              />
            </div>
            <div className="row-start-1 col-start-3">
              <StageColumn
                kind="merchant"
                phase={phase}
                active={
                  phase === 'requesting' ||
                  (phase === 'delivered' && !settled)
                }
              />
            </div>

            {/* Row 2: [V arrow] — empty — [V arrow] */}
            <div className="row-start-2 col-start-1 flex items-center justify-center">
              <FlowArrow
                orientation="vertical"
                reverse={false}
                active={phase === 'authorize'}
                done={reached(phase, 'policy')}
                color="violet"
                label={phase === 'authorize' ? 'authorize' : undefined}
              />
            </div>
            <div className="row-start-2 col-start-2" />
            <div className="row-start-2 col-start-3 flex items-center justify-center">
              <FlowArrow
                orientation="vertical"
                reverse
                active={phase === 'delivered' && !settled}
                done={reached(phase, 'delivered')}
                color={reached(phase, 'delivered') ? 'emerald' : 'violet'}
                label={phase === 'delivered' && !settled ? 'receipt' : undefined}
              />
            </div>

            {/* Row 3: Haven — [H arrow] — Chain */}
            <div className="row-start-3 col-start-1">
              <StageColumn
                kind="haven"
                phase={phase}
                active={phase === 'policy' || phase === 'sign'}
                policyProgress={policyProgress}
              />
            </div>
            <div className="row-start-3 col-start-2 flex items-center justify-center">
              <FlowArrow
                orientation="horizontal"
                reverse={false}
                active={phase === 'broadcast'}
                done={reached(phase, 'confirmed')}
                color="violet"
                label={phase === 'broadcast' ? 'submit tx' : undefined}
              />
            </div>
            <div className="row-start-3 col-start-3">
              <StageColumn
                kind="chain"
                phase={phase}
                active={phase === 'broadcast' || phase === 'confirmed'}
              />
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {!isRunning && !isDone && (
            <button
              onClick={run}
              className="group px-5 py-2.5 rounded-md bg-gradient-to-r from-violet-500 to-fuchsia-600 text-white text-sm font-medium hover:from-violet-400 hover:to-fuchsia-500 transition-all shadow-lg shadow-violet-500/25 inline-flex items-center gap-2"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M6 4l10 6-10 6V4z" />
              </svg>
              Run payment flow
            </button>
          )}
          {isRunning && (
            <button
              disabled
              className="px-5 py-2.5 rounded-md bg-white/[0.06] text-zinc-500 text-sm font-medium inline-flex items-center gap-2 cursor-not-allowed"
            >
              <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
              Settling payment…
            </button>
          )}
          {isDone && (
            <button
              onClick={run}
              className="px-5 py-2.5 rounded-md bg-gradient-to-r from-violet-500 to-fuchsia-600 text-white text-sm font-medium hover:from-violet-400 hover:to-fuchsia-500 transition-all shadow-lg shadow-violet-500/25 inline-flex items-center gap-2"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              Run again
            </button>
          )}
        </div>
      </section>

      {/* Timeline */}
      <section className="relative max-w-6xl mx-auto px-6 py-10 z-10">
        <div className="flex items-baseline gap-4 mb-6">
          <span className="text-xs font-mono bg-gradient-to-r from-violet-400 to-fuchsia-400 bg-clip-text text-transparent">
            [timeline]
          </span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">
            Execution trace
          </h2>
        </div>
        <div className="border border-white/[0.06] rounded-md bg-[#0b0b0f]/60">
          {timeline.length === 0 && (
            <div className="p-6 text-sm text-zinc-600 font-mono">
              <span className="text-zinc-700">$</span> awaiting payment intent…
            </div>
          )}
          <ol className="divide-y divide-white/[0.04]">
            {timeline.map((ev, i) => (
              <li
                key={i}
                className="flex items-start gap-4 px-5 py-3.5 font-mono text-sm animate-[fadeInUp_0.25s_ease-out]"
              >
                <span className="text-zinc-500 shrink-0 w-10 tabular-nums">
                  {ev.step.toString().padStart(2, '0')}.
                </span>
                <span
                  className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${phaseDotColor(ev.phase)}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-zinc-200">{ev.label}</div>
                  {ev.detail && (
                    <div className="text-xs text-zinc-500 mt-0.5 truncate">
                      {ev.detail}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* CTA */}
      <section className="relative max-w-6xl mx-auto px-6 py-16 text-center z-10">
        <div
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-[400px]"
          style={{
            background:
              'radial-gradient(ellipse 60% 80% at 50% 50%, rgba(139,92,246,0.12) 0%, rgba(217,70,239,0.06) 40%, transparent 70%)',
          }}
        />
        <div className="relative">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-4">
            <span className="bg-gradient-to-br from-white to-violet-200 bg-clip-text text-transparent">
              One policy. Open standards. Stablecoin settlement.
            </span>
          </h2>
          <p className="text-zinc-500 text-sm mb-8">
            Same allowance model as x402. No proprietary checkout in the way.
          </p>
          <Link
            href="/signup"
            className="inline-block px-6 py-3 rounded-md bg-gradient-to-r from-violet-500 to-fuchsia-600 text-white text-sm font-medium hover:from-violet-400 hover:to-fuchsia-500 transition-all shadow-xl shadow-violet-500/30"
          >
            Get Early Access
          </Link>
        </div>
      </section>

      <style jsx global>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes bounce {
          0%, 100% { transform: translateY(0); opacity: 0.4; }
          50% { transform: translateY(-2px); opacity: 1; }
        }
        @keyframes flowDotH {
          0% { left: 0; opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { left: calc(100% - 0.5rem); opacity: 0; }
        }
        @keyframes flowDotV {
          0% { top: 0; opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { top: calc(100% - 0.5rem); opacity: 0; }
        }
        @keyframes cardPulse {
          0%, 100% { box-shadow: inset 0 0 0 1px rgba(139,92,246,0.25); }
          50% { box-shadow: inset 0 0 0 1px rgba(139,92,246,0.55); }
        }
      `}</style>

      <SiteFooter />
    </div>
  )
}

// ─── Stage column ─────────────────────────────────────────────────

function StageColumn({
  kind,
  phase,
  active,
  policyProgress = 0,
}: {
  kind: 'agent' | 'haven' | 'chain' | 'merchant'
  phase: Phase
  active: boolean
  policyProgress?: number
}) {
  const config = COLUMN_CONFIG[kind]
  return (
    <div
      className={`relative bg-[#0b0b0f] border rounded-md p-5 h-full transition-all duration-300 ${
        active
          ? 'border-violet-400/70 shadow-[0_0_60px_-6px_rgba(139,92,246,0.55)] ring-1 ring-violet-400/30'
          : 'border-white/[0.06]'
      }`}
    >
      {active && (
        <>
          <div className="absolute -top-px inset-x-4 h-px bg-gradient-to-r from-transparent via-violet-400 to-transparent" />
          <div
            className="pointer-events-none absolute inset-0 rounded-md"
            style={{ animation: 'cardPulse 2s ease-in-out infinite' }}
          />
          <div className="absolute top-3 right-3 flex items-center gap-1.5 text-[10px] font-mono text-violet-200 z-10 px-1.5 py-0.5 rounded border border-violet-400/40 bg-violet-500/15">
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-violet-400" />
            </span>
            <span className="tabular-nums text-violet-300">{phaseStep(phase)}</span>
            <span className="text-violet-100/90">{DEMO.steps[Math.max(0, phaseStep(phase) - 1)]?.label}</span>
          </div>
        </>
      )}
      <div className="flex items-center gap-2 mb-4">
        <div
          className={`w-7 h-7 rounded-md bg-gradient-to-br ${config.iconGradient} flex items-center justify-center flex-shrink-0`}
        >
          {config.icon}
        </div>
        <div className="min-w-0">
          <div className="text-[11px] text-zinc-500 uppercase tracking-wider">
            {config.kicker}
          </div>
          <div className="text-sm font-medium text-zinc-100 truncate">
            {config.title}
          </div>
        </div>
      </div>

      {kind === 'agent' && <AgentContent phase={phase} />}
      {kind === 'merchant' && <MerchantContent phase={phase} />}
      {kind === 'haven' && <HavenContent phase={phase} policyProgress={policyProgress} />}
      {kind === 'chain' && <ChainContent phase={phase} />}
    </div>
  )
}

const COLUMN_CONFIG = {
  agent: {
    kicker: 'Client',
    title: DEMO.agent.name,
    iconGradient: 'from-sky-500 to-violet-600',
    icon: (
      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
      </svg>
    ),
  },
  merchant: {
    kicker: 'Merchant',
    title: DEMO.merchant.name,
    iconGradient: 'from-amber-500 to-orange-600',
    icon: (
      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
      </svg>
    ),
  },
  haven: {
    kicker: 'Policy engine',
    title: 'Haven',
    iconGradient: 'from-violet-500 to-fuchsia-600',
    icon: (
      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
  },
  chain: {
    kicker: 'Settlement',
    title: 'Base',
    iconGradient: 'from-fuchsia-500 to-pink-600',
    icon: (
      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5.25-1.5a3.75 3.75 0 01-7.5 0" />
      </svg>
    ),
  },
} as const

function AgentContent({ phase }: { phase: Phase }) {
  const hasIntent = reached(phase, 'requesting')
  const isDelivered = reached(phase, 'delivered')
  const isWaiting = reached(phase, 'authorize') && !isDelivered

  const subtext =
    phase === 'idle'
      ? 'Ready to subscribe to Insightly Pro.'
      : !hasIntent
      ? 'Drafting payment intent…'
      : isDelivered
      ? 'Subscription active. Receipt logged.'
      : isWaiting
      ? 'Asked Haven to settle on-chain.'
      : 'Forwarding intent to Haven.'

  return (
    <div className="space-y-3">
      <div className="text-xs text-zinc-500 leading-relaxed">{subtext}</div>

      {hasIntent && (
        <div className="rounded border border-white/[0.06] bg-black/30 p-3 font-mono text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500 shrink-0">→</span>
            <span className="text-zinc-400 truncate">pay {DEMO.amount} {DEMO.token} on {DEMO.network}</span>
            {!isDelivered && (
              <span className="ml-auto inline-flex gap-1">
                <span className="w-1 h-1 rounded-full bg-zinc-500" style={{ animation: 'bounce 1s ease-in-out infinite' }} />
                <span className="w-1 h-1 rounded-full bg-zinc-500" style={{ animation: 'bounce 1s ease-in-out 0.15s infinite' }} />
                <span className="w-1 h-1 rounded-full bg-zinc-500" style={{ animation: 'bounce 1s ease-in-out 0.3s infinite' }} />
              </span>
            )}
          </div>
        </div>
      )}

      {isDelivered && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] p-3 font-mono text-[11px] animate-[fadeInUp_0.3s_ease-out]">
          <div className="flex items-center gap-2 text-emerald-300">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />
            </svg>
            ← 200 OK • access granted
          </div>
          <div className="text-zinc-500 mt-1">{DEMO.resourceLabel}</div>
        </div>
      )}

      {isWaiting && !isDelivered && (
        <div className="text-[11px] text-zinc-500 font-mono flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
          waiting for Haven to settle…
        </div>
      )}

      <div className="text-[11px] text-zinc-600">
        API key <span className="text-zinc-400 font-mono">{DEMO.agent.apiKeyPreview}</span>
      </div>
    </div>
  )
}

function MerchantContent({ phase }: { phase: Phase }) {
  const hasIntent = reached(phase, 'requesting')
  const isDelivered = reached(phase, 'delivered')
  const awaitingProof =
    reached(phase, 'authorize') && !isDelivered

  const subtext =
    phase === 'idle'
      ? 'MPP merchant — accepts USDC on Base / Gnosis.'
      : !hasIntent
      ? 'Listening for payment intents…'
      : isDelivered
      ? 'Verified on-chain receipt — granting access.'
      : awaitingProof
      ? 'Awaiting on-chain settlement…'
      : 'Quoted price to agent.'

  return (
    <div className="space-y-3">
      <div className="text-xs text-zinc-500 leading-relaxed">{subtext}</div>

      {hasIntent && !isDelivered && (
        <div className="rounded border border-violet-500/30 bg-violet-500/[0.06] p-3 font-mono text-[11px] animate-[fadeInUp_0.3s_ease-out]">
          <div className="text-violet-300">→ MPP quote</div>
          <div className="text-zinc-500 mt-1">
            pay {DEMO.amount} {DEMO.token} → {shortHex(DEMO.payTo)}
          </div>
          <div className="text-zinc-600 mt-0.5">accepts: {DEMO.merchant.acceptedRails.join(' · ')}</div>
        </div>
      )}

      {isDelivered && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] p-3 font-mono text-[11px] animate-[fadeInUp_0.3s_ease-out]">
          <div className="flex items-center gap-2 text-emerald-300">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />
            </svg>
            paid · seat granted
          </div>
          <div className="text-zinc-500 mt-1">{DEMO.merchant.host}</div>
        </div>
      )}

      <div className="text-[11px] text-zinc-600">
        price <span className="text-zinc-400 font-mono">{DEMO.amount} {DEMO.token} / mo</span>
      </div>
    </div>
  )
}

function HavenContent({
  phase,
  policyProgress,
}: {
  phase: Phase
  policyProgress: number
}) {
  const inPolicy = phase === 'policy'
  const afterPolicy = reached(phase, 'sign')

  function checkStatus(i: number): 'pass' | 'pending' | 'idle' {
    if (afterPolicy) return 'pass'
    if (!inPolicy) return 'idle'
    if (policyProgress > i) return 'pass'
    if (policyProgress === i) return 'pending'
    return 'idle'
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-zinc-500 leading-relaxed">
        Evaluating intent against the agent policy.
      </div>
      <ul className="space-y-1.5">
        {POLICY_CHECKS.map((label, i) => {
          const status = checkStatus(i)
          return (
            <li
              key={label}
              className="flex items-center gap-2 text-[11px] transition-colors duration-200"
            >
              <PolicyDot status={status} />
              <span
                className={
                  status === 'pass'
                    ? 'text-zinc-300'
                    : status === 'pending'
                    ? 'text-zinc-400'
                    : 'text-zinc-600'
                }
              >
                {label}
              </span>
            </li>
          )
        })}
      </ul>
      {afterPolicy && (
        <div className="rounded border border-violet-500/30 bg-violet-500/[0.06] p-2.5 font-mono text-[11px] text-violet-200 animate-[fadeInUp_0.3s_ease-out]">
          sign_hash {shortHex(DEMO.signHash, 8, 6)}
        </div>
      )}
    </div>
  )
}

function ChainContent({ phase }: { phase: Phase }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-zinc-500 leading-relaxed">
        Safe executes allowance transfer via AllowanceModule.
      </div>
      {!reached(phase, 'broadcast') && (
        <div className="rounded border border-white/[0.06] bg-black/30 p-3 text-[11px] text-zinc-600">
          awaiting submission
        </div>
      )}
      {reached(phase, 'broadcast') && !reached(phase, 'confirmed') && (
        <div className="rounded border border-fuchsia-500/30 bg-fuchsia-500/[0.05] p-3 font-mono text-[11px] text-fuchsia-200">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400 animate-pulse" />
            pending on mempool…
          </div>
          <div className="text-fuchsia-300/60 mt-1">{shortHex(DEMO.txHash, 8, 6)}</div>
        </div>
      )}
      {reached(phase, 'confirmed') && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] p-3 font-mono text-[11px] text-emerald-200 animate-[fadeInUp_0.3s_ease-out]">
          <div className="flex items-center gap-2">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />
            </svg>
            confirmed
          </div>
          <div className="text-emerald-300/70 mt-1 truncate">{shortHex(DEMO.txHash, 10, 8)}</div>
          <div className="text-emerald-300/50 mt-0.5">
            block {DEMO.blockNumber.toLocaleString()} • {DEMO.gasUsed} gas
          </div>
        </div>
      )}
    </div>
  )
}

function PolicyDot({ status }: { status: 'pass' | 'pending' | 'idle' }) {
  if (status === 'pass') {
    return (
      <svg className="w-3 h-3 text-emerald-400 shrink-0 animate-[fadeInUp_0.2s_ease-out]" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />
      </svg>
    )
  }
  if (status === 'pending') {
    return (
      <span className="w-2.5 h-2.5 rounded-full border-2 border-zinc-500 border-t-violet-400 animate-spin shrink-0" />
    )
  }
  return <span className="w-2.5 h-2.5 rounded-full border border-zinc-700 shrink-0" />
}

function phaseDotColor(p: Phase) {
  switch (p) {
    case 'requesting':
      return 'bg-sky-400'
    case 'authorize':
    case 'policy':
    case 'sign':
      return 'bg-violet-400'
    case 'broadcast':
      return 'bg-fuchsia-400'
    case 'confirmed':
    case 'delivered':
      return 'bg-emerald-400'
    default:
      return 'bg-zinc-600'
  }
}

// ─── Flow arrow ───────────────────────────────────────────────────

function FlowArrow({
  orientation,
  reverse,
  active,
  done,
  color = 'violet',
  label,
}: {
  orientation: 'horizontal' | 'vertical'
  reverse: boolean
  active: boolean
  done: boolean
  color?: 'violet' | 'emerald'
  label?: string
}) {
  const isH = orientation === 'horizontal'
  const palette =
    color === 'emerald'
      ? {
          line: 'bg-gradient-to-r from-emerald-500/30 via-emerald-400 to-emerald-500/30',
          lineV: 'bg-gradient-to-b from-emerald-500/30 via-emerald-400 to-emerald-500/30',
          dot: 'bg-emerald-400',
          shadow: 'shadow-[0_0_12px_rgba(52,211,153,0.8)]',
          label: 'text-emerald-300',
        }
      : {
          line: 'bg-gradient-to-r from-violet-500/30 via-violet-400 to-violet-500/30',
          lineV: 'bg-gradient-to-b from-violet-500/30 via-violet-400 to-violet-500/30',
          dot: 'bg-violet-400',
          shadow: 'shadow-[0_0_12px_rgba(139,92,246,0.8)]',
          label: 'text-violet-300',
        }

  return (
    <div
      className={`relative flex items-center justify-center ${
        isH ? 'w-full h-12' : 'h-full w-12'
      }`}
    >
      <div
        className={`${
          isH
            ? `h-px w-full ${done ? palette.line : 'bg-white/[0.08]'}`
            : `w-px h-full ${done ? palette.lineV : 'bg-white/[0.08]'}`
        } transition-colors duration-300`}
      />

      {active && (
        <span
          className={`absolute w-2 h-2 rounded-full ${palette.dot} ${palette.shadow}`}
          style={
            isH
              ? {
                  top: '50%',
                  transform: 'translateY(-50%)',
                  animation: 'flowDotH 0.9s ease-in-out infinite',
                  animationDirection: reverse ? 'reverse' : 'normal',
                }
              : {
                  left: '50%',
                  transform: 'translateX(-50%)',
                  animation: 'flowDotV 0.9s ease-in-out infinite',
                  animationDirection: reverse ? 'reverse' : 'normal',
                }
          }
        />
      )}

      {label && active && (
        <span
          className={`absolute ${
            isH ? 'top-full mt-1' : 'left-full ml-2'
          } text-[10px] font-mono ${palette.label} whitespace-nowrap animate-[fadeInUp_0.25s_ease-out]`}
        >
          {label}
        </span>
      )}
    </div>
  )
}
