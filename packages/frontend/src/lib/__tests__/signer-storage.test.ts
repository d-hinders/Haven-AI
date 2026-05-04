import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const mockUseAccount = vi.fn()
const mockUseWalletClient = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => mockUseAccount(),
  useWalletClient: () => mockUseWalletClient(),
}))

import {
  clearStoredPasskeySigner,
  getStoredPasskeySigner,
  passkeyStorageKey,
  setStoredPasskeySigner,
  useActiveSigner,
} from '@/lib/signer'

const SAFE_ADDRESS = '0x07058311f995c89F4DbE17Db61fa1A3CDe638975' as Address
const SIGNER_ADDRESS = '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2' as Address

const storedValue = {
  schemaVersion: 1 as const,
  address: SIGNER_ADDRESS,
  credentialId: 'credential-123',
  publicKey: {
    x: `0x${'11'.repeat(32)}`,
    y: `0x${'22'.repeat(32)}`,
  },
  chainId: 100,
  safeAddress: SAFE_ADDRESS,
  createdAt: 123,
}

describe('passkey signer storage', () => {
  beforeEach(() => {
    localStorage.clear()
    mockUseAccount.mockReset()
    mockUseWalletClient.mockReset()
    mockUseAccount.mockReturnValue({ address: undefined })
    mockUseWalletClient.mockReturnValue({ data: undefined })
  })

  it('round-trips a stored passkey signer', () => {
    setStoredPasskeySigner(storedValue)

    expect(
      getStoredPasskeySigner({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    ).toEqual({
      type: 'passkey',
      address: SIGNER_ADDRESS,
      credentialId: 'credential-123',
      publicKey: storedValue.publicKey,
      chainId: 100,
    })
  })

  it('clears a stored passkey signer', () => {
    setStoredPasskeySigner(storedValue)

    clearStoredPasskeySigner({
      safeAddress: SAFE_ADDRESS,
      chainId: 100,
    })

    expect(
      getStoredPasskeySigner({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    ).toBeNull()
  })

  it('rejects legacy entries without a schemaVersion', () => {
    localStorage.setItem(
      passkeyStorageKey(SAFE_ADDRESS, 100),
      JSON.stringify({
        ...storedValue,
        schemaVersion: undefined,
      }),
    )

    expect(
      getStoredPasskeySigner({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    ).toBeNull()
  })

  it('rejects future schema versions', () => {
    localStorage.setItem(
      passkeyStorageKey(SAFE_ADDRESS, 100),
      JSON.stringify({
        ...storedValue,
        schemaVersion: 99,
      }),
    )

    expect(
      getStoredPasskeySigner({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    ).toBeNull()
  })

  it('dispatches a storage event when writing', () => {
    const listener = vi.fn()
    window.addEventListener('storage', listener)

    setStoredPasskeySigner(storedValue)

    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('storage', listener)
  })

  it('re-renders useActiveSigner after same-tab storage writes', () => {
    const { result } = renderHook(() =>
      useActiveSigner({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    )

    expect(result.current).toBeNull()

    act(() => {
      setStoredPasskeySigner(storedValue)
    })

    expect(result.current).toMatchObject({
      type: 'passkey',
      address: SIGNER_ADDRESS,
      credentialId: 'credential-123',
    })
  })
})
