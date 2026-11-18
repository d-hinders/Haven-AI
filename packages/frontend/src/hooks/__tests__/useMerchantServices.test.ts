import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3027: mocked through the typed builder rather than a hand-rolled literal.
// The mount tick reads the builder's `/merchant-services` default (OFF with no
// account, schema-checked against `@haven_ai/core`); later ticks are queued on
// the same spy with `mockResolvedValueOnce`/`mockRejectedValueOnce`.
vi.mock('@/lib/api', async () => (await import('../../../e2e/fixtures/api-mock')).apiMock())

import { api } from '@/lib/api'
import { merchantServicesOff, merchantServicesOn } from '../../../e2e/fixtures/haven-api'
import { useMerchantServices } from '@/hooks/useMerchantServices'

const mockApiGet = api.get as unknown as ReturnType<typeof vi.fn>
const mockApiPost = api.post as unknown as ReturnType<typeof vi.fn>
const mockApiDelete = api.delete as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockApiGet.mockClear()
  mockApiPost.mockReset()
  mockApiDelete.mockReset()
})

describe('useMerchantServices — the read (#4904)', () => {
  it('reads the setting once on mount and exposes the account', async () => {
    mockApiGet.mockResolvedValueOnce(merchantServicesOn)
    const { result } = renderHook(() => useMerchantServices())

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(mockApiGet).toHaveBeenCalledWith('/merchant-services')
    expect(result.current.enabled).toBe(true)
    expect(result.current.merchantAccount).toMatchObject({ id: 'account-sales', name: 'Sales' })
  })

  it('a failed read is an error state, never a silent off', async () => {
    mockApiGet.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useMerchantServices())

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.enabled).toBe(false)
    expect(result.current.merchantAccount).toBeNull()
  })

  it('refresh re-reads the setting', async () => {
    mockApiGet.mockResolvedValueOnce(merchantServicesOff)
    const { result } = renderHook(() => useMerchantServices())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    mockApiGet.mockResolvedValueOnce(merchantServicesOn)
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.enabled).toBe(true)
  })
})

describe('useMerchantServices — the writes (#4904)', () => {
  it('turnOn resolves ok and moves the shell’s copy with the card’s', async () => {
    mockApiGet.mockResolvedValueOnce(merchantServicesOff)
    const { result } = renderHook(() => useMerchantServices())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    mockApiPost.mockResolvedValueOnce({ ...merchantServicesOn, created: true })
    let outcome: Awaited<ReturnType<typeof result.current.turnOn>> | undefined
    await act(async () => {
      outcome = await result.current.turnOn({ chain_id: 8453, source_account_id: 'a1', key_id: '0x11' })
    })

    expect(outcome).toMatchObject({ ok: true })
    expect(mockApiPost).toHaveBeenCalledWith('/merchant-services', {
      chain_id: 8453,
      source_account_id: 'a1',
      key_id: '0x11',
    })
    expect(result.current.enabled).toBe(true)
    expect(result.current.merchantAccount).toMatchObject({ id: 'account-sales' })
  })

  it('a repeat (200, created: false) is a success, not an error', async () => {
    mockApiGet.mockResolvedValueOnce(merchantServicesOff)
    const { result } = renderHook(() => useMerchantServices())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    mockApiPost.mockResolvedValueOnce({ ...merchantServicesOn, created: false })
    let outcome: Awaited<ReturnType<typeof result.current.turnOn>> | undefined
    await act(async () => {
      outcome = await result.current.turnOn({})
    })
    expect(outcome).toMatchObject({ ok: true })
    expect(result.current.enabled).toBe(true)
  })

  it('a refusal resolves as a typed refusal, not a thrown error', async () => {
    mockApiGet.mockResolvedValueOnce(merchantServicesOff)
    const { result } = renderHook(() => useMerchantServices())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    mockApiPost.mockRejectedValueOnce(
      Object.assign(new Error('refused'), {
        status: 409,
        body: { error_code: 'MERCHANT_ACCOUNT_ON_OTHER_NETWORK', chain_id: 8453 },
      }),
    )
    let outcome: Awaited<ReturnType<typeof result.current.turnOn>> | undefined
    await act(async () => {
      outcome = await result.current.turnOn({ chain_id: 84532 })
    })
    expect(outcome).toEqual({ ok: false, refusal: { kind: 'other_network', chainId: 8453 } })
    // A refusal changes nothing: the setting is still off.
    expect(result.current.enabled).toBe(false)
  })

  it('turnOff keeps the account and records the setting as off', async () => {
    mockApiGet.mockResolvedValueOnce(merchantServicesOn)
    const { result } = renderHook(() => useMerchantServices())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    mockApiDelete.mockResolvedValueOnce({ ...merchantServicesOn, enabled: false })
    let outcome: Awaited<ReturnType<typeof result.current.turnOff>> | undefined
    await act(async () => {
      outcome = await result.current.turnOff()
    })
    expect(outcome).toMatchObject({ ok: true })
    expect(mockApiDelete).toHaveBeenCalledWith('/merchant-services')
    expect(result.current.enabled).toBe(false)
    // The account and its history are kept (owner decision 5 on #4894).
    expect(result.current.merchantAccount).toMatchObject({ id: 'account-sales' })
  })

  it('a failed turnOff resolves with the backend’s sentence', async () => {
    mockApiGet.mockResolvedValueOnce(merchantServicesOn)
    const { result } = renderHook(() => useMerchantServices())
    await waitFor(() => expect(result.current.status).toBe('ready'))

    mockApiDelete.mockRejectedValueOnce(new Error('Haven could not turn Sales off'))
    let outcome: Awaited<ReturnType<typeof result.current.turnOff>> | undefined
    await act(async () => {
      outcome = await result.current.turnOff()
    })
    expect(outcome).toEqual({ ok: false, message: 'Haven could not turn Sales off' })
    expect(result.current.enabled).toBe(true)
  })
})
