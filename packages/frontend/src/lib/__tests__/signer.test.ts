import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const mockUseAccount = vi.fn()
const mockUseWalletClient = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => mockUseAccount(),
  useWalletClient: (args: unknown) => mockUseWalletClient(args),
}))

import {
  credentialIdFromKeyId,
  getStoredPasskeySigner,
  isSafeCapableSigner,
  rememberPasskeyCredentialOnDevice,
  setStoredHybridSigners,
  useActiveSigner,
  type HybridAccountSigners,
} from '@/lib/signer'

const SAFE_ADDRESS = '0x07058311f995c89F4DbE17Db61fa1A3CDe638975' as Address
const PASSKEY_SIGNER_ADDRESS = '0x0802E96a6dd7e1DD80620CF5D759d41B714c0ce2' as Address
const EOA_ADDRESS = '0x1111111111111111111111111111111111111111' as Address

describe('getStoredPasskeySigner', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('reads passkey signer metadata for the active safe', () => {
    localStorage.setItem(
      'haven_passkey_0x07058311f995c89f4dbe17db61fa1a3cde638975_100',
      JSON.stringify({
        schemaVersion: 1,
        address: PASSKEY_SIGNER_ADDRESS,
        credentialId: 'credential-123',
        publicKey: {
          x: `0x${'11'.repeat(32)}`,
          y: `0x${'22'.repeat(32)}`,
        },
        chainId: 100,
        safeAddress: SAFE_ADDRESS,
        createdAt: 123,
      }),
    )

    expect(
      getStoredPasskeySigner({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    ).toEqual({
      type: 'passkey',
      address: PASSKEY_SIGNER_ADDRESS,
      credentialId: 'credential-123',
      publicKey: {
        x: `0x${'11'.repeat(32)}`,
        y: `0x${'22'.repeat(32)}`,
      },
      chainId: 100,
    })
  })

  it('returns null for malformed stored metadata', () => {
    localStorage.setItem(
      'haven_passkey_0x07058311f995c89f4dbe17db61fa1a3cde638975_100',
      JSON.stringify({
        schemaVersion: 1,
        address: PASSKEY_SIGNER_ADDRESS,
        credentialId: 'credential-123',
        publicKey: {
          x: '0x1234',
          y: `0x${'22'.repeat(32)}`,
        },
        chainId: 100,
        safeAddress: SAFE_ADDRESS,
        createdAt: 123,
      }),
    )

    expect(
      getStoredPasskeySigner({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    ).toBeNull()
  })
})

describe('useActiveSigner', () => {
  beforeEach(() => {
    localStorage.clear()
    mockUseAccount.mockReset()
    mockUseWalletClient.mockReset()
  })

  it('prefers a stored passkey signer over a connected wallet', () => {
    localStorage.setItem(
      'haven_passkey_0x07058311f995c89f4dbe17db61fa1a3cde638975_100',
      JSON.stringify({
        schemaVersion: 1,
        address: PASSKEY_SIGNER_ADDRESS,
        credentialId: 'credential-123',
        publicKey: {
          x: `0x${'11'.repeat(32)}`,
          y: `0x${'22'.repeat(32)}`,
        },
        chainId: 100,
        safeAddress: SAFE_ADDRESS,
        createdAt: 123,
      }),
    )
    mockUseAccount.mockReturnValue({ address: EOA_ADDRESS })
    mockUseWalletClient.mockReturnValue({ data: { account: { address: EOA_ADDRESS } } })

    const { result } = renderHook(() =>
      useActiveSigner({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    )

    expect(result.current).toMatchObject({
      type: 'passkey',
      address: PASSKEY_SIGNER_ADDRESS,
      credentialId: 'credential-123',
    })
    expect(mockUseWalletClient).toHaveBeenCalledWith({ chainId: 100 })
  })

  it('falls back to the connected EOA when no passkey metadata exists', () => {
    const walletClient = { transport: {} }
    mockUseAccount.mockReturnValue({ address: EOA_ADDRESS })
    mockUseWalletClient.mockReturnValue({ data: walletClient })

    const { result } = renderHook(() =>
      useActiveSigner({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    )

    expect(result.current).toEqual({
      type: 'eoa',
      address: EOA_ADDRESS,
      walletClient,
    })
    expect(mockUseWalletClient).toHaveBeenCalledWith({ chainId: 100 })
  })

  // ── Hybrid resolution (#1079) ────────────────────────────────────────────

  const HYBRID_ADDRESS = '0x9999888877776666555544443333222211110000' as Address
  const HYBRID_KEY_ID = '0x0102030405060708'
  const HYBRID_SIGNERS: HybridAccountSigners = {
    account_address: HYBRID_ADDRESS,
    chain_id: 84532,
    owner_address: null,
    passkeys: [
      { key_id: HYBRID_KEY_ID, x: `0x${'aa'.repeat(32)}`, y: `0x${'bb'.repeat(32)}` },
    ],
  }

  it('resolves a delegator_passkey signer when hybrid signers are stored and the key is on this device', () => {
    setStoredHybridSigners(HYBRID_SIGNERS)
    rememberPasskeyCredentialOnDevice(credentialIdFromKeyId(HYBRID_KEY_ID))
    // A connected wallet must NOT win over the account's own signer.
    mockUseAccount.mockReturnValue({ address: EOA_ADDRESS })
    mockUseWalletClient.mockReturnValue({ data: { transport: {} } })

    const { result } = renderHook(() =>
      useActiveSigner({ safeAddress: HYBRID_ADDRESS, chainId: 84532 }),
    )

    expect(result.current).toEqual({
      type: 'delegator_passkey',
      accountAddress: HYBRID_ADDRESS,
      chainId: 84532,
      signers: HYBRID_SIGNERS,
    })
    expect(isSafeCapableSigner(result.current)).toBe(false)
  })

  it('does NOT resolve the hybrid signer when the device marker is missing', () => {
    setStoredHybridSigners(HYBRID_SIGNERS)
    mockUseAccount.mockReturnValue({ address: undefined })
    mockUseWalletClient.mockReturnValue({ data: undefined })

    const { result } = renderHook(() =>
      useActiveSigner({ safeAddress: HYBRID_ADDRESS, chainId: 84532 }),
    )

    expect(result.current).toBeNull()
  })

  it('scopes hybrid signers to their own account address and chain', () => {
    setStoredHybridSigners(HYBRID_SIGNERS)
    rememberPasskeyCredentialOnDevice(credentialIdFromKeyId(HYBRID_KEY_ID))
    const walletClient = { transport: {} }
    mockUseAccount.mockReturnValue({ address: EOA_ADDRESS })
    mockUseWalletClient.mockReturnValue({ data: walletClient })

    // Different safe → legacy EOA fallback, untouched by the hybrid store.
    const { result } = renderHook(() =>
      useActiveSigner({ safeAddress: SAFE_ADDRESS, chainId: 100 }),
    )

    expect(result.current).toEqual({ type: 'eoa', address: EOA_ADDRESS, walletClient })
  })
})
