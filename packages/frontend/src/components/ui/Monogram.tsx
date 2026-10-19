import { merchantInitials } from '@/lib/marketplace'
import { avatarTint } from '@/lib/avatar-tint'

/**
 * Initials-in-a-circle avatar, or the entity's logo when it has one (#3079).
 * The `/contacts` `Initials` avatar was the first copy; the marketplace card
 * and merchant header were the second and third — the third copy is the
 * pattern-absorption trigger (epic #904). Initials: first letter of the first
 * and last word, or the first two letters of a one-word name.
 *
 * The initials variant is tinted from the entity's NAME (#4066): one of six
 * muted `--v2-avatar-*` tints picked by `avatarTint` (a pure hash of the
 * trimmed name — djb2 mod 6), so the same entity keeps the same colour
 * everywhere and neighbouring rows are told apart at a glance. Assignment is
 * by name, never by index, and never from a status or `--v2-series-*` chart
 * colour. Logos are untinted.
 *
 * `alt=""` on the logo: the name is always printed beside the avatar, so the
 * image is decorative to a screen reader. A plain `<img>` rather than
 * `next/image` because merchant logos are external and not known ahead of
 * time — `next/image`'s static domain allowlist would have to widen per row.
 */

/**
 * Literal classes per tint. Tailwind's JIT cannot see an interpolated
 * `bg-[var(--v2-avatar-${n})]` — the class has to appear verbatim in source
 * to compile — so the six are pinned string-by-string (1: terracotta,
 * 2: teal, 3: violet, 4: moss, 5: rose, 6: steel).
 */
const TINT_CLASSES: Record<number, { bg: string; ink: string }> = {
  1: { bg: 'bg-[var(--v2-avatar-1-soft)]', ink: 'text-[var(--v2-avatar-1)]' },
  2: { bg: 'bg-[var(--v2-avatar-2-soft)]', ink: 'text-[var(--v2-avatar-2)]' },
  3: { bg: 'bg-[var(--v2-avatar-3-soft)]', ink: 'text-[var(--v2-avatar-3)]' },
  4: { bg: 'bg-[var(--v2-avatar-4-soft)]', ink: 'text-[var(--v2-avatar-4)]' },
  5: { bg: 'bg-[var(--v2-avatar-5-soft)]', ink: 'text-[var(--v2-avatar-5)]' },
  6: { bg: 'bg-[var(--v2-avatar-6-soft)]', ink: 'text-[var(--v2-avatar-6)]' },
}

export function Monogram({
  name,
  logoUrl = null,
  size = 'sm',
}: {
  name: string
  logoUrl?: string | null
  /** `sm` — a 36px list/card avatar; `md` — a 48px page-header avatar. */
  size?: 'sm' | 'md'
}) {
  const box = size === 'md' ? 'h-12 w-12' : 'h-9 w-9'
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- see the docblock
      <img
        src={logoUrl}
        alt=""
        className={`${box} flex-shrink-0 rounded-full border border-[var(--v2-border)] object-cover`}
      />
    )
  }
  const tint = TINT_CLASSES[avatarTint(name)]
  return (
    <div
      className={`flex ${box} flex-shrink-0 items-center justify-center rounded-full border border-[var(--v2-border)] ${tint.bg}`}
    >
      <span className={`${size === 'md' ? 'text-sm' : 'text-xs'} font-semibold ${tint.ink}`}>
        {merchantInitials(name)}
      </span>
    </div>
  )
}
