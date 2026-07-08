import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { mockPost, mockSign, mockExecute, mockPropose, mockNonce, mockHash } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockSign: vi.fn(),
  mockExecute: vi.fn(),
  mockPropose: vi.fn(),
  mockNonce: vi.fn(),
  mockHash: vi.fn(),
}))

vi.mock('wagmi', () => ({ usePublicClient: () => ({}) }))
vi.mock('@/lib/signer', () => ({ useActiveSigner: () => ({ type: 'eoa', address: '0x' + '11'.repeat(20) }) }))
vi.mock('@/lib/api', () => ({ api: { post: mockPost, get: vi.fn() } }))
vi.mock('@/lib/safe-tx', () => ({
  getSafeNonce: mockNonce,
  signSafeTx: mockSign,
  executeSafeTx: mockExecute,
  proposeSafeTx: mockPropose,
  getSafeTxHash: mockHash,
}))

const { useApplySchedule } = await import('../useApplySchedule')

const BUILD = {
  inner_txs: [{ to: '0x' + '22'.repeat(20), data: '0xdead' }],
  from_period: 100,
  period_count: 90,
  first_permission_id: `0x${'ab'.repeat(32)}`,
}
const ARGS = {
  agentId: 'agent-1',
  safeAddress: '0x' + 'cd'.repeat(20),
  chainId: 84532,
}

beforeEach(() => {
  window.localStorage.clear()
  mockNonce.mockResolvedValue(1n)
  mockSign.mockResolvedValue('0x' + 'ee'.repeat(65))
  mockHash.mockReturnValue(`0x${'ff'.repeat(32)}`)
  mockExecute.mockResolvedValue({ txHash: '0x1' })
  mockPropose.mockResolvedValue(undefined)
})

describe('useApplySchedule — multi-sig propose + confirm retry (#800)', () => {
  it('threshold 1: executes and confirms directly', async () => {
    mockPost.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/build') ? BUILD : { recorded: true }),
    )
    const { result } = renderHook(() =>
      useApplySchedule({ ...ARGS, safeDetails: { threshold: 1 } as never }),
    )
    let res
    await act(async () => {
      res = await result.current.apply()
    })
    expect(res).toEqual({ ok: true })
    expect(mockExecute).toHaveBeenCalled()
    expect(mockPropose).not.toHaveBeenCalled()
    expect(mockPost.mock.calls.some(([p]) => String(p).endsWith('/confirm'))).toBe(true)
    // nothing parked:
    expect(window.localStorage.getItem('haven:schedule-pending-confirm:agent-1')).toBeNull()
  })

  it('threshold 2: proposes, parks the confirm, reports proposed — never executes', async () => {
    mockPost.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('/build') ? BUILD : { recorded: true }),
    )
    const { result } = renderHook(() =>
      useApplySchedule({ ...ARGS, safeDetails: { threshold: 2 } as never }),
    )
    let res
    await act(async () => {
      res = await result.current.apply()
    })
    expect(res).toEqual({ ok: true, proposed: true })
    expect(mockPropose).toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled()
    expect(result.current.awaitingCoOwners).toBe(true)
    const parked = JSON.parse(window.localStorage.getItem('haven:schedule-pending-confirm:agent-1')!)
    expect(parked).toMatchObject({ from_period: 100, first_permission_id: BUILD.first_permission_id })
    // confirm must NOT have been attempted at propose time:
    expect(mockPost.mock.calls.filter(([p]) => String(p).endsWith('/confirm'))).toHaveLength(0)
  })

  it('mount retry: a parked confirm records once the chain agrees (#801 arbitrates)', async () => {
    window.localStorage.setItem(
      'haven:schedule-pending-confirm:agent-1',
      JSON.stringify({ from_period: 100, period_count: 90, first_permission_id: BUILD.first_permission_id }),
    )
    mockPost.mockResolvedValue({ recorded: true }) // backend säger: nu är den enablad
    const { result } = renderHook(() =>
      useApplySchedule({ ...ARGS, safeDetails: { threshold: 2 } as never }),
    )
    await waitFor(() => expect(result.current.awaitingCoOwners).toBe(false))
    expect(window.localStorage.getItem('haven:schedule-pending-confirm:agent-1')).toBeNull()
  })

  it('mount retry: stays parked while the backend still 409s', async () => {
    window.localStorage.setItem(
      'haven:schedule-pending-confirm:agent-1',
      JSON.stringify({ from_period: 100, period_count: 90, first_permission_id: BUILD.first_permission_id }),
    )
    mockPost.mockImplementation(() => Promise.reject(new Error('409 not enabled')))
    const { result } = renderHook(() =>
      useApplySchedule({ ...ARGS, safeDetails: { threshold: 2 } as never }),
    )
    await waitFor(() => expect(result.current.awaitingCoOwners).toBe(true))
    expect(window.localStorage.getItem('haven:schedule-pending-confirm:agent-1')).not.toBeNull()
  })
})
