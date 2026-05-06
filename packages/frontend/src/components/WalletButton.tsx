'use client'

import { useEffect, useRef, useState } from 'react'
import { ConnectButton, useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { SUPPORTED_CHAIN_IDS } from '@/lib/chains'

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

interface PopoverProps {
  address: string
  chainName: string | undefined
  open: boolean
  onClose: () => void
  /**
   * Begin a "switch wallet" flow: disconnect the current wallet and then
   * open RainbowKit's connector picker. Driven from the parent so the
   * picker is opened *after* the disconnected render has committed —
   * RainbowKit refuses to open the connect modal while a wallet is
   * still connected, and the popover unmounts as soon as we disconnect.
   */
  onSwitchWallet: () => void
  switching: boolean
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

function WalletPopover({
  address,
  chainName,
  open,
  onClose,
  onSwitchWallet,
  switching,
  anchorRef,
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const { disconnectAsync } = useDisconnect()
  const [copied, setCopied] = useState(false)

  useEscapeToClose(open, onClose)

  // Outside-click to close.
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    // Defer one tick so the click that opened the popover doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', handler)
    }, 0)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('mousedown', handler)
    }
  }, [open, onClose, anchorRef])

  if (!open) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Wallet menu"
      className="absolute right-0 top-full mt-2 w-72 z-50 bg-[var(--v2-bg)] border border-[var(--v2-border)] rounded-xl shadow-[var(--v2-shadow-modal)] overflow-hidden"
    >
      <div className="p-4 border-b border-[var(--v2-border)]">
        <div className="text-xs text-[var(--v2-ink-3)] mb-1">Connected wallet</div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-mono text-[var(--v2-ink)]">
            {shortAddress(address)}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="px-2 py-1 rounded-md text-xs text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {chainName && (
          <div className="mt-3 text-xs text-[var(--v2-ink-3)]">
            Network:{' '}
            <span className="text-[var(--v2-ink)]">{chainName}</span>
          </div>
        )}
      </div>

      <div className="p-2">
        <button
          type="button"
          disabled={switching}
          onClick={() => {
            onClose()
            onSwitchWallet()
          }}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
        >
          {switching ? 'Disconnecting…' : 'Switch wallet'}
        </button>
        <button
          type="button"
          disabled={switching}
          onClick={async () => {
            onClose()
            try {
              await disconnectAsync()
            } catch {
              /* ignore */
            }
          }}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-[var(--v2-danger)] hover:bg-[var(--v2-danger-soft)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-danger)]/30"
        >
          Disconnect
        </button>
      </div>
    </div>
  )
}

/**
 * Single Haven-styled wallet entry point for the TopBar. Replaces RainbowKit's
 * default ConnectButton: no separate chain icon, one pill that opens a Haven
 * popover when connected. Falls back to RainbowKit's connect/account modals
 * for the heavy lifting (connector picker, account modal).
 */
export default function WalletButton() {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [popoverOpen, setPopoverOpen] = useState(false)

  // "Switch wallet" flow: disconnect, then open the connect modal once
  // wagmi has committed isConnected=false. Driven from the parent so the
  // open call survives the popover unmounting and lands in the
  // disconnected render path (RainbowKit refuses to open the connect
  // modal while a wallet is still connected).
  const { isConnected } = useAccount()
  const { disconnectAsync } = useDisconnect()
  const { openConnectModal: openConnectModalHook } = useConnectModal()
  const [pendingSwitch, setPendingSwitch] = useState(false)

  useEffect(() => {
    if (pendingSwitch && !isConnected && openConnectModalHook) {
      setPendingSwitch(false)
      openConnectModalHook()
    }
  }, [pendingSwitch, isConnected, openConnectModalHook])

  const handleSwitchWallet = async () => {
    setPendingSwitch(true)
    try {
      await disconnectAsync()
    } catch {
      setPendingSwitch(false)
    }
  }

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openConnectModal,
        openChainModal,
        mounted,
        authenticationStatus,
      }) => {
        const ready = mounted && authenticationStatus !== 'loading'
        const connected =
          ready &&
          !!account &&
          !!chain &&
          (!authenticationStatus || authenticationStatus === 'authenticated')

        // Hide entirely until mounted to avoid SSR mismatch.
        if (!ready) {
          return (
            <div
              aria-hidden
              style={{ opacity: 0, pointerEvents: 'none', userSelect: 'none' }}
            />
          )
        }

        if (!connected) {
          return (
            <button
              type="button"
              onClick={openConnectModal}
              className="px-4 py-2 rounded-md text-sm font-medium bg-[var(--v2-brand)] hover:bg-[var(--v2-brand-strong)] text-white shadow-[var(--v2-shadow-button)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
            >
              Connect wallet
            </button>
          )
        }

        const unsupported =
          chain.unsupported || !SUPPORTED_CHAIN_IDS.includes(chain.id)

        if (unsupported) {
          return (
            <button
              type="button"
              onClick={openChainModal}
              className="px-3 py-2 rounded-md text-sm font-medium bg-[var(--v2-danger-soft)] text-[var(--v2-danger)] border border-[var(--v2-danger)]/25 hover:border-[var(--v2-danger)]/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-danger)]/30"
            >
              Wrong network
            </button>
          )
        }

        return (
          <div className="relative">
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setPopoverOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={popoverOpen}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-white hover:bg-[var(--v2-surface)] text-[var(--v2-ink)] border border-[var(--v2-border)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
            >
              {account.ensAvatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={account.ensAvatar}
                  alt=""
                  className="w-5 h-5 rounded-full"
                />
              ) : (
                <span
                  aria-hidden
                  className="w-5 h-5 rounded-full bg-[var(--v2-brand)]"
                />
              )}
              <span className="font-mono">
                {account.ensName ?? shortAddress(account.address)}
              </span>
            </button>

            <WalletPopover
              address={account.address}
              chainName={chain.name}
              open={popoverOpen}
              onClose={() => setPopoverOpen(false)}
              onSwitchWallet={handleSwitchWallet}
              switching={pendingSwitch}
              anchorRef={triggerRef}
            />
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
