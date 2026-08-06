'use client'

import { Clock, Copy, TriangleAlert } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { type AllowanceInfo } from '@/lib/allowance-module'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { truncate } from '@/lib/format'
import { AllowanceBar } from './AllowanceBar'

export function UnmanagedDelegateCard({
  delegate,
  allowances,
  chainTimeSec,
  chainId = DEFAULT_CHAIN_ID,
  pendingHavenSetup = false,
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
}) {
  // Neutral tone while a Haven setup is still confirming; warning tone for a
  // genuinely external delegate that needs the user's attention.
  const accentText = pendingHavenSetup ? 'text-[var(--v2-ink-2)]' : 'text-[var(--v2-warning)]'
  const containerCls = pendingHavenSetup
    ? 'border-[var(--v2-border)] bg-[var(--v2-surface)]'
    : 'border-[var(--v2-warning)]/25 bg-[var(--v2-warning-soft)]'
  return (
    <div className={`rounded-[10px] border border-dashed p-5 ${containerCls}`}>
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-xl bg-white flex items-center justify-center ${accentText}`}>
            <Icon icon={pendingHavenSetup ? Clock : TriangleAlert} className="h-[17px] w-[17px]" />
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
        <p className="text-xs font-mono text-[var(--v2-ink-2)]">
          {truncate(delegate)}
          <button
            onClick={() => navigator.clipboard.writeText(delegate)}
            className={`ml-2 transition-colors hover:text-[var(--v2-ink)] ${accentText}`}
            title="Copy address"
          >
            <Icon icon={Copy} className="h-[11px] w-[11px]" />
          </button>
        </p>
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
    </div>
  )
}
