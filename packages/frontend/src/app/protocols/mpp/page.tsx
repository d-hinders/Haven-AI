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
  | 'minted'
  | 'present'
  | 'charging'
  | 'captured'
  | 'delivered'

interface TimelineEvent {
  step: number
  label: string
  detail?: string
  phase: Phase
}

const DEMO = {
  resourceLabel: 'Premium analytics dashboard — 1 month',
  amount: '29.00',
  currency: 'USD',
  merchant: {
    name: 'Insightly',
    host: 'checkout.insightly.example',
  },
  agent: {
    name: 'Ops Agent',
    apiKeyPreview: 'sk_agent_a1b9…7e',
    policy: {
      monthlyLimit: '500 USD',
      perTxLimit: '100 USD',
      allowedCategories: ['software', 'data'],
    },
    monthlySpent: '142.50',
    monthlyLimitNum: 500,
  },
  spt: 'spt_1Q4d8KH5Yj9c8e1f',
  chargeId: 'ch_3Q4d9MH5Yj9c8e1g',
  cardLast4: '4242',
  network: 'Visa',
  steps: [
    { phase: 'requesting', label: 'Agent picks item' },
    { phase: 'authorize', label: 'Request SPT' },
    { phase: 'policy', label: 'Policy evaluation' },
    { phase: 'minted', label: 'SPT minted' },
    { phase: 'present', label: 'Agent presents SPT' },
    { phase: 'charging', label: 'Stripe authorizes' },
    { phase: 'captured', label: 'Captured on card' },
    { phase: 'delivered', label: 'Receipt + access' },
  ] as const,
}

const POLICY_CHECKS: string[] = [
  'Within per-tx limit ($100)',
  'Category "software" allowed',
  'Monthly remaining sufficient',
]

function shortHex(s: string, head = 6, tail = 4) {
  return s.length > head + tail + 2 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s
}

