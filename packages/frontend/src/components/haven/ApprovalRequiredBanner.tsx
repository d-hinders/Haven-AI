import type { ReactNode } from 'react'

export function ApprovalRequiredBanner({
  title = 'Payments above budget need approval',
  children,
  density = 'normal',
  tone = 'warning',
}: {
  title?: string
  children: ReactNode
  density?: 'normal' | 'compact'
  tone?: 'neutral' | 'warning'
}) {
  const compact = density === 'compact'
  const neutral = tone === 'neutral'

  return (
    <div
      className={`${compact ? 'p-3' : 'p-4'} rounded-[10px] border ${
        neutral
          ? 'border-[var(--v2-border)] bg-[var(--v2-surface)]'
          : 'border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)]'
      }`}
    >
      <div className="flex gap-3">
        <div
          className={`${compact ? 'h-5 w-5' : 'h-6 w-6'} mt-0.5 flex flex-shrink-0 items-center justify-center rounded-full bg-white ${
            neutral ? 'text-[var(--v2-ink-3)]' : 'text-[var(--v2-warning)] shadow-[var(--v2-shadow-card)]'
          }`}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7}>
            {neutral ? (
              <>
                <circle cx="8" cy="8" r="5.75" />
                <path d="M8 7.25v3.25" strokeLinecap="round" />
                <path d="M8 5.25h.01" strokeLinecap="round" />
              </>
            ) : (
              <>
                <path d="M8 4.5v4" strokeLinecap="round" />
                <path d="M8 11.25h.01" strokeLinecap="round" />
                <path d="M7.1 2.1 1.9 11.2A1.8 1.8 0 0 0 3.5 14h9a1.8 1.8 0 0 0 1.6-2.8L8.9 2.1a1.05 1.05 0 0 0-1.8 0Z" strokeLinejoin="round" />
              </>
            )}
          </svg>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
          <div className={`${compact ? 'text-xs' : 'text-sm'} mt-1 leading-relaxed text-[var(--v2-ink-2)]`}>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}
