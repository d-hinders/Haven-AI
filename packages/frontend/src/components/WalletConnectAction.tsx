'use client'

import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useWalletClient } from 'wagmi'
import { Button } from './ui/Button'
import { useSwitchWallet } from '@/hooks/useSwitchWallet'

/**
 * The way out of a "connect the owner wallet" state, rendered INSIDE the flow
 * that needs the signature (#3812).
 *
 * Before this, the app's only connect/switch control was the header's
 * `WalletButton`: every signing flow — revoke, set/edit/stop a budget, send,
 * replace a signing key, change signers — said "connect your owner wallet"
 * and offered nothing to click. That made the header the one way an
 * EOA-owned account could ever sign, so it could not be removed (#3825)
 * without locking a wallet-only owner out of revoking.
 *
 * Render it only where the caller already knows the account cannot sign yet
 * (its `ready` is false / its gate is `no_signer` or `wrong_wallet`). A
 * passkey account is always ready, so a passkey-only owner never sees it.
 *
 * - No wallet connected: "Connect wallet" opens RainbowKit's picker.
 * - A wallet IS connected AND its client is ready (so it is the wrong one,
 *   or the caller would be ready): "Switch wallet" disconnects it and reopens
 *   the picker, the same flow as the header pill (`useSwitchWallet`).
 * - A wallet is connected but its client is not ready yet (a reconnect in
 *   flight): render nothing. That wallet may be the owner, and readiness
 *   needs the client too (`lib/signer.ts`), so offering "Switch wallet" here
 *   would disconnect the right wallet. The caller's own message still shows.
 */
export default function WalletConnectAction({ className }: { className?: string }) {
  const { isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { openConnectModal } = useConnectModal()
  const { switchWallet, switching } = useSwitchWallet()

  if (isConnected && !walletClient && !switching) return null

  if (isConnected) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className={className}
        onClick={() => void switchWallet()}
        disabled={switching}
      >
        {switching ? 'Disconnecting…' : 'Switch wallet'}
      </Button>
    )
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      className={className}
      onClick={() => openConnectModal?.()}
      disabled={!openConnectModal}
    >
      Connect wallet
    </Button>
  )
}