const phaseOrder: Phase[] = [
  'idle',
  'requesting',
  'authorize',
  'policy',
  'minted',
  'present',
  'charging',
  'captured',
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

    t += 400
    schedule(t, () => {
      setPhase('requesting')
      push({
        phase: 'requesting',
        label: 'Agent selected analytics dashboard',
        detail: `${DEMO.resourceLabel} • ${DEMO.amount} ${DEMO.currency}`,
      })
    })

    t += 1100
    schedule(t, () => {
      setPhase('authorize')
      push({
        phase: 'authorize',
        label: 'Agent requested SPT from Haven',
        detail: `POST /mpp/authorize • ${DEMO.agent.apiKeyPreview}`,
      })
    })

    const policyStart = t + 500
    schedule(policyStart, () => {
      setPhase('policy')
      push({
        phase: 'policy',
        label: 'Policy engine evaluating intent',
        detail: 'Per-tx limit, category allowlist, monthly remaining',
      })
    })
    for (let i = 1; i <= POLICY_CHECKS.length; i++) {
      schedule(policyStart + i * 300, () => setPolicyProgress(i))
    }
    t += 500 + 300 * POLICY_CHECKS.length + 300

    schedule(t, () => {
      setPhase('minted')
      push({
        phase: 'minted',
        label: 'Haven minted Shared Payment Token',
        detail: `${DEMO.spt} • scope: ${DEMO.merchant.name} • single-use`,
      })
    })

    t += 1100
    schedule(t, () => {
      setPhase('present')
      push({
        phase: 'present',
        label: 'Agent presented SPT at checkout',
        detail: `→ ${DEMO.merchant.host}`,
      })
    })

    t += 1100
    schedule(t, () => {
      setPhase('charging')
      push({
        phase: 'charging',
        label: 'Merchant exchanged SPT with Stripe',
        detail: `Authorize ${DEMO.amount} ${DEMO.currency} • ${DEMO.network} ••${DEMO.cardLast4}`,
      })
    })

    t += 1500
    schedule(t, () => {
      setPhase('captured')
      push({
        phase: 'captured',
        label: 'Capture confirmed by card network',
        detail: `charge ${shortHex(DEMO.chargeId, 8, 6)} • SPT consumed`,
      })
    })

    t += 1100
    schedule(t, () => {
      setPhase('delivered')
      push({
        phase: 'delivered',
        label: 'Merchant granted access — receipt logged',
        detail: `Remaining this month: ${(DEMO.agent.monthlyLimitNum - parseFloat(DEMO.agent.monthlySpent) - parseFloat(DEMO.amount)).toFixed(2)} ${DEMO.currency}`,
      })
    })

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
            check out with a card.
          </span>
        </h1>
        <p className="text-base md:text-lg text-zinc-400 leading-relaxed max-w-2xl">
          An agent buys a SaaS subscription. Haven mints a one-time, scope-bound
          payment token, the merchant charges Stripe, and the receipt lands in your
          audit log — without a card number ever leaving Haven.
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
              <span className="text-zinc-300">Machine Payments Protocol</span> — is
              an open standard for agents transacting on existing card rails.
              Instead of giving an agent a card number, you give it a{' '}
              <span className="font-mono text-zinc-300">Shared Payment Token (SPT)</span>:
              a one-time, scope-bound credential that authorises a single charge at
              a single merchant, up to a single amount.
            </p>
            <p>
              That maps cleanly onto how agents already work. An agent decides what
              to buy, asks Haven for an SPT, and presents it at checkout. The
              merchant redeems the SPT through Stripe; the card network does the
              rest. The agent never sees a PAN, the merchant never holds a re-usable
              credential, and Haven keeps the policy and audit trail in one place —
              the same one that gates on-chain spend.
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
                  <div className="text-zinc-200">Intent → SPT</div>
                  <div className="text-xs text-zinc-500">Wallet mints a scoped token.</div>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-[11px] font-mono text-violet-300 tabular-nums mt-0.5">02</span>
                <div>
                  <div className="text-zinc-200">Present → charge</div>
                  <div className="text-xs text-zinc-500">Merchant redeems SPT through Stripe.</div>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <span className="text-[11px] font-mono text-violet-300 tabular-nums mt-0.5">03</span>
                <div>
                  <div className="text-zinc-200">Capture → fulfil</div>
                  <div className="text-xs text-zinc-500">Card network settles, agent gets access.</div>
                </div>
              </li>
            </ol>
          </div>
        </div>
      </section>

      {/* Stage */}
      <section className="relative max-w-6xl mx-auto px-6 pb-6 z-10">
        <div className="mb-6 max-w-3xl">
          <p className="text-sm md:text-[15px] text-zinc-400 leading-relaxed">
            Below is one MPP payment in motion: an Ops Agent buying a $29 monthly
            analytics subscription. Four actors take part — watch how an intent, an
            SPT, and a captured charge flow between them.
          </p>
        </div>
        <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-3">
          {(['agent', 'merchant', 'haven', 'stripe'] as const).map((kind) => {
            const cfg = COLUMN_CONFIG[kind]
            const role =
              kind === 'agent'
                ? 'The AI making the purchase'
                : kind === 'merchant'
                ? 'The store taking the payment'
                : kind === 'haven'
                ? 'Policy engine + token mint'
                : 'Card network + settlement'
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
                MPP payment flow
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

          {/* 2x2 actor grid with 3 arrows */}
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
                  phase === 'present' ||
                  (phase === 'delivered' && !settled)
                }
              />
            </div>
            <div className="row-start-1 col-start-2 flex items-center justify-center">
              <FlowArrow
                orientation="horizontal"
                reverse={phase === 'delivered'}
                active={
                  phase === 'present' ||
                  (phase === 'delivered' && !settled)
                }
                done={reached(phase, 'present')}
                color={reached(phase, 'delivered') ? 'emerald' : 'violet'}
                label={
                  phase === 'present'
                    ? 'SPT'
                    : phase === 'delivered' && !settled
                    ? 'access'
                    : undefined
                }
              />
            </div>
            <div className="row-start-1 col-start-3">
              <StageColumn
                kind="merchant"
                phase={phase}
                active={
                  phase === 'present' ||
                  phase === 'charging' ||
                  (phase === 'delivered' && !settled)
                }
              />
            </div>

            {/* Row 2: [V arrow] — empty — [V arrow] */}
            <div className="row-start-2 col-start-1 flex items-center justify-center">
              <FlowArrow
                orientation="vertical"
                reverse={phase === 'minted'}
                active={phase === 'authorize' || phase === 'minted'}
                done={reached(phase, 'present')}
                color="violet"
                label={
                  phase === 'authorize'
                    ? 'authorize'
                    : phase === 'minted'
                    ? 'SPT'
                    : undefined
                }
              />
            </div>
            <div className="row-start-2 col-start-2" />
            <div className="row-start-2 col-start-3 flex items-center justify-center">
              <FlowArrow
                orientation="vertical"
                reverse={false}
                active={phase === 'charging'}
                done={reached(phase, 'captured')}
                color="violet"
                label={phase === 'charging' ? 'charge' : undefined}
              />
            </div>

            {/* Row 3: Haven — empty — Stripe */}
            <div className="row-start-3 col-start-1">
              <StageColumn
                kind="haven"
                phase={phase}
                active={phase === 'policy' || phase === 'minted'}
                policyProgress={policyProgress}
              />
            </div>
            <div className="row-start-3 col-start-2" />
            <div className="row-start-3 col-start-3">
              <StageColumn
                kind="stripe"
                phase={phase}
                active={phase === 'charging' || phase === 'captured'}
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
              One policy. Card rails included.
            </span>
          </h2>
          <p className="text-zinc-500 text-sm mb-8">
            Same allowance model, no card numbers in agent memory.
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
  kind: 'agent' | 'haven' | 'stripe' | 'merchant'
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
      {kind === 'stripe' && <StripeContent phase={phase} />}
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
  stripe: {
    kicker: 'Settlement',
    title: 'Stripe + card network',
    iconGradient: 'from-fuchsia-500 to-pink-600',
    icon: (
      <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
      </svg>
    ),
  },
} as const

function AgentContent({ phase }: { phase: Phase }) {
  const hasRequest = reached(phase, 'requesting')
  const hasMinted = reached(phase, 'minted')
  const isPresenting = reached(phase, 'present')
  const isDelivered = reached(phase, 'delivered')
  const isWaiting = reached(phase, 'authorize') && !hasMinted

  const subtext =
    phase === 'idle'
      ? 'Ready to subscribe to analytics dashboard.'
      : !hasMinted
      ? isWaiting
        ? 'Waiting for Haven to mint a payment token…'
        : 'Drafting purchase intent.'
      : !isPresenting
      ? 'Got SPT — heading to checkout.'
      : isDelivered
      ? 'Subscription active. Receipt logged.'
      : 'Presenting SPT to merchant…'

  return (
    <div className="space-y-3">
      <div className="text-xs text-zinc-500 leading-relaxed">{subtext}</div>

      {hasRequest && !hasMinted && (
        <div className="rounded border border-white/[0.06] bg-black/30 p-3 font-mono text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500 shrink-0">→</span>
            <span className="text-zinc-400 truncate">intent: subscribe • {DEMO.amount} {DEMO.currency}</span>
            {!hasMinted && (
              <span className="ml-auto inline-flex gap-1">
                <span className="w-1 h-1 rounded-full bg-zinc-500" style={{ animation: 'bounce 1s ease-in-out infinite' }} />
                <span className="w-1 h-1 rounded-full bg-zinc-500" style={{ animation: 'bounce 1s ease-in-out 0.15s infinite' }} />
                <span className="w-1 h-1 rounded-full bg-zinc-500" style={{ animation: 'bounce 1s ease-in-out 0.3s infinite' }} />
              </span>
            )}
          </div>
        </div>
      )}

      {hasMinted && !isDelivered && (
        <div className="rounded border border-violet-500/30 bg-violet-500/[0.06] p-3 font-mono text-[11px] animate-[fadeInUp_0.3s_ease-out]">
          <div className="text-violet-300">SPT acquired</div>
          <div className="text-zinc-500 mt-1 truncate">{shortHex(DEMO.spt, 10, 4)}</div>
        </div>
      )}

      {isDelivered && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] p-3 font-mono text-[11px] animate-[fadeInUp_0.3s_ease-out]">
          <div className="flex items-center gap-2 text-emerald-300">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />
            </svg>
            access granted
          </div>
          <div className="text-zinc-500 mt-1">{DEMO.resourceLabel}</div>
        </div>
      )}

      <div className="text-[11px] text-zinc-600">
        API key <span className="text-zinc-400 font-mono">{DEMO.agent.apiKeyPreview}</span>
      </div>
    </div>
  )
}

