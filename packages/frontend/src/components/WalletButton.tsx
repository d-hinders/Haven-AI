'use client'

import { useEffect, useRef, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useDisconnect } from 'wagmi'
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
  onSwitchWallet: () => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
}

function WalletPopover({
  address,
  chainName,
  open,
  onClose,
  onSwitchWallet,
  anchorRef,
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const { disconnect } = useDisconnect()
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
      className="absolute right-0 top-full mt-2 w-72 z-50 bg-[#111113] border border-white/[0.08] rounded-xl shadow-2xl shadow-black/40 overflow-hidden"
    >
      <div className="p-4 border-b border-white/[0.04]">
        <div className="text-xs text-zinc-500 mb-1">Connected wallet</div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-mono text-zinc-200">
            {shortAddress(address)}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="px-2 py-1 rounded-md text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {chainName && (
          <div className="mt-3 text-xs text-zinc-500">
            Network:{' '}
            <span className="text-zinc-300">{chainName}</span>
          </div>
        )}
      </div>

      <div className="p-2">
        <button
          type="button"
          onClick={() => {
            onClose()
            onSwitchWallet()
          }}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-zinc-200 hover:bg-white/[0.04] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
        >
          Switch wallet
        </button>
        <button
          type="button"
          onClick={() => {
            onClose()
            disconnect()
          }}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-red-400 hover:bg-red-500/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
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

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openConnectModal,
        openAccountModal,
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
              className="px-4 py-2 rounded-md text-sm font-medium bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-400 hover:to-violet-500 text-white shadow-lg shadow-indigo-500/20 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
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
              className="px-3 py-2 rounded-md text-sm font-medium bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50"
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
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium bg-white/[0.04] hover:bg-white/[0.08] text-zinc-200 border border-white/[0.06] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
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
                  className="w-5 h-5 rounded-full bg-gradient-to-br from-indigo-500 to-violet-600"
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
              onSwitchWallet={openAccountModal}
              anchorRef={triggerRef}
            />
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
