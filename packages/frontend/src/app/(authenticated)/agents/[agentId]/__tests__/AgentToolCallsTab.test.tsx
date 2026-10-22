import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockToolCallLog, mockApiGet } = vi.hoisted(() => ({
  mockToolCallLog: vi.fn(),
  mockApiGet: vi.fn(),
}))

vi.mock('@/hooks/useAgentActivity', () => ({
  // The tab reads the kinded population through this reader only; the rest
  // of the module is not this tab's surface. Args forwarded so the tests can
  // assert the server filters the tab sends.
  useAgentToolCallLog: (...args: unknown[]) => mockToolCallLog(...args),
  AGENT_TOOL_CALL_PAGE_SIZE: 25,
}))

// Only the #4196 denominator read (a filter is active) touches the API.
vi.mock('@/lib/api', () => ({
  api: { get: (...args: unknown[]) => mockApiGet(...args) },
}))

import AgentToolCallsTab, { foldToolCallRuns } from '../AgentToolCallsTab'
import type { McpToolCallActivityItem } from '@/hooks/useAgentActivity'

/** The reader's default answer: idle and empty. */
function seedLog(items: McpToolCallActivityItem[], extra: Record<string, unknown> = {}) {
  mockToolCallLog.mockReturnValue({
    items,
    total: items.length,
    hasMore: false,
    errorCount: 0,
    loading: false,
    loadingMore: false,
    error: null,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    ...extra,
  })
  return mockToolCallLog.mock.results[0]?.value as Record<string, unknown> | undefined
}

let seq = 0
function toolCall(overrides: Partial<McpToolCallActivityItem> = {}): McpToolCallActivityItem {
  seq += 1
  return {
    type: 'mcp_tool_call',
    id: `tc-${seq}`,
    agent_id: 'agent-1',
    tool_name: 'haven_get_payment_status',
    payment_id: null,
    result_status: 'ok',
    next_action: null,
    error_code: null,
    status_code: 200,
    created_at: '2026-06-01T10:00:00Z',
    ...overrides,
  }
}

