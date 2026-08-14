'use client'

import { Button } from '@/components/ui/Button'
import { Plus } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Modal } from '@/components/ui/Modal'

interface Props {
  open: boolean
  onClose: () => void
  onReceive?: () => void
}

export default function ComingSoonModal({ open, onClose, onReceive }: Props) {
  function handleReceiveInstead() {
    onClose()
    onReceive?.()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add funds is coming soon"
      subtitle="A guided fiat on-ramp is planned for a later release."
      showCloseButton
      bodyClassName="p-6"
    >
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[10px] border border-[var(--v2-brand)]/20 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]">
        <Icon icon={Plus} className="h-6 w-6" />
      </div>
      <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
        For now, use Receive to copy the correct Haven wallet address and send supported tokens on-chain.
      </p>
      <div className="mt-6 flex gap-3">
        {onReceive && (
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Close
          </Button>
        )}
        <Button onClick={onReceive ? handleReceiveInstead : onClose} className="flex-1">
          {onReceive ? 'Receive instead' : 'Close'}
        </Button>
      </div>
    </Modal>
  )
}
