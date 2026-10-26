'use client'

import { Fragment, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { FilterPill } from '@haven_ai/ui/FilterPill'
import { Icon } from '@/components/ui/Icon'
import { allOptionLabel, facetValueLabel } from './list-controls-copy'
import { planFacetOptions, toggleFacetGroup, type FacetOptionGroup } from './list-facet-groups'
import { listMenuItemClasses, listMenuPanelClasses, listTriggerClasses, useListMenu } from './list-menu'
import { sameValues, type FacetUrlSpec } from './list-url-codec'

export interface ListFacetOption {
  value: string
  label: string
  /**
   * A non-truncating detail slot (#4150): a short suffix such as an agent's
   * status ("Revoked") that the menu row, the phone-sheet row and the chip
   * always show, even beside a label too long to finish. The trigger summary
   * and `facetValueLabel` exclude it unless asked.
   */
  meta?: string
  /** Rows matching this value; shown on the right of a multi-select row. */
  count?: number
  /**
   * A collapsed option group (#4452): a long tail of options behind one
   * disclosure row ("Show 14 inactive"). Options stay one flat array, so the
   * URL codec, the chip summary and value clearing are unchanged.
   */
  group?: FacetOptionGroup
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
 * - **Collapsed option groups** (#4452): an option may carry a `group`, and a
 *   facet's long tail collapses behind one `menuitem` reading "Show 14
 *   inactive" with `aria-expanded`. Ungrouped rows come first. The toggle
 *   stays mounted when the group expands, so focus is not lost and the next
 *   arrow key continues from it; a group holding the selection is open on
 *   every render and cannot be collapsed. The split itself lives in
 *   `list-facet-groups.ts`, shared with the phone sheet.
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

  // The user's own expansions (#4452). The open state itself is derived on
  // every render by `planFacetOptions`, because the URL value loads after
  // mount and a selected grouped row must exist for `focusItem('checked')`.
  const [expandedGroups, setExpandedGroups] = useState<string[]>([])
  const plan = planFacetOptions(facet.options, value, expandedGroups)

  const optionRow = (option: ListFacetOption) => {
    const checked = value.includes(option.value)
    return (
      <button
        key={option.value}
        type="button"
        role={multi ? 'menuitemcheckbox' : 'menuitemradio'}
        aria-checked={checked}
        tabIndex={-1}
        onClick={() => {
          if (!multi) return choose([option.value])
          choose(checked ? value.filter((v) => v !== option.value) : [...value, option.value])
        }}
        className={listMenuItemClasses}
      >
        {multi ? <CheckboxMark checked={checked} /> : <RadioMark checked={checked} />}
        <span className="truncate" title={option.label}>
          {option.label}
        </span>
        {/* `meta` (#4150) is the non-truncating detail slot: a status
            suffix the label's `truncate` may not leave room for. */}
        <span className="flex items-center gap-2 text-xs text-[var(--v2-ink-3)]">
          {option.meta && <span className="whitespace-nowrap">{option.meta}</span>}
          <span className="tabular-nums">{option.count ?? ''}</span>
        </span>
      </button>
    )
  }

  return (
    // `sm:max-w-[20rem]` (#4401): from `sm` a header's actions row sizes to
    // max-content, so `max-w-full` alone lets a long selected name push the
    // header wide; the bound makes the summary below truncate there too. The
    // full name stays in the trigger's text, so its accessible name keeps it.
    <div ref={menu.wrapperRef} className="relative inline-flex min-w-0 max-w-full sm:max-w-[20rem]">
      <button {...menu.triggerProps} data-active={active} className={listTriggerClasses(active)}>
        <span className={active ? '' : 'text-[var(--v2-ink-3)]'}>{facet.label}:</span>
        {' '}
        {/* `min-w-0 truncate`: a long SELECTED label truncates inside the
            facet row instead of stretching the trigger past it (#4150). */}
        <span className="min-w-0 truncate font-medium" title={summary}>{summary}</span>
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
          {!multi && allLabel !== null && (
            <button
              key="__all"
              type="button"
              role="menuitemradio"
              aria-checked={value.length === 0}
              tabIndex={-1}
              onClick={() => choose([])}
              className={listMenuItemClasses}
            >
              <RadioMark checked={value.length === 0} />
              <span className="truncate" title={allLabel}>
                {allLabel}
              </span>
              <span className="flex items-center gap-2 text-xs text-[var(--v2-ink-3)]" />
            </button>
          )}
          {plan.ungrouped.map(optionRow)}
          {plan.groups.map((group) => (
            <Fragment key={`group-${group.group.id}`}>
              {/* The disclosure row (#4452) is a `menuitem`, which
                  `ITEM_SELECTOR` already counts, so arrows, Home and End reach
                  it. It STAYS MOUNTED when the group expands: focus is not
                  lost, and the next arrow key continues from it. */}
              <button
                type="button"
                role="menuitem"
                aria-expanded={group.open}
                tabIndex={-1}
                onClick={() => setExpandedGroups((ids) => toggleFacetGroup(ids, group))}
                className={listMenuItemClasses}
              >
                <Icon
                  icon={ChevronDown}
                  className={`h-3.5 w-3.5 text-[var(--v2-ink-3)] motion-safe:transition-transform ${group.open ? '' : '-rotate-90'}`}
                />
                <span className="truncate">{group.toggleLabel}</span>
              </button>
              {/* No `role="group"` around these rows: it would split one radio
                  set for screen readers. */}
              {group.open && group.options.map(optionRow)}
            </Fragment>
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
