'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'

type Phase =
  | 'idle'
  | 'requesting'
  | 'challenged'
  | 'authorize'
  | 'policy'
  | 'sign'
  | 'broadcast'
  | 'confirmed'
  | 'delivered'

interface TimelineEvent {
  label: string
  detail?: string
  elapsedMs: number
  phase: Phase
}

// Realistic demo payload — Base mainnet USDC transfer for a premium API call
const DEMO = {
  resourceUrl: 'https://api.research.example/query?q=sector+analysis+2026',
  resourceLabel: 'Premium research API',
  amount: '0.05',
  token: 'USDC',
  tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  network: 'Base',
  chainId: 8453,
  caip2: 'eip155:8453',
  payTo: '0x4F3ea5d9fE55AAd7F2F00f1eC00cD5BCd8f3bcFc',
  agent: {
    name: 'Research Agent',
    apiKeyPreview: 'sk_agent_d4c8…9f',
    policy: {
      dailyLimit: '50 USDC',
      perTxLimit: '1 USDC',
      approvalThreshold: '1 USDC',
      allowedCategories: ['api_access', 'data'],
      allowedNetworks: ['Base', 'Gnosis'],
    },
    dailySpent: '3.25',
    dailyLimitNum: 50,
  },
  signHash:
    '0x8b2f4e93a6c1ffde7019a2c5d8b4f16e0a39c7f82bc5d138e40b79aa2c6d4e8f',
  txHash:
    '0x7a9e3b1d2c8f4a60bd5e97c1a4f3b6d29e8c05f14a7b89f3d2c1e4a5b6c7d8e9',
  blockNumber: 14_892_103,
  gasUsed: '41,228',
  steps: [
    { phase: 'requesting', label: 'Agent requests data' },
    { phase: 'challenged', label: 'Server returns 402' },
    { phase: 'authorize', label: 'Forward to Haven' },
    { phase: 'policy', label: 'Policy evaluation' },
    { phase: 'sign', label: 'Safe signs transfer' },
    { phase: 'broadcast', label: 'Broadcast to Base' },
    { phase: 'confirmed', label: 'On-chain confirmation' },
    { phase: 'delivered', label: 'Data delivered' },
  ] as const,
}

function shortHex(s: string, head = 6, tail = 4) {
  return s.length > head + tail + 2 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s
}

