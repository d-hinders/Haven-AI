import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'

const mockUseAccount = vi.fn()
const mockUseWalletClient = vi.fn()
const mockUseAuth = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => mockUseAccount(),
  useWalletClient: () => mockUseWalletClient(),
}))

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

import {
  PASSKEY_SCHEMA_VERSION,
  credentialIdFromKeyId,
  rememberPasskeyCredentialOnDevice,
  setStoredHybridSigners,
  setStoredPasskeySigner,
} from '@/lib/signer'
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
    mockUseWalletClient.mockReset()
    mockUseAuth.mockReset()

    mockUseAccount.mockReturnValue({ address: undefined })
    mockUseWalletClient.mockReturnValue({ data: undefined })
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

  it('returns ready for an EOA safe when a wallet is connected and walletClient is ready', () => {
    mockUseAccount.mockReturnValue({ address: EOA_ADDRESS })
    mockUseWalletClient.mockReturnValue({ data: { type: 'walletClient' } })

    const { result } = renderHook(() =>
      useSafeOperationGate({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    )

    expect(result.current).toEqual({ kind: 'ready' })
  })

  it('returns no_signer when a wallet address is connected but walletClient is not yet ready', () => {
    mockUseAccount.mockReturnValue({ address: EOA_ADDRESS })
    mockUseWalletClient.mockReturnValue({ data: undefined })

    const { result } = renderHook(() =>
      useSafeOperationGate({
        safeAddress: SAFE_ADDRESS,
        chainId: 100,
      }),
    )

    expect(result.current).toEqual({ kind: 'no_signer' })
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

  // ── Rail awareness (#1079): delegator_hybrid accounts ──────────────────

  const HYBRID_ADDRESS = '0x9999888877776666555544443333222211110000' as Address
  const HYBRID_KEY_ID = '0x0102030405060708'
  const HYBRID_SAFE_ROW = {
    id: 'safe-hybrid',
    safe_address: HYBRID_ADDRESS,
    chain_id: 84532,
    name: 'Delegation account',
    is_default: true,
    created_at: '2026-07-01T00:00:00.000Z',
    account_type: 'delegator_hybrid',
  }
  const HYBRID_SIGNERS = {
    account_address: HYBRID_ADDRESS,
    chain_id: 84532,
    owner_address: null,
    passkeys: [
      { key_id: HYBRID_KEY_ID, x: `0x${'aa'.repeat(32)}` as const, y: `0x${'bb'.repeat(32)}` as const },
    ],
  }

  function mockHybridAuth() {
    mockUseAuth.mockReturnValue({ passkeys: [], user: { safes: [HYBRID_SAFE_ROW] } })
  }

  it('hybrid account: ready when the signer set is hydrated and the passkey is on this device', () => {
    mockHybridAuth()
    setStoredHybridSigners(HYBRID_SIGNERS)
    rememberPasskeyCredentialOnDevice(credentialIdFromKeyId(HYBRID_KEY_ID))

    const { result } = renderHook(() =>
      useSafeOperationGate({ safeAddress: HYBRID_ADDRESS, chainId: 84532 }),
    )

    expect(result.current).toEqual({ kind: 'ready' })
  })

  it('hybrid account: READY when signers exist but none is on this device (#1969 — cross-device ceremony is a working path)', () => {
    // Pre-#1969 this returned passkey_on_other_device, which consumers treat
    // as BLOCKED (isOnchainActionBlocked) — a false blocker (#1097) for a set
    // that signs via the cross-device ceremony. The availability hint lives
    // next to the working actions, not in this gate.
    mockHybridAuth()
    setStoredHybridSigners(HYBRID_SIGNERS)

    const { result } = renderHook(() =>
      useSafeOperationGate({ safeAddress: HYBRID_ADDRESS, chainId: 84532 }),
    )

    expect(result.current).toEqual({ kind: 'ready' })
  })

  it('hybrid account: no_signer when no signer set is known — even with a wallet connected', () => {
    mockHybridAuth()
    // A globally connected EOA says nothing about who may sign for a Hybrid.
    mockUseAccount.mockReturnValue({ address: EOA_ADDRESS })
    mockUseWalletClient.mockReturnValue({ data: { type: 'walletClient' } })

    const { result } = renderHook(() =>
      useSafeOperationGate({ safeAddress: HYBRID_ADDRESS, chainId: 84532 }),
    )

    expect(result.current).toEqual({ kind: 'no_signer' })
  })

  it('hybrid signer sets do not affect a DIFFERENT (legacy) safe address', () => {
    mockHybridAuth()
    setStoredHybridSigners(HYBRID_SIGNERS)
    rememberPasskeyCredentialOnDevice(credentialIdFromKeyId(HYBRID_KEY_ID))
    mockUseAccount.mockReturnValue({ address: EOA_ADDRESS })
    mockUseWalletClient.mockReturnValue({ data: { type: 'walletClient' } })

    const { result } = renderHook(() =>
      useSafeOperationGate({ safeAddress: SAFE_ADDRESS, chainId: 100 }),
    )

    // Legacy path untouched: connected wallet → ready.
    expect(result.current).toEqual({ kind: 'ready' })
  })
})
