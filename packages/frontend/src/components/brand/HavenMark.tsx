'use client'

interface HavenMarkProps {
  tone?: 'brand' | 'inverse'
  className?: string
}

export function HavenMark({ tone = 'brand', className = 'h-5 w-5' }: HavenMarkProps) {
  const inverse = tone === 'inverse'

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
    >
      <rect
        x="2"
        y="2"
        width="20"
        height="20"
        rx="6"
        className={inverse ? 'fill-white/20 stroke-white/30' : 'fill-[var(--v2-brand)]'}
        strokeWidth={inverse ? 1 : 0}
      />
      <path
        d="M8 7.5v9M16 7.5v9M8 12h8"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
