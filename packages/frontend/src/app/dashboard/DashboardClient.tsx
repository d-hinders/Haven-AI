'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { ConnectButton } from '@rainbow-me/rainbowkit'

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function DashboardClient() {
  const { user, loading, logout } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login')
    }
  }, [loading, user, router])

  useEffect(() => {
    if (!loading && user && !user.safe_address) {
      router.replace('/onboarding')
    }
  }, [loading, user, router])

  if (loading || !user || !user.safe_address) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
          <span className="text-sm text-zinc-500">Loading...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed]">
      {/* Background gradient */}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[500px] z-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.10) 0%, transparent 70%)',
        }}
      />

      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-white/[0.06] backdrop-blur-md bg-[#0a0a0a]/80">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link
            href="/dashboard"
            className="text-[15px] font-semibold tracking-tight bg-gradient-to-r from-white to-indigo-200 bg-clip-text text-transparent"
          >
            Haven
          </Link>
          <div className="flex items-center gap-4">
            <ConnectButton
              accountStatus="avatar"
              chainStatus="icon"
              showBalance={false}
            />
            <button
              onClick={() => {
                logout()
                router.push('/')
              }}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Log out
            </button>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="relative z-10 max-w-6xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="mb-10">
          <h1 className="text-2xl font-bold tracking-tight mb-1">Dashboard</h1>
          <p className="text-sm text-zinc-500">
            Welcome back, {user.email}
          </p>
        </div>

        {/* Account cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/[0.06] rounded-lg overflow-hidden mb-10">
          {/* Email */}
          <div className="bg-[#0a0a0a] p-6">
            <span className="block text-xs text-zinc-500 mb-2">Account</span>
            <span className="text-sm text-zinc-300">{user.email}</span>
          </div>

          {/* Wallet */}
          <div className="bg-[#0a0a0a] p-6">
            <span className="block text-xs text-zinc-500 mb-2">
              Connected wallet
            </span>
            {user.wallet_address ? (
              <a
                href={`https://gnosisscan.io/address/${user.wallet_address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                {truncate(user.wallet_address)}
              </a>
            ) : (
              <span className="text-sm text-zinc-600">Not connected</span>
            )}
          </div>

          {/* Safe */}
          <div className="bg-[#0a0a0a] p-6">
            <span className="block text-xs text-zinc-500 mb-2">
              Safe address
            </span>
            <a
              href={`https://gnosisscan.io/address/${user.safe_address}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              {truncate(user.safe_address)}
            </a>
          </div>
        </div>

        {/* Placeholder sections */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-white/[0.06] rounded-lg overflow-hidden">
          {/* Agents */}
          <div className="bg-[#0a0a0a] p-8">
            <div className="flex items-baseline gap-3 mb-4">
              <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
                01
              </span>
              <h2 className="text-sm font-semibold">Agents</h2>
            </div>
            <div className="flex items-center justify-center h-32 rounded-md border border-dashed border-white/[0.06]">
              <span className="text-sm text-zinc-600">Coming soon</span>
            </div>
          </div>

          {/* Transactions */}
          <div className="bg-[#0a0a0a] p-8">
            <div className="flex items-baseline gap-3 mb-4">
              <span className="text-xs font-mono bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">
                02
              </span>
              <h2 className="text-sm font-semibold">Transactions</h2>
            </div>
            <div className="flex items-center justify-center h-32 rounded-md border border-dashed border-white/[0.06]">
              <span className="text-sm text-zinc-600">Coming soon</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
