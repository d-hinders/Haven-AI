'use client'

import { useState } from 'react'
import { Clock, TriangleAlert } from 'lucide-react'
import ConfirmDialog from '../ConfirmDialog'
import { Address } from '@/components/haven/Address'
import { Icon } from '@/components/ui/Icon'
import { type AllowanceInfo } from '@/lib/allowance-module'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { AllowanceBar } from './AllowanceBar'

export function UnmanagedDelegateCard({
  delegate,
  allowances,
  chainTimeSec,
  chainId = DEFAULT_CHAIN_ID,
  pendingHavenSetup = false,
  onRevoke,
  revoking = false,
}: {
  delegate: string
  allowances: AllowanceInfo[]
  chainTimeSec: number | null
  chainId?: number
  /**
   * True when this delegate was set up through Haven in this session but its
   * agent hasn't flipped active yet (slow backend confirmation). It isn't
   * "unmanaged" — it's mid-setup — so we reword and de-escalate the tone rather
   * than implying it was created outside Haven.
   */
  pendingHavenSetup?: boolean
  /**
   * On-chain teardown of this delegate's spending authority (#1980). Same
   * Safe transaction as a managed agent's revoke — the AllowanceModule keys
   * authority on the address alone. Hidden on the pendingHavenSetup branch:
   * that delegate is mid-setup through Haven, and tearing it down here would
   * fight the setup flow that is about to adopt it.
   */
  onRevoke?: () => void
  revoking?: boolean
}) {
  const [revokeOpen, setRevokeOpen] = useState(false)
  // Neutral tone while a Haven setup is still confirming; warning tone for a
  // genuinely external delegate that needs the user's attention.
  const accentText = pendingHavenSetup ? 'text-[var(--v2-ink-2)]' : 'text-[var(--v2-warning)]'
  const containerCls = pendingHavenSetup
    ? 'border-[var(--v2-border)] bg-[var(--v2-surface)]'
    : 'border-warning/25 bg-[var(--v2-warning-soft)]'
  return (
    <>
    <div className={`rounded-[10px] border border-dashed p-5 ${containerCls}`}>
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl bg-white flex items-center justify-center ${accentText}`}>
            <Icon icon={pendingHavenSetup ? Clock : TriangleAlert} className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
                {pendingHavenSetup ? 'Finishing agent setup' : 'Unmanaged Delegate'}
              </h3>
              <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium bg-white ${accentText}`}>
                {pendingHavenSetup ? 'confirming' : 'network only'}
              </span>
            </div>
            <p className={`text-xs mt-0.5 ${accentText}`}>
              {pendingHavenSetup
                ? 'Haven is still confirming these rules on-chain — this agent will appear here shortly.'
                : 'This delegate was set up outside Haven'}
            </p>
          </div>
        </div>
      </div>

      {/* Delegate address */}
      <div className="mb-4">
        <p className={`mb-1 text-xs font-medium ${accentText}`}>
          Signing address
        </p>
        <Address value={delegate} copy className="text-xs text-[var(--v2-ink-2)]" />
      </div>

      {/* On-chain allowances */}
      {allowances.length > 0 && (
        <div className="space-y-2">
          <p className={`text-xs font-medium ${accentText}`}>Agent budget</p>
          {allowances.map((info) => (
            <AllowanceBar key={info.token} info={info} chainTimeSec={chainTimeSec} chainId={chainId} />
          ))}
        </div>
      )}

      {/* #1980: a surface showing live spending authority must answer "how do
          I stop it" — this card is the destination /custody's "Revoke an agent
          on-chain from Agents" copy points at. Same footer idiom as AgentCard. */}
      {!pendingHavenSetup && onRevoke && (
        <div className="flex items-center gap-2 mt-4 pt-3 pb-1 border-t border-warning/25">
          <button
            onClick={() => setRevokeOpen(true)}
            disabled={revoking}
            aria-label={`Revoke delegate ${delegate}`}
            className="text-xs text-[var(--v2-ink-3)] hover:text-[var(--v2-danger)] transition-colors disabled:opacity-50 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80"
          >
            {revoking ? 'Revoking...' : 'Revoke'}
          </button>
        </div>
      )}
    </div>

    <ConfirmDialog
      open={revokeOpen}
      onCancel={() => setRevokeOpen(false)}
      onConfirm={() => {
        setRevokeOpen(false)
        onRevoke?.()
      }}
      title="Revoke this delegate?"
      body={
        <div className="space-y-3">
          <p>
            This delegate was set up outside Haven, but it can spend from this Haven account within the budget shown. Revoking removes its network spending authority.
          </p>
          <div className="rounded-lg border border-danger/15 bg-[var(--v2-danger-soft)] px-3 py-3 text-[var(--v2-ink-2)]">
            <p className="text-xs font-medium text-[var(--v2-danger)] mb-1">What happens next</p>
            <p className="text-xs leading-relaxed">
              You&apos;ll be asked to approve the update that removes this delegate&apos;s spending access. Its budget ends on the network itself, so nothing set up outside Haven can restore it without your approval.
            </p>
          </div>
        </div>
      }
      confirmLabel="Revoke delegate"
      loading={revoking}
    />
    </>
  )
}
