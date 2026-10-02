import Link from 'next/link'
import type { ReactNode } from 'react'
import { TrailingArrow } from '@/components/marketing/TrailingArrow'
import { SITE_FONT_VARIABLES } from './fonts'
import { SITE_TYPE, SITE_WRAP } from './SiteSection'

/**
 * Building blocks the redesigned public pages share (#3576, epic #3572), each
 * one a mockup class from `docs/product/site-mockup/site.css` drawn with theme
 * tokens, so white and tinted grounds take their dark forms and the fixed
 * navy pieces stay fixed (epic decision 7, the #1867 band doctrine).
 */

/**
 * The compact navy hero (mockup `.hero.hero-compact`): fixed navy with the
 * mockup's indigo/violet washes and dot grid, fixed white ink. Marked
 * `data-v2-dark-section`, so an `overlay` header over it takes the on-dark
 * tone. Its top padding clears that overlay header.
 */
export function SiteHero({
  eyebrow,
  title,
  lede,
  crumb,
  titleId,
}: {
  eyebrow: string
  title: ReactNode
  lede: ReactNode
  /** A breadcrumb back to the parent page, e.g. How it works › Protocols. */
  crumb?: { label: string; href: string; current: string }
  titleId?: string
}) {
  return (
    <section
      data-v2-dark-section=""
      data-site-ground="navy"
      aria-labelledby={titleId}
      className={`${SITE_FONT_VARIABLES} relative overflow-hidden bg-[#0e1230] pb-[72px] pt-[132px] [--site-ink:#ffffff] [--site-ink-2:rgba(255,255,255,0.76)] [--site-eyebrow:#a5b4fc]`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(60% 55% at 12% 8%, rgba(99,102,241,0.55) 0%, transparent 60%), radial-gradient(45% 50% at 78% 18%, rgba(139,92,246,0.42) 0%, transparent 60%), radial-gradient(50% 45% at 55% 100%, rgba(56,189,248,0.16) 0%, transparent 60%), linear-gradient(180deg, #141a4a 0%, #0e1230 70%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.14]"
        style={{
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage: 'radial-gradient(70% 60% at 30% 20%, #000 0%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(70% 60% at 30% 20%, #000 0%, transparent 75%)',
        }}
      />
      <div className={`${SITE_WRAP} relative`}>
        {crumb && (
          <nav aria-label="Breadcrumb" className="mb-[18px] text-[13px] text-[rgba(255,255,255,0.6)]">
            <Link
              href={crumb.href}
              className="rounded-[4px] transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0e1230]"
            >
              {crumb.label}
            </Link>
            <span aria-hidden="true"> › </span>
            <span aria-current="page">{crumb.current}</span>
          </nav>
        )}
        <p className={SITE_TYPE.eyebrow}>{eyebrow}</p>
        <h1 id={titleId} className={`${SITE_TYPE.h1} !text-[length:clamp(36px,5vw,56px)]`}>
          {title}
        </h1>
        <p className={`${SITE_TYPE.lede} mt-[22px] !max-w-[60ch]`}>{lede}</p>
      </div>
    </section>
  )
}

/** Two columns that stack below 900px (mockup `.split`). */
export function SiteSplit({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-14 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {children}
    </div>
  )
}

/** A section's text column: eyebrow, heading, lede (mockup `.split > div`). */
export function SiteCopy({
  eyebrow,
  title,
  titleId,
  children,
}: {
  eyebrow: string
  title: ReactNode
  titleId?: string
  children?: ReactNode
}) {
  return (
    <div>
      <p className={SITE_TYPE.eyebrow}>{eyebrow}</p>
      <h2 id={titleId} className={SITE_TYPE.h2}>
        {title}
      </h2>
      {children}
    </div>
  )
}

/** A lede paragraph under a section heading. */
export function SiteLede({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`${SITE_TYPE.lede} mt-[18px] ${className}`}>{children}</p>
}

/**
 * An inline text link with a trailing arrow, on a themed ground. The arrow is
 * decorative (`TrailingArrow` is `aria-hidden`), so the link's name is its text.
 */
export function SiteTextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-[4px] font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]"
    >
      {children}
      <TrailingArrow />
    </Link>
  )
}

/** The CTA row under a heading (mockup `.cta-row`). */
export function SiteCtaRow({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return <div className={`mt-8 flex flex-wrap gap-3 ${center ? 'justify-center' : ''}`}>{children}</div>
}

type FlowTone = 'neutral' | 'warning' | 'brand' | 'success'

const FLOW_TONE: Record<FlowTone, string> = {
  neutral: 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]',
  warning: 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]',
  brand: 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]',
  success: 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]',
}

