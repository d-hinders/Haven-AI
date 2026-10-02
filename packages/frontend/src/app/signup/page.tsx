'use client'

import { Check } from 'lucide-react'
import { SafeAreaBand } from '@/components/ui/SafeAreaBand'
import { Icon } from '@/components/ui/Icon'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { nextPathFromSearch, postAuthDestination, viaMarkerFromSearch } from '@/lib/discovery'
import { ApiRequestError } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { HavenMark } from '@/components/brand/HavenMark'
import { AgentHandoffNote } from '@/components/onboarding/AgentHandoffNote'
import { isNewSiteVisible } from '@/lib/site-gate'
import { AuthShell, AuthCard } from '@/components/auth/AuthShell'

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
  delayMs,
}: {
  title: string
  description: string
  delayMs: number
}) {
  return (
    <div
      className="v2-animate-stagger flex gap-3"
      style={{ ['--v2-stagger-delay' as string]: `${delayMs}ms` }}
    >
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand-soft)] text-[var(--v2-brand)] ring-1 ring-inset ring-brand/20">
        <Icon icon={Check} className="h-3.5 w-3.5" />
      </div>
      <div>
        <p className="text-sm font-medium text-[var(--v2-ink)]">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-3)]">{description}</p>
      </div>
    </div>
  )
}

/**
 * The ONE signup form. Fields, validation, submission and redirect handling
 * live here exactly once; `site` picks only the frame around it — the
 * redesigned card (epic #3572, #3578) or today's card, which production keeps
 * rendering until the switch-over (#3579). The gate is read by the page and
 * passed in, so this component stays presentation-only.
 *
 * Copy on the redesigned frame is the mockup's, minus its two untrue lines:
 * three fields and "At least 12 characters" give way to the real four-field
 * form with the 8-character minimum, and the "created on Base" note is not
 * shipped — sign-up provisions an account on every supported chain, so no
 * chain is named. The sub-line that stays ("One passkey prompt…") is true of
 * the real flow: onboarding is passkey-only (`app/onboarding/copy.ts`).
 */
function SignupForm({ site, note }: { site: boolean; note?: ReactNode }) {
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

  // The redesigned shell picks the card frame and type sizes around the ONE
  // form below. Gate-off values are today's, animation classes included
  // (legacy code is frozen until #3579); gate-on values are the mockup's
  // (`.auth-card`: 26px heading, 14.5px sub, 12.5px labels, 13.5px alt line,
  // no entrance animation on the new frame).
  const headingClass = site
    ? '[font-family:var(--font-site-display)] text-[26px] font-semibold tracking-[-0.02em] text-[var(--v2-ink)]'
    : 'v2-animate-stagger text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-2'
  const headingStyle = site ? undefined : { ['--v2-stagger-delay' as string]: '40ms' }
  const subClass = site
    ? 'mb-8 mt-1.5 text-[14.5px] text-[var(--v2-ink-2)]'
    : 'v2-animate-stagger text-sm text-[var(--v2-ink-2)] mb-8'
  const subStyle = site ? undefined : { ['--v2-stagger-delay' as string]: '120ms' }
  const labelClass = site
    ? 'mb-1.5 block text-[12.5px] font-medium text-[var(--v2-ink-2)]'
    : 'mb-1.5 block text-xs font-medium text-[var(--v2-ink-2)]'
  const formClass = site ? 'space-y-4' : 'v2-animate-stagger space-y-4'
  const formStyle = site ? undefined : { ['--v2-stagger-delay' as string]: '200ms' }
  const altClass = site
    ? 'mt-[18px] text-center text-[13.5px] text-[var(--v2-ink-2)]'
    : 'mt-6 text-center text-sm text-[var(--v2-ink-2)]'

  const card: ReactNode = (
    <>
      <h1 className={headingClass} style={headingStyle}>
        {site ? 'Create your account' : 'Create your Haven account'}
      </h1>
      <p className={subClass} style={subStyle}>
        {site
          ? 'One passkey prompt, no credit card, no setup call.'
          : 'One account, agents that spend within rules you set.'}
      </p>

      <form onSubmit={handleSubmit} noValidate className={formClass} style={formStyle}>
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
          Log in
        </Link>
      </p>
    </>
  )

  return site ? (
    <AuthCard>{card}</AuthCard>
  ) : (
    <div className="v2-animate-step-rise rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-6 shadow-card">
      {card}
      {note}
    </div>
  )
}

// The redesigned sign-up screen (#3578, epic #3572): the mockup's auth shell
// (public header, quiet ground, one card, agent hand-off line under the card,
// public footer). The gate is decided here, at the page, so the legacy screen
// below keeps rendering exactly what production serves today until #3579.
export default function SignupPage() {
  if (isNewSiteVisible()) {
    return (
      <AuthShell note={<AgentHandoffNote path="/signup" />}>
        <SignupForm site />
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

      <div className="relative z-10 flex-1 flex items-center justify-center px-6 py-16">
        <div className="grid w-full max-w-4xl gap-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-center">
          <SignupForm site={false} note={<AgentHandoffNote path="/signup" />} />

          <div
            className="v2-animate-stagger rounded-[14px] border border-[var(--v2-border)] bg-bg/85 p-6 shadow-card"
            style={{ ['--v2-stagger-delay' as string]: '120ms' }}
          >
            <p
              className="v2-animate-stagger text-xs font-medium uppercase tracking-widest text-[var(--v2-ink-3)]"
              style={{ ['--v2-stagger-delay' as string]: '180ms' }}
            >
              What you&apos;re signing up for
            </p>
            <div className="mt-5 space-y-5">
              <TrustRow
                delayMs={260}
                title="An account wallet you own"
                description="Create it with a passkey or your existing wallet. You hold the funds, and Haven never does."
              />
              <TrustRow
                delayMs={340}
                title="Agents that ask, then act"
                description="Set budgets and reset periods. Anything over that limit is declined before any money moves."
              />
              <TrustRow
                delayMs={420}
                title="No surprises in production"
                description="Every payment is logged with the agent, the policy, and the outcome, so the trail is auditable from day one."
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
