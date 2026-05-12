'use client'

import ComingSoonModal from '@/components/ComingSoonModal'

interface Props {
  open: boolean
  onClose: () => void
  onReceive?: () => void
}

export default function AddFundsModal({ open, onClose, onReceive }: Props) {
  return <ComingSoonModal open={open} onClose={onClose} onReceive={onReceive} />
}
