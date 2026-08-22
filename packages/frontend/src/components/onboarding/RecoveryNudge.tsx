'use client'

/**
 * Backup-enrollment nudge shown right after passkey signup (#889, epic #836).
 *
 * A fresh single-passkey account has NO recovery path — losing the device
 * loses the account. This nudges the user to add a backup, dismissibly and
 * non-blocking (they can proceed and add one later from Backup & recovery on
 * any agent). Outcome language: "a lost device shouldn't mean a lost account".
 *
 * #1229 gave it a second home. A legacy passkey-Safe account has the same
 * one-key exposure and, until that issue, no way at all to fix it — enrolling
 * a backup passkey 409'd on the one-per-chain constraint. The risk is
 * identical on both rails; only the place you go to fix it differs, so that
 * is the only thing this component varies.
 */

import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

const DISMISS_KEY = 'haven.recovery-nudge.dismissed'

/** Where the user adds the backup — the one thing the two rails don't share. */
export type RecoveryNudgeRail = 'delegation' | 'safe'

export function RecoveryNudge({ rail = 'delegation' }: { rail?: RecoveryNudgeRail } = {}) {
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(DISMISS_KEY) === '1'
  })

  if (dismissed) return null

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* private mode — fall back to in-memory dismissal */
    }
    setDismissed(true)
  }

  return (
    <div className="mt-6 rounded-lg border border-brand/25 bg-[var(--v2-brand-soft)] p-4 text-left">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-white text-[var(--v2-brand)] ring-1 ring-brand/20">
          <Icon icon={ShieldCheck} className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--v2-ink)]">Add a backup soon</p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            Right now this account has one way to approve it. Add a backup — a backup passkey or a
            wallet — so a lost device never means a lost account.{' '}
            {rail === 'safe' ? (
              <>
                You&apos;ll find it under{' '}
                <span className="font-medium text-[var(--v2-ink)]">Approvers</span> in settings.
              </>
            ) : (
              <>
                You&apos;ll find it under{' '}
                <span className="font-medium text-[var(--v2-ink)]">Backup &amp; recovery</span> once
                your first agent is set up.
              </>
            )}
          </p>
          <div className="mt-3 flex items-center gap-4">
            <a
              href="https://docs.haven.xyz/product/account-recovery"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
            >
              How recovery works
            </a>
            <button
              type="button"
              onClick={dismiss}
              className="text-sm font-medium text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]"
            >
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
