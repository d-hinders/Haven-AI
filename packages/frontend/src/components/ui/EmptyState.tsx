import type { ReactNode } from 'react'

export function EmptyState({
  icon,
  title,
  body,
  action,
  className = '',
}: {
  icon?: ReactNode
  title: string
  body?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={`rounded-[10px] border border-dashed border-[var(--v2-border-strong)] bg-[var(--v2-surface)] px-6 py-10 text-center ${className}`}>
      {icon && (
        <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-[10px] bg-white text-[var(--v2-brand)] shadow-[var(--v2-shadow-card)]">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{title}</h3>
      {body && (
        <div className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--v2-ink-2)]">
          {body}
        </div>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
