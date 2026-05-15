'use client'

import type { ReactNode } from 'react'
import type { SafeOperationGate } from '@/hooks/useSafeOperationGate'
import NetworkGate from './NetworkGate'
import PasskeyOtherDeviceNotice from './PasskeyOtherDeviceNotice'

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

  return (
    <div
      role="alert"
      className={`rounded-lg border border-[var(--v2-warning)]/25 bg-[var(--v2-warning-soft)] px-3 py-2 text-sm text-[var(--v2-warning)] ${className}`}
    >
      {message}
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
