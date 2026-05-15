import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const mockUseAccount = vi.fn()
const mockUseAuth = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => mockUseAccount(),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

import { PASSKEY_SCHEMA_VERSION, setStoredPasskeySigner } from '@/lib/signer'
import { useSafeOperationGate } from '@/hooks/useSafeOperationGate'

const SAFE_ADDRESS = '0x07058311f995c89F4DbE17Db61fa1A3CDe638975' as Address
const PASSKEY_SIGNER_ADDRESS = '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2' as Address
const EOA_ADDRESS = '0x1111111111111111111111111111111111111111' as Address

const PASSKEY_ROW = {
  id: 'passkey-1',
  credential_id: 'credential-123',
  signer_address: PASSKEY_SIGNER_ADDRESS,
  chain_id: 100,
  safe_address: SAFE_ADDRESS,
  created_at: '2026-05-05T00:00:00.000Z',
}

describe('useSafeOperationGate', () => {
  beforeEach(() => {
    localStorage.clear()
    mockUseAccount.mockReset()
    mockUseAuth.mockReset()

    mockUseAccount.mockReturnValue({ address: undefined })
    mockUseAuth.mockReturnValue({ passkeys: [] })
  })

  it('returns ready when this device has stored passkey metadata for the safe', () => {
    mockUseAuth.mockReturnValue({ passkeys: [PASSKEY_ROW] })
    setStoredPasskeySigner({
      schemaVersion: PASSKEY_SCHEMA_VERSION,
      address: PASSKEY_SIGNER_ADDRESS,
      credentialId: PASSKEY_ROW.credential_id,
      publicKey: {
        x: `0x${'11'.repeat(32)}`,
        y: `0x${'22'.repeat(32)}`,
      },
      chainId: 100,
      safeAddress: SAFE_ADDRESS,
      createdAt: 123,
    })

    const { result } = renderHook(() =>
      useSafeOperationGate({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    )

    expect(result.current).toEqual({ kind: 'ready' })
  })

  it('returns ready for an EOA safe when a wallet is connected', () => {
    mockUseAccount.mockReturnValue({ address: EOA_ADDRESS })

    const { result } = renderHook(() =>
      useSafeOperationGate({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    )

    expect(result.current).toEqual({ kind: 'ready' })
  })

  it('returns no_signer when there is neither a stored passkey nor a connected wallet', () => {
    const { result } = renderHook(() =>
      useSafeOperationGate({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    )

    expect(result.current).toEqual({ kind: 'no_signer' })
  })

  it('returns passkey_on_other_device when the backend has a passkey row but this device does not', () => {
    mockUseAuth.mockReturnValue({ passkeys: [PASSKEY_ROW] })
    mockUseAccount.mockReturnValue({ address: EOA_ADDRESS })

    const { result } = renderHook(() =>
      useSafeOperationGate({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    )

    expect(result.current).toEqual({ kind: 'passkey_on_other_device' })
  })
})