function renderTab() {
  const onOpenPayment = vi.fn()
  const view = render(<AgentToolCallsTab agentId="agent-1" onOpenPayment={onOpenPayment} />)
  return { ...view, onOpenPayment }
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('AgentToolCallsTab (#4227)', () => {
  beforeEach(() => {
    mockApiGet.mockResolvedValue({ total: 9 })
    seedLog([])
  })

  it('leads with the plain-language label and carries the raw tool name second, as code', () => {
    seedLog([toolCall()])
    renderTab()
    expect(screen.getByText('Checked a payment')).toBeInTheDocument()
    const code = screen.getByText('haven_get_payment_status')
    expect(code.tagName).toBe('CODE')
  })

  it('an unknown (retired) tool name falls back to its raw name', () => {
    seedLog([toolCall({ tool_name: 'haven_quote_mpp' })])
    renderTab()
    // The raw name appears twice: as the fallback label AND as the code.
    expect(screen.getAllByText('haven_quote_mpp')).toHaveLength(2)
  })

  it('the one-line intro names the audit-trail-not-a-control fact', () => {
    renderTab()
    expect(screen.getByTestId('tool-calls-intro')).toHaveTextContent(
      'audit trail, not a spending control',
    )
  })

  it('folds consecutive same-tool, same-result, same-day calls into one ×N row', () => {
    seedLog([
      toolCall({ id: 'tc-b', created_at: '2026-06-01T11:00:00Z' }),
      toolCall({ id: 'tc-a', created_at: '2026-06-01T09:00:00Z' }),
    ])
    renderTab()
    expect(screen.getAllByText('Checked a payment')).toHaveLength(1)
    expect(screen.getByTestId('tool-call-fold')).toHaveTextContent('×2')
  })

  it('a run broken by result or tool does not fold, and days do not merge', () => {
    seedLog([
      toolCall({ id: 'tc-1', result_status: 'error', created_at: '2026-06-01T11:00:00Z' }),
      toolCall({ id: 'tc-2', result_status: 'ok', created_at: '2026-06-01T10:00:00Z' }),
      toolCall({ id: 'tc-3', tool_name: 'haven_get_agent', created_at: '2026-06-01T09:00:00Z' }),
      // Same tool+result as tc-1, but the day before: no fold across days.
      toolCall({ id: 'tc-4', result_status: 'error', created_at: '2026-05-31T09:00:00Z' }),
    ])
    renderTab()
    expect(screen.queryByTestId('tool-call-fold')).toBeNull()
    // Both day bands render, newest first.
    expect(screen.getByText('1 Jun')).toBeInTheDocument()
    expect(screen.getByText('31 May')).toBeInTheDocument()
  })

  it('a run spanning two loaded pages folds once the second page lands', () => {
    // Page one ends mid-run: the newest call of a ×3 run, then an older one
    // from a different tool.
    seedLog(
      [toolCall({ id: 'run-2' }), toolCall({ id: 'other', tool_name: 'haven_get_agent' })],
      { total: 5, hasMore: true },
    )
    const view = renderTab()

    // "Show 3 more" pages from #4229's hasMore/total — 2 loaded of 5 total.
    fireEvent.click(screen.getByRole('button', { name: 'Show 3 more' }))

    // Page two arrives with the run's two older calls appended: the fold
    // re-runs over the WHOLE loaded list, so the run is one row — never split
    // at the page boundary.
    seedLog(
      [
        toolCall({ id: 'run-2' }),
        toolCall({ id: 'run-1', created_at: '2026-06-01T09:30:00Z' }),
        toolCall({ id: 'run-0', created_at: '2026-06-01T09:00:00Z' }),
        toolCall({ id: 'other', tool_name: 'haven_get_agent' }),
      ],
      { total: 5, hasMore: false },
    )
    view.rerender(<AgentToolCallsTab agentId="agent-1" onOpenPayment={view.onOpenPayment} />)

    expect(screen.getAllByText('Checked a payment')).toHaveLength(1)
    expect(screen.getByTestId('tool-call-fold')).toHaveTextContent('×3')
  })

  it('error and denied rows get their badge and the error in words; ok rows stay quiet', () => {
    seedLog([
      toolCall({
        id: 'tc-err',
        tool_name: 'haven_pay_x402_quote',
        result_status: 'error',
        error_code: 'delegation_budget_exceeded',
      }),
      toolCall({
        id: 'tc-den',
        tool_name: 'haven_get_agent',
        result_status: 'denied',
        error_code: 'signature_rejected',
      }),
      toolCall({ id: 'tc-ok', result_status: 'ok' }),
    ])
    renderTab()
    expect(screen.getByText('error')).toBeInTheDocument()
    expect(screen.getByText('denied')).toBeInTheDocument()
    expect(screen.getByText('Over the agent budget')).toBeInTheDocument()
    expect(screen.getByText('Signature rejected')).toBeInTheDocument()
    // An OK row renders no badge at all.
    const okRow = screen.getByText('Checked a payment').closest('.relative')
    expect(okRow?.textContent).not.toContain('error')
    expect(okRow?.textContent).not.toContain('denied')
  })

  it('a call with a payment links to it — the link hands the id to the page', () => {
    seedLog([toolCall({ payment_id: 'pay-77' })])
    const { onOpenPayment } = renderTab()
    fireEvent.click(screen.getByTestId('tool-call-payment-link'))
    expect(onOpenPayment).toHaveBeenCalledWith('pay-77')
  })

  it('the Result facet filters on the server (the reader receives the status)', () => {
    seedLog([toolCall()])
    renderTab()
    expect(mockToolCallLog).toHaveBeenLastCalledWith('agent-1', {
      result: undefined,
      q: undefined,
    })

    fireEvent.click(screen.getByText('Result:'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Denied' }))
    expect(mockToolCallLog).toHaveBeenLastCalledWith('agent-1', {
      result: 'denied',
      q: undefined,
    })
  })

  it('search filters on the server after the commit pause', () => {
    vi.useFakeTimers()
    seedLog([toolCall()])
    renderTab()
    const field = screen.getByRole('searchbox', { name: 'Search tool calls' })
    fireEvent.change(field, { target: { value: 'haven_get' } })
    act(() => vi.advanceTimersByTime(299))
    expect(mockToolCallLog).toHaveBeenLastCalledWith('agent-1', {
      result: undefined,
      q: undefined,
    })
    act(() => vi.advanceTimersByTime(1))
    expect(mockToolCallLog).toHaveBeenLastCalledWith(
      'agent-1',
      expect.objectContaining({ q: 'haven_get' }),
    )
  })

  it('the summary line shows the error count and the call count', () => {
    seedLog([toolCall()], { total: 7, errorCount: 3 })
    renderTab()
    expect(screen.getByTestId('tool-calls-error-count')).toHaveTextContent('3 errors')
    // The unfiltered count: "7 tool calls".
    expect(screen.getByText('7 tool calls')).toBeInTheDocument()
  })

  it('with a filter applied the count reads the filtered population against the unfiltered one', async () => {
    seedLog([toolCall({ result_status: 'error' })], { total: 3, errorCount: 3 })
    renderTab()
    fireEvent.click(screen.getByText('Result:'))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Error' }))
    expect(await screen.findByText('3 of 9 tool calls')).toBeInTheDocument()
    // The #4196 denominator: one capped unfiltered read.
    expect(mockApiGet).toHaveBeenCalledWith(
      '/agent-activity/agent-1/activity?kind=tool_calls&limit=1',
    )
  })

  it('ListShowMore pages by hasMore and total', () => {
    // 25 loaded of 30 total → "Show 5 more".
    seedLog(Array.from({ length: 25 }, () => toolCall()), { total: 30, hasMore: true })
    const log = mockToolCallLog() as { loadMore: ReturnType<typeof vi.fn> }
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more' }))
    expect(log.loadMore).toHaveBeenCalled()
  })

  it('an agent with no tool calls gets the empty state, and the tab stays', () => {
    renderTab()
    expect(screen.getByText('No tool calls')).toBeInTheDocument()
    expect(
      screen.getByText("When this agent's MCP runtime calls Haven, each call shows here."),
    ).toBeInTheDocument()
    // The toolbar (and its filters) still render — the tab remains.
    expect(screen.getByText('Result:')).toBeInTheDocument()
    expect(screen.getByText('Period:')).toBeInTheDocument()
  })

  it('day bands are the shared headers and rows carry no bright dividers', () => {
    seedLog([
      toolCall({ id: 'tc-2', created_at: '2026-06-01T11:00:00Z' }),
      toolCall({ id: 'tc-1', created_at: '2026-05-31T09:00:00Z' }),
    ])
    renderTab()
    expect(screen.getByText('1 Jun')).toBeInTheDocument()
    expect(screen.getByText('31 May')).toBeInTheDocument()
    // The deleted `--v2-divider` (undefined token → currentColor → bright in
    // dark mode) is gone from the markup: hairlines are the shared tokens.
    expect(document.body.innerHTML).not.toContain('v2-divider')
    expect(document.querySelector('.divide-y')?.className).toContain('divide-[var(--v2-border)]')
  })

  describe('foldToolCallRuns (unit)', () => {
    it('is a pure fold over the loaded order, newest first', () => {
      const runs = foldToolCallRuns([
        toolCall({ id: 'a' }),
        toolCall({ id: 'b', created_at: '2026-06-01T09:00:00Z' }),
        toolCall({ id: 'c', result_status: 'denied' }),
        toolCall({ id: 'd', created_at: '2026-05-31T10:00:00Z' }),
      ])
      expect(runs.map((run) => [run.item.id, run.count])).toEqual([
        ['a', 2],
        ['c', 1],
        ['d', 1],
      ])
      // The representative is the run's most recent call.
      expect(runs[0].item.created_at).toBe('2026-06-01T10:00:00Z')
    })
  })
})
