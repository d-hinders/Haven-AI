'use client'

import { Suspense, useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { SafeAreaBand } from '@/components/ui/SafeAreaBand'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { postAuthDestination, sanitizeNextPath } from '@/lib/discovery'
import { ApiRequestError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { HavenMark } from '@/components/brand/HavenMark'
import { AgentHandoffNote } from '@/components/onboarding/AgentHandoffNote'
import { isNewSiteVisible } from '@/lib/site-gate'
import { AuthShell, AuthCard } from '@/components/auth/AuthShell'

function LoginForm() {
  const { login, user, loading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const justRegistered = searchParams.get('registered') === '1'

  // #2522: the hand-off target, sanitised to a same-origin path. An agent may
  // paste `/login?next=/agents%3Fsetup%3D…` for a user who already has an
  // account, and the link is worth nothing if signing in forgets it.
  const nextPath = sanitizeNextPath(searchParams.get('next'))

  // Redirect if already logged in
  useEffect(() => {
    if (!loading && user) {
      router.replace(
        postAuthDestination(Boolean(user.accounts?.length > 0 || user.account_address), nextPath),
      )
    }
  }, [loading, user, router, nextPath])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const u = await login(email, password)
      router.push(postAuthDestination(Boolean(u.account_address), nextPath))
    } catch (err) {
      // Generic message — don't surface raw backend errors here (prevents
      // account-enumeration: "user not found" vs "wrong password").
      if (err instanceof ApiRequestError && err.status >= 500) {
        setError('Something went wrong on our end. Please try again.')
      } else {
        setError('Invalid email or password.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  // The redesigned shell (#3578, epic #3572) picks the card frame and the
  // type sizes around the ONE form below — fields, validation, submission and
  // redirect handling are the same JSX whichever branch renders. Class values
  // for the gate-off branch are today's, unchanged (legacy code is frozen
  // until the switch-over, #3579); gate-on values are the mockup's
  // (`.auth-card`: 26px heading, 14.5px sub, 12.5px labels, 13.5px alt line).
  const site = isNewSiteVisible()
  const headingClass = site
    ? '[font-family:var(--font-site-display)] text-[26px] font-semibold tracking-[-0.02em] text-[var(--v2-ink)]'
    : 'text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2'
  const subClass = site
    ? 'mt-1.5 mb-8 text-[14.5px] text-[var(--v2-ink-2)]'
    : 'text-sm text-[var(--v2-ink-2)] mb-8'
  const labelClass = site
    ? 'mb-1.5 block text-[12.5px] font-medium text-[var(--v2-ink-2)]'
    : 'mb-1.5 block text-xs font-medium text-[var(--v2-ink-2)]'
  const altClass = site
    ? 'mt-[18px] text-center text-[13.5px] text-[var(--v2-ink-2)]'
    : 'mt-6 text-center text-sm text-[var(--v2-ink-2)]'

  const card: ReactNode = (
    <>
      <h1 className={headingClass}>Welcome back</h1>
      <p className={subClass}>Log in to your Haven account.</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        {justRegistered && !error && (
          <div className="rounded-md border border-success/20 bg-[var(--v2-success-soft)] px-4 py-3 text-sm text-[var(--v2-success)]">
            Account created. Log in to continue.
          </div>
        )}

        {error && (
          <div className="rounded-md border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="email" className={labelClass}>
            Email
          </label>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>

        <div>
          <label htmlFor="password" className={labelClass}>
            Password
          </label>
          <Input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <Button
          type="submit"
          disabled={submitting}
          className="w-full"
        >
          {submitting ? 'Logging in...' : 'Log in'}
        </Button>
      </form>

      <p className={altClass}>
        {"Don't have an account?"}{' '}
        <Link
          href="/signup"
          className="font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
        >
          Sign up
        </Link>
      </p>
    </>
  )

  return site ? (
    <AuthCard>{card}</AuthCard>
  ) : (
    <div className="w-full max-w-sm rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-6 shadow-card">
      {card}
    </div>
  )
}

/** The Suspense fallback both shells render while search params resolve. */
function LoginLoading() {
  return (
    <div className="flex items-center justify-center gap-3">
      <div className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" />
      <span className="text-sm text-[var(--v2-ink-2)]">Loading...</span>
    </div>
  )
}

// The redesigned sign-in screen (#3578, epic #3572): the mockup's auth shell
// (public header, quiet ground, one card, agent hand-off line, public
// footer). The gate is decided here, at the page, so the legacy screen below
// keeps rendering exactly what production serves today until #3579.
export default function LoginPage() {
  if (isNewSiteVisible()) {
    return (
      <AuthShell note={<AgentHandoffNote path="/login" />}>
        <Suspense fallback={<LoginLoading />}>
          <LoginForm />
        </Suspense>
      </AuthShell>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--v2-bg)] text-[var(--v2-ink)] flex flex-col">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 55% at 50% -10%, rgba(99,102,241,0.13) 0%, transparent 70%), radial-gradient(ellipse 70% 60% at 100% 10%, rgba(14,165,233,0.08) 0%, transparent 65%)',
        }}
      />

      {/*
        Safe-area inset (#2730). `viewport-fit=cover` is on the ROOT viewport
        export, so its blast radius is every route, not just the authenticated
        shell — and this is the first screen a freshly installed app shows, and
        every launch after a session expires. Without the padding the brand link
        renders under the status bar. Unchanged where the inset is 0.
      */}
      <div className="relative z-10">
        <SafeAreaBand />
        <div className="border-b border-[var(--v2-border)] bg-bg/80 backdrop-blur-md">
          <div className="max-w-6xl mx-auto px-6 h-14 flex items-center">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight text-[var(--v2-ink)]"
            >
              <HavenMark />
              Haven
            </Link>
          </div>
        </div>
      </div>

      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <Suspense fallback={<LoginLoading />}>
            <LoginForm />
          </Suspense>

          {/* #2524: an agent that reaches this form cannot get past it — the
              password is the user's. Say so here rather than leaving the agent
              to guess, and hand it the link to send.

              OUTSIDE the Suspense boundary on purpose. `LoginForm` reads
              `useSearchParams`, so everything inside the boundary is replaced
              by the fallback in the server-rendered HTML — a `curl` of
              `/login` sees "Loading…" and nothing else. This line has to be
              real page content for an agent that never runs the JavaScript,
              and it needs no search params to render, so it sits out here.
              Verified against `.next/server/app/login.html`. */}
          <AgentHandoffNote path="/login" />
        </div>
      </div>
    </div>
  )
}