const phaseOrder: Phase[] = [
  'idle',
  'requesting',
  'challenged',
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

export default function X402DemoPage() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const startRef = useRef<number>(0)
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
    startRef.current = Date.now()

    const schedule = (delay: number, fn: () => void) => {
      timers.current.push(setTimeout(fn, delay))
    }
    const push = (ev: Omit<TimelineEvent, 'elapsedMs'>) => {
      setTimeline((prev) => [
        ...prev,
        { ...ev, elapsedMs: Date.now() - startRef.current },
      ])
    }

    let t = 0

    // 1. Agent sends GET to paywalled API
    t += 200
    schedule(t, () => {
      setPhase('requesting')
      push({
        phase: 'requesting',
        label: 'Agent requested premium research data',
        detail: `GET ${DEMO.resourceUrl}`,
      })
    })

    // 2. Server responds with 402
    t += 700
    schedule(t, () => {
      setPhase('challenged')
      push({
        phase: 'challenged',
        label: 'Server responded 402 Payment Required',
        detail: `${DEMO.amount} ${DEMO.token} on ${DEMO.network} → ${shortHex(DEMO.payTo)}`,
      })
    })

    // 3. Agent forwards challenge to Haven
    t += 600
    schedule(t, () => {
      setPhase('authorize')
      push({
        phase: 'authorize',
        label: 'Agent forwarded challenge to Haven',
        detail: `POST /x402/authorize • ${DEMO.agent.apiKeyPreview}`,
      })
    })

    // 4. Haven policy engine evaluates
    t += 400
    schedule(t, () => {
      setPhase('policy')
      push({
        phase: 'policy',
        label: 'Policy engine evaluating intent',
        detail: 'Per-tx limit, approval threshold, network allowlist, on-chain allowance',
      })
    })

    // 5. Policy cleared — move to signing
    t += 900
    schedule(t, () => {
      setPhase('sign')
      push({
        phase: 'sign',
        label: 'Policy cleared — delegate signed transfer hash',
        detail: `Remaining today: ${(DEMO.agent.dailyLimitNum - parseFloat(DEMO.agent.dailySpent) - parseFloat(DEMO.amount)).toFixed(2)} ${DEMO.token} • ${shortHex(DEMO.signHash, 8, 6)}`,
      })
    })

    // 6. Broadcast
    t += 500
    schedule(t, () => {
      setPhase('broadcast')
      push({
        phase: 'broadcast',
        label: 'Allowance transfer submitted to Base',
        detail: 'Safe → ERC-20 transfer via AllowanceModule',
      })
    })

    // 7. Confirmed on Base
    t += 1200
    schedule(t, () => {
      setPhase('confirmed')
      push({
        phase: 'confirmed',
        label: `Confirmed in block ${DEMO.blockNumber.toLocaleString()}`,
        detail: `tx ${shortHex(DEMO.txHash, 10, 8)} • gas ${DEMO.gasUsed}`,
      })
    })

    // 8. Agent retries with proof, server delivers data
    t += 500
    schedule(t, () => {
      setPhase('delivered')
      push({
        phase: 'delivered',
        label: 'Agent retried with proof — data delivered',
        detail: `200 OK • ${DEMO.resourceLabel}`,
      })
    })
  }, [])

  const isRunning = phase !== 'idle' && phase !== 'delivered'
  const isDone = phase === 'delivered'
  const currentStep = DEMO.steps.findIndex((s) => s.phase === phase)

  return (
    <div className="bg-[#0a0a0a] text-[#ededed] min-h-screen overflow-x-hidden">
      {/* Top gradient wash */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.18) 0%, transparent 70%)',
        }}
      />

      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-white/[0.06] backdrop-blur-md bg-[#0a0a0a]/80">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link
            href="/"
            className="text-[15px] font-semibold tracking-tight bg-gradient-to-r from-white to-indigo-200 bg-clip-text text-transparent"
          >
            Haven
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="text-sm text-zinc-500 hover:text-[#ededed] transition-colors"
            >
              ← Back
            </Link>
            <Link
              href="/signup"
              className="text-sm px-4 py-1.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white font-medium hover:from-indigo-400 hover:to-violet-500 transition-all shadow-lg shadow-indigo-500/20"
            >
              Get Early Access
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative max-w-6xl mx-auto px-6 pt-16 pb-10 z-10">
        <div className="inline-flex items-center gap-2 mb-6 px-3 py-1 rounded-full border border-indigo-500/30 bg-indigo-500/10 text-indigo-300 text-xs font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
          Live x402 payment demo
        </div>
        <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-[1.05] mb-4 max-w-3xl">
          <span className="bg-gradient-to-br from-white via-white to-indigo-200 bg-clip-text text-transparent">
            Watch an AI agent
          </span>
          <br />
          <span className="bg-gradient-to-br from-white via-indigo-100 to-violet-300 bg-clip-text text-transparent">
            pay the internet.
          </span>
        </h1>
        <p className="text-base md:text-lg text-zinc-400 leading-relaxed max-w-2xl">
          An agent encounters an HTTP 402. Haven evaluates the payment against its
          policy, signs from the Safe, and settles on Base — all before the agent's
          retry finishes.
        </p>
      </section>

      {/* Stage */}
      <section className="relative max-w-6xl mx-auto px-6 pb-6 z-10">
        {/* Step ribbon */}
        <div className="mb-5 flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
          {DEMO.steps.map((s, i) => {
            const stepReached = reached(phase, s.phase as Phase)
            const isCurrent = i === currentStep
            return (
              <div key={s.phase} className="flex items-center gap-1.5">
                <span
                  className={`px-2 py-1 rounded border transition-colors duration-200 ${
                    isCurrent
                      ? 'border-indigo-400/60 bg-indigo-500/10 text-indigo-200'
                      : stepReached
                      ? 'border-emerald-500/30 bg-emerald-500/[0.04] text-emerald-300/70'
                      : 'border-white/[0.06] text-zinc-600'
                  }`}
                >
                  <span className="tabular-nums">{i + 1}.</span> {s.label}
                </span>
                {i < DEMO.steps.length - 1 && (
                  <span className={stepReached ? 'text-indigo-400/60' : 'text-zinc-700'}>›</span>
                )}
              </div>
            )
          })}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-4 md:gap-0">
          {/* Column: Agent / Client */}
          <StageColumn
            kind="agent"
            phase={phase}
            active={
              phase === 'requesting' ||
              phase === 'challenged' ||
              phase === 'authorize' ||
              phase === 'delivered'
            }
          />

          {/* Arrow: agent → haven */}
          <FlowArrow
            direction="right"
            active={phase === 'authorize'}
            done={reached(phase, 'policy')}
          />

          {/* Column: Haven */}
          <StageColumn
            kind="haven"
            phase={phase}
            active={phase === 'policy' || phase === 'sign'}
          />

          {/* Arrow: haven → chain */}
          <FlowArrow
            direction="right"
            active={phase === 'broadcast'}
            done={reached(phase, 'confirmed')}
          />

          {/* Column: Blockchain */}
          <StageColumn
            kind="chain"
            phase={phase}
            active={
              phase === 'broadcast' ||
              phase === 'confirmed' ||
              phase === 'delivered'
            }
          />
        </div>

        {/* Controls */}
        <div className="mt-8 flex flex-wrap items-center gap-3">
          {!isRunning && !isDone && (
            <button
              onClick={run}
              className="group px-5 py-2.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all shadow-lg shadow-indigo-500/25 inline-flex items-center gap-2"
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
              <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
              Settling payment…
            </button>
          )}
          {isDone && (
            <button
              onClick={run}
              className="px-5 py-2.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all shadow-lg shadow-indigo-500/25 inline-flex items-center gap-2"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              Run again
            </button>
          )}
          <span className="ml-auto text-xs text-zinc-600 font-mono">
            {phase === 'idle'
              ? 'Ready'
              : isDone
              ? `Settled in ${(timeline[timeline.length - 1]?.elapsedMs ?? 0) / 1000}s`
              : 'Running…'}
          </span>
        </div>
      </section>

      {/* Timeline */}
      <section className="relative max-w-6xl mx-auto px-6 py-10 z-10">
        <div className="flex items-baseline gap-4 mb-6">
          <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
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
                <span className="text-zinc-600 shrink-0 w-16 tabular-nums">
                  {(ev.elapsedMs / 1000).toFixed(2)}s
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

      {/* Technical details */}
      <section className="relative max-w-6xl mx-auto px-6 py-10 z-10">
        <div className="flex items-baseline gap-4 mb-6">
          <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
            [request]
          </span>
          <h2 className="text-xs text-zinc-500 uppercase tracking-widest">
            What the agent sends
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/[0.06] rounded-md overflow-hidden">
          <pre className="bg-[#0b0b0f] p-5 text-xs text-zinc-400 font-mono leading-relaxed overflow-x-auto">
{`POST /x402/authorize
Authorization: Bearer ${DEMO.agent.apiKeyPreview}
Content-Type: application/json

{
  "url":      "${DEMO.resourceUrl}",
  "payTo":    "${DEMO.payTo}",
  "amount":   "${(parseFloat(DEMO.amount) * 1_000_000).toString()}",
  "asset":    "${DEMO.tokenAddress}",
  "network":  "${DEMO.caip2}",
  "category": "api_access"
}`}
          </pre>
          <pre className="bg-[#0b0b0f] p-5 text-xs text-zinc-400 font-mono leading-relaxed overflow-x-auto">
{`HTTP/1.1 201 Created

{
  "payment_id":   "pi_8f2c…e14",
  "status":       "confirmed",
  "tx_hash":      "${shortHex(DEMO.txHash, 10, 8)}",
  "token":        "${DEMO.token}",
  "amount":       "${DEMO.amount}",
  "to":           "${DEMO.payTo.toLowerCase()}",
  "resource_url": "${DEMO.resourceUrl}",
  "explorer_url": "basescan.org/tx/${shortHex(DEMO.txHash, 6, 4)}"
}`}
          </pre>
        </div>
      </section>

      {/* CTA */}
      <section className="relative max-w-6xl mx-auto px-6 py-16 text-center z-10">
        <div
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 h-[400px]"
          style={{
            background:
              'radial-gradient(ellipse 60% 80% at 50% 50%, rgba(99,102,241,0.12) 0%, rgba(139,92,246,0.06) 40%, transparent 70%)',
          }}
        />
        <div className="relative">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight mb-4">
            <span className="bg-gradient-to-br from-white to-indigo-200 bg-clip-text text-transparent">
              Build an agent that pays its own way.
            </span>
          </h2>
          <p className="text-zinc-500 text-sm mb-8">
            Policies, approvals, and receipts included. Keys optional.
          </p>
          <Link
            href="/signup"
            className="inline-block px-6 py-3 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all shadow-xl shadow-indigo-500/30"
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
        @keyframes flowDot {
          0% { left: 0; opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { left: calc(100% - 0.5rem); opacity: 0; }
        }
      `}</style>
    </div>
  )
}

// ─── Stage column ─────────────────────────────────────────────────

function StageColumn({
  kind,
  phase,
  active,
}: {
  kind: 'agent' | 'haven' | 'chain'
  phase: Phase
  active: boolean
}) {
  const config = COLUMN_CONFIG[kind]
  return (
    <div
      className={`relative bg-[#0b0b0f] border border-white/[0.06] rounded-md p-5 transition-all duration-300 ${
        active
          ? 'border-indigo-500/50 shadow-[0_0_40px_-8px_rgba(99,102,241,0.4)]'
          : ''
      }`}
    >
      {active && (
        <div className="absolute -top-px inset-x-4 h-px bg-gradient-to-r from-transparent via-indigo-400 to-transparent" />
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
      {kind === 'haven' && <HavenContent phase={phase} />}
      {kind === 'chain' && <ChainContent phase={phase} />}
    </div>
  )
}

const COLUMN_CONFIG = {
  agent: {
    kicker: 'Client',
    title: DEMO.agent.name,
    iconGradient: 'from-sky-500 to-indigo-600',
    icon: (
      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z" />
      </svg>
    ),
  },
  haven: {
    kicker: 'Policy engine',
    title: 'Haven',
    iconGradient: 'from-indigo-500 to-violet-600',
    icon: (
      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
  },
  chain: {
    kicker: 'Settlement',
    title: 'Base',
    iconGradient: 'from-violet-500 to-fuchsia-600',
    icon: (
      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5.25-1.5a3.75 3.75 0 01-7.5 0" />
      </svg>
    ),
  },
} as const

function AgentContent({ phase }: { phase: Phase }) {
  const hasRequest = reached(phase, 'requesting')
  const hasChallenge = reached(phase, 'challenged')
  const isDelivered = reached(phase, 'delivered')
  const isWaiting = reached(phase, 'authorize') && !isDelivered

  const subtext =
    phase === 'idle'
      ? 'Ready to request premium research data.'
      : !hasChallenge
      ? 'Requesting paid API resource…'
      : isDelivered
      ? 'Got the data after payment was confirmed.'
      : 'Received 402 — asking Haven to settle.'

  return (
    <div className="space-y-3">
      <div className="text-xs text-zinc-500 leading-relaxed">{subtext}</div>

      {/* Outbound request */}
      {hasRequest && (
        <div className="rounded border border-white/[0.06] bg-black/30 p-3 font-mono text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">→</span>
            <span className="text-zinc-400 truncate">GET /query?q=sector+analysis</span>
            {!hasChallenge && (
              <span className="ml-auto inline-flex gap-1">
                <span className="w-1 h-1 rounded-full bg-zinc-500" style={{ animation: 'bounce 1s ease-in-out infinite' }} />
                <span className="w-1 h-1 rounded-full bg-zinc-500" style={{ animation: 'bounce 1s ease-in-out 0.15s infinite' }} />
                <span className="w-1 h-1 rounded-full bg-zinc-500" style={{ animation: 'bounce 1s ease-in-out 0.3s infinite' }} />
              </span>
            )}
          </div>
        </div>
      )}

      {/* 402 response (appears on challenged) */}
      {hasChallenge && !isDelivered && (
        <div className="rounded border border-amber-500/30 bg-amber-500/[0.06] p-3 font-mono text-[11px] animate-[fadeInUp_0.3s_ease-out]">
          <div className="text-amber-300">← 402 Payment Required</div>
          <div className="text-zinc-500 mt-1">
            {DEMO.amount} {DEMO.token} • {DEMO.network}
          </div>
        </div>
      )}

      {/* Successful delivery */}
      {isDelivered && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] p-3 font-mono text-[11px] animate-[fadeInUp_0.3s_ease-out]">
          <div className="flex items-center gap-2 text-emerald-300">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />
            </svg>
            ← 200 OK • research.json
          </div>
          <div className="text-zinc-500 mt-1">Sector analysis 2026 delivered</div>
        </div>
      )}

      {isWaiting && (
        <div className="text-[11px] text-zinc-500 font-mono flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
          waiting for Haven to settle…
        </div>
      )}

      <div className="text-[11px] text-zinc-600">
        API key <span className="text-zinc-400 font-mono">{DEMO.agent.apiKeyPreview}</span>
      </div>
    </div>
  )
}

function HavenContent({ phase }: { phase: Phase }) {
  const policyChecks: { label: string; status: 'pass' | 'pending' | 'idle' }[] = [
    {
      label: `Within per-tx limit (${DEMO.agent.policy.perTxLimit})`,
      status: reached(phase, 'policy')
        ? reached(phase, 'sign')
          ? 'pass'
          : 'pending'
        : 'idle',
    },
    {
      label: `Below approval threshold`,
      status: reached(phase, 'policy')
        ? reached(phase, 'sign')
          ? 'pass'
          : 'pending'
        : 'idle',
    },
    {
      label: `Network ${DEMO.network} allowed`,
      status: reached(phase, 'policy')
        ? reached(phase, 'sign')
          ? 'pass'
          : 'pending'
        : 'idle',
    },
    {
      label: `On-chain allowance sufficient`,
      status: reached(phase, 'sign') ? 'pass' : reached(phase, 'policy') ? 'pending' : 'idle',
    },
  ]
  return (
    <div className="space-y-3">
      <div className="text-xs text-zinc-500 leading-relaxed">
        Evaluating intent against the agent policy.
      </div>
      <ul className="space-y-1.5">
        {policyChecks.map((c) => (
          <li key={c.label} className="flex items-center gap-2 text-[11px]">
            <PolicyDot status={c.status} />
            <span
              className={
                c.status === 'pass'
                  ? 'text-zinc-300'
                  : c.status === 'pending'
                  ? 'text-zinc-400'
                  : 'text-zinc-600'
              }
            >
              {c.label}
            </span>
          </li>
        ))}
      </ul>
      {reached(phase, 'sign') && (
        <div className="rounded border border-indigo-500/30 bg-indigo-500/[0.06] p-2.5 font-mono text-[11px] text-indigo-200">
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
        <div className="rounded border border-sky-500/30 bg-sky-500/[0.05] p-3 font-mono text-[11px] text-sky-200">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
            pending on mempool…
          </div>
          <div className="text-sky-300/60 mt-1">{shortHex(DEMO.txHash, 8, 6)}</div>
        </div>
      )}
      {reached(phase, 'confirmed') && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] p-3 font-mono text-[11px] text-emerald-200">
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
      <svg className="w-3 h-3 text-emerald-400 shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />
      </svg>
    )
  }
  if (status === 'pending') {
    return (
      <span className="w-2.5 h-2.5 rounded-full border-2 border-zinc-500 border-t-indigo-400 animate-spin shrink-0" />
    )
  }
  return <span className="w-2.5 h-2.5 rounded-full border border-zinc-700 shrink-0" />
}

function phaseDotColor(p: Phase) {
  switch (p) {
    case 'requesting':
      return 'bg-sky-400'
    case 'challenged':
      return 'bg-amber-400'
    case 'authorize':
    case 'policy':
    case 'sign':
      return 'bg-indigo-400'
    case 'broadcast':
      return 'bg-sky-400'
    case 'confirmed':
    case 'delivered':
      return 'bg-emerald-400'
    default:
      return 'bg-zinc-600'
  }
}

// ─── Flow arrow ───────────────────────────────────────────────────

function FlowArrow({
  active,
  done,
}: {
  direction: 'right'
  active: boolean
  done: boolean
}) {
  return (
    <div className="relative flex items-center justify-center px-2 md:px-3 min-h-[1.5rem] min-w-[2rem] rotate-90 md:rotate-0">
      <div
        className={`h-px w-full transition-colors duration-300 ${
          done ? 'bg-gradient-to-r from-indigo-500/40 via-indigo-400 to-indigo-500/40' : 'bg-white/[0.08]'
        }`}
      />
      {active && (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-indigo-400 shadow-[0_0_12px_rgba(99,102,241,0.8)]"
          style={{ animation: 'flowDot 1s ease-in-out infinite' }}
        />
      )}
      <svg
        className={`absolute right-0 w-2.5 h-2.5 ${done ? 'text-indigo-400' : 'text-white/[0.14]'}`}
        fill="currentColor"
        viewBox="0 0 10 10"
      >
        <path d="M0 0 L10 5 L0 10 Z" />
      </svg>
    </div>
  )
}
