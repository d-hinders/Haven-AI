import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentListToolbar } from '../AgentListToolbar'
import { BUILT_IN_FACETS, EMPTY_FILTER_STATE, type AgentListFilterState } from '@/lib/agent-list-filters'

const counts = {
  status: { active: 2, paused: 1, pending_approval: 0, revoked: 0 },
  budget: { recurring: 1, one_time: 1, none: 1 },
}

function renderBar(state: AgentListFilterState = EMPTY_FILTER_STATE, overrides: Partial<Parameters<typeof AgentListToolbar>[0]> = {}) {
  const onChange = vi.fn()
  const onReset = vi.fn()
  render(
    <AgentListToolbar
      state={state}
      onChange={onChange}
      onReset={onReset}
      facets={BUILT_IN_FACETS}
      counts={counts}
      shown={3}
      total={3}
      active={false}
      {...overrides}
    />,
  )
  return { onChange, onReset }
}

describe('AgentListToolbar', () => {
  it('typing in the search emits the new query', () => {
    const { onChange } = renderBar()
    fireEvent.change(screen.getByRole('textbox', { name: /Search agents/ }), { target: { value: 'inv' } })
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER_STATE, q: 'inv' })
  })

  it('a facet option toggles into the selection and shows its count', () => {
    const { onChange } = renderBar()
    fireEvent.click(screen.getByRole('button', { name: /Status:/ }))
    const option = screen.getByRole('button', { name: /Paused/, pressed: false })
    expect(option).toHaveTextContent('1')
    fireEvent.click(option)
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER_STATE, facets: { status: ['paused'] } })
  })

  it('a selected option toggles back out', () => {
    const state = { ...EMPTY_FILTER_STATE, facets: { status: ['paused', 'active'] } }
    const { onChange } = renderBar(state, { active: true, shown: 2 })
    fireEvent.click(screen.getByRole('button', { name: /Status:\s*2 selected/ }))
    fireEvent.click(screen.getByRole('button', { name: /Paused/, pressed: true }))
    expect(onChange).toHaveBeenCalledWith({ ...state, facets: { status: ['active'] } })
  })

  it('the sort select emits the new key', () => {
    const { onChange } = renderBar()
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort agents' }), { target: { value: 'seen' } })
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER_STATE, sort: 'seen' })
  })

  it('no count line and no reset at rest — the header chip already carries the count', () => {
    renderBar()
    expect(screen.queryByTestId('agent-list-count')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('singular noun for one agent', () => {
    renderBar({ ...EMPTY_FILTER_STATE, q: 'x' }, { active: true, shown: 1, total: 1 })
    expect(screen.getByTestId('agent-list-count')).toHaveTextContent('1 of 1 agent shown')
  })

  it('in the zero state the bar steps back: count stays, its reset does not (the EmptyState owns it)', () => {
    renderBar({ ...EMPTY_FILTER_STATE, q: 'x' }, { active: true, shown: 0 })
    expect(screen.getByTestId('agent-list-count')).toHaveTextContent('0 of 3 agents shown')
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
  })

  it('the search field offers a clear button only while it has text', () => {
    const { onChange } = renderBar({ ...EMPTY_FILTER_STATE, q: 'inv' }, { active: true, shown: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_FILTER_STATE, q: '' })
  })

  it('no clear-search button while the field is empty', () => {
    renderBar()
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull()
  })

  it('Escape closes an open facet panel; the trigger reports its state', () => {
    renderBar()
    const trigger = screen.getByRole('button', { name: /Status:/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('group', { name: 'Status' })).toBeInTheDocument()
    screen.getByRole('button', { name: /Paused/ }).focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Status' })).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    // Focus returns to the trigger, never to <body> (mutation: drop the
    // `.focus()` in closeToTrigger → red).
    expect(document.activeElement).toBe(trigger)
  })

  it('reset is offered only while a filter is active, and calls onReset', () => {
    const { onReset } = renderBar({ ...EMPTY_FILTER_STATE, q: 'x' }, { active: true, shown: 1 })
    expect(screen.getByTestId('agent-list-count')).toHaveTextContent('1 of 3 agents shown')
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('a registered facet renders a dropdown without any toolbar change', () => {
    const labels = { id: 'label', label: 'Label', match: 'any' as const, options: [{ value: 'prod', label: 'prod' }], predicate: () => true }
    renderBar(EMPTY_FILTER_STATE, { facets: [...BUILT_IN_FACETS, labels], counts: { ...counts, label: { prod: 4 } } })
    fireEvent.click(screen.getByRole('button', { name: /Label:/ }))
    expect(screen.getByRole('button', { name: /prod/, pressed: false })).toHaveTextContent('4')
  })
})
