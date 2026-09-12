'use client'

import { havenEnvironment, isProductionEnvironment } from '@/lib/env'

/**
 * Small environment chip (e.g. "DEV") shown when NEXT_PUBLIC_HAVEN_ENV is set to
 * a non-production value. Renders nothing in production, so it never appears on
 * the live app.
 *
 * NEXT_PUBLIC_* vars are inlined at build time, so each deploy bakes in its own
 * value: the dev Vercel project sets NEXT_PUBLIC_HAVEN_ENV=dev, production leaves
 * it unset. The warning tone makes it unmistakable that you are not on prod.
 *
 * "Unset means production" is read through `lib/env.ts` (#2709) — the same
 * helper the capability manifest reports `environment` from, so the chip and
 * the manifest cannot disagree about which deployment this is.
 */
export default function EnvBadge() {
  if (isProductionEnvironment()) return null
  const env = havenEnvironment()

  return (
    <span
      title={`Haven ${env} environment — not production`}
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]"
    >
      {env}
    </span>
  )
}
