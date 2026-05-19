export function entityCardClassName({
  selected = false,
  muted = false,
}: {
  selected?: boolean
  muted?: boolean
} = {}): string {
  const hoverEffect =
    'hover:-translate-y-0.5 hover:border-[var(--v2-brand)]/35 hover:bg-[var(--v2-surface)] hover:shadow-[0_16px_34px_-28px_rgba(42,51,90,0.35)]'

  return [
    'group relative rounded-lg border p-5 shadow-[var(--v2-shadow-card)] transition-all duration-200',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30',
    muted ? 'opacity-80' : '',
    selected
      ? `border-[var(--v2-brand)]/30 bg-[var(--v2-brand)]/[0.03] ${hoverEffect}`
      : `border-[var(--v2-border)] bg-white ${hoverEffect}`,
  ].filter(Boolean).join(' ')
}
