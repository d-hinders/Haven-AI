'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

type Phase =
  | 'idle'
  | 'requesting'
  | 'challenged'
  | 'authorize'
  | 'rules'
  | 'sign'
  | 'broadcast'
  | 'confirmed'
  | 'delivered'

type ProtocolKind = 'x402' | 'mpp'

type TimelineEvent = {
  step: number
  label: string
  detail: string
  tone: 'neutral' | 'warning' | 'brand' | 'success'
}

const PHASES: Phase[] = [
  'idle',
  'requesting',
  'challenged',
  'authorize',
  'rules',
  'sign',
  'broadcast',
  'confirmed',
  'delivered',
]

const DEMOS = {
  x402: {
    title: 'x402 payment flow',
    idle: 'Press play to watch a 402 challenge become a settled payment.',
    amount: '0.05 USDC',
    actor: 'Research Agent',
    merchant: 'api.research.example',
    request: 'GET /query?q=sector+analysis',
    challenge: '402 Payment Required',
    authorize: 'POST /x402/authorize',
    delivered: '200 OK · research.json',
    timeline: {
      requesting: ['Agent requested premium research data', 'GET api.research.example/query?q=…', 'neutral'],
      challenged: ['Server responded 402 Payment Required', '0.05 USDC on Base → 0x4F3e…3bcFc', 'warning'],
      authorize: ['Agent forwarded challenge to Haven', 'POST /x402/authorize · sk_agent_d4c8…9f', 'brand'],
      rules: ['Rules checked', 'Per-payment limit · network allowlist · allowance', 'brand'],
      sign: ['Rules cleared — Haven signed the transfer', 'sign_hash 0x8b2f4e93…2c6d4e8f', 'brand'],
      broadcast: ['Allowance transfer submitted to Base', 'Safe → ERC-20 via AllowanceModule', 'brand'],
      confirmed: ['Confirmed in block 14,892,103', 'tx 0x7a9e3b1d…b6c7d8e9 · gas 41,228', 'success'],
      delivered: ['Agent retried with proof — data delivered', '200 OK · research.json', 'success'],
    },
  },
  mpp: {
    title: 'MPP checkout flow',
    idle: 'Press play to watch an agent subscribe and settle in USDC.',
    amount: '29.00 USDC',
    actor: 'Ops Agent',
    merchant: 'Insightly',
    request: 'Create Pro subscription',
    challenge: 'Quote · 29 USDC / month',
    authorize: 'POST /mpp/authorize',
    delivered: '200 OK · Pro access granted',
    timeline: {
      requesting: ['Agent drafted payment intent', 'Insightly Pro · 29.00 USDC → 0x4F3e…3bcFc', 'neutral'],
      challenged: ['Merchant returned payment terms', '29.00 USDC on Base · one month', 'warning'],
      authorize: ['Agent forwarded intent to Haven', 'POST /mpp/authorize · sk_agent_a1b9…7e', 'brand'],
      rules: ['Rules checked', 'Per-payment limit · network allowlist · allowance', 'brand'],
      sign: ['Rules cleared — Haven signed the transfer', 'sign_hash 0x6c1f4e93…2c6d9b3a', 'brand'],
      broadcast: ['Allowance transfer submitted to Base', 'Safe → ERC-20 via AllowanceModule', 'brand'],
      confirmed: ['Confirmed in block 14,892,103', 'tx 0x4d8a3b1d…b6c7e2f8 · gas 41,228', 'success'],
      delivered: ['Merchant verified receipt — access granted', '200 OK · Insightly Pro — 1 month', 'success'],
    },
  },
} as const

const RULE_CHECKS = [
  'Within per-payment limit',
  'Allowed network',
  'Funds available',
]

function phaseIndex(phase: Phase) {
  return PHASES.indexOf(phase)
}

function reached(current: Phase, target: Phase) {
  return phaseIndex(current) >= phaseIndex(target)
}

function eventFor(kind: ProtocolKind, phase: Exclude<Phase, 'idle'>, step: number): TimelineEvent {
  const [label, detail, tone] = DEMOS[kind].timeline[phase]
  return { step, label, detail, tone }
}

