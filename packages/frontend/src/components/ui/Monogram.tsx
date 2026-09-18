import { merchantInitials } from '@/lib/marketplace'

/**
 * Initials-in-a-circle avatar, or the entity's logo when it has one (#3079).
 * The `/contacts` `Initials` avatar was the first copy; the marketplace card
 * and merchant header were the second and third — the third copy is the
 * pattern-absorption trigger (epic #904). Initials: first letter of the first
 * and last word, or the first two letters of a one-word name.
 *
 * `alt=""` on the logo: the name is always printed beside the avatar, so the
 * image is decorative to a screen reader. A plain `<img>` rather than
 * `next/image` because merchant logos are external and not known ahead of
 * time — `next/image`'s static domain allowlist would have to widen per row.
 */
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
  return (
    <div
      className={`flex ${box} flex-shrink-0 items-center justify-center rounded-full border border-brand/20 bg-[var(--v2-brand-soft)]`}
    >
      <span className={`${size === 'md' ? 'text-sm' : 'text-xs'} font-semibold text-[var(--v2-brand)]`}>
        {merchantInitials(name)}
      </span>
    </div>
  )
}
