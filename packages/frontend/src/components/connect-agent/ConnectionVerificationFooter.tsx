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
 *
 * #1684: ONE row, not two. The check line and a separate "Verification
 * details" disclosure directly beneath it were two rows stating one fact, so
 * the check and the truncated address moved onto the disclosure row itself.
 * The address stays visible COLLAPSED on purpose: it is the user's only proof
 * that the delegate about to be granted a budget is the one on their own
 * machine, which is this flow's anti-phishing check — hiding it behind a
 * click would take the check away from everyone who does not click.
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
  // `items-start` + `mt-0.5`: at 12px/normal leading that lands the 14px check
  // exactly on the FIRST line's centre, so the row survives the address
  // wrapping onto a second line at 390px instead of centring the glyph
  // between the two.
  const check = (
    <Icon icon={Check} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--v2-success)]" />
  )
  const VERIFIED_LABEL = install?.manual_credential_fallback
    ? 'Manual credential created'
    : 'Local connection verified'

  // Nothing to disclose (no address, no runtime report, single-owner Safe):
  // the same line renders as plain text rather than a summary that opens onto
  // an empty list.
  if (!delegateAddress && !install && safeThreshold <= 1) {
    return (
      <div className="flex items-start gap-2 text-[12px] text-[var(--v2-ink-2)]">
        {check}
        {/* No address to append: this branch is only reached when there is
            none, which is also why there is nothing to disclose. */}
        <span>{VERIFIED_LABEL}</span>
      </div>
    )
  }

  return (
    <details className="group text-[12px]">
      {/* py-1: at 12px the bare row gave a ~36-40px hit height on mobile,
          under the 44px guideline — thin for the control that reveals this
          flow's anti-phishing evidence. */}
      <summary className="flex cursor-pointer list-none items-start gap-2 py-1 text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]">
        {check}
        <span>
          {VERIFIED_LABEL}
          {addressShort ? ' · ' : ' '}
          {/* The chevron rides INSIDE a nowrap group with the address rather
              than sitting beside the text as a flex item. Two 390px failures
              got it here: as a flex item it floated to the row's right edge
              and centred itself between the two lines once the address
              wrapped; inline with an ordinary space it wrapped onto a line of
              its own, because the boundary of an atomic inline is a break
              opportunity a no-break space does not close. Bound to the
              address, the affordance can only wrap WITH the text it
              discloses. */}
          <span className="whitespace-nowrap">
            {addressShort}
            <Icon
              icon={ChevronRight}
              className="ml-1 inline-block h-3 w-3 align-middle text-[var(--v2-ink-3)] transition-transform group-open:rotate-90"
            />
          </span>
        </span>
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
  )
}
