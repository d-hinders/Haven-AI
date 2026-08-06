'use client'

import { Check, ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { AgentConnectionSetupStatusResponse } from '@/hooks/useAgentConnectionSetupStatus'
import { truncate } from '@/lib/format'
import { runtimeStatusHelper, runtimeStatusLabel } from './setup-copy'

/**
 * The approval step's footer, shared by both rails (#1073).
 *
 * The verified-connection line plus the collapsible proof behind it. Both
 * approval steps show the same evidence for the same decision — only the
 * Safe-specific "Approvals required" row is rail-conditional, and it is
 * absent on the delegation rail because a single signature IS the approval.
 */
export function ConnectionVerificationFooter({
  delegateAddress,
  install,
  safeThreshold = 1,
  safeOwnerCount = 1,
}: {
  delegateAddress: string | null
  install: AgentConnectionSetupStatusResponse['install_status'] | undefined
  safeThreshold?: number
  safeOwnerCount?: number
}) {
  const addressShort = delegateAddress ? truncate(delegateAddress) : null
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[12px] text-[var(--v2-ink-2)]">
        <Icon icon={Check} className="h-3.5 w-3.5 shrink-0 text-[var(--v2-success)]" />
        <span>
          Local connection verified
          {addressShort ? ` · ${addressShort}` : ''}
        </span>
      </div>
      {(delegateAddress || install || safeThreshold > 1) && (
        <details className="group text-[12px]">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]">
            <Icon icon={ChevronRight} className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
            Verification details
          </summary>
          <dl className="mt-2 space-y-2 border-l border-[var(--v2-border)] pl-3">
            {delegateAddress && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
                  Public address
                </dt>
                <dd className="mt-0.5 break-all font-mono text-xs text-[var(--v2-ink)]">
                  {delegateAddress}
                </dd>
              </div>
            )}
            {install && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
                  Runtime setup
                </dt>
                <dd className="mt-0.5 text-xs text-[var(--v2-ink-2)]">
                  <span className="text-[var(--v2-ink)]">{runtimeStatusLabel(install)}</span>
                  {runtimeStatusHelper(install) ? ` — ${runtimeStatusHelper(install)}` : ''}
                </dd>
              </div>
            )}
            {safeThreshold > 1 && (
              <div>
                <dt className="text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
                  Approvals required
                </dt>
                <dd className="mt-0.5 text-xs text-[var(--v2-ink-2)]">
                  {safeThreshold} of {safeOwnerCount}
                </dd>
              </div>
            )}
          </dl>
        </details>
      )}
    </div>
  )
}
