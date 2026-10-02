'use client'

/**
 * The full-width red prod banner (#3515).
 *
 * Shows on every page whenever `prod` is selected, driven by the selected
 * key — not by a URL, a hostname or anything an operator could accidentally
 * satisfy on the wrong environment. The soft red surface is a token
 * (`--v2-danger-soft`) with `--v2-danger` ink, so it renders correctly in
 * both palettes; no red palette class passes design:lint.
 */
export function ProdBanner({ selectedKey }: { selectedKey: string }) {
  if (selectedKey !== 'prod') return null
  return (
    <div
      role="alert"
      data-testid="prod-banner"
      className="w-full bg-[var(--v2-danger-soft)] px-4 py-2.5 text-center text-[13px] font-medium text-[var(--v2-danger)]"
    >
      You are working in production. Every read you make is audited.
    </div>
  )
}
