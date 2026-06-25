'use client'

/**
 * Small environment chip (e.g. "DEV") shown when NEXT_PUBLIC_HAVEN_ENV is set to
 * a non-production value. Renders nothing in production, so it never appears on
 * the live app.
 *
 * NEXT_PUBLIC_* vars are inlined at build time, so each deploy bakes in its own
 * value: the dev Vercel project sets NEXT_PUBLIC_HAVEN_ENV=dev, production leaves
 * it unset. The warning tone makes it unmistakable that you are not on prod.
 */
export default function EnvBadge() {
  const env = process.env.NEXT_PUBLIC_HAVEN_ENV?.trim()
  if (!env || env === 'production' || env === 'prod') return null

  return (
    <span
      title={`Haven ${env} environment — not production`}
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]"
    >
      {env}
    </span>
  )
}
