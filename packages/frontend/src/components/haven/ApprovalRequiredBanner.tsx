import type { ReactNode } from 'react'
import { Info, TriangleAlert } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

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
          : 'border-warning/20 bg-[var(--v2-warning-soft)]'
      }`}
    >
      <div className="flex gap-3">
        <div
          className={`${compact ? 'h-5 w-5' : 'h-6 w-6'} mt-0.5 flex flex-shrink-0 items-center justify-center rounded-full bg-white ${
            neutral ? 'text-[var(--v2-ink-3)]' : 'text-[var(--v2-warning)] shadow-[var(--v2-shadow-card)]'
          }`}
        >
          <Icon icon={neutral ? Info : TriangleAlert} className="h-3.5 w-3.5" />
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
