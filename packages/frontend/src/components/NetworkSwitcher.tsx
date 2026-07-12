'use client'

import { Check, ChevronDown } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { useActiveChainId } from '@/hooks/useActiveChain'
import { getChainConfig } from '@/lib/chains'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/DropdownMenu'

/**
 * Active account / chain switcher (#628, epic #625) — the MetaMask-style network
 * chip. Shows the active account and its chain (coloured dot + name); the dropdown
 * lists every account so the user can flip the active one. Switching the active
 * account is what changes the active chain (see `useActiveChain`); under
 * architecture B (#626) this is pure client state — no backend switch.
 */

// Per-chain dot colour (display only). Base blue, Gnosis teal, Sepolia amber to
// flag it as a testnet.
const CHAIN_DOT: Record<number, string> = {
  8453: 'var(--v2-chain-base)',
  84532: 'var(--v2-chain-testnet)',
  100: 'var(--v2-chain-gnosis)',
}

function chainDotColor(chainId: number): string {
  return CHAIN_DOT[chainId] ?? 'var(--v2-ink-3)'
}

function chainName(chainId: number): string {
  try {
    return getChainConfig(chainId).name
  } catch {
    return `Chain ${chainId}`
  }
}

function ChainDot({ chainId }: { chainId: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
      style={{ backgroundColor: chainDotColor(chainId) }}
    />
  )
}

export default function NetworkSwitcher() {
  const router = useRouter()
  const { user, activeSafe, setActiveSafe } = useAuth()
  const activeChainId = useActiveChainId()
  const safes = user?.safes ?? []

  // The chip only makes sense once an account exists (onboarding has none).
  if (!activeSafe) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex items-center gap-2 rounded-full border border-[var(--v2-border)] bg-[var(--v2-bg)] px-2.5 py-1 text-[13px] font-medium text-[var(--v2-ink)] transition-colors hover:bg-[var(--v2-surface)]"
        aria-label={`Active account ${activeSafe.name} on ${chainName(activeChainId)} — switch`}
      >
        <ChainDot chainId={activeChainId} />
        <span className="max-w-[140px] truncate">{activeSafe.name}</span>
        <span className="text-[var(--v2-ink-3)]">·</span>
        <span className="text-[var(--v2-ink-2)]">{chainName(activeChainId)}</span>
        <Icon icon={ChevronDown} className="h-3 w-3 text-[var(--v2-ink-3)]" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="left">
        {safes.map((safe) => (
          <DropdownMenuItem key={safe.id} onSelect={() => setActiveSafe(safe)}>
            <ChainDot chainId={safe.chain_id} />
            <span className="flex-1 truncate">{safe.name}</span>
            <span className="text-xs text-[var(--v2-ink-3)]">{chainName(safe.chain_id)}</span>
            {safe.id === activeSafe.id && (
              <Icon icon={Check} className="h-3.5 w-3.5 flex-shrink-0 text-[var(--v2-brand)]" />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/accounts')}>
          <span className="text-[var(--v2-ink-2)]">Manage accounts</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
