import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLabels } from '../useLabels'

const { mockGet, mockPut, mockPost, mockDelete } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPut: vi.fn(),
  mockPost: vi.fn(),
  mockDelete: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}))

const LABELS = {
  labels: [
    { id: 'label-1', name: 'prod', color: 'brand', created_at: '2026-05-01T00:00:00Z' },
    { id: 'label-2', name: 'finance', color: 'debit', created_at: '2026-05-01T00:00:00Z' },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue(LABELS)
  mockPost.mockResolvedValue({ id: 'label-3', name: 'staging', color: 'neutral', created_at: '2026-05-02T00:00:00Z' })
  mockPut.mockResolvedValue({ id: 'label-1', name: 'production', color: 'brand', created_at: '2026-05-01T00:00:00Z' })
  mockDelete.mockResolvedValue({})
})

// The hook is deliberately PASSIVE — no fetch on mount. Both consumers (the
// tag editor and the manager) fetch when their modal opens, and a mount fetch
// here would double-fetch on every open.
describe('useLabels', () => {
  it('fetchLabels loads the vocabulary and degrades an absent key to []', async () => {
    const { result } = renderHook(() => useLabels())
    await act(async () => {
      await result.current.fetchLabels()
    })
    expect(mockGet).toHaveBeenCalledWith('/labels')
    expect(result.current.loading).toBe(false)
    expect(result.current.labels).toHaveLength(2)

    mockGet.mockResolvedValue({})
    await act(async () => {
      await result.current.fetchLabels()
    })
    expect(result.current.labels).toEqual([])
  })

  it('create sorts the new label into the vocabulary', async () => {
    const { result } = renderHook(() => useLabels())
    await act(async () => {
      await result.current.fetchLabels()
    })

    await act(async () => {
      await result.current.createLabel('staging')
    })
    expect(mockPost).toHaveBeenCalledWith('/labels', { name: 'staging' })
    expect(result.current.labels.map((l) => l.name)).toEqual(['finance', 'prod', 'staging'])
  })

  it('update replaces the edited label and re-sorts', async () => {
    const { result } = renderHook(() => useLabels())
    await act(async () => {
      await result.current.fetchLabels()
    })

    await act(async () => {
      await result.current.updateLabel('label-1', { name: 'production' })
    })
    expect(mockPut).toHaveBeenCalledWith('/labels/label-1', { name: 'production' })
    expect(result.current.labels.map((l) => l.name)).toEqual(['finance', 'production'])
  })

  it('delete removes the label locally', async () => {
    const { result } = renderHook(() => useLabels())
    await act(async () => {
      await result.current.fetchLabels()
    })

    await act(async () => {
      await result.current.deleteLabel('label-1')
    })
    expect(mockDelete).toHaveBeenCalledWith('/labels/label-1')
    expect(result.current.labels.map((l) => l.name)).toEqual(['finance'])
  })

  it('putAgentLabels resolves with the API-returned label set', async () => {
    const saved = { labels: [{ id: 'label-2', name: 'finance', color: 'debit', created_at: '2026-05-01T00:00:00Z' }] }
    mockPut.mockResolvedValue(saved)
    const { result } = renderHook(() => useLabels())

    let resolved: unknown
    await act(async () => {
      resolved = await result.current.putAgentLabels('agent-1', ['label-2'])
    })
    expect(mockPut).toHaveBeenCalledWith('/agents/agent-1/labels', { label_ids: ['label-2'] })
    expect(resolved).toEqual(saved.labels)
  })

  it('a fetch error sets the message and keeps the previous list', async () => {
    const { result } = renderHook(() => useLabels())
    await act(async () => {
      await result.current.fetchLabels()
    })
    expect(result.current.labels).toHaveLength(2)

    mockGet.mockRejectedValue(new Error('offline'))
    await act(async () => {
      await result.current.fetchLabels()
    })
    expect(result.current.error).toBe('We could not load your labels. Try again in a moment.')
    expect(result.current.labels).toHaveLength(2) // last good list survives
  })
})
