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
import { TriangleAlert, Wallet } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useAccount, useDisconnect } from 'wagmi'
import type { Address } from 'viem'
import { useAuth } from '@/context/AuthContext'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
import { getChainConfig, SUPPORTED_CHAIN_IDS } from '@/lib/chains'
import { useActiveSigner, hybridPasskeyOnDevice } from '@/lib/signer'
import { passkeyRowLabel } from '@/lib/passkeyLabels'
import { useOwnerDirectory } from '@/context/OwnerDirectoryContext'
import { truncateAddress } from '@/components/haven'

// Generative identicon gradient stops — decorative art hashed from an address
// for visual variety, NOT design-system colour. These are data, not UI chrome,
// so they legitimately stay literal (design-lint-disable-line per row) rather
// than becoming ~18 meaningless tokens. See /design-system → "How to use this page".
const AVATAR_PALETTES = [
  ['#4f46e5', '#06b6d4', '#14b8a6'], // design-lint-disable-line
  ['#0f766e', '#22c55e', '#facc15'], // design-lint-disable-line
  ['#7c3aed', '#ec4899', '#f97316'], // design-lint-disable-line
  ['#2563eb', '#8b5cf6', '#f43f5e'], // design-lint-disable-line
  ['#0891b2', '#0ea5e9', '#6366f1'], // design-lint-disable-line
  ['#059669', '#84cc16', '#06b6d4'], // design-lint-disable-line
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

/**
 * Below `sm`, every state of this control collapses to a 40px square: the icon
 * or the address avatar, and no label (#1803, owner decision 2026-08-23).
 *
 * `TopBar` is over-subscribed at 320px and always was. #1767 stopped the
 * controls OVERLAPPING by making the account chip the only compressible item,
 * which paid for the whole deficit out of one label: measured on `/dashboard`
 * under Pixel 5 emulation, the account name rendered **17px** wide — present,
 * orderly, unreadable. This control is the widest thing in the bar (88.64px as
 * "Connect wallet" at 320, 119.33px at 390) and the biggest single saving
 * available, so it is what gets dropped. Measured with the collapse applied:
 * the account name goes 17px -> **66px** at 320 and 57px -> 68px at 390, which
 * is within 2px of never truncating at all in the screenshot fixture.
 *
 * Dropped, not squeezed, and PRESENTATION rather than capability: the control
 * stays in the bar and stays reachable, only its label goes. At 320 the label
 * was not readable in the first place — the brand pill wrapped to two lines
 * ("Connect" / "wallet") and painted taller than the 56px band.
 *
 * Same rule #1767 applied one control over, where the chain segment is dropped
 * below `sm` and carried by the coloured dot plus the trigger's `aria-label`.
 *
 * Two things the collapse must not break, both asserted:
 *
 *  1. **The accessible name.** A label hidden by `hidden sm:inline` is
 *     `display: none` in a real engine, so it stops contributing to the
 *     accessible name and an icon-only button would announce as "button".
 *     Every state therefore carries an EXPLICIT `aria-label` (and a matching
 *     `title`, which is also the pointer-hover mitigation for the lost label).
 *     `WalletButton.test.tsx` pins the accessible name of each state; jsdom
 *     applies no CSS, so those tests would keep passing on the visible text
 *     alone — they assert the `aria-label` attribute itself for that reason.
 *  2. **The 40px footprint**, which is the notification bell's exactly. Not
 *     44px painted: matching the adjacent control is what keeps the bar a row
 *     rather than a set of differently-sized squares, and the bell's own 40px
 *     box is what shipped. The 44px COMFORT TARGET
 *     `docs/product/design-system.md` § Buttons asks for is met the way #1726
 *     and #1766 met it — a transparent `::after` that extends the hit area
 *     without moving a painted pixel. This is the third borrower of that
 *     mechanism outside `Button`, and the rule it follows is the one #1766
 *     wrote down: an icon-only square has no long axis, so it grows in both.
 *     It fits: the 44px target is 2px wider per side than the box, against a
 *     12px `gap-3` to the bell, so 10px of clearance remain — above the 8px
 *     § Buttons asks between adjacent targets. `sm:after:content-none` retires
 *     it the moment the label comes back and the control is wide anyway.
 *     `e2e/mobile-nav-tap-target.mobile.spec.ts` measures both the ≥8px border
 *     gap and this hit rectangle, in a real engine — jsdom has neither layout
 *     nor hit-testing, so a pseudo-element that silently no-ops is invisible
 *     to every unit test in the repo.
 */
const COLLAPSE_BELOW_SM =
  "relative h-10 w-10 justify-center rounded-xl p-0 after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] sm:h-auto sm:w-auto sm:justify-start sm:rounded-md sm:after:content-none"
/** The label itself — rendered from `sm` up, and in `aria-label` always. */
const LABEL_BELOW_SM = 'hidden sm:inline'

interface AddressSection {
  label: string
  address: string
  chainName?: string
  displayName?: string | null
}

interface PopoverProps {
  primary: AddressSection
  secondary?: AddressSection
  /**
   * #1126: identifies the ACTIVE passkey/device without an address — Hybrid
   * passkeys are raw P256 coordinates on the account contract and have no
   * on-chain address of their own; showing the treasury address here implied
   * the credential owned it.
   */
  signingWith?: { label: string; keyId: string }
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
  signingWith,
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
  const copyTimerRef = useRef<number | null>(null)

  // Cancel the copy-reset timer on unmount so it never fires into a dead component.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

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
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      setCopiedAddress(address)
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedAddress(null)
        copyTimerRef.current = null
      }, 1500)
    } catch {
      /* ignore */
    }
  }

  const renderAddressSection = (section: AddressSection, border = false) => (
    <div className={border ? 'pt-4 mt-4 border-t border-[var(--v2-border)]' : undefined}>
      <div className="text-xs text-[var(--v2-ink-3)] mb-1">{section.label}</div>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          {section.displayName ? (
            <div className="truncate text-sm font-medium text-[var(--v2-ink)]">
              {section.displayName}
            </div>
          ) : null}
          <span className="text-sm font-mono text-[var(--v2-ink)]">
            {truncateAddress(section.address)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => handleCopy(section.address)}
          className="px-2 py-1 rounded-md text-xs text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
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
        {signingWith ? (
          <div className="py-2">
            <p className="text-xs text-[var(--v2-ink-muted)]">Signing with</p>
            <p className="text-sm font-medium text-[var(--v2-ink)]">{signingWith.label}</p>
            <p className="truncate font-mono text-xs text-[var(--v2-ink-muted)]">
              {truncateAddress(signingWith.keyId)}
            </p>
          </div>
        ) : null}
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
          className="w-full text-left px-3 py-2 rounded-md text-sm text-[var(--v2-ink)] hover:bg-[var(--v2-surface)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
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
            className="w-full text-left px-3 py-2 rounded-md text-sm text-[var(--v2-danger)] hover:bg-[var(--v2-danger-soft)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80"
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
  const { getOwnerAlias } = useOwnerDirectory()
  const activeSafeAddress = activeSafe?.safe_address as Address | undefined
  const activeSigner = useActiveSigner({
    safeAddress: activeSafeAddress,
    chainId: activeSafe?.chain_id,
  })
  const passkeySigner = activeSigner?.type === 'passkey' ? activeSigner : null
  // #1079: a Hybrid DeleGator account whose passkey is on this device gets the
  // same "Passkey ready" pill — the reported symptom was this header reading
  // "Connect wallet" for a passkey that had just signed a budget.
  const delegatorSigner = activeSigner?.type === 'delegator_passkey' ? activeSigner : null
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
    if (!pendingSwitch) return

    if (!isConnected && openConnectModalHook) {
      setPendingSwitch(false)
      openConnectModalHook()
      return
    }

    // Safety valve: if we have been in pending state for >3 s but the connect
    // modal is still not available (e.g. RainbowKit not ready), give up so the
    // UI doesn't stay stuck on "Disconnecting…" indefinitely.
    const id = window.setTimeout(() => setPendingSwitch(false), 3000)
    return () => window.clearTimeout(id)
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
          const passkeyAlias = getOwnerAlias(passkeySigner.address)
          const connectedWallet =
            connected && account
              ? {
                  label: 'Connected wallet',
                  address: account.address,
                  chainName: chain?.name,
                  displayName: getOwnerAlias(account.address),
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
                aria-label={passkeyAlias ?? 'Passkey'}
                title={passkeyAlias ?? 'Passkey'}
                className={`flex items-center gap-2 text-sm font-medium bg-white hover:bg-[var(--v2-surface)] text-[var(--v2-ink)] border border-[var(--v2-border)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 sm:px-3 sm:py-1.5 ${COLLAPSE_BELOW_SM}`}
              >
                <AddressAvatar address={passkeySigner.address} />
                <span className={LABEL_BELOW_SM}>{passkeyAlias ?? 'Passkey'}</span>
              </button>

              <WalletPopover
                primary={{
                  label: 'Passkey',
                  address: passkeySigner.address,
                  chainName: safeChainName,
                  displayName: passkeyAlias,
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

        if (delegatorSigner) {
          const accountAlias = getOwnerAlias(delegatorSigner.accountAddress)
          // #1126/#1679: name the enrolled-on-this-device credential the same
          // way AccountSignersCard does — "Passkey · added {date}", never a
          // platform brand or a positional label. No address: Hybrid passkeys
          // have none.
          const onDeviceKey = hybridPasskeyOnDevice(delegatorSigner.signers)
          const keyIndex = onDeviceKey
            ? delegatorSigner.signers.passkeys.findIndex((pk) => pk.key_id === onDeviceKey.key_id)
            : -1
          const signingWith = onDeviceKey
            ? {
                label: passkeyRowLabel(onDeviceKey.created_at, keyIndex),
                keyId: onDeviceKey.key_id,
              }
            : undefined
          const connectedWallet =
            connected && account
              ? {
                  label: 'Connected wallet',
                  address: account.address,
                  chainName: chain?.name,
                  displayName: getOwnerAlias(account.address),
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
                aria-label="Passkey"
                title="Passkey"
                className={`flex items-center gap-2 text-sm font-medium bg-white hover:bg-[var(--v2-surface)] text-[var(--v2-ink)] border border-[var(--v2-border)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 sm:px-3 sm:py-1.5 ${COLLAPSE_BELOW_SM}`}
              >
                <AddressAvatar address={delegatorSigner.accountAddress} />
                <span className={LABEL_BELOW_SM}>Passkey</span>
              </button>

              <WalletPopover
                primary={{
                  label: 'Haven account',
                  address: delegatorSigner.accountAddress,
                  chainName: safeChainName,
                  displayName: accountAlias,
                }}
                signingWith={signingWith}
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
              // The label lives in `aria-label` because it is not rendered
              // below `sm` (#1803). `title` is the pointer-hover half of the
              // same mitigation — and the accepted cost is that a touch user
              // meeting this control for the first time gets neither: see
              // COLLAPSE_BELOW_SM.
              aria-label="Connect wallet"
              title="Connect wallet"
              // Offset against the page, as ui/Button does: on a brand-FILLED
              // control an un-offset brand ring composites brand-over-brand and
              // measures ~1.0:1 — invisible at any opacity (#1741).
              className={`inline-flex items-center gap-2 text-sm font-medium bg-[var(--v2-brand)] hover:bg-[var(--v2-brand-strong)] text-white shadow-[var(--v2-shadow-button)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)] sm:px-4 sm:py-2 ${COLLAPSE_BELOW_SM}`}
            >
              <Icon icon={Wallet} className="h-4 w-4 shrink-0 sm:hidden" />
              <span className={LABEL_BELOW_SM}>Connect wallet</span>
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
              aria-label="Wrong network"
              title="Wrong network"
              className={`inline-flex items-center gap-2 text-sm font-medium bg-[var(--v2-danger-soft)] text-[var(--v2-danger)] border border-danger/25 hover:border-danger/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/80 sm:px-3 sm:py-2 ${COLLAPSE_BELOW_SM}`}
            >
              <Icon icon={TriangleAlert} className="h-4 w-4 shrink-0 sm:hidden" />
              <span className={LABEL_BELOW_SM}>Wrong network</span>
            </button>
          )
        }

        const accountAlias = getOwnerAlias(account.address)
        // One expression, used for the visible label AND the accessible name,
        // so the two cannot drift once the label stops rendering below `sm`.
        const walletLabel = accountAlias ?? account.ensName ?? truncateAddress(account.address)

        return (
          <div className="relative">
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setPopoverOpen((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={popoverOpen}
              aria-label={walletLabel}
              title={walletLabel}
              className={`flex items-center gap-2 text-sm font-medium bg-white hover:bg-[var(--v2-surface)] text-[var(--v2-ink)] border border-[var(--v2-border)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 sm:px-3 sm:py-1.5 ${COLLAPSE_BELOW_SM}`}
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
              <span className={`${LABEL_BELOW_SM} ${accountAlias ? '' : 'font-mono'}`}>
                {walletLabel}
              </span>
            </button>

            <WalletPopover
              primary={{
                label: 'Connected wallet',
                address: account.address,
                chainName: chain.name,
                displayName: accountAlias ?? account.ensName,
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
