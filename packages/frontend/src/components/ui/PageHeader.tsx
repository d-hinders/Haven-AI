import type { ReactNode } from 'react'

export type PageHeaderProps = {
  title: string
  subtitle?: ReactNode
  eyebrow?: string
  actions?: ReactNode
}

export function PageHeader({ title, subtitle, eyebrow, actions }: PageHeaderProps) {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        {eyebrow && (
          <p className="v2-text-meta text-[var(--v2-ink-3)] uppercase tracking-wider mb-1">{eyebrow}</p>
        )}
        <h1 className="v2-text-h1 text-[var(--v2-ink)]">{title}</h1>
        {subtitle && (
          <p className="mt-2 v2-text-body text-[var(--v2-ink-2)] max-w-2xl">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 flex-shrink-0">{actions}</div>
      )}
    </header>
  )
}

export default PageHeader
