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

describe('useAttentionDismissals (#3813)', () => {
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
      expect(result.current.dismissedIds.has('no-backup:safe-1')).toBe(true)
      expect(result.current.dismissedIds.has('needs-setup:agent-1')).toBe(true)
    })
    expect(result.current.dismissedIds.size).toBe(2)
  })

  it('a failed read hides nothing — the dismissed set stays empty', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('offline'))

    const { result } = renderHook(() => useAttentionDismissals())

    await waitFor(() => expect(mockApiGet).toHaveBeenCalledOnce())
    expect(result.current.dismissedIds.size).toBe(0)
  })

  it('dismiss writes through for the backup item and hides it optimistically', async () => {
    const { result } = renderHook(() => useAttentionDismissals())

    act(() => {
      result.current.dismiss({ kind: 'no-backup', accountId: 'safe-1' })
    })

    expect(result.current.dismissedIds.has('no-backup:safe-1')).toBe(true)
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
      result.current.dismiss({ kind: 'needs-setup', agentId: 'agent-1' })
    })

    expect(result.current.dismissedIds.has('needs-setup:agent-1')).toBe(true)
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
      result.current.dismiss({ kind: 'no-backup', accountId: 'safe-1' })
    })
    expect(result.current.dismissedIds.has('no-backup:safe-1')).toBe(true)

    await waitFor(() => expect(result.current.dismissedIds.has('no-backup:safe-1')).toBe(false))
  })

  it('ignores a dismiss for a non-dismissible kind — those have no persistence', () => {
    const { result } = renderHook(() => useAttentionDismissals())

    act(() => {
      result.current.dismiss({ kind: 'low-balance', accountId: 'safe-1' })
      result.current.dismiss({ kind: 'budget-reached', agentId: 'agent-1' })
      result.current.dismiss({ kind: 'payments-failed' })
    })

    expect(mockApiPost).not.toHaveBeenCalled()
    expect(result.current.dismissedIds.size).toBe(0)
  })

  it('a dismissible-kind item without its id is ignored, not POSTed', () => {
    const { result } = renderHook(() => useAttentionDismissals())

    act(() => {
      result.current.dismiss({ kind: 'no-backup' })
      result.current.dismiss({ kind: 'needs-setup' })
    })

    expect(mockApiPost).not.toHaveBeenCalled()
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
      expect(result.current.dismissedIds.has('no-backup:safe-1')).toBe(true)
      expect(result.current.dismissedIds.has('no-backup:safe-norec')).toBe(false)
      expect(result.current.dismissedIds.has('no-backup:safe-testnet')).toBe(false)
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

      expect(result.current.dismissedIds.has('no-backup:safe-1')).toBe(true)
      // The later-funded account is NOT dismissed — when it becomes funded,
      // `computeAttentionItems` raises its own backup item.
      expect(result.current.dismissedIds.has('no-backup:safe-later')).toBe(false)
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
  })
})