function MerchantContent({ phase }: { phase: Phase }) {
  const isPresenting = reached(phase, 'present')
  const isCharging = reached(phase, 'charging')
  const isDelivered = reached(phase, 'delivered')

  const subtext =
    phase === 'idle'
      ? 'Stripe-MPP-enabled checkout.'
      : !isPresenting
      ? 'Waiting for an SPT at checkout…'
      : isDelivered
      ? 'Charge captured — granting access.'
      : isCharging
      ? 'Redeeming SPT through Stripe…'
      : 'SPT received — submitting to Stripe.'

  return (
    <div className="space-y-3">
      <div className="text-xs text-zinc-500 leading-relaxed">{subtext}</div>

      {isPresenting && !isDelivered && (
        <div className="rounded border border-violet-500/30 bg-violet-500/[0.06] p-3 font-mono text-[11px] animate-[fadeInUp_0.3s_ease-out]">
          <div className="text-violet-300">→ POST /v1/charges</div>
          <div className="text-zinc-500 mt-1">
            spt {shortHex(DEMO.spt, 8, 4)}
          </div>
          <div className="text-zinc-600 mt-0.5">amount: {DEMO.amount} {DEMO.currency}</div>
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
        price <span className="text-zinc-400 font-mono">{DEMO.amount} {DEMO.currency} / mo</span>
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
  const afterPolicy = reached(phase, 'minted')

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
        Evaluating intent, then minting a scope-bound SPT.
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
          spt {shortHex(DEMO.spt, 8, 4)}
        </div>
      )}
    </div>
  )
}

