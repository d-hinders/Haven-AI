/**
 * The collapsed option group (#4452): one facet's options split into the rows
 * that always show and the groups that hide behind a disclosure row.
 *
 * Both renderers — the desktop `FacetMenu` and the phone filter sheet — call
 * this, so the split, the open rule and the toggle label cannot drift apart.
 * Options stay ONE flat array on the facet: the URL codec, the chip summary
 * (`facetValueLabel`) and value clearing never learn about groups.
 */

import { facetGroupToggleLabel } from './list-controls-copy'

/** A named tail of a facet's options, collapsed behind one disclosure row. */
export interface FacetOptionGroup {
  id: string
  label: string
}

/** The minimum an option needs to take part in a group. */
export interface GroupableFacetOption {
  value: string
  group?: FacetOptionGroup
}

/** One group, resolved for this render. */
export interface FacetGroupPlan<O extends GroupableFacetOption> {
  group: FacetOptionGroup
  /** The group's options, in the facet's own order. */
  options: O[]
  /** A selected value sits in this group. */
  holdsSelection: boolean
  /**
   * Derived on EVERY render, never only initial state: open when the group
   * holds the selection, or when the user expanded it. The URL value loads
   * after mount, and `focusItem('checked')` must find the selected row.
   */
  open: boolean
  /** The disclosure row's text: "Show 14 inactive". */
  toggleLabel: string
}

export interface FacetOptionPlan<O extends GroupableFacetOption> {
  /** Options with no group: they render first, always visible. */
  ungrouped: O[]
  /** Groups in the order their first option appears. */
  groups: FacetGroupPlan<O>[]
}

/**
 * Split a facet's options and decide each group's open state.
 *
 * `expanded` is the ids the user has opened by hand; a group holding the
 * selection is open regardless, so a selected grouped value is never hidden.
 */
export function planFacetOptions<O extends GroupableFacetOption>(
  options: readonly O[],
  selected: readonly string[],
  expanded: readonly string[] = [],
): FacetOptionPlan<O> {
  const ungrouped: O[] = []
  const groups: FacetGroupPlan<O>[] = []
  const byId = new Map<string, FacetGroupPlan<O>>()

  for (const option of options) {
    if (!option.group) {
      ungrouped.push(option)
      continue
    }
    let plan = byId.get(option.group.id)
    if (!plan) {
      plan = { group: option.group, options: [], holdsSelection: false, open: false, toggleLabel: '' }
      byId.set(option.group.id, plan)
      groups.push(plan)
    }
    plan.options.push(option)
  }

  for (const plan of groups) {
    plan.holdsSelection = plan.options.some((option) => selected.includes(option.value))
    plan.open = plan.holdsSelection || expanded.includes(plan.group.id)
    plan.toggleLabel = facetGroupToggleLabel(plan.options.length, plan.group.label)
  }

  return { ungrouped, groups }
}

/**
 * The expanded-id list after activating a group's disclosure row.
 *
 * A group holding the selection cannot be collapsed: collapsing it would hide
 * the row the menu just focused, and the user has no other way to see which
 * value is applied. Every other group opens and closes freely.
 */
export function toggleFacetGroup(expanded: readonly string[], plan: FacetGroupPlan<GroupableFacetOption>): string[] {
  if (plan.holdsSelection) return [...expanded]
  return expanded.includes(plan.group.id)
    ? expanded.filter((id) => id !== plan.group.id)
    : [...expanded, plan.group.id]
}
