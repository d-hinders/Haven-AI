'use client'

import { Check, ChevronDown, Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'
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

// The system focus ring (Button/Input/Select carry the same four classes);
// the `transactions/FilterBar` triggers this bar is modelled on never had it,
// which the #3165 design review measured as the browser's default outline.
const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-bg)]'

function triggerClasses(active: boolean): string {
  return [
    // `min-h-11` below `sm`: a 44px tap target on a phone (the FilterPill rule).
    'flex min-h-11 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors sm:min-h-0',
    FOCUS_RING,
    active
      ? 'border-brand/30 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
      : 'border-[var(--v2-border)] bg-[var(--v2-bg)] text-[var(--v2-ink-2)] hover:bg-[var(--v2-surface)] hover:text-[var(--v2-ink)]',
  ].join(' ')
}

export function agentCountLabel(shown: number, total: number): string {
  const noun = total === 1 ? 'agent' : 'agents'
  return `${shown} of ${total} ${noun} shown`
}

/**
 * Search + facets + sort above the agents list (#3165). Facets are data
 * (`AgentFacet`), so a surface that lands later — labels (#3167),
 * organizations (#3164) — registers one and gets a dropdown, a URL key and
 * per-option counts without touching this file.
 *
 * The facet dropdown is a group of toggle buttons (`aria-pressed`), not a
 * listbox: options are multi-select and each one is its own focusable
 * control, which is the pattern `role="option"` forbids (no interactive
 * content inside an option). Escape and click-outside close it; the panel
 * spans the toolbar's width below `sm` so it cannot overhang the card on a
 * phone.
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
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  // Escape unmounts the panel with focus inside it; without this a keyboard
  // user lands on <body> and a screen reader hears nothing (#3165 review).
  const closeToTrigger = useCallback(() => {
    setOpen((current) => {
      if (current) triggerRefs.current[current]?.focus()
      return null
    })
  }, [])

  useEscapeToClose(open !== null, closeToTrigger)

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
      className="relative mb-4 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1">
          <Input
            type="text"
            aria-label="Search agents by name, description or delegate address"
            placeholder="Search agents"
            value={state.q}
            onChange={(event) => onChange({ ...state, q: event.target.value })}
            leftIcon={<Icon icon={Search} className="h-4 w-4" />}
            className="pl-9"
            rightAction={
              state.q ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => onChange({ ...state, q: '' })}
                  // 44px on a phone, 24px (the WCAG 2.5.8 floor) on desktop.
                  className={`flex min-h-11 min-w-11 items-center justify-center rounded text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] sm:min-h-6 sm:min-w-6 ${FOCUS_RING}`}
                >
                  <Icon icon={X} className="h-3.5 w-3.5" />
                </button>
              ) : undefined
            }
          />
        </div>

        {facets.map((facet) => {
          const selected = state.facets[facet.id] ?? []
          const isOpen = open === facet.id
          const panelId = `agent-facet-${facet.id}`
          return (
            <div key={facet.id} className="static sm:relative">
              <button
                type="button"
                ref={(el) => {
                  triggerRefs.current[facet.id] = el
                }}
                className={triggerClasses(selected.length > 0)}
                aria-expanded={isOpen}
                aria-controls={isOpen ? panelId : undefined}
                onClick={() => setOpen(isOpen ? null : facet.id)}
              >
                <span className="text-[var(--v2-ink-3)]">{facet.label}:</span>
                <span>{facetSummary(facet)}</span>
                <Icon
                  icon={ChevronDown}
                  className={`h-3.5 w-3.5 motion-safe:transition-transform ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {isOpen && (
                <div
                  id={panelId}
                  role="group"
                  aria-label={facet.label}
                  className="absolute left-3 right-3 z-20 mt-1 rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] p-1 shadow-modal sm:left-0 sm:right-auto sm:min-w-[220px]"
                >
                  {facet.options.map((option) => {
                    const checked = selected.includes(option.value)
                    const count = counts[facet.id]?.[option.value] ?? 0
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={checked}
                        onClick={() => toggleValue(facet, option.value)}
                        className={`flex min-h-11 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm sm:min-h-0 ${FOCUS_RING} ${
                          checked
                            ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                            : 'text-[var(--v2-ink)] hover:bg-[var(--v2-surface)]'
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            checked
                              ? 'border-[var(--v2-brand)] bg-[var(--v2-brand)] text-[var(--v2-ink-on-brand)]'
                              : 'border-[var(--v2-border-strong)] bg-[var(--v2-bg)]'
                          }`}
                        >
                          {checked && <Icon icon={Check} className="h-3 w-3" />}
                        </span>
                        <span className="flex-1">{option.label}</span>
                        <span className="text-xs tabular-nums text-[var(--v2-ink-3)]">{count}</span>
                      </button>
                    )
                  })}
                </div>
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

      {/*
        Only while a filter is on: at rest the header chip already carries the
        count, and a second copy 40px below it duplicates it. In the zero
        state the list's EmptyState owns the reset action, so the bar's reset
        steps back rather than offering the same label twice in two variants.
      */}
      {active && (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--v2-ink-3)]">
          <span data-testid="agent-list-count" aria-live="polite">
            {agentCountLabel(shown, total)}
          </span>
          {shown > 0 && (
            <Button size="sm" variant="tertiary" onClick={onReset}>
              Clear filters
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
