'use client'

import { useAuth } from '@/context/AuthContext'
import { usePreferences } from '@/hooks/usePreferences'

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function SettingsClient() {
  const { user } = useAuth()
  const { currency, setCurrency, saving } = usePreferences()

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight mb-1">Settings</h1>
        <p className="text-sm text-zinc-500">
          Manage your account preferences
        </p>
      </div>

      {/* Display Settings */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.01] p-6 mb-6">
        <h2 className="text-sm font-semibold text-zinc-200 mb-5">Display</h2>

        <div className="space-y-5">
          {/* Currency preference */}
          <div>
            <p className="text-xs text-zinc-500 mb-3">Preferred currency</p>
            <div className="flex gap-2">
              {(['USD', 'EUR'] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setCurrency(c)}
                  disabled={saving}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-all duration-150 ${
                    currency === c
                      ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                      : 'bg-white/[0.03] text-zinc-500 border border-white/[0.06] hover:border-white/[0.12] hover:text-zinc-300'
                  } disabled:opacity-50`}
                >
                  {c === 'USD' ? '$ USD' : '\u20AC EUR'}
                </button>
              ))}
            </div>
            {saving && (
              <p className="text-xs text-zinc-600 mt-2">Saving...</p>
            )}
          </div>
        </div>
      </div>

      {/* Account Information */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.01] p-6 mb-6">
        <h2 className="text-sm font-semibold text-zinc-200 mb-5">
          Account Information
        </h2>

        <div className="space-y-4">
          <div>
            <p className="text-xs text-zinc-500 mb-1">Email</p>
            <p className="text-sm text-zinc-300">{user?.email}</p>
          </div>

          <div>
            <p className="text-xs text-zinc-500 mb-1">Connected Wallet</p>
            <p className="text-sm font-mono text-zinc-300">
              {user?.wallet_address
                ? truncate(user.wallet_address)
                : 'Not connected'}
            </p>
          </div>

          <div>
            <p className="text-xs text-zinc-500 mb-1">Safe Accounts</p>
            {user?.safes && user.safes.length > 0 ? (
              <div className="space-y-1">
                {user.safes.map((safe) => (
                  <div key={safe.id} className="flex items-center gap-2">
                    <a
                      href={`https://gnosisscan.io/address/${safe.safe_address}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      {truncate(safe.safe_address)}
                    </a>
                    <span className="text-xs text-zinc-600">{safe.name}</span>
                    {safe.is_default && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-indigo-500/10 text-indigo-400">
                        default
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-600">Not deployed</p>
            )}
          </div>

          {user?.created_at && (
            <div>
              <p className="text-xs text-zinc-500 mb-1">Account Created</p>
              <p className="text-sm text-zinc-300">
                {new Date(user.created_at).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Security (placeholder) */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.01] p-6">
        <h2 className="text-sm font-semibold text-zinc-200 mb-5">Security</h2>

        <div className="space-y-3">
          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm text-zinc-300">Change password</p>
              <p className="text-xs text-zinc-600">
                Update your account password
              </p>
            </div>
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-indigo-500/10 text-indigo-400 font-medium">
              Soon
            </span>
          </div>

          <div className="border-t border-white/[0.06]" />

          <div className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm text-zinc-300">Active sessions</p>
              <p className="text-xs text-zinc-600">
                Manage your logged-in devices
              </p>
            </div>
            <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-indigo-500/10 text-indigo-400 font-medium">
              Soon
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
