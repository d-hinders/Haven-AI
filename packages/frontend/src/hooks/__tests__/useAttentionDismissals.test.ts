import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

import { api } from '@/lib/api'
import {
  LEGACY_DISMISS_KEY,
  ruleItemIdForDismissal,
  useAttentionDismissals,
} from '@/hooks/useAttentionDismissals'

const mockApiGet = api.get as unknown as ReturnType<typeof vi.fn>
const mockApiPost = api.post as unknown as ReturnType<typeof vi.fn>

/** An overview account block, narrowed to what the hook reads. */
function account(overrides: {
  accountId: string
  isTestnet?: boolean
  needs_backup_recommendation?: boolean | null
  funded?: boolean | null
}) {
  return overrides
}

describe('useAttentionDismissals (#3813, #4324)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mockApiGet.mockReset()
    mockApiPost.mockReset()
    mockApiGet.mockResolvedValue({ dismissals: [] })
    mockApiPost.mockResolvedValue({})
  })

  it('maps the server rows to rule-item ids on load', async () => {
    mockApiGet.mockResolvedValue({
      dismissals: [
        { id: 'd1', item_kind: 'no-backup', account_id: 'safe-1', agent_id: null, created_at: '2026-10-09T00:00:00.000Z' },
        { id: 'd2', item_kind: 'needs-setup', account_id: null, agent_id: 'agent-1', created_at: '2026-10-09T00:00:00.000Z' },
      ],
    })

    const { result } = renderHook(() => useAttentionDismissals())

    await waitFor(() => {
      expect(result.current.acknowledgements.has('no-backup:safe-1')).toBe(true)
      expect(result.current.acknowledgements.has('needs-setup:agent-1')).toBe(true)
    })
    expect(result.current.acknowledgements.size).toBe(2)
  })

  it('a failed read hides nothing — the dismissed set stays empty', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('offline'))

    const { result } = renderHook(() => useAttentionDismissals())

    await waitFor(() => expect(mockApiGet).toHaveBeenCalledOnce())
    expect(result.current.acknowledgements.size).toBe(0)
  })

  it('a malformed body hides nothing and does not throw — the read resolves to a body without dismissals (#4288)', async () => {
    // `SCREENSHOT_FIXTURE=empty` serves `FIXTURE_EMPTY_FALLBACK`, which has
    // no `dismissals` key. The old read iterated it inside a
    // `setDismissedIds` updater; React re-runs updaters while rendering, so
    // the `response.dismissals is not iterable` TypeError crashed the page
    // instead of reaching the `.catch` below.
    mockApiGet.mockResolvedValueOnce({})

    const { result } = renderHook(() => useAttentionDismissals())

    await waitFor(() => expect(mockApiGet).toHaveBeenCalledOnce())
    // The hook RENDERS — the crash used to take the whole page down — and
    // hides nothing: a body the hook cannot read dismisses nothing.
    expect(result.current.acknowledgements.size).toBe(0)
  })

  it('dismiss writes through for the backup item and hides it optimistically', async () => {
    const { result } = renderHook(() => useAttentionDismissals())

    act(() => {
      result.current.dismiss({ id: 'no-backup:safe-1', kind: 'no-backup', accountId: 'safe-1' })
    })

    expect(result.current.acknowledgements.has('no-backup:safe-1')).toBe(true)
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith('/user/attention-dismissals', {
        item_kind: 'no-backup',
        account_id: 'safe-1',
      }),
    )
  })

  it('dismiss writes through for the needs-setup item, per agent', async () => {
    const { result } = renderHook(() => useAttentionDismissals())

    act(() => {
      result.current.dismiss({ id: 'needs-setup:agent-1', kind: 'needs-setup', agentId: 'agent-1' })
    })

    expect(result.current.acknowledgements.has('needs-setup:agent-1')).toBe(true)
    await waitFor(() =>
      expect(mockApiPost).toHaveBeenCalledWith('/user/attention-dismissals', {
        item_kind: 'needs-setup',
        agent_id: 'agent-1',
      }),
    )
  })

  it('a failed dismiss write un-hides the item — no silent false permanence', async () => {
    mockApiPost.mockRejectedValueOnce(new Error('offline'))

    const { result } = renderHook(() => useAttentionDismissals())

    act(() => {
      result.current.dismiss({ id: 'no-backup:safe-1', kind: 'no-backup', accountId: 'safe-1' })
    })
    expect(result.current.acknowledgements.has('no-backup:safe-1')).toBe(true)

    await waitFor(() => expect(result.current.acknowledgements.has('no-backup:safe-1')).toBe(false))
  })

  it('ignores a dismiss for a non-dismissible kind — low balance and zero USDC have no persistence', () => {
    const { result } = renderHook(() => useAttentionDismissals())

    act(() => {
      result.current.dismiss({ id: 'low-balance:safe-1', kind: 'low-balance', accountId: 'safe-1' })
      result.current.dismiss({ id: 'zero-usdc:safe-1', kind: 'zero-usdc', accountId: 'safe-1' })
    })

    expect(mockApiPost).not.toHaveBeenCalled()
    expect(result.current.acknowledgements.size).toBe(0)
  })

  it('a dismissible-kind item without its id is ignored, not POSTed', () => {
    const { result } = renderHook(() => useAttentionDismissals())

    act(() => {
      result.current.dismiss({ id: 'no-backup:', kind: 'no-backup' })
      result.current.dismiss({ id: 'needs-setup:', kind: 'needs-setup' })
      result.current.dismiss({ id: 'budget-reached:', kind: 'budget-reached' })
      // budget-usage needs the firing budget's period end too.
      result.current.dismiss({ id: 'budget-usage:agent-1', kind: 'budget-usage', agentId: 'agent-1' })
      // An agent-less payments-failed item is only ever the unattributed one.
      result.current.dismiss({ id: 'payments-failed:agent-1', kind: 'payments-failed' })
    })

    expect(mockApiPost).not.toHaveBeenCalled()
  })

  // ── #4324: acknowledgements ────────────────────────────────────────────────

  it('#4324: acknowledging writes the per-kind body for every new kind', async () => {
    const { result } = renderHook(() => useAttentionDismissals())

    act(() => {
      result.current.dismiss({ id: 'budget-reached:agent-1', kind: 'budget-reached', agentId: 'agent-1' })
      result.current.dismiss({ id: 'budget-scope:agent-1', kind: 'budget-scope', agentId: 'agent-1' })
      result.current.dismiss({
        id: 'budget-usage:agent-1',
        kind: 'budget-usage',
        agentId: 'agent-1',
        periodEnd: '2026-11-01T00:00:00.000Z',
      })
      result.current.dismiss({ id: 'payments-failed:agent-1', kind: 'payments-failed', agentId: 'agent-1' })
      result.current.dismiss({ id: 'payments-failed:unattributed', kind: 'payments-failed' })
      result.current.dismiss({ id: 'haven-paused', kind: 'haven-paused' })
    })

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(6))
    expect(mockApiPost.mock.calls.map(([, body]) => body)).toEqual([
      { item_kind: 'budget-reached', agent_id: 'agent-1' },
      { item_kind: 'budget-scope', agent_id: 'agent-1' },
      { item_kind: 'budget-usage', agent_id: 'agent-1', period_end: '2026-11-01T00:00:00.000Z' },
      { item_kind: 'payments-failed', agent_id: 'agent-1' },
      { item_kind: 'payments-failed' },
      { item_kind: 'haven-paused' },
    ])
    expect(result.current.acknowledgements.get('budget-usage:agent-1')?.acknowledgedPeriodEnd).toBe(
      '2026-11-01T00:00:00.000Z',
    )
  })

  it('#4324: the server row replaces the optimistic acknowledgement time', async () => {
    mockApiPost.mockResolvedValueOnce({
      id: 'd9',
      item_kind: 'budget-reached',
      account_id: null,
      agent_id: 'agent-1',
      created_at: '2026-10-20T00:00:00.000Z',
      acknowledged_at: '2026-10-23T09:00:00.000Z',
      acknowledged_period_end: null,
    })
    const { result } = renderHook(() => useAttentionDismissals())

    act(() => {
      result.current.dismiss({ id: 'budget-reached:agent-1', kind: 'budget-reached', agentId: 'agent-1' })
    })

    await waitFor(() =>
      expect(result.current.acknowledgements.get('budget-reached:agent-1')?.acknowledgedAt).toBe(
        '2026-10-23T09:00:00.000Z',
      ),
    )
  })

  it('#4324: a failed re-acknowledgement restores the older acknowledgement, not nothing', async () => {
    mockApiGet.mockResolvedValue({
      dismissals: [
        {
          id: 'd1',
          item_kind: 'budget-reached',
          account_id: null,
          agent_id: 'agent-1',
          created_at: '2026-10-01T00:00:00.000Z',
          acknowledged_at: '2026-10-01T00:00:00.000Z',
          acknowledged_period_end: null,
        },
      ],
    })
    mockApiPost.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useAttentionDismissals())
    await waitFor(() => expect(result.current.acknowledgements.has('budget-reached:agent-1')).toBe(true))

    act(() => {
      result.current.dismiss({ id: 'budget-reached:agent-1', kind: 'budget-reached', agentId: 'agent-1' })
    })

    await waitFor(() =>
      expect(result.current.acknowledgements.get('budget-reached:agent-1')?.acknowledgedAt).toBe(
        '2026-10-01T00:00:00.000Z',
      ),
    )
  })

  it('#4324: loads acknowledged_at and acknowledged_period_end; an old row without acknowledged_at falls back to created_at', async () => {
    mockApiGet.mockResolvedValue({
      dismissals: [
        {
          id: 'd1',
          item_kind: 'budget-usage',
          account_id: null,
          agent_id: 'agent-1',
          created_at: '2026-10-01T00:00:00.000Z',
          acknowledged_at: '2026-10-20T00:00:00.000Z',
          acknowledged_period_end: '2026-11-01T00:00:00.000Z',
        },
        { id: 'd2', item_kind: 'no-backup', account_id: 'safe-1', agent_id: null, created_at: '2026-10-09T00:00:00.000Z' },
      ],
    })
    const { result } = renderHook(() => useAttentionDismissals())
    await waitFor(() => expect(result.current.acknowledgements.size).toBe(2))
    expect(result.current.acknowledgements.get('budget-usage:agent-1')).toEqual({
      acknowledgedAt: '2026-10-20T00:00:00.000Z',
      acknowledgedPeriodEnd: '2026-11-01T00:00:00.000Z',
    })
    expect(result.current.acknowledgements.get('no-backup:safe-1')).toEqual({
      acknowledgedAt: '2026-10-09T00:00:00.000Z',
      acknowledgedPeriodEnd: null,
    })
  })

  it('#4324 S1: a row of an unknown kind is ignored — it never hides an agent\'s Needs setup item', async () => {
    mockApiGet.mockResolvedValue({
      dismissals: [
        { id: 'd1', item_kind: 'some-future-kind', account_id: null, agent_id: 'agent-1', created_at: '2026-10-09T00:00:00.000Z' },
      ],
    })
    const { result } = renderHook(() => useAttentionDismissals())
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current.acknowledgements.has('needs-setup:agent-1')).toBe(false)
    expect(result.current.acknowledgements.size).toBe(0)
  })

  // ── The legacy key migration (owner decision 4, #3813) ────────────────────
  describe('legacy key migration', () => {
    const FUNDED_RECOMMENDED = account({
      accountId: 'safe-1',
      needs_backup_recommendation: true,
      funded: true,
    })

    it('writes server dismissals for the accounts raising the item now, then clears the key', async () => {
      window.localStorage.setItem(LEGACY_DISMISS_KEY, '1')
      mockApiGet.mockResolvedValue({ dismissals: [] })

      const { result } = renderHook(() =>
        useAttentionDismissals({
          accounts: [
            FUNDED_RECOMMENDED,
            account({ accountId: 'safe-norec', needs_backup_recommendation: false, funded: true }),
            account({ accountId: 'safe-unfunded', needs_backup_recommendation: true, funded: false }),
            account({ accountId: 'safe-testnet', isTestnet: true, needs_backup_recommendation: true, funded: true }),
          ],
        }),
      )

      await waitFor(() =>
        expect(mockApiPost).toHaveBeenCalledTimes(1),
      )
      expect(mockApiPost).toHaveBeenCalledWith('/user/attention-dismissals', {
        item_kind: 'no-backup',
        account_id: 'safe-1',
      })
      // Only the accounts the old key was actually hiding get a dismissal —
      // and only after EVERY write succeeded is the key cleared.
      expect(window.localStorage.getItem(LEGACY_DISMISS_KEY)).toBeNull()
      // The migrated account is hidden this session, without waiting for
      // the next server read; the accounts that were not raising the item
      // are not.
      expect(result.current.acknowledgements.has('no-backup:safe-1')).toBe(true)
      expect(result.current.acknowledgements.has('no-backup:safe-norec')).toBe(false)
      expect(result.current.acknowledgements.has('no-backup:safe-testnet')).toBe(false)
    })

    it('an account funded AFTER the migration still raises its own item', async () => {
      window.localStorage.setItem(LEGACY_DISMISS_KEY, '1')
      mockApiGet.mockResolvedValue({ dismissals: [] })

      const { result } = renderHook(() =>
        useAttentionDismissals({
          accounts: [
            FUNDED_RECOMMENDED,
            // Funded at migration time, but NOT raising the item — its
            // dismissal would wrongly hide a future backup item.
            account({ accountId: 'safe-later', needs_backup_recommendation: true, funded: false }),
          ],
        }),
      )

      await waitFor(() => expect(mockApiPost).toHaveBeenCalledOnce())

      expect(result.current.acknowledgements.has('no-backup:safe-1')).toBe(true)
      // The later-funded account is NOT dismissed — when it becomes funded,
      // `computeAttentionItems` raises its own backup item.
      expect(result.current.acknowledgements.has('no-backup:safe-later')).toBe(false)
    })

    it('a failed write leaves the key for the next load to retry', async () => {
      window.localStorage.setItem(LEGACY_DISMISS_KEY, '1')
      mockApiPost.mockRejectedValueOnce(new Error('offline'))

      renderHook(() => useAttentionDismissals({ accounts: [FUNDED_RECOMMENDED] }))

      await waitFor(() => expect(mockApiPost).toHaveBeenCalledOnce())
      expect(window.localStorage.getItem(LEGACY_DISMISS_KEY)).toBe('1')
    })

    it('never migrates before a loaded overview — a failed load decides nothing', async () => {
      window.localStorage.setItem(LEGACY_DISMISS_KEY, '1')

      renderHook(() => useAttentionDismissals({ accounts: undefined }))

      await waitFor(() => expect(mockApiGet).toHaveBeenCalledOnce())
      expect(mockApiPost).not.toHaveBeenCalled()
      expect(window.localStorage.getItem(LEGACY_DISMISS_KEY)).toBe('1')
    })

    it('a mount without the key writes nothing', () => {
      renderHook(() => useAttentionDismissals({ accounts: [FUNDED_RECOMMENDED] }))

      expect(mockApiPost).not.toHaveBeenCalled()
    })
  })

  it('ruleItemIdForDismissal mirrors the rule-item id shapes', () => {
    expect(
      ruleItemIdForDismissal({ item_kind: 'no-backup', account_id: 'a', agent_id: null }),
    ).toBe('no-backup:a')
    expect(
      ruleItemIdForDismissal({ item_kind: 'needs-setup', account_id: null, agent_id: 'g' }),
    ).toBe('needs-setup:g')
    // #4324: per kind, for every new kind.
    for (const kind of ['budget-reached', 'budget-usage', 'budget-scope', 'payments-failed']) {
      expect(ruleItemIdForDismissal({ item_kind: kind, account_id: null, agent_id: 'g' })).toBe(`${kind}:g`)
    }
    expect(ruleItemIdForDismissal({ item_kind: 'payments-failed', account_id: null, agent_id: null })).toBe(
      'payments-failed:unattributed',
    )
    expect(ruleItemIdForDismissal({ item_kind: 'haven-paused', account_id: null, agent_id: null })).toBe('haven-paused')
    // An unknown kind, or a known kind missing its id, maps to nothing.
    expect(ruleItemIdForDismissal({ item_kind: 'low-balance', account_id: 'a', agent_id: null })).toBeNull()
    expect(ruleItemIdForDismissal({ item_kind: 'some-future-kind', account_id: null, agent_id: 'g' })).toBeNull()
    expect(ruleItemIdForDismissal({ item_kind: 'budget-reached', account_id: null, agent_id: null })).toBeNull()
    expect(ruleItemIdForDismissal({ item_kind: 'no-backup', account_id: null, agent_id: null })).toBeNull()
  })
})
