'use client'

import type { ReactNode } from 'react'
import type { SafeOperationGate } from '@/hooks/useSafeOperationGate'
import NetworkGate from './NetworkGate'
import PasskeyOtherDeviceNotice from './PasskeyOtherDeviceNotice'
import { Info } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { truncateAddress } from '@/components/haven'

interface OnchainActionGateProps {
  requiredChainId: number
  operationGate: SafeOperationGate
  children: (state: { disabled: boolean }) => ReactNode
  noSignerMessage: string
  className?: string
  autoSwitch?: boolean
  showNotice?: boolean
}

interface OnchainActionNoticeProps {
  operationGate: SafeOperationGate
  noSignerMessage: string
  className?: string
}

export function isOnchainActionBlocked(operationGate: SafeOperationGate): boolean {
  return operationGate.kind !== 'ready'
}

export function getOnchainActionBlockMessage(
  operationGate: SafeOperationGate,
  noSignerMessage: string,
): string | null {
  if (operationGate.kind === 'no_signer') return noSignerMessage
  // #2073: name the mismatch. The generic no-signer copy reads as "nothing is
  // connected", which is false here and leaves the user re-connecting the
  // same wrong wallet. The message is built from the gate's own addresses
  // rather than taken from the caller, so every surface states the same fact.
  if (operationGate.kind === 'wrong_wallet') {
    return `Connected wallet ${truncateAddress(operationGate.connectedAddress)} is not this account's owner. Switch to the owner wallet ${truncateAddress(operationGate.ownerAddress)} to continue.`
  }
  if (operationGate.kind === 'passkey_on_other_device') {
    return 'Use the device with this Haven account passkey to approve.'
  }
  return null
}

export function OnchainActionNotice({
  operationGate,
  noSignerMessage,
  className = '',
}: OnchainActionNoticeProps) {
  if (operationGate.kind === 'passkey_on_other_device') {
    return <PasskeyOtherDeviceNotice className={className} />
  }

  const message = getOnchainActionBlockMessage(operationGate, noSignerMessage)
  if (!message) return null

  // Quiet inline hint (info icon + ink-3 caption) rather than a yellow
  // box. The yellow background made this read like an interactive
  // element; downgrading to a passive caption keeps the user's eye on
  // the disabled primary button below.
  return (
    <div
      role="status"
      className={`flex items-start gap-2 text-xs text-[var(--v2-ink-3)] ${className}`}
    >
      <Icon icon={Info} className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <span>{message}</span>
    </div>
  )
}

export default function OnchainActionGate({
  requiredChainId,
  operationGate,
  children,
  noSignerMessage,
  className,
  autoSwitch = false,
  showNotice = true,
}: OnchainActionGateProps) {
  const blocked = isOnchainActionBlocked(operationGate)
  const action = children({ disabled: blocked })

  if (blocked) {
    return (
      <div className={className}>
        {showNotice ? (
          <OnchainActionNotice
            operationGate={operationGate}
            noSignerMessage={noSignerMessage}
            className="mb-2"
          />
        ) : null}
        {action}
      </div>
    )
  }

  return (
    <NetworkGate requiredChainId={requiredChainId} autoSwitch={autoSwitch} className={className}>
      {action}
    </NetworkGate>
  )
}
