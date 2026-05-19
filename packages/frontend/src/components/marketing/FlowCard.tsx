'use client'

import { useEffect, useState } from 'react'

type Phase = 'idle' | 'intent' | 'policy' | 'signed' | 'settled'

const SEQUENCE: { phase: Phase; delay: number }[] = [
  { phase: 'intent', delay: 600 },
  { phase: 'policy', delay: 1100 },
  { phase: 'signed', delay: 900 },
  { phase: 'settled', delay: 1300 },
  { phase: 'idle', delay: 1800 },
]

const PHASE_INDEX: Record<Phase, number> = {
  idle: 0,
  intent: 1,
  policy: 2,
  signed: 3,
  settled: 4,
}

function reached(current: Phase, target: Phase) {
  return PHASE_INDEX[current] >= PHASE_INDEX[target]
}

export function FlowCard() {
  const [phase, setPhase] = useState<Phase>('idle')

  useEffect(() => {
    let cancelled = false
    let i = 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = () => {
      if (cancelled) return
      const next = SEQUENCE[i % SEQUENCE.length]
      timer = setTimeout(() => {
        if (cancelled) return
        setPhase(next.phase)
        i++
        tick()
      }, next.delay)
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  const checks = [
    { label: 'Within per‑payment limit', done: reached(phase, 'policy') },
    { label: 'Allowed network', done: reached(phase, 'policy') },
    { label: 'Funds available', done: reached(phase, 'signed') },
  ]

  return (
    <div className="relative">
      {/* Soft glow backdrop */}
      <div
        aria-hidden
        className="absolute -inset-6 -z-10 rounded-[24px] opacity-60 blur-2xl transition-opacity duration-500"
        style={{
          background:
            phase === 'settled'
              ? 'radial-gradient(circle, rgba(14,159,110,0.25), transparent 60%)'
              : 'radial-gradient(circle, rgba(79,70,229,0.22), transparent 60%)',
        }}
      />

      <div className="rounded-[14px] border border-[var(--v2-border)] bg-white shadow-[0_24px_48px_-24px_rgba(16,24,40,0.18),0_2px_6px_-2px_rgba(16,24,40,0.06)]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-11 border-b border-[var(--v2-border)]">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--v2-brand)]" />
            <span className="text-[12px] font-medium text-[var(--v2-ink-2)]">
              Live payment
            </span>
          </div>
          <span className="text-[11px] font-mono text-[var(--v2-ink-3)] v2-tabular">
            agt_ops · 29.00 USDC
          </span>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-3.5">
          <FlowRow
            index={1}
            label="Payment requested"
            sub="POST /payments"
            state={
              reached(phase, 'intent')
                ? reached(phase, 'policy')
                  ? 'done'
                  : 'active'
                : 'idle'
            }
          />

          <FlowRow
            index={2}
            label="Rules check"
            sub={
              <ul className="mt-1.5 space-y-0.5">
                {checks.map((c, i) => (
                  <li
                    key={c.label}
                    className={`flex items-center gap-1.5 text-[11px] transition-colors duration-300 ${
                      c.done ? 'text-[var(--v2-success)]' : 'text-[var(--v2-ink-3)]'
                    }`}
                    style={{ transitionDelay: `${i * 80}ms` }}
                  >
                    {c.done ? (
                      <svg
                        className="w-3 h-3"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                      >
                        <path d="M6.5 11.2L3.8 8.5l-1 1L6.5 13.2 14 5.7l-1-1z" />
                      </svg>
                    ) : (
                      <span className="w-1.5 h-1.5 rounded-full border border-[var(--v2-ink-3)]" />
                    )}
                    {c.label}
                  </li>
                ))}
              </ul>
            }
            state={
              reached(phase, 'policy')
                ? reached(phase, 'signed')
                  ? 'done'
                  : 'active'
                : 'idle'
            }
          />

          <FlowRow
            index={3}
            label="Settled on Base"
            sub={
              reached(phase, 'settled')
                ? 'tx 0x7a9e…d8e9 · block 14,892,103'
                : 'awaiting confirmation'
            }
            state={
              reached(phase, 'settled')
                ? 'done'
                : reached(phase, 'signed')
                ? 'active'
                : 'idle'
            }
            success
          />
        </div>

        {/* Footer */}
        <div className="px-5 h-11 border-t border-[var(--v2-border)] flex items-center justify-between text-[11px]">
          <span className="text-[var(--v2-ink-3)]">~120ms · approved automatically</span>
          <span
            className={`inline-flex items-center gap-1.5 transition-colors duration-300 ${
              reached(phase, 'settled') ? 'text-[var(--v2-success)]' : 'text-[var(--v2-ink-2)]'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                reached(phase, 'settled')
                  ? 'bg-[var(--v2-success)]'
                  : 'bg-[var(--v2-brand)] animate-pulse'
              }`}
            />
            {reached(phase, 'settled') ? 'Settled' : 'Processing'}
          </span>
        </div>
      </div>
    </div>
  )
}

function FlowRow({
  index,
  label,
  sub,
  state,
  success = false,
}: {
  index: number
  label: string
  sub: React.ReactNode
  state: 'idle' | 'active' | 'done'
  success?: boolean
}) {
  const dot =
    state === 'done'
      ? success
        ? 'bg-[var(--v2-success)] text-white'
        : 'bg-[var(--v2-brand)] text-white'
      : state === 'active'
      ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)] ring-2 ring-[var(--v2-brand)]/30'
      : 'bg-[var(--v2-surface)] text-[var(--v2-ink-3)] border border-[var(--v2-border)]'

  return (
    <div className="flex items-start gap-3">
      <div
        className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-medium transition-colors duration-300 ${dot}`}
      >
        {state === 'done' ? (
          <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.5 11.2L3.8 8.5l-1 1L6.5 13.2 14 5.7l-1-1z" />
          </svg>
        ) : state === 'active' ? (
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--v2-brand)] animate-pulse" />
        ) : (
          index
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className={`text-[13px] font-medium transition-colors duration-200 ${
            state === 'idle' ? 'text-[var(--v2-ink-3)]' : 'text-[var(--v2-ink)]'
          }`}
        >
          {label}
        </div>
        <div className="text-[12px] text-[var(--v2-ink-3)] mt-0.5">{sub}</div>
      </div>
    </div>
  )
}
