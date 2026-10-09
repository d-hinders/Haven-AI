'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { nextPathFromSearch, postAuthDestination, viaMarkerFromSearch } from '@/lib/discovery'
import { ApiRequestError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { AgentHandoffNote } from '@/components/onboarding/AgentHandoffNote'
import { AuthShell, AuthCard } from '@/components/auth/AuthShell'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LENGTH = 255
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const MAX_NAME_LENGTH = 80
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/

type FieldErrors = Partial<Record<'name' | 'email' | 'password' | 'confirmPassword', string>>

/**
 * The signup form (epic #3572, #3578).
 *
 * Copy is the mockup's, minus its two untrue lines: three fields and "At
 * least 12 characters" give way to the real four-field form with the
 * 8-character minimum, and the "created on Base" note is not shipped —
 * sign-up names no chain because the network is picked later, at
 * onboarding, where one account is provisioned on it. The sub-line ("One
 * passkey prompt…") is true of the real flow: onboarding is passkey-only
 * (`app/onboarding/copy.ts`).
 */
function SignupForm() {
  const { signup } = useAuth()
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)

  function validateForm(): { valid: boolean; name: string; email: string } {
    const nextErrors: FieldErrors = {}
    const normalizedName = name.trim().replace(/\s+/g, ' ')
    const normalizedEmail = email.trim().toLowerCase()

    if (!normalizedName) {
      nextErrors.name = 'Enter your name.'
    } else if (normalizedName.length > MAX_NAME_LENGTH || CONTROL_CHAR_RE.test(name)) {
      nextErrors.name = 'Use 80 characters or fewer.'
    }

    if (!normalizedEmail) {
      nextErrors.email = 'Enter your email address.'
    } else if (normalizedEmail.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(normalizedEmail)) {
      nextErrors.email = 'Enter a valid email address.'
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      nextErrors.password = 'Use at least 8 characters.'
    } else if (password.length > MAX_PASSWORD_LENGTH) {
      nextErrors.password = 'Use 128 characters or fewer.'
    }

    if (password !== confirmPassword) {
      nextErrors.confirmPassword = 'Passwords do not match.'
    }

    setFieldErrors(nextErrors)
    return {
      valid: Object.keys(nextErrors).length === 0,
      name: normalizedName,
      email: normalizedEmail,
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const validation = validateForm()
    if (!validation.valid) return

    setSubmitting(true)
    try {
      // #2522: read from `window.location.search` rather than
      // `useSearchParams`, matching `useAgentConnectionSetup`'s existing use of
      // the same source. This page has no Suspense boundary (login does), and
      // both reads happen inside a submit handler — client-only, after
      // hydration — so the hook would buy a restructure and nothing else.
      const search = window.location.search
      const next = nextPathFromSearch(search)
      const u = await signup(
        validation.name,
        validation.email,
        password,
        viaMarkerFromSearch(search),
      )
      router.push(postAuthDestination(Boolean(u.account_address), next))
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message)
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  // The mockup's `.auth-card` type sizes: 26px heading, 14.5px sub, 12.5px
  // labels, 13.5px alt line, and no entrance animation.
  const headingClass =
    '[font-family:var(--font-site-display)] text-[26px] font-semibold tracking-[-0.02em] text-[var(--v2-ink)]'
  const subClass = 'mb-8 mt-1.5 text-[14.5px] text-[var(--v2-ink-2)]'
  const labelClass = 'mb-1.5 block text-[12.5px] font-medium text-[var(--v2-ink-2)]'
  const altClass = 'mt-[18px] text-center text-[13.5px] text-[var(--v2-ink-2)]'

  const card: ReactNode = (
    <>
      <h1 className={headingClass}>
        Create your account
      </h1>
      <p className={subClass}>
        One passkey prompt, no credit card, no setup call.
      </p>

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {error && (
          <div className="rounded-md border border-danger/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="name" className={labelClass}>
            Name
          </label>
          <Input
            id="name"
            type="text"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setFieldErrors((prev) => ({ ...prev, name: undefined }))
            }}
            placeholder="Your name"
            aria-invalid={Boolean(fieldErrors.name)}
            aria-describedby={fieldErrors.name ? 'name-error' : undefined}
          />
          {fieldErrors.name && (
            <p id="name-error" className="mt-1.5 text-xs text-[var(--v2-danger)]">
              {fieldErrors.name}
            </p>
          )}
        </div>

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
            onChange={(e) => {
              setEmail(e.target.value)
              setFieldErrors((prev) => ({ ...prev, email: undefined }))
            }}
            placeholder="you@example.com"
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? 'email-error' : undefined}
          />
          {fieldErrors.email && (
            <p id="email-error" className="mt-1.5 text-xs text-[var(--v2-danger)]">
              {fieldErrors.email}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="password" className={labelClass}>
            Password
          </label>
          <Input
            id="password"
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setFieldErrors((prev) => ({
                ...prev,
                password: undefined,
                confirmPassword: undefined,
              }))
            }}
            placeholder="Min 8 characters"
            aria-invalid={Boolean(fieldErrors.password)}
            aria-describedby={fieldErrors.password ? 'password-error' : undefined}
          />
          {fieldErrors.password && (
            <p id="password-error" className="mt-1.5 text-xs text-[var(--v2-danger)]">
              {fieldErrors.password}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="confirm" className={labelClass}>
            Confirm password
          </label>
          <Input
            id="confirm"
            type="password"
            required
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value)
              setFieldErrors((prev) => ({ ...prev, confirmPassword: undefined }))
            }}
            placeholder="Repeat password"
            aria-invalid={Boolean(fieldErrors.confirmPassword)}
            aria-describedby={fieldErrors.confirmPassword ? 'confirm-error' : undefined}
          />
          {fieldErrors.confirmPassword && (
            <p id="confirm-error" className="mt-1.5 text-xs text-[var(--v2-danger)]">
              {fieldErrors.confirmPassword}
            </p>
          )}
        </div>

        <Button
          type="submit"
          disabled={submitting}
          className="w-full"
        >
          {submitting ? 'Creating account...' : 'Create account'}
        </Button>
      </form>

      <p className={altClass}>
        Already have an account?{' '}
        <Link
          href="/login"
          className="font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
        >
          Sign in
        </Link>
      </p>
    </>
  )

  return <AuthCard>{card}</AuthCard>
}

// The sign-up screen (#3578, epic #3572): the mockup's auth shell (public
// header, quiet ground, one card, agent hand-off line under the card, public
// footer).
export default function SignupPage() {
  return (
    <AuthShell note={<AgentHandoffNote path="/signup" />}>
      <SignupForm />
    </AuthShell>
  )
}
