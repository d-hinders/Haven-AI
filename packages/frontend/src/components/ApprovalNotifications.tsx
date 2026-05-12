'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApprovals } from '@/hooks/useApprovals'
import { approvalRecipientLabel, approvalSourceLabel } from '@/lib/approval-labels'
import { timeAgo } from '@/lib/format'

export default function ApprovalNotifications() {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const { approvals, actionableCount, loading } = useApprovals()

  const pendingApprovals = useMemo(
    () => approvals.filter((approval) => approval.status === 'pending' || approval.status === 'approved'),
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
    <div className="relative z-[110]">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Notifications${actionableCount > 0 ? `, ${actionableCount} payments need action` : ''}`}
        className={`relative inline-flex items-center justify-center w-10 h-10 rounded-xl border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30 ${
          actionableCount > 0
            ? 'border-[var(--v2-warning)]/25 bg-[var(--v2-warning-soft)] text-[var(--v2-warning)] hover:border-[var(--v2-warning)]/40'
            : 'border-[var(--v2-border)] bg-white text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)]'
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5" />
          <path d="M9 17a3 3 0 0 0 6 0" />
        </svg>
        {actionableCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full bg-[var(--v2-warning)] text-white text-[10px] font-bold flex items-center justify-center shadow-[var(--v2-shadow-button)]">
            {actionableCount > 99 ? '99+' : actionableCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Pending approvals"
          className="absolute right-0 top-full mt-3 w-[360px] max-w-[calc(100vw-2rem)] z-[120] isolate overflow-hidden rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-[var(--v2-shadow-modal)]"
        >
          <div className="absolute inset-0 bg-[var(--v2-bg)]" aria-hidden="true" />
          <div className="relative px-4 py-3 border-b border-[var(--v2-border)] bg-white flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-[var(--v2-ink)]">Approvals</p>
              <p className="text-[11px] text-[var(--v2-ink-3)]">
                {actionableCount > 0
                  ? `${actionableCount} payment${actionableCount === 1 ? '' : 's'} need your action`
                  : 'No payments need action'}
              </p>
            </div>
            {actionableCount > 0 && (
              <span className="text-[10px] px-2 py-1 rounded-full font-semibold bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]">
                {actionableCount} waiting
              </span>
            )}
          </div>

          {loading ? (
            <div className="relative p-4 space-y-3 bg-[var(--v2-surface)]">
              {[0, 1].map((index) => (
                <div
                  key={index}
                  className="rounded-xl border border-[var(--v2-border)] bg-white p-3"
                >
                  <div className="h-3 w-28 rounded bg-[var(--v2-surface-2)] animate-pulse mb-2" />
                  <div className="h-2 w-44 rounded bg-[var(--v2-surface-2)] animate-pulse mb-2" />
                  <div className="h-2 w-24 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                </div>
              ))}
            </div>
          ) : pendingApprovals.length === 0 ? (
            <div className="relative px-5 py-8 text-center bg-[var(--v2-surface)]">
              <div className="w-11 h-11 rounded-2xl bg-[var(--v2-success-soft)] text-[var(--v2-success)] flex items-center justify-center mx-auto mb-3">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 12l2 2 4-4" />
                  <circle cx="12" cy="12" r="10" />
                </svg>
              </div>
              <p className="text-sm font-medium text-[var(--v2-ink)]">
                {actionableCount > 0 ? 'Open approvals for the full queue' : "You're all caught up"}
              </p>
              <p className="text-xs text-[var(--v2-ink-2)] mt-1 leading-relaxed max-w-[240px] mx-auto">
                {actionableCount > 0
                  ? 'There are more requests than this preview can show.'
                  : 'Agent payments above budget will appear here before any money moves.'}
              </p>
              {actionableCount > 0 ? (
                <Link
                  href="/approvals"
                  onClick={() => setOpen(false)}
                  className="mt-4 inline-flex items-center justify-center rounded-md border border-[var(--v2-border-strong)] bg-white px-3.5 py-2 text-xs font-medium text-[var(--v2-ink)] transition-colors hover:bg-[var(--v2-surface)]"
                >
                  Open approvals
                </Link>
              ) : null}
            </div>
          ) : (
            <>
              <div className="relative max-h-[360px] overflow-y-auto p-2 space-y-2 bg-[var(--v2-surface)]">
                {pendingApprovals.map((approval) => (
                  <Link
                    key={approval.id}
                    href="/approvals"
                    onClick={() => setOpen(false)}
                    className="block rounded-xl border border-[var(--v2-border)] bg-white px-3 py-3 hover:border-[var(--v2-border-strong)] transition-all"
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-[var(--v2-ink)] truncate">
                          {approval.agent_name}
                        </p>
                        <p className="text-[11px] text-[var(--v2-ink-3)]">
                          {timeAgo(approval.created_at)}
                        </p>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--v2-warning-soft)] text-[var(--v2-warning)] font-semibold flex-shrink-0">
                        {approval.status === 'approved' ? 'Complete' : 'Review'}
                      </span>
                    </div>
                    <p className="text-sm text-[var(--v2-ink)]">
                      {approval.amount_human} {approval.token_symbol}
                    </p>
                    <p className="text-xs text-[var(--v2-ink-3)] mt-1">
                      To {approvalRecipientLabel({
                        reason: approval.reason,
                        source: approval.source,
                        x402ResourceUrl: approval.x402_resource_url,
                        toAddress: approval.to_address,
                      })}
                      {approvalSourceLabel({ reason: approval.reason, source: approval.source })
                        ? ` · ${approvalSourceLabel({ reason: approval.reason, source: approval.source })}`
                        : ''}
                    </p>
                  </Link>
                ))}
              </div>
              <div className="relative px-4 py-3 border-t border-[var(--v2-border)] bg-white">
                <Link
                  href="/approvals"
                  onClick={() => setOpen(false)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors"
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
