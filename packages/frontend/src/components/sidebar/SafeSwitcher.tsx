'use client'

import { useState, useRef, useEffect } from 'react'
import { useAuth, type UserSafe } from '@/context/AuthContext'

function truncate(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function SafeSwitcher() {
  const { user, activeSafe, setActiveSafe } = useAuth()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const safes = user?.safes ?? []

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Don't render if user has 0 or 1 Safe
  if (safes.length <= 1) return null

  return (
    <div ref={ref} className="relative px-3 py-2">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03] transition-colors"
      >
        {/* Safe icon */}
        <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
        </svg>
        <span className="flex-1 text-left truncate">
          {activeSafe?.name ?? 'Select account'}
        </span>
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-3 right-3 bottom-full mb-1 bg-[#141414] border border-white/[0.08] rounded-lg shadow-xl overflow-hidden z-50">
          <div className="py-1">
            {safes.map((safe) => (
              <button
                key={safe.id}
                onClick={() => {
                  setActiveSafe(safe)
                  setOpen(false)
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                  activeSafe?.id === safe.id
                    ? 'bg-indigo-500/10 text-indigo-400'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex-1 text-left min-w-0">
                  <p className="truncate font-medium">{safe.name}</p>
                  <p className="text-[10px] text-zinc-600 font-mono">
                    {truncate(safe.safe_address)}
                  </p>
                </div>
                {activeSafe?.id === safe.id && (
                  <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
                {safe.is_default && activeSafe?.id !== safe.id && (
                  <span className="text-[9px] px-1 py-0.5 rounded bg-white/[0.06] text-zinc-600 flex-shrink-0">
                    default
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
