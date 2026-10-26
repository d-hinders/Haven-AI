import { describe, expect, it } from 'vitest'
import { planFacetOptions, toggleFacetGroup } from '../list-facet-groups'

const OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive', group: { id: 'inactive', label: 'inactive' } },
  { value: 'archived', label: 'Archived', group: { id: 'inactive', label: 'inactive' } },
  { value: 'paused', label: 'Paused' },
  { value: 'revoked', label: 'Revoked', group: { id: 'revoked', label: 'revoked' } },
]

describe('planFacetOptions — the split both renderers share (#4452)', () => {
  it('keeps ungrouped options in facet order and groups in first-appearance order', () => {
    const plan = planFacetOptions(OPTIONS, [])
    expect(plan.ungrouped.map((o) => o.value)).toEqual(['active', 'paused'])
    expect(plan.groups.map((g) => g.group.id)).toEqual(['inactive', 'revoked'])
    expect(plan.groups[0].options.map((o) => o.value)).toEqual(['inactive', 'archived'])
    expect(plan.groups[1].options.map((o) => o.value)).toEqual(['revoked'])
  })

  it('names each toggle with its own count and label', () => {
    const plan = planFacetOptions(OPTIONS, [])
    expect(plan.groups.map((g) => g.toggleLabel)).toEqual(['Show 2 inactive', 'Show 1 revoked'])
  })

  it('is closed by default, open when the user expanded it, and open when it holds the selection', () => {
    expect(planFacetOptions(OPTIONS, []).groups.map((g) => g.open)).toEqual([false, false])
    expect(planFacetOptions(OPTIONS, [], ['revoked']).groups.map((g) => g.open)).toEqual([false, true])
    // Derived on every render: the value can arrive after mount.
    const selected = planFacetOptions(OPTIONS, ['archived'])
    expect(selected.groups[0].holdsSelection).toBe(true)
    expect(selected.groups[0].open).toBe(true)
    expect(selected.groups[1].open).toBe(false)
  })

  it('a facet with no groups is all ungrouped', () => {
    const plan = planFacetOptions([{ value: 'a', label: 'A' }], [])
    expect(plan.ungrouped).toHaveLength(1)
    expect(plan.groups).toEqual([])
  })
})

describe('toggleFacetGroup', () => {
  const plan = planFacetOptions(OPTIONS, [])
  const inactive = plan.groups[0]
  const revoked = plan.groups[1]

  it('opens a closed group and closes an open one', () => {
    expect(toggleFacetGroup([], inactive)).toEqual(['inactive'])
    expect(toggleFacetGroup(['inactive', 'revoked'], inactive)).toEqual(['revoked'])
  })

  it('leaves a group holding the selection open', () => {
    const holding = planFacetOptions(OPTIONS, ['inactive']).groups[0]
    expect(holding.holdsSelection).toBe(true)
    expect(toggleFacetGroup([], holding)).toEqual([])
    expect(toggleFacetGroup(['inactive'], holding)).toEqual(['inactive'])
  })

  it('does not touch another group', () => {
    expect(toggleFacetGroup(['revoked'], inactive)).toEqual(['revoked', 'inactive'])
    expect(toggleFacetGroup(['revoked'], revoked)).toEqual([])
  })
})
