import { truncate } from '@/lib/format'
import { Tooltip } from '@/components/ui/Tooltip'
import { Wallet } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'

export function WalletIdentityBlock({
  name,
  network,
  address,
  balance,
}: {
  name: string
  network: string
  address?: string
  balance?: string
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-4 shadow-card">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]">
          <Icon icon={Wallet} className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">{name}</h3>
            <span className="rounded-full bg-[var(--v2-surface)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-2)]">
              {network}
            </span>
          </div>
          {address && (
            <Tooltip label={address} mono>
              <p className="mt-1 font-mono text-xs text-[var(--v2-ink-3)]">{truncate(address)}</p>
            </Tooltip>
          )}
          {balance && <p className="mt-3 text-sm font-medium text-[var(--v2-ink)] v2-tabular">{balance}</p>}
        </div>
      </div>
    </div>
  )
}
