export function entityCardClassName({
  selected = false,
  muted = false,
}: {
  selected?: boolean
  muted?: boolean
} = {}): string {
  const hoverEffect =
    'hover:-translate-y-0.5 hover:border-brand/35 hover:bg-[var(--v2-surface)] hover:shadow-[0_16px_34px_-28px_rgba(42,51,90,0.35)]'

  return [
    'group relative rounded-lg border p-5 shadow-[var(--v2-shadow-card)] transition-all duration-200',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80',
    muted ? 'opacity-80' : '',
    // #1709: the selected state had NO visual effect at all. Both halves were
    // the dead bare-var()-with-opacity shape, so the active-account indicator
    // on the accounts overview rendered neither its border nor its tint.
    //
    // The `bg-` half is nominally #1710's, and is fixed here anyway for a
    // specific reason: it uses a BRACKETED opacity (`/[0.03]`), and every grep
    // in epic #1685 — the census, #1710's enumeration, and #1710's own
    // acceptance criterion — matches `/[0-9]+`, which cannot match `/[`. It is
    // the only bracketed instance in the tree, so it would have survived the
    // whole epic and #1710 would have closed green with it still dead. Fixing
    // only the border would also leave this exact component half-fixed, which
    // is the failure mode #1708 was careful to flag rather than create.
    selected
      ? `border-brand/30 bg-brand/[0.03] ${hoverEffect}`
      : `border-[var(--v2-border)] bg-white ${hoverEffect}`,
  ].filter(Boolean).join(' ')
}
