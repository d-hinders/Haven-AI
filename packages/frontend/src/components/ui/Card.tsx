import type { ReactNode } from 'react'

export function Card({
  children,
  className = '',
  as: Tag = 'div',
  hover = true,
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'article'
  hover?: boolean
}) {
  return (
    <Tag
      className={`bg-white border border-[var(--v2-border)] rounded-[10px] shadow-[var(--v2-shadow-card)] ${hover ? 'hover:shadow-[0_8px_24px_-12px_rgba(16,24,40,0.12)] transition-shadow duration-200' : ''} ${className}`}
    >
      {children}
    </Tag>
  )
}
