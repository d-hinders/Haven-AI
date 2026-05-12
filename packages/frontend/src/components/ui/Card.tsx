import type { ReactNode } from 'react'

export function Card({
  children,
  className = '',
  as: Tag = 'div',
  hover = true,
  elevation = 'flat',
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'article'
  hover?: boolean
  elevation?: 'flat' | 'raised'
}) {
  const shadowClass =
    elevation === 'raised'
      ? 'shadow-[var(--v2-shadow-card-raised)]'
      : 'shadow-[var(--v2-shadow-card)]'
  const hoverClass =
    elevation === 'raised' || !hover
      ? ''
      : 'hover:shadow-[0_8px_24px_-12px_rgba(16,24,40,0.12)] transition-shadow duration-200'
  return (
    <Tag
      className={`bg-white border border-[var(--v2-border)] rounded-[10px] ${shadowClass} ${hoverClass} ${className}`}
    >
      {children}
    </Tag>
  )
}
