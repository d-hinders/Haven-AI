'use client'

import type { ReactNode } from 'react'
import { Header } from '@/components/marketing/site/Header'
import { Footer } from '@/components/marketing/site/Footer'
import { SITE_FONT_VARIABLES } from '@/components/marketing/site/fonts'

/**
 * The redesigned sign-in and sign-up shell (epic #3572, slice #3578).
 *
 * The mockup's auth screen (`docs/product/site-mockup/signin.html`,
 * `signup.html`) is the public header, a quiet ground with a soft radial
 * tint, one centred card, the agent hand-off line under the card, and the
 * public footer. This component renders that frame; the page renders its
 * form INTO it, so each form still has exactly one copy of its fields and
 * submit handler.
 *
 * Lives under `components/auth/` — deliberately OUTSIDE `components/marketing/`
 * and `components/brand/`, which design-lint exempts from the token rules
 * (#874): an authentication surface stays under the product's token and
 * structure gates.
 *
 * Every colour reads a theme token, so the ground, card and note take their
 * dark forms with the visitor's theme (epic decision 7). The radial tint is
 * the mockup's `.auth` gradient with its literal `#eef2ff` swapped for
 * `--v2-brand-soft` — the same colour in the light palette, a theme token so
 * the dark theme gets its own soft value instead of a light-only glow.
 */
export function AuthShell({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div
      className={`${SITE_FONT_VARIABLES} flex min-h-screen flex-col bg-[var(--v2-bg)] text-[var(--v2-ink)]`}
    >
      <Header />
      <main className="flex flex-1 flex-col">
        <section
          className="relative flex flex-1 items-center justify-center px-6 pb-20 pt-[120px] md:pb-24"
          style={{
            background:
              'radial-gradient(60% 50% at 50% 0%, var(--v2-brand-soft) 0%, transparent 70%)',
          }}
        >
          <div className="w-full max-w-[400px]">
            {children}
            {note}
          </div>
        </section>
      </main>
      <Footer />
    </div>
  )
}

/**
 * The mockup's auth card (`.auth-card`): 14px radius, raised shadow, 32px
 * padding. The frame is chrome — the fields, validation and submission stay
 * in the page's one form component, which renders as this card's content.
 */
export function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-8 shadow-card-raised">
      {children}
    </div>
  )
}
