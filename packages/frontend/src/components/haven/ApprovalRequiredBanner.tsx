import type { ReactNode } from 'react'
import { Info, OctagonAlert, TriangleAlert } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

/**
 * Tone ladder. `danger` was added by #1701 for the one thing the warning tone
 * could not say: an action that is IRREVERSIBLE, as opposed to one that merely
 * needs attention. The re-key flow revokes an agent's authority on-chain and
 * cannot give it back, and rendering that in the same yellow as "this payment
 * needs approval" flattened the two into one voice.
 *
 * Additive by construction: `warning` remains the default and every existing
 * call site passes `tone` explicitly, so nothing that rendered before renders
 * differently now.
 */
type BannerTone = 'neutral' | 'warning' | 'danger'

const TONE_STYLES: Record<BannerTone, { frame: string; badge: string; icon: typeof Info }> = {
  neutral: {
    frame: 'border-[var(--v2-border)] bg-[var(--v2-surface)]',
    badge: 'text-[var(--v2-ink-3)]',
    icon: Info,
  },
  warning: {
    frame: 'border-warning/20 bg-[var(--v2-warning-soft)]',
    badge: 'text-[var(--v2-warning)] shadow-[var(--v2-shadow-card)]',
    icon: TriangleAlert,
  },
  // `danger` carries a STRUCTURAL break from `warning`, not only a hue swap
  // (design review on #1701). At the same border weight and saturation band,
  // pale pink and pale yellow read as two shades of "notice" — so a reader who
  // has just scrolled past a warning treats the irreversible banner as more of
  // the same. The doubled border and the solid left rule make severity a
  // step-change that survives skimming and does not rely on hue alone, which
  // also keeps it legible to a red/green-colour-blind reader.
  danger: {
    frame: 'border-2 border-danger/40 border-l-4 border-l-[var(--v2-danger)] bg-[var(--v2-danger-soft)]',
    badge: 'text-[var(--v2-danger)] shadow-[var(--v2-shadow-card)]',
    icon: OctagonAlert,
  },
}

export function ApprovalRequiredBanner({
  title = 'Payments above budget need approval',
  children,
  density = 'normal',
  tone = 'warning',
}: {
  title?: string
  children: ReactNode
  density?: 'normal' | 'compact'
  tone?: BannerTone
}) {
  const compact = density === 'compact'
  const styles = TONE_STYLES[tone]

  return (
    <div className={`${compact ? 'p-3' : 'p-4'} rounded-[10px] border ${styles.frame}`}>
      <div className="flex gap-3">
        <div
          className={`${compact ? 'h-5 w-5' : 'h-6 w-6'} mt-0.5 flex flex-shrink-0 items-center justify-center rounded-full bg-white ${styles.badge}`}
        >
          <Icon icon={styles.icon} className="h-3.5 w-3.5" />
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
