'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getChainConfig } from '@/lib/chains'
import type {
  TransactionFilterAgentOption,
  TransactionFilterSafeOption,
  TransactionFilterState,
  TransactionFilterTokenOption,
} from '@/types/transactions'

interface FilterBarProps {
  filters: TransactionFilterState
  safes: TransactionFilterSafeOption[]
  agents: TransactionFilterAgentOption[]
  tokens: TransactionFilterTokenOption[]
  loading: boolean
  error: string | null
  onChange: (filters: TransactionFilterState) => void
}

type DropdownKey = 'safe' | 'agent' | 'token' | null

function chainLabel(chainId: number): string {
  return getChainConfig(chainId).name.replace(/\s+Chain$/, '')
}

function tokenLabel(token: TransactionFilterTokenOption): string {
  return token.isNative
    ? `Native ${token.symbol} (${chainLabel(token.chainId)})`
    : `${token.symbol} (${chainLabel(token.chainId)})`
}

function agentStatusTone(status: string): string {
  if (status === 'active') return 'text-zinc-200'
  if (status === 'paused') return 'text-zinc-500'
  return 'text-zinc-600'
}

function triggerClasses(active: boolean, disabled = false): string {
  return [
    'flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors',
    active
      ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
      : 'border-white/[0.06] bg-white/[0.04] text-zinc-300 hover:bg-white/[0.06]',
    disabled ? 'cursor-not-allowed opacity-60 hover:bg-white/[0.04]' : '',
  ].join(' ')
}

