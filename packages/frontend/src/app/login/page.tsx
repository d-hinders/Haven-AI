'use client'

import { Suspense, useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { ApiRequestError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { HavenMark } from '@/components/brand/HavenMark'

function LoginForm() {
  const { login, user, loading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const justRegistered = searchParams.get('registered') === '1'

  // Redirect if already logged in
  useEffect(() => {
    if (!loading && user) {
      if (user.safes?.length > 0 || user.safe_address) {
        router.replace('/dashboard')
      } else {
        router.replace('/onboarding')
      }
    }
  }, [loading, user, router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const u = await login(email, password)
      if (u.safe_address) {
        router.push('/dashboard')
      } else {
        router.push('/onboarding')
      }
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

  return (
    <div className="w-full max-w-sm rounded-[14px] border border-[var(--v2-border)] bg-white p-6 shadow-[var(--v2-shadow-card)]">
      <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">Welcome back</h1>
      <p className="text-sm text-[var(--v2-ink-2)] mb-8">Log in to your Haven account.</p>

      <form onSubmit={handleSubmit} className="space-y-4">
        {justRegistered && !error && (
          <div className="rounded-md border border-[var(--v2-success)]/20 bg-[var(--v2-success-soft)] px-4 py-3 text-sm text-[var(--v2-success)]">
            Account created. Log in to continue.
          </div>
        )}

        {error && (
          <div className="rounded-md border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
            {error}
          </div>
        )}

        <div>
          <label
            htmlFor="email"
            className="block text-xs font-medium text-[var(--v2-ink-2)] mb-1.5"
          >
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
          <label
            htmlFor="password"
            className="block text-xs font-medium text-[var(--v2-ink-2)] mb-1.5"
          >
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

      <p className="mt-6 text-center text-sm text-[var(--v2-ink-2)]">
        {"Don't have an account?"}{' '}
        <Link
          href="/signup"
          className="font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
        >
          Sign up
        </Link>
      </p>
    </div>
  )
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-[var(--v2-bg)] text-[var(--v2-ink)] flex flex-col">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 55% at 50% -10%, rgba(99,102,241,0.13) 0%, transparent 70%), radial-gradient(ellipse 70% 60% at 100% 10%, rgba(14,165,233,0.08) 0%, transparent 65%)',
        }}
      />

      <div className="relative z-10 border-b border-[var(--v2-border)] bg-white/80 backdrop-blur-md">
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

      <div className="relative z-10 flex-1 flex items-center justify-center px-6 py-16">
        <Suspense
          fallback={
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-[var(--v2-brand)] animate-pulse" />
              <span className="text-sm text-[var(--v2-ink-2)]">Loading...</span>
            </div>
          }
        >
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}