export function ProtocolPlayground({ kind }: { kind: ProtocolKind }) {
  const demo = DEMOS[kind]
  const [phase, setPhase] = useState<Phase>('idle')
  const [ruleProgress, setRuleProgress] = useState(0)
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout)
    timers.current = []
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const schedule = useCallback((delay: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, delay))
  }, [])

  const run = useCallback(() => {
    clearTimers()
    setPhase('idle')
    setRuleProgress(0)
    setTimeline([])

    let delay = 250
    const phases: Exclude<Phase, 'idle'>[] = [
      'requesting',
      'challenged',
      'authorize',
      'rules',
      'sign',
      'broadcast',
      'confirmed',
      'delivered',
    ]

    phases.forEach((nextPhase, index) => {
      schedule(delay, () => {
        setPhase(nextPhase)
        setTimeline((prev) => [...prev, eventFor(kind, nextPhase, index + 1)])
      })

      if (nextPhase === 'rules') {
        RULE_CHECKS.forEach((_, checkIndex) => {
          schedule(delay + 280 * (checkIndex + 1), () => setRuleProgress(checkIndex + 1))
        })
        delay += 1400
      } else {
        delay += nextPhase === 'confirmed' ? 1100 : 850
      }
    })
  }, [clearTimers, kind, schedule])

  const isRunning = phase !== 'idle' && phase !== 'delivered'
  const isDone = phase === 'delivered'
  const activeStep = Math.max(0, phaseIndex(phase))

  return (
    <Card hover={false} className="p-0 overflow-hidden">
      <div className="flex flex-col gap-4 border-b border-[var(--v2-border)] px-5 py-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)]">
            Interactive demo
          </div>
          <h3 className="mt-1 text-[18px] font-semibold tracking-tight text-[var(--v2-ink)]">
            {demo.title}
          </h3>
          <p className="mt-1 text-[13px] text-[var(--v2-ink-2)]">
            {phase === 'idle' ? demo.idle : `Step ${activeStep} of 8 · ${timeline.at(-1)?.label ?? demo.idle}`}
          </p>
        </div>
        <Button
          type="button"
          size="md"
          onClick={run}
          disabled={isRunning}
        >
          {isRunning ? 'Playing flow' : isDone ? 'Play again' : 'Play flow'}
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-6 bg-[var(--v2-surface)] p-5 md:grid-cols-[minmax(0,1fr)_120px_minmax(0,1fr)] md:items-stretch md:gap-x-0 md:gap-y-0 md:p-7">
        <StageCard
          className="md:col-start-1 md:row-start-1"
          title={demo.actor}
          kicker="Agent"
          active={!isDone && ['requesting', 'authorize'].includes(phase)}
          done={reached(phase, 'authorize')}
          complete={isDone}
          lines={[
            reached(phase, 'requesting') ? demo.request : 'Waiting to start',
            reached(phase, 'authorize') ? demo.authorize : 'No payment credential exposed',
            reached(phase, 'delivered') ? demo.delivered : 'Awaiting proof',
          ]}
        />
        <AnimatedArrow
          className="md:col-start-2 md:row-start-1"
          active={['requesting', 'challenged'].includes(phase)}
          done={reached(phase, 'challenged')}
          reverse={phase === 'challenged'}
          label={phase === 'challenged' ? demo.challenge : 'request'}
        />
        <StageCard
          className="md:col-start-3 md:row-start-1"
          title={demo.merchant}
          kicker={kind === 'x402' ? 'Resource server' : 'Merchant'}
          active={!isDone && ['requesting', 'challenged'].includes(phase)}
          done={reached(phase, 'delivered')}
          complete={isDone}
          success={reached(phase, 'delivered')}
          lines={[
            reached(phase, 'requesting') ? 'Request received' : 'Ready',
            reached(phase, 'challenged') ? demo.challenge : 'Payment terms prepared',
            reached(phase, 'delivered') ? 'Access granted' : 'Waiting for proof',
          ]}
        />

        <MobileArrow active={phase === 'authorize'} done={reached(phase, 'rules')} />
        <DesktopDropConnector
          className="md:col-start-1 md:row-start-2"
          active={phase === 'authorize' || phase === 'rules'}
          done={reached(phase, 'sign')}
          label="authorize"
        />
        <DesktopDropConnector
          className="md:col-start-3 md:row-start-2"
          active={phase === 'confirmed' || phase === 'delivered'}
          done={reached(phase, 'delivered')}
          label="proof"
        />
        <StageCard
          className="md:col-start-1 md:row-start-3"
          title="Haven"
          kicker="Agent rules"
          active={['authorize', 'rules', 'sign'].includes(phase)}
          done={reached(phase, 'sign')}
          complete={isDone}
          lines={[
            reached(phase, 'authorize') ? 'Payment received' : 'No request yet',
            reached(phase, 'rules') ? `${ruleProgress}/${RULE_CHECKS.length} checks passed` : 'Rules pending',
            reached(phase, 'sign') ? 'Transfer signed' : 'Signature locked',
          ]}
        >
          <ul className="mt-4 space-y-1.5">
            {RULE_CHECKS.map((check, index) => {
              const done = ruleProgress > index || reached(phase, 'sign')
              return (
                <li
                  key={check}
                  className={`flex items-center gap-2 text-[12px] transition-colors ${
                    done ? 'text-[var(--v2-success)]' : 'text-[var(--v2-ink-3)]'
                  }`}
                >
                  {done ? (
                    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M6.5 11.2L3.8 8.5l-1 1L6.5 13.2 14 5.7l-1-1z" />
                    </svg>
                  ) : (
                    <span className="h-2 w-2 rounded-full border border-current" />
                  )}
                  {check}
                </li>
              )
            })}
          </ul>
        </StageCard>
        <AnimatedArrow
          className="md:col-start-2 md:row-start-3"
          active={phase === 'broadcast'}
          done={reached(phase, 'confirmed')}
          label={phase === 'broadcast' ? 'submit tx' : 'settle'}
        />
        <StageCard
          className="md:col-start-3 md:row-start-3"
          title="Base"
          kicker="Settlement"
          active={['broadcast', 'confirmed'].includes(phase)}
          done={reached(phase, 'confirmed')}
          complete={isDone}
          success={reached(phase, 'confirmed')}
          lines={[
            reached(phase, 'broadcast') ? 'Transfer submitted' : 'Waiting',
            reached(phase, 'confirmed') ? 'Block 14,892,103' : demo.amount,
            reached(phase, 'confirmed') ? 'Receipt ready' : 'USDC on Base',
          ]}
        />
      </div>

      <div className="border-t border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4 md:px-7">
        <div className="mb-3 text-[12px] font-medium tracking-tight text-[var(--v2-ink-3)]">
          Live trace
        </div>
        {timeline.length === 0 ? (
          <div className="rounded-[10px] border border-dashed border-[var(--v2-border-strong)] bg-white px-4 py-5 text-[13px] text-[var(--v2-ink-3)]">
            The trace will populate as the flow plays.
          </div>
        ) : (
          <ol className="divide-y divide-[var(--v2-border)] overflow-hidden rounded-[10px] border border-[var(--v2-border)] bg-white">
            {timeline.map((event) => (
              <li key={`${event.step}-${event.label}`} className="flex items-start gap-4 px-4 py-3">
                <span className="w-6 pt-0.5 text-[12px] text-[var(--v2-ink-3)] v2-tabular">
                  {String(event.step).padStart(2, '0')}
                </span>
                <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${toneDot(event.tone, isDone)}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-[var(--v2-ink)]">{event.label}</div>
                  <div className="mt-0.5 truncate font-mono text-[12px] text-[var(--v2-ink-3)]">
                    {event.detail}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  )
}

function StageCard({
  className = '',
  title,
  kicker,
  lines,
  active,
  done,
  complete = false,
  success = false,
  children,
}: {
  className?: string
  title: string
  kicker: string
  lines: string[]
  active: boolean
  done: boolean
  complete?: boolean
  success?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={`rounded-[10px] border p-5 transition-all duration-200 ${
        active
          ? 'border-[var(--v2-brand)]/45 bg-[var(--v2-brand-soft)]/55 shadow-[0_12px_32px_-18px_rgba(79,70,229,0.34)]'
          : done
          ? success
            ? 'border-[var(--v2-success)]/25 bg-[var(--v2-success-soft)]/70'
            : 'border-[var(--v2-border)] bg-white'
          : 'border-[var(--v2-border)] bg-white'
      } h-full ${className}`}
    >
      <div className="mb-1 text-[11px] uppercase tracking-wider text-[var(--v2-ink-3)]">{kicker}</div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-[15px] font-semibold text-[var(--v2-ink)]">{title}</div>
        <span
          className={`h-2 w-2 rounded-full ${
            complete
              ? 'bg-[var(--v2-success)]'
              : active
              ? 'bg-[var(--v2-brand)] animate-pulse'
              : done
              ? 'bg-[var(--v2-success)]'
              : 'bg-[var(--v2-border-strong)]'
          }`}
        />
      </div>
      <div className="space-y-2">
        {lines.map((line) => (
          <div key={line} className="rounded-md bg-white/70 px-3 py-2 text-[12px] text-[var(--v2-ink-2)] ring-1 ring-[var(--v2-border)]">
            {line}
          </div>
        ))}
      </div>
      {children}
    </div>
  )
}

function AnimatedArrow({
  className = '',
  active,
  done,
  reverse = false,
  label,
}: {
  className?: string
  active: boolean
  done: boolean
  reverse?: boolean
  label: string
}) {
  if (!active && !done) {
    return <div className={`hidden md:block ${className}`} aria-hidden />
  }

  const color = done ? 'bg-[var(--v2-success)]' : active ? 'bg-[var(--v2-brand)]' : 'bg-[var(--v2-border-strong)]'
  const textColor = done ? 'text-[var(--v2-success)]' : active ? 'text-[var(--v2-brand)]' : 'text-[var(--v2-ink-3)]'
  return (
    <div className={`hidden items-center justify-center md:flex ${className}`}>
      <div className="relative h-0.5 w-full">
        <div className={`absolute inset-x-0 top-0 h-0.5 ${color}`} />
        <svg className={`absolute -right-0.5 -top-[5px] h-3 w-3 ${textColor}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M2 6h7M6.5 3.5 9 6 6.5 8.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className={`absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap bg-white px-1 font-mono text-[11px] ${textColor}`}>
          {label}
        </span>
        {active && (
          <span
            className={`absolute -top-1 h-2 w-2 rounded-full bg-[var(--v2-brand)] ${reverse ? 'animate-[v2FlowReverse_1.1s_linear_infinite]' : 'animate-[v2FlowForward_1.1s_linear_infinite]'}`}
          />
        )}
      </div>
    </div>
  )
}

function DesktopDropConnector({
  active,
  done,
  label,
  className = '',
}: {
  active: boolean
  done: boolean
  label: string
  className?: string
}) {
  if (!active && !done) {
    return <div className={`hidden min-h-12 md:block ${className}`} aria-hidden />
  }

  const color = done ? 'bg-[var(--v2-success)]' : active ? 'bg-[var(--v2-brand)]' : 'bg-[var(--v2-border-strong)]'
  const textColor = done ? 'text-[var(--v2-success)]' : active ? 'text-[var(--v2-brand)]' : 'text-[var(--v2-ink-3)]'

  return (
    <div className={`hidden min-h-12 items-center justify-center md:flex ${className}`}>
      <div className="relative h-full min-h-12 w-0.5">
        <div className={`absolute inset-y-0 left-0 w-0.5 ${color}`} />
        <svg className={`absolute -bottom-0.5 -left-[5px] h-3 w-3 ${textColor}`} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M6 2v7M3.5 6.5 6 9l2.5-2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className={`absolute left-3 top-1/2 -translate-y-1/2 bg-white px-1 font-mono text-[11px] ${textColor}`}>
          {label}
        </span>
      </div>
    </div>
  )
}

function MobileArrow({ active, done, className = '' }: { active: boolean; done: boolean; className?: string }) {
  if (!active && !done) {
    return <div className={`py-1 md:hidden ${className}`} aria-hidden />
  }

  return (
    <div className={`flex items-center justify-center py-1 md:hidden ${className}`}>
      <div className={`h-9 w-px ${done ? 'bg-[var(--v2-success)]' : active ? 'bg-[var(--v2-brand)]' : 'bg-[var(--v2-border-strong)]'}`} />
    </div>
  )
}

function toneDot(tone: TimelineEvent['tone'], complete = false) {
  if (complete) return 'bg-[var(--v2-success)]'
  if (tone === 'warning') return 'bg-[var(--v2-warning)]'
  if (tone === 'success') return 'bg-[var(--v2-success)]'
  if (tone === 'brand') return 'bg-[var(--v2-brand)]'
  return 'bg-[var(--v2-ink-3)]'
}