export type FlowStep = { tone: FlowTone; title: ReactNode; detail: ReactNode }

/**
 * A numbered payment flow (mockup `.flow`): a card with a head row and an
 * ordered list. It is an illustration of one payment, so it is a real list
 * with real text, not an image.
 */
export function PaymentFlow({
  label,
  amount,
  steps,
}: {
  label: ReactNode
  amount: ReactNode
  steps: ReadonlyArray<FlowStep>
}) {
  return (
    <div className="w-full overflow-hidden rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 text-[12.5px] text-[var(--v2-ink-3)]">
        <span>{label}</span>
        <span className={SITE_TYPE.mono}>{amount}</span>
      </div>
      <ol className="px-4 py-1.5">
        {steps.map((step, i) => (
          <li
            key={i}
            className="grid grid-cols-[22px_1fr] gap-3 border-t border-[var(--v2-border)] py-[11px] text-[13.5px] first:border-t-0"
          >
            <span
              aria-hidden="true"
              className={`grid h-[22px] w-[22px] place-items-center rounded-full text-[11px] font-semibold ${FLOW_TONE[step.tone]}`}
            >
              {i + 1}
            </span>
            <div>
              <b className="block font-semibold text-[var(--v2-ink)]">{step.title}</b>
              <small className={`${SITE_TYPE.mono} mt-0.5 block text-[11.5px] text-[var(--v2-ink-3)]`}>
                {step.detail}
              </small>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** One agent with its budget bar (mockup `.agent-row`), for use inside a `ProductFrame`. */
export function AgentBudgetRow({
  name,
  role,
  used,
  total,
  meta,
}: {
  name: string
  role: string
  used: string
  total: string
  meta: ReactNode
}) {
  const pct = Math.max(1, Math.round((Number(used) / Number(total)) * 100))
  return (
    <div className="border-t border-[var(--v2-border)] py-3 first:border-t-0 first:pt-0">
      <div className="whitespace-nowrap text-[14px] font-semibold text-[var(--v2-ink)]">
        <span aria-hidden="true" className="mr-[7px] inline-block h-2 w-2 rounded-full bg-[var(--v2-success)] align-[1px]" />
        {name}
        <span className="ml-1.5 font-normal text-[var(--v2-ink-3)]">{role}</span>
      </div>
      <div className="mt-1.5 flex justify-between text-[12.5px]">
        <b className="font-semibold tabular-nums text-[var(--v2-ink)]">
          {used} of {total} USDC
        </b>
        <span className="tabular-nums text-[var(--v2-ink-3)]">{pct}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--v2-surface-2)]">
        <i className="block h-full rounded-full bg-[var(--v2-brand)]" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 text-[12px] text-[var(--v2-ink-3)]">{meta}</div>
    </div>
  )
}

/** A status pill inside a frame (mockup `.pill-ok`). */
export function FramePill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[22px] items-center whitespace-nowrap rounded-full bg-[var(--v2-success-soft)] px-2 text-[11.5px] font-medium text-[var(--v2-success)]">
      {children}
    </span>
  )
}

/**
 * A code block (mockup `.code`): fixed navy with fixed light ink in both
 * themes, like a terminal. `CodePrompt` marks the `$` the way the mockup does.
 * It wraps rather than scrolls: inside a product frame the body is `inert`,
 * so a horizontal scroll could never be reached and a long line would clip.
 */
export function SiteCode({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={`${SITE_TYPE.mono} whitespace-pre-wrap break-words bg-[#0e1230] px-3.5 py-3 text-[12px] leading-[1.7] text-[#e6e9ff] ${className}`}
    >
      {children}
    </pre>
  )
}

export function CodePrompt() {
  return (
    <span aria-hidden="true" className="text-[#a5b4fc]">
      ${' '}
    </span>
  )
}

/** A card on the navy band (mockup `.band .card`): fixed navy-2, fixed ink. */
export function NavyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-[rgba(255,255,255,0.12)] bg-[#161b3f] p-6">
      <h3 className={`${SITE_TYPE.h3} mb-2.5 !text-white`}>{title}</h3>
      <p className="text-[15px] text-[rgba(255,255,255,0.72)]">{children}</p>
    </div>
  )
}

/** A protocol card (mockup `.side`), on a themed ground. */
export function SideCard({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-[26px]">
      <p className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--v2-ink-3)]">{kicker}</p>
      <h3 className={`${SITE_TYPE.h3} mb-2.5 !text-[19px]`}>{title}</h3>
      <p className="text-[15px] text-[var(--v2-ink-2)]">{children}</p>
    </div>
  )
}
