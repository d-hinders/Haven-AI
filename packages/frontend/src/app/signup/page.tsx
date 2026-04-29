'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { ApiRequestError } from '@/lib/api'

export default function SignupPage() {
  const { signup } = useAuth()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setSubmitting(true)
    try {
      const u = await signup(email, password)
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
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed] flex flex-col">
      {/* Subtle gradient background */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.12) 0%, transparent 70%)',
        }}
      />

      {/* Top bar */}
      <div className="relative z-10 border-b border-white/[0.06] bg-[#0a0a0a]/80 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center">
          <Link
            href="/"
            className="text-[15px] font-semibold tracking-tight bg-gradient-to-r from-white to-indigo-200 bg-clip-text text-transparent"
          >
            Haven
          </Link>
        </div>
      </div>

      {/* Form */}
      <div className="relative z-10 flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-bold tracking-tight mb-2">
            Create your account
          </h1>
          <p className="text-sm text-zinc-500 mb-8">
            Get started with Haven in minutes.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-4 py-3">
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor="email"
                className="block text-xs text-zinc-400 mb-1.5"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-md text-sm text-[#ededed] placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-xs text-zinc-400 mb-1.5"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-md text-sm text-[#ededed] placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                placeholder="Min 8 characters"
              />
            </div>

            <div>
              <label
                htmlFor="confirm"
                className="block text-xs text-zinc-400 mb-1.5"
              >
                Confirm password
              </label>
              <input
                id="confirm"
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/[0.08] rounded-md text-sm text-[#ededed] placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                placeholder="Repeat password"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-md bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-medium hover:from-indigo-400 hover:to-violet-500 transition-all duration-200 shadow-lg shadow-indigo-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Creating account...' : 'Create account'}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-zinc-500">
            Already have an account?{' '}
            <Link
              href="/login"
              className="text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Log in
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
