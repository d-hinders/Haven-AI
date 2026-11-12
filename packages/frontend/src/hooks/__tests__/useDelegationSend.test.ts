/**
 * #4820: what a rejected transfer SUBMIT is evidence of.
 *
 * The submit POST is the only call that can move funds, so its rejection is
 * classified rather than folded into `failed`: the route's outcome-unknown
 * answer, a request that got no answer at all, and a 5xx without the route's
 * code all mean the transfer may have gone through. A 4xx, the route's
 * known-failure code, and every failure BEFORE the submit (prepare refused,
 * signing failed or cancelled) keep today's reading.
 */
import { renderHook, act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/lib/api'

const { mockGet, mockPost, mockSign, mockSigner, mockOnDevice } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockSign: vi.fn(),
  mockSigner: vi.fn(),
  mockOnDevice: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { get: mockGet, post: mockPost } }
})
vi.mock('@/lib/signer', () => ({
  useActiveSigner: () => mockSigner(),
  hasPasskeyCredentialOnDevice: (id: string) => mockOnDevice(id),
  credentialIdFromKeyId: (k: string) => k,
}))
vi.mock('@/lib/hybridAccountOps', () => ({ signPreparedAccountOp: mockSign }))

const { useDelegationSend } = await import('@/hooks/useDelegationSend')

const ACCOUNT = '0x' + 'aa'.repeat(20)
const TOKEN = '0x' + '05'.repeat(20)
const TO = '0x' + '06'.repeat(20)
const USER_OP_HASH = '0x' + 'dd'.repeat(32)

const SIGNERS = {
  account_address: ACCOUNT,
  chain_id: 84532,
  owner_address: null,
  passkeys: [{ key_id: '0x' + '11'.repeat(32), x: '0x1', y: '0x2' }],
}

const PREPARED = {
  signature_scheme: 'webauthn_userop' as const,
  user_op_hash: '0x' + 'ee'.repeat(32),
  user_operation: { sender: ACCOUNT, callData: '0xffff' },
}

const INPUT = { tokenAddress: TOKEN as `0x${string}`, to: TO as `0x${string}`, amountAtomic: '250000' }

/** A submit rejection carrying the route's body. */
function apiError(status: number, body: Record<string, unknown>): ApiRequestError {
  return new ApiRequestError(String(body.error ?? 'failed'), status, body)
}

async function sendOnce() {
  const { result } = renderHook(() => useDelegationSend(ACCOUNT, 84532))
  await waitFor(() => expect(result.current.ready).toBe(true))
  let outcome: unknown
  await act(async () => {
    outcome = await result.current.send(INPUT)
  })
  return outcome
}

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockSign.mockReset()
  mockSigner.mockReset()
  mockOnDevice.mockReset()
  mockGet.mockResolvedValue(SIGNERS)
  mockSigner.mockReturnValue(null)
  mockOnDevice.mockReturnValue(false)
  mockSign.mockResolvedValue('0x' + 'ab'.repeat(80))
})

describe('useDelegationSend — a confirmed send', () => {
  it('returns the transaction hash', async () => {
    mockPost
      .mockResolvedValueOnce(PREPARED)
      .mockResolvedValueOnce({ submitted: true, tx_hash: '0x' + 'ff'.repeat(32) })
    expect(await sendOnce()).toEqual({ ok: true, txHash: '0x' + 'ff'.repeat(32) })
  })
})

describe('useDelegationSend — a failure BEFORE the submit (nothing was sent)', () => {
  it('a refused prepare is `failed`, never `unconfirmed`', async () => {
    mockPost.mockRejectedValueOnce(apiError(400, { error: 'A valid to address is required' }))
    expect(await sendOnce()).toEqual({
      ok: false,
      reason: 'failed',
      message: 'A valid to address is required',
    })
  })

  it('a prepare that got no answer is still `failed`: nothing was submitted', async () => {
    mockPost.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await sendOnce()).toEqual({ ok: false, reason: 'failed', message: 'Failed to fetch' })
  })

  it('a signing failure is `failed`', async () => {
    mockPost.mockResolvedValueOnce(PREPARED)
    mockSign.mockRejectedValueOnce(new Error('Connect your account owner wallet'))
    expect(await sendOnce()).toEqual({
      ok: false,
      reason: 'failed',
      message: 'Connect your account owner wallet',
    })
  })

  it('a dismissed passkey prompt is `cancelled`', async () => {
    mockPost.mockResolvedValueOnce(PREPARED)
    const cancelled = new Error('Failed to request credential')
    cancelled.name = 'NotAllowedError'
    mockSign.mockRejectedValueOnce(cancelled)
    expect(await sendOnce()).toEqual({ ok: false, reason: 'cancelled' })
  })
})

describe('useDelegationSend — a rejected SUBMIT (the transfer may have gone through)', () => {
  it("the route's outcome-unknown answer is `unconfirmed`, with the operation hash", async () => {
    mockPost.mockResolvedValueOnce(PREPARED).mockRejectedValueOnce(
      apiError(502, {
        error: 'The transfer may have gone through',
        error_code: 'submission_outcome_unknown',
        user_op_hash: USER_OP_HASH,
      }),
    )
    expect(await sendOnce()).toEqual({
      ok: false,
      reason: 'unconfirmed',
      message: 'The transfer may have gone through',
      userOpHash: USER_OP_HASH,
    })
  })

  it('a submit that got no HTTP answer at all is `unconfirmed`', async () => {
    mockPost.mockResolvedValueOnce(PREPARED).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await sendOnce()).toEqual({ ok: false, reason: 'unconfirmed', message: 'Failed to fetch' })
  })

  it('a 502 with no error_code (a platform answer) is `unconfirmed`', async () => {
    mockPost
      .mockResolvedValueOnce(PREPARED)
      .mockRejectedValueOnce(apiError(502, { error: 'Bad Gateway' }))
    expect(await sendOnce()).toEqual({ ok: false, reason: 'unconfirmed', message: 'Bad Gateway' })
  })

  it('a 5xx carrying a code this client does not know is `unconfirmed`', async () => {
    mockPost
      .mockResolvedValueOnce(PREPARED)
      .mockRejectedValueOnce(apiError(503, { error: 'Service Unavailable', error_code: 'upstream_down' }))
    expect(await sendOnce()).toEqual({
      ok: false,
      reason: 'unconfirmed',
      message: 'Service Unavailable',
    })
  })
})

describe('useDelegationSend — a KNOWN submit failure (nothing moved)', () => {
  it("the route's known-failure code is `failed`", async () => {
    mockPost.mockResolvedValueOnce(PREPARED).mockRejectedValueOnce(
      apiError(502, { error: 'Transfer failed', error_code: 'onchain_execution_failed' }),
    )
    expect(await sendOnce()).toEqual({ ok: false, reason: 'failed', message: 'Transfer failed' })
  })

  it('a 4xx is `failed`', async () => {
    mockPost
      .mockResolvedValueOnce(PREPARED)
      .mockRejectedValueOnce(apiError(400, { error: 'user_operation does not match the requested transfer' }))
    expect(await sendOnce()).toEqual({
      ok: false,
      reason: 'failed',
      message: 'user_operation does not match the requested transfer',
    })
  })
})
