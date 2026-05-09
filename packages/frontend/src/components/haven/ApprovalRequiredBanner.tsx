import type { ReactNode } from 'react'

export function ApprovalRequiredBanner({
  title = 'Approval required above budget',
  children,
}: {
  title?: string
  children: ReactNode
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-warning)]/20 bg-[var(--v2-warning-soft)] p-4">
      <div className="flex gap-3">
        <div className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-white text-[var(--v2-warning)] shadow-[var(--v2-shadow-card)]">
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7}>
            <path d="M8 4.5v4" strokeLinecap="round" />
            <path d="M8 11.25h.01" strokeLinecap="round" />
            <path d="M7.1 2.1 1.9 11.2A1.8 1.8 0 0 0 3.5 14h9a1.8 1.8 0 0 0 1.6-2.8L8.9 2.1a1.05 1.05 0 0 0-1.8 0Z" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
          <div className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">{children}</div>
        </div>
      </div>
    </div>
  )
}
