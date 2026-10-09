'use client'

import { useEffect, useState } from 'react'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'

/**
 * The "switch wallet" flow: disconnect the current wallet, then open
 * RainbowKit's connector picker once wagmi has committed `isConnected=false`.
 *
 * RainbowKit refuses to open the connect modal while a wallet is still
 * connected, so the open has to wait for the disconnected render — which is
 * why this is a hook driven by an effect rather than two calls in a row.
 * Extracted from `WalletButton` (#3812) so every signing flow's in-flow
 * `WalletConnectAction` switches the same way the header pill does.
 */
export function useSwitchWallet(): { switchWallet: () => Promise<void>; switching: boolean } {
  const { isConnected } = useAccount()
  const { disconnectAsync } = useDisconnect()
  const { openConnectModal } = useConnectModal()
  const [pendingSwitch, setPendingSwitch] = useState(false)

  useEffect(() => {
    if (!pendingSwitch) return

    if (!isConnected && openConnectModal) {
      setPendingSwitch(false)
      openConnectModal()
      return
    }

    // Safety valve: if we have been in pending state for >3 s but the connect
    // modal is still not available (e.g. RainbowKit not ready), give up so the
    // UI doesn't stay stuck on "Disconnecting…" indefinitely.
    const id = window.setTimeout(() => setPendingSwitch(false), 3000)
    return () => window.clearTimeout(id)
  }, [pendingSwitch, isConnected, openConnectModal])

  const switchWallet = async () => {
    setPendingSwitch(true)
    try {
      await disconnectAsync()
    } catch {
      setPendingSwitch(false)
    }
  }

  return { switchWallet, switching: pendingSwitch }
}