export default function FilterBar({
  filters,
  safes,
  agents,
  tokens,
  loading,
  error,
  onChange,
}: FilterBarProps) {
  const [open, setOpen] = useState<DropdownKey>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(null)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const sortedAgents = [...agents].sort((a, b) => {
    const rank = (status: string) => {
      if (status === 'active') return 0
      if (status === 'paused') return 1
      return 2
    }
    return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name)
  })

  const selectedSafe = safes.find((safe) => safe.id === filters.safeId)
  const selectedAgent =
    filters.agentId === 'user'
      ? { id: 'user', name: 'User (manual)', status: 'manual' }
      : agents.find((agent) => agent.id === filters.agentId)
  const selectedToken = tokens.find((token) => token.key === filters.tokenKey)

  const chips = [
    selectedSafe
      ? { key: 'safeId' as const, label: `Safe: ${selectedSafe.name}` }
      : null,
    selectedAgent
      ? { key: 'agentId' as const, label: `Initiator: ${selectedAgent.name}` }
      : null,
    selectedToken
      ? { key: 'tokenKey' as const, label: `Token: ${tokenLabel(selectedToken)}` }
      : null,
  ].filter((chip): chip is { key: keyof TransactionFilterState; label: string } => Boolean(chip))

  const clearFilter = (key: keyof TransactionFilterState) => {
    if (key === 'safeId') onChange({ ...filters, safeId: undefined })
    if (key === 'agentId') onChange({ ...filters, agentId: undefined })
    if (key === 'tokenKey') onChange({ ...filters, tokenKey: undefined })
  }

  return (
    <div ref={ref} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="relative">
          <button
            onClick={() => {
              if (safes.length <= 1) return
              setOpen(open === 'safe' ? null : 'safe')
            }}
            disabled={safes.length <= 1}
            className={triggerClasses(Boolean(filters.safeId), safes.length <= 1)}
          >
            <span>Safe: {selectedSafe?.name ?? 'All'}</span>
            <Chevron open={open === 'safe'} />
          </button>
          {open === 'safe' && safes.length > 1 && (
            <div className="absolute left-0 top-full z-40 mt-2 min-w-60 overflow-hidden rounded-lg border border-white/[0.08] bg-[#141414] shadow-xl">
              <DropdownButton
                active={!filters.safeId}
                onClick={() => {
                  onChange({ ...filters, safeId: undefined })
                  setOpen(null)
                }}
              >
                All
              </DropdownButton>
              {safes.map((safe) => (
                <DropdownButton
                  key={safe.id}
                  active={filters.safeId === safe.id}
                  onClick={() => {
                    onChange({ ...filters, safeId: safe.id })
                    setOpen(null)
                  }}
                >
                  <div className="min-w-0 text-left">
                    <div className="truncate font-medium">{safe.name}</div>
                    <div className="text-[10px] text-zinc-600">
                      {chainLabel(safe.chainId)}
                    </div>
                  </div>
                </DropdownButton>
              ))}
            </div>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => setOpen(open === 'agent' ? null : 'agent')}
            className={triggerClasses(Boolean(filters.agentId))}
          >
            <span>Initiator: {selectedAgent?.name ?? 'All'}</span>
            <Chevron open={open === 'agent'} />
          </button>
          {open === 'agent' && (
            <div className="absolute left-0 top-full z-40 mt-2 min-w-64 overflow-hidden rounded-lg border border-white/[0.08] bg-[#141414] shadow-xl">
              <DropdownButton
                active={!filters.agentId}
                onClick={() => {
                  onChange({ ...filters, agentId: undefined })
                  setOpen(null)
                }}
              >
                All
              </DropdownButton>
              <DropdownButton
                active={filters.agentId === 'user'}
                onClick={() => {
                  onChange({ ...filters, agentId: 'user' })
                  setOpen(null)
                }}
              >
                <div className="min-w-0 text-left">
                  <div className="truncate font-medium">User (manual)</div>
                </div>
              </DropdownButton>
              {sortedAgents.map((agent) => (
                <DropdownButton
                  key={agent.id}
                  active={filters.agentId === agent.id}
                  onClick={() => {
                    onChange({ ...filters, agentId: agent.id })
                    setOpen(null)
                  }}
                >
                  <div className="min-w-0 text-left">
                    <div className={`truncate font-medium ${agentStatusTone(agent.status)}`}>
                      {agent.name}
                    </div>
                    <div className="text-[10px] uppercase tracking-wide text-zinc-600">
                      {agent.status}
                    </div>
                  </div>
                </DropdownButton>
              ))}
            </div>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => setOpen(open === 'token' ? null : 'token')}
            className={triggerClasses(Boolean(filters.tokenKey))}
          >
            <span>Token: {selectedToken ? tokenLabel(selectedToken) : 'All'}</span>
            <Chevron open={open === 'token'} />
          </button>
          {open === 'token' && (
            <div className="absolute left-0 top-full z-40 mt-2 max-h-80 min-w-72 overflow-y-auto rounded-lg border border-white/[0.08] bg-[#141414] shadow-xl">
              <DropdownButton
                active={!filters.tokenKey}
                onClick={() => {
                  onChange({ ...filters, tokenKey: undefined })
                  setOpen(null)
                }}
              >
                All
              </DropdownButton>
              {tokens.map((token) => (
                <DropdownButton
                  key={token.key}
                  active={filters.tokenKey === token.key}
                  onClick={() => {
                    onChange({ ...filters, tokenKey: token.key })
                    setOpen(null)
                  }}
                >
                  <div className="min-w-0 text-left">
                    <div className="truncate font-medium">{tokenLabel(token)}</div>
                  </div>
                </DropdownButton>
              ))}
            </div>
          )}
        </div>
      </div>

      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => clearFilter(chip.key)}
              className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-1 text-xs text-indigo-400 transition-colors hover:bg-indigo-500/15"
            >
              <span>{chip.label}</span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

      {(loading || error) && (
        <div className="mt-3 text-xs">
          {loading && <span className="text-zinc-600">Loading filter options...</span>}
          {error && <span className="text-red-400">{error}</span>}
        </div>
      )}
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3 w-3 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
    </svg>
  )
}

function DropdownButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors ${
        active
          ? 'bg-indigo-500/10 text-indigo-400'
          : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  )
}
