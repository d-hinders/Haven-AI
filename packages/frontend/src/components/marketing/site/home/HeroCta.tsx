import Link from 'next/link'
import type { ReactNode } from 'react'
import { TrailingArrow } from '@/components/marketing/TrailingArrow'

/**
 * The hero's call-to-action pair, on the fixed navy hero (#3574).
 *
 * The closing band reuses `BrandBandButton`, whose ring is offset onto
 * `--v2-brand` — the treatment the retargeted e2e focus gate asserts there.
 * The hero needs the same ring geometry with its offset on the HERO's own
 * navy (`#0e1230`), which is why this is a local pair rather than a
 * `BrandBandButton` prop: that primitive's documented premise is "the band's
 * brand ground", and the hero is not one.
 *
 * Same tone arithmetic as `BrandBandButton` § The focus ring: the ring is
 * white at /80 because brand indigo tops out below 3:1 on a dark fill; the
 * offset is the band so the ring is not painted onto itself.
 */
const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-tight transition-colors h-11 px-[18px] text-[15px] whitespace-nowrap ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e1230]'

const VARIANT_CLASS = {
  solid: 'bg-white text-[#0e1230] hover:bg-[#eef2ff]',
  ghost: 'border border-white/25 text-white hover:bg-white/10',
} as const

export function HeroCta({
  href,
  variant,
  children,
  trailingArrow,
}: {
  href: string
  variant: keyof typeof VARIANT_CLASS
  children: React.ReactNode
  trailingArrow?: boolean
}) {
  return (
    <Link href={href} className={`${BASE} ${VARIANT_CLASS[variant]}`}>
      {children}
      {trailingArrow && <TrailingArrow />}
    </Link>
  )
}
