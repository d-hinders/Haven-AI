'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApprovals } from '@/hooks/useApprovals'
import { truncate, timeAgo } from '@/lib/format'

export default function ApprovalNotifications() {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const { approvals, pendingCount, loading } = useApprovals()

  const pendingApprovals = useMemo(
    () => approvals.filter((approval) => approval.status === 'pending'),
    [approvals],
  )

  useEffect(() => {
    if (!open) return

    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    const timeout = window.setTimeout(() => {
      window.addEventListener('mousedown', onMouseDown)
    }, 0)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Notifications${pendingCount > 0 ? `, ${pendingCount} pending approvals` : ''}`}
        className={`relative inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 ${
          pendingCount > 0
            ? 'border-amber-500/20 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15'
            : 'border-white/[0.06] bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200'
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
          <path d="M9 17a3 3 0 0 0 6 0" />
        </svg>
        {pendingCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full bg-amber-400 text-black text-[10px] font-bold flex items-center justify-center shadow-lg shadow-amber-500/20">
            {pendingCount > 99 ? '99+' : pendingCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Pending approvals"
          className="absolute right-0 top-full mt-3 w-[360px] max-w-[calc(100vw-2rem)] z-50 overflow-hidden rounded-2xl border border-white/[0.10] bg-[#121216] shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur-none"
        >
          <div className="px-4 py-3 border-b border-white/[0.06] bg-[#15151a] flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-zinc-100">Approvals</p>
              <p className="text-[11px] text-zinc-500">
                {pendingCount > 0
                  ? `${pendingCount} transaction${pendingCount === 1 ? '' : 's'} waiting for your review`
                  : 'No transactions waiting for approval'}
              </p>
            </div>
            {pendingCount > 0 && (
              <span className="text-[10px] px-2 py-1 rounded-full font-semibold bg-amber-500/15 text-amber-300">
                {pendingCount} pending
              </span>
            )}
          </div>

          {loading ? (
            <div className="p-4 space-y-3 bg-[#121216]">
              {[0, 1].map((index) => (
                <div
                  key={index}
                  className="rounded-xl border border-white/[0.06] bg-[#18181d] p-3"
                >
                  <div className="h-3 w-28 rounded bg-white/[0.06] animate-pulse mb-2" />
                  <div className="h-2 w-44 rounded bg-white/[0.04] animate-pulse mb-2" />
                  <div className="h-2 w-24 rounded bg-white/[0.04] animate-pulse" />
                </div>
              ))}
            </div>
          ) : pendingApprovals.length === 0 ? (
            <div className="px-5 py-8 text-center bg-[#121216]">
              <div className="w-11 h-11 rounded-2xl bg-emerald-500/12 text-emerald-400 flex items-center justify-center mx-auto mb-3 shadow-inner shadow-emerald-500/5">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 12l2 2 4-4" />
                  <circle cx="12" cy="12" r="10" />
                </svg>
              </div>
              <p className="text-sm font-medium text-zinc-200">You&apos;re all caught up</p>
              <p className="text-xs text-zinc-500 mt-1 leading-relaxed max-w-[240px] mx-auto">
                New agent transactions that need manual approval will appear here.
              </p>
            </div>
          ) : (
            <>
              <div className="max-h-[360px] overflow-y-auto p-2 space-y-2 bg-[#121216]">
                {pendingApprovals.map((approval) => (
                  <Link
                    key={approval.id}
                    href="/approvals"
                    onClick={() => setOpen(false)}
                    className="block rounded-xl border border-white/[0.06] bg-[#18181d] px-3 py-3 hover:bg-[#1c1c22] hover:border-white/[0.10] transition-all"
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-200 truncate">
                          {approval.agent_name}
                        </p>
                        <p className="text-[11px] text-zinc-500">
                          {timeAgo(approval.created_at)}
                        </p>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-semibold flex-shrink-0">
                        Pending
                      </span>
                    </div>
                    <p className="text-sm text-zinc-100">
                      {approval.amount_human} {approval.token_symbol}
                    </p>
                    <p className="text-xs text-zinc-500 mt-1">
                      To {truncate(approval.to_address)}
                    </p>
                  </Link>
                ))}
              </div>
              <div className="px-4 py-3 border-t border-white/[0.06] bg-[#15151a]">
                <Link
                  href="/approvals"
                  onClick={() => setOpen(false)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-300 hover:text-indigo-200 transition-colors"
                >
                  View all approvals
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14" />
                    <path d="m12 5 7 7-7 7" />
                  </svg>
                </Link>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
