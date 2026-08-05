import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.fn()
const mockApiPost = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => mockApiGet(...args),
    post: (...args: unknown[]) => mockApiPost(...args),
  },
}))

import { useAgentPassport, type AgentPassport, type AgentPassportStanding } from '@/hooks/useAgentPassport'

function passport(overrides: Partial<AgentPassport> = {}): AgentPassport {
  return {
    status: 'anchored',
    assurance_level: 0,
    attestation_uid: '0x' + '11'.repeat(32),
    tx_hash: '0x' + 'aa'.repeat(32),
    chain_id: 84532,
    attempts: 1,
    last_error: null,
    requested_at: '2026-06-02T10:00:00.000Z',
    anchored_at: '2026-06-02T10:00:12.000Z',
    ...overrides,
  }
}

function standing(overrides: Partial<AgentPassportStanding> = {}): AgentPassportStanding {
  return {
    agentId: 'agent-1',
    standing: 'active',
    anchor: 'anchored',
    attestationUid: '0x' + '11'.repeat(32),
    chainLagging: false,
    revocationConfirmedAt: null,
    ...overrides,
  }
}

describe('useAgentPassport', () => {
  beforeEach(() => {
    mockApiGet.mockReset()
    mockApiPost.mockReset()
  })

  it('reports no passport as null rather than an error — the normal case', async () => {
    mockApiGet.mockResolvedValueOnce({ passport: null, standing: standing({ anchor: 'not_anchored' }) })
    const { result } = renderHook(() => useAgentPassport('agent-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.passport).toBeNull()
    expect(result.current.standing?.anchor).toBe('not_anchored')
  })

  it('surfaces an anchored passport', async () => {
    mockApiGet.mockResolvedValueOnce({ passport: passport(), standing: standing() })
    const { result } = renderHook(() => useAgentPassport('agent-1'))
    await waitFor(() => expect(result.current.passport?.status).toBe('anchored'))
    expect(result.current.standing?.standing).toBe('active')
  })

  it('issuePassport posts then refetches, and surfaces a failure message', async () => {
    mockApiGet.mockResolvedValueOnce({ passport: null, standing: standing({ anchor: 'not_anchored' }) })
    const { result } = renderHook(() => useAgentPassport('agent-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    mockApiPost.mockRejectedValueOnce(new Error('Agent is revoked — a passport cannot be issued'))
    await act(() => result.current.issuePassport())
    await waitFor(() => expect(result.current.issueError).toBe('Agent is revoked — a passport cannot be issued'))
    expect(mockApiGet).toHaveBeenCalledTimes(1) // refetch skipped after a failed POST

    mockApiPost.mockResolvedValueOnce({ passport: passport({ status: 'pending' }) })
    mockApiGet.mockResolvedValueOnce({ passport: passport({ status: 'pending' }), standing: standing({ anchor: 'not_anchored' }) })
    await act(() => result.current.issuePassport())
    await waitFor(() => expect(result.current.passport?.status).toBe('pending'))
    expect(result.current.issueError).toBeNull()
  })

  it('ignores a late response from a superseded agentId', async () => {
    let resolveOld: (v: { passport: AgentPassport | null; standing: AgentPassportStanding | null }) => void = () => {}
    mockApiGet.mockImplementationOnce(
      () => new Promise((resolve) => { resolveOld = resolve }),
    )

    const { result, rerender } = renderHook(({ id }) => useAgentPassport(id), {
      initialProps: { id: 'agent-old' },
    })

    mockApiGet.mockResolvedValueOnce({ passport: passport(), standing: standing() })
    rerender({ id: 'agent-new' })
    await waitFor(() => expect(result.current.passport?.chain_id).toBe(84532))

    resolveOld({ passport: null, standing: standing({ agentId: 'agent-old', anchor: 'not_anchored' }) })
    await Promise.resolve()
    expect(result.current.passport).not.toBeNull()
  })
})
