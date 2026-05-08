'use client'

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { ConnectButton, useConnectModal } from '@rainbow-me/rainbowkit'
import { useAccount, useDisconnect } from 'wagmi'
import type { Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { getChainConfig, SUPPORTED_CHAIN_IDS } from '@/lib/chains'
import { useActiveSigner } from '@/lib/signer'

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

const AVATAR_PALETTES = [
  ['#4f46e5', '#06b6d4', '#14b8a6'],
  ['#0f766e', '#22c55e', '#facc15'],
  ['#7c3aed', '#ec4899', '#f97316'],
  ['#2563eb', '#8b5cf6', '#f43f5e'],
  ['#0891b2', '#0ea5e9', '#6366f1'],
  ['#059669', '#84cc16', '#06b6d4'],
] as const

function hashAddress(address: string): number {
  let hash = 0
  for (const char of address.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return hash
}

function getAvatarStyle(address: string): CSSProperties {
  const hash = hashAddress(address)
  const palette = AVATAR_PALETTES[hash % AVATAR_PALETTES.length]
  const angle = hash % 360
  const stripeAngle = (hash >> 3) % 180

  return {
    backgroundImage: [
      `repeating-linear-gradient(${stripeAngle}deg, rgba(255,255,255,0.18) 0 2px, transparent 2px 5px)`,
      `linear-gradient(${angle}deg, ${palette[0]}, ${palette[1]} 52%, ${palette[2]})`,
    ].join(', '),
  }
}

function AddressAvatar({ address }: { address: string }) {
  return (
    <span
      aria-hidden
      className="h-5 w-5 shrink-0 overflow-hidden rounded-full border border-white/70 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.35)]"
      style={getAvatarStyle(address)}
    />
  )
}

interface AddressSection {
  label: string
  address: string
  chainName?: string
}

interface PopoverProps {
  primary: AddressSection
  secondary?: AddressSection
  unavailablePasskey?: boolean
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
  onConnectWallet: () => void
  hasConnectedWallet: boolean
  switching: boolean
  anchorRef: RefObject<HTMLButtonElement | null>
}

function WalletPopover({
  primary,
  secondary,
  unavailablePasskey = false,
  open,
  onClose,
  onSwitchWallet,
  onConnectWallet,
  hasConnectedWallet,
  switching,
  anchorRef,
}: PopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const { disconnectAsync } = useDisconnect()
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null)

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

  const handleCopy = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address)
      setCopiedAddress(address)
      window.setTimeout(() => setCopiedAddress(null), 1500)
    } catch {
      /* ignore */
    }
  }

  const renderAddressSection = (section: AddressSection, border = false) => (
    <div className={border ? 'pt-4 mt-4 border-t border-[var(--v2-border)]' : undefined}>
      <div className="text-xs text-[var(--v2-ink-3)] mb-1">{section.label}</div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-mono text-[var(--v2-ink)]">
          {shortAddress(section.address)}
        </span>
        <button
          type="button"
          onClick={() => handleCopy(section.address)}
          className="px-2 py-1 rounded-md text-xs text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
        >
          {copiedAddress === section.address ? 'Copied' : 'Copy'}
        </button>
      </div>
      {section.chainName && (
        <div className="mt-3 text-xs text-[var(--v2-ink-3)]">
          Network:{' '}
          <span className="text-[var(--v2-ink)]">{section.chainName}</span>
        </div>
      )}
    </div>
  )

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Wallet menu"
      className="absolute right-0 top-full mt-2 w-72 z-50 bg-[var(--v2-bg)] border border-[var(--v2-border)] rounded-xl shadow-[var(--v2-shadow-modal)] overflow-hidden"
    >
      <div className="p-4 border-b border-[var(--v2-border)]">
        {unavailablePasskey && (
          <p className="mb-4 text-xs text-[var(--v2-ink-3)]">
            This account uses a passkey that is not available here.
          </p>
        )}
        {renderAddressSection(primary)}
        {secondary && renderAddressSection(secondary, true)}
      </div>

      <div className="p-2">
        <button
          type="button"
          disabled={switching}
          onClick={() => {
            onClose()
            if (hasConnectedWallet) {
              onSwitchWallet()
            } else {
              onConnectWallet()
            }
          }}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
        >
          {switching
            ? 'Disconnecting…'
            : hasConnectedWallet
              ? 'Switch wallet'
              : 'Connect wallet instead'}
        </button>
        {hasConnectedWallet && (
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
        )}
      </div>
    </div>
  )
}

function getSafeChainName(chainId?: number): string | undefined {
  if (chainId === undefined) return undefined

  try {
    return getChainConfig(chainId).name
  } catch {
    return undefined
  }
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
  const { activeSafe, passkeys } = useAuth()
  const activeSafeAddress = activeSafe?.safe_address as Address | undefined
  const activeSigner = useActiveSigner({
    safeAddress: activeSafeAddress,
    chainId: activeSafe?.chain_id,
  })
  const passkeySigner = activeSigner?.type === 'passkey' ? activeSigner : null
  const passkeyUnavailableOnDevice = useMemo(() => {
    const safeAddress = activeSafe?.safe_address.toLowerCase()
    if (!safeAddress || activeSafe?.chain_id === undefined || passkeySigner) {
      return false
    }

    return passkeys.some(
      (passkey) =>
        passkey.chain_id === activeSafe.chain_id &&
        passkey.safe_address?.toLowerCase() === safeAddress,
    )
  }, [activeSafe?.chain_id, activeSafe?.safe_address, passkeySigner, passkeys])

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

        const safeChainName = getSafeChainName(activeSafe?.chain_id)
        const openWalletConnect = () => {
          if (openConnectModalHook) {
            openConnectModalHook()
            return
          }

          openConnectModal?.()
        }

        if (passkeySigner) {
          const connectedWallet =
            connected && account
              ? {
                  label: 'Connected wallet',
                  address: account.address,
                  chainName: chain?.name,
                }
              : undefined

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
                <AddressAvatar address={passkeySigner.address} />
                <span>Passkey ready</span>
              </button>

              <WalletPopover
                primary={{
                  label: 'Passkey',
                  address: passkeySigner.address,
                  chainName: safeChainName,
                }}
                secondary={connectedWallet}
                open={popoverOpen}
                onClose={() => setPopoverOpen(false)}
                onSwitchWallet={handleSwitchWallet}
                onConnectWallet={openWalletConnect}
                hasConnectedWallet={connected}
                switching={pendingSwitch}
                anchorRef={triggerRef}
              />
            </div>
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
                  className="h-5 w-5 shrink-0 rounded-full"
                />
              ) : (
                <AddressAvatar address={account.address} />
              )}
              <span className="font-mono">
                {account.ensName ?? shortAddress(account.address)}
              </span>
            </button>

            <WalletPopover
              primary={{
                label: 'Connected wallet',
                address: account.address,
                chainName: chain.name,
              }}
              unavailablePasskey={passkeyUnavailableOnDevice}
              open={popoverOpen}
              onClose={() => setPopoverOpen(false)}
              onSwitchWallet={handleSwitchWallet}
              onConnectWallet={openWalletConnect}
              hasConnectedWallet={connected}
              switching={pendingSwitch}
              anchorRef={triggerRef}
            />
          </div>
        )
      }}
    </ConnectButton.Custom>
  )
}
