import { ReactNode } from 'react'

export function Section({
  eyebrow,
  title,
  lede,
  children,
  centered = false,
  className = '',
}: {
  eyebrow?: string
  title?: ReactNode
  lede?: ReactNode
  children?: ReactNode
  centered?: boolean
  className?: string
}) {
  return (
    <section className={`max-w-6xl mx-auto px-6 py-20 md:py-24 ${className}`}>
      {(eyebrow || title || lede) && (
        <div className={`mb-12 ${centered ? 'text-center max-w-2xl mx-auto' : 'max-w-2xl'}`}>
          {eyebrow && (
            <div className="text-[12px] font-medium tracking-tight text-[var(--v2-brand)] mb-3">
              {eyebrow}
            </div>
          )}
          {title && (
            <h2 className="text-[28px] md:text-[34px] font-semibold tracking-[-0.02em] leading-[1.15] text-[var(--v2-ink)] mb-4">
              {title}
            </h2>
          )}
          {lede && (
            <p className="text-[16px] leading-relaxed text-[var(--v2-ink-2)]">{lede}</p>
          )}
        </div>
      )}
      {children}
    </section>
  )
}