function StripeContent({ phase }: { phase: Phase }) {
  return (
    <div className="space-y-3">
      <div className="text-xs text-zinc-500 leading-relaxed">
        Redeems SPT, charges the card on file via the network.
      </div>
      {!reached(phase, 'charging') && (
        <div className="rounded border border-white/[0.06] bg-black/30 p-3 text-[11px] text-zinc-600">
          awaiting SPT
        </div>
      )}
      {reached(phase, 'charging') && !reached(phase, 'captured') && (
        <div className="rounded border border-fuchsia-500/30 bg-fuchsia-500/[0.05] p-3 font-mono text-[11px] text-fuchsia-200">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-fuchsia-400 animate-pulse" />
            authorizing on {DEMO.network}…
          </div>
          <div className="text-fuchsia-300/60 mt-1">••{DEMO.cardLast4}</div>
        </div>
      )}
      {reached(phase, 'captured') && (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/[0.06] p-3 font-mono text-[11px] text-emerald-200 animate-[fadeInUp_0.3s_ease-out]">
          <div className="flex items-center gap-2">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" />
            </svg>
            captured
          </div>
          <div className="text-emerald-300/70 mt-1 truncate">{shortHex(DEMO.chargeId, 10, 6)}</div>
          <div className="text-emerald-300/50 mt-0.5">
            {DEMO.amount} {DEMO.currency} • {DEMO.network} ••{DEMO.cardLast4}
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
      return 'bg-violet-400'
    case 'minted':
    case 'present':
      return 'bg-violet-400'
    case 'charging':
      return 'bg-fuchsia-400'
    case 'captured':
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
