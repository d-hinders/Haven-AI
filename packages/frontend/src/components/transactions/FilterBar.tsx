'use client'

import { ChevronDown, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { resolveChainOrNull } from '@/lib/chains'
import { agentStatusPresentation } from '@/lib/payment-status'
import type {
  TransactionFilterAgentOption,
  TransactionFilterAccountOption,
  TransactionFilterState,
  TransactionFilterTokenOption,
  TransactionPeriodPreset,
} from '@/types/transactions'

interface FilterBarProps {
  filters: TransactionFilterState
  accounts: TransactionFilterAccountOption[]
  agents: TransactionFilterAgentOption[]
  tokens: TransactionFilterTokenOption[]
  loading: boolean
  error: string | null
  onChange: (filters: TransactionFilterState) => void
  /**
   * Hide the Account chip and trigger when the page FIXES the account — the
   * account Activity tab (#4093) passes one, so the account is not a filter
   * there and must not render as a removable chip. Default: shown, as on the
   * Transactions page.
   */
  hideAccountChip?: boolean
  /**
   * Export CSV lives in the bar since #4095 — one control, over the same
   * filters the list shows. Absent on surfaces with nothing to export.
   */
  onExport?: () => void
  exporting?: boolean
  /** The page's export gate (server total > 0, not loading). */
  canExport?: boolean
}

type DropdownKey = 'account' | 'agent' | 'token' | 'direction' | 'period' | null

const DIRECTION_OPTIONS: { value: 'in' | 'out'; label: string }[] = [
  { value: 'in', label: 'Incoming' },
  { value: 'out', label: 'Outgoing' },
]

const PERIOD_PRESET_OPTIONS: { value: TransactionPeriodPreset; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
]

const SEARCH_COMMIT_DELAY_MS = 400

function directionLabel(direction: 'in' | 'out' | undefined): string {
  if (direction === 'in') return 'Incoming'
  if (direction === 'out') return 'Outgoing'
  return 'All'
}

/**
 * The Period chip's label. Presets read from the same strings the dropdown
 * shows, so the chip never names a window differently than the menu that
 * set it; a custom range shows its two calendar dates as sent.
 */
function periodLabel(filters: TransactionFilterState): string {
  const preset = PERIOD_PRESET_OPTIONS.find((option) => option.value === filters.period)
  if (preset) return preset.label
  if (filters.from && filters.to) return `${filters.from} to ${filters.to}`
  return 'All time'
}

/** True when a Period filter is active — a preset or a custom range. */
function hasPeriodFilter(filters: TransactionFilterState): boolean {
  return Boolean(filters.period || (filters.from && filters.to))
}

function chainLabel(chainId: number): string {
  const chain = resolveChainOrNull(chainId)
  return chain ? chain.name.replace(/\s+Chain$/, '') : `Chain ${chainId}`
}

function tokenLabel(token: TransactionFilterTokenOption): string {
  return token.isNative
    ? `Native ${token.symbol} (${chainLabel(token.chainId)})`
    : `${token.symbol} (${chainLabel(token.chainId)})`
}

function agentStatusClass(status: string): string {
  const { tone } = agentStatusPresentation(status)
  if (tone === 'success') return 'text-[var(--v2-ink)]'
  if (tone === 'warning') return 'text-[var(--v2-ink-2)]'
  return 'text-[var(--v2-ink-3)]'
}

function triggerClasses(active: boolean, disabled = false): string {
  return [
    'flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors',
    active
      ? 'border-brand/30 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
      : 'border-[var(--v2-border)] bg-[var(--v2-bg)] text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)]',
    disabled ? 'cursor-not-allowed opacity-60 hover:bg-[var(--v2-bg)]' : '',
  ].join(' ')
}

export default function FilterBar({
  filters,
  accounts,
  agents,
  tokens,
  loading,
  error,
  onChange,
  hideAccountChip = false,
  onExport,
  exporting = false,
  canExport = false,
}: FilterBarProps) {
  const [open, setOpen] = useState<DropdownKey>(null)
  const ref = useRef<HTMLDivElement>(null)

  // #4095: the search field commits debounced, not per keystroke — every
  // commit is a server round-trip plus a URL rewrite, and typing "savings"
  // must not fire six of them. Enter commits immediately.
  const [searchDraft, setSearchDraft] = useState(filters.search ?? '')
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The last value THIS bar committed, echoed back through the parent's
  // state. It separates our own commits (draft already matches) from an
  // EXTERNAL change — URL navigation, a cleared chip — which must reset the
  // field and cancel any pending debounce, or a stale timer could re-add a
  // term the user just removed.
  const committedSearchRef = useRef(filters.search ?? '')

  useEffect(() => {
    const incoming = filters.search ?? ''
    if (incoming !== committedSearchRef.current) {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
      committedSearchRef.current = incoming
      setSearchDraft(incoming)
    }
  }, [filters.search])

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [])

  // The custom range's two date fields, seeded from the active filter so
  // re-opening the form continues where the user left it.
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [showCustomRange, setShowCustomRange] = useState(false)

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

  const showAccountChip = !hideAccountChip
  const selectedAccount = accounts.find((account) => account.id === filters.accountId)
  // An account filter can be ACTIVE without being resolvable: `accountId` is
  // seeded from the URL (the "View all" link on account detail), while
  // `accounts` comes from a separate request that can be empty — during the
  // deploy window that the `?? []` in `useTransactionsFilters` creates, or on
  // any failed filter fetch. Saying "All" there would label a filtered money
  // history as unfiltered, which is the wrong failure direction on this
  // screen: a crash is loud, a wrong total is not. So the label admits the
  // filter it cannot name, and the chip below stays rendered so there is
  // always a way out — the trigger is disabled on a short list, so the chip
  // is the ONLY exit.
  const accountFilterUnresolved = Boolean(filters.accountId) && !selectedAccount
  const accountLabel = selectedAccount?.name ?? (accountFilterUnresolved ? 'filtered' : 'All')
  const selectedAgent =
    filters.agentId === 'user'
      ? { id: 'user', name: 'User (manual)', status: 'manual' }
      : agents.find((agent) => agent.id === filters.agentId)
  const selectedToken = tokens.find((token) => token.key === filters.tokenKey)

  const commitSearch = (value: string) => {
    committedSearchRef.current = value
    // An emptied field removes the filter entirely — the absent parameter is
    // "no search", and a blank `?search=` would still pin the URL.
    onChange({ ...filters, search: value.trim() ? value : undefined })
  }

  const handleSearchInput = (value: string) => {
    setSearchDraft(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null
      if (value !== committedSearchRef.current) commitSearch(value)
    }, SEARCH_COMMIT_DELAY_MS)
  }

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    if (searchDraft !== committedSearchRef.current) commitSearch(searchDraft)
  }

  const applyPeriodPreset = (preset: TransactionPeriodPreset) => {
    setShowCustomRange(false)
    setOpen(null)
    onChange({ ...filters, period: preset, from: undefined, to: undefined })
  }

  const clearPeriod = () => {
    setShowCustomRange(false)
    setOpen(null)
    onChange({ ...filters, period: undefined, from: undefined, to: undefined })
  }

  const openCustomRange = () => {
    setCustomFrom(filters.from ?? '')
    setCustomTo(filters.to ?? '')
    setShowCustomRange(true)
  }

  // Both dates set, start not after end — the same rule the server answers
  // with a 400, refused here before the request can be made.
  const customRangeValid =
    /^\d{4}-\d{2}-\d{2}$/.test(customFrom) &&
    /^\d{4}-\d{2}-\d{2}$/.test(customTo) &&
    customFrom <= customTo

  const applyCustomRange = () => {
    if (!customRangeValid) return
    setOpen(null)
    setShowCustomRange(false)
    onChange({ ...filters, period: undefined, from: customFrom, to: customTo })
  }

  type ChipKey = 'accountId' | 'agentId' | 'tokenKey' | 'direction' | 'search' | 'period'
  const chips = [
    showAccountChip && filters.accountId
      ? { key: 'accountId' as const, label: `Account: ${accountLabel}` }
      : null,
    selectedAgent
      ? { key: 'agentId' as const, label: `Initiator: ${selectedAgent.name}` }
      : null,
    selectedToken
      ? { key: 'tokenKey' as const, label: `Token: ${tokenLabel(selectedToken)}` }
      : null,
    filters.direction
      ? { key: 'direction' as const, label: `Direction: ${directionLabel(filters.direction)}` }
      : null,
    filters.search?.trim()
      ? { key: 'search' as const, label: `Search: ${filters.search.trim()}` }
      : null,
    hasPeriodFilter(filters)
      ? { key: 'period' as const, label: `Period: ${periodLabel(filters)}` }
      : null,
  ].filter((chip): chip is { key: ChipKey; label: string } => Boolean(chip))

  const clearFilter = (key: ChipKey) => {
    if (key === 'accountId') onChange({ ...filters, accountId: undefined })
    if (key === 'agentId') onChange({ ...filters, agentId: undefined })
    if (key === 'tokenKey') onChange({ ...filters, tokenKey: undefined })
    if (key === 'direction') onChange({ ...filters, direction: undefined })
    if (key === 'search') onChange({ ...filters, search: undefined })
    if (key === 'period') onChange({ ...filters, period: undefined, from: undefined, to: undefined })
  }

  return (
    <div ref={ref} className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-4 shadow-card">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-56 flex-1 basis-56">
          <Input
            type="search"
            value={searchDraft}
            onChange={(event) => handleSearchInput(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search transactions"
            aria-label="Search transactions"
            leftIcon={<Icon icon={Search} className="h-4 w-4" />}
            className="w-full py-2"
          />
        </div>

        {showAccountChip && (
          <div className="relative">
            <button
              onClick={() => {
                if (accounts.length <= 1) return
                setOpen(open === 'account' ? null : 'account')
              }}
              disabled={accounts.length <= 1}
              className={triggerClasses(Boolean(filters.accountId), accounts.length <= 1)}
            >
              <span>Account: {accountLabel}</span>
              <Chevron open={open === 'account'} />
            </button>
            {open === 'account' && accounts.length > 1 && (
              <div className="absolute left-0 top-full z-40 mt-2 min-w-60 overflow-hidden rounded-lg border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal">
                <DropdownButton
                  active={!filters.accountId}
                  onClick={() => {
                    onChange({ ...filters, accountId: undefined })
                    setOpen(null)
                  }}
                >
                  All
                </DropdownButton>
                {accounts.map((account) => (
                  <DropdownButton
                    key={account.id}
                    active={filters.accountId === account.id}
                    onClick={() => {
                      onChange({ ...filters, accountId: account.id })
                      setOpen(null)
                    }}
                  >
                    <div className="min-w-0 text-left">
                      <div className="truncate font-medium">{account.name}</div>
                      <div className="text-xs text-[var(--v2-ink-3)]">
                        {chainLabel(account.chainId)}
                      </div>
                    </div>
                  </DropdownButton>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="relative">
          <button
            onClick={() => setOpen(open === 'agent' ? null : 'agent')}
            className={triggerClasses(Boolean(filters.agentId))}
          >
            <span>Initiator: {selectedAgent?.name ?? 'All'}</span>
            <Chevron open={open === 'agent'} />
          </button>
          {open === 'agent' && (
            <div className="absolute left-0 top-full z-40 mt-2 min-w-64 overflow-hidden rounded-lg border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal">
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
              {sortedAgents.map((agent) => {
                const status = agentStatusPresentation(agent.status)
                return (
                  <DropdownButton
                    key={agent.id}
                    active={filters.agentId === agent.id}
                    onClick={() => {
                      onChange({ ...filters, agentId: agent.id })
                      setOpen(null)
                    }}
                  >
                    <div className="min-w-0 text-left">
                      <div className={`truncate font-medium ${agentStatusClass(agent.status)}`}>
                        {agent.name}
                      </div>
                      <div className="text-xs uppercase tracking-wide text-[var(--v2-ink-3)]">
                        {status.label}
                      </div>
                    </div>
                  </DropdownButton>
                )
              })}
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
            <div className="absolute left-0 top-full z-40 mt-2 max-h-80 min-w-72 overflow-y-auto rounded-lg border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal">
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

        <div className="relative">
          <button
            onClick={() => setOpen(open === 'direction' ? null : 'direction')}
            className={triggerClasses(Boolean(filters.direction))}
          >
            <span>Direction: {directionLabel(filters.direction)}</span>
            <Chevron open={open === 'direction'} />
          </button>
          {open === 'direction' && (
            <div className="absolute left-0 top-full z-40 mt-2 min-w-44 overflow-hidden rounded-lg border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal">
              <DropdownButton
                active={!filters.direction}
                onClick={() => {
                  onChange({ ...filters, direction: undefined })
                  setOpen(null)
                }}
              >
                All
              </DropdownButton>
              {DIRECTION_OPTIONS.map((option) => (
                <DropdownButton
                  key={option.value}
                  active={filters.direction === option.value}
                  onClick={() => {
                    onChange({ ...filters, direction: option.value })
                    setOpen(null)
                  }}
                >
                  <span className="truncate font-medium">{option.label}</span>
                </DropdownButton>
              ))}
            </div>
          )}
        </div>

        <div className="relative">
          <button
            onClick={() => setOpen(open === 'period' ? null : 'period')}
            className={triggerClasses(hasPeriodFilter(filters))}
          >
            <span>Period: {periodLabel(filters)}</span>
            <Chevron open={open === 'period'} />
          </button>
          {open === 'period' && !showCustomRange && (
            <div className="absolute left-0 top-full z-40 mt-2 min-w-52 overflow-hidden rounded-lg border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal">
              <DropdownButton active={!hasPeriodFilter(filters)} onClick={clearPeriod}>
                All time
              </DropdownButton>
              {PERIOD_PRESET_OPTIONS.map((option) => (
                <DropdownButton
                  key={option.value}
                  active={filters.period === option.value}
                  onClick={() => applyPeriodPreset(option.value)}
                >
                  <span className="truncate font-medium">{option.label}</span>
                </DropdownButton>
              ))}
              <DropdownButton
                active={Boolean(filters.from && filters.to)}
                onClick={openCustomRange}
              >
                <span className="truncate font-medium">Custom range</span>
              </DropdownButton>
            </div>
          )}
          {open === 'period' && showCustomRange && (
            <div className="absolute left-0 top-full z-40 mt-2 min-w-72 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3 shadow-modal">
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  aria-label="Period start date"
                  value={customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                  className="rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] px-2 py-1.5 text-sm text-[var(--v2-ink)]"
                />
                <span className="text-xs text-[var(--v2-ink-3)]">to</span>
                <input
                  type="date"
                  aria-label="Period end date"
                  value={customTo}
                  onChange={(event) => setCustomTo(event.target.value)}
                  className="rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] px-2 py-1.5 text-sm text-[var(--v2-ink)]"
                />
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--v2-ink-3)]">
                  {customFrom || customTo
                    ? 'Both days are included, in your time zone.'
                    : 'Pick a start and an end date.'}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowCustomRange(false)}
                    className="px-2 py-1 text-xs text-[var(--v2-ink-3)] transition-colors hover:text-[var(--v2-ink)]"
                  >
                    Back
                  </button>
                  <Button
                    variant="primary"
                    onClick={applyCustomRange}
                    disabled={!customRangeValid}
                    className="min-w-16 px-2 py-1 text-xs"
                  >
                    Apply
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {onExport && (
          <Button
            variant="tertiary"
            onClick={onExport}
            disabled={!canExport || exporting}
            aria-busy={exporting}
            className="ml-auto min-w-28"
          >
            {exporting ? 'Preparing…' : 'Export CSV'}
          </Button>
        )}
      </div>

      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => clearFilter(chip.key)}
              className="inline-flex items-center gap-1 rounded-full bg-[var(--v2-brand-soft)] px-2 py-1 text-xs text-[var(--v2-brand)] transition-colors hover:bg-brand/15"
            >
              <span>{chip.label}</span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}

      {(loading || error) && (
        <div className="mt-3 text-xs">
          {loading && <span className="text-[var(--v2-ink-3)]">Loading filter options...</span>}
          {error && <span className="text-[var(--v2-danger)]">{error}</span>}
        </div>
      )}
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      icon={ChevronDown}
      className={`h-3 w-3 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
    />
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
          ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
          : 'text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)]'
      }`}
    >
      {children}
    </button>
  )
}
