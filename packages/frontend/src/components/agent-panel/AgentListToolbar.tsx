'use client'

import { ChevronDown, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import {
  SORT_OPTIONS,
  type AgentFacet,
  type AgentListFilterState,
  type AgentSortKey,
} from '@/lib/agent-list-filters'

interface AgentListToolbarProps {
  state: AgentListFilterState
  onChange: (next: AgentListFilterState) => void
  onReset: () => void
  facets: AgentFacet[]
  counts: Record<string, Record<string, number>>
  /** Agents shown after filtering, and the total the filter ran over. */
  shown: number
  total: number
  active: boolean
}

function triggerClasses(active: boolean): string {
  return [
    'flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors',
    active
      ? 'border-brand/30 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
      : 'border-[var(--v2-border)] bg-[var(--v2-bg)] text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)]',
  ].join(' ')
}

/**
 * Search + facets + sort above the agents list (#3165). Facets are data
 * (`AgentFacet`), so a surface that lands later — labels (#3167),
 * organizations (#3164) — registers one and gets a dropdown, a URL key and
 * per-option counts without touching this file. The dropdown shape and the
 * click-outside handling follow `transactions/FilterBar.tsx`; the pill
 * styling follows `ui/FilterPill`.
 */
export function AgentListToolbar({
  state,
  onChange,
  onReset,
  facets,
  counts,
  shown,
  total,
  active,
}: AgentListToolbarProps) {
  const [open, setOpen] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(null)
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const toggleValue = (facet: AgentFacet, value: string) => {
    const current = state.facets[facet.id] ?? []
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
    onChange({ ...state, facets: { ...state.facets, [facet.id]: next } })
  }

  const facetSummary = (facet: AgentFacet): string => {
    const selected = state.facets[facet.id] ?? []
    if (selected.length === 0) return 'All'
    if (selected.length === 1) return facet.options.find((o) => o.value === selected[0])?.label ?? selected[0]
    return `${selected.length} selected`
  }

  return (
    <div
      ref={ref}
      data-testid="agent-list-toolbar"
      className="mb-4 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1">
          <Input
            type="search"
            aria-label="Search agents"
            placeholder="Search by name, description or delegate address"
            value={state.q}
            onChange={(event) => onChange({ ...state, q: event.target.value })}
            leftIcon={<Icon icon={Search} className="h-4 w-4" />}
          />
        </div>

        {facets.map((facet) => {
          const selected = state.facets[facet.id] ?? []
          const isOpen = open === facet.id
          return (
            <div key={facet.id} className="relative">
              <button
                type="button"
                className={triggerClasses(selected.length > 0)}
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : facet.id)}
              >
                <span className="text-[var(--v2-ink-3)]">{facet.label}:</span>
                <span>{facetSummary(facet)}</span>
                <Icon icon={ChevronDown} className="h-3.5 w-3.5" />
              </button>
              {isOpen && (
                <ul
                  role="listbox"
                  aria-label={facet.label}
                  aria-multiselectable="true"
                  className="absolute left-0 z-20 mt-1 min-w-[220px] rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] p-1 shadow-modal"
                >
                  {facet.options.map((option) => {
                    const checked = selected.includes(option.value)
                    const count = counts[facet.id]?.[option.value] ?? 0
                    return (
                      <li key={option.value} role="option" aria-selected={checked}>
                        <button
                          type="button"
                          onClick={() => toggleValue(facet, option.value)}
                          className={`flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm ${
                            checked
                              ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                              : 'text-[var(--v2-ink)] hover:bg-[var(--v2-surface)]'
                          }`}
                        >
                          <span>{option.label}</span>
                          <span className="text-xs tabular-nums text-[var(--v2-ink-3)]">{count}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}

        <label className="flex items-center gap-2 text-sm text-[var(--v2-ink-3)]">
          <span>Sort</span>
          <Select
            aria-label="Sort agents"
            value={state.sort}
            onChange={(event) => onChange({ ...state, sort: event.target.value as AgentSortKey })}
            className="w-auto"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--v2-ink-3)]">
        <span data-testid="agent-list-count" aria-live="polite">
          {active ? `${shown} of ${total} agents shown` : `${total} agents`}
        </span>
        {active && (
          <Button size="sm" variant="ghost" onClick={onReset}>
            <Icon icon={X} className="h-3.5 w-3.5" />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}
