'use client'

import { Suspense, useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { postAuthDestination, sanitizeNextPath } from '@/lib/discovery'
import { ApiRequestError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { AgentHandoffNote } from '@/components/onboarding/AgentHandoffNote'
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

  // The mockup's `.auth-card` type sizes (#3578): 26px heading, 14.5px sub,
  // 12.5px labels, 13.5px alt line.
  const headingClass =
    '[font-family:var(--font-site-display)] text-[26px] font-semibold tracking-[-0.02em] text-[var(--v2-ink)]'
  const subClass = 'mt-1.5 mb-8 text-[14.5px] text-[var(--v2-ink-2)]'
  const labelClass = 'mb-1.5 block text-[12.5px] font-medium text-[var(--v2-ink-2)]'
  const altClass = 'mt-[18px] text-center text-[13.5px] text-[var(--v2-ink-2)]'

  const card: ReactNode = (
    <>
      <h1 className={headingClass}>Welcome back</h1>
      <p className={subClass}>Sign in to your Haven account.</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        {justRegistered && !error && (
          <div className="rounded-md border border-success/20 bg-[var(--v2-success-soft)] px-4 py-3 text-sm text-[var(--v2-success)]">
            Account created. Sign in to continue.
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
          {submitting ? 'Signing in...' : 'Sign in'}
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

  return <AuthCard>{card}</AuthCard>
}

/** The Suspense fallback rendered while search params resolve. */
function LoginLoading() {
  return (
    <div className="flex items-center justify-center gap-3">
      <div className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" />
      <span className="text-sm text-[var(--v2-ink-2)]">Loading...</span>
    </div>
  )
}

// The sign-in screen (#3578, epic #3572): the mockup's auth shell (public
// header, quiet ground, one card, agent hand-off line, public footer). The
// hand-off line is passed as the shell's `note`, outside the Suspense
// boundary: `LoginForm` reads `useSearchParams`, so everything inside the
// boundary is the fallback in the server-rendered HTML, and an agent that
// never runs the JavaScript must still read the line (#2524).
export default function LoginPage() {
  return (
    <AuthShell note={<AgentHandoffNote path="/login" />}>
      <Suspense fallback={<LoginLoading />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  )
}
