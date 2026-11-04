'use client'

import { ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Modal } from '@/components/ui/Modal'
import { Row } from '@haven_ai/ui/Row'
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
 *
 * #4601 (N5): the options are `Row`s, not hand-styled `<button>`s. The old
 * buttons carried a tinted `--v2-surface` fill and no `focus-visible` style, so
 * keyboard focus fell back to the browser's default outline (measured on dev at
 * 375 px: `outline: rgb(229, 151, 0) auto 1px`). `Row` with `onClick` renders a
 * full-width `<button>` with the shared `focus-visible:ring-2 ring-inset
 * ring-brand/80`, and its `title` slot takes the Default `StatusBadge`. `Row`
 * has no border of its own, so the divided container below supplies the
 * separation the per-button borders used to.
 *
 * #4642: an account with no resolved `chain_id` cannot sign a send, and the
 * Send dialog's mount guard skips it — so listing it as clickable was a silent
 * dead end (the row set `sendOpen` and nothing rendered). For the `send` action
 * such an account is a NON-interactive `Row` (no `onClick`) carrying the reason
 * as its subtitle. `Row` has no disabled state, so a static row is the existing
 * pattern. Receive is unaffected: an account can receive on a chain it has not
 * resolved yet, and the Receive dialog names the network itself.
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
    >
      <div className="divide-y divide-[var(--v2-border)] overflow-hidden rounded-lg border border-[var(--v2-border)]">
        {accounts.map((account) => {
          const titleSlot = (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{account.name}</span>
              {account.is_default ? <StatusBadge tone="brand">Default</StatusBadge> : null}
            </span>
          )

          // #4642: no resolved chain, no send. A static row says why instead of
          // accepting a click that renders nothing.
          if (action === 'send' && account.chain_id == null) {
            return (
              <Row
                key={account.id}
                title={titleSlot}
                subtitle="No network yet. You can't send from this account."
              />
            )
          }

          return (
            <Row
              key={account.id}
              onClick={() => onSelect(account.id)}
              title={titleSlot}
              subtitle={resolveChainOrNull(account.chain_id)?.name ?? `Chain ${account.chain_id}`}
              trailing={<Icon icon={ChevronRight} className="w-4 h-4 text-[var(--v2-ink-3)]" />}
            />
          )
        })}
      </div>
    </Modal>
  )
}
