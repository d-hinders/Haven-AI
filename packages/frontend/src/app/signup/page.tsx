'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { ApiRequestError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { HavenMark } from '@/components/brand/HavenMark'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAIL_LENGTH = 255
const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const MAX_NAME_LENGTH = 80
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/

type FieldErrors = Partial<Record<'name' | 'email' | 'password' | 'confirmPassword', string>>

function TrustRow({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--v2-success-soft)] text-[var(--v2-success)]">
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium text-[var(--v2-ink)]">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-3)]">{description}</p>
      </div>
    </div>
  )
}

export default function SignupPage() {
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
      const u = await signup(validation.name, validation.email, password)
      if (u.safe_address) {
        router.push('/dashboard')
      } else {
        router.push('/onboarding')
      }
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
        <div className="grid w-full max-w-4xl gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-center">
          <div className="rounded-[14px] border border-[var(--v2-border)] bg-white p-6 shadow-[var(--v2-shadow-card)]">
            <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
              Create your account
            </h1>
            <p className="text-sm text-[var(--v2-ink-2)] mb-8">
              Set up Haven, then create your first account with a passkey or connected wallet.
            </p>

            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              {error && (
                <div className="rounded-md border border-[var(--v2-danger)]/20 bg-[var(--v2-danger-soft)] px-4 py-3 text-sm text-[var(--v2-danger)]">
                  {error}
                </div>
              )}

              <div>
                <label
                  htmlFor="name"
                  className="block text-xs font-medium text-[var(--v2-ink-2)] mb-1.5"
                >
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
                <label
                  htmlFor="confirm"
                  className="block text-xs font-medium text-[var(--v2-ink-2)] mb-1.5"
                >
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

            <p className="mt-6 text-center text-sm text-[var(--v2-ink-2)]">
              Already have an account?{' '}
              <Link
                href="/login"
                className="font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
              >
                Log in
              </Link>
            </p>
          </div>

          <div className="rounded-[14px] border border-[var(--v2-border)] bg-white/85 p-6 shadow-[var(--v2-shadow-card)]">
            <p className="text-xs font-medium uppercase tracking-widest text-[var(--v2-ink-3)]">
              What happens next
            </p>
            <div className="mt-5 space-y-5">
              <TrustRow
                title="Create an account wallet"
                description="Use a passkey or wallet to create the account that will hold funds."
              />
              <TrustRow
                title="You stay in control"
                description="Haven applies rules for agents; it does not hold unrestricted payment credentials."
              />
              <TrustRow
                title="Start with clear limits"
                description="Connect agents only after you choose budgets, networks, and spend rules."
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
