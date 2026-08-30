import Link from 'next/link'
import { forwardRef } from 'react'
import { ArrowRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'tertiary' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const SIZE_CLASS: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-[13px]',
  md: 'h-10 px-4 text-[14px]',
  lg: 'h-11 px-5 text-[15px]',
}

/**
 * Tap-target extension (#1726).
 *
 * `sm` renders 36px tall and `md` 40px — both under the ~44px commonly cited as
 * a comfortable touch target. (Neither is an accessibility failure: WCAG 2.2 AA
 * *Target Size (Minimum)* has a 24px floor. This is comfort and mis-tap rate,
 * which matters most in row lists of destructive actions — the Backup & recovery
 * card's stacked `Remove` buttons at 390px are the case that surfaced it.)
 *
 * Rather than raise the rendered heights — which would move the density of every
 * table, toolbar and row list in the product and require new visual baselines —
 * a transparent pseudo-element extends the *hit area* to 44px while the button
 * still renders at its declared height. Nothing about the painted pixels changes.
 *
 * Deliberately **vertical only**. An `sm` button's width already clears 44px at
 * every real call site (`px-3.5` plus a label), and growing the target sideways
 * would let a button in a tight `gap-2` toolbar swallow clicks meant for its
 * neighbour. The vertical overhang is 4px per edge on `sm` and 2px on `md`,
 * which is within half of the 8px minimum gap this design system uses between
 * stacked controls, so adjacent targets meet but never overlap.
 *
 * `lg` is already 44px and gets nothing.
 */
const TAP_TARGET_CLASS: Record<Size, string> = {
  sm: "relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']",
  md: "relative after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']",
  lg: '',
}

/**
 * Fill and focus-ring TONE travel together (#1817).
 *
 * The ring's width, offset and offset-colour stay in the base string — those are
 * uniform across every variant. Its COLOUR lives here, next to the fill it has
 * to agree with, because a destructive control signals destructive in every
 * state it has: the `danger` variant is a solid `--v2-danger` fill and wore
 * `ring-brand/80` for as long as the ring colour lived in the base string,
 * across four destructive confirmations including the approval queue's reject.
 *
 * Co-locating them is what makes the defect *visible* rather than merely fixed.
 * A per-class-string guard cannot pair a fill in this table with a ring in the
 * base template — that split is exactly why both existing guards were blind to
 * this, and #1798 had to write a bespoke `Button` assertion for the offset rule
 * for the same reason. With the two in one string the general tone rule in
 * `focus-ring.test.ts` now covers `Button` like any other call-site.
 *
 * Do not move the colour back to the base string to "deduplicate" it: three
 * variants repeating `ring-brand/80` is the cost of the fourth being checkable.
 *
 * **A caller-supplied ring colour via `className` is unsupported.** No call-site
 * does it today. If one did, the override would NOT reliably win: both values
 * set `--tw-ring-color`, and which one applies is decided by declaration order
 * in Tailwind's generated stylesheet, not by position in the class attribute —
 * so "mine is last in the markup" is not a rule. Add a variant instead.
 */
const VARIANT_CLASS: Record<Variant, string> = {
  primary:
    'bg-[var(--v2-brand)] text-white hover:bg-[var(--v2-brand-strong)] shadow-button focus-visible:ring-brand/80',
  ghost:
    'bg-white text-[var(--v2-ink)] border border-[var(--v2-border-strong)] hover:bg-[var(--v2-surface)] focus-visible:ring-brand/80',
  tertiary:
    'bg-transparent text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)] focus-visible:ring-brand/80',
  danger:
    'bg-[var(--v2-danger)] text-white hover:bg-danger/90 shadow-button focus-visible:ring-danger/80',
}

type ButtonProps = {
  children: ReactNode
  href?: string
  target?: AnchorHTMLAttributes<HTMLAnchorElement>['target']
  rel?: AnchorHTMLAttributes<HTMLAnchorElement>['rel']
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type']
  /**
   * Associates a submit button with a `<form>` elsewhere in the document, by
   * that form's `id` (#1946).
   *
   * Needed because `ui/Modal`'s `footer` renders OUTSIDE the scrolling body —
   * it is a flex sibling, not a descendant — so a dialog whose fields live in
   * a `<form>` in the body cannot put its submit button in the footer by
   * nesting. The HTML `form` attribute is the standard answer, and it keeps
   * implicit submission (Enter in a text field) working, which rewiring the
   * button to `type="button"` + `onClick` would silently drop.
   *
   * Ignored on the `href` branch below: an anchor has no form owner.
   */
  form?: string
  /**
   * Accessible name, when the visible label alone is not the whole story
   * (#2203). Added so a call site that already carried one on a hand-rolled
   * `<a>` can move onto this primitive without dropping it — which is how the
   * recoverable-funds CTA came to be hand-rolled and 24px tall in the first
   * place: routing through `Button` used to cost an attribute.
   *
   * Keep it a SUPERSET of the visible label rather than a replacement for it
   * (WCAG 2.5.3 Label in Name) — a voice-control user says what they can see.
   */
  'aria-label'?: string
  disabled?: boolean
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick']
  variant?: Variant
  size?: Size
  className?: string
  trailingIcon?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children,
  href,
  target,
  rel,
  type = 'button',
  form,
  'aria-label': ariaLabel,
  disabled,
  onClick,
  variant = 'primary',
  size = 'md',
  className = '',
  trailingIcon,
}, ref) {
  // Ring geometry is uniform and lives here; ring COLOUR is per-variant and
  // lives in VARIANT_CLASS, next to the fill it must agree with (#1817).
  const classes = `inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-tight transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] disabled:cursor-not-allowed disabled:opacity-60 ${SIZE_CLASS[size]} ${TAP_TARGET_CLASS[size]} ${VARIANT_CLASS[variant]} ${className}`
  const content = (
    <>
      {children}
      {trailingIcon && (
        <Icon icon={ArrowRight} className="w-3.5 h-3.5" />
      )}
    </>
  )

  if (!href) {
    return (
      <button ref={ref} type={type} form={form} aria-label={ariaLabel} disabled={disabled} onClick={onClick} className={classes}>
        {content}
      </button>
    )
  }

  return (
    <Link href={href} target={target} rel={rel} aria-label={ariaLabel} className={classes}>
      {content}
    </Link>
  )
})
