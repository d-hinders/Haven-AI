import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUseAuth = vi.fn()

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}))

import {
  useActiveChainId,
  useChainScope,
  inScope,
} from '@/hooks/useActiveChain'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'

const BASE = 8453
const SEPOLIA = 84532

function setActiveChain(chainId: number | null) {
  mockUseAuth.mockReturnValue({
    activeSafe: chainId == null ? null : { id: 's1', chain_id: chainId },
  })
}

describe('useActiveChain', () => {
  beforeEach(() => {
    mockUseAuth.mockReset()
  })

  it('useActiveChainId returns the active account chain, defaulting when none', () => {
    setActiveChain(SEPOLIA)
    expect(renderHook(() => useActiveChainId()).result.current).toBe(SEPOLIA)

    setActiveChain(null)
    expect(renderHook(() => useActiveChainId()).result.current).toBe(DEFAULT_CHAIN_ID)
  })

  it('inScope: a specific chain matches only itself, "all" matches everything', () => {
    expect(inScope(BASE, BASE)).toBe(true)
    expect(inScope(SEPOLIA, BASE)).toBe(false)
    expect(inScope(BASE, 'all')).toBe(true)
    expect(inScope(SEPOLIA, 'all')).toBe(true)
  })

  describe('useChainScope follow-active (Catalog/Transactions)', () => {
    it('defaults to the active chain and re-defaults when it switches', () => {
      setActiveChain(BASE)
      const { result, rerender } = renderHook(() => useChainScope('follow-active'))
      expect(result.current.scope).toBe(BASE)

      // User overrides to view another chain manually.
      act(() => result.current.setScope(SEPOLIA))
      expect(result.current.scope).toBe(SEPOLIA)

      // Switching the active account re-defaults the surface, dropping the override.
      setActiveChain(SEPOLIA)
      rerender()
      expect(result.current.scope).toBe(SEPOLIA)

      setActiveChain(BASE)
      rerender()
      expect(result.current.scope).toBe(BASE)
    })
  })

  describe('useChainScope all-chains (Contacts/Accounts)', () => {
    it('defaults to all and is NOT collapsed by the active chain', () => {
      setActiveChain(BASE)
      const { result, rerender } = renderHook(() => useChainScope('all-chains'))
      expect(result.current.scope).toBe('all')

      // Switching the active chain must not hide anything.
      setActiveChain(SEPOLIA)
      rerender()
      expect(result.current.scope).toBe('all')

      // The user can still opt into a manual filter.
      act(() => result.current.setScope(BASE))
      expect(result.current.scope).toBe(BASE)
    })
  })
})
