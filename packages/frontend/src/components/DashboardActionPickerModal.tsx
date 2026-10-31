'use client'

import { ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Modal } from '@/components/ui/Modal'
import { resolveChainOrNull } from '@/lib/chains'
import type { SmartAccount } from '@/context/AuthContext'

interface Props {
  open: boolean
  action: 'receive' | 'send'
  accounts: SmartAccount[]
  onClose: () => void
  onSelect: (accountId: string) => void
}

/**
 * Pick the Haven account a money action runs on (#4094).
 *
 * #4566: the shell is `ui/Modal` — the shared anatomy instead of a hand-built
 * overlay. It is a single-screen chooser with no action row of its own: the
 * account rows ARE the actions, so the footer stays empty and the ✕ (on by
 * default) plus the backdrop and Escape are the dismissals.
 */
export default function DashboardActionPickerModal({
  open,
  action,
  accounts,
  onClose,
  onSelect,
}: Props) {
  // #4094: the money verbs are Send / Receive everywhere. The 'add-funds'
  // action merged into 'receive' — one Receive dialog now serves both old
  // funding dialogs — and 'send' is back for the DELEGATION rail's owner-send
  // (`DelegationSendModal`). The legacy Safe send stays retired (#1989, epic
  // #1440): that modal and its hook are deleted, and nothing here reopens
  // that path.
  const title =
    action === 'receive'
      ? 'Choose an account to receive on'
      : 'Choose an account to send from'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle="Money actions stay explicit when you have multiple accounts."
      width="md"
      bodyClassName="space-y-2"
    >
      {accounts.map((account) => (
        <button
          key={account.id}
          onClick={() => onSelect(account.id)}
          className="w-full rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 text-left transition-colors hover:border-brand/30 hover:bg-[var(--v2-brand-soft)]"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--v2-ink)] truncate">{account.name}</span>
                {account.is_default && (
                  <StatusBadge tone="brand">Default</StatusBadge>
                )}
              </div>
              <p className="text-xs text-[var(--v2-ink-3)] mt-1">
                {resolveChainOrNull(account.chain_id)?.name ?? `Chain ${account.chain_id}`}
              </p>
            </div>
            <Icon icon={ChevronRight} className="w-4 h-4 text-[var(--v2-ink-3)] flex-shrink-0" />
          </div>
        </button>
      ))}
    </Modal>
  )
}
