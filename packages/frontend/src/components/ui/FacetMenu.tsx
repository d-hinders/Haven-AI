'use client'

import { Check, ChevronDown } from 'lucide-react'
import { FilterPill } from '@haven_ai/ui/FilterPill'
import { Icon } from '@/components/ui/Icon'
import { allOptionLabel, facetValueLabel } from './list-controls-copy'
import { listMenuItemClasses, listMenuPanelClasses, listTriggerClasses, useListMenu } from './list-menu'
import { sameValues, type FacetUrlSpec } from './list-url-codec'

export interface ListFacetOption {
  value: string
  label: string
  /** Rows matching this value; shown on the right of a multi-select row. */
  count?: number
}

/**
 * One filter dimension of a list (#4110): a URL key, a label and its
 * options. The page declares facets; `ListToolbar` decides how they look.
 */
export interface ListFacet extends FacetUrlSpec {
  label: string
  options: ListFacetOption[]
  /** `pills` is for a short category list only (Marketplace). Default `menu`. */
  rendering?: 'menu' | 'pills'
}

export interface FacetMenuProps {
  facet: ListFacet
  /** Selected values; `[]` is All. */
  value: readonly string[]
  onChange: (next: string[]) => void
  /**
   * Overrides the facet's own `allLabel`. `null` here means a VIEW choice —
   * the Sort chip: no "no filter" row, and the trigger never tints. A facet
   * that merely has no All (`facet.allLabel === null`) still tints when it
   * differs from its default.
   */
  allLabel?: string | null
  /** Which edge of the trigger the menu hangs from. Clamped to the viewport either way. */
  align?: 'left' | 'right'
}

/**
 * A facet as a chip dropdown, "Label: Value" (#4110, epic #4108).
 *
 * - **Single-select** (the default): `menuitemradio` rows, "All" first.
 *   Choosing one applies it and closes the menu, focus back on the trigger.
 * - **Multi-select**: `menuitemcheckbox` rows with counts; the menu stays
 *   open while you tick. The trigger reads "Status: Active, Paused", or
 *   "Status: 3 selected" past two.
 * - **Pills**: the same facet drawn as a row of toggle buttons
 *   (`aria-pressed`, the `FilterPill` primitive) for a short category list.
 *   Pills are not menu items.
 * - A facet with one possible value is hidden — there is nothing to choose.
 * - `facet.allLabel` renames the "no filter" row, or (`null`, #4113) drops
 *   it for a single-select facet whose every value is a real choice
 *   ("Archived: Hidden / Shown"); its `defaultValue` is the unfiltered view.
 *
 * Why menu roles, superseding the toggle-button group the Agents list used
 * before #4113 (`AgentListToolbar`, deleted):
 * that header rejected a listbox because each option was its own focusable
 * button, and `role="option"` forbids interactive content inside an option.
 * A menu item IS the control, so the conflict is gone, and the trigger's
 * `aria-haspopup="menu"` tells a screen reader what opens.
 */
export function FacetMenu({ facet, value, onChange, allLabel: allLabelOverride, align = 'left' }: FacetMenuProps) {
  const menu = useListMenu()
  const multi = facet.selection === 'multi'
  const viewChoice = allLabelOverride === null
  const allLabel = allLabelOverride !== undefined ? allLabelOverride : facet.allLabel !== undefined ? facet.allLabel : allOptionLabel

  if (facet.options.length <= 1) return null

  if (facet.rendering === 'pills') {
    const toggle = (v: string) => {
      // A facet without All cannot be deselected back to `[]`.
      if (!multi) return onChange(value.includes(v) && allLabel !== null ? [] : [v])
      onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])
    }
    return (
      <div role="group" aria-label={facet.label} className="flex flex-wrap gap-1.5">
        {allLabel !== null && (
          <FilterPill active={value.length === 0} onClick={() => onChange([])}>
            {allLabel}
          </FilterPill>
        )}
        {facet.options.map((option) => (
          <FilterPill key={option.value} active={value.includes(option.value)} onClick={() => toggle(option.value)}>
            {option.label}
          </FilterPill>
        ))}
      </div>
    )
  }

  // Active = differs from the page default (see ListToolbar); the Sort chip
  // (the `allLabel={null}` override) is a view choice and never tints.
  const active = !viewChoice && !sameValues(value, facet.defaultValue ?? [])
  const summary = facetValueLabel(value, facet.options, allLabel ?? allOptionLabel)

  const choose = (next: string[]) => {
    onChange(next)
    if (!multi) menu.close(true)
  }

  const rows: { value: string | null; label: string; count?: number; checked: boolean }[] = []
  if (!multi && allLabel !== null) rows.push({ value: null, label: allLabel, checked: value.length === 0 })
  for (const option of facet.options) {
    rows.push({ value: option.value, label: option.label, count: option.count, checked: value.includes(option.value) })
  }

  return (
    <div ref={menu.wrapperRef} className="relative inline-flex">
      <button {...menu.triggerProps} data-active={active} className={listTriggerClasses(active)}>
        <span className={active ? '' : 'text-[var(--v2-ink-3)]'}>{facet.label}:</span>
        {' '}
        <span className="font-medium">{summary}</span>
        <Icon
          icon={ChevronDown}
          className={`h-3.5 w-3.5 shrink-0 motion-safe:transition-transform ${menu.open ? 'rotate-180' : ''}`}
        />
      </button>
      {menu.open && (
        <div
          ref={menu.panelRef}
          id={menu.menuId}
          role="menu"
          aria-labelledby={menu.triggerId}
          onKeyDown={menu.onPanelKeyDown}
          style={menu.panelStyle}
          className={`${listMenuPanelClasses} ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {rows.map((row) => (
            <button
              key={row.value ?? '__all'}
              type="button"
              role={multi ? 'menuitemcheckbox' : 'menuitemradio'}
              aria-checked={row.checked}
              tabIndex={-1}
              onClick={() => {
                if (row.value === null) return choose([])
                if (!multi) return choose([row.value])
                choose(row.checked ? value.filter((v) => v !== row.value) : [...value, row.value])
              }}
              className={listMenuItemClasses}
            >
              {multi ? <CheckboxMark checked={row.checked} /> : <RadioMark checked={row.checked} />}
              <span className="truncate">{row.label}</span>
              <span className="text-xs tabular-nums text-[var(--v2-ink-3)]">{row.count ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The radio dot a `menuitemradio` row draws. Decorative: the row carries the state. */
export function RadioMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-4 w-4 items-center justify-center rounded-full border-[1.5px] ${
        checked ? 'border-[var(--v2-brand)]' : 'border-[var(--v2-border-strong)]'
      }`}
    >
      {checked && <span className="h-2 w-2 rounded-full bg-[var(--v2-brand)]" />}
    </span>
  )
}

/** The checkbox square a `menuitemcheckbox` row draws. Decorative. */
export function CheckboxMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-4 w-4 items-center justify-center rounded border-[1.5px] ${
        checked
          ? 'border-[var(--v2-brand)] bg-[var(--v2-brand)] text-[var(--v2-ink-on-brand)]'
          : 'border-[var(--v2-border-strong)] bg-[var(--v2-bg)]'
      }`}
    >
      {checked && <Icon icon={Check} className="h-3 w-3" />}
    </span>
  )
}
